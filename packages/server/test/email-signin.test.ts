import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft/runtime";
import { openSqlite } from "@weft/data/sqlite";
import { defineAction } from "../src/action.ts";
import { createApp, type App } from "../src/app.ts";
import {
  emailSignIn,
  EmailSignInError,
  MemoryEmailTokenStore,
  normalizeEmail,
  SqlEmailTokenStore,
  type EmailSignInMessage,
  type EmailSignInOptions,
  type EmailTokenStore,
} from "../src/email-signin.ts";
import type { Identity } from "../src/oauth.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";
const PUBLIC = "https://app.example";

function setup(extra: Partial<EmailSignInOptions> = {}, signIn: (i: Identity) => string | null = (i) => `u:${i.email}`) {
  const sent: EmailSignInMessage[] = [];
  let clock = Date.now();
  const email = emailSignIn({ page: "/confirm", url: PUBLIC, send: (m) => void sent.push(m), now: () => clock, ...extra });
  const identities: Identity[] = [];
  const Who = defineComponent("Who", (props: { who: string }) => ({
    render: () => `<p id="who">${escapeHtml(props.who)}</p>`,
  }));
  const Confirm = defineComponent("Confirm", (props: { email: string; token: string; action: string } | { email: null }) => ({
    render: () =>
      props.email === null
        ? `<p id="gone">expired</p>`
        : `<h1>Sign in as ${escapeHtml(props.email)}</h1><form method="post" action="${escapeHtml(props.action)}">` +
          `<input type="hidden" name="t" value="${escapeHtml(props.token)}"><button>Sign in</button></form>`,
  }));
  const ask = defineAction("ask", [{ name: "email", type: "string" }, { name: "next", type: "string" }], async (ctx, address: string, next: string) => {
    try {
      await email.request(ctx, address, { next });
      return "sent";
    } catch (err) {
      if (err instanceof EmailSignInError) return err.code;
      throw err;
    }
  });
  const code = defineAction("code", [{ name: "email", type: "string" }, { name: "code", type: "string" }], (ctx, address: string, c: string) =>
    email.verify(ctx, address, c),
  );
  const errors: unknown[] = [];
  const app = createApp({
    secret: SECRET,
    routes: {
      "/": { component: Who as never, load: (ctx) => ({ who: (ctx.user as { id: string } | null)?.id ?? "nobody" }) },
      "/confirm": { component: Confirm as never, load: async (ctx) => (await email.pending(ctx)) ?? { email: null } },
    },
    actions: { ask: ask as never, code: code as never },
    onError: (e) => errors.push(e),
    auth: {
      email,
      signIn: (i) => {
        identities.push(i);
        return signIn(i);
      },
      signInError: "/signin",
    },
  });
  return { app, email, sent, identities, errors, tick: (ms: number) => (clock += ms) };
}

