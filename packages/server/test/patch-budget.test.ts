import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, signal } from "@weft/runtime";
import { defineModel } from "@weft/data";
import { createApp, type PatchOver } from "../src/app.ts";

const ORIGIN = "http://app.test";
const SECRET = "test-secret-test-secret-test-secret!";

const Big = defineComponent("Big", () => {
  const n = signal(0);
  return {
    handlers: {
      grow() {
        n.value = n.value === 4000 ? 4001 : 4000;
      },
      nudge() {
        n.value += 1;
      },
    },
    render: () => `<p data-weft-on-click="grow">${"secret-ish ".repeat(Math.ceil(n.value / 11))}${n.value}</p>`,
  };
});

async function open(app: ReturnType<typeof createApp>) {
  const res = (await app.fetch(new Request(`${ORIGIN}/items/7`)))!;
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const html = await res.text();
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)![1];
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)![1]!;
  const sse = (await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } })))!;
  const reader = sse.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const session = String((JSON.parse(/data: (.*)\n\n/.exec(first)![1]!) as { session: string }).session);
  let seq = 0;
  const send = async (handler: string) => {
    const r = (await app.fetch(
      new Request(`${ORIGIN}/_weft/live/event`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": session },
        body: JSON.stringify({ t: "event", id: "r", handler, event: { type: "click" }, seq: ++seq }),
      }),
    ))!;
    assert.equal(r.status < 400, true, `event ${handler}: ${r.status}`);
    await r.arrayBuffer();
  };
  return { send, lid, cookie, close: () => reader.cancel() };
}

test("an event over the budget is reported by route, cause and component", async () => {
  const over: PatchOver[] = [];
  const app = createApp({
    secret: SECRET,
    routes: { "/items/[id]": { component: Big as never } },
    patchBudget: 2048,
    onPatchBudget: (o) => void over.push(o),
  });
  const page = await open(app);
  await page.send("nudge");
  assert.equal(over.length, 0, "a small patch is within budget");
  await page.send("grow");
  assert.equal(over.length, 1);
  const o = over[0]!;
  assert.equal(o.route, "/items/[id]", "the pattern, never the path with its id");
  assert.equal(o.cause, "Big.grow");
  assert.equal(o.budget, 2048);
  assert.ok(o.bytes > 2048);
  assert.deepEqual(o.components.map((c) => c.name), ["Big"]);
  assert.equal(o.components[0]!.bytes, o.bytes);
  assert.doesNotMatch(JSON.stringify(over), /secret-ish/, "no HTML in the report");
  await page.send("grow");
  await page.send("grow");
  assert.equal(over.length, 1);
  await page.send("nudge");
  assert.deepEqual(over.map((x) => x.cause), ["Big.grow", "Big.nudge"]);
  await page.close();
});

test("a re-render from a write is checked too, as a data change", async () => {
  const Notes = defineModel<{ id: string; text: string }>("BudgetNote", {
    fields: { id: "string", text: "string" },
    read: () => true,
    write: () => true,
  });
  const List = defineComponent("List", (props: { notes: { text: string }[] }) => ({
    handlers: {},
    render: () => `<ul>${props.notes.map((n) => `<li>${n.text}</li>`).join("")}</ul>`,
  }));
  const over: PatchOver[] = [];
  const app = createApp({
    secret: SECRET,
    syncDelayMs: 0,
    routes: { "/items/[id]": { component: List as never, load: () => ({ notes: Notes.as({ id: "a" }).where(() => true) }) } },
    patchBudget: 2048,
    onPatchBudget: (o) => void over.push(o),
  });
  const page = await open(app);
  Notes.as({ id: "a" }).create({ id: "1", text: "y".repeat(3000) });
  for (let i = 0; i < 50 && over.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  await page.close();
  app.close();
  assert.deepEqual(over.map((o) => [o.cause, o.components[0]!.name]), [["data change", "List"]]);
});

test("off by default without devtools, and with false; a thrower is contained; bad budgets refused", async () => {
  const warned: unknown[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a);
  try {
    for (const patchBudget of [undefined, false] as const) {
      const app = createApp({ secret: SECRET, routes: { "/items/[id]": { component: Big as never } }, patchBudget });
      const page = await open(app);
      await page.send("grow");
      await page.close();
    }
  } finally {
    console.warn = orig;
  }
  assert.deepEqual(warned, []);

  const errors: unknown[] = [];
  const app = createApp({
    secret: SECRET,
    routes: { "/items/[id]": { component: Big as never } },
    patchBudget: 1024,
    onPatchBudget: () => {
      throw new Error("hook broke");
    },
    onError: (e) => void errors.push(e),
  });
  const page = await open(app);
  await page.send("grow");
  await page.close();
  assert.deepEqual(errors.map(String), ["Error: hook broke"]);

  for (const patchBudget of [0, 100, 2.5, -1, Number.NaN]) {
    assert.throws(() => createApp({ secret: SECRET, routes: {}, patchBudget }), /patchBudget/);
  }
});

test("with devtools: on by default, logged to the console and the overlay", async () => {
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.map(String).join(" "));
  const Huge = defineComponent("Huge", () => {
    const on = signal(false);
    return {
      handlers: { grow() { on.value = true; } },
      render: () => `<p>${on.value ? "x".repeat(70_000) : "small"}</p>`,
    };
  });
  try {
    const app = createApp({ secret: SECRET, routes: { "/items/[id]": { component: Huge as never } }, devtools: true });
    const page = await open(app);
    await page.send("grow");
    const snap = (await app.fetch(new Request(`${ORIGIN}/_weft/dev/inspect?lid=${page.lid}`, { headers: { cookie: page.cookie } })))!;
    const body = await snap.text();
    await page.close();
    assert.equal(warned.length, 1);
    assert.match(warned[0]!, /patch budget: Huge\.grow on \/items\/\[id\] sent \d+ bytes \(budget 65536\): Huge \d+/);
    assert.match(body, /"dir":"warn"/);
    assert.match(body, /patch budget: Huge\.grow sent/);
  } finally {
    console.warn = orig;
  }
});
