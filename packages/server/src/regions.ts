import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Change, Model } from "@weft-framework/data";
import type { SessionRecord, SessionStore } from "./auth.ts";

type Revealable = string | { reveal(): string };
const reveal = (v: Revealable) => (typeof v === "string" ? v : v.reveal());

export class RegionWriteError extends Error {
  constructor(model: string) {
    super(`${model}: this region's database is a read-only replica; writes go to the primary region`);
    this.name = "RegionWriteError";
  }
}

export const REGION_PATH = "/_weft/region/";
const AUTH = "x-weft-region-auth";
const URL_HEADER = "x-weft-region-url";
const SEQ_HEADER = "x-weft-region-seq";
const SEQ_COOKIE = "weft-region-seq";
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "host", "content-length"]);
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

const DATE = "$weft:date";
const BIG = "$weft:bigint";

export function encodeRows(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, v) {
    const raw = this[key];
    if (raw instanceof Date) return { [DATE]: raw.toISOString() };
    if (typeof raw === "bigint") return { [BIG]: raw.toString() };
    return v;
  });
}

export function decodeRows<T>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1) {
      if (typeof v[DATE] === "string") return new Date(v[DATE]);
      if (typeof v[BIG] === "string" && /^-?\d+$/.test(v[BIG])) return BigInt(v[BIG]);
    }
    return v;
  }) as T;
}

function mac(secret: string, region: string, ts: number, method: string, path: string): string {
  return createHmac("sha256", secret).update(`weft-region\n${region}\n${ts}\n${method}\n${path}`).digest("hex");
}

function sign(secret: string, region: string, method: string, url: URL, now: number): string {
  const ts = Math.floor(now / 1000);
  return `${region}.${ts}.${mac(secret, region, ts, method.toUpperCase(), url.pathname + url.search)}`;
}

function verify(secret: string, req: Request, now: number): string | null {
  const h = req.headers.get(AUTH);
  const m = h ? /^([a-z][a-z0-9-]{0,31})\.(\d{1,12})\.([0-9a-f]{64})$/.exec(h) : null;
  if (!m) return null;
  const ts = Number(m[2]);
  if (Math.abs(now / 1000 - ts) > 60) return null;
  const url = new URL(req.url);
  const want = Buffer.from(mac(secret, m[1]!, ts, req.method.toUpperCase(), url.pathname + url.search));
  return timingSafeEqual(Buffer.from(m[3]!), want) ? m[1]! : null;
}

interface Entry {
  seq: number;
  model: string;
  op: Change["op"];
  key: unknown;
  row?: unknown;
  regions?: string[];
}

interface LogReply {
  epoch: string;
  seq: number;
  reset?: true;
  entries: Entry[];
}

export interface RegionsOptions {
  region: string;
  primary: string;
  primaryUrl: string;
  secret: Revealable;
  models: readonly Model<any, any>[];
  forward?: "proxy" | "fly-replay";
  logSize?: number;
  maxLagMs?: number;
  sessionCacheMs?: number;
  onError?: (err: unknown) => void;
  fetch?: typeof fetch;
  now?: () => number;
}

export class Regions {
  readonly region: string;
  readonly primary: string;
  readonly isPrimary: boolean;
  readonly #secret: string;
  readonly #primaryUrl: URL;
  readonly #models: Map<string, Model<any, any>>;
  readonly #o: Required<Pick<RegionsOptions, "forward" | "logSize" | "maxLagMs" | "sessionCacheMs" | "onError" | "fetch" | "now">>;
  readonly #epoch = randomBytes(9).toString("base64url");
  #seq = 0;
  #log: Entry[] = [];
  #waiters = new Set<() => void>();
  #unsubscribe: (() => void)[] = [];
  #remoteEpoch = "";
  #applied = 0;
  #applying = false;
  #ready = false;
  #stopped = false;
  #appliedWaiters = new Set<() => void>();
  readonly #toPrimary = new WeakSet<object>();

