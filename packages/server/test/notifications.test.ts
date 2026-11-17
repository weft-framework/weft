import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft-framework/runtime";
import { defineNotifications } from "@weft-framework/core";
import { createApp, type App } from "../src/app.ts";
import { defineAction } from "../src/action.ts";
import { login } from "../src/auth.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

function setup() {
  const notify = defineNotifications({ types: { comment: { label: "Comments", channels: { inApp: "instant" } } } });
  const Bell = defineComponent("Bell", (props: { unread: number; latest: string }) => ({
    handlers: { noop() {} },
    render: () =>
      `<p id="unread">${props.unread}</p><p id="latest">${escapeHtml(props.latest)}</p><button data-weft-on-click="noop">x</button>`,
  }));
  const signIn = defineAction("signIn", [{ name: "id", type: "string" }], async (ctx, id: string) => {
    await login(ctx, id);
  });
  const comment = defineAction("comment", [{ name: "to", type: "string" }, { name: "text", type: "string" }], async (ctx, to: string, text: string) => {
    const me = (ctx.user as { id: string } | null)?.id ?? "anon";
    await notify.send(to, "comment", { title: `${me}: ${text}` });
  });
  const readAll = defineAction("readAll", [], (ctx) => notify.markRead((ctx.user as { id: string }).id, "all"));
  const app = createApp({
    secret: SECRET,
    transports: ["sse"],
    routes: {
      "/": {
        component: Bell as never,
        load: (ctx) => {
          const id = (ctx.user as { id: string } | null)?.id;
          return id ? { unread: notify.unread(id), latest: notify.inbox(id, { limit: 1 })[0]?.title ?? "" } : { unread: 0, latest: "" };
        },
      },
    },
    actions: { signIn: signIn as never, comment: comment as never, readAll: readAll as never },
    auth: { user: (id) => ({ id }) },
  });
  return { app, notify };
}

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

async function page(app: App, cookie = "") {
  const res = (await app.fetch(new Request(`${ORIGIN}/`, { headers: cookie ? { cookie } : {} })))!;
  const html = await res.text();
  return {
    cookie: cookieOf(res) || cookie,
    unread: /<p id="unread">([^<]*)<\/p>/.exec(html)?.[1],
    csrf: /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "",
    lid: /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "",
  };
}

async function call(app: App, name: string, body: object, cookie: string, csrf: string) {
  const res = (await app.fetch(
    new Request(`${ORIGIN}/?/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": csrf },
      body: JSON.stringify(body),
    }),
  ))!;
  await res.text();
  return res;
}

async function signedIn(app: App, id: string) {
  const anon = await page(app);
  const res = await call(app, "signIn", { id }, anon.cookie, anon.csrf);
  return page(app, cookieOf(res));
}

async function stream(app: App, cookie: string, lid: string) {
  const res = (await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } })))!;
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const next = async (ms = 1000): Promise<Record<string, unknown> | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const m = /data: (.*)\n\n/.exec(buf);
      if (m) {
        buf = buf.slice(m.index + m[0].length);
        return JSON.parse(m[1]!) as Record<string, unknown>;
      }
      pending ??= reader.read();
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now())));
      const got = await Promise.race([pending, timeout]);
      if (got === null || got.done) return null;
      pending = null;
      buf += dec.decode(got.value);
    }
  };
  const patched = async (text: string, ms = 1000): Promise<boolean> => {
    for (;;) {
      const msg = await next(ms);
      if (msg === null) return false;
      if (msg.t === "patch" && String(msg.html).includes(text)) return true;
    }
  };
  assert.equal((await next())?.t, "hello");
  return { patched, next, close: () => reader.cancel() };
}

test("the unread count on an open page follows the user's notifications, and only theirs", async () => {
  const { app } = setup();
  const ada = await signedIn(app, "ada");
  const bob = await signedIn(app, "bob");
  assert.equal(ada.unread, "0");
  const live = await stream(app, ada.cookie, ada.lid);

  await call(app, "comment", { to: "ada", text: "hello <b>" }, bob.cookie, bob.csrf);
  assert.ok(await live.patched('<p id="unread">1</p>'), "a new notification re-rendered Ada's page");
  assert.equal((await page(app, ada.cookie)).unread, "1");

  await call(app, "comment", { to: "eve", text: "not for Ada" }, bob.cookie, bob.csrf);
  assert.equal(await live.next(300), null, "Eve's notification does not touch Ada's page");

  const ada2 = await page(app, ada.cookie);
  await call(app, "readAll", {}, ada2.cookie, ada2.csrf);
  assert.ok(await live.patched('<p id="unread">0</p>'), "marked read in another tab");
  await live.close();
  app.close();
});
