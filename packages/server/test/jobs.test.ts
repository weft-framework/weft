import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent } from "@weft-framework/runtime";
import { openSqlite } from "@weft-framework/data/sqlite";
import { defineAction } from "../src/action.ts";
import { createApp } from "../src/app.ts";
import { login } from "../src/auth.ts";
import {
  createJobs,
  defineJob,
  JobError,
  MemoryJobStore,
  parseCron,
  SqlJobStore,
  type JobContext,
  type JobsOptions,
  type JobStore,
} from "../src/jobs.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";
const T0 = Date.UTC(2026, 10, 14, 10, 0, 0);
const iso = (t: number) => new Date(t).toISOString().slice(0, 16);

test("cron expressions", () => {
  const next = (e: string, from = T0) => iso(parseCron(e).next(from));
  assert.equal(next("* * * * *"), "2026-11-14T10:01");
  assert.equal(next("*/15 * * * *"), "2026-11-14T10:15");
  assert.equal(next("0 6 * * *"), "2026-11-15T06:00");
  assert.equal(next("30 9 * * mon-fri"), "2026-11-16T09:30", "Saturday the 14th: Monday next");
  assert.equal(next("0 0 1 jan *"), "2027-01-01T00:00");
  assert.equal(next("0 12 13 * 5"), "2026-11-20T12:00", "day 13 or a Friday: the Friday comes first");
  assert.equal(next("0 0 29 2 *"), "2028-02-29T00:00");
  assert.equal(next("@hourly"), "2026-11-14T11:00");
  assert.equal(next("@weekly"), "2026-11-15T00:00");
  assert.equal(next("0 0 * * 7"), "2026-11-15T00:00", "7 is Sunday too");
  assert.equal(next("5,10-12/2 * * * *"), "2026-11-14T10:05");
  assert.equal(next("0 0 * * *", Date.UTC(2026, 11, 31, 23, 59, 30)), "2027-01-01T00:00");
  for (const bad of ["* * * *", "60 * * * *", "* * 0 * *", "5-1 * * * *", "*/0 * * * *", "* * * foo *", "a b c d e"]) {
    assert.throws(() => parseCron(bad), /cron/, bad);
  }
  assert.throws(() => parseCron("0 0 30 2 *").next(T0), /never fires/);
});

function harness(extra: Partial<JobsOptions> = {}, store: JobStore = new MemoryJobStore()) {
  let clock = T0;
  const runs: { name: string; args: unknown[]; user: unknown; attempt: number }[] = [];
  const errors: unknown[] = [];
  const behaviour = new Map<string, (ctx: JobContext) => unknown>();
  const record = (name: string) => (ctx: JobContext, ...args: unknown[]) => {
    runs.push({ name, args, user: ctx.user, attempt: ctx.job.attempt });
    return behaviour.get(name)?.(ctx);
  };
  const welcome = defineJob("welcome", [{ name: "user", type: "string" }, { name: "tags", type: "string", list: true, optional: true }], record("welcome"));
  const flaky = defineJob("flaky", [], record("flaky"), { attempts: 3 });
  const slow = defineJob("slow", [], record("slow"), { attempts: 2, timeoutMs: 1000 });
  const report = defineJob("report", [], record("report"));
  const users = new Set(["ada", "eve"]);
  const jobs = createJobs({
    jobs: [welcome, flaky, slow, report],
    store,
    user: (id, tenant) => (users.has(id) ? { id, tenant: tenant ?? null } : null),
    onError: (e) => errors.push(e),
    now: () => clock,
    random: () => 0.5,
    ...extra,
  });
  return { jobs, store, runs, errors, behaviour, users, welcome, flaky, slow, report, tick: (ms: number) => (clock += ms), now: () => clock };
}

