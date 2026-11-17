import { test } from "node:test";
import assert from "node:assert/strict";
import { openSqlite } from "@weft/data/sqlite";
import { createJobs, MemoryJobStore, SqlJobStore } from "../src/jobs.ts";
import {
  createWorkflows,
  defineWorkflow,
  MemoryWorkflowStore,
  SqlWorkflowStore,
  type WorkflowContext,
  type WorkflowStore,
} from "../src/workflows.ts";

const T0 = Date.UTC(2026, 10, 14, 10, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;

type Body = (wf: WorkflowContext, who: string) => unknown;

function harness(body: Body, kind: "memory" | "sql" = "memory", o: { attempts?: number } = {}) {
  let clock = T0;
  const db = kind === "sql" ? openSqlite(":memory:") : null;
  const store: WorkflowStore = db ? new SqlWorkflowStore(db) : new MemoryWorkflowStore();
  const errors: unknown[] = [];
  const users = new Map<string, { id: string; name: string }>([["ada", { id: "ada", name: "Ada" }]]);
  const flow = defineWorkflow("flow", [{ name: "who", type: "string" }], (wf, who: string) => body(wf, who));
  const workflows = createWorkflows({ workflows: [flow], store, now: () => clock, onError: (e) => errors.push(e), ...o });
  const jobs = createJobs({
    jobs: [workflows.job],
    store: db ? new SqlJobStore(db) : new MemoryJobStore(),
    user: (id) => users.get(id) ?? null,
    now: () => clock,
    random: () => 0.5,
    onError: () => {},
  });
  workflows.use(jobs);
  return {
    workflows,
    jobs,
    flow,
    errors,
    users,
    advance: async (ms: number) => {
      clock += ms;
      await jobs.drain();
    },
    now: () => clock,
  };
}

for (const kind of ["memory", "sql"] as const) {
  test(`${kind}: steps run once; a sleep ends the execution and resumes after the time`, async () => {
    const effects: string[] = [];
    const h = harness(async (wf, who) => {
      const a = await wf.step("welcome", () => (effects.push(`welcome ${who}`), { sent: 1 }));
      await wf.sleep("wait", 3 * DAY);
      await wf.step("remind", () => effects.push(`remind ${who} after ${a.sent}`));
      return { ok: true };
    }, kind);
    const id = (await h.workflows.start(null, h.flow, { who: "ada" }))!;
    await h.jobs.drain();
    assert.deepEqual(effects, ["welcome ada"]);
    let run = (await h.workflows.get(id))!;
    assert.equal(run.status, "running");
    assert.equal(run.wakeAt, T0 + 3 * DAY);
    await h.advance(DAY);
    assert.deepEqual(effects, ["welcome ada"], "not yet");
    await h.advance(2 * DAY);
    assert.deepEqual(effects, ["welcome ada", "remind ada after 1"], "the stored step result is replayed");
    run = (await h.workflows.get(id))!;
    assert.equal(run.status, "done");
    assert.deepEqual(run.result, { ok: true });
    assert.equal(run.wakeAt, null);
  });

  test(`${kind}: a failed step is retried without running the steps before it again`, async () => {
    let first = 0;
    let flaky = 0;
    const h = harness(async (wf) => {
      await wf.step("one", () => ++first);
      await wf.step("two", () => {
        if (++flaky < 3) throw new Error("provider down");
        return "ok";
      });
    }, kind);
    const id = (await h.workflows.start(null, h.flow, { who: "ada" }))!;
    for (let i = 0; i < 5; i++) await h.advance(MIN);
    assert.equal((await h.workflows.get(id))!.status, "done");
    assert.equal(first, 1);
    assert.equal(flaky, 3);
  });

  test(`${kind}: waitFor takes a signal sent before or after the wait, once, and times out to null`, async () => {
    const got: unknown[] = [];
    const h = harness(async (wf, who) => {
      got.length = 0;
      await wf.step("before", () => 1);
      got.push(await wf.waitFor("a", "approved", { key: who }));
      got.push(await wf.waitFor("b", "approved", { key: who, timeoutMs: DAY }));
      got.push(await wf.waitFor("c", "approved", { key: who, timeoutMs: DAY }));
      return got.length;
    }, kind);
    await h.workflows.signal("approved", "ada", { by: "old" });
    await h.advance(1);
    const id = (await h.workflows.start(null, h.flow, { who: "ada" }))!;
    await h.workflows.signal("approved", "bob", { by: "other key" });
    await h.workflows.signal("rejected", "ada", { by: "other event" });
    assert.equal(await h.workflows.signal("approved", "ada", { by: "early" }), 0, "nobody waits yet: buffered");
    await h.jobs.drain();
    assert.equal(got.length, 1, "the early signal is taken by the first wait; the second waits");
    assert.deepEqual((got[0] as { payload: unknown }).payload, { by: "early" }, "not the one sent before the run");
    assert.deepEqual((await h.workflows.get(id))!.waiting, { event: "approved", key: "ada" });
    await h.advance(MIN);
    assert.equal(await h.workflows.signal("approved", "ada", { by: "late" }), 1, "the waiting run is woken");
    await h.jobs.drain();
    assert.deepEqual((got[1] as { payload: unknown }).payload, { by: "late" });
    assert.equal(got.length, 2, "the late signal is not taken twice");
    await h.advance(DAY);
    assert.equal(got[2], null, "timed out");
    const run = (await h.workflows.get(id))!;
    assert.equal(run.status, "done");
    assert.equal(run.result, 3);
  });

  test(`${kind}: duplicate wakes of one run do not run its steps twice`, async () => {
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(async (wf) => {
      await wf.step("slow", async () => {
        n++;
        await gate;
      });
    }, kind);
    const id = (await h.workflows.start(null, h.flow, { who: "ada" }))!;
    for (let i = 0; i < 3; i++) await h.jobs.enqueue(null, h.workflows.job, { run: id });
    const drained = h.jobs.drain();
    await new Promise((r) => setTimeout(r, 20));
    release();
    await drained;
    await h.advance(20 * MIN);
    assert.equal(n, 1);
    assert.equal((await h.workflows.get(id))!.status, "done");
  });
}

for (const kind of ["memory", "sql"] as const) test(`${kind}: a run acts as its starter, re-resolved at each execution; a start key admits one run`, async () => {
  const seen: unknown[] = [];
  const h = harness(async (wf) => {
    seen.push(wf.user);
    await wf.sleep("s", MIN);
    seen.push(wf.user);
  }, kind);
  const id = await h.workflows.start(null, h.flow, { who: "x" }, { as: { user: "ada" }, key: "onboard:ada" });
  assert.equal(await h.workflows.start(null, h.flow, { who: "x" }, { key: "onboard:ada" }), false);
  await h.jobs.drain();
  h.users.set("ada", { id: "ada", name: "Ada L." });
  await h.advance(MIN);
  assert.deepEqual(seen.at(-1), { id: "ada", name: "Ada L." });
  assert.deepEqual(seen[0], { id: "ada", name: "Ada" });
  assert.equal((await h.workflows.get(id as string))!.status, "done");
  assert.ok(await h.workflows.start(null, h.flow, { who: "x" }, { key: "onboard:ada" }), "the key is free once done");
});

for (const kind of ["memory", "sql"] as const) test(`${kind} store: a hold ends at its time, and only the holder saves`, async () => {
  const store: WorkflowStore = kind === "sql" ? new SqlWorkflowStore(openSqlite(":memory:")) : new MemoryWorkflowStore();
  const run = {
    id: "r1", name: "flow", args: ["a"], actor: null, status: "running" as const, history: {}, waiting: null, wakeAt: null,
    result: null, error: null, key: "k", created: T0, updated: T0, holder: null, holdUntil: 0,
  };
  assert.equal(await store.create(run), true);
  assert.equal(await store.create({ ...run, id: "r2" }), false, "the key is held");
  assert.ok(await store.acquire("r1", "a", T0 + MIN, T0));
  assert.equal(await store.acquire("r1", "b", T0 + 2 * MIN, T0 + 1), null, "held by a");
  assert.equal(await store.save("r1", "b", { history: { x: { v: 1 } } }, T0), false, "b does not hold it");
  assert.ok(await store.acquire("r1", "b", T0 + 3 * MIN, T0 + MIN + 1), "a's hold ran out");
  assert.equal(await store.save("r1", "a", { history: { x: { v: 2 } } }, T0), false, "a lost it");
  assert.equal(await store.save("r1", "b", { history: { x: { v: 3 } }, status: "done" }, T0), true);
  const got = (await store.get("r1"))!;
  assert.deepEqual(got.history, { x: { v: 3 } });
  assert.equal(got.key, null);
  assert.equal(got.holder, null);
  assert.equal(await store.acquire("r1", "c", T0 + 9 * MIN, T0 + 9 * MIN), null, "done: not run again");
  assert.equal(await store.create({ ...run, id: "r3" }), true, "the key is free");
});

test("cancel stops a waiting run; failure after the last attempt", async () => {
  let after = 0;
  const h = harness(async (wf, who) => {
    if (who === "fail") await wf.step("boom", () => {
      throw new Error("no such account");
    });
    await wf.sleep("s", DAY);
    await wf.step("after", () => ++after);
  }, "memory", { attempts: 2 });
  const id = (await h.workflows.start(null, h.flow, { who: "ada" }))!;
  await h.jobs.drain();
  assert.equal(await h.workflows.cancel(id), true);
  assert.equal(await h.workflows.cancel(id), false);
  await h.advance(2 * DAY);
  assert.equal(after, 0);
  assert.equal((await h.workflows.get(id))!.status, "cancelled");

  const bad = (await h.workflows.start(null, h.flow, { who: "fail" }))!;
  for (let i = 0; i < 4; i++) await h.advance(MIN);
  const run = (await h.workflows.get(bad))!;
  assert.equal(run.status, "failed");
  assert.equal(run.error, "no such account");
  assert.ok(h.errors.length >= 2);
  assert.deepEqual((await h.workflows.list({ status: "failed" })).map((r) => r.id), [bad]);
});

test("misuse is refused", async () => {
  const h = harness(async (wf) => {
    await wf.step("same", () => 1);
    await wf.step("same", () => 2);
  });
  const id = (await h.workflows.start(null, h.flow, { who: "a" }))!;
  await h.advance(MIN);
  const run = (await h.workflows.get(id))!;
  assert.equal(run.status, "failed", "a step name used twice fails at once");
  assert.match(run.error!, /used twice/);

  const r = harness(async (wf) => {
    await wf.step("date", () => new Date(T0));
    return wf.step("fn", () => (() => 1) as never);
  });
  const id2 = (await r.workflows.start(null, r.flow, { who: "a" }))!;
  await r.advance(MIN);
  assert.match((await r.workflows.get(id2))!.error!, /not JSON/);

  await assert.rejects(h.workflows.start(null, h.flow, { who: 1 } as never), /who/);
  await assert.rejects(h.workflows.start(null, defineWorkflow("other", [], () => {}), {}), /not one of these/);
  await assert.rejects(h.workflows.signal("bad event!", "k"), /event name/);
  await assert.rejects(h.workflows.signal("ok", ""), /key/);
  await assert.rejects(h.workflows.signal("ok", "k", "x".repeat(70_000)), /payload/);
  const f = defineWorkflow("f", [], () => {});
  assert.throws(() => defineWorkflow("no spaces", [], () => {}), /valid name/);
  assert.throws(() => createWorkflows({ workflows: [] }), /at least one/);
  assert.throws(() => createWorkflows({ workflows: [f, defineWorkflow("f", [], () => {})] }), /two workflows/);
  assert.throws(() => createWorkflows({ workflows: [f], attempts: 0 }), /attempts/);
  assert.throws(() => new SqlWorkflowStore(openSqlite(":memory:"), "x;drop"), /table name/);
  await assert.rejects(createWorkflows({ workflows: [f] }).start(null, f), /use\(jobs\)/);
});
