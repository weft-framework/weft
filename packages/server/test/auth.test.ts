import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft/runtime";
import { createApp, type AppOptions } from "../src/app.ts";
import { defineAction, fail } from "../src/action.ts";
import { login, logout, MemorySessionStore } from "../src/auth.ts";
import { hashPassword, needsRehash, verifyPassword } from "../src/password.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";
const FAST = { ln: 10 };

test("passwords hash with scrypt and verify", async () => {
  const h = await hashPassword("correct horse", FAST);
  assert.match(h, /^\$scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
  assert.notEqual(await hashPassword("correct horse", FAST), h, "salted");
  assert.ok(await verifyPassword("correct horse", h));
  assert.ok(!(await verifyPassword("correct horsE", h)));
  assert.ok(!(await verifyPassword("", h)));
  assert.ok(!(await verifyPassword("x".repeat(2000), h)), "oversized input is refused, not hashed");
  assert.ok(!(await verifyPassword("correct horse", null)), "no user: false, after the same work");
  assert.ok(!(await verifyPassword("correct horse", "$scrypt$ln=99,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(43))));
  assert.ok(!(await verifyPassword("correct horse", "plaintext")));
  const nfc = await hashPassword("café", FAST);
  assert.ok(await verifyPassword("café", nfc));
  assert.ok(needsRehash(h), "below the default cost");
  assert.ok(!needsRehash(h, FAST));
  assert.ok(needsRehash("$2b$10$bcrypt-hash"));
  assert.ok(!needsRehash(await hashPassword("pw")), "the default cost is current");
  await assert.rejects(hashPassword(""), TypeError);
  await assert.rejects(hashPassword("pw", { ln: 4 }), RangeError);
});

function setup(extra: Partial<AppOptions> = {}) {
  const users = new Map([["ada", { id: "u1", name: "Ada", hash: hashPassword("lovelace", FAST) }]]);
  const signIn = defineAction(
    "signIn",
    [
      { name: "name", type: "string" },
      { name: "password", type: "string" },
    ],
    async (ctx, name: string, password: string) => {
      const u = users.get(name);
      if (!(await verifyPassword(password, u ? await u.hash : null))) {
        fail("Wrong name or password");
      }
      await login(ctx, u!.id);
      return (ctx.user as { name: string }).name;
    },
  );
  const signOut = defineAction("signOut", [], async (ctx) => {
    await logout(ctx);
  });
  const Who = defineComponent("Who", (props: { who: string }) => ({
    handlers: { noop() {} },
    render: () => `<p id="who">${escapeHtml(props.who)}</p><button data-weft-on-click="noop">x</button>`,
  }));
  const errors: unknown[] = [];
  let seen: unknown = "unset";
  const app = createApp({
    secret: SECRET,
    sync: false,
    transports: ["sse"],
    routes: {
      "/": {
        component: Who as never,
        load: (ctx) => ({ who: (ctx.user as { name?: string } | null)?.name ?? "anon" }),
      },
      "/sneaky": {
        component: Who as never,
        load: async (ctx) => {
          await login(ctx, "u1");
          return { who: "never" };
        },
      },
    },
    api: {
      "/api/session": {
        POST: async (ctx) => {
          await login(ctx, "u1");
          return Response.json({ ok: true });
        },
        GET: async (ctx) => {
          await logout(ctx);
          return Response.json({ ok: true });
        },
      },
    },
    actions: { signIn: signIn as never, signOut: signOut as never },
    middleware: [
      ({ user }) => {
        seen = user;
      },
    ],
    onError: (e) => errors.push(e),
    ...extra,
    auth: { user: (id) => [...users.values()].find((u) => u.id === id) ?? null, ...extra.auth },
  });
  return { app, errors, seen: () => seen, users };
}

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

async function page(app: ReturnType<typeof createApp>, cookie = "") {
  const res = (await app.fetch(new Request(`${ORIGIN}/`, { headers: cookie ? { cookie } : {} })))!;
  const html = await res.text();
  return {
    res,
    cookie: cookieOf(res) || cookie,
    who: /<p id="who">([^<]*)<\/p>/.exec(html)?.[1],
    csrf: /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "",
    lid: /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "",
  };
}

function call(app: ReturnType<typeof createApp>, name: string, body: object, cookie: string, csrf: string) {
  return app.fetch(
    new Request(`${ORIGIN}/?/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": csrf },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;
}

test("login rotates the session and makes ctx.user the actor", async () => {
  const { app, seen } = setup();
  const anon = await page(app);
  assert.equal(anon.who, "anon");
  assert.equal(seen(), null);

  const bad = await call(app, "signIn", { name: "ada", password: "nope" }, anon.cookie, anon.csrf);
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("set-cookie"), null, "a failed login changes nothing");

  const ok = await call(app, "signIn", { name: "ada", password: "lovelace" }, anon.cookie, anon.csrf);
  assert.deepEqual(await ok.json(), { ok: true, value: "Ada", redirect: "/" });
  const setCookie = ok.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Max-Age=2592000/);
  const cookie = cookieOf(ok);
  assert.notEqual(cookie, anon.cookie, "a new session id (no fixation)");
  assert.ok(ok.headers.get("x-weft-csrf"));

  const sse = await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${anon.lid}`, { headers: { cookie: anon.cookie } }));
  assert.equal(sse?.status, 404);
  assert.equal((await call(app, "signOut", {}, cookie, anon.csrf)).status, 403);
  assert.equal((await page(app, anon.cookie)).who, "anon");

  const signedIn = await page(app, cookie);
  assert.equal(signedIn.who, "Ada");
  assert.deepEqual(seen(), { id: "u1", name: "Ada", hash: seen() && (seen() as { hash: unknown }).hash });

  const out = await call(app, "signOut", {}, cookie, signedIn.csrf);
  assert.deepEqual(await out.json(), { ok: true, redirect: "/" });
  const after = cookieOf(out);
  assert.notEqual(after, cookie);
  assert.doesNotMatch(out.headers.get("set-cookie") ?? "", /Max-Age/);
  assert.equal((await page(app, after)).who, "anon");
  assert.equal((await page(app, cookie)).who, "anon", "the signed-out id stays signed out");
  app.close();
});

test("login and logout are refused where a cross-site link could trigger them", async () => {
  const { app, errors } = setup();
  const res = (await app.fetch(new Request(`${ORIGIN}/sneaky`)))!;
  assert.equal(res.status, 500);
  assert.match(String(errors[0]), /only work in actions and in API handlers for POST/);
  const get = (await app.fetch(new Request(`${ORIGIN}/api/session`)))!;
  assert.equal(get.status, 500);
  assert.match(String(errors[1]), /only work in actions/);
  app.close();
});

test("an API POST can sign in; the new token comes back with the cookie", async () => {
  const { app } = setup();
  const anon = await page(app);
  const res = (await app.fetch(
    new Request(`${ORIGIN}/api/session`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: anon.cookie, "x-weft-csrf": anon.csrf },
    }),
  ))!;
  assert.equal(res.status, 200);
  const cookie = cookieOf(res);
  assert.notEqual(cookie, anon.cookie);
  const token = res.headers.get("x-weft-csrf")!;
  assert.equal((await page(app, cookie)).who, "Ada");
  const out = await call(app, "signOut", {}, cookie, token);
  assert.equal(out.status, 200);
  app.close();
});

test("logins expire when idle or too old, and with their user", async () => {
  let t = 1_000_000;
  const store = new MemorySessionStore();
  const { app, users } = setup({ now: () => t, auth: { store, idleMs: 1000, maxAgeMs: 5000 } });
  const sign = async () => {
    const anon = await page(app);
    const ok = await call(app, "signIn", { name: "ada", password: "lovelace" }, anon.cookie, anon.csrf);
    return cookieOf(ok);
  };
  let cookie = await sign();
  t += 900;
  assert.equal((await page(app, cookie)).who, "Ada");
  t += 1100;
  assert.equal((await page(app, cookie)).who, "anon", "idle too long");

  cookie = await sign();
  for (let i = 0; i < 6; i++) {
    t += 900;
    await page(app, cookie);
  }
  assert.equal((await page(app, cookie)).who, "anon", "past the absolute limit");

  cookie = await sign();
  users.clear();
  assert.equal((await page(app, cookie)).who, "anon", "a user the app no longer knows");
  assert.equal(store.size, 0);
  app.close();
});

test("a standalone action that signs in hands back the new token", async () => {
  const { app } = setup();
  const boot = (await app.fetch(new Request(`${ORIGIN}/_weft/session`, { headers: { origin: ORIGIN } })))!;
  const cookie = cookieOf(boot);
  const { csrf } = (await boot.json()) as { csrf: string };
  const res = (await app.fetch(
    new Request(`${ORIGIN}/_weft/action/signIn`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": csrf },
      body: JSON.stringify({ name: "ada", password: "lovelace" }),
    }),
  ))!;
  assert.deepEqual(await res.json(), { ok: true, value: "Ada" }, "no page to reload");
  assert.ok(res.headers.get("x-weft-csrf"));
  assert.notEqual(cookieOf(res), cookie);
  app.close();
});