test("arguments are checked when queued and a job runs once", async () => {
  const h = harness();
  await assert.rejects(h.jobs.enqueue(null, h.welcome, {}), /user is required/);
  await assert.rejects(h.jobs.enqueue(null, h.welcome, { user: 1 }), /user: expected string/);
  await assert.rejects(h.jobs.enqueue(null, h.welcome, { user: "ada", extra: 1 }), /unknown argument/);
  const other = defineJob("welcome", [], () => {});
  await assert.rejects(h.jobs.enqueue(null, other as never), /not one of this queue's jobs/);

  const id = await h.jobs.enqueue(null, h.welcome, { user: "ada", tags: ["a", "b"] });
  assert.equal(typeof id, "string");
  await h.jobs.drain();
  assert.deepEqual(h.runs, [{ name: "welcome", args: ["ada", ["a", "b"]], user: null, attempt: 1 }]);
  const rec = (await h.jobs.get(id as string))!;
  assert.equal(rec.status, "done");
  await h.jobs.drain();
  assert.equal(h.runs.length, 1, "not run again");

  await h.jobs.enqueue(null, h.welcome, { user: "eve" });
  await h.jobs.drain();
  assert.deepEqual(h.runs[1].args, ["eve", undefined], "an absent optional stays absent");
  assert.equal((await h.jobs.counts()).done, 2);
  h.tick(25 * 3600_000);
  await h.jobs.tick();
  assert.equal((await h.jobs.counts()).done, 0, "done jobs are swept after a day");
});

test("a job runs as the actor that queued it, resolved when it runs", async () => {
  const h = harness();
  await h.jobs.enqueue(null, h.report, {}, { as: { user: "ada", tenant: "acme" } });
  await h.jobs.drain();
  assert.deepEqual(h.runs[0].user, { id: "ada", tenant: "acme" });

  const act = defineAction("go", [], async (ctx) => {
    await login(ctx, "eve");
    return h.jobs.enqueue(ctx, h.report, {});
  });
  const app = createApp({
    secret: SECRET,
    routes: { "/": { component: defineComponent("P", () => ({ render: () => "<p>x</p>" })) as never } },
    actions: { go: act as never },
    auth: { user: (id) => ({ id }) },
  });
  const page = (await app.fetch(new Request(ORIGIN + "/")))!;
  const cookie = page.headers.getSetCookie()[0].split(";")[0];
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(await page.text())![1];
  const res = (await app.fetch(
    new Request(`${ORIGIN}/?/go`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": csrf }, body: "{}" }),
  ))!;
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
  await h.jobs.drain();
  assert.deepEqual(h.runs[1].user, { id: "eve", tenant: null });

  await h.jobs.enqueue(null, h.report, {}, { as: { user: "eve" } });
  h.users.delete("eve");
  await h.jobs.drain();
  assert.equal(h.runs.length, 2);
  const [dead] = await h.jobs.list({ status: "dead" });
  assert.match(dead.error!, /no longer exists/);
  assert.equal(dead.attempts, 1);
});

test("failures retry with backoff, then the job is dead; the dashboard retries or cancels", async () => {
  const h = harness();
  h.behaviour.set("flaky", () => {
    throw new Error("smtp down");
  });
  const id = (await h.jobs.enqueue(null, h.flaky, {})) as string;
  await h.jobs.drain();
  assert.equal(h.runs.length, 1);
  let rec = (await h.jobs.get(id))!;
  assert.equal(rec.status, "queued");
  assert.equal(rec.error, "smtp down");
  assert.equal(rec.runAt, h.now() + 1000, "1 s (jitter at 0.5 is none)");
  h.tick(999);
  await h.jobs.drain();
  assert.equal(h.runs.length, 1, "not before the backoff");
  h.tick(1);
  await h.jobs.drain();
  assert.equal(h.runs.length, 2);
  assert.equal((await h.jobs.get(id))!.runAt, h.now() + 2000, "doubled");
  h.tick(2000);
  await h.jobs.drain();
  rec = (await h.jobs.get(id))!;
  assert.deepEqual([rec.status, rec.attempts, h.runs.map((r) => r.attempt)], ["dead", 3, [1, 2, 3]]);
  assert.deepEqual((await h.jobs.counts()).dead, 1);

  h.behaviour.delete("flaky");
  assert.equal(await h.jobs.retry(id), true);
  await h.jobs.drain();
  assert.equal((await h.jobs.get(id))!.status, "done");
  assert.equal(h.runs.at(-1)!.attempt, 1, "attempts counted afresh");
  assert.equal(await h.jobs.retry(id), false, "only dead or cancelled jobs");

  h.behaviour.set("flaky", () => {
    throw new JobError("bad input", { retry: false });
  });
  const once = (await h.jobs.enqueue(null, h.flaky, {})) as string;
  await h.jobs.drain();
  assert.deepEqual([(await h.jobs.get(once))!.status, (await h.jobs.get(once))!.attempts], ["dead", 1]);

  const later = (await h.jobs.enqueue(null, h.report, {}, { delayMs: 60_000 })) as string;
  assert.equal(await h.jobs.cancel(later), true);
  h.tick(60_000);
  await h.jobs.drain();
  assert.equal((await h.jobs.get(later))!.status, "cancelled");
  assert.ok(!h.runs.some((r) => r.name === "report"));
});

test("a run that times out is aborted and retried", async () => {
  const h = harness();
  let aborted = 0;
  h.behaviour.set("slow", (ctx) => {
    ctx.signal.addEventListener("abort", () => aborted++);
    return h.runs.length === 1 ? new Promise(() => {}) : undefined;
  });
  const id = (await h.jobs.enqueue(null, h.slow, {})) as string;
  await h.jobs.drain();
  assert.equal(aborted, 1);
  assert.match((await h.jobs.get(id))!.error!, /timed out/);
  h.tick(1000);
  await h.jobs.drain();
  assert.equal((await h.jobs.get(id))!.status, "done");
});

test("a job whose worker died is taken again when its lease runs out", async () => {
  const store = new MemoryJobStore();
  const h = harness({ leaseMs: 5000 }, store);
  const id = (await h.jobs.enqueue(null, h.report, {})) as string;
  assert.equal(store.claim(h.now(), "ghost", h.now() + 5000)!.id, id);
  await h.jobs.drain();
  assert.equal(h.runs.length, 0, "held by the other worker");
  h.tick(5001);
  await h.jobs.drain();
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].attempt, 2);
  assert.equal(store.settle(id, "ghost", { status: "done" }, h.now()), false, "the ghost cannot settle it any more");
});

