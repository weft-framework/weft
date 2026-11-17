import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent } from "@weft-framework/runtime";
import { createApp, type ErrorReport } from "../src/app.ts";
import { defineAction } from "../src/action.ts";
import { login } from "../src/auth.ts";

const ORIGIN = "http://app.test";

function setup(reporter?: (err: unknown, r: ErrorReport) => void) {
  const reports: { err: unknown; r: ErrorReport }[] = [];
  const errors: unknown[] = [];
  const Broken = defineComponent("BrokenPage", () => ({ render: () => { throw new Error("render failed"); } }));
  const Clicky = defineComponent("Clicky", () => ({
    handlers: { boom() { throw new Error("handler failed"); } },
    render: () => `<button data-weft-on-click="boom">x</button>`,
  }));
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: { "/": { component: Clicky as never }, "/broken/[id]": { component: Broken as never } },
    api: { "/api/fail": { GET: () => { throw new Error("api failed"); } } },
    actions: {
      signIn: defineAction("signIn", [], async (ctx) => void (await login(ctx, "ada"))) as never,
      explode: defineAction("explode", [], () => { throw new Error("action failed"); }) as never,
    },
    auth: { user: (id) => ({ id, email: `${id}@example.com`, secretNotes: "private" }) },
    onError: (e) => errors.push(e),
    reportError: reporter ?? ((err, r) => void reports.push({ err, r })),
    instance: "node-a",
  });
  return { app, reports, errors };
}

const fetchApp = async (app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) => (await app.fetch(new Request(ORIGIN + path, init)))!;

test("page, API and action errors carry where they happened and the actor's id only", async () => {
  const { app, reports, errors } = setup();
  const page = await fetchApp(app, "/broken/42?token=abc");
  assert.equal(page.status, 500);
  assert.equal(reports.length, 1, "once, though the error passes two handlers");
  assert.equal(errors.length, 1);
  assert.match(String(reports[0]!.err), /render failed/);
  assert.deepEqual(reports[0]!.r, {
    kind: "page",
    route: "/broken/[id]",
    component: "BrokenPage",
    actor: null,
    requestId: null,
    method: "GET",
    path: "/broken/42",
    instance: "node-a",
  });

  const home = await fetchApp(app, "/");
  let cookie = (home.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrfOf = async () => /name="weft-csrf" content="([^"]+)"/.exec(await (await fetchApp(app, "/", { headers: { cookie } })).text())![1]!;
  const call = async (name: string) => {
    const res = await fetchApp(app, `/?/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": await csrfOf() },
      body: "{}",
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return res;
  };
  await call("signIn");
  assert.equal((await call("explode")).status, 500);
  const action = reports.at(-1)!.r;
  assert.deepEqual([action.kind, action.handler, action.actor, action.path], ["action", "explode", "ada", "/"]);
  assert.equal((await fetchApp(app, "/api/fail", { headers: { cookie } })).status, 500);
  const api = reports.at(-1)!.r;
  assert.deepEqual([api.kind, api.route, api.actor], ["api", "/api/fail", "ada"]);
  assert.doesNotMatch(JSON.stringify(reports.map((x) => x.r)), /example\.com|private/, "no actor data");
});

test("event handler errors name the handler", async () => {
  const { app, reports } = setup();
  const res = await fetchApp(app, "/");
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const html = await res.text();
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)![1];
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)![1]!;
  const sse = await fetchApp(app, `/_weft/live/sse?lid=${lid}`, { headers: { cookie } });
  const reader = sse.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const session = String((JSON.parse(/data: (.*)\n\n/.exec(first)![1]!) as { session: string }).session);
  await fetchApp(app, "/_weft/live/event", {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": session },
    body: JSON.stringify({ t: "event", id: "r", handler: "boom", event: { type: "click" }, seq: 1 }),
  });
  await reader.cancel();
  const r = reports.find((x) => x.r.kind === "event")!.r;
  assert.deepEqual([r.route, r.component, r.handler, r.actor], ["/", "Clicky", "boom", null]);
});

test("a reporter that throws is contained", async () => {
  const { app, errors } = setup(() => {
    throw new Error("tracker down");
  });
  assert.equal((await fetchApp(app, "/broken/1")).status, 500);
  assert.deepEqual(errors.map(String), ["Error: render failed", "Error: tracker down"]);
});
