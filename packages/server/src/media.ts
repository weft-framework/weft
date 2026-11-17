import { createPrivateKey, sign as rsaSign, timingSafeEqual, createHmac, randomBytes } from "node:crypto";
import { onFileRelease, type SqlDatabase } from "@weft-framework/data";
import type { Uploads } from "./uploads.ts";

export type Revealable = string | { reveal(): string };
const reveal = (v: Revealable) => (typeof v === "string" ? v : v.reveal());

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

export interface MediaProbe {
  container: "mp4" | "wav";
  duration: number | null;
  width: number | null;
  height: number | null;
  video: boolean;
  audio: boolean;
}

export function probeMedia(bytes: Uint8Array): MediaProbe | null {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("probeMedia: bytes is a Uint8Array");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (bytes.length >= 12 && tag(0) === "RIFF" && tag(8) === "WAVE") return wav(bytes, v, tag);
  if (bytes.length >= 8 && (tag(4) === "ftyp" || tag(4) === "moov" || tag(4) === "mdat" || tag(4) === "wide")) return mp4(bytes, v, tag);
  return null;
}

function wav(bytes: Uint8Array, v: DataView, tag: (at: number) => string): MediaProbe | null {
  let byteRate = 0;
  let data = -1;
  for (let p = 12, n = 0; p + 8 <= bytes.length && n < 1000; n++) {
    const size = v.getUint32(p + 4, true);
    if (tag(p) === "fmt " && p + 20 <= bytes.length) byteRate = v.getUint32(p + 16, true);
    if (tag(p) === "data") {
      data = size;
      break;
    }
    p += 8 + size + (size & 1);
  }
  if (data < 0) return null;
  return { container: "wav", duration: byteRate > 0 ? round(data / byteRate) : null, width: null, height: null, video: false, audio: true };
}

