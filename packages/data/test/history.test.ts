import { test } from "node:test";
import assert from "node:assert/strict";
import { defineHistory, defineModel, holdFile, transaction, useDatabase, type Model } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Doc {
  id: string;
  org: string;
  owner: string;
  title: string;
  body: string;
  secret: string;
  file: string | null;
  deletedAt: number | null;
}

interface Who {
  id: string;
  tenant?: string;
}

function docs(): Model<Doc, "deletedAt" | "file"> {
  return defineModel<Doc, "deletedAt" | "file">("Doc", {
    fields: {
      id: "string",
      org: "string",
      owner: "string",
      title: "string",
      body: "string",
      secret: "string",
      file: "File | null",
      deletedAt: "number | null",
    },
    attrs: { org: { tenant: true }, deletedAt: { softDelete: true }, file: { default: () => null } },
    read: () => true,
    write: (a: Who, r) => r.owner === a.id,
  });
}

const ada: Who = { id: "ada", tenant: "acme" };
const bob: Who = { id: "bob", tenant: "acme" };
const eve: Who = { id: "eve", tenant: "evil" };

for (const driver of ["memory", "sqlite"] as const) {
  const make = (keep?: number) => {
    const m = docs();
    let clock = 1_000;
    const h = defineHistory(m, { omit: ["secret"], now: () => (clock += 1000), ...(keep ? { keep } : {}) });
    if (driver === "sqlite") useDatabase(openSqlite(":memory:"), [m as Model<never>, h.model as Model<never>]);
    return { m, h };
  };

  test(`${driver}: every write is a version; readable only with the row`, () => {
    const { m, h } = make();
    m.as(ada).create({ id: "d1", org: "acme", owner: "ada", title: "Plan", body: "v1", secret: "s1" });
    m.as(ada).update((d) => d.id === "d1", { title: "Plan B" });
    m.as(bob).update((d) => d.id === "d1", { title: "hijack" });
    m.as(ada).update((d) => d.id === "d1", { body: "v2", secret: "s2" });
    const v = h.versions(m.as(bob), "d1")!;
    assert.deepEqual(v.map((x) => [x.version, x.action, x.actor]), [[3, "update", "ada"], [2, "update", "ada"], [1, "create", "ada"]]);
    assert.deepEqual(v[1]!.changes, [{ field: "title", before: "Plan", after: "Plan B" }]);
    assert.deepEqual(v[0]!.changes, [{ field: "body", before: "v1", after: "v2" }], "the omitted field changed but is not there");
    assert.ok(v.every((x) => !("secret" in x.row)), "omitted fields are never stored");
    assert.equal(v[2]!.changes.length > 3, true, "a create lists its fields");
    assert.equal(v[0]!.at > v[1]!.at, true);
    assert.equal(h.versions(m.as(eve), "d1"), null, "another tenant learns nothing");
    assert.equal(h.versions(m.as(ada), "nope"), null);
    assert.equal(h.diff(m.as(eve), "d1", 1, 3), null);
    assert.equal(h.versions(m.as(bob), "d1", { limit: 1 })!.length, 1);
  });

  test(`${driver}: diff between any two kept versions`, () => {
    const { m, h } = make();
    m.as(ada).create({ id: "d1", org: "acme", owner: "ada", title: "A", body: "x", secret: "" });
    m.as(ada).update(() => true, { title: "B" });
    m.as(ada).update(() => true, { body: "y" });
    assert.deepEqual(h.diff(m.as(bob), "d1", 1, 3), [
      { field: "title", before: "A", after: "B" },
      { field: "body", before: "x", after: "y" },
    ]);
    assert.deepEqual(h.diff(m.as(bob), "d1", 3, 1)!.map((c) => c.after), ["A", "x"]);
    assert.equal(h.diff(m.as(bob), "d1", 1, 9), null);
  });

  test(`${driver}: restore goes through the write rule and is a new version`, () => {
    const { m, h } = make();
    m.as(ada).create({ id: "d1", org: "acme", owner: "ada", title: "A", body: "x", secret: "keep me" });
    m.as(ada).update(() => true, { title: "B", body: "y", secret: "newer" });
    assert.equal(h.restore(m.as(bob), "d1", 1), false, "bob may read but not write");
    assert.equal(m.as(ada).get("d1")!.title, "B");
    assert.equal(h.restore(m.as(ada), "d1", 1), true);
    const now = m.as(ada).get("d1")!;
    assert.deepEqual([now.title, now.body, now.secret], ["A", "x", "newer"], "omitted fields are not restored");
    assert.deepEqual(h.versions(m.as(ada), "d1")!.map((v) => v.version), [3, 2, 1]);
    assert.equal(h.restore(m.as(ada), "d1", 3), true, "already as it was");
    assert.equal(h.versions(m.as(ada), "d1")!.length, 3, "no empty version");
    assert.equal(h.restore(m.as(ada), "d1", 42), false);
    assert.equal(h.restore(m.as(eve), "d1", 1), false);
  });

  test(`${driver}: trash and restore are versions; the trash is readable; delete forgets`, () => {
    const { m, h } = make();
    m.as(ada).create({ id: "d1", org: "acme", owner: "ada", title: "A", body: "", secret: "" });
    m.as(ada).delete(() => true);
    assert.deepEqual(h.versions(m.as(bob), "d1")!.map((v) => v.action), ["trash", "create"], "readable while in the trash");
    assert.equal(h.versions(m.as(bob).trash(), "d1")!.length, 2);
    assert.equal(h.restore(m.as(ada), "d1", 1), false, "restored from the trash first");
    m.as(ada).trash().restore(() => true);
    assert.equal(h.versions(m.as(bob), "d1")![0]!.action, "restore");
    assert.equal(h.versions(m.as(bob).trash(), "d1"), null, "a trash handle answers for trashed rows");
    m.as(ada).update(() => true, { title: "B" });
    assert.equal(h.restore(m.as(ada), "d1", 2), true, "restoring the trashed version leaves the row live");
    assert.deepEqual([m.as(ada).get("d1")!.title, m.as(ada).get("d1")!.deletedAt], ["A", null]);
    m.as(ada).delete(() => true);
    m.as(ada).trash().delete(() => true);
    assert.equal(h.model.publicUnscoped().length, 0, "deleted for good: history gone");
    m.as(ada).create({ id: "d2", org: "acme", owner: "ada", title: "A", body: "", secret: "" });
    m.as(ada).delete(() => true);
    m.purgeTrash(Date.now() + 1);
    assert.equal(h.model.publicUnscoped().length, 0, "purged: gone too");
  });

  test(`${driver}: keep caps the versions per row`, () => {
    const { m, h } = make(3);
    m.as(ada).create({ id: "d1", org: "acme", owner: "ada", title: "0", body: "", secret: "" });
    for (let i = 1; i <= 5; i++) m.as(ada).update(() => true, { title: String(i) });
    const v = h.versions(m.as(ada), "d1")!;
    assert.deepEqual(v.map((x) => x.version), [6, 5, 4]);
    assert.deepEqual(v[2]!.changes.map((c) => c.field).sort(), ["body", "id", "org", "owner", "title"], "the oldest kept lists every non-null field");
  });
}

