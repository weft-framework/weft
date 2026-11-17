import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft-framework/runtime";
import { defineModel, isReadOnlyActor } from "@weft-framework/data";
import { createApp, type App } from "../src/app.ts";
import { defineAction } from "../src/action.ts";
import { allowWhileViewing, login, switchTenant, viewAs } from "../src/auth.ts";
import { defineSupport } from "../src/support.ts";

const ORIGIN = "http://app.test";
const MIN = 60_000;

interface Note {
  id: string;
  owner: string;
  text: string;
}

const PEOPLE: Record<string, { name: string; orgs: string[] }> = {
  ada: { name: "Ada Lovelace", orgs: ["acme", "globex"] },
  bob: { name: "Bob", orgs: [] },
  ops: { name: "Olga Ops", orgs: [] },
};

const str = (name: string, optional = false) => ({ name, type: "string" as const, optional });

function setup(o: { consent?: boolean } = {}) {
  let t = Date.parse("2026-11-14T10:00:00Z");
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  const operators = new Set(["ops"]);
  const Note = defineModel<Note>(`Note${Math.random().toString(36).slice(2)}`, {
    fields: { id: "string", owner: "string", text: "string" },
    read: (a: { id: string }, r) => r.owner === a.id,
    write: (a: { id: string }, r) => r.owner === a.id,
  });
  Note.as({ id: "ada" }).create({ id: "n1", owner: "ada", text: "ada's note" });
  Note.as({ id: "ops" }).create({ id: "n2", owner: "ops", text: "ops note" });
  const support = defineSupport<{ name: string }>({
    allow: (id) => operators.has(id),
    lookup: (q) =>
      Object.entries(PEOPLE)
        .filter(([, p]) => p.name.toLowerCase().includes(q.toLowerCase()))
        .map(([id, p]) => ({ id, label: p.name })),
    describe: (id) => (PEOPLE[id] ? { name: PEOPLE[id]!.name, tenants: PEOPLE[id]!.orgs } : null),
    now: clock.now,
    ...(o.consent === false ? { consent: false } : {}),
  });
  const Home = defineComponent<{ who: string; notes: string[]; ro: boolean }>("Home", (p) => ({
    render: () => `<p id="who">${escapeHtml(p.who)}</p><p id="ro">${p.ro}</p><ul>${p.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`,
  }));
  const actions = {
    signIn: defineAction("signIn", [str("id")], async (ctx, id: string) => void (await login(ctx, id))),
    addNote: defineAction("addNote", [str("text")], async (ctx, text: string) => {
      const u = ctx.user as { id: string };
      return Note.as(u).create({ id: crypto.randomUUID(), owner: u.id, text }) !== undefined;
    }),
    find: defineAction("find", [str("q")], (ctx, q: string) => support.search(ctx, q)),
    open: defineAction("open", [str("id")], (ctx, id: string) => support.customer(ctx, id)),
    mine: allowWhileViewing(defineAction("mine", [], (ctx) => support.myAccess(ctx))),
    sneak: defineAction("sneak", [str("user")], (ctx, user: string) => viewAs(ctx, user, { until: t + MIN })),
    toOrg: defineAction("toOrg", [str("org")], (ctx, org: string) => switchTenant(ctx, org)),
    ...support.actions,
  };
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    now: clock.now,
    routes: {
      "/": {
        component: Home as never,
        load: (ctx) => {
          const u = ctx.user as { id: string; tenant?: string } | null;
          return { who: u ? `${u.id}${u.tenant ? `@${u.tenant}` : ""}` : "nobody", notes: u ? Note.as(u).all().map((n) => n.text) : [], ro: isReadOnlyActor(u) };
        },
      },
    },
    actions: actions as never,
    api: { "/api/ping": { POST: () => new Response("pong"), GET: () => new Response("get") } } as never,
    auth: {
      user: (id, tenant) => {
        if (!PEOPLE[id]) return null;
        if (tenant !== undefined && !PEOPLE[id]!.orgs.includes(tenant)) return null;
        return tenant !== undefined ? { id, tenant } : { id };
      },
      viewAs: support.viewAs,
    },
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
  return { app, support, clock, operators, Note };
}

