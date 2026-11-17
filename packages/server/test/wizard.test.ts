import { test } from "node:test";
import assert from "node:assert/strict";
import { openSqlite } from "@weft-framework/data/sqlite";
import type { PageContext } from "../src/context.ts";
import { defineWizard, MemoryDraftStore, SqlDraftStore, type DraftStore, type WizardValues } from "../src/wizard.ts";

function ctx(user: string | null, session = "s1", path = "/onboard"): PageContext {
  const url = new URL(`http://app.test${path}`);
  return { request: new Request(url), url, params: {}, query: url.searchParams, session, user: user ? { id: user } : null };
}

function setup(store: DraftStore = new MemoryDraftStore(), extra: { anonymous?: boolean } = {}) {
  let clock = Date.UTC(2026, 10, 14);
  const completed: WizardValues[] = [];
  let failNext = false;
  const wizard = defineWizard({
    name: "onboarding",
    store,
    ...extra,
    now: () => clock,
    steps: [
      {
        id: "profile",
        label: "Profile",
        fields: {
          name: { type: "text", label: "Name", required: true, maxLength: 20 },
          email: { type: "email", label: "Email", required: true },
        },
      },
      {
        id: "team",
        fields: {
          size: { type: "choice", options: ["1", "2-10", "11+"], required: true },
          seats: { type: "number", integer: true, min: 1, max: 500 },
        },
        check: (v) => (v.size === "1" && typeof v.seats === "number" && v.seats > 1 ? { seats: "One person, one seat." } : undefined),
      },
      { id: "billing", when: (all) => all.size !== "1", fields: { vat: { type: "text", pattern: /^[A-Z]{2}[0-9A-Z]{2,12}$/, required: true } } },
      { id: "terms", fields: { agree: { type: "boolean", required: true }, start: { type: "date", min: "2026-01-01" } } },
    ],
    complete: (_ctx, values) => {
      if (failNext) {
        failNext = false;
        throw new Error("write failed");
      }
      completed.push(values);
      return completed.length;
    },
  });
  return { wizard, completed, tick: (ms: number) => (clock += ms), failOnce: () => (failNext = true) };
}

test("steps are checked as they are saved and the draft resumes after a reload", async () => {
  const { wizard, completed } = setup();
  const ada = ctx("ada");
  const first = (await wizard.view(ada))!;
  assert.deepEqual([first.step, first.index, first.total, first.back, first.last, first.saved], ["profile", 0, 4, null, false, null]);
  assert.deepEqual(first.fields.map((f) => [f.name, f.label, f.type, f.required, f.value]), [
    ["name", "Name", "text", true, null],
    ["email", "Email", "email", true, null],
  ]);

  const bad = await wizard.save(ada, "profile", new URLSearchParams({ name: "x".repeat(21), email: "nope" }));
  assert.deepEqual(bad, { ok: false, reason: "invalid", errors: { name: "At most 20 characters.", email: "Enter an email address." } });
  const polluted = new URLSearchParams();
  polluted.set("name", " Ada ");
  polluted.set("email", "ada@example.com");
  polluted.set("__proto__", "x");
  polluted.set("admin", "1");
  const ok = await wizard.save(ada, "profile", polluted);
  assert.deepEqual(ok, { ok: true, step: "team" });

  const again = (await wizard.view(ada))!;
  assert.equal(again.step, "team");
  assert.ok(again.saved);
  assert.deepEqual(await wizard.values(ada), { name: "Ada", email: "ada@example.com" }, "trimmed; unknown names dropped");

  assert.deepEqual(await wizard.save(ada, "team", { size: "1", seats: "3" }), { ok: false, reason: "invalid", errors: { seats: "One person, one seat." } });
  assert.deepEqual(await wizard.save(ada, "team", { size: "1", seats: 1 }), { ok: true, step: "terms" });
  const terms = (await wizard.view(ada))!;
  assert.deepEqual(terms.steps.map((s) => s.id), ["profile", "team", "terms"], "billing does not apply");
  assert.deepEqual([terms.index, terms.total, terms.back, terms.last], [2, 3, "team", true]);
  assert.equal((await wizard.finish(ada)).ok, false, "terms not done yet");
  assert.deepEqual(await wizard.save(ada, "terms", { agree: "on", start: "2026-02-30" }), { ok: false, reason: "invalid", errors: { start: "Enter a date." } });
  assert.deepEqual(await wizard.save(ada, "terms", { agree: "on", start: "2026-03-01" }), { ok: true, step: null });

  const done = await wizard.finish(ada);
  assert.deepEqual(done, { ok: true, result: 1 });
  assert.deepEqual(completed[0], { name: "Ada", email: "ada@example.com", size: "1", seats: 1, agree: true, start: "2026-03-01" });
  assert.deepEqual(await wizard.finish(ada), { ok: false, reason: "incomplete" }, "the draft is gone: completes once");
  assert.equal((await wizard.view(ada))!.step, "profile", "a new draft starts over");
});