function mp4(bytes: Uint8Array, v: DataView, tag: (at: number) => string): MediaProbe | null {
  const out: MediaProbe = { container: "mp4", duration: null, width: null, height: null, video: false, audio: false };
  let boxes = 0;
  const walk = (from: number, to: number, fn: (type: string, start: number, end: number) => void): boolean => {
    let p = from;
    while (p + 8 <= to) {
      if (++boxes > 10_000) return false;
      let size = v.getUint32(p);
      let head = 8;
      if (size === 1) {
        if (p + 16 > to) return false;
        const big = v.getBigUint64(p + 8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        size = Number(big);
        head = 16;
      } else if (size === 0) size = to - p;
      if (size < head) return false;
      const end = p + size;
      if (end > to) {
        if (to === bytes.length) return true;
        return false;
      }
      fn(tag(p + 4), p + head, end);
      p = end;
    }
    return true;
  };
  let found = false;
  let ok = true;
  const top = walk(0, bytes.length, (type, s, e) => {
    if (type !== "moov") return;
    found = true;
    ok &&= walk(s, e, (t, s2, e2) => {
      if (t === "mvhd" && e2 - s2 >= 32) {
        const ver = bytes[s2]!;
        const scale = v.getUint32(s2 + (ver === 1 ? 20 : 12));
        const dur = ver === 1 ? Number(v.getBigUint64(s2 + 24)) : v.getUint32(s2 + 16);
        if (scale > 0 && dur !== 0xffffffff) out.duration = round(dur / scale);
      }
      if (t !== "trak") return;
      let w = 0;
      let h = 0;
      let kind = "";
      ok &&= walk(s2, e2, (t3, s3, e3) => {
        if (t3 === "tkhd" && e3 - s3 >= 84) {
          w = v.getUint32(e3 - 8) / 65536;
          h = v.getUint32(e3 - 4) / 65536;
        }
        if (t3 === "mdia") {
          ok &&= walk(s3, e3, (t4, s4, e4) => {
            if (t4 === "hdlr" && e4 - s4 >= 12) kind = tag(s4 + 8);
          });
        }
      });
      if (kind === "vide") {
        out.video = true;
        if (out.width === null && w > 0 && h > 0) [out.width, out.height] = [Math.round(w), Math.round(h)];
      } else if (kind === "soun") out.audio = true;
    });
  });
  return top && ok && found ? out : null;
}

const round = (s: number) => Math.round(s * 1000) / 1000;

export interface ProviderAsset {
  asset: string;
}

export interface ProviderEvent {
  asset: string;
  status: "ready" | "errored" | "processing" | "deleted";
  playback?: string;
  duration?: number | null;
  aspect?: string | null;
  error?: string;
}

export interface MediaProvider {
  readonly name: string;
  create(input: { source: string; tag: string }): Promise<ProviderAsset>;
  remove(asset: string): Promise<void>;
  verify(body: string, headers: Headers, nowSeconds: number): ProviderEvent | { ignored: true } | null;
  links(playback: string, expires: number): { hls: string; poster: string };
}

type Fetch = typeof fetch;

function hmacHeader(body: string, header: string | null, keys: { time: string; sig: string }, secrets: string[], now: number): boolean {
  if (typeof header !== "string" || header.length > 4096) return false;
  let t = NaN;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (k === keys.time && /^\d{1,12}$/.test(val)) t = Number(val);
    else if (k === keys.sig && /^[0-9a-f]{64}$/i.test(val)) sigs.push(val.toLowerCase());
  }
  if (!Number.isFinite(t) || sigs.length === 0 || Math.abs(now - t) > 300) return false;
  let ok = false;
  for (const secret of secrets) {
    const want = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
    for (const s of sigs) ok = timingSafeEqual(Buffer.from(s), want) || ok;
  }
  return ok;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function jwt(key: Revealable, kid: string, claims: Record<string, unknown>): string {
  let pem = reveal(key).trim();
  if (!pem.startsWith("-----BEGIN")) pem = Buffer.from(pem, "base64").toString("utf8");
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = b64url(JSON.stringify(claims));
  const sig = rsaSign("sha256", Buffer.from(`${head}.${body}`), createPrivateKey(pem));
  return `${head}.${body}.${b64url(sig)}`;
}

function secretsOf(v: Revealable | readonly Revealable[], what: string): string[] {
  const list = (Array.isArray(v) ? v : [v]).map((x) => reveal(x as Revealable));
  if (list.length === 0 || list.some((s) => typeof s !== "string" || s.length < 16)) throw new MediaError(`${what}: the webhook secret is the provider's signing secret`);
  return list;
}

function checkKey(key: Revealable, what: string): void {
  try {
    jwt(key, "check", { sub: "check" });
  } catch {
    throw new MediaError(`${what}: signingKey is an RSA private key (PEM, or base64 of the PEM)`);
  }
}

async function call(f: Fetch, what: string, url: string, init: RequestInit): Promise<unknown> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (init.method === "DELETE" && res.status === 404) return null;
  if (!res.ok) throw new MediaError(`${what}: ${res.status} ${text.slice(0, 200)}`);
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    throw new MediaError(`${what}: the reply is not JSON`);
  }
}

export interface MuxOptions {
  tokenId: Revealable;
  tokenSecret: Revealable;
  webhookSecret: Revealable | readonly Revealable[];
  signingKeyId: string;
  signingKey: Revealable;
  fetch?: Fetch;
  api?: string;
}