test("restore leaves files alone (an old file id is not claimed)", () => {
  const m = docs();
  const h = defineHistory(m);
  holdFile("f1", ada);
  m.as(ada).create({ id: "d1", org: "acme", owner: "ada", title: "A", body: "", secret: "", file: "f1" });
  holdFile("f2", ada);
  m.as(ada).update(() => true, { title: "B", file: "f2" });
  assert.equal(h.restore(m.as(ada), "d1", 1), true);
  assert.deepEqual([m.as(ada).get("d1")!.title, m.as(ada).get("d1")!.file], ["A", "f2"]);
});

test("a rolled-back write leaves no version", () => {
  const m = docs();
  const h = defineHistory(m);
  m.as(ada).create({ id: "d1", org: "acme", owner: "ada", title: "A", body: "", secret: "" });
  assert.throws(() =>
    transaction(() => {
      m.as(ada).update(() => true, { title: "B" });
      throw new Error("abort");
    }),
  );
  assert.deepEqual(h.versions(m.as(ada), "d1")!.map((v) => v.version), [1]);
});

test("the history model is closed; recording failures do not break writes", () => {
  const m = docs();
  const errors: unknown[] = [];
  const h = defineHistory(m, { onError: (e) => errors.push(e) });
  m.as(ada).create({ id: "d1", org: "acme", owner: "ada", title: "A", body: "", secret: "s" });
  for (const a of [ada, { weftHistory: true }, null, "x"]) {
    assert.deepEqual(h.model.as(a as never).all(), [], "no actor reads it");
    assert.equal(h.model.as(a as never).create({ id: "f", key: '"d1"', version: 9, at: 0, actor: "ada", action: "update", data: "{}" }), undefined);
    assert.equal(h.model.as(a as never).delete(() => true), 0);
  }
  assert.throws(() => h.versions(docs().as(ada) as never, "d1"), /pass Doc.as/);
  assert.throws(() => h.versions({ model: m, get: () => ({}) } as never, "d1"), /pass Doc.as/);
  h.stop();
  m.as(ada).update(() => true, { title: "B" });
  assert.equal(h.versions(m.as(ada), "d1")!.length, 1, "stopped");
  assert.deepEqual(errors, []);
});

test("declarations", () => {
  const m = docs();
  assert.throws(() => defineHistory({} as never), /needs a model/);
  assert.throws(() => defineHistory(m, { omit: ["nope" as never] }), /no field/);
  assert.throws(() => defineHistory(m, { omit: ["id"] }), /key cannot/);
  assert.throws(() => defineHistory(m, { keep: 0 }), /keep/);
  assert.throws(() => defineHistory(m, { name: "bad name" }), /name/);
  assert.equal(defineHistory(m).model.name, "DocHistory");
});
