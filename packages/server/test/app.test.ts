import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml, signal } from "@weft/runtime";
import { createApp, type AppOptions, type LiveSocket, type SocketData } from "../src/app.ts";

const Counter = defineComponent("Counter", (props: { start: number }) => {
  const count = signal(props.start);
  function inc() {
    count.value = count.value + 1;
  }
  return {
    handlers: { inc },
    render: () => `<button data-weft-on-click="inc">${escapeHtml(count.value)}</button>`,
  };
});

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

type App = ReturnType<typeof createApp>;

function makeApp(extra: Partial<AppOptions> = {}): App {
  return createApp({
    secret: SECRET,
    routes: { "/": { component: Counter, load: () => ({ start: 5 }), title: "Count <me>" } },
    clientScript: "export {}",
    onError: () => {},
    ...extra,
  });
}

async function get(app: App, path: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await app.fetch(new Request(ORIGIN + path, { headers }));
  assert.ok(res, "a response");
  return res;
}

async function openPage(app: App) {
  const res = await get(app, "/");
  const html = await res.text();
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "";
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";
  return { res, html, cookie, lid, csrf };
}

async function openSse(app: App, cookie: string, lid: string) {
  const res = await get(app, `/_weft/live/sse?lid=${lid}`, { cookie });
  assert.equal(res.status, 200);
  const body = res.body;
  assert.ok(body);
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return {
    async next(): Promise<Record<string, unknown>> {
      for (;;) {
        const m = /data: (.*)\n\n/.exec(buf);
        if (m) {
          buf = buf.slice(m.index + m[0].length);
          return JSON.parse(m[1]);
        }
        const { value } = await reader.read();
        buf += dec.decode(value);
      }
    },
    close: () => reader.cancel(),
  };
}

async function post(app: App, headers: Record<string, string>, body: string): Promise<number> {
  const res = await app.fetch(
    new Request(`${ORIGIN}/_weft/live/event`, { method: "POST", headers, body }),
  );
  assert.ok(res);
  return res.status;
}

const eventBody = (seq = 1) =>
  JSON.stringify({ t: "event", id: "r", handler: "inc", event: { type: "click" }, seq });

test("secrets must be long enough", () => {
  assert.throws(() => createApp({ secret: "short", routes: {} }), /at least 32/);
});

test("a page renders as a hardened live document", async () => {
  const app = makeApp();
  const { res, html, cookie } = await openPage(app);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("set-cookie") ?? "", /^weft_sid=[^;]+; Path=\/; HttpOnly; SameSite=Lax$/);
  const csp = res.headers.get("content-security-policy") ?? "";
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce);
  assert.ok(html.includes(`<script type="module" nonce="${nonce}" src="/_weft/client.js"></script>`));
  assert.ok(html.includes(`<style nonce="${nonce}">`));
  assert.ok(html.includes("<title>Count &lt;me&gt;</title>"));
  assert.match(html, /<body>\s*<weft-c data-weft-c="r"><button data-weft-on-click="inc">5<\/button><\/weft-c>\s*<\/body>/);
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.ok(cookie.startsWith("weft_sid="));

  const again = await get(app, "/", { cookie });
  assert.equal(again.headers.get("set-cookie"), null);
});

