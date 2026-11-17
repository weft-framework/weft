import { test } from "node:test";
import assert from "node:assert/strict";
import { audit, changes, defineModel, useDatabase, type AuditEvent, type Model } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Log {
  id: string;
  owner: string;
  at: number;
  closed: number | null;
  deletedAt: number | null;
}

const DAY = 86_400_000;
let n = 0;

function make(sql: boolean, on: "at" | "closed" = "at") {
  const Logs = defineModel<Log>(`RetainLog${++n}`, {
    fields: { id: "string", owner: "string", at: "number", closed: "number | null", deletedAt: "number | null" },
    attrs: { [on]: { retain: 30 * DAY }, deletedAt: { softDelete: true } },
    read: (a: { id: string }, r) => r.owner === a.id,
    write: (a: { id: string }, r) => r.owner === a.id,
  });
  if (sql) useDatabase(openSqlite(":memory:"), [Logs] as unknown as Model<never>[]);
  return Logs;
}

for (const sql of [false, true]) {
  const name = sql ? "sqlite" : "memory";

  test(`${name}: expired rows are purged for good, trashed or not, and audited`, () => {
    const Logs = make(sql);
    const now = 100 * DAY;
    const ann = Logs.as({ id: "ann" });
    ann.create({ id: "old", owner: "ann", at: now - 31 * DAY, closed: null, deletedAt: null });
    ann.create({ id: "edge", owner: "ann", at: now - 30 * DAY, closed: null, deletedAt: null });
    ann.create({ id: "new", owner: "ann", at: now - DAY, closed: null, deletedAt: null });
    ann.create({ id: "binned", owner: "ann", at: now - 40 * DAY, closed: null, deletedAt: null });
    ann.delete((r) => r.id === "binned");
    assert.deepEqual(Logs.retention, { field: "at", ms: 30 * DAY });

    const events: AuditEvent[] = [];
    const stop = audit((e) => void events.push(e));
    const seen: string[] = [];
    const unsub = changes.subscribe((c) => {
      if (c.model === Logs.name) seen.push(`${c.op} ${String(c.key)}`);
    });
    try {
      assert.equal(Logs.purgeExpired(now), 2);
    } finally {
      stop();
      unsub();
    }
    assert.deepEqual(ann.all().map((r) => r.id).sort(), ["edge", "new"], "exactly 30 days is kept");
    assert.deepEqual(ann.trash().all(), [], "trashed and expired is gone too");
    assert.deepEqual(seen.sort(), ["delete binned", "delete old"]);
    const purge = events.filter((e) => e.model === Logs.name);
    assert.equal(purge.length, 1);
    assert.deepEqual([purge[0]!.action, purge[0]!.reason, purge[0]!.actor, [...purge[0]!.keys].sort()], ["delete", "retention", null, ["binned", "old"]]);
    assert.equal(Logs.purgeExpired(now), 0, "nothing left to purge");
    assert.equal(Logs.purgeExpired(now + 30 * DAY), 2);
  });

  test(`${name}: a nullable time keeps rows until it is set`, () => {
    const Logs = make(sql, "closed");
    const now = 100 * DAY;
    const ann = Logs.as({ id: "ann" });
    ann.create({ id: "open", owner: "ann", at: 0, closed: null, deletedAt: null });
    ann.create({ id: "done", owner: "ann", at: 0, closed: now - 31 * DAY, deletedAt: null });
    assert.equal(Logs.purgeExpired(now), 1);
    assert.deepEqual(ann.all().map((r) => r.id), ["open"]);
  });
}

test("bad declarations are refused", () => {
  const bad = (attrs: Record<string, unknown>, fields: Record<string, string> = {}, re = /@retain/) =>
    assert.throws(
      () => defineModel(`RetainBad${++n}`, { fields: { id: "string", at: "number", s: "string", b: "number", ...fields }, attrs: attrs as never }),
      re,
    );
  bad({ s: { retain: DAY } });
  bad({ at: { retain: 1000 } });
  bad({ at: { retain: 60_000.5 } });
  bad({ at: { retain: "30d" } });
  bad({ at: { retain: DAY }, b: { retain: DAY } });
  bad({ id: { retain: DAY } }, { id: "number" });
  const plain = defineModel(`RetainNone${++n}`, { fields: { id: "string" } });
  assert.equal(plain.retention, null);
  assert.throws(() => plain.purgeExpired(), /no @retain field/);
  const ok = defineModel(`RetainOk${++n}`, { fields: { id: "string", at: "number" }, attrs: { at: { retain: DAY } } });
  assert.throws(() => ok.purgeExpired(Number.NaN), /time in ms/);
});
