import { test } from "node:test";
import assert from "node:assert/strict";
import { defineHistory, defineModel, useDatabase, type Model } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Card {
  id: string;
  title: string | null;
  frozen: boolean;
  deletedAt: number | null;
}

type Who = { id: string };
const ada: Who = { id: "ada" };
const bob: Who = { id: "bob" };

for (const driver of ["memory", "sqlite"] as const) {
  const make = () => {
    const board = { closed: false };
    const m = defineModel<Card, "deletedAt">("Card", {
      fields: { id: "string", title: "string | null", frozen: "boolean", deletedAt: "number | null" },
      attrs: { deletedAt: { softDelete: true } },
      read: () => true,
      write: (_a, r) => !board.closed && r.frozen !== true,
    });
    let clock = 1_000;
    const h = defineHistory(m, { now: () => (clock += 1000) });
    if (driver === "sqlite") useDatabase(openSqlite(":memory:"), [m as Model<never>, h.model as Model<never>]);
    return { m, h, board, tick: (ms: number) => (clock += ms) };
  };
  const title = (m: Model<Card, "deletedAt">) => m.as(ada).get("c")?.title;

  test(`${driver}: undo an update, then redo it; others' writes are not undone`, () => {
    const { m, h } = make();
    m.as(ada).create({ id: "c", title: "one", frozen: false });
    m.as(ada).update((r) => r.id === "c", { title: "two" });
    assert.deepEqual(h.undo(m.as(bob), "c"), { ok: false, reason: "not-yours" }, "bob did not write it");
    assert.deepEqual(h.undo(m.as(ada), "c"), { ok: true, action: "update", version: 2 });
    assert.equal(title(m), "one");
    assert.deepEqual(h.undo(m.as(ada), "c"), { ok: true, action: "update", version: 3 }, "undoing the undo redoes");
    assert.equal(title(m), "two");

    m.as(bob).update((r) => r.id === "c", { title: "bob's" });
    assert.deepEqual(h.undo(m.as(ada), "c"), { ok: false, reason: "not-yours" });
    assert.deepEqual(h.undo(m.as(bob), "c"), { ok: true, action: "update", version: 5 });
    assert.equal(title(m), "two");
    assert.deepEqual(h.undo(m.as(ada), "c"), { ok: false, reason: "not-yours" }, "the undo is bob's write now");
    assert.deepEqual(h.undo(m.as(ada), "missing"), { ok: false, reason: "not-found" });
  });

  test(`${driver}: create, trash and restore are undone; the rules decide at undo time`, () => {
    const { m, h, board, tick } = make();
    m.as(ada).create({ id: "c", title: "one", frozen: false });
    assert.deepEqual(h.undo(m.as(ada), "c"), { ok: true, action: "create", version: 1 });
    assert.equal(m.as(ada).get("c"), undefined, "an undone create goes to the trash");
    assert.equal(m.as(ada).trash().get("c")?.title, "one");
    assert.deepEqual(h.undo(m.as(ada), "c"), { ok: true, action: "trash", version: 2 }, "an undone trash is restored");
    assert.equal(title(m), "one");
    assert.deepEqual(h.undo(m.as(ada), "c"), { ok: true, action: "restore", version: 3 });
    assert.equal(m.as(ada).get("c"), undefined);
    m.as(ada).trash().restore((r) => r.id === "c");

    m.as(ada).update((r) => r.id === "c", { title: "renamed" });
    board.closed = true;
    assert.deepEqual(h.undo(m.as(ada), "c"), { ok: false, reason: "refused" });
    assert.equal(title(m), "renamed");
    board.closed = false;

    tick(60_000);
    assert.deepEqual(h.undo(m.as(ada), "c", { within: 30_000 }), { ok: false, reason: "too-old" });
    assert.throws(() => h.undo(m.as(ada).trash(), "c"), TypeError);
    assert.throws(() => h.undo(defineModel("Other", { fields: { id: "string" } }).as(ada) as never, "c"), TypeError);
  });

  test(`${driver}: a change outside the rules is not overwritten; undoable lists what undo accepts`, () => {
    const { m, h } = make();
    m.as(ada).create({ id: "c", title: "one", frozen: false });
    m.as(ada).create({ id: "d", title: "d", frozen: false });
    m.as(bob).create({ id: "e", title: "e", frozen: false });
    m.as(ada).update((r) => r.id === "c", { title: "two" });
    assert.deepEqual(
      h.undoable(m.as(ada)).map((v) => [v.key, v.version]),
      [["c", 2], ["d", 1]],
    );
    assert.deepEqual(h.undoable(m.as(bob)).map((v) => v.key), ["e"]);
    assert.deepEqual(h.undoable(m.as(ada), { limit: 1 }).map((v) => v.key), ["c"]);
    assert.throws(() => h.undoable({ ...m.as(ada) } as never), TypeError, "not a handle");

    m.unlinkUnscoped(["d"], "title", "test");
    assert.deepEqual(h.undo(m.as(ada), "d"), { ok: false, reason: "not-yours" });
    h.stop();
    m.as(bob).update((r) => r.id === "c", { title: "unrecorded" });
    assert.deepEqual(h.undo(m.as(ada), "c"), { ok: false, reason: "changed" });
  });
}