test("no skipping steps, ?step= only for reachable ones, back keeps answers", async () => {
  const { wizard } = setup();
  const bo = ctx("bo");
  assert.deepEqual(await wizard.save(bo, "terms", { agree: true }), { ok: false, reason: "unreachable" });
  assert.deepEqual(await wizard.save(bo, "nope", {}), { ok: false, reason: "unreachable" });
  await wizard.save(bo, "profile", { name: "Bo", email: "bo@example.com" });
  await wizard.save(bo, "team", { size: "2-10" });
  assert.equal((await wizard.view(bo))!.step, "billing", "billing applies to a team");
  assert.deepEqual(await wizard.save(bo, "terms", { agree: true }), { ok: false, reason: "unreachable" }, "billing first");
  assert.equal((await wizard.view(ctx("bo", "s1", "/onboard?step=terms")))!.step, "billing");
  assert.equal((await wizard.view(ctx("bo", "s1", "/onboard?step=profile")))!.step, "profile");

  assert.deepEqual(await wizard.save(bo, "billing", { vat: "bad vat" }, { go: "back" }), { ok: true, step: "team" });
  assert.equal((await wizard.view(bo))!.step, "team");
  assert.deepEqual(await wizard.save(bo, "billing", { vat: "CZ12345678" }), { ok: true, step: "terms" });

  await wizard.save(bo, "team", { size: "1" }, { go: "stay" });
  assert.deepEqual((await wizard.view(bo))!.steps.map((s) => s.id), ["profile", "team", "terms"]);
  assert.deepEqual(await wizard.values(bo), { name: "Bo", email: "bo@example.com", size: "1" }, "billing answers left out");
  assert.deepEqual(await wizard.save(bo, "team", { size: "11+" }), { ok: true, step: "terms" }, "billing still done");
});

test("drafts belong to one owner; anonymous only when allowed; they expire", async () => {
  const { wizard, tick } = setup();
  await wizard.save(ctx("ada"), "profile", { name: "Ada", email: "ada@example.com" });
  assert.equal((await wizard.view(ctx("eve")))!.step, "profile", "eve sees her own, empty draft");
  assert.deepEqual(await wizard.values(ctx("eve")), {});
  assert.equal(await wizard.view(ctx(null)), null, "no draft for visitors not signed in");
  assert.deepEqual(await wizard.save(ctx(null), "profile", {}), { ok: false, reason: "not-found" });

  tick(31 * 86_400_000);
  assert.equal((await wizard.view(ctx("ada")))!.step, "profile", "expired after 30 days");
  assert.equal(await wizard.sweep(), 1);

  const anon = setup(new MemoryDraftStore(), { anonymous: true }).wizard;
  await anon.save(ctx(null, "s-a"), "profile", { name: "A", email: "a@example.com" });
  assert.equal((await anon.view(ctx(null, "s-a")))!.step, "team");
  assert.equal((await anon.view(ctx(null, "s-b")))!.step, "profile", "another session, another draft");
  await anon.discard(ctx(null, "s-a"));
  assert.equal((await anon.view(ctx(null, "s-a")))!.step, "profile");
});

test("finish rechecks every step and gives the draft back when complete throws", async () => {
  const store = new SqlDraftStore(openSqlite(":memory:"));
  const { wizard, completed, failOnce } = setup(store);
  const ada = ctx("ada");
  await wizard.save(ada, "profile", { name: "Ada", email: "ada@example.com" });
  await wizard.save(ada, "team", { size: "1" });
  await wizard.save(ada, "terms", { agree: true });
  failOnce();
  await assert.rejects(wizard.finish(ada), /write failed/);
  assert.equal(completed.length, 0);
  const r = await wizard.finish(ada);
  assert.equal(r.ok, true, "the draft survived the failed completion");
  assert.deepEqual(completed[0], { name: "Ada", email: "ada@example.com", size: "1", agree: true });

  await wizard.save(ada, "profile", { name: "Ada", email: "ada@example.com" });
  await wizard.save(ada, "team", { size: "1" });
  await wizard.save(ada, "terms", { agree: true });
  const d = (await store.get("onboarding", "user:ada"))!;
  store.put("onboarding", "user:ada", { ...d, values: { ...d.values, email: "not an email" } });
  assert.deepEqual(await wizard.finish(ada), { ok: false, reason: "invalid", step: "profile", errors: { email: "Enter an email address." } });
  assert.equal(store.sweep(Number.MAX_SAFE_INTEGER), 1);
  assert.equal(store.get("onboarding", "user:ada"), null);
});

test("definitions are checked", () => {
  const base = { name: "w", store: new MemoryDraftStore(), complete: () => 0 };
  assert.throws(() => defineWizard({ ...base, name: "bad name", steps: [{ id: "a", fields: {} }] }), /name/);
  assert.throws(() => defineWizard({ ...base, steps: [] }), /at least one/);
  assert.throws(() => defineWizard({ ...base, steps: [{ id: "a", fields: {} }, { id: "a", fields: {} }] }), /twice/);
  assert.throws(() => defineWizard({ ...base, steps: [{ id: "a", fields: { x: { type: "text" } } }, { id: "b", fields: { x: { type: "text" } } }] }), /steps a and b/);
  assert.throws(() => defineWizard({ ...base, steps: [{ id: "a", fields: { x: { type: "choice", options: [] } } }] }), /options/);
  assert.throws(() => defineWizard({ ...base, steps: [{ id: "a", fields: { x: { type: "text", pattern: /x/g } } }] }), /pattern/);
  assert.throws(() => defineWizard({ ...base, steps: [{ id: "a", fields: { x: { type: "date", min: "2026-13-01" } } }] }), /date/);
  assert.throws(() => defineWizard({ ...base, steps: [{ id: "a", fields: { "bad name": { type: "text" } } }] }), /field name/);
});
