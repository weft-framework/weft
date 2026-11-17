import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft/runtime";
import { LocalBroadcast } from "@weft/data";
import { openSqlite } from "@weft/data/sqlite";
import { defineAction } from "../src/action.ts";
import { createApp, type App, type LiveSocket, type SocketData } from "../src/app.ts";
import {
  listSessions,
  login,
  MemorySessionStore,
  revokeSession,
  signOutEverywhere,
  type SessionStore,
} from "../src/auth.ts";
import {
  AccountError,
  defineAccount,
  SqlAccountTokenStore,
  type AccountMessage,
  type AccountOptions,
} from "../src/account.ts";
import { verifyPassword } from "../src/password.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";
const PUBLIC = "https://app.example";

function setup(o: { store?: SessionStore; revocations?: ReturnType<LocalBroadcast["channel"]>; account?: Partial<AccountOptions> } = {}) {
  let clock = 1_800_000_000_000;
  const sent: AccountMessage[] = [];
  const users = new Map<string, { email: string; password: string | null; verified?: string }>([
    ["ada", { email: "ada@example.com", password: null }],
    ["eve", { email: "eve@example.com", password: null }],
  ]);
  let next = 0;
  const account = defineAccount({
    url: PUBLIC,
    send: (m) => void sent.push(m),
    findUser: (email) => [...users].find(([, u]) => u.email === email)?.[0] ?? null,
    emailOf: (user) => users.get(user)?.email ?? null,
    setPassword: (user, hash) => void (users.get(user)!.password = hash),
    setEmail: (user, email) => void (users.get(user)!.email = email),
    checkPassword: (pw) => (pw.includes("password") ? "Too easy to guess" : null),
    createUser: (email, hash) => {
      const id = `u${++next}`;
      users.set(id, { email, password: hash });
      return id;
    },
    markVerified: (user, email) => void (users.get(user)!.verified = email),
    allowSignUp: (email) => (email.endsWith("@spam.example") ? "Use a real address" : true),
    clientKey: (ctx) => ctx.request.headers.get("x-client"),
    now: () => clock,
    ...o.account,
  });
  const Who = defineComponent("Who", (props: { who: string }) => ({
    handlers: { noop() {} },
    render: () => `<p id="who" data-weft-on-click="noop">${escapeHtml(props.who)}</p>`,
  }));
  const str = (name: string) => ({ name, type: "string" }) as const;
  const wrap = async (f: () => Promise<unknown>) => {
    try {
      return (await f()) ?? "done";
    } catch (err) {
      if (err instanceof AccountError) return `error:${err.code}`;
      throw err;
    }
  };
  const actions = {
    as: defineAction("as", [str("id")], (ctx, id: string) => login(ctx, id)),
    list: defineAction("list", [], (ctx) => listSessions(ctx)),
    revoke: defineAction("revoke", [str("id")], (ctx, id: string) => revokeSession(ctx, id)),
    everywhere: defineAction("everywhere", [{ name: "keep", type: "boolean" }], (ctx, keep: boolean) => signOutEverywhere(ctx, { keepThis: keep })),
    forgot: defineAction("forgot", [str("email")], (ctx, e: string) => wrap(() => account.requestPasswordReset(ctx, e))),
    reset: defineAction("reset", [str("token"), str("password")], (ctx, t: string, p: string) => wrap(() => account.resetPassword(ctx, t, p))),
    change: defineAction("change", [str("email")], (ctx, e: string) => wrap(() => account.requestEmailChange(ctx, e))),
    confirm: defineAction("confirm", [str("token")], (ctx, t: string) => wrap(() => account.confirmEmailChange(ctx, t))),
    form: defineAction("form", [], (ctx) => account.signUpForm(ctx)),
    signUp: defineAction("signUp", [str("email"), str("password"), str("form"), str("trap")], (ctx, email: string, password: string, form: string, trap: string) =>
      wrap(() => account.signUp(ctx, { email, password: password || null, form, trap })),
    ),
    complete: defineAction("complete", [str("token")], (ctx, t: string) => wrap(() => account.completeSignUp(ctx, t))),
    askVerify: defineAction("askVerify", [], (ctx) => wrap(() => account.requestVerification(ctx))),
    verify: defineAction("verify", [str("token")], (_ctx, t: string) => account.verifyEmail(t)),
  };
  const app = createApp({
    secret: SECRET,
    now: () => clock,
    clientScript: "export {}",
    onError: () => {},
    routes: { "/": { component: Who as never, load: (ctx) => ({ who: (ctx.user as { id: string } | null)?.id ?? "nobody" }) } },
    actions: actions as never,
    auth: { ...(o.store ? { store: o.store } : {}), ...(o.revocations ? { revocations: o.revocations } : {}) },
  });
  return { app, account, sent, users, tick: (ms: number) => (clock += ms) };
}

