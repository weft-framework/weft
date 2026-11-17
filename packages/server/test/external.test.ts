import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { external, isExternal, type ApiHandler } from "../src/api.ts";
import { defineAction } from "../src/action.ts";
import { login } from "../src/auth.ts";

const ORIGIN = "http://app.test";

test("external handlers skip the browser checks and never see the browser's session", async () => {
  const seen: unknown[] = [];
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: {},
    api: {
      "/api/hook": {
        POST: external(async (ctx) => {
          seen.push({ user: ctx.user, body: await ctx.request.text() });
          return new Response("taken", { headers: { "set-cookie": "x=1" } });
        }),
      },
      "/api/browser": { POST: () => new Response("browser") },
    },
    actions: { signIn: defineAction("signIn", [], async (ctx) => void (await login(ctx, "ada"))) as never },
    auth: { user: (id) => ({ id }) },
    maxApiBytes: 64,
    onError: () => undefined,
  });

  const session = (await app.fetch(new Request(`${ORIGIN}/_weft/session`, { headers: { origin: ORIGIN } })))!;
  let cookie = (session.headers.get("set-cookie") ?? "").split(";")[0]!;
  const { csrf } = (await session.json()) as { csrf: string };

  const cross = { origin: "https://evil.example", "content-type": "application/json" };
  const browser = (await app.fetch(new Request(`${ORIGIN}/api/browser`, { method: "POST", headers: cross, body: "{}" })))!;
  assert.equal(browser.status, 403);

  const res = (await app.fetch(new Request(`${ORIGIN}/api/hook`, { method: "POST", headers: { ...cross, cookie }, body: '{"a":1}' })))!;
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "taken");
  assert.equal(res.headers.get("set-cookie"), null, "no cookie, not even the handler's");
  assert.equal(res.headers.get("x-weft-csrf"), null);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(seen.at(-1), { user: null, body: '{"a":1}' });

  const signIn = (await app.fetch(
    new Request(`${ORIGIN}/_weft/action/signIn`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie, "content-type": "application/json", "x-weft-csrf": csrf },
      body: "{}",
    }),
  ))!;
  assert.ok(signIn.status < 400, `signed in (${signIn.status})`);
  const rotated = signIn.headers.get("set-cookie");
  assert.ok(rotated, "login rotates the session");
  cookie = rotated.split(";")[0]!;
  await app.fetch(new Request(`${ORIGIN}/api/hook`, { method: "POST", headers: { origin: ORIGIN, cookie }, body: "x" }));
  assert.deepEqual(seen.at(-1), { user: null, body: "x" }, "a signed-in visitor's cookie is ignored");

  const big = (await app.fetch(new Request(`${ORIGIN}/api/hook`, { method: "POST", headers: cross, body: "x".repeat(65) })))!;
  assert.equal(big.status, 413);

  const plain: ApiHandler = () => new Response("x");
  assert.equal(isExternal(plain), false);
  const lookalike = Object.assign(() => new Response("x"), { [Symbol.for("weft.api.external")]: false });
  assert.equal(isExternal(lookalike), false);
  assert.equal(isExternal(external(plain)), true);
  assert.throws(() => external(null as never), /handler/);
});