export function muxProvider(o: MuxOptions): MediaProvider {
  const secrets = secretsOf(o.webhookSecret, "muxProvider");
  if (typeof o.signingKeyId !== "string" || !o.signingKeyId) throw new MediaError("muxProvider: signingKeyId is the signing key's id");
  checkKey(o.signingKey, "muxProvider");
  const f = o.fetch ?? fetch;
  const api = o.api ?? "https://api.mux.com";
  const auth = () => `Basic ${Buffer.from(`${reveal(o.tokenId)}:${reveal(o.tokenSecret)}`).toString("base64")}`;
  return {
    name: "mux",
    async create({ source, tag }) {
      const r = (await call(f, "mux", `${api}/video/v1/assets`, {
        method: "POST",
        headers: { authorization: auth(), "content-type": "application/json" },
        body: JSON.stringify({ inputs: [{ url: source }], playback_policies: ["signed"], passthrough: tag, video_quality: "basic" }),
      })) as { data?: { id?: string } };
      if (typeof r?.data?.id !== "string") throw new MediaError("mux: no asset id in the reply");
      return { asset: r.data.id };
    },
    async remove(asset) {
      await call(f, "mux", `${api}/video/v1/assets/${encodeURIComponent(asset)}`, { method: "DELETE", headers: { authorization: auth() } });
    },
    verify(body, headers, now) {
      if (!hmacHeader(body, headers.get("mux-signature"), { time: "t", sig: "v1" }, secrets, now)) return null;
      const e = JSON.parse(body) as { type?: string; data?: Record<string, any> };
      const d = e.data ?? {};
      if (typeof d.id !== "string") return { ignored: true };
      switch (e.type) {
        case "video.asset.ready": {
          const pid = (d.playback_ids as { id: string; policy: string }[] | undefined)?.find((p) => p.policy === "signed")?.id;
          if (!pid) return { asset: d.id, status: "errored", error: "no signed playback id" };
          return { asset: d.id, status: "ready", playback: pid, duration: typeof d.duration === "number" ? d.duration : null, aspect: typeof d.aspect_ratio === "string" ? d.aspect_ratio : null };
        }
        case "video.asset.errored":
          return { asset: d.id, status: "errored", error: String((d.errors as { messages?: string[] } | undefined)?.messages?.join("; ") ?? "failed") };
        case "video.asset.deleted":
          return { asset: d.id, status: "deleted" };
        default:
          return { ignored: true };
      }
    },
    links(playback, expires) {
      const tok = (aud: string) => jwt(o.signingKey, o.signingKeyId, { sub: playback, aud, exp: expires, kid: o.signingKeyId });
      const id = encodeURIComponent(playback);
      return { hls: `https://stream.mux.com/${id}.m3u8?token=${tok("v")}`, poster: `https://image.mux.com/${id}/thumbnail.jpg?token=${tok("t")}` };
    },
  };
}

export interface CloudflareStreamOptions {
  accountId: string;
  apiToken: Revealable;
  webhookSecret: Revealable | readonly Revealable[];
  customerCode: string;
  signingKeyId: string;
  signingKey: Revealable;
  fetch?: Fetch;
  api?: string;
}

export function cloudflareStreamProvider(o: CloudflareStreamOptions): MediaProvider {
  const secrets = secretsOf(o.webhookSecret, "cloudflareStreamProvider");
  for (const k of ["accountId", "customerCode", "signingKeyId"] as const) {
    if (typeof o[k] !== "string" || !/^[A-Za-z0-9_-]+$/.test(o[k])) throw new MediaError(`cloudflareStreamProvider: ${k} is required`);
  }
  checkKey(o.signingKey, "cloudflareStreamProvider");
  const f = o.fetch ?? fetch;
  const base = `${o.api ?? "https://api.cloudflare.com/client/v4"}/accounts/${o.accountId}/stream`;
  const auth = () => `Bearer ${reveal(o.apiToken)}`;
  return {
    name: "cloudflare",
    async create({ source, tag }) {
      const r = (await call(f, "cloudflare", `${base}/copy`, {
        method: "POST",
        headers: { authorization: auth(), "content-type": "application/json" },
        body: JSON.stringify({ url: source, requireSignedURLs: true, meta: { weft: tag } }),
      })) as { result?: { uid?: string } };
      if (typeof r?.result?.uid !== "string") throw new MediaError("cloudflare: no video uid in the reply");
      return { asset: r.result.uid };
    },
    async remove(asset) {
      await call(f, "cloudflare", `${base}/${encodeURIComponent(asset)}`, { method: "DELETE", headers: { authorization: auth() } });
    },
    verify(body, headers, now) {
      if (!hmacHeader(body, headers.get("webhook-signature"), { time: "time", sig: "sig1" }, secrets, now)) return null;
      const d = JSON.parse(body) as Record<string, any>;
      if (typeof d.uid !== "string") return { ignored: true };
      const state = d.status?.state;
      if (d.readyToStream === true || state === "ready") {
        const w = d.input?.width;
        const h = d.input?.height;
        return { asset: d.uid, status: "ready", playback: d.uid, duration: typeof d.duration === "number" && d.duration >= 0 ? d.duration : null, aspect: w > 0 && h > 0 ? `${w}:${h}` : null };
      }
      if (state === "error") return { asset: d.uid, status: "errored", error: String(d.status?.errorReasonText ?? d.status?.errorReasonCode ?? "failed") };
      return { ignored: true };
    },
    links(playback, expires) {
      const tok = jwt(o.signingKey, o.signingKeyId, { sub: playback, kid: o.signingKeyId, exp: expires });
      const host = `https://customer-${o.customerCode}.cloudflarestream.com/${tok}`;
      return { hls: `${host}/manifest/video.m3u8`, poster: `${host}/thumbnails/thumbnail.jpg` };
    },
  };
}

