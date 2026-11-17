import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent } from "@weft/runtime";
import { createApp, type AppOptions } from "../src/app.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";
const Home = defineComponent("Home", () => ({ render: () => `<p>home</p>` }));

function makeApp(extra: Partial<AppOptions> = {}) {
  const errors: unknown[] = [];
  const app = createApp({ secret: SECRET, routes: { "/": { component: Home as never } }, onError: (e) => errors.push(e), ...extra });
  const get = async (path: string, init: RequestInit = {}) => (await app.fetch(new Request(ORIGIN + path, init)))!;
  return { app, get, errors };
}

test("health answers while serving; ready runs the checks and names nothing", async () => {
  let db: unknown = true;
  let slow = false;
  const { app, get, errors } = makeApp({
    ready: {
      db: () => {
        if (db instanceof Error) throw db;
        return db;
      },
      queue: () => (slow ? new Promise(() => {}) : undefined),
    },
    readyTimeoutMs: 30,
  });
  for (const path of ["/_weft/health", "/_weft/ready"]) {
    const res = await get(path);
    assert.deepEqual([res.status, await res.text(), res.headers.get("cache-control")], [200, "ok\n", "no-store"], path);
    const head = await get(path, { method: "HEAD" });
    assert.deepEqual([head.status, await head.text()], [200, ""]);
    assert.equal((await get(path, { method: "POST" })).status, 405);
  }
  assert.equal(errors.length, 0);

  db = false;
  let res = await get("/_weft/ready");
  assert.deepEqual([res.status, await res.text()], [503, "unavailable\n"]);
  assert.match(String(errors.pop()), /ready check "db" failed: returned false/);
  db = new Error("connection refused to 10.0.0.5");
  res = await get("/_weft/ready");
  assert.equal(res.status, 503);
  assert.doesNotMatch(await res.text(), /10\.0\.0\.5|db/, "the reason stays in the log");
  assert.match(String(errors.pop()), /"db" failed: connection refused/);
  db = 0;
  slow = true;
  assert.equal((await get("/_weft/ready")).status, 503, "a check that hangs");
  assert.match(String(errors.pop()), /"queue" failed: timed out after 30 ms/);
  assert.equal(errors.length, 0, "0 is not false: only the slow check failed");
  assert.equal((await get("/_weft/health")).status, 200, "liveness does not run the checks");
  app.close();

  assert.throws(() => makeApp({ ready: { db: "yes" as never } }), /ready check "db"/);
  assert.throws(() => makeApp({ readyTimeoutMs: 0 }), /readyTimeoutMs/);
});

test("drain: not ready at once, waits for requests in flight, then sends live pages elsewhere", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { app, get } = makeApp({
    api: {
      "/api/slow": {
        GET: async () => {
          await gate;
          return new Response("done");
        },
      },
    },
  });
  const page = await get("/");
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const lid = /name="weft-live" content="([^"]+)"/.exec(await page.text())![1];
  const sse = await get(`/_weft/live/sse?lid=${lid}`, { headers: { cookie } });
  assert.equal(sse.status, 200);
  const reader = sse.body!.getReader();
  let buf = "";
  const until = async (t: string) => {
    for (;;) {
      for (const m of buf.matchAll(/data: (.*)\n\n/g)) {
        if ((JSON.parse(m[1]!) as { t: string }).t === t) return;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended without ${t}`);
      buf += new TextDecoder().decode(value);
    }
  };

  const slow = get("/api/slow");
  await new Promise((r) => setTimeout(r, 5));
  let drained = false;
  const draining = app.drain({ timeoutMs: 5000 }).then((v) => ((drained = true), v));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await get("/_weft/ready")).status, 503, "not ready at once");
  assert.equal((await get("/_weft/health")).status, 200, "still alive");
  assert.equal(drained, false, "waits for the request in flight");
  release();
  assert.equal(await (await slow).text(), "done");
  assert.equal(await draining, true);
  await until("expired");
  assert.equal((await get(`/_weft/live/sse?lid=${lid}`, { headers: { cookie } })).status, 404, "the page is gone");
  assert.equal((await get("/_weft/ready")).status, 503, "stays not ready");
  app.close();
});

test("drain gives up on requests that outlast its timeout", async () => {
  const { app, get } = makeApp({ api: { "/api/hang": { GET: () => new Promise<Response>(() => {}) } } });
  void get("/api/hang");
  await new Promise((r) => setTimeout(r, 5));
  const t = Date.now();
  assert.equal(await app.drain({ delayMs: 20, timeoutMs: 30 }), false);
  assert.ok(Date.now() - t >= 45, "delay, then the timeout");
  await assert.rejects(app.drain({ timeoutMs: -1 }), /timeoutMs/);
  await assert.rejects(app.drain({ delayMs: Number.NaN }), /delayMs/);
  app.close();
});
