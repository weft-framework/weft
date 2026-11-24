import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft-framework/runtime";
import { openSqlite } from "@weft-framework/data/sqlite";
import { defineAction } from "../src/action.ts";
import { createApp, type App } from "../src/app.ts";
import { login, SqlSessionStore, switchTenant, type SessionStore } from "../src/auth.ts";
import { emailSignIn, type EmailSignInMessage } from "../src/email-signin.ts";
import {
  base32,
  defineTwoFactor,
  fromBase32,
  MemoryTwoFactorStore,
  SqlTwoFactorStore,
  totp,
  TwoFactorError,
  type TwoFactorOptions,
  type TwoFactorSetup,
  type TwoFactorStore,
} from "../src/two-factor.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const KEY = "two-factor-key-two-factor-key-two-factor-key";
const ORIGIN = "http://app.test";
const STEP = 30_000;

test("codes match RFC 6238 (SHA-1) and secrets round-trip through base32", async () => {
  const secret = new TextEncoder().encode("12345678901234567890");
  for (const [t, code] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ] as const) {
    assert.equal(await totp(secret, Math.floor(t / 30), 8), code, `T=${t}`);
  }
  assert.equal(await totp(secret, 1, 6), "287082");
  assert.equal(base32(secret), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  for (let n = 0; n < 24; n++) {
    const b = crypto.getRandomValues(new Uint8Array(n));
    assert.deepEqual(fromBase32(base32(b)), b);
  }
  assert.equal(fromBase32("not base32!"), null);
});

interface Setup {
  require?: TwoFactorOptions["require"];
  store?: TwoFactorStore;
  sessions?: SessionStore;
  extra?: Partial<TwoFactorOptions>;
}

function setup(o: Setup = {}) {
  let clock = 1_800_000_000_000;
  const sent: EmailSignInMessage[] = [];
  const twoFactor = defineTwoFactor({
    key: KEY,
    issuer: "Acme",
    page: "/two-factor",
    store: o.store ?? new MemoryTwoFactorStore(),
    now: () => clock,
    ...(o.require ? { require: o.require } : {}),
    ...o.extra,
  });
  const email = emailSignIn({ url: "https://app.example", page: "/confirm", send: (m) => void sent.push(m), now: () => clock });
  const Who = defineComponent("Who", (props: { who: string }) => ({ render: () => `<p id="who">${escapeHtml(props.who)}</p>` }));
  const str = (name: string) => ({ name, type: "string" }) as const;
  const wrap = async (f: () => Promise<unknown>) => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof TwoFactorError) return `error:${err.code}`;
      throw err;
    }
  };
  const actions = {
    as: defineAction("as", [str("id")], (ctx, id: string) => login(ctx, id)),
    asStrong: defineAction("asStrong", [str("id")], (ctx, id: string) => login(ctx, id, { multiFactor: true })),
    ask: defineAction("ask", [str("email")], async (ctx, address: string) => void (await email.request(ctx, address, { next: "/inbox" }))),
    org: defineAction("org", [str("id")], (ctx, id: string) => switchTenant(ctx, id)),
    status: defineAction("status", [], (ctx) => twoFactor.status(ctx)),
    setup: defineAction("setup", [], (ctx) => wrap(() => twoFactor.setup(ctx, { account: "ada@example.com" }))),
    enable: defineAction("enable", [str("state"), str("code")], (ctx, s: string, c: string) => wrap(() => twoFactor.enable(ctx, s, c))),
    verify: defineAction("verify", [str("code")], (ctx, c: string) => wrap(() => twoFactor.verify(ctx, c))),
    confirm: defineAction("confirm", [str("code")], (ctx, c: string) => wrap(() => twoFactor.confirm(ctx, c))),
    regen: defineAction("regen", [str("code")], (ctx, c: string) => wrap(() => twoFactor.regenerateRecoveryCodes(ctx, c))),
    disable: defineAction("disable", [str("code")], (ctx, c: string) => wrap(() => twoFactor.disable(ctx, c))),
  };
  const app = createApp({
    secret: SECRET,
    now: () => clock,
    routes: {
      "/": { component: Who as never, load: (ctx) => ({ who: (ctx.user as { id: string } | null)?.id ?? "nobody" }) },
    },
    actions: actions as never,
    auth: {
      ...(o.sessions ? { store: o.sessions } : {}),
      user: (id, tenant) => (tenant === undefined ? { id } : { id, tenant }),
      email,
      signIn: (i) => (i.email === "ada@example.com" ? "ada" : null),
      twoFactor,
    },
  });
  return { app, twoFactor, sent, tick: (ms: number) => (clock += ms), now: () => clock };
}

