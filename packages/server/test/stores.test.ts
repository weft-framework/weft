import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, defineStore } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";
import { defineAction } from "../src/action.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

const hits = defineStore("hits", "app", () => 0);
const cart = defineStore<string[]>("cart", "session", () => []);
const motd = defineStore("motd", "app", () => "hello");

const Hits = defineComponent("Hits", () => ({
  handlers: {
    bump() {
      hits.value = hits.value + 1;
    },
  },
  render: () => `<b>${hits.value}</b><button data-weft-on-click="bump">+</button>`,
}));

const Cart = defineComponent("Cart", () => ({
  handlers: {
    add() {
      cart.value = [...cart.value, "apple"];
    },
  },
  render: () => `<i>${cart.value.length}</i><button data-weft-on-click="add">+</button>`,
}));

const Motd = defineComponent("Motd", (props: { text: string }) => ({
  handlers: {},
  render: () => `<p>${props.text}</p>`,
}));

const addToCart = defineAction("addToCart", [{ name: "item", type: "string" }], async (_ctx, item: string) => {
  cart.value = [...cart.value, item];
});

function setup() {
  return createApp({
    secret: SECRET,
    syncDelayMs: 0,
    onError: (e) => {
      throw e;
    },
    actions: { addToCart },
    routes: {
      "/hits": { component: Hits as never },
      "/cart": { component: Cart as never },
      "/motd": { component: Motd as never, load: () => ({ text: motd.value }) },
    },
  });
}

type App = ReturnType<typeof createApp>;

async function open(app: App, path: string, cookie = "") {
  const res = await app.fetch(new Request(ORIGIN + path, { headers: cookie ? { cookie } : {} }));
  assert.ok(res);
  const html = await res.text();
  const set = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "";
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";
  const id = /data-weft-c="([^"]+)"/.exec(html)?.[1] ?? "";
  return { html, cookie: set || cookie, lid, csrf, id };
}

async function stream(app: App, cookie: string, lid: string) {
  const res = await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } }));
  assert.equal(res?.status, 200);
  const reader = res!.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const s = {
    async next(ms = 500): Promise<Record<string, unknown> | null> {
      const deadline = Date.now() + ms;
      for (;;) {
        const m = /data: (.*)\n\n/.exec(buf);
        if (m) {
          buf = buf.slice(m.index + m[0].length);
          return JSON.parse(m[1]);
        }
        pending ??= reader.read();
        const left = deadline - Date.now();
        const got = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, left)))]);
        if (got === null) {
          return null;
        }
        pending = null;
        buf += dec.decode(got.value);
      }
    },
    close: () => reader.cancel(),
    session: "",
  };
  const hello = await s.next();
  s.session = String(hello?.session);
  return s;
}

async function click(app: App, p: Awaited<ReturnType<typeof open>>, session: string, handler: string) {
  const res = await app.fetch(
    new Request(`${ORIGIN}/_weft/live/event`, {
      method: "POST",
      headers: { cookie: p.cookie, origin: ORIGIN, "x-weft-csrf": p.csrf, "x-weft-session": session },
      body: JSON.stringify({ t: "event", id: p.id, handler, event: { type: "click" }, seq: 1 }),
    }),
  );
  assert.equal(res?.status, 204);
}

test("an app store write refreshes every page that rendered it", async () => {
  const app = setup();
  const a = await open(app, "/hits");
  const b = await open(app, "/hits");
  assert.match(b.html, /<b>0<\/b>/);
  const sa = await stream(app, a.cookie, a.lid);
  const sb = await stream(app, b.cookie, b.lid);
  await click(app, a, sa.session, "bump");
  assert.match(String((await sa.next())?.html), /<b>1<\/b>/, "the writer's reply");
  const msg = await sb.next();
  assert.equal(msg?.t, "patch");
  assert.equal("ack" in msg!, false);
  assert.match(String(msg?.html), /<b>1<\/b>/, "another visitor's page follows");
  await sa.close();
  await sb.close();
  app.close();
});

test("a session store is per visitor: only the writer's pages refresh", async () => {
  const app = setup();
  const a = await open(app, "/cart");
  const a2 = await open(app, "/cart", a.cookie);
  const b = await open(app, "/cart");
  const sa = await stream(app, a.cookie, a.lid);
  const sa2 = await stream(app, a2.cookie, a2.lid);
  const sb = await stream(app, b.cookie, b.lid);
  await click(app, a, sa.session, "add");
  assert.match(String((await sa.next())?.html), /<i>1<\/i>/);
  assert.match(String((await sa2.next())?.html), /<i>1<\/i>/, "same session, other tab");
  assert.equal(await sb.next(150), null, "another visitor is not even refreshed");
  const fresh = await open(app, "/cart", b.cookie);
  assert.match(fresh.html, /<i>0<\/i>/, "and never sees the other cart");
  for (const s of [sa, sa2, sb]) await s.close();
  app.close();
});

test("an action writing a session store refreshes that session's pages", async () => {
  const app = setup();
  const a = await open(app, "/cart");
  const sa = await stream(app, a.cookie, a.lid);
  const res = await app.fetch(
    new Request(`${ORIGIN}/cart?/addToCart`, {
      method: "POST",
      headers: { cookie: a.cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "item=pear",
    }),
  );
  assert.equal(res?.status, 303);
  assert.match(String((await sa.next())?.html), /<i>1<\/i>/);
  await sa.close();
  app.close();
});

test("a store read in load reloads the page when it changes", async () => {
  const app = setup();
  const p = await open(app, "/motd");
  assert.match(p.html, /<p>hello<\/p>/);
  const s = await stream(app, p.cookie, p.lid);
  motd.value = "maintenance at noon";
  assert.match(String((await s.next())?.html), /maintenance at noon/);
  await s.close();
  app.close();
});

test("a session store has no value outside a request", () => {
  assert.throws(() => cart.value, /outside a request/);
});
