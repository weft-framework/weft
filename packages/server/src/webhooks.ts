import type { SqlDatabase } from "@weft-framework/data";
import { defineJob, JobError, type Job, type Jobs } from "./jobs.ts";
import { isSecret, type Secret } from "./secret.ts";
import { MIN_SECRET_LENGTH } from "./security.ts";

type Bytes = Uint8Array<ArrayBuffer>;
const utf8 = new TextEncoder();

export interface WebhookEndpoint {
  id: string;
  owner: string;
  url: string;
  events: string[];
  description: string;
  enabled: boolean;
  disabledReason: string | null;
  created: number;
  failures: number;
}

interface StoredEndpoint extends WebhookEndpoint {
  secret: string;
  previous: { secret: string; until: number } | null;
}

export interface WebhookMessage {
  id: string;
  owner: string;
  event: string;
  body: string;
  created: number;
}

export interface WebhookAttempt {
  at: number;
  status: number | null;
  durationMs: number;
  error: string | null;
  response: string;
}

export type DeliveryStatus = "pending" | "succeeded" | "failed";

export interface WebhookDelivery {
  id: string;
  owner: string;
  message: string;
  endpoint: string;
  event: string;
  status: DeliveryStatus;
  attempts: WebhookAttempt[];
  created: number;
  updated: number;
}

export type WebhookKind = "endpoint" | "message" | "delivery";

export interface WebhookStore {
  put(kind: WebhookKind, id: string, owner: string, ref: string | null, created: number, data: string): void | Promise<void>;
  get(kind: WebhookKind, id: string): string | null | Promise<string | null>;
  list(kind: WebhookKind, owner: string, o: { ref?: string; limit: number; before?: number }): string[] | Promise<string[]>;
  remove(kind: WebhookKind, id: string): void | Promise<void>;
  sweep(kind: WebhookKind, before: number, owner?: string): number | Promise<number>;
}

interface Doc {
  kind: WebhookKind;
  id: string;
  owner: string;
  ref: string | null;
  created: number;
  seq: number;
  data: string;
}

export class MemoryWebhookStore implements WebhookStore {
  readonly #docs = new Map<string, Doc>();
  #seq = 0;
  put(kind: WebhookKind, id: string, owner: string, ref: string | null, created: number, data: string): void {
    const k = `${kind}:${id}`;
    const seq = this.#docs.get(k)?.seq ?? ++this.#seq;
    this.#docs.set(k, { kind, id, owner, ref, created, seq, data });
  }
  get(kind: WebhookKind, id: string): string | null {
    return this.#docs.get(`${kind}:${id}`)?.data ?? null;
  }
  list(kind: WebhookKind, owner: string, o: { ref?: string; limit: number; before?: number }): string[] {
    return [...this.#docs.values()]
      .filter((d) => d.kind === kind && d.owner === owner && (o.ref === undefined || d.ref === o.ref) && (o.before === undefined || d.created < o.before))
      .sort((a, b) => b.created - a.created || b.seq - a.seq)
      .slice(0, o.limit)
      .map((d) => d.data);
  }
  remove(kind: WebhookKind, id: string): void {
    this.#docs.delete(`${kind}:${id}`);
  }
  sweep(kind: WebhookKind, before: number, owner?: string): number {
    let n = 0;
    for (const [k, d] of this.#docs) {
      if (d.kind === kind && d.created < before && (owner === undefined || d.owner === owner)) {
        this.#docs.delete(k);
        n++;
      }
    }
    return n;
  }
}

export class SqlWebhookStore implements WebhookStore {
  readonly #db: SqlDatabase;
  readonly #t: string;

