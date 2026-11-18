import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { audit, defineModel, type Model } from "../src/index.ts";
import { PgAuditLog, pgliteAsPool, usePostgres } from "../src/postgres.ts";

test("PgAuditLog records model access and answers seen/byActor", async () => {
  const pool = pgliteAsPool(new PGlite());
  const Doc = defineModel<{ id: string; owner: string }>("AuditDoc", {
    fields: { id: "string", owner: "string" },
    read: (a: { id: string }, r) => a.id === r.owner,
    write: (a: { id: string }, r) => a.id === r.owner,
  });
  await usePostgres(pool, [Doc as Model<never>], { onWarning: () => {} });
  const log = new PgAuditLog(pool);
  const stop = audit(log.sink, { reads: true });
  try {
    await Doc.as({ id: "ann" }).create({ id: "d1", owner: "ann" });
    await Doc.as({ id: "ann" }).all();
    assert.equal(await Doc.as({ id: "bob" }).create({ id: "d2", owner: "ann" }), undefined, "a denied create is a no-op");
    await log.flush();
    const seen = await log.seen("AuditDoc", "d1");
    assert.deepEqual(seen.map((e) => [e.actor, e.action, e.outcome]).sort(), [
      ["ann", "create", "allowed"],
      ["ann", "read", "allowed"],
    ]);
    const bob = await log.byActor("bob");
    assert.equal(bob.length, 1);
    assert.equal(bob[0].outcome, "denied");
    assert.equal((await log.byActor("ann", { actions: ["create"] })).length, 1);
  } finally {
    stop();
  }
});
