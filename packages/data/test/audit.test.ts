import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audit,
  defineModel,
  SqlAuditLog,
  transaction,
  useDatabase,
  type AuditEvent,
  type Model,
  type PolicyExpr,
} from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Doc {
  id: string;
  owner: string;
  locked: boolean;
}
type Actor = { id: string; token?: string };
const OWN: PolicyExpr = { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } };

function setup(sql: boolean) {
  const Docs = defineModel<Doc>("Doc", {
    fields: { id: "string", owner: "string", locked: "boolean" },
    read: (a: Actor, d) => d.owner === a.id || d.owner === "public",
    write: (a: Actor, d) => d.owner === a.id && !d.locked,
    readWhere: { or: [OWN, { cmp: "==", l: { field: ["owner"] }, r: { value: "public" } }] },
  });
  const Secret = defineModel<{ id: string }>("Secret", { fields: { id: "string" } });
  const db = openSqlite(":memory:");
  if (sql) useDatabase(db, [Docs, Secret] as Model<never>[]);
  Docs.as({ id: "ann" }).create({ id: "a1", owner: "ann", locked: false });
  Docs.as({ id: "bob" }).create({ id: "b1", owner: "bob", locked: false });
  Docs.as({ id: "public" }).create({ id: "p1", owner: "public", locked: false });
  Docs.driver.insert({ id: "l1", owner: "ann", locked: true });
  const events: AuditEvent[] = [];
  return { Docs, Secret, db, events, ann: Docs.as({ id: "ann", token: "t0ps3cret" }) };
}

const brief = (e: AuditEvent) =>
  `${e.action} ${e.outcome} ${e.model}[${e.keys.map(String).join(",")}]${e.reason ? ` (${e.reason})` : ""}`;

for (const sql of [false, true]) {
  const name = sql ? "sqlite" : "memory";

  test(`${name}: writes and refusals are audited`, () => {
    const { ann, Secret, events } = setup(sql);
    const stop = audit((e) => events.push(e));
    try {
      ann.create({ id: "a2", owner: "ann", locked: false });
      ann.create({ id: "x1", owner: "bob", locked: false });
      assert.equal(ann.get("b1"), undefined);
      assert.equal(ann.get("nope"), undefined);
      ann.update((d) => d.id === "a1", { locked: false });
      ann.update(() => true, { owner: "bob" });
      ann.delete((d) => d.id === "p1");
      ann.query().where({ id: "a2" }).delete();
      Secret.as({ id: "ann" }).all();
      assert.deepEqual(events.map(brief), [
        "create allowed Doc[a2]",
        "create denied Doc[x1] (write rule)",
        "read denied Doc[b1] (read rule)",
        "update allowed Doc[a1]",
        "update denied Doc[p1,l1] (write rule)",
        "update denied Doc[a1] (write rule (as patched))",
        "update denied Doc[a2] (write rule (as patched))",
        "delete denied Doc[p1] (write rule)",
        "delete allowed Doc[a2]",
        "read denied Secret[] (no read rule)",
      ]);
      assert.equal(events[0].actor.id, "ann");
      assert.ok(events.every((e) => e.at instanceof Date && e.count === e.keys.length));
    } finally {
      stop();
    }
  });

  test(`${name}: reads only on request; rolled-back writes are not logged as done`, () => {
    const { ann, events } = setup(sql);
    const stop = audit((e) => events.push(e), { reads: true });
    try {
      ann.query().orderBy("id").all();
      assert.throws(() =>
        transaction(() => {
          ann.create({ id: "a3", owner: "ann", locked: false });
          ann.create({ id: "x", owner: "bob", locked: false });
          throw new Error("abort");
        }),
      );
      transaction(() => ann.create({ id: "a4", owner: "ann", locked: false }));
      assert.deepEqual(events.map(brief), [
        "read allowed Doc[a1,l1,p1]",
        "create denied Doc[x] (write rule)",
        "create allowed Doc[a4]",
      ]);
    } finally {
      stop();
    }
    events.length = 0;
    ann.create({ id: "a5", owner: "ann", locked: false });
    assert.equal(events.length, 0, "stopped sinks hear nothing");
  });
}

