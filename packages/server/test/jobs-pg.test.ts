import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createJobs, defineJob, JobError, PgJobStore, type JobContext, type JobRecord } from "../src/jobs.ts";

const URL_ = process.env.WEFT_TEST_PG;
const T0 = Date.UTC(2026, 10, 14, 10);
let pool: { query(t: string, v?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> } | null = null;
let tables = 0;

async function db() {
  if (!pool) {
    const pg = (await import("pg")).default;
    pool = new pg.Pool({ connectionString: URL_, max: 8 });
  }
  return pool;
}
async function store() {
  const p = await db();
  const table = `weft_jobs_t${process.pid}_${++tables}`;
  await p.query(`DROP TABLE IF EXISTS "${table}"`);
  after(() => p.query(`DROP TABLE IF EXISTS "${table}"`));
  return { store: new PgJobStore(p, table), table, p };
}
process.on("beforeExit", () => void pool?.end());

const skip = URL_ ? false : "set WEFT_TEST_PG to run against Postgres";

function record(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: `j${Math.random().toString(16).slice(2, 10)}`,
    name: "n",
    args: [1, "two", { three: 3 }],
    actor: { user: "ada", tenant: "acme" },
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    runAt: T0,
    created: T0,
    updated: T0,
    worker: null,
    leaseUntil: 0,
    error: null,
    key: null,
    keepKey: false,
    progress: null,
    ...over,
  };
}

test("the store contract: round trip, claim, lease, settle, move, list, counts, sweep", { skip }, async () => {
  const { store: s, p, table } = await store();
  const a = record({ id: "a", key: "k1" });
  assert.equal(await s.add(a), true);
  assert.equal(await s.add(record({ id: "b", key: "k1" })), false, "a key is unique");
  assert.deepEqual(await s.get("a"), a, "every field round-trips, numbers as numbers");
  assert.equal(await s.get("nope"), null);
  const cols = await p.query(`SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = 'run_at'`, [table]);
  assert.equal(cols.rows[0]!.data_type, "bigint", "millisecond times fit");

  assert.equal(await s.claim(T0 - 1, "w1", T0 + 1000), null, "not due yet");
  const c = (await s.claim(T0, "w1", T0 + 1000))!;
  assert.deepEqual([c.id, c.status, c.attempts, c.worker, c.leaseUntil], ["a", "running", 1, "w1", T0 + 1000]);
  assert.equal(await s.claim(T0 + 500, "w2", T0 + 2000), null, "held while leased");
  assert.equal(await s.extend("a", "w2", T0 + 5000, 0.3), false, "only the holder renews");
  assert.equal(await s.extend("a", "w1", T0 + 5000, 0.3), true);
  assert.equal(await s.extend("a", "w1", T0 + 5000, null), true, "null keeps the progress");
  assert.equal((await s.get("a"))!.progress, 0.3);
  const taken = (await s.claim(T0 + 6000, "w2", T0 + 9000))!;
  assert.deepEqual([taken.worker, taken.attempts], ["w2", 2], "a lapsed lease is taken over");
  assert.equal(await s.settle("a", "w1", { status: "done", error: null }, T0 + 7000), false, "the old holder cannot settle");
  assert.equal(await s.settle("a", "w2", { status: "queued", runAt: T0 + 60_000, error: "boom" }, T0 + 7000), true);
  let r = (await s.get("a"))!;
  assert.deepEqual([r.status, r.runAt, r.error, r.key, r.worker], ["queued", T0 + 60_000, "boom", "k1", null], "a retry keeps its key");
  await s.claim(T0 + 60_000, "w1", T0 + 61_000);
  assert.equal(await s.settle("a", "w1", { status: "dead", error: "it's \"over\"; DROP TABLE x" }, T0 + 60_500), true);
  r = (await s.get("a"))!;
  assert.deepEqual([r.status, r.error, r.key], ["dead", "it's \"over\"; DROP TABLE x", null], "an ended job frees its key");

  assert.equal(await s.move("a", ["queued"], { status: "cancelled" }, T0), false);
  assert.equal(await s.move("a", ["dead", "cancelled"], { status: "queued", runAt: T0 + 1, attempts: 0 }, T0 + 2), true);
  r = (await s.get("a"))!;
  assert.deepEqual([r.status, r.runAt, r.attempts, r.updated], ["queued", T0 + 1, 0, T0 + 2]);
  await s.add(record({ id: "k", key: "kept", keepKey: true }));
  assert.equal(await s.move("k", ["queued"], { status: "cancelled" }, T0 + 3), true);
  assert.equal((await s.get("k"))!.key, "kept", "keepKey survives a cancel");

  await s.add(record({ id: "c", name: "other", created: T0 + 10 }));
  assert.deepEqual((await s.list({})).map((x) => x.id), ["c", "k", "a"], "newest first");
  assert.deepEqual((await s.list({ name: "other" })).map((x) => x.id), ["c"]);
  assert.deepEqual((await s.list({ status: "cancelled" })).map((x) => x.id), ["k"]);
  assert.deepEqual((await s.list({ name: "n'; --", limit: 1 })), []);
  assert.equal((await s.list({ limit: 1 })).length, 1);
  assert.deepEqual(await s.counts(), { queued: 2, running: 0, done: 0, dead: 0, cancelled: 1 });
  await s.sweep(T0 + 4);
  assert.equal(await s.get("k"), null, "a cancelled job is swept");
  assert.notEqual(await s.get("a"), null, "a queued one is not");
});

