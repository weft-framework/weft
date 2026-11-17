import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft/runtime";
import { defineAction } from "../src/action.ts";
import { edgeHandler } from "../src/edge.ts";

const SECRET = "edge-secret-edge-secret-edge-secret!!";
const ORIGIN = "https://edge.test";

let destroyed = 0;
const Hello = defineComponent("Hello", (_props: Record<string, never>) => ({
  handlers: {},
  render: () => `<p>Hello from the edge</p>`,
  destroy: [() => void (destroyed += 1)],
}));
const Clicky = defineComponent("Clicky", (_props: Record<string, never>) => ({
  handlers: { go() {} },
  render: () => `<button data-weft-on-click="go">go</button>`,
}));

let total = 0;
const add = defineAction("add", [{ name: "n", type: "number" }], (_ctx, n: number) => {
  total += n;
  return escapeHtml(total);
});

function handler(errors: unknown[] = []) {
  return edgeHandler({
    secret: SECRET,
    routes: { "/": { component: Hello }, "/clicky": { component: Clicky } },
    actions: { add },
    onError: (e) => errors.push(e),
  });
}

test("pages are rendered per request and nothing is kept", async () => {
  const fetch = handler();
  destroyed = 0;
  const res = await fetch(new Request(`${ORIGIN}/`));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Hello from the edge/);
  assert.match(html, /<meta name="weft-csrf" content="[^"]+">/);
  assert.ok(!html.includes('name="weft-live"'), "no live page id");
  assert.equal(destroyed, 1, "the instance is disposed with the request");

  const sse = await fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=anything`));
  assert.equal(sse.status, 404);
  const ws = await fetch(new Request(`${ORIGIN}/_weft/live?lid=x`, { headers: { upgrade: "websocket" } }));
  assert.equal(ws.status, 426);
});

test("actions run with the session and CSRF token of a stateless page", async () => {
  const fetch = handler();
  const page = await fetch(new Request(`${ORIGIN}/`));
  const html = await page.text();
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0];
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)![1];
  total = 0;
  const call = (headers: Record<string, string>) =>
    fetch(
      new Request(`${ORIGIN}/?/add`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie, ...headers },
        body: JSON.stringify({ n: 2 }),
      }),
    );
  const ok = await call({ "x-weft-csrf": csrf });
  assert.deepEqual(await ok.json(), { ok: true, value: "2" });
  assert.equal((await call({})).status, 403, "no token, no call");
});

test("server event handlers on a stateless host are reported once per route", async () => {
  const errors: unknown[] = [];
  const fetch = handler(errors);
  await (await fetch(new Request(`${ORIGIN}/clicky`))).text();
  await (await fetch(new Request(`${ORIGIN}/clicky`))).text();
  await (await fetch(new Request(`${ORIGIN}/`))).text();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /\/clicky binds server event handlers/);
});
