import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml, signal } from "@weft/runtime";
import { createApp, type App } from "../src/app.ts";
import { defineAction } from "../src/action.ts";
import { login } from "../src/auth.ts";
import { defineInspector } from "../src/inspector.ts";

const ORIGIN = "http://app.test";
const str = (name: string) => ({ name, type: "string" as const, optional: false });

function setup() {
  let t = Date.parse("2026-11-14T10:00:00Z");
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  const inspector = defineInspector({ allow: (id) => id === "ops", now: clock.now, name: `insp${Math.random().toString(36).slice(2, 8)}` });
  const Home = defineComponent("Home", (p: { who: string }) => {
    const n = signal(0);
    return {
      handlers: { inc: () => void (n.value += 1) },
      render: () => `<p id="who">${escapeHtml(p.who)}</p><button data-weft-on-click="inc">${n.value}</button>`,
    };
  });
  const actions = {
    signIn: defineAction("signIn", [str("id")], async (ctx, id: string) => void (await login(ctx, id))),
    list: defineAction("list", [], (ctx) => inspector.sessions(ctx)),
    look: defineAction("look", [str("id"), str("page")], (ctx, id: string, page: string) => inspector.look(ctx, id, page)),
    state: defineAction("state", [str("id"), str("page"), str("n")], (ctx, id: string, page: string, n: string) => inspector.frame(ctx, id, page, Number(n))),
    mine: defineAction("mine", [], (ctx) => inspector.mine(ctx)),
    ...inspector.actions,
  };
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    now: clock.now,
    routes: { "/": { component: Home as never, load: (ctx) => ({ who: (ctx.user as { id?: string } | null)?.id ?? "nobody" }) } },
    actions: actions as never,
    auth: { user: (id) => (["ada", "bob", "ops"].includes(id) ? { id } : null) },
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
  return { app, inspector, clock, prefix: Object.keys(inspector.actions)[0]!.replace(/Consent$/, "") };
}

function client(app: App) {
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const open = async (cookie: string) => {
    const html = await (await app.fetch(new Request(`${ORIGIN}/`, { headers: { cookie } })))!.text();
    return { lid: /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "", csrf: /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "" };
  };
  const call = async (cookie: string, name: string, body: object = {}) => {
    const res = (await app.fetch(
      new Request(`${ORIGIN}/?/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": (await open(cookie)).csrf },
        body: JSON.stringify(body),
      }),
    ))!;
    const json = (await res.json()) as { value?: any };
    return { value: json.value, cookie: cookieOf(res) };
  };
  return {
    call,
    open,
    async as(id: string) {
      const anon = cookieOf((await app.fetch(new Request(`${ORIGIN}/`)))!);
      return (await call(anon, "signIn", { id })).cookie || anon;
    },
  };
}

test("only a consenting session is inspected, by operators only, read-only and logged", async () => {
  const { app, clock, prefix } = setup();
  const c = client(app);
  const ada = await c.as("ada");
  const bob = await c.as("bob");
  const ops = await c.as("ops");
  const before = await c.open(ada);

  assert.deepEqual((await c.call(ops, "list")).value, [], "nobody agreed yet");
  const granted = (await c.call(ada, `${prefix}Consent`, { minutes: "10" })).value;
  assert.equal(granted.until, clock.now() + 10 * 60_000);
  assert.equal((await c.call(ada, `${prefix}Consent`, { minutes: "999" })).value, null, "longer than allowed");
  const after = await c.open(ada);

  for (const who of [bob, ada]) {
    assert.equal((await c.call(who, "list")).value, null, "not an operator");
    assert.equal((await c.call(who, "look", { id: granted.id, page: after.lid })).value, null);
  }
  const list = (await c.call(ops, "list")).value;
  assert.equal(list.length, 1);
  assert.equal(list[0].user, "ada");
  const pages = list[0].pages.map((p: { page: string }) => p.page);
  assert.ok(pages.includes(before.lid) && pages.includes(after.lid), "every open page of that session");
  assert.equal(JSON.stringify(list).includes(ada.split("=")[1]!), false, "the session id is never handed out");

  const view = (await c.call(ops, "look", { id: granted.id, page: after.lid })).value;
  assert.equal(view.path, "/");
  assert.equal(view.tree.name, "Home");
  assert.deepEqual(view.frames.map((f: { what: string }) => f.what), ["the page opened"]);
  const older = (await c.call(ops, "look", { id: granted.id, page: before.lid })).value;
  assert.deepEqual(older.frames.map((f: { what: string }) => f.what), ["inspection started"]);
  const state = (await c.call(ops, "state", { id: granted.id, page: after.lid, n: "0" })).value;
  assert.match(state.html, /<p id="who">ada<\/p>/);
  const bobPage = await c.open(bob);
  assert.equal((await c.call(ops, "look", { id: granted.id, page: bobPage.lid })).value, null);

  const mine = (await c.call(ada, "mine")).value;
  assert.equal(mine.until, granted.until);
  assert.deepEqual(mine.log.map((e: { event: string; operator: string | null }) => [e.event, e.operator]).slice(0, 3), [
    ["frame", "ops"],
    ["look", "ops"],
    ["look", "ops"],
  ]);
  assert.ok(mine.log.some((e: { event: string }) => e.event === "consent-grant"));
  assert.equal((await c.call(bob, "mine")).value.until, null, "bob's session agreed to nothing");

  assert.equal((await c.call(ada, `${prefix}Withdraw`)).value, true);
  assert.equal((await c.call(ops, "look", { id: granted.id, page: after.lid })).value, null, "withdrawn at once");
  assert.deepEqual((await c.call(ops, "list")).value, []);
  app.close();
});

test("a consent ends with its time, and covers only the session that gave it", async () => {
  const { app, clock, prefix } = setup();
  const c = client(app);
  const ada = await c.as("ada");
  const adaElsewhere = await c.as("ada");
  const ops = await c.as("ops");
  const granted = (await c.call(ada, `${prefix}Consent`, { minutes: "1" })).value;
  const page = await c.open(ada);
  const other = await c.open(adaElsewhere);
  const list = (await c.call(ops, "list")).value;
  assert.deepEqual(list[0].pages.map((p: { page: string }) => p.page).includes(other.lid), false, "her other session is not covered");
  assert.ok((await c.call(ops, "look", { id: granted.id, page: page.lid })).value);
  clock.advance(2 * 60_000);
  assert.equal((await c.call(ops, "look", { id: granted.id, page: page.lid })).value, null);
  assert.deepEqual((await c.call(ops, "list")).value, []);
  app.close();
});

test("declaration checks", () => {
  assert.throws(() => defineInspector({} as never), /allow/);
  assert.throws(() => defineInspector({ allow: () => true, maxMinutes: 0 }), /maxMinutes/);
  assert.throws(() => defineInspector({ allow: () => true, maxMinutes: 2000 }), /maxMinutes/);
  assert.throws(() => defineInspector({ allow: () => true, name: "Bad name" }), /name/);
});