test("many workers on many pools: every job runs exactly once", { skip }, async () => {
  const { store: s, table } = await store();
  const pg = (await import("pg")).default;
  const pools = [new pg.Pool({ connectionString: URL_, max: 4 }), new pg.Pool({ connectionString: URL_, max: 4 })];
  try {
    const ran: string[] = [];
    const work = defineJob("work", [{ name: "n", type: "number" }], async (_ctx, n: number) => {
      ran.push(String(n));
      await new Promise((r) => setTimeout(r, 2));
    });
    const mk = (st: PgJobStore) => createJobs({ jobs: [work], store: st, concurrency: 4, onError: () => {} });
    const queues = [mk(s), mk(new PgJobStore(pools[0]!, table)), mk(new PgJobStore(pools[1]!, table))];
    for (let i = 0; i < 60; i++) await queues[i % 3]!.enqueue(null, work, { n: i });
    await Promise.all(queues.map((q) => q.drain()));
    assert.equal(ran.length, 60, "none twice");
    assert.equal(new Set(ran).size, 60, "none missed");
    assert.equal((await queues[0]!.counts()).done, 60);
  } finally {
    await Promise.all(pools.map((x) => x.end()));
  }
});

test("retries, the dead list, keys, cron slots and progress through createJobs", { skip }, async () => {
  const { store: s } = await store();
  let clock = T0;
  let fail = true;
  const seen: (number | null)[] = [];
  const flaky = defineJob("flaky", [], () => {
    if (fail) throw new Error("nope");
  }, { attempts: 2 });
  const fatal = defineJob("fatal", [], () => {
    throw new JobError("bad input", { retry: false });
  });
  const report = defineJob("report", [], async (ctx: JobContext) => {
    ctx.progress(0.5);
    seen.push((await s.get(ctx.job.id))!.progress);
  });
  const mk = () =>
    createJobs({ jobs: [flaky, fatal, report], store: s, schedule: [{ cron: "*/5 * * * *", job: report }], now: () => clock, random: () => 0.5, onError: () => {} });
  const a = mk();
  const b = mk();
  const id = (await a.enqueue(null, flaky, {}, { key: "once" })) as string;
  assert.equal(await b.enqueue(null, flaky, {}, { key: "once" }), false);
  await a.drain();
  clock += 60_000;
  await b.drain();
  assert.deepEqual([(await a.get(id))!.status, (await a.get(id))!.attempts], ["dead", 2]);
  fail = false;
  assert.equal(await a.retry(id), true);
  await b.drain();
  assert.equal((await a.get(id))!.status, "done");
  const f = (await a.enqueue(null, fatal, {})) as string;
  await a.drain();
  assert.deepEqual([(await a.get(f))!.status, (await a.get(f))!.attempts, (await a.get(f))!.error], ["dead", 1, "bad input"]);

  clock = T0 + 5 * 60_000;
  await Promise.all([a.drain(), b.drain()]);
  clock += 5 * 60_000;
  await Promise.all([b.drain(), a.drain()]);
  assert.equal((await a.list({ name: "report" })).filter((r) => r.status === "done").length, 2);
  assert.deepEqual(seen, [null, null], "progress is kept with the lease, not on every call");
});

test("declarations", () => {
  assert.throws(() => new PgJobStore({} as never), /pool/);
  assert.throws(() => new PgJobStore({ query: async () => ({ rows: [] }) }, 'x"; DROP'), /table name/);
  assert.throws(() => new PgJobStore({ query: async () => ({ rows: [] }) }, "a".repeat(60)), /table name/);
});

test("a failed setup is retried on the next call", async () => {
  let calls = 0;
  const s = new PgJobStore({
    query: async (t) => {
      calls++;
      if (calls === 1) throw new Error("down");
      void t;
      return { rows: [] };
    },
  });
  await assert.rejects(s.get("x"), /down/);
  assert.equal(await s.get("x"), null);
  assert.equal(calls, 4, "create table, index, then the select");
});