function visitor(app: App, origin = ORIGIN) {
  let cookie = "";
  let csrf = "";
  const keep = (res: Response) => {
    const set = res.headers.getSetCookie().find((c) => c.startsWith("weft_sid="));
    if (set) cookie = set.split(";")[0];
  };
  return {
    get cookie() {
      return cookie;
    },
    async open(path = "/") {
      const res = (await app.fetch(new Request(origin + path, { headers: cookie ? { cookie } : {} })))!;
      keep(res);
      const html = await res.text();
      csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? csrf;
      return { res, html, who: /<p id="who">([^<]*)<\/p>/.exec(html)?.[1] };
    },
    async call(name: string, body: object) {
      if (!csrf) await this.open();
      const res = (await app.fetch(
        new Request(`${origin}/?/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie, "x-weft-csrf": csrf },
          body: JSON.stringify(body),
        }),
      ))!;
      keep(res);
      const out = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
      if (!out.ok) throw new Error(`action ${name} failed: ${out.error}`);
      return out.value;
    },
    async confirm(token: string, from = origin) {
      const res = (await app.fetch(
        new Request(`${origin}/_weft/auth/email`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: from, ...(cookie ? { cookie } : {}) },
          body: new URLSearchParams({ t: token }).toString(),
        }),
      ))!;
      keep(res);
      return res;
    },
  };
}

const tokenOf = (m: EmailSignInMessage) => new URL(m.link).searchParams.get("t")!;
const local = (m: EmailSignInMessage) => {
  const u = new URL(m.link);
  return `${u.pathname}${u.search}`;
};

test("a magic link opens a confirmation page, and its POST signs in once", async () => {
  const { app, sent, identities } = setup();
  const a = visitor(app);
  assert.equal(await a.call("ask", { email: "  Ada@Example.COM ", next: "/inbox" }), "sent");
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.email, "ada@example.com");
  assert.ok(m.link.startsWith(`${PUBLIC}/confirm?t=`), "built from the configured url and page, not the request");
  assert.match(m.code, /^\d{6}$/);

  const b = visitor(app);
  for (let i = 0; i < 2; i++) {
    const page = await b.open(local(m));
    assert.equal(page.res.status, 200);
    assert.match(page.html, /Sign in as ada@example\.com/);
    assert.match(page.html, /<form method="post" action="\/_weft\/auth\/email">/);
    assert.equal(page.res.headers.get("referrer-policy"), "no-referrer", "the token stays out of Referer");
    assert.match(page.res.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  }
  assert.equal((await b.open("/")).res.headers.get("referrer-policy"), "strict-origin-when-cross-origin", "other pages keep the default");
  assert.equal(
    (await app.fetch(new Request(`${ORIGIN}/_weft/auth/email?t=${tokenOf(m)}`)))!.status,
    405,
  );
  assert.equal((await b.open()).who, "nobody");

  assert.equal((await b.confirm(tokenOf(m), "https://evil.example")).status, 403);

  const before = b.cookie;
  const done = await b.confirm(tokenOf(m));
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("location"), "/inbox");
  assert.notEqual(b.cookie, before, "the session id rotates");
  assert.equal((await b.open()).who, "u:ada@example.com");
  assert.deepEqual(
    { provider: identities[0].provider, subject: identities[0].subject, verified: identities[0].emailVerified },
    { provider: "email", subject: "ada@example.com", verified: true },
  );

  const again = await visitor(app).confirm(tokenOf(m));
  assert.equal(again.headers.get("location"), "/signin?error=expired");
  assert.match((await visitor(app).open(local(m))).html, /<p id="gone">expired<\/p>/);
});

test("a one-time code works only in the session that asked, for a few tries", async () => {
  const { app, sent } = setup({ maxAttempts: 3 });
  const a = visitor(app);
  await a.call("ask", { email: "ada@example.com", next: "/" });
  const { code } = sent[0];
  const wrong = code === "000000" ? "111111" : "000000";

  const other = visitor(app);
  assert.equal(await other.call("code", { email: "ada@example.com", code }), false);

  assert.equal(await a.call("code", { email: "ada@example.com", code: wrong }), false);
  assert.equal((await a.open()).who, "nobody");
  assert.equal(await a.call("code", { email: "ADA@example.com", code: `${code.slice(0, 3)} ${code.slice(3)}` }), true, "spaces and case are forgiven");
  assert.equal((await a.open()).who, "u:ada@example.com");
  assert.equal(await a.call("code", { email: "ada@example.com", code }), false, "used up");
  assert.equal((await visitor(app).confirm(tokenOf(sent[0]))).headers.get("location"), "/signin?error=expired", "its link too");

  const c = visitor(app);
  await c.call("ask", { email: "bob@example.com", next: "/" });
  const right = sent[1].code;
  const bad = right === "000000" ? "111111" : "000000";
  for (let i = 0; i < 3; i++) assert.equal(await c.call("code", { email: "bob@example.com", code: bad }), false);
  assert.equal(await c.call("code", { email: "bob@example.com", code: right }), false);
  assert.equal((await c.open()).who, "nobody");
  assert.equal((await c.confirm(tokenOf(sent[1]))).headers.get("location"), "/signin?error=expired");
});

test("requests expire, and a newer one replaces the older", async () => {
  const { app, sent, tick } = setup();
  const a = visitor(app);
  await a.call("ask", { email: "ada@example.com", next: "/" });
  await a.call("ask", { email: "ada@example.com", next: "/" });
  assert.equal((await a.confirm(tokenOf(sent[0]))).headers.get("location"), "/signin?error=expired", "replaced");
  assert.equal(await a.call("code", { email: "ada@example.com", code: sent[0].code }), sent[0].code === sent[1].code);
  if (sent[0].code === sent[1].code) return;
  tick(15 * 60_000 + 1);
  assert.equal(await a.call("code", { email: "ada@example.com", code: sent[1].code }), false);
  assert.equal((await a.confirm(tokenOf(sent[1]))).headers.get("location"), "/signin?error=expired");
});

test("requests are rate limited, and addresses not allowed get nothing", async () => {
  const allowed = new Set(["ada@example.com"]);
  const { app, sent } = setup({ perEmail: 2, perSession: 3, allow: (e) => allowed.has(e) });
  const a = visitor(app);
  assert.equal(await a.call("ask", { email: "ada@example.com", next: "/" }), "sent");
  assert.equal(await a.call("ask", { email: "ada@example.com", next: "/" }), "sent");
  assert.equal(await visitor(app).call("ask", { email: "ada@example.com", next: "/" }), "limit", "per address, across sessions");
  assert.equal(await a.call("ask", { email: "nobody@example.com", next: "/" }), "sent", "the same answer");
  assert.equal(await a.call("ask", { email: "x@example.com", next: "/" }), "limit", "per session");
  assert.equal(sent.length, 2, "nothing sent to an address that is not allowed");
  assert.equal(await a.call("ask", { email: "not an address", next: "/" }), "invalid");
});

test("a refused address and a bad `next` do not sign in or redirect away", async () => {
  const { app, sent } = setup({}, (i) => (i.email === "ada@example.com" ? "ada" : null));
  const a = visitor(app);
  await a.call("ask", { email: "eve@example.com", next: "/" });
  assert.equal((await a.confirm(tokenOf(sent[0]))).headers.get("location"), "/signin?error=refused");
  await a.call("ask", { email: "eve@example.com", next: "/" });
  assert.equal(await a.call("code", { email: "eve@example.com", code: sent[1].code }), false);
  assert.equal((await a.open()).who, "nobody");
  await a.call("ask", { email: "ada@example.com", next: "//evil.example/x" });
  assert.equal((await a.confirm(tokenOf(sent[2]))).headers.get("location"), "/");
});

test("a forged Host header still gets a link to the configured site", async () => {
  const { app, sent } = setup();
  await visitor(app, "http://evil.example").call("ask", { email: "ada@example.com", next: "/" });
  assert.ok(sent[0].link.startsWith(`${PUBLIC}/`));
});

test("only hashes are stored, and a failed send leaves nothing behind", async () => {
  const store = new MemoryEmailTokenStore();
  let fail = false;
  const sent: EmailSignInMessage[] = [];
  const { app } = setup({
    store,
    send: (m) => {
      if (fail) throw new Error("smtp down");
      sent.push(m);
    },
  });
  const a = visitor(app);
  await a.call("ask", { email: "ada@example.com", next: "/" });
  const dump = JSON.stringify(store.find(a.cookie ? (await sessionOf(app, a.cookie))! : "", "ada@example.com"));
  assert.ok(!dump.includes(tokenOf(sent[0])), "no link token at rest");
  assert.ok(!dump.includes(`"${sent[0].code}"`), "no code at rest");
  fail = true;
  await assert.rejects(a.call("ask", { email: "bob@example.com", next: "/" }), /failed/);
  assert.equal(store.find((await sessionOf(app, a.cookie))!, "bob@example.com"), null);
});

async function sessionOf(_app: App, cookie: string): Promise<string | null> {
  const { verifySession, importSecret } = await import("../src/security.ts");
  return verifySession(await importSecret(SECRET), cookie.split("=")[1]);
}

test("the SQL store keeps requests for several instances, and uses each once", async () => {
  const db = openSqlite(":memory:");
  const store: EmailTokenStore = new SqlEmailTokenStore(db);
  const shared = { store };
  const one = setup(shared);
  const a = visitor(one.app);
  await a.call("ask", { email: "ada@example.com", next: "/x" });
  const two = setup(shared);
  const b = visitor(two.app);
  const res = await b.confirm(tokenOf(one.sent[0]));
  assert.equal(res.headers.get("location"), "/x");
  assert.equal((await visitor(one.app).confirm(tokenOf(one.sent[0]))).headers.get("location"), "/signin?error=expired");
  await a.call("ask", { email: "bob@example.com", next: "/" });
  const c = one.sent[1].code;
  assert.equal(await store.take("missing"), false);
  assert.equal(await a.call("code", { email: "bob@example.com", code: c }), true);
  db.close?.();
});

test("addresses are normalised and checked", () => {
  assert.equal(normalizeEmail(" Ada@Example.com "), "ada@example.com");
  for (const bad of ["", "ada", "ada@", "@x.io", "a b@x.io", "ada@x", "ada@-x.io", "<a>@x.io", `${"a".repeat(65)}@x.io`, 42, null]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
  assert.equal(normalizeEmail("o'brien+tag@mail.example.co.uk"), "o'brien+tag@mail.example.co.uk");
});

test("configuration mistakes throw", () => {
  const send = () => undefined;
  assert.throws(() => emailSignIn({ page: "/confirm", url: "http://app.example", send }), /https/);
  assert.throws(() => emailSignIn({ page: "/confirm", url: "app.example", send }), /public origin/);
  assert.throws(() => emailSignIn({ page: "/confirm", url: PUBLIC, send, ttlMs: 10 }), /ttlMs/);
  assert.throws(() => emailSignIn({ page: "/confirm", url: PUBLIC, send, codeLength: 4 }), /codeLength/);
  assert.throws(() => emailSignIn({ page: "/confirm", url: PUBLIC, send, maxAttempts: 0 }), /maxAttempts/);
  for (const page of [undefined, "", "confirm", "//evil.example/x", "/c?x=1", "/c#x", "/_weft/auth/email", "https://evil.example/"]) {
    assert.throws(() => emailSignIn({ page, url: PUBLIC, send } as never), /page/, String(page));
  }
  emailSignIn({ page: "/confirm", url: "http://localhost:3000", send });
  const email = emailSignIn({ page: "/confirm", url: PUBLIC, send });
  assert.throws(() => createApp({ secret: SECRET, routes: {}, auth: { email } }), /auth\.signIn/);
  assert.throws(() => new SqlEmailTokenStore(openSqlite(":memory:"), "bad name"), /table name/);
});

test("pending() reads the token only on the configured page and uses nothing up", async () => {
  const { app, email, sent } = setup();
  await visitor(app).call("ask", { email: "ada@example.com", next: "/" });
  const t = tokenOf(sent[0]);
  const ctxAt = (path: string) => ({ url: new URL(`${ORIGIN}${path}`) }) as never;
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await email.pending(ctxAt(`/confirm?t=${t}`)), { email: "ada@example.com", token: t, action: "/_weft/auth/email" });
  }
  assert.equal(await email.pending(ctxAt(`/other?t=${t}`)), null, "another page");
  assert.equal(await email.pending(ctxAt(`/confirm`)), null);
  assert.equal(await email.pending(ctxAt(`/confirm?t=${t.slice(1)}x`)), null);
  assert.equal((await visitor(app).confirm(t)).status, 303, "still usable");
  assert.equal(await email.pending(ctxAt(`/confirm?t=${t}`)), null, "used");
});
