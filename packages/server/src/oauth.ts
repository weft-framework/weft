import { isSecret, type Secret } from "./secret.ts";
import { base64url, fromBase64url } from "./security.ts";

export interface Identity {
  readonly provider: string;
  readonly subject: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly name: string | null;
  readonly picture: string | null;
  readonly claims: Readonly<Record<string, unknown>>;
}

export class SignInError extends Error {
  readonly code: "denied" | "failed";
  constructor(code: "denied" | "failed", message: string) {
    super(message);
    this.name = "SignInError";
    this.code = code;
  }
}

export interface AuthorizeInput {
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
}

export interface IdentifyInput {
  code: string;
  redirectUri: string;
  verifier: string;
  nonce: string;
}

export interface Provider {
  readonly id: string;
  readonly label: string;
  authorize(input: AuthorizeInput): Promise<string>;
  identify(input: IdentifyInput): Promise<Identity>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProviderOptions {
  clientId: string;
  clientSecret: Secret | string;
  scopes?: string[];
  params?: Record<string, string>;
  id?: string;
  label?: string;
  timeoutMs?: number;
  fetch?: Fetch;
}

export interface OidcOptions extends ProviderOptions {
  id: string;
  issuer: string;
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESERVED = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "nonce",
  "code_challenge",
  "code_challenge_method",
]);
const MAX_BODY = 1 << 20;
const SKEW_S = 60;
const JWKS_REFRESH_MS = 60_000;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function fail(message: string): never {
  throw new SignInError("failed", message);
}

function secretOf(s: Secret | string): string {
  return isSecret(s) ? s.reveal() : s;
}

export function checkEndpoint(raw: unknown, what: string): string {
  if (typeof raw !== "string") {
    throw new Error(`sign-in: ${what} is missing`);
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`sign-in: ${what} is not a URL: ${raw}`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new Error(`sign-in: ${what} must use https: ${raw}`);
  }
  if (u.username || u.password) {
    throw new Error(`sign-in: ${what} must not carry credentials`);
  }
  return u.href;
}

function checkCommon(o: ProviderOptions, fallbackId: string): { id: string; label: string; fetch: Fetch; timeoutMs: number } {
  const id = o.id ?? fallbackId;
  if (typeof id !== "string" || !ID.test(id)) {
    throw new Error(`sign-in: provider id ${JSON.stringify(id)} must be 1-32 lowercase letters, digits or -`);
  }
  if (typeof o.clientId !== "string" || o.clientId === "") {
    throw new Error(`sign-in: ${id} needs a clientId`);
  }
  if (!isSecret(o.clientSecret) && (typeof o.clientSecret !== "string" || o.clientSecret === "")) {
    throw new Error(`sign-in: ${id} needs a clientSecret`);
  }
  for (const key of Object.keys(o.params ?? {})) {
    if (RESERVED.has(key)) {
      throw new Error(`sign-in: ${id}: the parameter ${key} is set by the flow`);
    }
  }
  for (const s of o.scopes ?? []) {
    if (typeof s !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s)) {
      throw new Error(`sign-in: ${id}: bad scope ${JSON.stringify(s)}`);
    }
  }
  const timeoutMs = o.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`sign-in: ${id}: timeoutMs is a positive number`);
  }
  return { id, label: o.label ?? fallbackId, fetch: o.fetch ?? ((i, init) => fetch(i, init)), timeoutMs };
}

async function json(f: Fetch, url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await f(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    fail(`${what}: ${(err as Error).message}`);
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) {
    await res.body?.cancel().catch(() => undefined);
    fail(`${what}: response too large`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BODY) {
    fail(`${what}: response too large`);
  }
  let body: unknown;
  try {
    body = JSON.parse(dec.decode(buf));
  } catch {
    fail(`${what}: HTTP ${res.status}, not JSON`);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    fail(`${what}: HTTP ${res.status}, not a JSON object`);
  }
  const o = body as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof o.error === "string" ? o.error.slice(0, 64) : "";
    fail(`${what}: HTTP ${res.status}${code ? ` (${code})` : ""}`);
  }
  return o;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}

function authorizeUrl(endpoint: string, fields: Record<string, string>, extra: Record<string, string> | undefined): string {
  const u = new URL(endpoint);
  for (const [k, v] of Object.entries(extra ?? {})) u.searchParams.set(k, v);
  for (const [k, v] of Object.entries(fields)) u.searchParams.set(k, v);
  return u.href;
}

