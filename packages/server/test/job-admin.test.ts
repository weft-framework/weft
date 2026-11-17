import { test } from "node:test";
import assert from "node:assert/strict";
import { canSee, onRead, type Model } from "@weft-framework/data";
import { defineComponent } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";
import { defineAction } from "../src/action.ts";
import { login } from "../src/auth.ts";
import type { PageContext } from "../src/context.ts";
import { createJobs, defineJob, JobError, type JobContext } from "../src/jobs.ts";
import { defineJobAdmin } from "../src/job-admin.ts";

const ORIGIN = "http://app.test";
const T0 = Date.UTC(2026, 10, 14, 10);
let prefixes = 0;

const ctxOf = (id: string | null) => ({ user: id === null ? null : { id } }) as unknown as PageContext;

function setup(showArgs?: boolean | ((j: { name: string }) => boolean)) {
  let clock = T0;
  const behaviour = { fail: false, release: () => {} };
  const send = defineJob("sendInvoice", [{ name: "to", type: "string" }], async (_ctx, to: string) => {
    if (behaviour.fail) throw new JobError(`SMTP refused ${to}`, { retry: false });
  });
  const exportCsv = defineJob("exportCsv", [{ name: "rows", type: "number" }], async (ctx: JobContext, rows: number) => {
    for (let i = 1; i <= rows; i++) {
      clock += 300;
      ctx.progress(i / rows);
    }
  });
  const jobs = createJobs({
    jobs: [send, exportCsv],
    now: () => clock,
    random: () => 0.5,
    onError: () => {},
    track: { prefix: `T${++prefixes}` },
  });
  const admin = defineJobAdmin({ jobs, allow: (ctx) => (ctx.user as { id?: string } | null)?.id === "ops", ...(showArgs !== undefined ? { showArgs } : {}) });
  return { admin, jobs, send, exportCsv, behaviour, tick: (ms: number) => (clock += ms) };
}

test("only allowed operators get anything", async () => {
  const { admin, jobs, send } = setup();
  const id = (await jobs.enqueue(null, send, { to: "a@b.example" })) as string;
  for (const who of [null, "mia"]) {
    assert.equal(await admin.overview(ctxOf(who)), null);
    assert.equal(await admin.job(ctxOf(who), id), null);
    assert.deepEqual(await admin.cancel(ctxOf(who), id), { ok: false, reason: "not found" });
    assert.deepEqual(await admin.retry(ctxOf(who), id), { ok: false, reason: "not found" });
  }
  assert.equal((await jobs.get(id))!.status, "queued", "nothing changed");
  const throwing = defineJobAdmin({ jobs, allow: () => { throw new Error("x"); } });
  assert.equal(await throwing.overview(ctxOf("ops")), null);
  const ops = ctxOf("ops");
  assert.equal(await admin.job(ops, "nothex"), null);
  assert.equal(await admin.job(ops, "0".repeat(32)), null);
  assert.equal((await admin.job(ops, id))!.id, id);
});