test("keys: one queued or running job per key", async () => {
  const h = harness();
  const a = await h.jobs.enqueue(null, h.report, {}, { key: "daily" });
  assert.equal(typeof a, "string");
  assert.equal(await h.jobs.enqueue(null, h.report, {}, { key: "daily" }), false);
  await h.jobs.drain();
  assert.equal(typeof (await h.jobs.enqueue(null, h.report, {}, { key: "daily" })), "string", "free again once done");
  await assert.rejects(h.jobs.enqueue(null, h.report, {}, { key: "cron:x" }), /key/);
});

test("progress is stored while a job runs", async () => {
  const h = harness({ leaseMs: 5000 });
  let resolve!: () => void;
  h.behaviour.set("report", (ctx) => {
    ctx.progress(0.5);
    return new Promise<void>((r) => (resolve = r));
  });
  const id = (await h.jobs.enqueue(null, h.report, {})) as string;
  const run = h.jobs.tick();
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal((await h.jobs.get(id))!.progress, 0.5, "renewed with the lease");
  resolve();
  await run;
  assert.equal((await h.jobs.get(id))!.status, "done");
});

for (const kind of ["memory", "sql"] as const) {
  test(`schedules run once per slot across instances (${kind})`, async () => {
    const store: JobStore = kind === "sql" ? new SqlJobStore(openSqlite(":memory:")) : new MemoryJobStore();
    const one = harness({}, store);
    const sched = (h: ReturnType<typeof harness>) => [{ cron: "*/5 * * * *", job: h.report }];
    let clock = T0;
    const mk = (h: ReturnType<typeof harness>) =>
      createJobs({ jobs: [h.report], store, schedule: sched(h), now: () => clock, onError: (e) => h.errors.push(e) });
    const two = harness({}, store);
    const a = mk(one);
    const b = mk(two);
    await a.drain();
    await b.drain();
    assert.equal(one.runs.length + two.runs.length, 0, "nothing due yet");
    clock += 5 * 60_000;
    await a.drain();
    await b.drain();
    assert.equal(one.runs.length + two.runs.length, 1, "one run for the 10:05 slot");
    clock += 60 * 60_000;
    await b.drain();
    await a.drain();
    assert.equal(one.runs.length + two.runs.length, 2);
    const slots = (await a.list({ name: "report" })).map((r) => iso(r.runAt)).sort();
    assert.deepEqual(slots, ["2026-11-14T10:05", "2026-11-14T11:05"]);
  });
}