function visitor(app: App, agent = "TestBrowser/1.0", client = "") {
  let cookie = "";
  let csrf = "";
  let lid = "";
  const keep = (res: Response) => {
    const set = res.headers.getSetCookie().find((x) => x.startsWith("weft_sid="));
    if (set) cookie = set.split(";")[0];
    csrf = res.headers.get("x-weft-csrf") ?? csrf;
  };
  const self = {
    async who() {
      const res = (await app.fetch(new Request(ORIGIN + "/", { headers: { "user-agent": agent, ...(cookie ? { cookie } : {}) } })))!;
      keep(res);
      const html = await res.text();
      csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? csrf;
      lid = /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? lid;
      return /<p id="who"[^>]*>([^<]*)<\/p>/.exec(html)?.[1];
    },
    async call(name: string, body: object = {}): Promise<any> {
      if (!csrf) await self.who();
      const res = (await app.fetch(
        new Request(`${ORIGIN}/?/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": csrf, "user-agent": agent, ...(client ? { "x-client": client } : {}) },
          body: JSON.stringify(body),
        }),
      ))!;
      keep(res);
      const out = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
      if (!out.ok) throw new Error(`${name}: ${out.error}`);
      await self.who();
      return out.value;
    },
    async live() {
      await self.who();
      let data: SocketData | null = null;
      const server = { upgrade: (_r: Request, o: { data: SocketData }) => ((data = o.data), true) };
      await app.fetch(new Request(`${ORIGIN}/_weft/live?lid=${lid}`, { headers: { cookie, origin: ORIGIN, upgrade: "websocket" } }), server);
      const sent: Record<string, unknown>[] = [];
      const ws: LiveSocket = { data: data!, send: (s) => void sent.push(JSON.parse(s)), close() {} };
      app.websocket.open(ws);
      assert.equal(sent[0]?.t, "hello");
      return sent;
    },
  };
  return self;
}

const tokenOf = (m: AccountMessage) => ("link" in m ? new URL(m.link).searchParams.get("token")! : "");
const settle = () => new Promise((r) => setTimeout(r, 20));

test("a user sees their sessions and signs one out: its live page closes at once", async () => {
  const { app } = setup();
  const a = visitor(app, "Firefox/140");
  const b = visitor(app, "Safari/19");
  await a.call("as", { id: "ada" });
  await b.call("as", { id: "ada" });
  const eve = visitor(app);
  await eve.call("as", { id: "eve" });

  const list = (await a.call("list")) as { id: string; agent: string; current: boolean; mfa: boolean; pending: boolean }[];
  assert.equal(list.length, 2, "only Ada's");
  const mine = list.find((s) => s.current)!;
  const other = list.find((s) => !s.current)!;
  assert.equal(mine.agent, "Firefox/140");
  assert.equal(other.agent, "Safari/19");
  for (const s of list) assert.match(s.id, /^[A-Za-z0-9_-]{22}$/);

  assert.equal(await eve.call("revoke", { id: other.id }), false, "not Eve's session");
  assert.equal(await a.call("revoke", { id: mine.id }), false, "not the asking one (that is logout)");
  assert.equal(await a.call("revoke", { id: "x".repeat(22) }), false);
  assert.equal(await b.who(), "ada");

  const page = await b.live();
  assert.equal(await a.call("revoke", { id: other.id }), true);
  assert.deepEqual(page.at(-1), { t: "expired" }, "the revoked session's live page closed");
  assert.equal(await b.who(), "nobody");
  assert.equal(await a.who(), "ada");
  assert.equal((await a.call("list")).length, 1);
  assert.deepEqual(await eve.call("list").then((l: unknown[]) => l.length), 1);
  assert.deepEqual(await visitor(app).call("list"), [], "signed out: nothing");
});

test("sign out everywhere, keeping this session or not", async () => {
  const { app } = setup();
  const [a, b, c] = [visitor(app), visitor(app), visitor(app)];
  for (const v of [a, b, c]) await v.call("as", { id: "ada" });
  const eve = visitor(app);
  await eve.call("as", { id: "eve" });
  const pc = await c.live();
  assert.equal(await a.call("everywhere", { keep: true }), 2);
  assert.deepEqual(pc.at(-1), { t: "expired" });
  assert.deepEqual([await a.who(), await b.who(), await c.who(), await eve.who()], ["ada", "nobody", "nobody", "eve"]);
  await b.call("as", { id: "ada" });
  assert.equal(await a.call("everywhere", { keep: false }), 2);
  assert.deepEqual([await a.who(), await b.who(), await eve.who()], ["nobody", "nobody", "eve"]);
});

test("with revocations, a session signed out on one instance closes on the others", async () => {
  const store = new MemorySessionStore();
  const hub = new LocalBroadcast();
  const one = setup({ store, revocations: hub.channel() });
  const two = setup({ store, revocations: hub.channel() });
  const a = visitor(one.app);
  await a.call("as", { id: "ada" });
  const b = visitor(two.app);
  await b.call("as", { id: "ada" });
  const page = await b.live();
  assert.equal(await a.call("everywhere", { keep: true }), 1);
  await settle();
  assert.deepEqual(page.at(-1), { t: "expired" }, "closed on the other instance");
  assert.equal(await b.who(), "nobody");

  const ch = hub.channel();
  ch.publish("not json");
  ch.publish(JSON.stringify({ v: 1, t: "revoke", ids: [1, 2] }));
  await settle();
});

test("password reset: same answer for any address, a single-use link, everyone signed out", async () => {
  const env = setup();
  const v = visitor(env.app);
  const elsewhere = visitor(env.app);
  await elsewhere.call("as", { id: "ada" });

  assert.equal(await v.call("forgot", { email: "nobody@example.com" }), "done");
  assert.equal(env.sent.length, 0, "no account, no message, the same answer");
  assert.equal(await v.call("forgot", { email: "not an address" }), "error:invalid");
  assert.equal(await v.call("forgot", { email: " ADA@example.com " }), "done");
  const m = env.sent[0] as Extract<AccountMessage, { kind: "password-reset" }>;
  assert.equal(m.kind, "password-reset");
  assert.equal(m.to, "ada@example.com");
  assert.ok(m.link.startsWith(`${PUBLIC}/reset-password?token=`), "built from the configured url");
  const token = tokenOf(m);
  assert.equal(await env.account.checkResetToken(token), true);
  assert.equal(await env.account.checkResetToken(token + "x"), false);

  assert.equal(await v.call("reset", { token, password: "short" }), "error:weak");
  assert.equal(await v.call("reset", { token, password: "mypassword123" }), "error:weak", "the app's own check");
  assert.equal(env.users.get("ada")!.password, null);
  assert.equal(await v.call("reset", { token, password: "correct horse battery" }), true, "the link still works after a weak try");
  assert.ok(await verifyPassword("correct horse battery", env.users.get("ada")!.password!));
  assert.equal(await elsewhere.who(), "nobody", "signed out everywhere");
  assert.equal(await v.who(), "nobody", "and not signed in by the reset");
  assert.deepEqual(env.sent.at(-1), { kind: "password-changed", to: "ada@example.com" });
  assert.equal(await v.call("reset", { token, password: "another good one" }), false, "used");
});

test("reset links expire, replace each other and die with an address change", async () => {
  const env = setup();
  const v = visitor(env.app);
  await v.call("forgot", { email: "ada@example.com" });
  await v.call("forgot", { email: "ada@example.com" });
  const [first, second] = env.sent.map(tokenOf);
  assert.equal(await v.call("reset", { token: first, password: "a fine passphrase" }), false, "replaced");
  env.tick(30 * 60_000 + 1);
  assert.equal(await v.call("reset", { token: second, password: "a fine passphrase" }), false, "expired");
  await v.call("forgot", { email: "ada@example.com" });
  env.users.get("ada")!.email = "ada@new.example";
  assert.equal(await v.call("reset", { token: tokenOf(env.sent[2]), password: "a fine passphrase" }), false, "sent to an old address");
});

test("requests are rate limited per address", async () => {
  const env = setup();
  for (let i = 0; i < 3; i++) assert.equal(await visitor(env.app).call("forgot", { email: "ada@example.com" }), "done");
  assert.equal(await visitor(env.app).call("forgot", { email: "ada@example.com" }), "error:limit");
  assert.equal(await visitor(env.app).call("forgot", { email: "nobody@example.com" }), "done");
  env.tick(3600_000);
  assert.equal(await visitor(env.app).call("forgot", { email: "ada@example.com" }), "done");
});

test("email change: confirmed from the new address by the same user, the old one told", async () => {
  const env = setup();
  const ada = visitor(env.app);
  assert.equal(await ada.call("change", { email: "ada@new.example" }), "error:signed-out");
  await ada.call("as", { id: "ada" });
  assert.equal(await ada.call("change", { email: "ada@example.com" }), "error:invalid", "the same address");
  assert.equal(await ada.call("change", { email: "eve@example.com" }), "done");
  assert.equal(env.sent.length, 0, "an address in use gets nothing; the same answer");

  assert.equal(await ada.call("change", { email: "Ada@New.example" }), "done");
  const m = env.sent[0] as Extract<AccountMessage, { kind: "email-change" }>;
  assert.equal(m.kind, "email-change");
  assert.equal(m.to, "ada@new.example");
  assert.ok(m.link.startsWith(`${PUBLIC}/confirm-email?token=`));
  const token = tokenOf(m);

  const eve = visitor(env.app);
  await eve.call("as", { id: "eve" });
  assert.equal(await eve.call("confirm", { token }), "done", "null for Eve");
  assert.equal(env.users.get("eve")!.email, "eve@example.com");
  assert.equal(await ada.call("confirm", { token }), "ada@new.example", "Eve's try did not use it up");
  assert.equal(env.users.get("ada")!.email, "ada@new.example");
  assert.deepEqual(env.sent.at(-1), { kind: "email-changed", to: "ada@example.com", newEmail: "ada@new.example" });
  assert.equal(await ada.call("confirm", { token }), "done", "used: null");

  await ada.call("change", { email: "ada@third.example" });
  const t2 = tokenOf(env.sent.at(-1)!);
  env.users.get("eve")!.email = "ada@third.example";
  assert.equal(await ada.call("confirm", { token: t2 }), "done", "null: taken meanwhile");
  assert.equal(env.users.get("ada")!.email, "ada@new.example");

  env.users.get("eve")!.email = "eve@example.com";
  await ada.call("change", { email: "ada@fourth.example" });
  env.tick(24 * 3600_000 + 1);
  assert.equal(await ada.call("confirm", { token: tokenOf(env.sent.at(-1)!) }), "done");
  assert.equal(env.users.get("ada")!.email, "ada@new.example");
});

test("a failed send leaves no usable link", async () => {
  let fail = true;
  const sent: AccountMessage[] = [];
  const env = setup({
    account: {
      send: (m) => {
        sent.push(m);
        if (fail) throw new Error("mail down");
      },
    },
  });
  const v = visitor(env.app);
  await assert.rejects(v.call("forgot", { email: "ada@example.com" }));
  assert.equal(await env.account.checkResetToken(tokenOf(sent[0])), false);
  fail = false;
});

test("SQL tokens and configuration", async () => {
  const db = openSqlite(":memory:");
  const store = new SqlAccountTokenStore(db);
  store.add({ id: "a", kind: "reset", user: "ada", email: "ada@example.com", expires: 10 });
  store.add({ id: "b", kind: "email", user: "ada", email: "x@example.com", expires: 20 });
  assert.equal(store.get("a")!.user, "ada");
  assert.equal(store.take("a")!.email, "ada@example.com");
  assert.equal(store.take("a"), null, "once");
  store.clear("ada", "reset");
  assert.ok(store.get("b"));
  store.sweep(20);
  assert.equal(store.get("b"), null);

  const env = setup({ account: { store } });
  const v = visitor(env.app);
  await v.call("forgot", { email: "ada@example.com" });
  assert.equal(await v.call("reset", { token: tokenOf(env.sent[0]), password: "sql backed pass" }), true);

  const ok = { url: PUBLIC, send: () => {}, findUser: () => null, emailOf: () => null };
  assert.throws(() => defineAccount({ ...ok, url: "http://app.example" }), /https/);
  assert.throws(() => defineAccount({ ...ok, resetPage: "//evil.example" }), /resetPage/);
  assert.throws(() => defineAccount({ ...ok, minPasswordLength: 4 }), /minPasswordLength/);
  assert.throws(() => defineAccount({ ...ok, findUser: undefined as never }), /findUser/);
});

async function signUp(env: ReturnType<typeof setup>, v: ReturnType<typeof visitor>, email: string, o: { password?: string; trap?: string; wait?: number } = {}) {
  const form = await v.call("form");
  env.tick(o.wait ?? 3000);
  return v.call("signUp", { email, password: o.password ?? "a long passphrase", form, trap: o.trap ?? "" });
}

test("sign-up: the account is made only once the address confirms, then signed in", async () => {
  const env = setup();
  const v = visitor(env.app);
  assert.equal(await signUp(env, v, " New@Example.com "), "done");
  assert.equal(env.users.size, 2, "no account yet");
  const m = env.sent[0] as Extract<AccountMessage, { kind: "sign-up" }>;
  assert.equal(m.kind, "sign-up");
  assert.equal(m.to, "new@example.com");
  assert.ok(m.link.startsWith(`${PUBLIC}/sign-up/confirm?token=`));

  const w = visitor(env.app);
  const out = await w.call("complete", { token: tokenOf(m) });
  assert.deepEqual(out, { user: "u1", login: "ok" });
  assert.equal(await w.who(), "u1");
  const made = env.users.get("u1")!;
  assert.equal(made.email, "new@example.com");
  assert.equal(made.verified, "new@example.com");
  assert.ok(await verifyPassword("a long passphrase", made.password!), "stored hashed");
  assert.equal(await visitor(env.app).call("complete", { token: tokenOf(m) }), "done", "used: null");
  assert.equal(env.users.size, 3);
});

test("sign-up for an address with an account: a notice, the same answer", async () => {
  const env = setup();
  const v = visitor(env.app);
  assert.equal(await signUp(env, v, "ada@example.com"), "done");
  assert.deepEqual(env.sent, [{ kind: "account-exists", to: "ada@example.com" }]);
  await signUp(env, v, "twin@example.com");
  await signUp(env, v, "twin@example.com");
  const [a, b] = env.sent.slice(1).map(tokenOf);
  assert.equal((await visitor(env.app).call("complete", { token: b })).user, "u1");
  assert.equal(await visitor(env.app).call("complete", { token: a }), "done", "taken meanwhile: null");
  assert.equal(env.users.size, 3);
});

test("sign-up abuse checks: trap field, too-fast forms, stale forms, limits, the app's rules", async () => {
  const env = setup();
  const v = visitor(env.app);
  assert.equal(await signUp(env, v, "bot1@example.com", { trap: "http://spam" }), "done");
  assert.equal(await signUp(env, v, "bot2@example.com", { wait: 100 }), "done");
  assert.equal(env.sent.length, 0, "bots are dropped silently");
  assert.equal(await v.call("signUp", { email: "x@example.com", password: "a long passphrase", form: "forged", trap: "" }), "error:expired");
  const form = await v.call("form");
  assert.equal(await visitor(env.app).call("signUp", { email: "x@example.com", password: "a long passphrase", form, trap: "" }), "error:expired", "another session's form");
  env.tick(3600_000 + 1);
  assert.equal(await v.call("signUp", { email: "x@example.com", password: "a long passphrase", form, trap: "" }), "error:expired", "an hour old");
  assert.equal(await signUp(env, v, "x@example.com", { password: "short" }), "error:weak");
  assert.equal(await signUp(env, v, "x@spam.example"), "error:refused");

  const env2 = setup({ account: { perClient: 2 } });
  for (let i = 0; i < 2; i++) assert.equal(await signUp(env2, visitor(env2.app, "B", "10.0.0.1"), `p${i}@example.com`), "done");
  assert.equal(await signUp(env2, visitor(env2.app, "B", "10.0.0.1"), "p9@example.com"), "error:limit");
  assert.equal(await signUp(env2, visitor(env2.app, "B", "10.0.0.2"), "p9@example.com"), "done");
});

test("a signed-in user verifies their address", async () => {
  const env = setup();
  const v = visitor(env.app);
  assert.equal(await v.call("askVerify"), "error:signed-out");
  await v.call("as", { id: "ada" });
  assert.equal(await v.call("askVerify"), "done");
  const m = env.sent[0] as Extract<AccountMessage, { kind: "verify-email" }>;
  assert.equal(m.kind, "verify-email");
  assert.equal(m.to, "ada@example.com");
  assert.ok(m.link.startsWith(`${PUBLIC}/verify-email?token=`));
  assert.equal(await visitor(env.app).call("verify", { token: tokenOf(m) }), true);
  assert.equal(env.users.get("ada")!.verified, "ada@example.com");
  assert.equal(await visitor(env.app).call("verify", { token: tokenOf(m) }), false, "once");
  await v.call("askVerify");
  env.users.get("ada")!.email = "ada@other.example";
  assert.equal(await visitor(env.app).call("verify", { token: tokenOf(env.sent[1]) }), false, "not the address any more");
});
