const enc = new TextEncoder();

export const MIN_SECRET_LENGTH = 32;

export type Key = CryptoKey;

export async function importSecret(secret: string): Promise<Key> {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `@weft/server: the secret must be at least ${MIN_SECRET_LENGTH} characters of random data`,
    );
  }
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomId(bytes = 18): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function macBytes(key: Key, data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

async function mac(key: Key, data: string): Promise<string> {
  return base64url(await macBytes(key, data));
}

export function fromBase64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) {
    return null;
  }
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

const SID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export async function signSession(key: Key, sid: string): Promise<string> {
  return `${sid}.${await mac(key, "sid:" + sid)}`;
}

export async function verifySession(key: Key, value: string | undefined): Promise<string | null> {
  if (!value) {
    return null;
  }
  const dot = value.indexOf(".");
  if (dot < 0) {
    return null;
  }
  const sid = value.slice(0, dot);
  if (!SID_RE.test(sid)) {
    return null;
  }
  const expected = await mac(key, "sid:" + sid);
  return timingSafeEqual(value.slice(dot + 1), expected) ? sid : null;
}

export async function csrfToken(key: Key, sid: string): Promise<string> {
  const raw = await macBytes(key, "csrf:" + sid);
  const pad = crypto.getRandomValues(new Uint8Array(raw.length));
  const out = new Uint8Array(raw.length * 2);
  out.set(pad);
  for (let i = 0; i < raw.length; i++) {
    out[raw.length + i] = raw[i] ^ pad[i];
  }
  return base64url(out);
}

export async function verifyCsrf(key: Key, sid: string, token: string | null): Promise<boolean> {
  const bytes = token ? fromBase64url(token) : null;
  const raw = await macBytes(key, "csrf:" + sid);
  if (!bytes || bytes.length !== raw.length * 2) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < raw.length; i++) {
    diff |= bytes[i] ^ bytes[raw.length + i] ^ raw[i];
  }
  return diff === 0;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (name && !(name in out)) {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export interface CookieOptions {
  secure: boolean;
  maxAgeSeconds?: number;
}

export function sessionCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.secure) {
    parts.push("Secure");
  }
  if (opts.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.floor(opts.maxAgeSeconds)}`);
  }
  return parts.join("; ");
}

export function sameOrigin(req: Request): boolean {
  const own = new URL(req.url).origin;
  const origin = req.headers.get("origin");
  if (origin !== null) {
    return origin === own;
  }
  return req.headers.get("sec-fetch-site") === "same-origin";
}

export interface RateLimitOptions {
  capacity: number;
  refillPerSecond: number;
  maxKeys?: number;
}

export class RateLimiter {
  private readonly opts: Required<RateLimitOptions>;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(opts: RateLimitOptions) {
    this.opts = { maxKeys: 100_000, ...opts };
  }

  take(key: string, now = Date.now()): boolean {
    const { capacity, refillPerSecond, maxKeys } = this.opts;
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSecond);
      b.at = now;
      this.buckets.delete(key);
    } else {
      b = { tokens: capacity, at: now };
      if (this.buckets.size >= maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) {
          this.buckets.delete(oldest);
        }
      }
    }
    this.buckets.set(key, b);
    if (b.tokens < 1) {
      return false;
    }
    b.tokens -= 1;
    return true;
  }
}

export interface CspSources {
  connect?: readonly string[];
  img?: readonly string[];
  media?: readonly string[];
  font?: readonly string[];
  frame?: readonly string[];
  style?: readonly string[];
  form?: readonly string[];
  worker?: readonly string[];
}

const CSP_DIRECTIVES: Record<keyof CspSources, string> = {
  connect: "connect-src",
  img: "img-src",
  media: "media-src",
  font: "font-src",
  frame: "frame-src",
  style: "style-src",
  form: "form-action",
  worker: "worker-src",
};
const CSP_SCHEMES: Record<string, readonly (keyof CspSources)[]> = {
  "blob:": ["connect", "img", "media", "worker"],
  "data:": ["img", "media", "font"],
};
const CSP_ORIGIN =
  /^(?:(?:https|wss):\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*|(?:http|ws):\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?::\d{1,5})?(?:\/[A-Za-z0-9._~%!$&()*+=:@/-]*)?$/;

export function checkCspSources(raw: unknown, where: string): CspSources {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(`${where}: csp is an object of origin lists, like { connect: ["https://api.example.com"] }`);
  }
  const out: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(raw)) {
    if (!(key in CSP_DIRECTIVES)) {
      throw new TypeError(`${where}: csp.${key} is not one of ${Object.keys(CSP_DIRECTIVES).join(", ")}`);
    }
    if (!Array.isArray(list) || list.length > 32) {
      throw new TypeError(`${where}: csp.${key} is a list of at most 32 origins`);
    }
    const kept: string[] = [];
    for (const entry of list) {
      const scheme = typeof entry === "string" ? CSP_SCHEMES[entry] : undefined;
      const ok =
        typeof entry === "string" &&
        entry.length <= 256 &&
        (scheme ? scheme.includes(key as keyof CspSources) : CSP_ORIGIN.test(entry));
      if (!ok) {
        throw new TypeError(
          `${where}: csp.${key} entry ${JSON.stringify(entry)} is not an origin this page may reach ` +
            "(https://host or wss://host, optionally *.host, a port and a path; http: only for localhost)",
        );
      }
      if (!kept.includes(entry)) kept.push(entry);
    }
    if (kept.length) out[key] = kept;
  }
  return out as CspSources;
}

export function mergeCspSources(...sets: (CspSources | undefined)[]): CspSources {
  const out: Record<string, string[]> = {};
  for (const set of sets) {
    for (const [key, list] of Object.entries(set ?? {})) {
      const into = (out[key] ??= []);
      for (const e of list as string[]) if (!into.includes(e)) into.push(e);
    }
  }
  return out as CspSources;
}

export interface HeaderOptions {
  nonce: string;
  hashes?: { script: readonly string[]; style: readonly string[] };
  secure: boolean;
  sources?: CspSources;
  report?: string;
}

export function securityHeaders(opts: HeaderOptions): Record<string, string> {
  const s = opts.sources ?? {};
  const add = (base: string, list: readonly string[] | undefined) => (list?.length ? `${base} ${list.join(" ")}` : base);
  const directives = [
    "default-src 'self'",
    opts.hashes ? add("script-src 'self'", opts.hashes.script) : `script-src 'nonce-${opts.nonce}' 'self'`,
    add(opts.hashes ? add("style-src 'self'", opts.hashes.style) : `style-src 'self' 'nonce-${opts.nonce}'`, s.style),
    add("img-src 'self' data:", s.img?.filter((e) => e !== "data:")),
    add("connect-src 'self'", s.connect),
    ...(s.media?.length ? [add("media-src 'self'", s.media)] : []),
    ...(s.font?.length ? [add("font-src 'self'", s.font)] : []),
    ...(s.worker?.length ? [add("worker-src 'self'", s.worker)] : []),
    s.frame?.length ? `frame-src ${s.frame.join(" ")}` : "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    add("form-action 'self'", s.form),
  ];
  if (opts.report) directives.push(`report-uri ${opts.report}`, "report-to weft-csp");
  const h: Record<string, string> = {
    "content-security-policy": directives.join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
  };
  if (opts.report) h["reporting-endpoints"] = `weft-csp="${opts.report}"`;
  if (opts.secure) {
    h["strict-transport-security"] = "max-age=63072000; includeSubDomains";
  }
  return h;
}