function client(app: App) {
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrfOf = async (cookie: string) => {
    const html = await (await app.fetch(new Request(`${ORIGIN}/`, { headers: { cookie } })))!.text();
    return /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";
  };
  const call = async (cookie: string, name: string, body: object = {}) => {
    const res = (await app.fetch(
      new Request(`${ORIGIN}/?/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": await csrfOf(cookie) },
        body: JSON.stringify(body),
      }),
    ))!;
    const json = (await res.json()) as { ok: boolean; error?: string; value?: any };
    return { status: res.status, error: json.error, value: json.value, cookie: cookieOf(res) };
  };
  return {
    call,
    async as(id: string | null) {
      const anon = cookieOf((await app.fetch(new Request(`${ORIGIN}/`)))!);
      if (id === null) return anon;
      return (await call(anon, "signIn", { id })).cookie || anon;
    },
    async who(cookie: string) {
      const html = await (await app.fetch(new Request(`${ORIGIN}/`, { headers: { cookie } })))!.text();
      return { who: /<p id="who">([^<]*)<\/p>/.exec(html)?.[1], ro: /<p id="ro">([^<]*)<\/p>/.exec(html)?.[1] === "true", html };
    },
    async api(cookie: string, method: string) {
      const res = (await app.fetch(new Request(`${ORIGIN}/api/ping`, { method, headers: { origin: ORIGIN, cookie, "x-weft-csrf": await csrfOf(cookie) } })))!;
      return { status: res.status, text: await res.text() };
    },
  };
}

test("only operators search and open customers; both are logged", async () => {
  const { app, support } = setup();
  const c = client(app);
  for (const who of [await c.as(null), await c.as("bob")]) {
    assert.equal((await c.call(who, "find", { q: "ada" })).value, null);
    assert.equal((await c.call(who, "open", { id: "ada" })).value, null);
    assert.equal((await c.call(who, "supportStartView", { user: "ada", minutes: "5", reason: "x" })).value, null);
  }
  assert.deepEqual(support.log(), [], "nothing logged for refused requests");
  const ops = await c.as("ops");
  const s = (await c.call(ops, "find", { q: " o " })).value;
  assert.deepEqual(s, { query: "o", results: [{ id: "ada", label: "Ada Lovelace" }, { id: "bob", label: "Bob" }, { id: "ops", label: "Olga Ops" }], more: false });
  assert.deepEqual((await c.call(ops, "find", { q: "  " })).value, { query: "", results: [], more: false });
  assert.equal((await c.call(ops, "open", { id: "nobody" })).value, null);
  const u = (await c.call(ops, "open", { id: "ada" })).value;
  assert.deepEqual(u.customer, { name: "Ada Lovelace", tenants: ["acme", "globex"] });
  assert.equal(u.consent, null);
  assert.equal(u.viewable, false);
  assert.deepEqual(support.log().map((e) => [e.event, e.user, e.operator, e.detail]), [
    ["open", "ada", "ops", null],
    ["lookup", null, "ops", "o"],
  ]);
  assert.equal(support.log({ operator: "ops" }).length, 2);
});

test("with consent, an operator sees the app as the customer, read-only, and stops", async () => {
  const { app, support, Note } = setup();
  const c = client(app);
  const ada = await c.as("ada");
  const ops = await c.as("ops");
  const view = (body: object) => c.call(ops, "supportStartView", body).then((r) => r.value);
  assert.deepEqual(await view({ user: "ada", minutes: "10", reason: "ticket 42" }), { ok: false, reason: "no consent" });

  assert.equal((await c.call(ada, "supportGrant", { minutes: "60" })).value, Date.parse("2026-11-14T11:00:00Z"));
  assert.equal((await c.call(ada, "supportGrant", { minutes: String(7 * 1440 + 1) })).value, null);
  assert.equal(support.consentUntil("ada"), Date.parse("2026-11-14T11:00:00Z"));

  assert.deepEqual(await view({ user: "ada", minutes: "10", reason: "   " }), { ok: false, reason: "bad reason" });
  assert.deepEqual(await view({ user: "ada", minutes: "10", reason: "x".repeat(501) }), { ok: false, reason: "bad reason" });
  assert.deepEqual(await view({ user: "ada", minutes: "31", reason: "x" }), { ok: false, reason: "bad minutes" });
  assert.deepEqual(await view({ user: "ada", minutes: "1.5", reason: "x" }), { ok: false, reason: "bad minutes" });
  assert.deepEqual(await view({ user: "ada", minutes: "5", reason: "x", tenant: "initech" }), { ok: false, reason: "bad tenant" });
  assert.deepEqual(await view({ user: "bob", minutes: "5", reason: "x", tenant: "acme" }), { ok: false, reason: "bad tenant" });
  assert.deepEqual(await view({ user: "nobody", minutes: "5", reason: "x" }), { ok: false, reason: "not found" });

  assert.deepEqual(await view({ user: "ada", minutes: "10", reason: "ticket 42", tenant: "globex" }), { ok: true, until: Date.parse("2026-11-14T10:10:00Z") });
  let w = await c.who(ops);
  assert.equal(w.who, "ada@globex");
  assert.equal(w.ro, true);
  assert.match(w.html, /ada&#39;s note|ada's note/);
  assert.ok(!w.html.includes("ops note"));
  assert.equal((await c.who(ada)).ro, false, "the customer's own session is untouched");
  assert.deepEqual((await c.call(ops, "mine")).value.user, "ada", "myAccess shows the viewed customer's");

  let r = await c.call(ops, "addNote", { text: "planted" });
  assert.equal(r.status, 403);
  assert.equal(r.error, "Read-only while viewing as another user");
  assert.equal(Note.as({ id: "ada" }).all().length, 1);
  assert.equal((await c.call(ops, "supportGrant", { minutes: "1440" })).status, 403, "cannot extend the customer's consent");
  assert.equal((await c.call(ops, "toOrg", { org: "acme" })).status, 403);
  assert.equal((await c.api(ops, "POST")).status, 403);
  assert.equal((await c.api(ops, "GET")).text, "get");

  r = await c.call(ops, "supportStopView");
  assert.equal(r.value, true);
  w = await c.who(ops);
  assert.equal(w.who, "ops");
  assert.equal(w.ro, false);
  assert.equal((await c.call(ops, "supportStopView")).value, false, "not viewing");
  assert.equal((await c.call(ops, "find", { q: "a" })).value.query, "a", "an operator again");

  assert.deepEqual(support.log({ user: "ada" }).map((e) => [e.event, e.operator, e.detail]), [
    ["view-stop", "ops", null],
    ["view-start", "ops", "ticket 42"],
    ["consent-grant", null, "60"],
  ]);
  const mine = (await c.call(ada, "mine")).value;
  assert.equal(mine.consent, Date.parse("2026-11-14T11:00:00Z"));
  assert.equal(mine.maxMinutes, 7 * 1440);
  assert.deepEqual(mine.log.map((e: { event: string }) => e.event), ["view-stop", "view-start", "consent-grant"]);
});

test("a view ends: consent withdrawn, time up, consent ended, operator removed", async () => {
  const { app, support, clock, operators } = setup();
  const c = client(app);
  const ada = await c.as("ada");
  const ops = await c.as("ops");
  const start = async (minutes = "10") => {
    const r = await c.call(ops, "supportStartView", { user: "ada", minutes, reason: "r" });
    assert.equal(r.value?.ok, true, JSON.stringify(r));
    assert.equal((await c.who(ops)).who, "ada@acme", "the first organisation by default");
    return r.value.until as number;
  };
  await c.call(ada, "supportGrant", { minutes: "60" });

  await start();
  assert.equal((await c.call(ada, "supportRevoke")).value, true);
  assert.equal((await c.call(ada, "supportRevoke")).value, false);
  assert.equal(support.consentUntil("ada"), null);
  assert.equal((await c.who(ops)).who, "ops", "withdrawn consent ends it at the next request");
  assert.deepEqual(support.log({ user: "ada", limit: 2 }).map((e) => [e.event, e.operator]), [["consent-revoke", null], ["view-start", "ops"]]);

  await c.call(ada, "supportGrant", { minutes: "60" });
  await start("5");
  clock.advance(4 * MIN);
  assert.equal((await c.who(ops)).who, "ada@acme");
  clock.advance(MIN);
  assert.equal((await c.who(ops)).who, "ops", "the view ends at its time");

  clock.advance(45 * MIN);
  assert.equal(await start("30"), Date.parse("2026-11-14T11:00:00Z"), "cut to the end of the consent");
  clock.advance(10 * MIN);
  assert.equal((await c.who(ops)).who, "ops");
  assert.equal(support.consentUntil("ada"), null, "the consent has ended");
  assert.equal((await c.call(ops, "open", { id: "ada" })).value.viewable, false);

  await c.call(ada, "supportGrant", { minutes: "60" });
  await start();
  operators.delete("ops");
  assert.equal((await c.who(ops)).who, "ops", "no longer an operator");
  operators.add("ops");

  await start();
  assert.equal((await c.call(ops, "signIn", { id: "ops" })).status, 403, "signing in again is an action, refused while viewing");
});

test("viewAs needs auth.viewAs to say yes; never as oneself or an unknown user", async () => {
  const { app } = setup();
  const c = client(app);
  const ops = await c.as("ops");
  const bob = await c.as("bob");
  const ada = await c.as("ada");
  assert.equal((await c.call(ops, "sneak", { user: "ada" })).value, false, "no consent");
  await c.call(ada, "supportGrant", { minutes: "60" });
  assert.equal((await c.call(bob, "sneak", { user: "ada" })).value, false, "not an operator");
  await c.call(ops, "supportGrant", { minutes: "60" });
  assert.equal((await c.call(ops, "sneak", { user: "ops" })).value, false);
  assert.equal((await c.call(ops, "sneak", { user: "ada" })).value, true);
  assert.equal((await c.who(ops)).ro, true);
});

test("consent: false lets operators view without it, still logged", async () => {
  const { app, support } = setup({ consent: false });
  const c = client(app);
  const ops = await c.as("ops");
  assert.equal((await c.call(ops, "open", { id: "bob" })).value.viewable, true);
  assert.equal((await c.call(ops, "supportStartView", { user: "bob", minutes: "5", reason: "audit" })).value.ok, true);
  assert.equal((await c.who(ops)).who, "bob");
  assert.equal(support.log({ user: "bob" })[0]!.event, "view-start");
});

test("the app's own checks, with an auth.viewAs that always agrees", async () => {
  const Home = defineComponent<{ who: string }>("Home3", (p) => ({ render: () => `<p id="who">${escapeHtml(p.who)}</p>` }));
  const support = defineSupport({ allow: () => true, lookup: () => [], describe: (id) => ({ id }) });
  const actions = {
    signIn: defineAction("signIn", [str("id")], async (ctx, id: string) => void (await login(ctx, id))),
    look: allowWhileViewing(
      defineAction("look", [str("user"), str("tenant", true)], (ctx, user: string, tenant?: string) =>
        viewAs(ctx, user, { until: Date.now() + MIN, ...(tenant ? { tenant } : {}) }),
      ),
    ),
    org: allowWhileViewing(defineAction("org", [str("id")], (ctx, id: string) => switchTenant(ctx, id))),
    find: allowWhileViewing(defineAction("find", [], (ctx) => support.search(ctx, "x"))),
  };
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: {
      "/": {
        component: Home as never,
        load: (ctx) => {
          const u = ctx.user as { id: string; tenant?: string } | null;
          return { who: u ? `${u.id}${u.tenant ? `@${u.tenant}` : ""}` : "nobody" };
        },
      },
    },
    actions: actions as never,
    auth: { user: (id) => ({ id, tenant: "home" }), viewAs: () => true },
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
  const c = client(app);
  const ops = await c.as("ops");
  assert.equal((await c.call(ops, "look", { user: "ops" })).value, false, "never as oneself");
  assert.equal((await c.call(ops, "look", { user: "ada", tenant: "acme" })).value, false, "not acting in that tenant");
  assert.equal((await c.call(ops, "look", { user: "ada" })).value, true);
  assert.equal((await c.who(ops)).who, "ada@home");
  assert.equal((await c.call(ops, "look", { user: "bob" })).value, false, "not while already viewing");
  assert.equal((await c.call(ops, "org", { id: "home" })).value, false, "no tenant switch while viewing");
  assert.equal((await c.call(ops, "find")).value, null, "a viewing session is no operator, even viewing one");
});

test("an app without auth.viewAs never views as anyone", async () => {
  const Home = defineComponent<{ who: string }>("Home2", (p) => ({ render: () => `<p id="who">${escapeHtml(p.who)}</p>` }));
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: { "/": { component: Home as never, load: (ctx) => ({ who: (ctx.user as { id: string } | null)?.id ?? "nobody" }) } },
    actions: {
      signIn: defineAction("signIn", [str("id")], async (ctx, id: string) => void (await login(ctx, id))) as never,
      sneak: defineAction("sneak", [], (ctx) => viewAs(ctx, "ada", { until: Date.now() + MIN })) as never,
    },
    auth: { user: (id) => ({ id }) },
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
  const c = client(app);
  const ops = await c.as("ops");
  assert.equal((await c.call(ops, "sneak")).value, false);
  assert.equal((await c.who(ops)).who, "ops");
});

test("arguments and declarations", () => {
  const { support } = setup();
  assert.throws(() => support.log({ limit: 0 }), /limit/);
  assert.equal(support.models.length, 2);
  const ok = { allow: () => true, lookup: () => [], describe: () => null };
  assert.throws(() => defineSupport({} as never), /allow/);
  assert.throws(() => defineSupport({ allow: () => true } as never), /lookup/);
  assert.throws(() => defineSupport({ ...ok, name: "bad name" }), /name/);
  assert.throws(() => defineSupport({ ...ok, maxViewMinutes: 0 }), /maxViewMinutes/);
  assert.throws(() => defineSupport({ ...ok, maxConsentMinutes: 1.5 }), /maxConsentMinutes/);
  assert.throws(() => defineSupport({ ...ok, userId: 1 as never }), /userId/);
  const s = defineSupport({ ...ok, name: "help" });
  assert.deepEqual(Object.keys(s.actions), ["helpStartView", "helpStopView", "helpGrant", "helpRevoke"]);
  assert.equal(s.models[0]!.name, "HelpConsent");
});

test("the SQL session store keeps a view and adds its column to an older table", async () => {
  const { openSqlite } = await import("@weft-framework/data/sqlite");
  const { SqlSessionStore } = await import("../src/auth.ts");
  const db = openSqlite(":memory:");
  db.exec(`CREATE TABLE weft_sessions (sid TEXT PRIMARY KEY NOT NULL, user TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL)`);
  const store = new SqlSessionStore(db);
  store.set("s", { user: "ops", created: 1, seen: 2, viewAs: { user: "ada", tenant: "acme", until: 99 } });
  assert.deepEqual(store.get("s"), { user: "ops", created: 1, seen: 2, viewAs: { user: "ada", tenant: "acme", until: 99 } });
  store.set("s", { user: "ops", created: 1, seen: 3 });
  assert.deepEqual(store.get("s"), { user: "ops", created: 1, seen: 3 }, "cleared");
  db.exec(`UPDATE weft_sessions SET view_as = 'not json' WHERE sid = 's'`);
  assert.deepEqual(new SqlSessionStore(db).get("s"), { user: "ops", created: 1, seen: 3 }, "not one we wrote: no view");
  db.exec(`UPDATE weft_sessions SET view_as = '{"user":"ada"}' WHERE sid = 's'`);
  assert.deepEqual(store.get("s"), { user: "ops", created: 1, seen: 3 }, "no time limit: no view");
  db.close();
});
