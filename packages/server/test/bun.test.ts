import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineComponent, escapeHtml, signal } from "@weft-framework/runtime";
import { createApp, type LiveSocket, type SocketData } from "../src/app.ts";
import { forwarded, serveBun, type BunServeApi } from "../src/bun.ts";

const Counter = defineComponent("Counter", (_props: Record<string, never>) => {
  const count = signal(0);
  return {
    handlers: {
      inc() {
        count.value = count.value + 1;
      },
    },
    render: () => `<button data-weft-on-click="inc">${escapeHtml(count.value)}</button>`,
  };
});

const SECRET = "bun-secret-bun-secret-bun-secret-bun!";

type ServeOpts = Parameters<BunServeApi["serve"]>[0];

function fakeBun() {
  let opts: ServeOpts | null = null;
  let stopped: boolean | undefined;
  const api: BunServeApi = {
    serve(o) {
      opts = o;
      return {
        url: new URL(`http://${o.hostname}:${o.port}/`),
        stop(closeActive) {
          stopped = closeActive;
        },
      };
    },
  };
  return { api, opts: () => opts!, stopped: () => stopped };
}

const app = () =>
  createApp({ secret: SECRET, routes: { "/": { component: Counter } }, transports: ["ws", "sse"], onError: () => {} });

test("serveBun configures Bun.serve: idle timeout above the SSE heartbeat, pings, errors", async () => {
  const bun = fakeBun();
  const errors: unknown[] = [];
  const server = serveBun(app(), { port: 4123, onError: (e) => errors.push(e) }, bun.api);
  const o = bun.opts();
  assert.equal(o.hostname, "127.0.0.1");
  assert.equal(o.idleTimeout, 60);
  assert.equal(o.websocket.sendPings, true);
  assert.equal(server.url, "http://127.0.0.1:4123/");
  const res = o.error(new Error("boom"));
  assert.equal(res.status, 500);
  assert.equal(await res.text(), "Internal Server Error");
  assert.equal(errors.length, 1);
  await server.close();
  assert.equal(bun.stopped(), true);
  assert.equal(serveBun(app(), { idleTimeout: 9999 }, fakeBun().api) !== null, true);
});

test("a live page upgrades and answers events over the adapter's WebSocket", async () => {
  const bun = fakeBun();
  serveBun(app(), {}, bun.api);
  const o = bun.opts();
  const page = await o.fetch(new Request("http://127.0.0.1:3000/"), null);
  assert.ok(page);
  const html = await page.text();
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0];
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)![1];

  let data: SocketData | null = null;
  const upgrader = {
    upgrade(_req: Request, u: { data: SocketData }) {
      data = u.data;
      return true;
    },
  };
  const upgrade = new Request(`http://127.0.0.1:3000/_weft/live?lid=${lid}`, {
    headers: { cookie, origin: "http://127.0.0.1:3000", upgrade: "websocket" },
  });
  assert.equal(await o.fetch(upgrade, upgrader), undefined, "handled by the upgrade");
  const sent: Record<string, unknown>[] = [];
  const ws: LiveSocket = { data: data!, send: (s) => sent.push(JSON.parse(s)), close: () => {} };
  o.websocket.open(ws);
  await o.websocket.message(ws, JSON.stringify({ t: "event", id: "r", handler: "inc", event: { type: "click" }, seq: 1 }));
  assert.equal(sent[0].t, "hello");
  assert.deepEqual(sent[1], { t: "patch", id: "r", html: '<button data-weft-on-click="inc">1</button>', ack: 1 });
  o.websocket.close(ws);
});

test("behind a trusted proxy the forwarded origin passes the same-origin check", async () => {
  const req = new Request("http://10.0.0.5:3000/_weft/live?lid=x", {
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "app.example, inner", origin: "https://app.example", upgrade: "websocket" },
  });
  assert.equal(forwarded(req).url, "https://app.example/_weft/live?lid=x");
  const odd = new Request("http://10.0.0.5:3000/", { headers: { "x-forwarded-host": "evil.example/path" } });
  assert.equal(forwarded(odd).url, "http://10.0.0.5:3000/");

  for (const trustProxy of [false, true]) {
    const bun = fakeBun();
    serveBun(app(), { trustProxy }, bun.api);
    const res = await bun.opts().fetch(req.clone(), { upgrade: () => true });
    assert.equal(res?.status, trustProxy ? undefined : 403, `trustProxy=${trustProxy}`);
  }
});

const hasBun = spawnSync("bun", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;

test("on real Bun: page, WebSocket hello and an event round-trip", { skip: !hasBun && "bun is not installed" }, async () => {
  const fixture = fileURLToPath(new URL("./bun-serve.fixture.ts", import.meta.url));
  const proc = spawn("bun", [fixture], { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  const code = await new Promise<number | null>((r) => proc.once("exit", r));
  assert.equal(code, 0, out);
  assert.match(out, /ok hello patch:1/);
});
