import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { asyncTransaction, ChangeFeed, defineModel, replicate, type Model } from "../src/index.ts";
import { pgliteAsPool, usePostgres } from "../src/postgres.ts";

interface Member {
  id: string;
  ws: string;
  role: string;
}

async function setup() {
  const pool = pgliteAsPool(new PGlite());
  const Members = defineModel<Member>("Member", {
    fields: { id: "string", ws: "string", role: "string" },
    read: (a, m) => (a as { ws: string }).ws === m.ws,
    write: () => true,
  });
  await usePostgres(pool, [Members] as Model<never>[], { onWarning: () => {} });
  return { pool, Members };
}

test("replica: loads existing rows; .local reads synchronously through policies", async () => {
  const { Members } = await setup();
  await Members.as({ ws: "a" }).create({ id: "1", ws: "a", role: "owner" });
  await Members.as({ ws: "b" }).create({ id: "2", ws: "b", role: "viewer" });
  await replicate(Members);
  const rows = Members.as({ ws: "a" }).local.all();
  assert.ok(Array.isArray(rows), "sync result");
  assert.deepEqual(rows.map((m) => m.id), ["1"]);
  assert.equal(Members.syncDriver().select([]).length, 2);
});

test("replica: writes reach it after commit; rolled-back writes never do", async () => {
  const { Members } = await setup();
  await replicate(Members);
  const h = Members.as({ ws: "a" });
  await h.create({ id: "1", ws: "a", role: "owner" });
  assert.equal(h.local.all().length, 1, "outside a transaction: applied at once");
  await assert.rejects(
    asyncTransaction(async () => {
      await h.create({ id: "2", ws: "a", role: "x" });
      assert.equal(h.local.all().length, 1, "not visible before commit");
      throw new Error("abort");
    }),
  );
  assert.equal(h.local.all().length, 1);
  await asyncTransaction(async () => {
    await h.update((m) => m.id === "1", { role: "admin" });
    await h.create({ id: "3", ws: "a", role: "viewer" });
  });
  assert.deepEqual(h.local.all().map((m) => [m.id, m.role]), [["1", "admin"], ["3", "viewer"]]);
  await h.delete((m) => m.id === "3");
  assert.deepEqual(h.local.all().map((m) => m.id), ["1"]);
});

test("replica: follows changes made by other instances (feed), including redacted ones", async () => {
  const { pool, Members } = await setup();
  const replica = await replicate(Members);
  const feed = new ChangeFeed();
  const stop = replica.follow(feed);
  feed.publish({ model: "Member", op: "create", key: "9", after: { id: "9", ws: "a", role: "remote" } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(Members.as({ ws: "a" }).local.all().map((m) => m.id), ["9"]);
  await pool.query(`INSERT INTO "Member" (id, ws, role) VALUES ('8', 'a', 'direct')`);
  await replica.apply({ model: "Member", op: "create", key: "8", redacted: true });
  assert.equal(Members.as({ ws: "a" }).local.get("8")?.role, "direct", "redacted change refetches the row");
  feed.publish({ model: "Member", op: "delete", key: "9" });
  await new Promise((r) => setImmediate(r));
  assert.equal(Members.as({ ws: "a" }).local.get("9"), undefined);
  stop();
});