test("SSE + POST: an event round-trips to a patch", async () => {
  const app = makeApp();
  const { cookie, lid, csrf } = await openPage(app);
  const sse = await openSse(app, cookie, lid);
  const hello = await sse.next();
  assert.equal(hello.t, "hello");

  const code = await post(
    app,
    { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": String(hello.session) },
    eventBody(1),
  );
  assert.equal(code, 204);
  assert.deepEqual(await sse.next(), {
    t: "patch",
    id: "r",
    html: '<button data-weft-on-click="inc">6</button>',
    ack: 1,
  });
  await sse.close();
});

test("event POSTs are refused without origin, CSRF, session or a valid body", async () => {
  const app = makeApp();
  const { cookie, lid, csrf } = await openPage(app);
  const sse = await openSse(app, cookie, lid);
  const session = String((await sse.next()).session);
  const good = { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": session };

  const badName = '{"t":"event","id":"r","handler":"in c","event":{"type":"click"},"seq":1}';
  const cases: [string, Record<string, string>, string, number][] = [
    ["cross-origin", { ...good, origin: "http://evil.test" }, eventBody(), 403],
    ["forged csrf", { ...good, "x-weft-csrf": "forged" }, eventBody(), 403],
    ["forged cookie", { ...good, cookie: "weft_sid=forged.mac" }, eventBody(), 403],
    ["unknown stream", { ...good, "x-weft-session": "unknown" }, eventBody(), 404],
    ["malformed", good, badName, 400],
    ["oversized", good, "x".repeat(70 * 1024), 413],
  ];
  for (const [name, headers, body, code] of cases) {
    assert.equal(await post(app, headers, body), code, name);
  }
  await sse.close();
});

test("another session cannot attach to or drive a page", async () => {
  const app = makeApp();
  const a = await openPage(app);
  const b = await openPage(app);
  assert.equal((await get(app, `/_weft/live/sse?lid=${a.lid}`, { cookie: b.cookie })).status, 404);

  const sse = await openSse(app, a.cookie, a.lid);
  const session = String((await sse.next()).session);
  const code = await post(
    app,
    { cookie: b.cookie, origin: ORIGIN, "x-weft-csrf": b.csrf, "x-weft-session": session },
    eventBody(),
  );
  assert.equal(code, 404);
  await sse.close();
});

test("events are rate limited per session", async () => {
  const app = makeApp({ rateLimit: { capacity: 2, refillPerSecond: 0 } });
  const { cookie, lid, csrf } = await openPage(app);
  const sse = await openSse(app, cookie, lid);
  const session = String((await sse.next()).session);
  const h = { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": session };
  assert.equal(await post(app, h, eventBody(1)), 204);
  assert.equal(await post(app, h, eventBody(2)), 204);
  assert.equal(await post(app, h, eventBody(3)), 429);
  await sse.close();
});

test("idle pages expire and per-session pages are bounded", async () => {
  let t = 0;
  const app = makeApp({ now: () => t, pageTtlMs: 1000, maxPagesPerSession: 2 });
  const first = await openPage(app);
  t = 2000;
  assert.equal((await get(app, `/_weft/live/sse?lid=${first.lid}`, { cookie: first.cookie })).status, 404);

  const lids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const html = await (await get(app, "/", { cookie: first.cookie })).text();
    lids.push(/name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "");
  }
  const sse = (lid: string) => get(app, `/_weft/live/sse?lid=${lid}`, { cookie: first.cookie });
  assert.equal((await sse(lids[0])).status, 404, "oldest evicted");
  const live = await sse(lids[2]);
  assert.equal(live.status, 200);
  await live.body?.cancel();
});

test("WebSocket: same-origin upgrade, hello, events, bad messages close", async () => {
  const app = makeApp();
  const { cookie, lid } = await openPage(app);
  let data: SocketData | null = null;
  const server = {
    upgrade(_req: Request, o: { data: SocketData }) {
      data = o.data;
      return true;
    },
  };
  const wsReq = (origin: string) =>
    new Request(`${ORIGIN}/_weft/live?lid=${lid}`, {
      headers: { cookie, origin, upgrade: "websocket" },
    });

  assert.equal((await app.fetch(wsReq("http://evil.test"), server))?.status, 403);
  assert.equal(await app.fetch(wsReq(ORIGIN), server), undefined);
  assert.ok(data);

  const sent: Record<string, unknown>[] = [];
  let closed: number | null = null;
  const ws: LiveSocket = {
    data,
    send: (s) => sent.push(JSON.parse(s)),
    close: (c) => {
      closed = c ?? 0;
    },
  };
  app.websocket.open(ws);
  assert.equal(sent[0].t, "hello");
  await app.websocket.message(ws, eventBody(1));
  assert.deepEqual(sent[1], {
    t: "patch",
    id: "r",
    html: '<button data-weft-on-click="inc">6</button>',
    ack: 1,
  });
  await app.websocket.message(ws, "{not json");
  assert.equal(closed, 1008);
});

test("unknown paths 404, wrong methods 405, client bundle is served", async () => {
  const app = makeApp();
  assert.equal((await get(app, "/nope")).status, 404);
  assert.equal((await get(app, "/__proto__")).status, 404);
  const postPage = await app.fetch(new Request(`${ORIGIN}/`, { method: "POST" }));
  assert.equal(postPage?.status, 405);
  assert.equal((await get(app, "/_weft/live/event")).status, 405);
  const js = await get(app, "/_weft/client.js");
  assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await js.text(), "export {}");
});

test("an unknown or evicted live page is told it expired", async () => {
  const app = makeApp({ maxPagesPerSession: 1 });
  const first = await openPage(app);
  let data: SocketData | null = null;
  const server = {
    upgrade(_req: Request, o: { data: SocketData }) {
      data = o.data;
      return true;
    },
  };
  const socket = (lid: string, cookie: string) => {
    data = null;
    const req = new Request(`${ORIGIN}/_weft/live?lid=${lid}`, {
      headers: { cookie, origin: ORIGIN, upgrade: "websocket" },
    });
    return app.fetch(req, server);
  };
  const fake = () => {
    const sent: Record<string, unknown>[] = [];
    const ws: LiveSocket & { code: number | null } = {
      data: data!,
      code: null,
      send: (s) => sent.push(JSON.parse(s)),
      close(c) {
        ws.code = c ?? 0;
      },
    };
    return { ws, sent };
  };

  assert.equal(await socket("nope", first.cookie), undefined);
  const stray = fake();
  app.websocket.open(stray.ws);
  assert.deepEqual(stray.sent, [{ t: "expired" }]);
  assert.equal(stray.ws.code, 1008);

  await socket(first.lid, first.cookie);
  const live = fake();
  app.websocket.open(live.ws);
  assert.equal(live.sent[0].t, "hello");
  await get(app, "/", { cookie: first.cookie });
  assert.deepEqual(live.sent.at(-1), { t: "expired" });
  await app.websocket.message(live.ws, '{"t":"event"}');
  assert.equal(live.ws.code, 1008);
});

test("a reconnecting stream first gets the whole page", async () => {
  const app = makeApp();
  const { cookie, lid, csrf } = await openPage(app);
  const first = await openSse(app, cookie, lid);
  const hello = await first.next();
  await first.close();
  const code = await post(
    app,
    { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": String(hello.session) },
    eventBody(1),
  );
  assert.equal(code, 404, "the stream is gone");

  const again = await openSse(app, cookie, lid);
  assert.equal((await again.next()).t, "hello");
  assert.deepEqual(await again.next(), {
    t: "patch",
    id: "r",
    html: '<button data-weft-on-click="inc">5</button>',
  });
  await again.close();
});