  constructor(o: RegionsOptions) {
    const fail = (m: string): never => {
      throw new Error(`defineRegions: ${m}`);
    };
    if (!o || typeof o !== "object") fail("needs options");
    for (const k of ["region", "primary"] as const) if (typeof o[k] !== "string" || !NAME.test(o[k])) fail(`${k} is a region name like \`fra\` or \`us-east\``);
    let url: URL;
    try {
      url = new URL(o.primaryUrl);
    } catch {
      url = fail("primaryUrl is the primary's URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") fail("primaryUrl is an http(s) URL");
    const secret = reveal(o.secret);
    if (typeof secret !== "string" || secret.length < 32) fail("secret is at least 32 characters");
    if (!Array.isArray(o.models) || o.models.length === 0) fail("models lists the replicated models");
    this.region = o.region;
    this.primary = o.primary;
    this.isPrimary = o.region === o.primary;
    this.#secret = secret;
    this.#primaryUrl = new URL(url.origin);
    this.#models = new Map(o.models.map((m) => [m.name, m]));
    this.#o = {
      forward: o.forward ?? "proxy",
      logSize: o.logSize ?? 10_000,
      maxLagMs: o.maxLagMs ?? 2000,
      sessionCacheMs: o.sessionCacheMs ?? 10_000,
      onError: o.onError ?? ((err) => console.error("[weft] regions:", err)),
      fetch: o.fetch ?? fetch,
      now: o.now ?? Date.now,
    };
    if (this.isPrimary) this.#startLog();
    else this.#readOnly();
  }