type Jwk = JsonWebKey & { kid?: string; use?: string; alg?: string };

const ALGS: Record<string, { import: RsaHashedImportParams | EcKeyImportParams; verify: AlgorithmIdentifier | RsaPssParams | EcdsaParams }> = {
  RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: "RSASSA-PKCS1-v1_5" },
  RS384: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, verify: "RSASSA-PKCS1-v1_5" },
  RS512: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }, verify: "RSASSA-PKCS1-v1_5" },
  PS256: { import: { name: "RSA-PSS", hash: "SHA-256" }, verify: { name: "RSA-PSS", saltLength: 32 } },
  ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
  ES384: { import: { name: "ECDSA", namedCurve: "P-384" }, verify: { name: "ECDSA", hash: "SHA-384" } },
};

function part(s: string, what: string): Record<string, unknown> {
  const raw = fromBase64url(s);
  if (!raw) fail(`ID token: bad ${what}`);
  let v: unknown;
  try {
    v = JSON.parse(dec.decode(raw));
  } catch {
    fail(`ID token: bad ${what}`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`ID token: bad ${what}`);
  return v as Record<string, unknown>;
}

export interface VerifyOptions {
  key(kid: string | null, alg: string): Promise<Jwk | null>;
  issuer(iss: unknown, claims: Record<string, unknown>): boolean;
  audience: string;
  nonce: string;
  algs: readonly string[];
  now?: number;
}

export async function verifyIdToken(token: unknown, o: VerifyOptions): Promise<Record<string, unknown>> {
  if (typeof token !== "string" || token.length > 16_384) fail("ID token: missing or too long");
  const parts = token.split(".");
  if (parts.length !== 3) fail("ID token: not a signed JWT");
  const header = part(parts[0], "header");
  const alg = header.alg;
  if (typeof alg !== "string" || !o.algs.includes(alg) || !(alg in ALGS)) {
    fail(`ID token: algorithm ${JSON.stringify(alg)} is not allowed`);
  }
  if (header.crit !== undefined) fail("ID token: critical header extensions are not supported");
  const kid = typeof header.kid === "string" ? header.kid : null;
  const jwk = await o.key(kid, alg);
  if (!jwk) fail("ID token: signed with an unknown key");
  const spec = ALGS[alg];
  let key: CryptoKey;
  try {
    const { kid: _k, use: _u, alg: _a, key_ops: _o, ...material } = jwk;
    key = await crypto.subtle.importKey("jwk", material, spec.import, false, ["verify"]);
  } catch {
    fail("ID token: the provider's key does not fit its algorithm");
  }
  const sig = fromBase64url(parts[2]);
  if (!sig) fail("ID token: bad signature encoding");
  const ok = await crypto.subtle.verify(spec.verify, key, new Uint8Array(sig), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) fail("ID token: bad signature");
  const claims = part(parts[1], "claims");
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  if (!o.issuer(claims.iss, claims)) fail("ID token: wrong issuer");
  const aud = claims.aud;
  const auds = Array.isArray(aud) ? aud : [aud];
  if (!auds.includes(o.audience)) fail("ID token: not issued for this app");
  if (auds.length > 1 && claims.azp !== o.audience) fail("ID token: issued to another party");
  if (claims.azp !== undefined && claims.azp !== o.audience) fail("ID token: issued to another party");
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) fail("ID token: expired");
  if (typeof claims.iat !== "number" || claims.iat - SKEW_S > now) fail("ID token: issued in the future");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - SKEW_S > now)) fail("ID token: not valid yet");
  if (typeof claims.nonce !== "string" || claims.nonce !== o.nonce) fail("ID token: nonce does not match");
  if (typeof claims.sub !== "string" || claims.sub === "" || claims.sub.length > 255) fail("ID token: no subject");
  return claims;
}

interface OidcBehaviour {
  issuer?(iss: unknown, claims: Record<string, unknown>, expected: string): boolean;
  metadataIssuer?(found: unknown, expected: string): boolean;
  verified?(claims: Record<string, unknown>): boolean;
  defaultScopes?: string[];
}

