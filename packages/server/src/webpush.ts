import type { SqlDatabase } from "@weft/data";
import { authState } from "./auth.ts";
import type { PageContext } from "./context.ts";
import { isSecret, type Secret } from "./secret.ts";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
type Bytes = Uint8Array<ArrayBuffer>;

export interface PushSubscriptionRecord {
  endpoint: string;
  user: string;
  p256dh: string;
  auth: string;
  created: number;
}

export interface PushStore {
  add(r: PushSubscriptionRecord): void | Promise<void>;
  forUser(user: string): PushSubscriptionRecord[] | Promise<PushSubscriptionRecord[]>;
  remove(endpoint: string, user?: string): boolean | Promise<boolean>;
}

export class MemoryPushStore implements PushStore {
  readonly #rows = new Map<string, PushSubscriptionRecord>();
  add(r: PushSubscriptionRecord): void {
    this.#rows.delete(r.endpoint);
    this.#rows.set(r.endpoint, { ...r });
  }
  forUser(user: string): PushSubscriptionRecord[] {
    return [...this.#rows.values()].filter((r) => r.user === user).map((r) => ({ ...r }));
  }
  remove(endpoint: string, user?: string): boolean {
    const r = this.#rows.get(endpoint);
    if (!r || (user !== undefined && r.user !== user)) return false;
    return this.#rows.delete(endpoint);
  }
}

export class SqlPushStore implements PushStore {
  readonly #db: SqlDatabase;
  readonly #t: string;

  constructor(db: SqlDatabase, table = "weft_push_subscriptions") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`@weft/server: not a valid table name: ${table}`);
    this.#db = db;
    this.#t = `"${table}"`;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#t} (endpoint TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, ` +
        `p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL)`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_user" ON ${this.#t} (user_id)`);
  }
  add(r: PushSubscriptionRecord): void {
    this.#db
      .prepare(`INSERT OR REPLACE INTO ${this.#t} (endpoint, user_id, p256dh, auth, created) VALUES (?, ?, ?, ?, ?)`)
      .run(r.endpoint, r.user, r.p256dh, r.auth, r.created);
  }
  forUser(user: string): PushSubscriptionRecord[] {
    return (this.#db.prepare(`SELECT * FROM ${this.#t} WHERE user_id = ? ORDER BY created, endpoint`).all(user) as Record<string, unknown>[]).map(
      (r) => ({ endpoint: String(r.endpoint), user: String(r.user_id), p256dh: String(r.p256dh), auth: String(r.auth), created: Number(r.created) }),
    );
  }
  remove(endpoint: string, user?: string): boolean {
    const r = user === undefined
      ? this.#db.prepare(`DELETE FROM ${this.#t} WHERE endpoint = ? RETURNING endpoint`).all(endpoint)
      : this.#db.prepare(`DELETE FROM ${this.#t} WHERE endpoint = ? AND user_id = ? RETURNING endpoint`).all(endpoint, user);
    return r.length > 0;
  }
}

const utf8 = new TextEncoder();

function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const ZERO = String.fromCharCode(0);

async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64url(raw), privateKey: jwk.d! };
}

function pointJwk(publicKey: Bytes): { x: string; y: string } {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("not an uncompressed P-256 point");
  return { x: b64url(publicKey.subarray(1, 33)), y: b64url(publicKey.subarray(33)) };
}

export async function encryptPushPayload(
  plaintext: Uint8Array,
  to: { p256dh: Bytes; auth: Bytes },
  test: { local?: CryptoKeyPair; salt?: Bytes } = {},
): Promise<Bytes> {
  if (to.p256dh.length !== 65 || to.p256dh[0] !== 4) throw new Error("p256dh is an uncompressed P-256 point");
  if (to.auth.length !== 16) throw new Error("auth is 16 bytes");
  const local = test.local ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const salt = test.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", to.p256dh, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(shared, to.auth, concat(utf8.encode(`WebPush: info${ZERO}`), to.p256dh, asPublic), 32);
  const cek = await hkdf(ikm, salt, utf8.encode(`Content-Encoding: aes128gcm${ZERO}`), 16);
  const nonce = await hkdf(ikm, salt, utf8.encode(`Content-Encoding: nonce${ZERO}`), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, Uint8Array.of(2))));
  const rs = 4096;
  const header = concat(salt, Uint8Array.of(rs >>> 24, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255), Uint8Array.of(65), asPublic);
  return concat(header, sealed);
}

export const PUSH_SERVICES: readonly string[] = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
];

export interface WebPushOptions {
  publicKey: string;
  privateKey: string | Secret;
  subject: string;
  store?: PushStore;
  allowHosts?: readonly string[];
  maxPerUser?: number;
  ttlSeconds?: number;
  fetch?: Fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface PushMessage {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
  urgency?: "very-low" | "low" | "normal" | "high";
}

export interface PushResult {
  sent: number;
  removed: number;
  failed: number;
}

export class PushError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "PushError";
    this.permanent = permanent;
  }
}