function visitor(app: App) {
  let cookie = "";
  let csrf = "";
  const keep = (res: Response) => {
    const set = res.headers.getSetCookie().find((x) => x.startsWith("weft_sid="));
    if (set) cookie = set.split(";")[0];
    csrf = res.headers.get("x-weft-csrf") ?? csrf;
  };
  const self = {
    async who() {
      const res = (await app.fetch(new Request(ORIGIN + "/", { headers: cookie ? { cookie } : {} })))!;
      keep(res);
      const html = await res.text();
      csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? csrf;
      return /<p id="who">([^<]*)<\/p>/.exec(html)?.[1];
    },
    async call(name: string, body: object = {}): Promise<any> {
      if (!csrf) await self.who();
      const res = (await app.fetch(
        new Request(`${ORIGIN}/?/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": csrf },
          body: JSON.stringify(body),
        }),
      ))!;
      keep(res);
      const out = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
      if (!out.ok) throw new Error(`${name}: ${out.error}`);
      await self.who();
      return out.value;
    },
    async confirmEmail(m: EmailSignInMessage) {
      const res = (await app.fetch(
        new Request(`${ORIGIN}/_weft/auth/email`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
          body: new URLSearchParams({ t: new URL(m.link).searchParams.get("t")! }).toString(),
        }),
      ))!;
      keep(res);
      return res;
    },
  };
  return self;
}

type Env = ReturnType<typeof setup>;
const codeAt = (env: Env, secret: string, drift = 0) =>
  totp(fromBase32(secret)!, Math.floor(env.now() / STEP) + drift);

async function enrol(env: Env, user = "ada") {
  const v = visitor(env.app);
  assert.equal(await v.call("as", { id: user }), "ok");
  const s = (await v.call("setup")) as TwoFactorSetup;
  const codes = (await v.call("enable", { state: s.state, code: await codeAt(env, s.secret) })) as string[];
  return { v, secret: s.secret, codes, setup: s };
}

test("setting it up: a secret for the app, confirmed by its first code, and recovery codes", async () => {
  const env = setup();
  const v = visitor(env.app);
  await v.call("as", { id: "ada" });
  assert.equal(await v.who(), "ada");
  const s = (await v.call("setup")) as TwoFactorSetup;
  assert.match(s.secret, /^[A-Z2-7]{32}$/);
  const uri = new URL(s.uri);
  assert.equal(uri.protocol, "otpauth:");
  assert.ok(s.uri.startsWith("otpauth://totp/Acme:ada%40example.com?"), s.uri);
  assert.deepEqual(Object.fromEntries(uri.searchParams), { secret: s.secret, issuer: "Acme", algorithm: "SHA1", digits: "6", period: "30" });
  assert.equal(await v.call("enable", { state: s.state, code: "000000" === (await codeAt(env, s.secret)) ? "111111" : "000000" }), null);
  assert.equal((await v.call("status")).enabled, false, "a wrong first code turns nothing on");

  const codes = (await v.call("enable", { state: s.state, code: await codeAt(env, s.secret) })) as string[];
  assert.equal(codes.length, 10);
  for (const c of codes) assert.match(c, /^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/);
  assert.equal(new Set(codes).size, 10);
  assert.equal(await v.who(), "ada");
  assert.deepEqual(await v.call("status"), { user: "ada", pending: false, enabled: true, required: true, mfa: true, recoveryLeft: 10 });
  assert.equal(await v.call("setup"), "error:conflict");

  const eve = visitor(env.app);
  assert.equal(await eve.call("setup"), "error:signed-out");
  await eve.call("as", { id: "eve" });
  assert.equal(await eve.call("enable", { state: s.state, code: await codeAt(env, s.secret) }), "error:expired");
});

test("a login waits for the code; each code is accepted once", async () => {
  const env = setup();
  const { secret } = await enrol(env);
  env.tick(STEP);

  const v = visitor(env.app);
  assert.equal(await v.call("as", { id: "ada" }), "two-factor");
  assert.equal(await v.who(), "nobody", "not signed in before the second factor");
  assert.equal((await v.call("status")).pending, true);
  assert.equal(await v.call("verify", { code: "12345" }), false, "malformed");
  for (const name of ["confirm", "regen", "disable"]) {
    assert.equal(await v.call(name, { code: await codeAt(env, secret) }), "error:signed-out", name);
  }
  const right = await codeAt(env, secret);
  assert.equal(await v.call("verify", { code: right === "123456" ? "654321" : "123456" }), false);
  assert.equal(await v.who(), "nobody");
  assert.equal(await v.call("verify", { code: ` ${right.slice(0, 3)} ${right.slice(3)} ` }), true, "spaces are ignored");
  assert.equal(await v.who(), "ada");
  assert.equal((await v.call("status")).mfa, true);
  assert.equal(await v.call("verify", { code: right }), "error:signed-out", "nothing waits any more");

  const w = visitor(env.app);
  await w.call("as", { id: "ada" });
  assert.equal(await w.call("verify", { code: right }), false, "replayed");
  assert.equal(await w.call("verify", { code: await codeAt(env, secret, -1) }), false, "an earlier step");
  assert.equal(await w.call("verify", { code: await codeAt(env, secret, 1) }), true);
  assert.equal(await w.who(), "ada");
});

test("a recovery code signs in once", async () => {
  const env = setup();
  const { codes } = await enrol(env);
  const v = visitor(env.app);
  await v.call("as", { id: "ada" });
  const loose = codes[0].replace("-", "").toUpperCase().replace(/0/g, "O").replace(/1/g, "L");
  assert.equal(await v.call("verify", { code: loose }), true);
  assert.equal(await v.who(), "ada");
  assert.equal((await v.call("status")).recoveryLeft, 9);
  const w = visitor(env.app);
  await w.call("as", { id: "ada" });
  assert.equal(await w.call("verify", { code: codes[0] }), false, "used");
  assert.equal(await w.call("verify", { code: "zzzzz-zzzzz" }), false);
  assert.equal(await w.call("verify", { code: codes[1] }), true);
});

test("wrong codes lock the user's second factor, in every session", async () => {
  const env = setup();
  const { secret } = await enrol(env);
  env.tick(STEP);
  const wrong = async () => ((await codeAt(env, secret)) === "000000" ? "111111" : "000000");
  const a = visitor(env.app);
  await a.call("as", { id: "ada" });
  for (let i = 0; i < 4; i++) assert.equal(await a.call("verify", { code: await wrong() }), false);
  const b = visitor(env.app);
  await b.call("as", { id: "ada" });
  assert.equal(await b.call("verify", { code: await wrong() }), "error:locked", "the fifth, from another session");
  assert.equal(await a.call("verify", { code: await codeAt(env, secret) }), "error:locked", "even the right code");
  assert.equal(await b.call("verify", { code: "aaaaa-aaaaa" }), "error:locked", "and recovery codes");

  env.tick(15 * 60_000 - STEP);
  assert.equal(await a.call("verify", { code: await codeAt(env, secret) }), "error:signed-out");
  const c = visitor(env.app);
  await c.call("as", { id: "ada" });
  assert.equal(await c.call("verify", { code: await codeAt(env, secret) }), "error:locked", "still locked");
  env.tick(STEP);
  assert.equal(await c.call("verify", { code: await codeAt(env, secret) }), true, "unlocked");
});

test("a pending login expires after ten minutes", async () => {
  const env = setup();
  const { secret } = await enrol(env);
  const v = visitor(env.app);
  await v.call("as", { id: "ada" });
  env.tick(10 * 60_000 + 1);
  assert.equal(await v.call("verify", { code: await codeAt(env, secret) }), "error:signed-out");
  assert.equal(await v.who(), "nobody");
});

test("sign-in by email goes through the second factor too", async () => {
  const env = setup();
  const { secret } = await enrol(env);
  env.tick(STEP);
  const v = visitor(env.app);
  await v.call("ask", { email: "ada@example.com" });
  const res = await v.confirmEmail(env.sent[0]);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/two-factor?next=%2Finbox");
  assert.equal(await v.who(), "nobody");
  assert.equal(await v.call("verify", { code: await codeAt(env, secret) }), true);
  assert.equal(await v.who(), "ada");
});

test("a passkey with user verification counts as two factors", async () => {
  const env = setup();
  await enrol(env);
  const v = visitor(env.app);
  assert.equal(await v.call("asStrong", { id: "ada" }), "ok");
  assert.equal(await v.who(), "ada");
  assert.equal((await v.call("status")).mfa, true);
});

test("required by policy: set up during the login, per organisation, and when the policy changes", async () => {
  const strict = new Set<string>(["acme"]);
  const admins = new Set<string>();
  const env = setup({ require: (user, tenant) => admins.has(user) || (tenant !== undefined && strict.has(tenant)) });

  const v = visitor(env.app);
  assert.equal(await v.call("as", { id: "bob" }), "ok");
  assert.equal(await v.call("org", { id: "other" }), true);
  assert.equal(await v.call("org", { id: "acme" }), false, "acme requires a second factor this login did not give");
  assert.equal(await v.who(), "bob");

  admins.add("carol");
  const c = visitor(env.app);
  assert.equal(await c.call("as", { id: "carol" }), "two-factor");
  assert.equal(await c.who(), "nobody");
  const st = await c.call("status");
  assert.deepEqual([st.pending, st.enabled, st.required], [true, false, true]);
  assert.equal(await c.call("verify", { code: "123456" }), "error:not-enrolled");
  const s = (await c.call("setup")) as TwoFactorSetup;
  assert.equal((await c.call("enable", { state: s.state, code: await codeAt(env, s.secret) })).length, 10);
  assert.equal(await c.who(), "carol");
  assert.equal(await c.call("org", { id: "acme" }), true, "with two factors acme lets her in");
  assert.equal(await c.call("disable", { code: await codeAt(env, s.secret, 1) }), "error:required");

  admins.add("bob");
  assert.equal(await v.who(), "nobody");
  assert.equal((await v.call("status")).pending, true);
});

test("turning it off and new recovery codes need a current code", async () => {
  const env = setup();
  const { v, secret, codes } = await enrol(env);
  env.tick(STEP);
  assert.equal(await v.call("regen", { code: codes[0] }), null, "a recovery code is not enough");
  const fresh = (await v.call("regen", { code: await codeAt(env, secret) })) as string[];
  assert.equal(fresh.length, 10);
  assert.notDeepEqual(fresh, codes);
  env.tick(STEP);
  assert.equal(await v.call("confirm", { code: await codeAt(env, secret) }), true, "step-up");
  env.tick(STEP);
  assert.equal(await v.call("disable", { code: "000000" === (await codeAt(env, secret)) ? "111111" : "000000" }), false);
  assert.equal(await v.call("disable", { code: await codeAt(env, secret) }), true);
  assert.equal((await v.call("status")).enabled, false);
  assert.equal(await v.call("disable", { code: "123456" }), "error:not-enrolled");

  const w = visitor(env.app);
  assert.equal(await w.call("as", { id: "ada" }), "ok", "off: no second factor");
  await w.call("as", { id: "ada" });
  const old = visitor(env.app);
  await old.call("as", { id: "ada" });
  assert.equal(await old.who(), "ada");
  const again = await enrol(env);
  const x = visitor(env.app);
  await x.call("as", { id: "ada" });
  assert.equal(await x.call("verify", { code: codes[1] }), false);
  assert.equal(await x.call("verify", { code: fresh[1] }), false);
  assert.equal(await x.call("verify", { code: again.codes[1] }), true);
});

test("secrets are stored encrypted, bound to their user", async () => {
  const store = new MemoryTwoFactorStore();
  const env = setup({ store });
  const { secret } = await enrol(env);
  const rec = store.get("ada")!;
  assert.equal(store.advance("ada", rec.lastStep), false, "a step is accepted once");
  assert.equal(store.advance("ada", rec.lastStep - 1), false);
  assert.equal(store.advance("ada", rec.lastStep + 1), true);
  assert.match(rec.secret, /^v1\./);
  assert.ok(!rec.secret.includes(secret));

  store.add({ ...rec, user: "mallory" });
  store.setRecovery("mallory", []);
  const m = visitor(env.app);
  await m.call("as", { id: "mallory" });
  await assert.rejects(m.call("verify", { code: await codeAt(env, secret, 1) }), /verify:/);

  const other = defineTwoFactor({ key: KEY.replace("two", "TWO"), issuer: "Acme", page: "/2fa", store, now: env.now });
  const app2 = createApp({
    secret: SECRET,
    now: env.now,
    routes: { "/": { component: defineComponent("W", () => ({ render: () => "<p id=\"who\">x</p>" })) as never } },
    actions: { as: defineAction("as", [{ name: "id", type: "string" }], (ctx, id: string) => login(ctx, id)) as never,
      verify: defineAction("verify", [{ name: "code", type: "string" }], (ctx, c: string) => other.verify(ctx, c)) as never },
    auth: { twoFactor: other },
  });
  const o = visitor(app2);
  await o.call("as", { id: "ada" });
  await assert.rejects(o.call("verify", { code: await codeAt(env, secret, 1) }), /verify:/);
});

test("SQL stores keep the second factor and the pending login", async () => {
  const db = openSqlite(":memory:");
  db.exec(`CREATE TABLE "weft_sessions" (sid TEXT PRIMARY KEY NOT NULL, user TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL)`);
  const sessions = new SqlSessionStore(db);
  const store = new SqlTwoFactorStore(db);
  const env = setup({ store, sessions });
  const { secret, codes } = await enrol(env);
  assert.equal(store.countRecovery("ada"), 10);
  assert.equal(store.add({ ...store.get("ada")!, secret: "x" }), false, "one per user");
  env.tick(STEP);

  const v = visitor(env.app);
  await v.call("as", { id: "ada" });
  assert.equal(await v.who(), "nobody");
  const pending = db.prepare(`SELECT count(*) AS n FROM "weft_sessions" WHERE pending = 1`).all()[0] as { n: number };
  assert.equal(Number(pending.n), 1);
  assert.equal(await v.call("verify", { code: await codeAt(env, secret) }), true);
  assert.equal(await v.who(), "ada");
  assert.equal(store.advance("ada", Math.floor(env.now() / STEP)), false, "that step is used");
  assert.equal(store.useRecovery("ada", "nope"), false);

  const w = visitor(env.app);
  await w.call("as", { id: "ada" });
  assert.equal(await w.call("verify", { code: codes[2] }), true);
  assert.equal(store.countRecovery("ada"), 9);
  const x = visitor(env.app);
  await x.call("as", { id: "ada" });
  for (let i = 0; i < 4; i++) assert.equal(await x.call("verify", { code: "zzzzz-zzzzz" }), false);
  assert.equal(await x.call("verify", { code: "zzzzz-zzzzz" }), "error:locked");
  assert.ok(store.get("ada")!.lockedUntil > env.now());
  assert.equal(store.remove("ada"), true);
  assert.equal(store.countRecovery("ada"), 0);
});

test("configuration is checked", () => {
  const ok = { key: KEY, issuer: "Acme", page: "/two-factor" };
  assert.throws(() => defineTwoFactor({ ...ok, key: "short" }), /at least 32/);
  assert.throws(() => defineTwoFactor({ ...ok, issuer: "a:b" }), /issuer/);
  assert.throws(() => defineTwoFactor({ ...ok, page: "//evil.example" }), /page/);
  assert.throws(() => defineTwoFactor({ ...ok, page: "https://evil.example/" }), /page/);
  assert.throws(() => defineTwoFactor({ ...ok, digits: 7 as 6 }), /digits/);
  assert.throws(() => defineTwoFactor({ ...ok, window: 5 }), /window/);
  assert.throws(() => defineTwoFactor({ ...ok, maxAttempts: 1000 }), /maxAttempts/);
  assert.throws(() => defineTwoFactor({ ...ok, lockMs: 10 }), /lockMs/);
  assert.throws(() => createApp({ secret: SECRET, routes: {}, auth: { twoFactor: { page: "//x", needed: () => false } } }), /twoFactor/);
});

test("an existing secret imported from another app signs in with its codes, once per user", async () => {
  const env = setup();
  const old = "JBSWY3DPEHPK3PXP";
  assert.equal(await env.twoFactor.importSecret("ada", old.toLowerCase()), true);
  assert.equal(await env.twoFactor.importSecret("ada", old), false, "already on");
  await assert.rejects(env.twoFactor.importSecret("eve", "JBSWY3DP"), TwoFactorError, "too short");
  await assert.rejects(env.twoFactor.importSecret("eve", "not base32!"), TwoFactorError);
  assert.equal(await env.twoFactor.enabled("eve"), false);

  const v = visitor(env.app);
  assert.equal(await v.call("as", { id: "ada" }), "two-factor");
  const code = await codeAt(env, old);
  assert.equal(await v.call("verify", { code }), true);
  assert.equal(await v.who(), "ada");
  assert.deepEqual(await v.call("status"), { user: "ada", pending: false, enabled: true, required: true, mfa: true, recoveryLeft: 0 });
  const w = visitor(env.app);
  await w.call("as", { id: "ada" });
  assert.equal(await w.call("verify", { code }), false, "replayed");
});