  #startLog(): void {
    const feeds = new Set([...this.#models.values()].map((m) => m.feed));
    for (const feed of feeds) {
      this.#unsubscribe.push(
        feed.subscribe((c) => {
          const m = this.#models.get(c.model);
          if (!m || m.feed !== feed) return;
          const e: Entry = { seq: ++this.#seq, model: c.model, op: c.op, key: c.key };
          if (c.after !== undefined && c.op !== "delete") e.row = c.after;
          if (c.regions && c.regions.length > 0) e.regions = c.regions;
          if (c.redacted) e.key = undefined;
          this.#log.push(e);
          if (this.#log.length > this.#o.logSize) this.#log.splice(0, this.#log.length - this.#o.logSize);
          for (const w of [...this.#waiters]) w();
        }),
      );
    }
  }

  static #reaches(regions: string[] | undefined, to: string): boolean {
    return !regions || regions.length === 0 || regions.every((r) => r === to);
  }

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(REGION_PATH)) return null;
    if (!this.isPrimary) return new Response("Not found", { status: 404 });
    const from = verify(this.#secret, req, this.#o.now());
    if (from === null) return new Response("Forbidden", { status: 403 });
    const what = url.pathname.slice(REGION_PATH.length);
    const json = (v: unknown, status = 200) =>
      new Response(encodeRows(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (what === "log" && req.method === "GET") {
      const epoch = url.searchParams.get("epoch") ?? "";
      const since = Number(url.searchParams.get("since") ?? "0");
      const wait = Math.min(25_000, Math.max(0, Number(url.searchParams.get("wait") ?? "0") || 0));
      const oldest = this.#log[0]?.seq ?? this.#seq + 1;
      if (epoch !== this.#epoch || !Number.isSafeInteger(since) || since < oldest - 1 || since > this.#seq) {
        return json({ epoch: this.#epoch, seq: this.#seq, reset: true, entries: [] } satisfies LogReply);
      }
      if (since === this.#seq && wait > 0) {
        await new Promise<void>((done) => {
          const t = setTimeout(finish, wait);
          function finish() {
            clearTimeout(t);
            waiters.delete(finish);
            done();
          }
          const waiters = this.#waiters;
          waiters.add(finish);
          req.signal?.addEventListener("abort", finish);
        });
      }
      const entries = this.#log
        .filter((e) => e.seq > since)
        .slice(0, 1000)
        .map((e) => (Regions.#reaches(e.regions, from) ? e : { seq: e.seq, model: e.model, op: e.op, key: undefined }));
      return json({ epoch: this.#epoch, seq: entries.at(-1)?.seq ?? since, entries } satisfies LogReply);
    }
    if (what === "snapshot" && req.method === "GET") {
      const models: Record<string, unknown[]> = {};
      for (const [name, m] of this.#models) {
        models[name] = (m.syncDriver().select([]) as unknown[]).filter((row) => Regions.#reaches(m.regionsOf(row, undefined), from));
      }
      return json({ epoch: this.#epoch, seq: this.#seq, models });
    }
    if (what === "session") return this.#sessionEndpoint(req, url);
    return new Response("Not found", { status: 404 });
  }

  #sessionStore: SessionStore | null = null;

  async #sessionEndpoint(req: Request, url: URL): Promise<Response> {
    const store = this.#sessionStore;
    if (!store) return new Response("No session store", { status: 404 });
    const sid = url.searchParams.get("sid") ?? "";
    const user = url.searchParams.get("user");
    const json = (v: unknown) => new Response(encodeRows(v), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (req.method === "GET" && user !== null) return json(store.forUser ? await store.forUser(user) : []);
    if (sid.length < 16 || sid.length > 256) return new Response("Bad request", { status: 400 });
    if (req.method === "GET") return json((await store.get(sid)) ?? null);
    if (req.method === "PUT") {
      const text = await req.text();
      if (text.length > 64_000) return new Response("Too large", { status: 413 });
      await store.set(sid, decodeRows<SessionRecord>(text));
      return json(true);
    }
    if (req.method === "DELETE") {
      await store.delete(sid);
      return json(true);
    }
    return new Response("Method not allowed", { status: 405 });
  }

  sessions(store: SessionStore): SessionStore {
    if (this.isPrimary) {
      this.#sessionStore = store;
      return store;
    }
    const cache = new Map<string, { at: number; record: SessionRecord | null }>();
    const call = async (method: string, query: string, body?: string): Promise<unknown> => {
      const url = new URL(`${REGION_PATH}session?${query}`, this.#primaryUrl);
      const res = await this.#o.fetch(url, {
        method,
        headers: { [AUTH]: sign(this.#secret, this.region, method, url, this.#o.now()), "content-type": "application/json" },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`regions: the primary answered ${res.status} for a session`);
      return decodeRows(await res.text());
    };
    return {
      get: async (sid) => {
        const hit = cache.get(sid);
        if (hit && this.#o.now() - hit.at < this.#o.sessionCacheMs) return hit.record;
        const record = (await call("GET", `sid=${encodeURIComponent(sid)}`)) as SessionRecord | null;
        cache.set(sid, { at: this.#o.now(), record });
        if (cache.size > 10_000) cache.delete(cache.keys().next().value!);
        return record;
      },
      set: async (sid, record) => {
        cache.set(sid, { at: this.#o.now(), record });
        await call("PUT", `sid=${encodeURIComponent(sid)}`, encodeRows(record));
      },
      delete: async (sid) => {
        cache.delete(sid);
        await call("DELETE", `sid=${encodeURIComponent(sid)}`);
      },
      forUser: async (user) => (await call("GET", `user=${encodeURIComponent(user)}`)) as { sid: string; record: SessionRecord }[],
    };
  }

  get seq(): string {
    return `${this.#epoch}.${this.#seq}`;
  }

  #readOnly(): void {
    for (const m of this.#models.values()) {
      const d = m.syncDriver() as unknown as Record<string, (...a: unknown[]) => unknown>;
      for (const op of ["insert", "update", "delete"] as const) {
        const real = d[op]!.bind(d);
        d[op] = (...args: unknown[]) => {
          if (!this.#applying) throw new RegionWriteError(m.name);
          return real(...args);
        };
      }
    }
  }

  async start(): Promise<void> {
    if (this.isPrimary) return;
    await this.#snapshot();
    void this.#follow();
  }

  get ready(): boolean {
    return this.isPrimary || this.#ready;
  }

  stop(): void {
    this.#stopped = true;
    for (const u of this.#unsubscribe) u();
    for (const w of [...this.#waiters]) w();
  }

  async #get(path: string, signal?: AbortSignal): Promise<string> {
    const url = new URL(path, this.#primaryUrl);
    const res = await this.#o.fetch(url, { headers: { [AUTH]: sign(this.#secret, this.region, "GET", url, this.#o.now()) }, ...(signal ? { signal } : {}) });
    if (!res.ok) throw new Error(`regions: the primary answered ${res.status} for ${url.pathname}`);
    return res.text();
  }

  async #snapshot(): Promise<void> {
    const snap = decodeRows<{ epoch: string; seq: number; models: Record<string, unknown[]> }>(await this.#get(`${REGION_PATH}snapshot`, AbortSignal.timeout(60_000)));
    this.#applying = true;
    try {
      for (const [name, m] of this.#models) {
        const rows = snap.models[name] ?? [];
        const d = m.syncDriver();
        for (const old of d.select([])) d.delete((old as Record<string, unknown>)[m.key]);
        for (const row of rows) d.insert(row);
        m.publishAll();
      }
    } finally {
      this.#applying = false;
    }
    this.#remoteEpoch = snap.epoch;
    this.#setApplied(snap.seq);
    this.#ready = true;
  }

  #setApplied(seq: number): void {
    this.#applied = seq;
    for (const w of [...this.#appliedWaiters]) w();
  }

  #apply(e: Entry): void {
    const m = this.#models.get(e.model);
    if (!m) return;
    if (e.key === undefined) {
      m.publishAll();
      return;
    }
    const d = m.syncDriver();
    const before = d.select([], e.key).find((r) => (r as Record<string, unknown>)[m.key] === e.key || String((r as Record<string, unknown>)[m.key]) === String(e.key));
    this.#applying = true;
    try {
      if (e.op === "delete" || e.row === undefined) {
        if (before !== undefined) d.delete(e.key);
      } else if (before !== undefined) d.update(e.key, e.row);
      else d.insert(e.row);
    } finally {
      this.#applying = false;
    }
    m.publish(e.op === "delete" ? "delete" : before === undefined ? "create" : "update", e.key, before, e.op === "delete" ? undefined : e.row);
  }

  async #follow(): Promise<void> {
    let backoff = 500;
    while (!this.#stopped) {
      try {
        const reply = decodeRows<LogReply>(
          await this.#get(`${REGION_PATH}log?epoch=${encodeURIComponent(this.#remoteEpoch)}&since=${this.#applied}&wait=20000`, AbortSignal.timeout(30_000)),
        );
        if (reply.reset) {
          await this.#snapshot();
        } else {
          for (const e of reply.entries) this.#apply(e);
          this.#setApplied(reply.seq);
        }
        backoff = 500;
      } catch (err) {
        if (this.#stopped) return;
        this.#o.onError(err);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
  }

  async #caughtUp(token: string | null, ms: number): Promise<boolean> {
    if (!token) return true;
    const m = /^([A-Za-z0-9_-]{1,32})\.(\d{1,15})$/.exec(token);
    if (!m) return true;
    const seq = Number(m[2]);
    const ok = () => this.#ready && (m[1] !== this.#remoteEpoch ? false : this.#applied >= seq);
    if (ok()) return true;
    if (m[1] !== this.#remoteEpoch && this.#ready) return false;
    return new Promise((done) => {
      const t = setTimeout(() => {
        this.#appliedWaiters.delete(check);
        done(ok());
      }, ms);
      const check = () => {
        if (!ok()) return;
        clearTimeout(t);
        this.#appliedWaiters.delete(check);
        done(true);
      };
      this.#appliedWaiters.add(check);
    });
  }

  async route(req: Request, o: { routeOf(path: string): object | null; holdsPage(lid: string | null): boolean }): Promise<Request | Response | null> {
    const url = new URL(req.url);
    if (this.isPrimary) {
      const original = req.headers.get(URL_HEADER);
      if (original === null) return req;
      if (verify(this.#secret, req, this.#o.now()) === null) return new Response("Forbidden", { status: 403 });
      const headers = new Headers(req.headers);
      headers.delete(URL_HEADER);
      headers.delete(AUTH);
      return new Request(original, {
        method: req.method,
        headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: req.body, duplex: "half" }),
        signal: req.signal,
      } as RequestInit);
    }
    if (url.pathname.startsWith(REGION_PATH)) return new Response("Not found", { status: 404 });
    if (url.pathname === "/_weft/health" || url.pathname === "/_weft/ready") return null;
    const reading = req.method === "GET" || req.method === "HEAD";
    if (url.pathname.startsWith("/_weft/live")) {
      return o.holdsPage(url.searchParams.get("lid")) ? null : this.forward(req);
    }
    if (!reading || url.pathname.startsWith("/_weft/auth") || url.pathname.startsWith("/_weft/uploads")) return this.forward(req);
    const route = o.routeOf(url.pathname);
    if (route !== null && this.#toPrimary.has(route)) return this.forward(req);
    if (!this.#ready) return this.forward(req);
    if (!(await this.#caughtUp(cookie(req, SEQ_COOKIE), this.#o.maxLagMs))) return this.forward(req);
    return null;
  }

  remember(route: object): void {
    this.#toPrimary.add(route);
  }

  async forward(req: Request): Promise<Response> {
    if (this.#o.forward === "fly-replay") {
      return new Response(null, { status: 409, headers: { "fly-replay": `region=${this.primary}`, "cache-control": "no-store" } });
    }
    const url = new URL(req.url);
    const target = new URL(url.pathname + url.search, this.#primaryUrl);
    const headers = new Headers();
    req.headers.forEach((v, k) => {
      if (!HOP.has(k) && !k.startsWith("x-weft-region")) headers.set(k, v);
    });
    headers.set(URL_HEADER, req.url);
    headers.set(AUTH, sign(this.#secret, this.region, req.method, target, this.#o.now()));
    let res: Response;
    try {
      res = await this.#o.fetch(target, {
        method: req.method,
        headers,
        redirect: "manual",
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: req.body, duplex: "half" }),
        signal: req.signal,
      } as RequestInit);
    } catch (err) {
      this.#o.onError(err);
      return new Response("The primary region cannot be reached", { status: 503, headers: { "retry-after": "5" } });
    }
    const out = new Headers();
    res.headers.forEach((v, k) => {
      if (!HOP.has(k) && k !== "set-cookie" && k !== SEQ_HEADER && k !== "content-encoding") out.set(k, v);
    });
    for (const c of res.headers.getSetCookie()) out.append("set-cookie", c);
    const seq = res.headers.get(SEQ_HEADER);
    if (seq && /^[A-Za-z0-9_-]{1,32}\.\d{1,15}$/.test(seq) && !(req.method === "GET" || req.method === "HEAD")) {
      out.append("set-cookie", `${SEQ_COOKIE}=${seq}; Path=/; Max-Age=60; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`);
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  }

  stamp(req: Request, res: Response): Response {
    if (!this.isPrimary || req.method === "GET" || req.method === "HEAD") return res;
    try {
      res.headers.set(SEQ_HEADER, this.seq);
      return res;
    } catch {
      const h = new Headers(res.headers);
      h.set(SEQ_HEADER, this.seq);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
  }
}

function cookie(req: Request, name: string): string | null {
  const h = req.headers.get("cookie");
  if (!h) return null;
  for (const part of h.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function defineRegions(o: RegionsOptions): Regions {
  return new Regions(o);
}
