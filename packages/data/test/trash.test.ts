import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audit,
  canSee,
  defineModel,
  holdFile,
  onFileRelease,
  useDatabase,
  type AuditEvent,
  type Change,
  type Model,
  type SqlDatabase,
} from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Doc {
  id: string;
  org: string;
  owner: string;
  title: string;
  deletedAt: number | null;
}

interface Who {
  id: string;
  tenant?: string;
}

function docs(): Model<Doc, "deletedAt"> {
  return defineModel<Doc, "deletedAt">("Doc", {
    fields: { id: "string", org: "string", owner: "string", title: "string", deletedAt: "number | null" },
    attrs: { org: { tenant: true }, deletedAt: { softDelete: true, index: true } },
    read: () => true,
    write: (a: Who, r) => r.owner === a.id,
    readWhere: { truthy: { value: true } },
    writeWhere: { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } },
  });
}

const ada: Who = { id: "ada", tenant: "acme" };
const bob: Who = { id: "bob", tenant: "acme" };
const eve: Who = { id: "eve", tenant: "evil" };

function recording(db: SqlDatabase): SqlDatabase & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      log.push(sql);
      return db.prepare(sql);
    },
  };
}

for (const driver of ["memory", "sqlite"] as const) {
  const make = () => {
    const m = docs();
    let db: (SqlDatabase & { log: string[] }) | null = null;
    if (driver === "sqlite") {
      db = recording(openSqlite(":memory:"));
      useDatabase(db, [m as Model<never>]);
    }
    assert.ok(m.as(ada).create({ id: "d1", org: "acme", owner: "ada", title: "Plan" }));
    assert.ok(m.as(ada).create({ id: "d2", org: "acme", owner: "ada", title: "Notes" }));
    assert.ok(m.as(bob).create({ id: "d3", org: "acme", owner: "bob", title: "Bob's" }));
    assert.ok(m.as(eve).create({ id: "e1", org: "evil", owner: "eve", title: "Theirs" }));
    return { m, db };
  };

  test(`${driver}: a deleted row goes to the trash and out of every ordinary read`, () => {
    const { m, db } = make();
    assert.equal(m.as(ada).get("d1")!.deletedAt, null, "created live");
    const before = Date.now();
    assert.equal(m.as(ada).delete((d) => d.id === "d1"), 1);
    assert.deepEqual(m.as(bob).all().map((d) => d.id).sort(), ["d2", "d3"]);
    assert.equal(m.as(ada).get("d1"), undefined, "not by key either");
    assert.equal(m.as(ada).find((d) => d.id === "d1"), undefined);
    assert.deepEqual(m.as(ada).query().where({ title: "Plan" }).all(), []);
    assert.equal(m.as(ada).query().count(), 2);
    assert.equal(m.as(ada).update((d) => d.id === "d1", { title: "x" }), 0, "a trashed row is not updated");
    assert.equal(m.as(ada).delete((d) => d.id === "d1"), 0, "nor deleted again");

    const bin = m.as(bob).trash();
    const t = bin.all();
    assert.deepEqual(t.map((d) => d.id), ["d1"], "teammates read the trash under the read rule");
    assert.ok(t[0]!.deletedAt! >= before && t[0]!.deletedAt! <= Date.now());
    assert.equal(bin.get("d2"), undefined, "the trash holds only trashed rows");
    assert.deepEqual(m.as(eve).trash().all().map((d) => d.id), [], "another tenant's trash is not reachable");
    assert.equal(bin.query().count(), 1);
    if (db) {
      const sel = db.log.filter((s) => s.startsWith("SELECT") && s.includes('FROM "Doc"'));
      assert.ok(sel.length > 0 && sel.every((s) => /"deletedAt" IS (NOT )?\?/.test(s)), "every read carries the trash condition in SQL");
      assert.ok(sel.some((s) => /"deletedAt" IS NOT \?/.test(s)), "the trash read too");
    }
  });

  test(`${driver}: restore and permanent delete go through the write rule`, () => {
    const { m } = make();
    m.as(ada).delete(() => true);
    assert.deepEqual(m.as(ada).all().map((d) => d.id), ["d3"], "only her own rows were trashed");
    assert.equal(m.as(bob).trash().restore(() => true), 0, "bob cannot restore ada's rows");
    assert.equal(m.as(bob).trash().delete(() => true), 0, "nor purge them");
    assert.equal(m.as(ada).trash().restore((d) => d.id === "d1"), 1);
    assert.equal(m.as(bob).get("d1")!.deletedAt, null, "back, live");
    assert.equal(m.as(ada).trash().delete((d) => d.id === "d2"), 1);
    assert.equal(m.as(ada).trash().all().length, 0);
    assert.equal(m.as(ada).get("d2"), undefined);
    assert.equal(m.publicUnscoped().filter((d) => d.id === "d2").length, 0, "gone for good");
    assert.equal(m.as(ada).query().where({ id: "d1" }).delete(), 1);
    assert.equal(m.as(ada).trash().query().where({ id: "d1" }).count(), 1);
    assert.equal(m.as(ada).trash().query().where({ id: "d1" }).delete(), 1, "and on the trash, removes");
    assert.equal(m.publicUnscoped().filter((d) => d.id === "d1").length, 0);
  });

  test(`${driver}: the trash field is written only by delete and restore`, () => {
    const { m } = make();
    assert.throws(() => m.as(ada).create({ id: "x", org: "acme", owner: "ada", title: "t", deletedAt: 1 }), /created live/);
    assert.throws(() => m.as(ada).update((d) => d.id === "d1", { deletedAt: 1 }), /set by delete/);
    assert.throws(() => m.as(ada).update((d) => d.id === "d1", { deletedAt: null }), /set by delete/);
    assert.throws(() => m.as(ada).query().update({ deletedAt: 5 }), /set by delete/);
    m.as(ada).delete((d) => d.id === "d1");
    assert.throws(() => m.as(ada).trash().update(() => true, { title: "x" }), /restored before/);
    assert.throws(() => m.as(ada).trash().create({ id: "y", org: "acme", owner: "ada", title: "t" }), /created live/);
    assert.throws(() => m.as(ada).restore(() => true), /on the trash/);
    assert.equal(m.as(ada).trash().all()[0]!.title, "Plan", "unchanged");
  });

  test(`${driver}: purge removes rows trashed before a time`, () => {
    const { m } = make();
    m.as(ada).delete((d) => d.id === "d1");
    const cut = Date.now() + 1;
    assert.equal(m.purgeTrash(cut - 60_000), 0, "trashed after the cut");
    assert.equal(m.purgeTrash(cut), 1);
    assert.equal(m.publicUnscoped().filter((d) => d.id === "d1").length, 0);
    assert.equal(m.publicUnscoped().length, 3, "live rows untouched");
    assert.throws(() => m.purgeTrash(Number.NaN), /time in ms/);
  });
}

