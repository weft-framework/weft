import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { bridgeChanges, ChangeFeed, type Change } from "../src/index.ts";
import { pgBroadcast, pgliteAsPool, type PgPool } from "../src/postgres.ts";

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("pgBroadcast: two instances exchange changes over LISTEN/NOTIFY", async () => {
  const pool: PgPool = pgliteAsPool(new PGlite());
  const a = new ChangeFeed();
  const b = new ChangeFeed();
  const chA = pgBroadcast(pool);
  const chB = pgBroadcast(pool);
  await Promise.all([chA.ready(), chB.ready()]);
  const offA = bridgeChanges(a, chA, { origin: "a" });
  const offB = bridgeChanges(b, chB, { origin: "b" });
  const heardB: Change[] = [];
  const heardA: Change[] = [];
  b.subscribe((c) => heardB.push(c));
  a.subscribe((c) => heardA.push(c));

  const when = new Date("2026-05-06T07:08:09.000Z");
  a.publish({ model: "Task", op: "update", key: "1", after: { id: "1", at: when } });
  await until(() => heardB.length === 1);
  assert.equal(heardB[0].key, "1");
  assert.ok((heardB[0].after as { at: Date }).at instanceof Date, "dates survive the bridge");
  assert.equal(heardA.length, 1, "an instance does not hear itself twice");

  a.publish({ model: "Task", op: "update", key: "2", after: { id: "2", body: "x".repeat(20_000) } });
  await until(() => heardB.length === 2);
  assert.equal(heardB[1].redacted, true, "oversized changes are sent without the row");
  assert.equal(heardB[1].model, "Task");

  offA();
  offB();
  await chA.close();
  await chB.close();
});
