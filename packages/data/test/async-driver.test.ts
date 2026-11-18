import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel, MemoryDriver, type AsyncDriver, type Driver } from "../src/index.ts";

interface Note {
  id: string;
  owner: string;
  body: string;
  deleted: number | null;
}

function asyncOf<T>(d: Driver<T>, local = false): AsyncDriver<T> {
  const tick = <R>(f: () => R) => new Promise<R>((r) => setImmediate(() => r(f())));
  return {
    async: true,
    select: (s, k) => tick(() => d.select(s, k)),
    insert: (row) => tick(() => d.insert(row)),
    update: (k, row) => tick(() => d.update(k, row)),
    delete: (k) => tick(() => d.delete(k)),
    ...(d.query ? { query: (s, q) => tick(() => d.query!(s, q)) } : {}),
    ...(local ? { local: d } : {}),
  };
}

function setup(local = false) {
  const Notes = defineModel<Note>("AsyncNote", {
    fields: { id: "string", owner: "string", body: "string", deleted: "number | null" },
    attrs: { deleted: { softDelete: true } },
    read: (a, n) => (a as { id: string }).id === n.owner,
    write: (a, n) => (a as { id: string }).id === n.owner,
  });
  Notes.use(asyncOf(new MemoryDriver<Note>(), local));
  return Notes;
}

test("async driver: terminals return promises and enforce the same policies", async () => {
  const Notes = setup();
  assert.equal(Notes.isAsync, true);
  const ann = Notes.as({ id: "ann" });
  const bob = Notes.as({ id: "bob" });
  const created = ann.create({ id: "1", owner: "ann", body: "hi" });
  assert.ok(created instanceof Promise);
  assert.equal((await created)?.body, "hi");
  assert.equal(await bob.create({ id: "2", owner: "ann", body: "forged" }), undefined);
  assert.equal((await ann.all()).length, 1);
  assert.equal((await bob.all()).length, 0);
  assert.equal(await bob.get("1"), undefined);
  assert.equal(await bob.update((n) => n.id === "1", { body: "x" }), 0);
  assert.equal(await ann.update((n) => n.id === "1", { body: "edited" }), 1);
  assert.equal((await ann.query().where({ body: "edited" }).first())?.id, "1");
  assert.equal(await ann.query().count(), 1);
  assert.equal(await ann.delete((n) => n.id === "1"), 1);
  assert.equal((await ann.all()).length, 0);
  assert.equal((await ann.trash().all()).length, 1);
  assert.equal(await ann.trash().restore(() => true), 1);
  assert.equal((await ann.all()).length, 1);
});

test("async driver: allows() uses rows seen by this handle; syncDriver() needs a replica", async () => {
  const Notes = setup();
  const ann = Notes.as({ id: "ann" });
  await ann.create({ id: "1", owner: "ann", body: "hi" });
  assert.throws(() => Notes.syncDriver(), /async driver without a local replica/);
  const fresh = Notes.as({ id: "ann" });
  assert.equal(fresh.allows("write", "1"), false, "not loaded through this handle yet");
  await fresh.all();
  assert.equal(fresh.allows("write", "1"), true);
  assert.equal(Notes.as({ id: "bob" }).allows("read", "1"), false);
});

test("async driver with a local replica: .local reads synchronously through policies", async () => {
  const Notes = setup(true);
  await Notes.as({ id: "ann" }).create({ id: "1", owner: "ann", body: "hi" });
  const rows = Notes.as({ id: "ann" }).local.all();
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 1);
  assert.equal(Notes.as({ id: "bob" }).local.all().length, 0);
});