  constructor(db: SqlDatabase, table = "weft_webhooks") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`@weft-framework/server: not a valid table name: ${table}`);
    this.#db = db;
    this.#t = `"${table}"`;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#t} (kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, ref TEXT, ` +
        `created INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id))`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_owner" ON ${this.#t} (kind, owner, created)`);
  }
  put(kind: WebhookKind, id: string, owner: string, ref: string | null, created: number, data: string): void {
    this.#db
      .prepare(
        `INSERT INTO ${this.#t} (kind, id, owner, ref, created, data) VALUES (?, ?, ?, ?, ?, ?) ` +
          `ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data`,
      )
      .run(kind, id, owner, ref, created, data);
  }
  get(kind: WebhookKind, id: string): string | null {
    const r = this.#db.prepare(`SELECT data FROM ${this.#t} WHERE kind = ? AND id = ?`).all(kind, id)[0] as { data: string } | undefined;
    return r ? String(r.data) : null;
  }
  list(kind: WebhookKind, owner: string, o: { ref?: string; limit: number; before?: number }): string[] {
    const where = ["kind = ?", "owner = ?"];
    const args: (string | number)[] = [kind, owner];
    if (o.ref !== undefined) (where.push("ref = ?"), args.push(o.ref));
    if (o.before !== undefined) (where.push("created < ?"), args.push(o.before));
    const rows = this.#db
      .prepare(`SELECT data FROM ${this.#t} WHERE ${where.join(" AND ")} ORDER BY created DESC, rowid DESC LIMIT ?`)
      .all(...args, o.limit) as { data: string }[];
    return rows.map((r) => String(r.data));
  }
  remove(kind: WebhookKind, id: string): void {
    this.#db.prepare(`DELETE FROM ${this.#t} WHERE kind = ? AND id = ?`).run(kind, id);
  }
  sweep(kind: WebhookKind, before: number, owner?: string): number {
    const r = owner === undefined
      ? this.#db.prepare(`DELETE FROM ${this.#t} WHERE kind = ? AND created < ? RETURNING id`).all(kind, before)
      : this.#db.prepare(`DELETE FROM ${this.#t} WHERE kind = ? AND created < ? AND owner = ? RETURNING id`).all(kind, before, owner);
    return r.length;
  }
}

function v4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((x) => x <= 255) ? p : null;
}

function v4Public(p: number[]): boolean {
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.includes("%")) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = v4Parts(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    s = s.slice(0, lastColon + 1) + "0";
    s = s.endsWith("::0") ? s.slice(0, -1) : s.slice(0, -2);
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === "" ? [] : h.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]!);
  const back = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...back].some(Number.isNaN)) return null;
  const want = 8 - tail.length;
  if (halves.length === 1) {
    if (head.length !== want) return null;
    return [...head, ...tail];
  }
  const fill = want - head.length - back.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...back, ...tail];
}

export function isPublicAddress(ip: string): boolean {
  if (typeof ip !== "string") return false;
  const v4 = v4Parts(ip);
  if (v4) return v4Public(v4);
  const g = v6Groups(ip);
  if (!g) return false;
  const embedded = () => [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return g[5] === 0xffff ? v4Public(embedded()) : false;
  }
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1]! < 0x200) return false;
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false;
  if (g[0] === 0x2002) return false;
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false;
  return true;
}

function isIpLiteral(host: string): boolean {
  return v4Parts(host) !== null || v6Groups(host) !== null;
}

export class WebhookError extends Error {
  readonly code: "invalid" | "not-found" | "limit" | "address";
  constructor(code: WebhookError["code"], message: string) {
    super(message);
    this.name = "WebhookError";
    this.code = code;
  }
}

function b64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function fromB64(s: string): Bytes {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function secretBytes(secret: string): Bytes {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new WebhookError("invalid", "a webhook secret starts with whsec_");
  const b = fromB64(secret.slice(6));
  if (b.length < 16 || b.length > 64) throw new WebhookError("invalid", "a webhook secret is 16 to 64 bytes");
  return b;
}

async function hmac(secret: string, content: string): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", secretBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(content)));
}