test("the SQL audit log keeps actor ids, not actors, and survives rollbacks", () => {
  const { ann, db } = setup(true);
  const log = new SqlAuditLog(db);
  const stop = audit(log.sink);
  try {
    ann.get("b1");
    assert.throws(() =>
      transaction(() => {
        ann.create({ id: "z", owner: "bob", locked: false });
        throw new Error("abort");
      }),
    );
    ann.create({ id: "a9", owner: "ann", locked: false });
  } finally {
    stop();
  }
  const rows = db.prepare(`SELECT model, actor, action, outcome, keys, count, reason FROM weft_audit ORDER BY id`).all();
  assert.deepEqual(
    rows.map((r) => ({ ...(r as object) })),
    [
      { model: "Doc", actor: "ann", action: "read", outcome: "denied", keys: '["b1"]', count: 1, reason: "read rule" },
      { model: "Doc", actor: "ann", action: "create", outcome: "denied", keys: '["z"]', count: 1, reason: "write rule" },
      { model: "Doc", actor: "ann", action: "create", outcome: "allowed", keys: '["a9"]', count: 1, reason: null },
    ],
  );
  assert.ok(!JSON.stringify(rows).includes("t0ps3cret"), "the actor's token is never stored");
  assert.throws(() => new SqlAuditLog(db, { table: "x; DROP" }), /table name/);
});

test("who saw a row, and what an actor did, from the SQL log", () => {
  const { Docs, ann, db } = setup(true);
  const log = new SqlAuditLog(db);
  const stop = audit(log.sink, { reads: true });
  const bob = Docs.as({ id: "bob" });
  try {
    ann.get("p1");
    bob.get("p1");
    bob.get("a1");
    ann.where((d) => d.id === "a1");
    ann.update((d) => d.id === "a1", { locked: false });
  } finally {
    stop();
  }
  const seen = (key: unknown, o = {}) => log.seen("Doc", key, o).map((e) => `${e.actor} ${e.action} ${e.outcome} ${e.certain}`);
  assert.deepEqual(seen("p1"), [
    "ann read allowed true",
    "ann read allowed true",
    "bob read allowed true",
    "ann read allowed true",
  ]);
  assert.deepEqual(seen("a1"), [
    "ann update allowed true",
    "ann read allowed true",
    "ann read allowed true",
    "bob read denied true",
  ]);
  assert.deepEqual(seen("a1", { outcome: "denied" }), ["bob read denied true"]);
  assert.deepEqual(seen("a1", { actions: ["update"] }), ["ann update allowed true"]);
  assert.deepEqual(seen("a1", { limit: 1 }), ["ann update allowed true"]);
  assert.deepEqual(seen("zz"), []);
  assert.deepEqual(log.seen("Secret", "p1"), [], "another model's rows are not this one's");
  const future = new Date(Date.now() + 60_000);
  assert.deepEqual(seen("p1", { since: future }), []);
  assert.equal(seen("p1", { until: future }).length, 4);
  assert.deepEqual(
    log.byActor("bob").map((e) => `${e.action} ${e.outcome} ${e.keys.join(",")}`),
    ["read denied a1", "read allowed p1"],
  );
  assert.deepEqual(log.byActor("bob", { model: "Secret" }), []);
  assert.deepEqual(log.byActor("nobody"), []);

  for (let i = 0; i < 150; i++) Docs.driver.insert({ id: `m${String(i).padStart(3, "0")}`, owner: "carol", locked: false });
  const stop2 = audit(log.sink, { reads: true });
  try {
    Docs.as({ id: "carol" }).where(() => true);
  } finally {
    stop2();
  }
  const listed = log.seen("Doc", "m000").find((e) => e.actor === "carol")!;
  assert.equal(listed.certain, true);
  assert.equal(listed.count, 151, "her 150 and the public p1");
  const beyond = log.seen("Doc", "m149").find((e) => e.actor === "carol")!;
  assert.equal(beyond.certain, false, "not among the listed keys, but the read was larger");
  const p1 = log.seen("Doc", "p1").find((e) => e.actor === "carol")!;
  assert.equal(p1.certain, true, "p1 is among the listed keys");

  const bad = (f: () => unknown) => assert.throws(f);
  bad(() => log.seen("", "p1"));
  bad(() => log.seen("Doc", { id: "p1" }));
  bad(() => log.seen("Doc", "p1", { limit: 0 }));
  bad(() => log.seen("Doc", "p1", { actions: ["drop" as "read"] }));
  bad(() => log.seen("Doc", "p1", { actions: [] }));
  bad(() => log.seen("Doc", "p1", { since: new Date("nope") }));
  bad(() => log.seen("Doc", "p1", { outcome: "maybe" as "allowed" }));
  bad(() => log.byActor(""));
  assert.deepEqual(log.seen("Doc' OR 1=1 --", "p1"), []);
  assert.deepEqual(log.byActor("bob' OR '1'='1"), []);
});