test("counts, filters, details; arguments hidden unless allowed", async () => {
  const { admin, jobs, send, exportCsv, behaviour } = setup();
  behaviour.fail = true;
  const bad = (await jobs.enqueue(null, send, { to: "x@b.example" }, { as: { user: "ada", tenant: "acme" } })) as string;
  await jobs.drain();
  behaviour.fail = false;
  await jobs.enqueue(null, send, { to: "ok@b.example" }, { delayMs: 60_000 });
  await jobs.enqueue(null, exportCsv, { rows: 2 }, { delayMs: 60_000 });
  const ops = ctxOf("ops");
  let o = (await admin.overview(ops))!;
  assert.equal(o.counts.queued, 2);
  assert.equal(o.counts.dead, 1);
  assert.equal(o.jobs.length, 3);
  assert.ok(o.jobs.every((j) => j.args === null), "arguments are not given");
  assert.deepEqual(o.names.sort(), ["exportCsv", "sendInvoice"]);
  o = (await admin.overview(ops, { status: "dead" }))!;
  assert.deepEqual([o.jobs.length, o.status], [1, "dead"]);
  o = (await admin.overview(ops, { name: "exportCsv" }))!;
  assert.deepEqual(o.jobs.map((j) => j.name), ["exportCsv"]);
  o = (await admin.overview(ops, { status: "bogus", name: "x<y" }))!;
  assert.deepEqual([o.jobs.length, o.status, o.name], [3, null, null], "unknown filters are ignored");
  await assert.rejects(admin.overview(ops, { limit: 0 }), /limit/);
  const j = (await admin.job(ops, bad))!;
  assert.deepEqual([j.status, j.args, j.canRetry, j.canCancel, j.error], ["dead", null, true, true, "SMTP refused x@b.example"]);
  assert.deepEqual(j.queuedBy, { user: "ada", tenant: "acme" });

  const s = setup((x) => x.name === "sendInvoice");
  const id = (await s.jobs.enqueue(null, s.send, { to: "<i>x</i>" }, { delayMs: 60_000 })) as string;
  const e = (await s.jobs.enqueue(null, s.exportCsv, { rows: 1 }, { delayMs: 60_000 })) as string;
  const shown = (await s.admin.job(ops, id))!.args!;
  assert.deepEqual(shown, ["<i>x</i>"]);
  (shown as string[])[0] = "changed";
  assert.deepEqual((await s.jobs.get(id))!.args, ["<i>x</i>"], "a copy");
  assert.equal((await s.admin.job(ops, e))!.args, null);
});