const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export class WebPush {
  readonly publicKey: string;
  readonly #o: { subject: string; store: PushStore; hosts: string[]; max: number; ttl: number; fetch: Fetch; timeoutMs: number; now: () => number };
  readonly #privateKey: string | Secret;
  #signing: Promise<CryptoKey> | null = null;
  #lastCreated = 0;

  constructor(o: WebPushOptions) {
    let pub: Bytes;
    try {
      pub = fromB64url(o.publicKey);
      pointJwk(pub);
    } catch {
      throw new Error("defineWebPush: publicKey is a base64url P-256 public key (generateVapidKeys)");
    }
    const priv = isSecret(o.privateKey) ? o.privateKey.reveal() : o.privateKey;
    if (typeof priv !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(priv)) throw new Error("defineWebPush: privateKey is a base64url 32-byte key");
    if (typeof o.subject !== "string" || !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(o.subject)) {
      throw new Error("defineWebPush: subject is a mailto: address or an https URL");
    }
    const hosts = [...PUSH_SERVICES];
    for (const h of o.allowHosts ?? []) {
      if (typeof h !== "string" || !HOST_RE.test(h)) throw new Error(`defineWebPush: allowHosts takes host names: ${JSON.stringify(h)}`);
      hosts.push(h);
    }
    const max = o.maxPerUser ?? 10;
    if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error("defineWebPush: maxPerUser is 1-50");
    const ttl = o.ttlSeconds ?? 86_400;
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 28 * 86_400) throw new Error("defineWebPush: ttlSeconds is 0-28 days");
    this.publicKey = o.publicKey;
    this.#privateKey = o.privateKey;
    this.#o = {
      subject: o.subject,
      store: o.store ?? new MemoryPushStore(),
      hosts,
      max,
      ttl,
      fetch: o.fetch ?? ((i, init) => fetch(i, init)),
      timeoutMs: o.timeoutMs ?? 15_000,
      now: o.now ?? Date.now,
    };
  }

  allowedEndpoint(endpoint: unknown): endpoint is string {
    if (typeof endpoint !== "string" || endpoint.length > 2048 || /[\x00-\x20\x7f]/.test(endpoint)) return false;
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      return false;
    }
    if (u.protocol !== "https:" || u.port !== "" || u.username || u.password || u.hash) return false;
    const host = u.hostname.toLowerCase();
    if (!HOST_RE.test(host)) return false;
    return this.#o.hosts.some((h) => host === h || host.endsWith(`.${h}`));
  }

  #parse(input: unknown): { endpoint: string; p256dh: string; auth: string } {
    let v = input;
    if (typeof v === "string") {
      if (v.length > 4096) throw new PushError("subscription too large", true);
      try {
        v = JSON.parse(v);
      } catch {
        throw new PushError("not a push subscription", true);
      }
    }
    const s = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
    if (!s || typeof s !== "object" || !this.allowedEndpoint(s.endpoint)) throw new PushError("not an allowed push endpoint", true);
    const p256dh = s.keys?.p256dh;
    const auth = s.keys?.auth;
    try {
      if (typeof p256dh !== "string" || typeof auth !== "string") throw new Error();
      pointJwk(fromB64url(p256dh));
      if (fromB64url(auth).length !== 16) throw new Error();
    } catch {
      throw new PushError("not a push subscription: keys.p256dh is a P-256 point, keys.auth 16 bytes", true);
    }
    return { endpoint: s.endpoint, p256dh, auth };
  }

  async subscribe(ctx: PageContext, subscription: unknown): Promise<void> {
    const s = await authState(ctx);
    if (!s || s.pending) throw new PushError("sign in to turn on notifications", true);
    const sub = this.#parse(subscription);
    const store = this.#o.store;
    await store.remove(sub.endpoint);
    this.#lastCreated = Math.max(this.#o.now(), this.#lastCreated + 1);
    await store.add({ ...sub, user: s.user, created: this.#lastCreated });
    const mine = await store.forUser(s.user);
    for (const old of mine.sort((a, b) => a.created - b.created || (a.endpoint < b.endpoint ? -1 : 1)).slice(0, Math.max(0, mine.length - this.#o.max))) {
      await store.remove(old.endpoint, s.user);
    }
  }

  async unsubscribe(ctx: PageContext, endpoint: string): Promise<boolean> {
    const s = await authState(ctx);
    if (!s || s.pending || typeof endpoint !== "string") return false;
    return this.#o.store.remove(endpoint, s.user);
  }

  async forget(user: string): Promise<number> {
    let n = 0;
    for (const r of await this.#o.store.forUser(user)) if (await this.#o.store.remove(r.endpoint, user)) n++;
    return n;
  }

  async #key(): Promise<CryptoKey> {
    this.#signing ??= (async () => {
      const d = isSecret(this.#privateKey) ? this.#privateKey.reveal() : this.#privateKey;
      const { x, y } = pointJwk(fromB64url(this.publicKey));
      return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d, x, y, ext: false }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    })();
    return this.#signing;
  }

  async authorization(endpoint: string): Promise<string> {
    const aud = new URL(endpoint).origin;
    const enc = (o: object) => b64url(utf8.encode(JSON.stringify(o)));
    const input = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud, exp: Math.floor(this.#o.now() / 1000) + 12 * 3600, sub: this.#o.subject })}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await this.#key(), utf8.encode(input)));
    return `vapid t=${input}.${b64url(sig)}, k=${this.publicKey}`;
  }

  async send(user: string, message: PushMessage): Promise<PushResult> {
    const payload = pushPayload(message);
    const result: PushResult = { sent: 0, removed: 0, failed: 0 };
    let transient: PushError | null = null;
    for (const sub of await this.#o.store.forUser(user)) {
      if (!this.allowedEndpoint(sub.endpoint)) {
        await this.#o.store.remove(sub.endpoint, user);
        result.removed++;
        continue;
      }
      try {
        const body = await encryptPushPayload(payload, { p256dh: fromB64url(sub.p256dh), auth: fromB64url(sub.auth) });
        const res = await this.#o.fetch(sub.endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(this.#o.timeoutMs),
          headers: {
            authorization: await this.authorization(sub.endpoint),
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: String(this.#o.ttl),
            urgency: message.urgency ?? "normal",
          },
          body,
        });
        await res.body?.cancel().catch(() => {});
        if (res.status === 404 || res.status === 410) {
          await this.#o.store.remove(sub.endpoint, user);
          result.removed++;
        } else if (res.ok) {
          result.sent++;
        } else {
          result.failed++;
          if (res.status === 429 || res.status >= 500) transient = new PushError(`push service: HTTP ${res.status}`, false);
        }
      } catch (err) {
        result.failed++;
        transient = new PushError(`push service: ${err instanceof Error ? err.message : String(err)}`, false, err);
      }
    }
    if (result.sent === 0 && transient) throw transient;
    return result;
  }

  channel(label = "Push"): { label: string; send(d: { user: string; notification: { title: string; body: string; url: string | null; type: string } }): Promise<PushResult> } {
    return {
      label,
      send: ({ user, notification: n }) =>
        this.send(user, { title: n.title, body: n.body, ...(n.url && n.url.startsWith("/") ? { url: n.url } : {}), tag: n.type }),
    };
  }

  worker(): Response {
    return new Response(PUSH_WORKER_JS, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  }
}

function pushPayload(m: PushMessage): Bytes {
  if (!m || typeof m.title !== "string" || m.title === "" || m.title.length > 200 || CONTROL_RE.test(m.title) || /[\r\n]/.test(m.title)) {
    throw new PushError("title is one line of 1-200 characters", true);
  }
  const body = m.body ?? "";
  if (typeof body !== "string" || body.length > 1000 || CONTROL_RE.test(body)) throw new PushError("body is at most 1000 characters", true);
  if (m.url !== undefined && (typeof m.url !== "string" || !m.url.startsWith("/") || m.url.startsWith("//") || /[\s\\]/.test(m.url) || m.url.length > 1000)) {
    throw new PushError("url is a path on this site", true);
  }
  if (m.tag !== undefined && (typeof m.tag !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(m.tag))) throw new PushError("tag is [A-Za-z0-9._:-]{1,64}", true);
  if (m.urgency !== undefined && !["very-low", "low", "normal", "high"].includes(m.urgency)) throw new PushError("urgency is very-low, low, normal or high", true);
  const bytes = utf8.encode(JSON.stringify({ title: m.title, body, url: m.url ?? "/", ...(m.tag ? { tag: m.tag } : {}) }));
  if (bytes.length > 3072) throw new PushError("the message is over 3 KiB", true);
  return bytes;
}

export function defineWebPush(o: WebPushOptions): WebPush {
  return new WebPush(o);
}

export const PUSH_WORKER_JS = `// Weft push worker (generated by @weft/server).
self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = {};
  }
  const title = typeof d.title === "string" && d.title ? d.title : "Notification";
  const options = { body: typeof d.body === "string" ? d.body : "", data: { url: typeof d.url === "string" ? d.url : "/" } };
  if (typeof d.tag === "string") options.tag = d.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let url = new URL("/", self.location.origin).href;
  try {
    const u = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
    if (u.origin === self.location.origin) url = u.href;
  } catch {
    // keep the site root
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if (c.url === url && "focus" in c) return c.focus();
      return self.clients.openWindow(url);
    }),
  );
});
`;
