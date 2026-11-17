import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { ImageError } from "./image/bitmap.ts";
import { probe, transform as transformSync, type ImageFormat, type Transformed, type Variant } from "./image/transform.ts";

export { ImageError, type ImageFormat, type Transformed, type Variant };

export const IMAGES_PATH = "/_weft/img";

export interface ImagesOptions {
  widths?: number[];
  aspects?: string[];
  formats?: (ImageFormat | "auto")[];
  quality?: number;
  maxPixels?: number;
  maxBytes?: number;
  workers?: number;
  queue?: number;
  cacheBytes?: number;
  timeoutMs?: number;
}

export interface ImageUrlOptions {
  width: number;
  aspect?: string;
  format?: ImageFormat | "auto";
}

export interface Images {
  url(src: string, o: ImageUrlOptions): string;
  srcset(src: string, o?: { aspect?: string; format?: ImageFormat | "auto"; widths?: number[] }): string;
  transform(src: Uint8Array, v: { width: number; aspect?: string; format?: ImageFormat | "auto"; focus?: [number, number] }): Promise<Transformed>;
  handle(req: Request, read: (path: string, ifNoneMatch?: string) => Promise<Response>): Promise<Response>;
  close(): Promise<void>;
}

const ASPECT = /^([1-9]\d{0,2})x([1-9]\d{0,2})$/;
const SRC = /^\/(?![/\\])[^\s#\\]{0,1023}$/;

interface Cached {
  tag: string;
  out: Transformed;
  etag: string;
  publicTtl: boolean;
}

class Pool {
  readonly #size: number;
  readonly #queue: number;
  readonly #timeout: number;
  readonly #idle: Worker[] = [];
  #all = 0;
  readonly #waiting: { job: Job }[] = [];
  #next = 1;

  constructor(size: number, queue: number, timeout: number) {
    this.#size = size;
    this.#queue = queue;
    this.#timeout = timeout;
  }

  run(src: Uint8Array, variant: Variant, maxPixels: number): Promise<Transformed> {
    return new Promise((resolve, reject) => {
      const job: Job = { id: this.#next++, src, variant, maxPixels, resolve, reject };
      const w = this.#idle.pop() ?? (this.#all < this.#size ? this.#spawn() : null);
      if (w) this.#start(w, job);
      else if (this.#waiting.length >= this.#queue) reject(new ImageBusy());
      else this.#waiting.push({ job });
    });
  }

  #spawn(): Worker {
    this.#all += 1;
    const w = new Worker(new URL("./image/worker.ts", import.meta.url));
    w.unref();
    return w;
  }

  #start(w: Worker, job: Job): void {
    const timer = setTimeout(() => {
      done();
      this.#all -= 1;
      void w.terminate();
      job.reject(new ImageError(`processing took longer than ${this.#timeout} ms`));
      this.#drain();
    }, this.#timeout);
    const onMessage = (m: { id: number; ok?: Transformed; error?: string }) => {
      if (m.id !== job.id) return;
      done();
      if (m.ok) job.resolve({ ...m.ok, bytes: new Uint8Array(m.ok.bytes) });
      else job.reject(new ImageError(m.error ?? "image processing failed"));
      this.#idle.push(w);
      this.#drain();
    };
    const onError = (err: Error) => {
      done();
      this.#all -= 1;
      job.reject(new ImageError(err.message));
      this.#drain();
    };
    const done = () => {
      clearTimeout(timer);
      w.off("message", onMessage);
      w.off("error", onError);
    };
    w.on("message", onMessage);
    w.on("error", onError);
    const copy = job.src.slice();
    w.postMessage({ id: job.id, src: copy, variant: job.variant, maxPixels: job.maxPixels }, [copy.buffer]);
  }

  #drain(): void {
    while (this.#waiting.length) {
      const w = this.#idle.pop() ?? (this.#all < this.#size ? this.#spawn() : null);
      if (!w) return;
      this.#start(w, this.#waiting.shift()!.job);
    }
  }

  async close(): Promise<void> {
    const idle = this.#idle.splice(0);
    this.#all -= idle.length;
    await Promise.all(idle.map((w) => w.terminate()));
  }
}

interface Job {
  id: number;
  src: Uint8Array;
  variant: Variant;
  maxPixels: number;
  resolve(t: Transformed): void;
  reject(e: Error): void;
}

class ImageBusy extends Error {}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("base64url").slice(0, 32);

export function defineImages(o: ImagesOptions = {}): Images {
  const widths = [...(o.widths ?? [320, 640, 960, 1280, 1920, 2560])].sort((a, b) => a - b);
  const aspects = o.aspects ?? [];
  const formats = o.formats ?? ["auto", "jpeg", "png"];
  const quality = o.quality ?? 80;
  const maxPixels = o.maxPixels ?? 40_000_000;
  const maxBytes = o.maxBytes ?? 30 * 1024 * 1024;
  const cacheBytes = o.cacheBytes ?? 64 * 1024 * 1024;
  const timeoutMs = o.timeoutMs ?? 30_000;
  const workers = o.workers ?? Math.max(1, Math.min(2, availableParallelism() - 1));
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!widths.length || widths.length > 16 || !widths.every((w) => int(w, 16, 8192))) throw new RangeError("defineImages: widths are 1-16 whole numbers, 16-8192");
  if (aspects.length > 8 || !aspects.every((a) => ASPECT.test(a))) throw new RangeError('defineImages: aspects are up to 8 ratios like "16x9"');
  if (!formats.length || !formats.every((f) => f === "auto" || f === "jpeg" || f === "png")) throw new RangeError('defineImages: formats are "auto", "jpeg" or "png"');
  if (!int(quality, 1, 100)) throw new RangeError("defineImages: quality is 1-100");
  if (!int(maxPixels, 1, 200_000_000) || !int(maxBytes, 1024, 512 * 1024 * 1024)) throw new RangeError("defineImages: maxPixels or maxBytes out of range");
  if (!int(workers, 1, 32) || !int(o.queue ?? 32, 0, 10_000) || !int(timeoutMs, 1000, 600_000)) throw new RangeError("defineImages: workers, queue or timeoutMs out of range");

  const pool = new Pool(workers, o.queue ?? 32, timeoutMs);
  const cache = new Map<string, Cached>();
  let held = 0;
  const keep = (key: string, c: Cached) => {
    const old = cache.get(key);
    if (old) held -= old.out.bytes.byteLength;
    cache.delete(key);
    if (c.out.bytes.byteLength > cacheBytes / 4) return;
    cache.set(key, c);
    held += c.out.bytes.byteLength;
    for (const [k, v] of cache) {
      if (held <= cacheBytes) break;
      cache.delete(k);
      held -= v.out.bytes.byteLength;
    }
  };
  const ratio = (a: string | undefined): [number, number] | undefined => {
    if (a === undefined) return undefined;
    const m = ASPECT.exec(a)!;
    return [Number(m[1]), Number(m[2])];
  };
  const local = (src: string): boolean => {
    if (typeof src !== "string" || !SRC.test(src)) return false;
    const u = new URL(src, "http://app.invalid");
    const path = u.pathname.toLowerCase();
    return u.origin === "http://app.invalid" && path !== IMAGES_PATH && !path.startsWith(`${IMAGES_PATH}/`);
  };
  const check = (src: string, width: number, aspect: string | undefined, format: string | undefined) => {
    if (!local(src)) throw new TypeError(`images: ${JSON.stringify(src)} is not a path of this app`);
    if (!widths.includes(width)) throw new TypeError(`images: width ${width} is not one of ${widths.join(", ")}`);
    if (aspect !== undefined && !aspects.includes(aspect)) throw new TypeError(`images: aspect ${aspect} is not one of ${aspects.join(", ") || "(none)"}`);
    if (format !== undefined && !formats.includes(format as ImageFormat)) throw new TypeError(`images: format ${format} is not one of ${formats.join(", ")}`);
  };
  const url = (src: string, u: ImageUrlOptions) => {
    check(src, u.width, u.aspect, u.format);
    const q = new URLSearchParams({ src, w: String(u.width) });
    if (u.aspect) q.set("ar", u.aspect);
    if (u.format && u.format !== formats[0]) q.set("f", u.format);
    return `${IMAGES_PATH}?${q}`;
  };

  return {
    url,
    srcset(src, s = {}) {
      return (s.widths ?? widths).map((w) => `${url(src, { width: w, aspect: s.aspect, format: s.format })} ${w}w`).join(", ");
    },
    async transform(src, v) {
      if (!int(v.width, 1, 16384)) throw new RangeError("images.transform: width is 1-16384");
      if (v.aspect !== undefined && !ASPECT.test(v.aspect)) throw new RangeError('images.transform: aspect is like "16x9"');
      if (!probe(src)) throw new ImageError("not a JPEG or PNG image");
      return pool.run(src, { width: v.width, aspect: ratio(v.aspect), focus: v.focus, format: v.format ?? "auto", quality }, maxPixels);
    },
    async handle(req, read) {
      const q = new URL(req.url).searchParams;
      const src = q.get("src") ?? "";
      const width = Number(q.get("w"));
      const aspect = q.get("ar") ?? undefined;
      const format = (q.get("f") ?? formats[0]!) as ImageFormat | "auto";
      try {
        check(src, width, aspect, format);
      } catch (err) {
        return text(400, (err as Error).message);
      }
      const key = `${src}\n${width}\n${aspect ?? ""}\n${format}`;
      const entry = cache.get(key);
      const res = await read(src, entry?.tag.startsWith("e:") ? entry.tag.slice(2) : undefined);
      let hit: Cached;
      if (res.status === 304 && entry) {
        hit = entry;
      } else if (res.status !== 200) {
        await res.body?.cancel();
        return text(res.status === 404 || res.status === 401 || res.status === 403 ? res.status : 502, "image unavailable");
      } else {
        const body = await readCapped(res, maxBytes);
        if (!body) return text(413, "image too large");
        const etag = res.headers.get("etag");
        const tag = etag ? `e:${etag}` : `h:${sha(body)}`;
        const publicTtl = /\bpublic\b/.test(res.headers.get("cache-control") ?? "");
        if (entry && entry.tag === tag) {
          hit = { ...entry, publicTtl };
        } else {
          const kind = probe(body);
          if (!kind) return text(415, "not a JPEG or PNG image");
          if (kind.width * kind.height > maxPixels) return text(413, "image too large");
          let out: Transformed;
          try {
            out = await pool.run(body, { width, aspect: ratio(aspect), format, quality }, maxPixels);
          } catch (err) {
            if (err instanceof ImageBusy) return text(503, "busy; try again", { "retry-after": "2" });
            return text(422, (err as Error).message);
          }
          hit = { tag, out, etag: `"${sha(out.bytes)}"`, publicTtl };
        }
        keep(key, hit);
      }
      const { publicTtl } = hit;
      const headers: Record<string, string> = {
        "content-type": hit.out.type,
        etag: hit.etag,
        "cache-control": publicTtl ? "public, max-age=86400" : "private, no-cache",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      };
      if (!publicTtl) headers.vary = "Cookie";
      if (req.headers.get("if-none-match")?.split(",").some((t) => t.trim().replace(/^W\//, "") === hit.etag)) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(hit.out.bytes as BodyInit, { headers });
    },
    close: () => pool.close(),
  };
}

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra } });
}

async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (Number(res.headers.get("content-length") ?? "0") > max) {
    await res.body?.cancel();
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export { transformSync };