test("audit: trash, restore and purge; a trashed key is not reported as a probe", () => {
  const m = docs();
  m.as(ada).create({ id: "d1", org: "acme", owner: "ada", title: "Plan" });
  const events: AuditEvent[] = [];
  const stop = audit((e) => events.push(e));
  try {
    m.as(bob).delete((d) => d.id === "d1");
    m.as(ada).delete((d) => d.id === "d1");
    m.as(ada).get("d1");
    m.as(bob).trash().restore(() => true);
    m.as(ada).trash().restore(() => true);
    m.as(ada).delete(() => true);
    m.purgeTrash(Date.now() + 1);
  } finally {
    stop();
  }
  const seen = events.map((e) => `${e.action}:${e.outcome}:${(e.actor as Who | null)?.id ?? "-"}${e.reason ? `:${e.reason}` : ""}`);
  assert.deepEqual(seen, [
    "delete:denied:bob:write rule",
    "trash:allowed:ada",
    "update:denied:bob:write rule",
    "restore:allowed:ada",
    "trash:allowed:ada",
    "delete:allowed:-:trash purged",
  ]);
});

test("change relevance: trashing and restoring reach pages that read the row", () => {
  const m = docs();
  m.as(ada).create({ id: "d1", org: "acme", owner: "ada", title: "Plan" });
  const got: Change[] = [];
  const unsub = m.feed.subscribe((c) => {
    if (c.model === "Doc") got.push(c);
  });
  m.as(ada).delete(() => true);
  m.as(ada).trash().restore(() => true);
  unsub();
  assert.deepEqual(got.map((c) => c.op), ["update", "update"]);
  assert.ok(got.every((c) => canSee(m as Model<unknown>, bob, c)), "a teammate's live and trash pages re-render");
  assert.ok(got.every((c) => !canSee(m as Model<unknown>, eve, c)), "another tenant's do not");
});

