import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeChanges, ChangeFeed, defineModel, LocalBroadcast, useDatabase } from "@weft/data";
import { openSqlite } from "@weft/data/sqlite";
import { defineComponent, escapeHtml } from "@weft/runtime";
import { createApp, type App } from "../src/app.ts";
import { defineAction } from "../src/action.ts";
import { login, SqlSessionStore } from "../src/auth.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

function cluster() {
  const db = openSqlite(":memory:");
  const store = new SqlSessionStore(db);
  const hub = new LocalBroadcast();
  const make = (name: string) => {
    const feed = new ChangeFeed();
    bridgeChanges(feed, hub.channel());
    const Notes = defineModel<{ id: string; text: string }>("Note", {
      fields: { id: "string", text: "string" },
      read: () => true,
      write: () => true,
    }).publishTo(feed);
    useDatabase(db, [Notes as never]);
    const List = defineComponent("List", () => ({
      handlers: { noop() {} },
      render: () =>
        `<ul>${Notes.as({ id: "x" })
          .all()
          .map((n) => `<li>${escapeHtml(n.text)}</li>`)
          .join("")}</ul><i data-weft-on-click="noop"></i>`,
    }));
    const Me = defineComponent("Me", (p: { who: string }) => ({ handlers: {}, render: () => `<p>${escapeHtml(p.who)}</p>` }));
    const signIn = defineAction("signIn", [], async (ctx) => {
      await login(ctx, "u1");
    });
    const app = createApp({
      secret: SECRET,
      instance: name,
      stickyCookie: "weft_node",
      transports: ["sse"],
      sync: feed,
      syncDelayMs: 0,
      auth: { store },
      routes: {
        "/": { component: List },
        "/me": {
          component: Me as never,
          load: (ctx) => ({ who: (ctx.user as { id: string } | null)?.id ?? "anon" }),
        },
      },
      actions: { signIn: signIn as never },
    });
    return { app, Notes };
  };
  return { a: make("node-a"), b: make("node-b"), db };
}

async function open(app: App, path: string, cookie = "") {
  const res = (await app.fetch(new Request(ORIGIN + path, { headers: cookie ? { cookie } : {} })))!;
  const html = await res.text();
  const cookies = res.headers.getSetCookie();
  return {
    res,
    html,
    cookies,
    sid: cookies.find((c) => c.startsWith("weft_sid="))?.split(";")[0] ?? cookie,
    lid: /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "",
    csrf: /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "",
  };
}

test("pages name their instance and set the sticky cookie once", async () => {
  const { a, b, db } = cluster();
  const first = await open(a.app, "/");
  assert.equal(first.res.headers.get("x-weft-instance"), "node-a");
  assert.ok(first.cookies.some((c) => /^weft_node=node-a; Path=\/; HttpOnly; SameSite=Lax$/.test(c)));
  const again = await open(a.app, "/", `${first.sid}; weft_node=node-a`);
  assert.ok(!again.cookies.some((c) => c.startsWith("weft_node=")));
  assert.throws(() => createApp({ secret: SECRET, routes: {}, instance: "no spaces" }), /instance names/);
  assert.throws(() => createApp({ secret: SECRET, routes: {}, stickyCookie: "weft_sid" }), /stickyCookie/);
  a.app.close();
  b.app.close();
  db.close();
});

test("a login on one instance is seen by the others (shared store)", async () => {
  const { a, b, db } = cluster();
  const p = await open(a.app, "/me");
  const res = (await a.app.fetch(
    new Request(`${ORIGIN}/me?/signIn`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: p.sid, "x-weft-csrf": p.csrf },
      body: "{}",
    }),
  ))!;
  assert.equal(res.status, 200);
  const sid = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("weft_sid="))!
    .split(";")[0];
  assert.match((await open(b.app, "/me", sid)).html, /<p>u1<\/p>/);
  assert.match((await open(a.app, "/me", sid)).html, /<p>u1<\/p>/);
  a.app.close();
  b.app.close();
  db.close();
});

test("a write on one instance refreshes pages held by another", async () => {
  const { a, b, db } = cluster();
  const page = await open(b.app, "/");
  const sse = (await b.app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${page.lid}`, { headers: { cookie: page.sid } })))!;
  assert.equal(sse.headers.get("x-weft-instance"), "node-b");
  const reader = sse.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const until = async (re: RegExp) => {
    const end = Date.now() + 2000;
    while (!re.test(buf)) {
      assert.ok(Date.now() < end, `timed out waiting for ${re}: ${buf}`);
      const { value } = await reader.read();
      buf += dec.decode(value);
    }
  };
  await until(/"t":"hello"/);
  a.Notes.as({ id: "x" }).create({ id: "n1", text: "from a" });
  await until(/from a/);
  await reader.cancel();

  const elsewhere = await a.app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${page.lid}`, { headers: { cookie: page.sid } }));
  assert.equal(elsewhere?.status, 404);
  a.app.close();
  b.app.close();
  db.close();
});