function makeOidc(o: ProviderOptions & { issuer: string }, fallbackId: string, fallbackLabel: string, b: OidcBehaviour = {}): Provider {
  const c = checkCommon(o, fallbackId);
  const issuer = checkEndpoint(o.issuer, `${c.id} issuer`).replace(/\/$/, "");
  const scopes = o.scopes ?? b.defaultScopes ?? ["openid", "email", "profile"];
  if (!scopes.includes("openid")) {
    throw new Error(`sign-in: ${c.id}: OpenID Connect needs the openid scope`);
  }
  let meta: Promise<Record<string, unknown>> | null = null;
  const metadata = (): Promise<Record<string, unknown>> => {
    meta ??= (async () => {
      const m = await json(c.fetch, `${issuer}/.well-known/openid-configuration`, {}, c.timeoutMs, `${c.id} discovery`);
      const ok = b.metadataIssuer ? b.metadataIssuer(m.issuer, issuer) : m.issuer === issuer;
      if (!ok) fail(`${c.id} discovery: the metadata is for another issuer`);
      for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
        try {
          checkEndpoint(m[k], `${c.id} ${k}`);
        } catch (err) {
          fail((err as Error).message);
        }
      }
      return m;
    })();
    meta.catch(() => (meta = null));
    return meta;
  };
  let keys: Jwk[] = [];
  let fetched = 0;
  const refresh = async (): Promise<void> => {
    const m = await metadata();
    const set = await json(c.fetch, m.jwks_uri as string, {}, c.timeoutMs, `${c.id} keys`);
    keys = Array.isArray(set.keys) ? (set.keys as Jwk[]).filter((k) => typeof k === "object" && k !== null) : [];
    fetched = Date.now();
  };
  const find = (kid: string | null, alg: string): Jwk | null => {
    const kty = alg.startsWith("ES") ? "EC" : "RSA";
    const usable = keys.filter((k) => k.kty === kty && (k.use === undefined || k.use === "sig") && (k.alg === undefined || k.alg === alg));
    if (kid !== null) return usable.find((k) => k.kid === kid) ?? null;
    return usable.length === 1 ? usable[0] : null;
  };
  return {
    id: c.id,
    label: o.label ?? fallbackLabel,
    async authorize(input) {
      const m = await metadata();
      return authorizeUrl(
        m.authorization_endpoint as string,
        {
          response_type: "code",
          client_id: o.clientId,
          redirect_uri: input.redirectUri,
          scope: scopes.join(" "),
          state: input.state,
          nonce: input.nonce,
          code_challenge: input.challenge,
          code_challenge_method: "S256",
        },
        o.params,
      );
    },
    async identify(input) {
      const m = await metadata();
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
      });
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      };
      const methods = m.token_endpoint_auth_methods_supported;
      const secret = secretOf(o.clientSecret);
      if (Array.isArray(methods) && methods.includes("client_secret_post") && !methods.includes("client_secret_basic")) {
        form.set("client_id", o.clientId);
        form.set("client_secret", secret);
      } else {
        const user = encodeURIComponent(o.clientId);
        headers.authorization = `Basic ${btoa(`${user}:${encodeURIComponent(secret)}`)}`;
      }
      const tokens = await json(c.fetch, m.token_endpoint as string, { method: "POST", headers, body: form.toString() }, c.timeoutMs, `${c.id} token`);
      const supported = m.id_token_signing_alg_values_supported;
      const algs = Array.isArray(supported) ? Object.keys(ALGS).filter((a) => supported.includes(a)) : ["RS256"];
      const claims = await verifyIdToken(tokens.id_token, {
        audience: o.clientId,
        nonce: input.nonce,
        algs,
        issuer: (iss, all) => (b.issuer ? b.issuer(iss, all, issuer) : iss === issuer),
        key: async (kid, alg) => {
          if (fetched === 0) await refresh();
          let k = find(kid, alg);
          if (!k && Date.now() - fetched > JWKS_REFRESH_MS) {
            await refresh();
            k = find(kid, alg);
          }
          return k;
        },
      });
      const email = str(claims.email);
      return Object.freeze({
        provider: c.id,
        subject: claims.sub as string,
        email,
        emailVerified: email !== null && (b.verified ? b.verified(claims) : claims.email_verified === true || claims.email_verified === "true"),
        name: str(claims.name),
        picture: str(claims.picture),
        claims: Object.freeze(claims),
      });
    },
  };
}