test("retry and cancel in the right state; the actions", async () => {
  const { admin, jobs, send, behaviour } = setup();
  behaviour.fail = true;
  const id = (await jobs.enqueue(null, send, { to: "x@y.example" })) as string;
  await jobs.drain();
  behaviour.fail = false;
  const ops = ctxOf("ops");
  let r = await admin.retry(ops, id);
  assert.equal(r.ok, true);
  assert.equal((r as { job: { status: string } }).job.status, "queued");
  assert.deepEqual(await admin.retry(ops, id), { ok: false, reason: "wrong state" });
  r = await admin.cancel(ops, id);
  assert.equal((await jobs.get(id))!.status, "cancelled");
  assert.deepEqual(await admin.cancel(ops, id), { ok: false, reason: "wrong state" });

  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: { "/": { component: defineComponent("Home", () => ({ render: () => `<p>home</p>` })) as never } },
    actions: { signIn: defineAction("signIn", [{ name: "id", type: "string" }], async (ctx, u: string) => void (await login(ctx, u))) as never, ...admin.actions },
    auth: { user: (u) => ({ id: u }) },
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const call = async (cookie: string, name: string, body: object) => {
    const html = await (await app.fetch(new Request(`${ORIGIN}/`, { headers: { cookie } })))!.text();
    const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";
    const res = (await app.fetch(
      new Request(`${ORIGIN}/?/${name}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": csrf }, body: JSON.stringify(body) }),
    ))!;
    return { res, json: (await res.json()) as { value?: { ok: boolean; reason?: string } } };
  };
  const anon = cookieOf((await app.fetch(new Request(`${ORIGIN}/`)))!);
  const signed = cookieOf((await call(anon, "signIn", { id: "ops" })).res);
  assert.deepEqual((await call(anon, "jobsRetry", { id })).json.value, { ok: false, reason: "not found" });
  assert.equal((await call(signed, "jobsRetry", { id })).json.value!.ok, true);
  assert.equal((await jobs.get(id))!.status, "queued");
  assert.equal((await call(signed, "jobsCancel", { id })).json.value!.ok, true);
});

test("progress: only the user who queued a tracked job reads it, as it moves", async () => {
  const { jobs, send, exportCsv, behaviour } = setup();
  const id = (await jobs.enqueue(null, exportCsv, { rows: 10 }, { as: { user: "ada" }, track: true })) as string;
  assert.deepEqual(jobs.progress({ id: "ada" }, id), { name: "exportCsv", status: "queued", progress: null });
  assert.equal(jobs.progress({ id: "bob" }, id), null, "another user sees nothing");
  assert.equal(jobs.progress(null, id), null);
  assert.equal(jobs.progress({ id: "ada", tracker: true }, id) !== null, true, "the owner, whatever else the actor holds");
  const M = jobs.models.JobProgress!;
  assert.equal(M.as({ id: "ada", tracker: true } as never).update((r) => r.id === id, { status: "done" }), 0);
  assert.equal(M.as({ id: "ada" } as never).create({ id: "x", user: "ada", name: "n", status: "done", progress: 1, updated: 0 }), undefined);

  const reads: [Model<unknown>, unknown][] = [];
  const stop = onRead((m, a) => reads.push([m, a]));
  jobs.progress({ id: "ada" }, id);
  jobs.progress({ id: "bob" }, id);
  stop();
  const mine = reads.find(([, a]) => (a as { id: string }).id === "ada")!;
  const theirs = reads.find(([, a]) => (a as { id: string }).id === "bob")!;
  const seen: number[] = [];
  const relevant: boolean[] = [];
  const other: boolean[] = [];
  const unsub = M.feed.subscribe((ch) => {
    if (ch.model !== M.name) return;
    relevant.push(canSee(mine[0], mine[1] as never, ch));
    other.push(canSee(theirs[0], theirs[1] as never, ch));
    const row = (ch as { after?: { progress: number | null } }).after;
    if (row && row.progress !== null) seen.push(row.progress);
  });
  await jobs.drain();
  unsub();
  assert.deepEqual(jobs.progress({ id: "ada" }, id), { name: "exportCsv", status: "done", progress: 1 });
  assert.ok(relevant.length > 0 && relevant.every(Boolean));
  assert.ok(other.every((x) => !x));
  assert.ok(seen.length >= 4 && seen.length <= 7, `progress writes: ${seen.join(",")}`);
  assert.equal(seen.at(-1), 1);

  behaviour.fail = true;
  const f = (await jobs.enqueue(null, send, { to: "x" }, { as: { user: "ada" }, track: true })) as string;
  await jobs.drain();
  assert.equal(jobs.progress({ id: "ada" }, f)!.status, "failed");
  await jobs.retry(f);
  assert.equal(jobs.progress({ id: "ada" }, f)!.status, "queued");
  await jobs.cancel(f);
  assert.equal(jobs.progress({ id: "ada" }, f)!.status, "cancelled");
  const plain = (await jobs.enqueue(null, send, { to: "x" }, { as: { user: "ada" } })) as string;
  assert.equal(jobs.progress({ id: "ada" }, plain), null);

  await assert.rejects(jobs.enqueue(null, send, { to: "x" }, { track: true }), /needs the user/);
  await assert.rejects(jobs.enqueue(null, send, { to: "x" }, { as: { user: "a" }, track: "yes" as never }), /true or false/);
  const untracked = createJobs({ jobs: [defineJob("j", [], () => {})] });
  await assert.rejects(untracked.enqueue(null, defineJob("j", [], () => {}), {}, { as: { user: "a" }, track: true }));
  assert.equal(untracked.progress({ id: "a" }, "x"), null);
  assert.throws(() => createJobs({ jobs: [], track: { prefix: "bad prefix" } }), /track.prefix/);
});

test("finished progress rows are swept with the jobs", async () => {
  const { jobs, send, tick } = setup();
  const id = (await jobs.enqueue(null, send, { to: "x" }, { as: { user: "ada" }, track: true })) as string;
  await jobs.drain();
  assert.equal(jobs.progress({ id: "ada" }, id)!.status, "done");
  tick(25 * 3600_000);
  await jobs.tick();
  assert.equal(jobs.progress({ id: "ada" }, id), null);
});

test("declarations", () => {
  const jobs = createJobs({ jobs: [defineJob("j", [], () => {})] });
  assert.throws(() => defineJobAdmin({ jobs } as never), /allow/);
  assert.throws(() => defineJobAdmin({ allow: () => true } as never), /createJobs/);
  assert.throws(() => defineJobAdmin({ jobs, allow: () => true, name: "Bad-name" }), /name/);
  assert.deepEqual(Object.keys(defineJobAdmin({ jobs, allow: () => true, name: "queue" }).actions), ["queueRetry", "queueCancel"]);
});
