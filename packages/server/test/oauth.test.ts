import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft-framework/runtime";
import { createApp, type App } from "../src/app.ts";
import { github, google, microsoft, oidc, verifyIdToken, type Identity, type Provider } from "../src/oauth.ts";
import { Secret } from "../src/secret.ts";
import { base64url } from "../src/security.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";
const ISSUER = "https://id.example";
const enc = new TextEncoder();

type Keys = { kid: string; alg: string; privateKey: CryptoKey; jwk: JsonWebKey & { kid: string } };

async function rsaKey(kid: string): Promise<Keys> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  return { kid, alg: "RS256", privateKey: pair.privateKey, jwk };
}

async function ecKey(kid: string): Promise<Keys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  return { kid, alg: "ES256", privateKey: pair.privateKey, jwk };
}

const b64json = (v: unknown) => base64url(enc.encode(JSON.stringify(v)));

async function jwt(k: Keys, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const head = b64json({ alg: k.alg, typ: "JWT", kid: k.kid, ...header });
  const body = b64json(claims);
  const algo = k.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : "RSASSA-PKCS1-v1_5";
  const sig = new Uint8Array(await crypto.subtle.sign(algo, k.privateKey, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${base64url(sig)}`;
}

const nowS = () => Math.floor(Date.now() / 1000);

async function challengeOf(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}

async function fakeOidc(opts: { issuer?: string; metaIssuer?: string; lax?: boolean; claims?: (base: Record<string, unknown>) => Record<string, unknown> } = {}) {
  const issuer = opts.issuer ?? ISSUER;
  let keys = [await rsaKey("k1")];
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string }>();
  const calls: string[] = [];
  let signer = keys[0];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    calls.push(url.pathname);
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return json(200, {
        issuer: opts.metaIssuer ?? issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256", "ES256"],
      });
    }
    if (url.pathname.endsWith("/jwks")) {
      return json(200, { keys: keys.map((k) => k.jwk) });
    }
    if (url.pathname.endsWith("/token")) {
      const form = new URLSearchParams(String(init.body));
      const auth = new Headers(init.headers).get("authorization");
      if (auth !== `Basic ${btoa("client-1:shh")}`) return json(401, { error: "invalid_client" });
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (!grant) return json(400, { error: "invalid_grant" });
      if (!opts.lax && grant.redirect !== form.get("redirect_uri")) return json(400, { error: "invalid_grant" });
      if ((await challengeOf(form.get("code_verifier") ?? "")) !== grant.challenge) return json(400, { error: "invalid_grant" });
      const base = {
        iss: issuer,
        aud: "client-1",
        sub: "user-42",
        email: "ada@example.com",
        email_verified: true,
        name: "Ada",
        nonce: grant.nonce,
        iat: nowS(),
        exp: nowS() + 300,
      };
      return json(200, { access_token: "at", token_type: "Bearer", id_token: await jwt(signer, opts.claims ? opts.claims(base) : base) });
    }
    return json(404, { error: "not_found" });
  };
  return {
    fetch,
    calls,
    consent(authorizeUrl: string): string {
      const u = new URL(authorizeUrl);
      assert.equal(u.searchParams.get("response_type"), "code");
      assert.equal(u.searchParams.get("code_challenge_method"), "S256");
      const code = `code-${codes.size}-${Math.random().toString(36).slice(2)}`;
      codes.set(code, {
        nonce: u.searchParams.get("nonce")!,
        challenge: u.searchParams.get("code_challenge")!,
        redirect: u.searchParams.get("redirect_uri")!,
      });
      const back = new URL(u.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", u.searchParams.get("state")!);
      return back.href;
    },
    async rotate() {
      const k = await rsaKey("k2");
      keys = [...keys, k];
      signer = k;
    },
    signWith(k: Keys) {
      signer = k;
    },
  };
}

function appWith(providers: Provider[], signIn: (i: Identity) => string | null = (i) => `u:${i.subject}`) {
  const seen: Identity[] = [];
  const errors: unknown[] = [];
  const Who = defineComponent("Who", (props: { who: string }) => ({
    render: () => `<p id="who">${escapeHtml(props.who)}</p>`,
  }));
  const app = createApp({
    secret: SECRET,
    routes: { "/": { component: Who as never, load: (ctx) => ({ who: (ctx.user as { id: string } | null)?.id ?? "nobody" }) } },
    onError: (e) => errors.push(e),
    auth: {
      providers,
      signIn: (i) => {
        seen.push(i);
        return signIn(i);
      },
      signInError: "/signin",
    },
  });
  return { app, seen, errors };
}

function browser(app: App) {
  const jar = new Map<string, { value: string; path: string }>();
  const cookieFor = (path: string) =>
    [...jar].filter(([, c]) => path.startsWith(c.path)).map(([n, c]) => `${n}=${c.value}`).join("; ");
  return {
    jar,
    async get(url: string, headers: Record<string, string> = {}) {
      const u = new URL(url, ORIGIN);
      const cookie = cookieFor(u.pathname);
      const res = (await app.fetch(new Request(u.href, { headers: { ...(cookie ? { cookie } : {}), ...headers } })))!;
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split("; ");
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        const path = attrs.find((a) => a.startsWith("Path="))?.slice(5) ?? "/";
        if (attrs.includes("Max-Age=0") || value === "") jar.delete(name);
        else jar.set(name, { value, path });
      }
      return res;
    },
    async who() {
      const html = await (await this.get("/")).text();
      return /<p id="who">([^<]*)<\/p>/.exec(html)?.[1];
    },
  };
}

function provider(fake: { fetch: (i: string, init?: RequestInit) => Promise<Response> }): Provider {
  return oidc({ id: "acme", issuer: ISSUER, clientId: "client-1", clientSecret: new Secret("ACME_SECRET", "shh"), fetch: fake.fetch });
}

test("an OpenID Connect sign-in logs the visitor in and returns to `next`", async () => {
  const fake = await fakeOidc();
  const { app, seen, errors } = appWith([provider(fake)]);
  const b = browser(app);
  await b.get("/");
  const before = b.jar.get("weft_sid")!.value;
  const start = await b.get("/_weft/auth/acme?next=/after?x=1");
  assert.equal(start.status, 302);
  const location = start.headers.get("location")!;
  assert.ok(location.startsWith(`${ISSUER}/authorize?`));
  const u = new URL(location);
  assert.equal(u.searchParams.get("redirect_uri"), `${ORIGIN}/_weft/auth/acme/callback`);
  assert.equal(u.searchParams.get("scope"), "openid email profile");
  assert.equal(u.searchParams.get("client_id"), "client-1");
  assert.ok(u.searchParams.get("state")!.length >= 40 && u.searchParams.get("nonce")!.length >= 40);
  const flowCookie = start.headers.getSetCookie().find((c) => c.startsWith("weft_signin="))!;
  assert.match(flowCookie, /Path=\/_weft\/auth\/; HttpOnly; SameSite=Lax; Max-Age=600/);
  assert.equal(start.headers.get("cache-control"), "no-store");

  const done = await b.get(fake.consent(location));
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("location"), "/after?x=1");
  assert.ok(!b.jar.has("weft_signin"), "the flow cookie is cleared");
  assert.notEqual(b.jar.get("weft_sid")!.value, before, "logging in rotates the session");
  assert.equal(await b.who(), "u:user-42");
  assert.deepEqual(errors, []);
  const id = seen[0];
  assert.equal(id.provider, "acme");
  assert.equal(id.subject, "user-42");
  assert.equal(id.email, "ada@example.com");
  assert.equal(id.emailVerified, true);
  assert.equal(id.name, "Ada");
  assert.ok(Object.isFrozen(id));
});

test("a callback completes only in the browser and session that started it", async () => {
  const fake = await fakeOidc();
  const { app, seen } = appWith([provider(fake)]);

  const attacker = browser(app);
  const link = fake.consent((await attacker.get("/_weft/auth/acme")).headers.get("location")!);
  const victim = browser(app);
  await victim.get("/");
  const res = await victim.get(link);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/signin?error=failed");
  assert.equal(await victim.who(), "nobody");
  assert.ok(!fake.calls.includes("/token"), "the code is never exchanged");

  victim.jar.set("weft_signin", attacker.jar.get("weft_signin")!);
  assert.equal((await victim.get(link)).headers.get("location"), "/signin?error=failed");
  assert.equal(await victim.who(), "nobody");

  const b = browser(app);
  const back = new URL(fake.consent((await b.get("/_weft/auth/acme")).headers.get("location")!));
  back.searchParams.set("state", "x".repeat(43));
  assert.equal((await b.get(back.href)).headers.get("location"), "/signin?error=failed");
  assert.equal(seen.length, 0);

  const lax = await fakeOidc({ lax: true });
  const two = appWith([provider(lax), oidc({ id: "other", issuer: ISSUER, clientId: "client-1", clientSecret: "shh", fetch: lax.fetch })]);
  const c = browser(two.app);
  const url = new URL(lax.consent((await c.get("/_weft/auth/acme")).headers.get("location")!));
  url.pathname = "/_weft/auth/other/callback";
  assert.equal((await c.get(url.href)).headers.get("location"), "/signin?error=failed");
  assert.equal(two.seen.length, 0);
});

test("a sign-in starts only from this site, and returns only to its own paths", async () => {
  const fake = await fakeOidc();
  const { app } = appWith([provider(fake)]);
  const b = browser(app);
  assert.equal((await b.get("/_weft/auth/acme", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await b.get("/_weft/auth/acme", { "sec-fetch-site": "same-site" })).status, 403);
  assert.equal((await b.get("/_weft/auth/acme", { "sec-fetch-site": "same-origin" })).status, 302);
  assert.equal((await b.get("/_weft/auth/acme", { "sec-fetch-site": "none" })).status, 302);
  for (const next of ["//evil.example/x", "https://evil.example/", "/\\evil.example", "javascript:alert(1)"]) {
    const c = browser(app);
    const start = await c.get(`/_weft/auth/acme?next=${encodeURIComponent(next)}`);
    const done = await c.get(fake.consent(start.headers.get("location")!));
    assert.equal(done.headers.get("location"), "/", next);
  }
  assert.equal((await b.get("/_weft/auth/nope")).status, 404);
  assert.equal((await b.get("/_weft/auth/acme/elsewhere")).status, 404);
  const post = (await app.fetch(new Request(`${ORIGIN}/_weft/auth/acme`, { method: "POST", headers: { origin: ORIGIN } })))!;
  assert.equal(post.status, 405);
});

test("a denied consent, a refused identity and a provider failure do not log in", async () => {
  const fake = await fakeOidc();
  const { app, errors } = appWith([provider(fake)], (i) => (i.email === "ada@example.com" ? null : "x"));
  const b = browser(app);
  const location = (await b.get("/_weft/auth/acme")).headers.get("location")!;
  const denied = new URL(`${ORIGIN}/_weft/auth/acme/callback`);
  denied.searchParams.set("error", "access_denied");
  denied.searchParams.set("state", new URL(location).searchParams.get("state")!);
  assert.equal((await b.get(denied.href)).headers.get("location"), "/signin?error=denied");

  const refused = await b.get(fake.consent((await b.get("/_weft/auth/acme")).headers.get("location")!));
  assert.equal(refused.headers.get("location"), "/signin?error=refused");
  assert.equal(await b.who(), "nobody");

  const bad = new URL(fake.consent((await b.get("/_weft/auth/acme")).headers.get("location")!));
  bad.searchParams.set("code", "made-up");
  assert.equal((await b.get(bad.href)).headers.get("location"), "/signin?error=failed");
  assert.match(String(errors.at(-1)), /acme token: HTTP 400 \(invalid_grant\)/);
  assert.equal(await b.who(), "nobody");
});

test("ID tokens are checked: signature, algorithm, issuer, audience, expiry, nonce", async () => {
  const rsa = await rsaKey("k1");
  const ec = await ecKey("e1");
  const good = { iss: ISSUER, aud: "client-1", sub: "s", nonce: "n", iat: nowS(), exp: nowS() + 60 };
  const opts = {
    key: async (kid: string | null) => [rsa.jwk, ec.jwk].find((k) => k.kid === kid) ?? null,
    issuer: (iss: unknown) => iss === ISSUER,
    audience: "client-1",
    nonce: "n",
    algs: ["RS256", "ES256"],
  };
  assert.equal((await verifyIdToken(await jwt(rsa, good), opts)).sub, "s");
  assert.equal((await verifyIdToken(await jwt(ec, good), opts)).sub, "s");
  const rejects = async (token: string | Promise<string>, re: RegExp, o = opts) =>
    assert.rejects(verifyIdToken(await token, o), (e: Error) => re.test(e.message));
  await rejects(jwt(rsa, { ...good, aud: "client-2" }), /not issued for this app/);
  await rejects(jwt(rsa, { ...good, aud: ["client-1", "client-2"] }), /another party/);
  await rejects(jwt(rsa, { ...good, azp: "client-2" }), /another party/);
  await rejects(jwt(rsa, { ...good, iss: "https://evil.example" }), /wrong issuer/);
  await rejects(jwt(rsa, { ...good, exp: nowS() - 120 }), /expired/);
  await rejects(jwt(rsa, { ...good, iat: nowS() + 600 }), /future/);
  await rejects(jwt(rsa, { ...good, nonce: "other" }), /nonce/);
  await rejects(jwt(rsa, { ...good, nonce: undefined }), /nonce/);
  await rejects(jwt(rsa, { ...good, sub: "" }), /subject/);
  await rejects(jwt(rsa, good, { kid: "unknown" }), /unknown key/);
  await rejects(jwt(rsa, good), /not allowed/, { ...opts, algs: ["ES256"] });
  await rejects(jwt(rsa, good, { alg: "ES256" }), /does not fit|bad signature/);
  const [h, , s] = (await jwt(rsa, good)).split(".");
  await rejects(`${h}.${b64json({ ...good, sub: "admin" })}.${s}`, /bad signature/);
  await rejects(`${b64json({ alg: "none" })}.${b64json(good)}.`, /not allowed/);
  await rejects(`${b64json({ alg: "HS256", kid: "k1" })}.${b64json(good)}.${base64url(new Uint8Array(32))}`, /not allowed/);
  await rejects(jwt(rsa, good, { crit: ["exp"] }), /critical/);
  await rejects("a.b", /not a signed JWT/);
});

test("a key the provider rotated in is fetched once", async () => {
  const fake = await fakeOidc();
  const { app } = appWith([provider(fake)]);
  const b = browser(app);
  await b.get(fake.consent((await b.get("/_weft/auth/acme")).headers.get("location")!));
  assert.equal(fake.calls.filter((c) => c === "/jwks").length, 1);
  await fake.rotate();
  const c = browser(app);
  const res = await c.get(fake.consent((await c.get("/_weft/auth/acme")).headers.get("location")!));
  assert.equal(res.headers.get("location"), "/signin?error=failed");
  assert.equal(fake.calls.filter((c) => c === "/jwks").length, 1);
});

test("a rotated key is found after the refresh interval", async (t) => {
  const fake = await fakeOidc();
  const p = provider(fake);
  const { app } = appWith([p]);
  const b = browser(app);
  await b.get(fake.consent((await b.get("/_weft/auth/acme")).headers.get("location")!));
  await fake.rotate();
  const real = Date.now;
  t.after(() => (Date.now = real));
  const start = real();
  Date.now = () => start + 61_000;
  const c = browser(app);
  const res = await c.get(fake.consent((await c.get("/_weft/auth/acme")).headers.get("location")!));
  assert.equal(res.headers.get("location"), "/");
  assert.equal(fake.calls.filter((c) => c === "/jwks").length, 2);
});

test("Microsoft's shared endpoint accepts the user's own directory as issuer", async () => {
  const authority = "https://login.example";
  const tid = "8f2c6c1e-1d3a-4c55-9a1a-0b8f3e2d7c11";
  const template = `${authority}/{tenantid}/v2.0`;
  const fake = await fakeOidc({
    issuer: `${authority}/common/v2.0`,
    metaIssuer: template,
    claims: (base) => ({ ...base, iss: `${authority}/${tid}/v2.0`, tid, email_verified: undefined }),
  });
  const ms = microsoft({ clientId: "client-1", clientSecret: "shh", authority, fetch: fake.fetch });
  const { app, seen } = appWith([ms]);
  const b = browser(app);
  const res = await b.get(fake.consent((await b.get("/_weft/auth/microsoft")).headers.get("location")!));
  assert.equal(res.headers.get("location"), "/");
  assert.equal(seen[0].emailVerified, false, "Microsoft's email is not taken as verified");
  assert.equal(ms.label, "Microsoft");

  const evil = await fakeOidc({
    issuer: `${authority}/common/v2.0`,
    metaIssuer: template,
    claims: (base) => ({ ...base, iss: `${authority}/${tid}/v2.0`, tid: "00000000-0000-0000-0000-000000000000" }),
  });
  const two = appWith([microsoft({ clientId: "client-1", clientSecret: "shh", authority, fetch: evil.fetch })]);
  const c = browser(two.app);
  const bad = await c.get(evil.consent((await c.get("/_weft/auth/microsoft")).headers.get("location")!));
  assert.equal(bad.headers.get("location"), "/signin?error=failed");
  assert.match(String(two.errors.at(-1)), /wrong issuer/);
});

test("GitHub: the numeric id, and the primary email only when verified", async () => {
  const codes = new Set<string>();
  let emails: unknown = [
    { email: "old@example.com", primary: false, verified: true },
    { email: "ada@example.com", primary: true, verified: true },
  ];
  const calls: string[] = [];
  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push(url.pathname);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (url.pathname === "/login/oauth/access_token") {
      const form = new URLSearchParams(String(init.body));
      if (form.get("client_secret") !== "shh" || !codes.delete(form.get("code")!) || !form.get("code_verifier")) {
        return json({ error: "bad_verification_code" });
      }
      return json({ access_token: "gho_x", token_type: "bearer" });
    }
    if (new Headers(init.headers).get("authorization") !== "Bearer gho_x") return json({ message: "Bad credentials" }, 401);
    if (url.pathname === "/user") return json({ id: 583231, login: "ada", name: null, email: null, avatar_url: "https://avatars.example/u/1" });
    if (url.pathname === "/user/emails") return json(emails);
    return json({}, 404);
  };
  const gh = github({ clientId: "gh-1", clientSecret: "shh", baseUrl: "https://gh.example", apiUrl: "https://api.gh.example", fetch });
  const { app, seen, errors } = appWith([gh]);
  const run = async () => {
    const b = browser(app);
    const u = new URL((await b.get("/_weft/auth/github")).headers.get("location")!);
    assert.equal(u.origin + u.pathname, "https://gh.example/login/oauth/authorize");
    assert.equal(u.searchParams.get("scope"), "read:user user:email");
    const code = `c${codes.size}${Math.random()}`;
    codes.add(code);
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.search = new URLSearchParams({ code, state: u.searchParams.get("state")! }).toString();
    return b.get(back.href);
  };
  assert.equal((await run()).headers.get("location"), "/");
  assert.deepEqual(
    { subject: seen[0].subject, email: seen[0].email, verified: seen[0].emailVerified, name: seen[0].name },
    { subject: "583231", email: "ada@example.com", verified: true, name: "ada" },
  );
  emails = [{ email: "ada@example.com", primary: true, verified: false }];
  await run();
  assert.equal(seen[1].email, null);
  assert.equal(seen[1].emailVerified, false);
  const b = browser(app);
  const u = new URL((await b.get("/_weft/auth/github")).headers.get("location")!);
  const back = new URL(u.searchParams.get("redirect_uri")!);
  back.search = new URLSearchParams({ code: "nope", state: u.searchParams.get("state")! }).toString();
  assert.equal((await b.get(back.href)).headers.get("location"), "/signin?error=failed");
  assert.match(String(errors.at(-1)), /bad_verification_code/);
});

test("provider and app configuration mistakes throw at startup", () => {
  const base = { clientId: "c", clientSecret: "s" };
  assert.throws(() => oidc({ ...base, id: "x", issuer: "http://id.example" }), /must use https/);
  assert.throws(() => oidc({ ...base, id: "x", issuer: "https://u:p@id.example" }), /credentials/);
  assert.throws(() => oidc({ ...base, id: "X Y", issuer: ISSUER }), /provider id/);
  assert.throws(() => oidc({ ...base, id: "x", issuer: ISSUER, scopes: ["email"] }), /openid scope/);
  assert.throws(() => google({ ...base, params: { redirect_uri: "https://evil.example" } }), /set by the flow/);
  assert.throws(() => google({ ...base, clientSecret: "" }), /clientSecret/);
  assert.throws(() => github({ ...base, baseUrl: "http://gh.example" }), /must use https/);
  assert.throws(() => microsoft({ ...base, tenant: "a/b" }), /tenant/);
  oidc({ ...base, id: "local", issuer: "http://localhost:8080/realms/dev" });
  const g = google(base);
  assert.equal(g.id, "google");
  assert.equal(g.label, "Google");
  assert.throws(() => createApp({ secret: SECRET, routes: {}, auth: { providers: [g, google(base)], signIn: () => null } }), /two sign-in providers/);
  assert.throws(() => createApp({ secret: SECRET, routes: {}, auth: { providers: [g] } }), /auth\.signIn/);
  assert.throws(
    () => createApp({ secret: SECRET, routes: {}, auth: { providers: [g], signIn: () => null, signInError: "https://evil.example" } }),
    /same-origin path/,
  );
});

test("without providers the sign-in routes do not exist", async () => {
  const app = createApp({ secret: SECRET, routes: {} });
  assert.equal((await app.fetch(new Request(`${ORIGIN}/_weft/auth/google`)))!.status, 404);
});