export type MediaStatus = "processing" | "ready" | "errored";

export interface MediaRecord {
  file: string;
  provider: string;
  asset: string;
  tag: string;
  status: MediaStatus;
  playback: string | null;
  duration: number | null;
  aspect: string | null;
  error: string | null;
  created: number;
}

export interface MediaStore {
  put(r: MediaRecord): void | Promise<void>;
  get(file: string): MediaRecord | null | Promise<MediaRecord | null>;
  byAsset(provider: string, asset: string): MediaRecord | null | Promise<MediaRecord | null>;
  remove(file: string): void | Promise<void>;
}

export class MemoryMediaStore implements MediaStore {
  readonly #rows = new Map<string, MediaRecord>();
  put(r: MediaRecord): void {
    this.#rows.set(r.file, { ...r });
  }
  get(file: string): MediaRecord | null {
    const r = this.#rows.get(file);
    return r ? { ...r } : null;
  }
  byAsset(provider: string, asset: string): MediaRecord | null {
    for (const r of this.#rows.values()) if (r.provider === provider && r.asset === asset) return { ...r };
    return null;
  }
  remove(file: string): void {
    this.#rows.delete(file);
  }
}

export class SqlMediaStore implements MediaStore {
  readonly #db: SqlDatabase;
  readonly #t: string;
  constructor(db: SqlDatabase, table = "weft_media") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`@weft-framework/server: not a valid table name: ${table}`);
    this.#db = db;
    this.#t = `"${table}"`;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#t} (file TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, asset TEXT NOT NULL, ` +
        `tag TEXT NOT NULL, status TEXT NOT NULL, playback TEXT, duration REAL, aspect TEXT, error TEXT, created INTEGER NOT NULL)`,
    );
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "${table}_asset" ON ${this.#t} (provider, asset)`);
  }
  put(r: MediaRecord): void {
    this.#db
      .prepare(`INSERT OR REPLACE INTO ${this.#t} (file, provider, asset, tag, status, playback, duration, aspect, error, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.file, r.provider, r.asset, r.tag, r.status, r.playback, r.duration, r.aspect, r.error, r.created);
  }
  static #row(x: Record<string, unknown> | undefined): MediaRecord | null {
    if (!x) return null;
    const opt = (v: unknown) => (v === null || v === undefined ? null : String(v));
    return {
      file: String(x.file),
      provider: String(x.provider),
      asset: String(x.asset),
      tag: String(x.tag),
      status: String(x.status) as MediaStatus,
      playback: opt(x.playback),
      duration: x.duration === null || x.duration === undefined ? null : Number(x.duration),
      aspect: opt(x.aspect),
      error: opt(x.error),
      created: Number(x.created),
    };
  }
  get(file: string): MediaRecord | null {
    return SqlMediaStore.#row(this.#db.prepare(`SELECT * FROM ${this.#t} WHERE file = ?`).all(file)[0] as Record<string, unknown> | undefined);
  }
  byAsset(provider: string, asset: string): MediaRecord | null {
    return SqlMediaStore.#row(this.#db.prepare(`SELECT * FROM ${this.#t} WHERE provider = ? AND asset = ?`).all(provider, asset)[0] as Record<string, unknown> | undefined);
  }
  remove(file: string): void {
    this.#db.prepare(`DELETE FROM ${this.#t} WHERE file = ?`).run(file);
  }
}

export interface MediaOptions {
  uploads: Uploads<string>;
  provider: MediaProvider;
  store: MediaStore;
  origin: string;
  onReady?: (r: MediaRecord) => void | Promise<void>;
  onError?: (err: unknown) => void;
  now?: () => number;
}

export interface Playback {
  status: MediaStatus;
  hls: string | null;
  poster: string | null;
  duration: number | null;
  aspect: string | null;
  expires: number | null;
}

export class Media {
  readonly #o: Required<Omit<MediaOptions, "onReady">> & Pick<MediaOptions, "onReady">;
  #stopTracking: (() => void) | null = null;

  constructor(o: MediaOptions) {
    if (!o || !o.uploads || !o.provider || !o.store) throw new MediaError("defineMedia: needs uploads, provider and store");
    let origin: URL;
    try {
      origin = new URL(o.origin);
    } catch {
      throw new MediaError("defineMedia: origin is the app's public URL (https://...)");
    }
    if (origin.protocol !== "https:") throw new MediaError("defineMedia: origin must be https (the provider fetches files from it)");
    this.#o = { onError: () => {}, now: Date.now, ...o, origin: origin.origin };
  }

  async process(file: string): Promise<MediaRecord> {
    const existing = await this.#o.store.get(file);
    if (existing && existing.status !== "errored") return existing;
    const info = await this.#o.uploads.info(file);
    if (!info) throw new MediaError("process: no such ready file");
    if (!/^(video|audio)\//.test(info.type)) throw new MediaError(`process: ${info.type} is not video or audio`);
    const link = await this.#o.uploads.url(file, { ttlSeconds: 3600 });
    if (link === null) throw new MediaError("process: no such ready file");
    const source = new URL(link, this.#o.origin).href;
    const tag = randomBytes(12).toString("base64url");
    const { asset } = await this.#o.provider.create({ source, tag });
    const r: MediaRecord = {
      file,
      provider: this.#o.provider.name,
      asset,
      tag,
      status: "processing",
      playback: null,
      duration: null,
      aspect: null,
      error: null,
      created: this.#o.now(),
    };
    await this.#o.store.put(r);
    if (existing && existing.asset !== asset) await this.#o.provider.remove(existing.asset).catch(this.#o.onError);
    return r;
  }

  async webhook(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > 1_000_000) return new Response("Too large", { status: 413 });
    const body = await req.text();
    if (body.length > 1_000_000) return new Response("Too large", { status: 413 });
    let e: ProviderEvent | { ignored: true } | null;
    try {
      e = this.#o.provider.verify(body, req.headers, Math.floor(this.#o.now() / 1000));
    } catch {
      e = null;
    }
    if (e === null) return new Response("Bad signature", { status: 400 });
    if ("ignored" in e) return new Response("ok");
    const r = await this.#o.store.byAsset(this.#o.provider.name, e.asset);
    if (!r) return new Response("ok");
    if (e.status === "deleted") {
      await this.#o.store.remove(r.file);
      return new Response("ok");
    }
    if (e.status === "processing" || r.status === e.status) return new Response("ok");
    r.status = e.status;
    r.playback = e.playback ?? r.playback;
    r.duration = e.duration ?? r.duration;
    r.aspect = e.aspect ?? r.aspect;
    r.error = e.status === "errored" ? (e.error ?? "failed").slice(0, 500) : null;
    await this.#o.store.put(r);
    try {
      await this.#o.onReady?.(r);
    } catch (err) {
      this.#o.onError(err);
    }
    return new Response("ok");
  }

  async playback(file: string | null | undefined, o: { ttlSeconds?: number } = {}): Promise<Playback | null> {
    if (typeof file !== "string") return null;
    const r = await this.#o.store.get(file);
    if (!r) return null;
    const ttl = o.ttlSeconds ?? 3600;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) throw new MediaError("playback: ttlSeconds is 60 seconds to 1 day");
    if (r.status !== "ready" || r.playback === null) return { status: r.status, hls: null, poster: null, duration: r.duration, aspect: r.aspect, expires: null };
    const expires = Math.floor(this.#o.now() / 1000) + ttl;
    return { status: "ready", ...this.#o.provider.links(r.playback, expires), duration: r.duration, aspect: r.aspect, expires };
  }

  async remove(file: string): Promise<boolean> {
    const r = await this.#o.store.get(file);
    if (!r) return false;
    await this.#o.provider.remove(r.asset);
    await this.#o.store.remove(file);
    return true;
  }

  track(): () => void {
    this.#stopTracking ??= onFileRelease((id) => {
      this.remove(id).catch(this.#o.onError);
    });
    return () => {
      this.#stopTracking?.();
      this.#stopTracking = null;
    };
  }
}

export function defineMedia(o: MediaOptions): Media {
  const m = new Media(o);
  m.track();
  return m;
}