export function oidc(o: OidcOptions): Provider {
  return makeOidc(o, o.id, o.id);
}

export function google(o: ProviderOptions): Provider {
  return makeOidc({ ...o, issuer: "https://accounts.google.com" }, "google", "Google");
}

export interface MicrosoftOptions extends ProviderOptions {
  tenant?: string;
  authority?: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function microsoft(o: MicrosoftOptions): Provider {
  const tenant = o.tenant ?? "common";
  if (!/^[A-Za-z0-9.-]{1,64}$/.test(tenant)) {
    throw new Error(`sign-in: microsoft tenant ${JSON.stringify(tenant)} is not a tenant id or domain`);
  }
  const authority = (o.authority ?? "https://login.microsoftonline.com").replace(/\/$/, "");
  const multi = tenant === "common" || tenant === "organizations" || tenant === "consumers";
  const template = (expected: string) => expected.replace(`/${tenant}/`, "/{tenantid}/");
  return makeOidc({ ...o, issuer: `${authority}/${tenant}/v2.0` }, "microsoft", "Microsoft", {
    metadataIssuer: (found, expected) => found === expected || (multi && found === template(expected)),
    issuer: (iss, claims, expected) => {
      if (!multi) return iss === expected;
      const tid = claims.tid;
      return typeof tid === "string" && GUID.test(tid) && iss === template(expected).replace("{tenantid}", tid);
    },
    verified: (claims) => claims.email_verified === true || claims.xms_edov === true,
  });
}

export interface GitHubOptions extends ProviderOptions {
  baseUrl?: string;
  apiUrl?: string;
}

export function github(o: GitHubOptions): Provider {
  const c = checkCommon(o, "github");
  const base = checkEndpoint(o.baseUrl ?? "https://github.com", "github baseUrl").replace(/\/$/, "");
  const api = checkEndpoint(o.apiUrl ?? (o.baseUrl ? `${base}/api/v3` : "https://api.github.com"), "github apiUrl").replace(/\/$/, "");
  const scopes = o.scopes ?? ["read:user", "user:email"];
  return {
    id: c.id,
    label: o.label ?? "GitHub",
    async authorize(input) {
      return authorizeUrl(
        `${base}/login/oauth/authorize`,
        {
          client_id: o.clientId,
          redirect_uri: input.redirectUri,
          scope: scopes.join(" "),
          state: input.state,
          code_challenge: input.challenge,
          code_challenge_method: "S256",
        },
        o.params,
      );
    },
    async identify(input) {
      const form = new URLSearchParams({
        client_id: o.clientId,
        client_secret: secretOf(o.clientSecret),
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
      });
      const tokens = await json(
        c.fetch,
        `${base}/login/oauth/access_token`,
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString() },
        c.timeoutMs,
        "github token",
      );
      if (typeof tokens.error === "string") fail(`github token: ${tokens.error.slice(0, 64)}`);
      const access = str(tokens.access_token);
      if (!access) fail("github token: no access token");
      const headers = { authorization: `Bearer ${access}`, accept: "application/vnd.github+json", "user-agent": "weft-sign-in" };
      const user = await json(c.fetch, `${api}/user`, { headers }, c.timeoutMs, "github user");
      if (typeof user.id !== "number" || !Number.isSafeInteger(user.id)) fail("github user: no id");
      let email = str(user.email);
      let verified = false;
      try {
        const res = await c.fetch(`${api}/user/emails`, { headers, redirect: "error", signal: AbortSignal.timeout(c.timeoutMs) });
        const text = res.ok ? await res.text() : "";
        const list: unknown = text.length <= MAX_BODY && text ? JSON.parse(text) : [];
        const primary = Array.isArray(list)
          ? (list as { email?: unknown; primary?: unknown; verified?: unknown }[]).find((e) => e?.primary === true && e.verified === true)
          : undefined;
        if (primary && typeof primary.email === "string") {
          email = primary.email;
          verified = true;
        }
      } catch {
      }
      return Object.freeze({
        provider: c.id,
        subject: String(user.id),
        email,
        emailVerified: verified,
        name: str(user.name) ?? str(user.login),
        picture: str(user.avatar_url),
        claims: Object.freeze(user),
      });
    },
  };
}