export async function signWebhook(secrets: readonly string[], id: string, timestamp: number, body: string): Promise<string> {
  const parts: string[] = [];
  for (const s of secrets) parts.push(`v1,${b64(await hmac(s, `${id}.${timestamp}.${body}`))}`);
  return parts.join(" ");
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export async function verifyWebhook(
  secret: string,
  headers: Headers | Record<string, string | undefined>,
  body: string,
  o: { toleranceSec?: number; now?: number } = {},
): Promise<unknown> {
  const h = (n: string) => (headers instanceof Headers ? headers.get(n) : (headers[n] ?? null)) ?? null;
  const id = h("webhook-id");
  const ts = h("webhook-timestamp");
  const sig = h("webhook-signature");
  if (!id || !ts || !sig || !/^\d{1,12}$/.test(ts)) throw new WebhookError("invalid", "missing webhook headers");
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  if (Math.abs(now - Number(ts)) > (o.toleranceSec ?? 300)) throw new WebhookError("invalid", "webhook timestamp too far from now");
  const want = await hmac(secret, `${id}.${ts}.${body}`);
  let ok = false;
  for (const entry of sig.split(" ")) {
    const [v, s] = entry.split(",", 2);
    if (v !== "v1" || !s) continue;
    let got: Uint8Array;
    try {
      got = fromB64(s);
    } catch {
      continue;
    }
    if (equal(got, want)) ok = true;
  }
  if (!ok) throw new WebhookError("invalid", "webhook signature does not match");
  return JSON.parse(body);
}

function newSecret(): string {
  return `whsec_${b64(crypto.getRandomValues(new Uint8Array(24)))}`;
}

function randomId(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookResponse {
  status: number;
  body: string;
}

export type WebhookTransport = (req: WebhookRequest) => Promise<WebhookResponse>;

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

const RESPONSE_LIMIT = 2048;

export function nodeTransport(o: { allowPrivateNetworks?: boolean; lookup?: Lookup } = {}): WebhookTransport {
  return async (req) => {
    const u = new URL(req.url);
    const mod = u.protocol === "https:" ? await import("node:https") : await import("node:http");
    const dns = await import("node:dns");
    const resolve: Lookup = o.lookup ?? ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (isIpLiteral(host) && !o.allowPrivateNetworks && !isPublicAddress(host)) {
      throw new WebhookError("address", `${host} is not a public address`);
    }
    type Cb = (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void;
    const lookup = (hostname: string, opts: { all?: boolean } | number, cb: Cb) => {
      resolve(hostname).then(
        (addrs) => {
          if (addrs.length === 0) return cb(new WebhookError("address", `${hostname} does not resolve`), "");
          const bad = addrs.find((a) => !isPublicAddress(a.address));
          if (bad && !o.allowPrivateNetworks) {
            return cb(new WebhookError("address", `${hostname} resolves to ${bad.address}, not a public address`), "");
          }
          if (typeof opts === "object" && opts.all) return cb(null, addrs);
          cb(null, addrs[0]!.address, addrs[0]!.family);
        },
        (err: Error) => cb(err, ""),
      );
    };
    return new Promise<WebhookResponse>((resolveRes, reject) => {
      const r = mod.request(
        u,
        {
          method: "POST",
          headers: { ...req.headers, "content-length": String(Buffer.byteLength(req.body)) },
          lookup: lookup as never,
          timeout: req.timeoutMs,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const done = () => resolveRes({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8").slice(0, RESPONSE_LIMIT) });
          res.on("data", (c: Buffer) => {
            if (size < RESPONSE_LIMIT) chunks.push(c.subarray(0, RESPONSE_LIMIT - size));
            size += c.length;
            if (size >= RESPONSE_LIMIT) {
              done();
              res.destroy();
            }
          });
          res.on("end", done);
          res.on("error", () => done());
        },
      );
      const timer = setTimeout(() => r.destroy(new Error(`timed out after ${req.timeoutMs} ms`)), req.timeoutMs);
      r.on("timeout", () => r.destroy(new Error(`timed out after ${req.timeoutMs} ms`)));
      r.on("error", (e) => (clearTimeout(timer), reject(e)));
      r.on("close", () => clearTimeout(timer));
      r.end(req.body);
    });
  };
}

const EVENT_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,4}$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const DEFAULT_SCHEDULE = [5_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 5 * 3600_000, 10 * 3600_000, 10 * 3600_000];

export interface WebhooksOptions<E extends string> {
  events: readonly E[];
  key: string | Secret;
  store?: WebhookStore;
  jobs: () => Jobs;
  transport?: WebhookTransport;
  lookup?: Lookup;
  retrySchedule?: readonly number[];
  timeoutMs?: number;
  disableAfter?: number;
  maxEndpoints?: number;
  maxBytes?: number;
  keepMs?: number;
  allowInsecure?: boolean;
  allowPrivateNetworks?: boolean;
  jobName?: string;
  onError?(err: unknown): void;
  now?(): number;
}

export interface EndpointInput<E extends string> {
  url: string;
  events: readonly (E | "*")[];
  description?: string;
}

export class Webhooks<E extends string = string> {
  readonly job: Job<[string]>;
  readonly events: readonly E[];
  readonly #store: WebhookStore;
  readonly #o: {
    jobs: () => Jobs;
    transport: WebhookTransport;
    lookup: Lookup | undefined;
    timeoutMs: number;
    disableAfter: number;
    maxEndpoints: number;
    maxBytes: number;
    keepMs: number;
    allowInsecure: boolean;
    allowPrivate: boolean;
    onError: (err: unknown) => void;
    now: () => number;
  };
  readonly #keyText: string;
  #aes: Promise<CryptoKey> | null = null;

  constructor(o: WebhooksOptions<E>) {
    const fail = (m: string): never => {
      throw new Error(`defineWebhooks: ${m}`);
    };
    if (!Array.isArray(o.events) || o.events.length === 0) fail("events lists the event types");
    const seen = new Set<string>();
    for (const e of o.events) {
      if (typeof e !== "string" || e.length > 64 || !EVENT_RE.test(e)) fail(`not an event type (a.b_c, lower case): ${JSON.stringify(e)}`);
      if (seen.has(e)) fail(`event ${e} is listed twice`);
      seen.add(e);
    }
    const key = isSecret(o.key) ? o.key.reveal() : o.key;
    if (typeof key !== "string" || key.length < MIN_SECRET_LENGTH) fail(`key must be at least ${MIN_SECRET_LENGTH} characters`);
    if (typeof o.jobs !== "function") fail("jobs is a function returning the queue");
    const schedule = o.retrySchedule ?? DEFAULT_SCHEDULE;
    if (!Array.isArray(schedule) || schedule.length > 30 || schedule.some((ms) => !Number.isInteger(ms) || ms < 0 || ms > 7 * 24 * 3600_000)) {
      fail("retrySchedule is up to 30 waits of 0 ms to 7 days");
    }
    const int = (what: string, v: number, lo: number, hi: number) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fail(`${what} is ${lo} to ${hi}`));
    this.events = Object.freeze([...o.events]);
    this.#keyText = key;
    this.#store = o.store ?? new MemoryWebhookStore();
    const allowPrivate = o.allowPrivateNetworks === true;
    const lookup = o.lookup;
    this.#o = {
      jobs: o.jobs,
      transport: o.transport ?? nodeTransport({ allowPrivateNetworks: allowPrivate, ...(lookup ? { lookup } : {}) }),
      lookup,
      timeoutMs: int("timeoutMs", o.timeoutMs ?? 15_000, 1000, 60_000),
      disableAfter: int("disableAfter", o.disableAfter ?? 20, 1, 1000),
      maxEndpoints: int("maxEndpoints", o.maxEndpoints ?? 20, 1, 100),
      maxBytes: int("maxBytes", o.maxBytes ?? 256 * 1024, 1024, 1024 * 1024),
      keepMs: int("keepMs", o.keepMs ?? 30 * 24 * 3600_000, 3600_000, 365 * 24 * 3600_000),
      allowInsecure: o.allowInsecure === true,
      allowPrivate,
      onError: o.onError ?? ((err) => console.error("[weft] webhook:", err)),
      now: o.now ?? Date.now,
    };
    const waits = [...schedule];
    this.job = defineJob<[string]>(
      o.jobName ?? "weftWebhook",
      [{ name: "delivery", type: "string" }],
      (ctx, delivery) => this.#attempt(delivery, ctx.job.attempt, ctx.job.maxAttempts),
      { attempts: waits.length + 1, backoff: (attempt) => waits[attempt - 1] ?? waits[waits.length - 1] ?? 0, timeoutMs: this.#o.timeoutMs + 30_000 },
    );
  }

  async #key(): Promise<CryptoKey> {
    this.#aes ??= (async () => {
      const base = await crypto.subtle.importKey("raw", utf8.encode(this.#keyText), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: utf8.encode("weft webhooks"), info: utf8.encode("endpoint secret") },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    return this.#aes;
  }

  async #seal(secret: string, endpoint: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(endpoint) }, await this.#key(), utf8.encode(secret)));
    return `v1.${b64(iv)}.${b64(ct)}`;
  }

  async #open(sealed: string, endpoint: string): Promise<string> {
    const [v, iv, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !ct) throw new Error("webhooks: unreadable stored secret");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv), additionalData: utf8.encode(endpoint) }, await this.#key(), fromB64(ct));
    return new TextDecoder().decode(pt);
  }

  #owner(owner: unknown): string {
    if (typeof owner !== "string" || owner === "" || owner.length > 256 || CONTROL_RE.test(owner)) throw new WebhookError("invalid", "owner is a non-empty id");
    return owner;
  }

  #events(events: unknown): string[] {
    if (!Array.isArray(events) || events.length === 0) throw new WebhookError("invalid", 'events lists event types, or ["*"]');
    if (events.includes("*")) {
      if (events.length !== 1) throw new WebhookError("invalid", '"*" stands alone');
      return ["*"];
    }
    const out = new Set<string>();
    for (const e of events) {
      if (!(this.events as readonly unknown[]).includes(e)) throw new WebhookError("invalid", `not an event type: ${JSON.stringify(e)}`);
      out.add(e as string);
    }
    return [...out];
  }

  async checkUrl(url: unknown): Promise<string> {
    if (typeof url !== "string" || url.length > 2048 || /[\x00-\x20\x7f]/.test(url)) throw new WebhookError("invalid", "url is an https URL");
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new WebhookError("invalid", "url is an https URL");
    }
    if (u.protocol !== "https:" && !(this.#o.allowInsecure && u.protocol === "http:")) throw new WebhookError("invalid", "url is an https URL");
    if (u.username || u.password) throw new WebhookError("invalid", "url carries no user name or password");
    if (u.hash) throw new WebhookError("invalid", "url has no #fragment");
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (this.#o.allowPrivate) return u.href;
    if (isIpLiteral(host)) {
      if (!isPublicAddress(host)) throw new WebhookError("address", `${host} is not a public address`);
      return u.href;
    }
    if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost") {
      throw new WebhookError("address", `${host} is not a public host name`);
    }
    let addrs: { address: string }[];
    try {
      addrs = this.#o.lookup ? await this.#o.lookup(host) : await (await import("node:dns")).promises.lookup(host, { all: true, verbatim: true });
    } catch {
      throw new WebhookError("address", `${host} does not resolve`);
    }
    if (addrs.length === 0) throw new WebhookError("address", `${host} does not resolve`);
    const bad = addrs.find((a) => !isPublicAddress(a.address));
    if (bad) throw new WebhookError("address", `${host} resolves to ${bad.address}, not a public address`);
    return u.href;
  }

  async #endpoint(owner: string, id: unknown): Promise<StoredEndpoint> {
    const raw = typeof id === "string" && id.length <= 64 ? await this.#store.get("endpoint", id) : null;
    const ep = raw ? (JSON.parse(raw) as StoredEndpoint) : null;
    if (!ep || ep.owner !== owner) throw new WebhookError("not-found", "no such endpoint");
    return ep;
  }

  async #save(ep: StoredEndpoint): Promise<void> {
    await this.#store.put("endpoint", ep.id, ep.owner, null, ep.created, JSON.stringify(ep));
  }

  #public(ep: StoredEndpoint): WebhookEndpoint {
    const { secret: _s, previous: _p, ...rest } = ep;
    return { ...rest, events: [...rest.events] };
  }

  async createEndpoint(owner: string, input: EndpointInput<E>): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    this.#owner(owner);
    const url = await this.checkUrl(input?.url);
    const events = this.#events(input.events);
    const description = this.#description(input.description);
    const mine = await this.#store.list("endpoint", owner, { limit: this.#o.maxEndpoints + 1 });
    if (mine.length >= this.#o.maxEndpoints) throw new WebhookError("limit", `at most ${this.#o.maxEndpoints} endpoints`);
    const id = randomId("ep_");
    const secret = newSecret();
    const ep: StoredEndpoint = {
      id,
      owner,
      url,
      events,
      description,
      enabled: true,
      disabledReason: null,
      created: this.#o.now(),
      failures: 0,
      secret: await this.#seal(secret, id),
      previous: null,
    };
    await this.#save(ep);
    return { endpoint: this.#public(ep), secret };
  }

  #description(d: unknown): string {
    if (d === undefined) return "";
    if (typeof d !== "string" || d.length > 500 || CONTROL_RE.test(d.replace(/\n/g, ""))) throw new WebhookError("invalid", "description is at most 500 characters");
    return d;
  }

  async endpoints(owner: string): Promise<WebhookEndpoint[]> {
    this.#owner(owner);
    return (await this.#store.list("endpoint", owner, { limit: 1000 })).map((r) => this.#public(JSON.parse(r) as StoredEndpoint));
  }

  async endpoint(owner: string, id: string): Promise<WebhookEndpoint | null> {
    this.#owner(owner);
    try {
      return this.#public(await this.#endpoint(owner, id));
    } catch (err) {
      if (err instanceof WebhookError && err.code === "not-found") return null;
      throw err;
    }
  }

  async updateEndpoint(
    owner: string,
    id: string,
    patch: { url?: string; events?: readonly (E | "*")[]; description?: string; enabled?: boolean },
  ): Promise<WebhookEndpoint> {
    this.#owner(owner);
    const ep = await this.#endpoint(owner, id);
    if (patch.url !== undefined) ep.url = await this.checkUrl(patch.url);
    if (patch.events !== undefined) ep.events = this.#events(patch.events);
    if (patch.description !== undefined) ep.description = this.#description(patch.description);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") throw new WebhookError("invalid", "enabled is a boolean");
      ep.enabled = patch.enabled;
      ep.disabledReason = null;
      if (patch.enabled) ep.failures = 0;
    }
    await this.#save(ep);
    return this.#public(ep);
  }

  async revealSecret(owner: string, id: string): Promise<string> {
    this.#owner(owner);
    const ep = await this.#endpoint(owner, id);
    return this.#open(ep.secret, ep.id);
  }

  async rotateSecret(owner: string, id: string, o: { keepOldMs?: number } = {}): Promise<string> {
    this.#owner(owner);
    const keep = o.keepOldMs ?? 24 * 3600_000;
    if (!Number.isInteger(keep) || keep < 0 || keep > 7 * 24 * 3600_000) throw new WebhookError("invalid", "keepOldMs is 0 to 7 days");
    const ep = await this.#endpoint(owner, id);
    const secret = newSecret();
    ep.previous = keep > 0 ? { secret: ep.secret, until: this.#o.now() + keep } : null;
    ep.secret = await this.#seal(secret, ep.id);
    await this.#save(ep);
    return secret;
  }

  async removeEndpoint(owner: string, id: string): Promise<boolean> {
    this.#owner(owner);
    try {
      await this.#endpoint(owner, id);
    } catch {
      return false;
    }
    await this.#store.remove("endpoint", id);
    for (;;) {
      const batch = await this.#store.list("delivery", owner, { ref: id, limit: 500 });
      if (batch.length === 0) break;
      for (const r of batch) await this.#store.remove("delivery", (JSON.parse(r) as WebhookDelivery).id);
    }
    return true;
  }

  async emit(owner: string, event: E, data: unknown): Promise<string | null> {
    this.#owner(owner);
    if (!(this.events as readonly string[]).includes(event)) throw new WebhookError("invalid", `not an event type: ${JSON.stringify(event)}`);
    const now = this.#o.now();
    let body: string;
    try {
      body = JSON.stringify({ type: event, timestamp: new Date(now).toISOString(), data: data ?? null });
    } catch (err) {
      throw new WebhookError("invalid", `event data is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (utf8.encode(body).length > this.#o.maxBytes) throw new WebhookError("invalid", `event data is over ${this.#o.maxBytes} bytes`);
    const targets = (await this.#store.list("endpoint", owner, { limit: 1000 }))
      .map((r) => JSON.parse(r) as StoredEndpoint)
      .filter((ep) => ep.enabled && (ep.events.includes("*") || ep.events.includes(event)));
    if (targets.length === 0) return null;
    const msg: WebhookMessage = { id: randomId("msg_"), owner, event, body, created: now };
    await this.#store.put("message", msg.id, owner, null, now, JSON.stringify(msg));
    for (const ep of targets) {
      const d: WebhookDelivery = { id: randomId("dlv_"), owner, message: msg.id, endpoint: ep.id, event, status: "pending", attempts: [], created: now, updated: now };
      await this.#store.put("delivery", d.id, owner, ep.id, now, JSON.stringify(d));
      await this.#o.jobs().enqueue(null, this.job as never, { delivery: d.id }, { as: null, key: `webhook:${d.id}` });
    }
    return msg.id;
  }

  async #delivery(id: string): Promise<WebhookDelivery | null> {
    const raw = typeof id === "string" && id.length <= 64 ? await this.#store.get("delivery", id) : null;
    return raw ? (JSON.parse(raw) as WebhookDelivery) : null;
  }

  async #put(d: WebhookDelivery): Promise<void> {
    await this.#store.put("delivery", d.id, d.owner, d.endpoint, d.created, JSON.stringify(d));
  }

  async deliveries(owner: string, f: { endpoint?: string; status?: DeliveryStatus; limit?: number; before?: number } = {}): Promise<WebhookDelivery[]> {
    this.#owner(owner);
    const limit = Math.min(Math.max(1, Math.floor(f.limit ?? 50)), 500);
    const out: WebhookDelivery[] = [];
    let before = f.before;
    while (out.length < limit) {
      const batch = (await this.#store.list("delivery", owner, { ...(f.endpoint !== undefined ? { ref: f.endpoint } : {}), limit: 500, ...(before !== undefined ? { before } : {}) })).map(
        (r) => JSON.parse(r) as WebhookDelivery,
      );
      for (const d of batch) if (f.status === undefined || d.status === f.status) out.push(d);
      if (batch.length < 500 || f.status === undefined) break;
      before = batch[batch.length - 1]!.created;
    }
    return out.slice(0, limit);
  }

  async delivery(owner: string, id: string): Promise<(WebhookDelivery & { body: string | null }) | null> {
    this.#owner(owner);
    const d = await this.#delivery(id);
    if (!d || d.owner !== owner) return null;
    const msg = await this.#store.get("message", d.message);
    return { ...d, body: msg ? (JSON.parse(msg) as WebhookMessage).body : null };
  }

  async replay(owner: string, id: string): Promise<boolean> {
    this.#owner(owner);
    const d = await this.#delivery(id);
    if (!d || d.owner !== owner || d.status === "pending") return false;
    if (!(await this.#store.get("message", d.message))) return false;
    const raw = await this.#store.get("endpoint", d.endpoint);
    const ep = raw ? (JSON.parse(raw) as StoredEndpoint) : null;
    if (!ep || ep.owner !== owner || !ep.enabled) return false;
    d.status = "pending";
    d.updated = this.#o.now();
    await this.#put(d);
    const queued = await this.#o.jobs().enqueue(null, this.job as never, { delivery: d.id }, { as: null, key: `webhook:${d.id}` });
    return queued !== false;
  }

  async #attempt(id: string, attempt: number, maxAttempts: number): Promise<void> {
    const d = await this.#delivery(id);
    if (!d || d.status !== "pending") return;
    const final = attempt >= maxAttempts;
    const rawEp = await this.#store.get("endpoint", d.endpoint);
    const ep = rawEp ? (JSON.parse(rawEp) as StoredEndpoint) : null;
    const rawMsg = await this.#store.get("message", d.message);
    if (!ep || ep.owner !== d.owner || !ep.enabled || !rawMsg) {
      d.status = "failed";
      d.attempts.push({ at: this.#o.now(), status: null, durationMs: 0, error: !ep ? "endpoint removed" : !rawMsg ? "message pruned" : "endpoint disabled", response: "" });
      d.updated = this.#o.now();
      await this.#put(d);
      return;
    }
    const msg = JSON.parse(rawMsg) as WebhookMessage;
    const start = this.#o.now();
    const ts = Math.floor(start / 1000);
    let secrets: string[];
    try {
      secrets = [await this.#open(ep.secret, ep.id)];
      if (ep.previous && ep.previous.until > start) secrets.push(await this.#open(ep.previous.secret, ep.id));
    } catch (err) {
      this.#o.onError(err);
      d.status = "failed";
      d.attempts.push({ at: start, status: null, durationMs: 0, error: "the endpoint's signing secret cannot be read", response: "" });
      d.updated = this.#o.now();
      await this.#put(d);
      return;
    }
    const rec: WebhookAttempt = { at: start, status: null, durationMs: 0, error: null, response: "" };
    try {
      await this.checkUrl(ep.url);
      const res = await this.#o.transport({
        url: ep.url,
        timeoutMs: this.#o.timeoutMs,
        body: msg.body,
        headers: {
          "content-type": "application/json",
          "user-agent": "Weft-Webhooks/1",
          "webhook-id": msg.id,
          "webhook-timestamp": String(ts),
          "webhook-signature": await signWebhook(secrets, msg.id, ts, msg.body),
        },
      });
      rec.status = res.status;
      rec.response = String(res.body ?? "").slice(0, RESPONSE_LIMIT);
      if (res.status < 200 || res.status > 299) rec.error = `HTTP ${res.status}`;
    } catch (err) {
      rec.error = err instanceof Error ? err.message : String(err);
    }
    rec.durationMs = Math.max(0, this.#o.now() - start);
    d.attempts.push(rec);
    if (d.attempts.length > 50) d.attempts.splice(0, d.attempts.length - 50);
    d.updated = this.#o.now();
    const ok = rec.error === null;
    if (ok || final) d.status = ok ? "succeeded" : "failed";
    await this.#put(d);
    if (ok || final) await this.#settle(ep.id, ok);
    if (!ok && !final) throw new JobError(`webhook ${d.id}: ${rec.error}`);
  }

  async #settle(endpoint: string, ok: boolean): Promise<void> {
    const raw = await this.#store.get("endpoint", endpoint);
    if (!raw) return;
    const ep = JSON.parse(raw) as StoredEndpoint;
    if (ok) {
      if (ep.failures === 0) return;
      ep.failures = 0;
    } else {
      ep.failures++;
      if (ep.failures >= this.#o.disableAfter && ep.enabled) {
        ep.enabled = false;
        ep.disabledReason = `${ep.failures} deliveries in a row failed`;
      }
    }
    try {
      await this.#save(ep);
    } catch (err) {
      this.#o.onError(err);
    }
  }

  async prune(owner?: string): Promise<number> {
    const before = this.#o.now() - this.#o.keepMs;
    if (owner !== undefined) this.#owner(owner);
    return (await this.#store.sweep("delivery", before, owner)) + (await this.#store.sweep("message", before, owner));
  }

  async forget(owner: string): Promise<number> {
    this.#owner(owner);
    let n = 0;
    for (const ep of await this.endpoints(owner)) if (await this.removeEndpoint(owner, ep.id)) n++;
    await this.#store.sweep("delivery", Number.MAX_SAFE_INTEGER, owner);
    await this.#store.sweep("message", Number.MAX_SAFE_INTEGER, owner);
    return n;
  }
}

export function defineWebhooks<const E extends string>(o: WebhooksOptions<E>): Webhooks<E> {
  return new Webhooks<E>(o);
}