test("files stay held by a trashed row until it is purged", () => {
  interface Att {
    id: string;
    file: string | null;
    gone: number | null;
  }
  const m = defineModel<Att>("Att", {
    fields: { id: "string", file: "File | null", gone: "number | null" },
    attrs: { gone: { softDelete: true } },
    read: () => true,
    write: () => true,
  });
  const released: string[] = [];
  const off = onFileRelease((id) => released.push(id));
  try {
    holdFile("f1", ada);
    m.as(ada).create({ id: "a", file: "f1", gone: null });
    m.as(ada).delete(() => true);
    assert.deepEqual(released, []);
    m.purgeTrash(Date.now() + 1);
    assert.deepEqual(released, ["f1"]);
  } finally {
    off();
  }
});

test("the write rule sees the row as trashed: a rule can refuse trashing; grants keep the view", () => {
  interface Row {
    id: string;
    owner: string;
    gone: number | null;
  }
  const m = defineModel<Row>("Guarded", {
    fields: { id: "string", owner: "string", gone: "number | null" },
    attrs: { gone: { softDelete: true } },
    read: () => true,
    write: (a: Who & { mayTrash?: boolean }, r) => r.owner === a.id && (r.gone === null || a.mayTrash === true),
  });
  m.as(ada).create({ id: "g", owner: "ada", gone: null });
  assert.equal(m.as(ada).delete(() => true), 0, "the rule refuses the trashed row");
  assert.equal(m.as(ada).all().length, 1);
  assert.equal(m.as({ ...ada, mayTrash: true }).delete(() => true), 1);
  assert.equal(m.as(ada).trash().restore(() => true), 0, "a trashed row this actor may not write is not restored");
  const grant = { model: "Guarded", key: "g", rights: "read" as const };
  assert.deepEqual(m.as(bob).trash().using(grant).all().map((r) => r.id), ["g"], "a grant on a trash handle stays in the trash");
  assert.equal(m.as(bob).using(grant).get("g"), undefined, "and does not bring the row back to live reads");
});

test("declarations", () => {
  const base = { read: () => true, write: () => true };
  assert.throws(
    () => defineModel("A", { fields: { id: "string", d: "number" }, attrs: { d: { softDelete: true } }, ...base }),
    /`number \| null`/,
  );
  assert.throws(
    () => defineModel("A", { fields: { id: "string", d: "string | null" }, attrs: { d: { softDelete: true } }, ...base }),
    /`number \| null`/,
  );
  assert.throws(
    () =>
      defineModel("A", {
        fields: { id: "string", d: "number | null", e: "number | null" },
        attrs: { d: { softDelete: true }, e: { softDelete: true } },
        ...base,
      }),
    /more than one @softDelete/,
  );
  const plain = defineModel("P", { fields: { id: "string" }, ...base });
  assert.throws(() => plain.as(ada).trash(), /no @softDelete/);
  assert.throws(() => plain.purgeTrash(0), /no @softDelete/);
  assert.equal(plain.trashField, null);
});