test("SQL store: claims, retries, keys and the dashboard", async () => {
  const db = openSqlite(":memory:");
  const h = harness({}, new SqlJobStore(db));
  const other = createJobs({ jobs: [h.welcome, h.flaky, h.slow, h.report], store: new SqlJobStore(db), now: h.now, onError: () => {} });
  for (let i = 0; i < 10; i++) await h.jobs.enqueue(null, h.welcome, { user: `u${i}` });
  await Promise.all([h.jobs.drain(), other.drain()]);
  assert.equal(h.runs.length, 10);
  assert.equal(new Set(h.runs.map((r) => r.args[0])).size, 10);
  assert.equal((await h.jobs.counts()).done, 10);

  h.behaviour.set("flaky", () => {
    throw new Error("nope");
  });
  const id = (await h.jobs.enqueue(null, h.flaky, {}, { key: "k" })) as string;
  assert.equal(await h.jobs.enqueue(null, h.flaky, {}, { key: "k" }), false);
  for (let i = 0; i < 3; i++) {
    await h.jobs.drain();
    h.tick(10_000);
  }
  const rec = (await h.jobs.get(id))!;
  assert.deepEqual([rec.status, rec.attempts, rec.error, rec.key], ["dead", 3, "nope", null]);
  assert.equal(typeof (await h.jobs.enqueue(null, h.flaky, {}, { key: "k" })), "string", "a dead job frees its key");
  assert.equal((await h.jobs.list({ status: "dead" })).length, 1);
  assert.equal(await h.jobs.cancel(id), true);
  assert.equal((await h.jobs.counts()).cancelled, 1);

  h.tick(25 * 3600_000);
  await h.jobs.tick();
  assert.equal((await h.jobs.counts()).done, 0);
});

test("configuration is checked", () => {
  const j = defineJob("a", [], () => {});
  assert.throws(() => defineJob("not valid", [], () => {}), /job name/);
  assert.throws(() => defineJob("b", [], () => {}, { attempts: 0 }), /attempts/);
  assert.throws(() => defineJob("b", [], () => {}, { timeoutMs: 10 }), /timeoutMs/);
  assert.throws(() => createJobs({ jobs: [j, defineJob("a", [], () => {})] }), /two jobs/);
  assert.throws(() => createJobs({ jobs: [j], concurrency: 0 }), /concurrency/);
  assert.throws(() => createJobs({ jobs: [j], schedule: [{ cron: "* * * * *", job: defineJob("c", [], () => {}) }] }), /one of `jobs`/);
  assert.throws(() => createJobs({ jobs: [j], schedule: [{ cron: "nope", job: j }] }), /cron/);
  assert.throws(() => createJobs({ jobs: [j], schedule: [{ cron: "* * * * *", job: j }, { cron: "0 * * * *", job: j }] }), /two schedules/);
});
