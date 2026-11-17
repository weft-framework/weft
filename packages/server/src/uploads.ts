import { holdFile, onFileRelease, sweepHeldFiles, type FileRef, type SqlDatabase } from "@weft/data";
import { ActionError } from "./action.ts";
import { authState } from "./auth.ts";
import type { PageContext } from "./context.ts";
import { isSecret, type Secret } from "./secret.ts";
import { MIN_SECRET_LENGTH } from "./security.ts";

type Bytes = Uint8Array<ArrayBuffer>;
const utf8 = new TextEncoder();

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export type FileStatus = "uploading" | "ready";

export interface FileRecord {
  id: string;
  kind: string;
  owner: string;
  name: string;
  type: string;
  size: number;
  partBytes: number;
  status: FileStatus;
  upload: string;
  claimed: boolean;
  created: number;
}

export interface FileInfo {
  id: string;
  kind: string;
  name: string;
  type: string;
  size: number;
}

export interface FileStore {
  put(r: FileRecord): void | Promise<void>;
  get(id: string): FileRecord | null | Promise<FileRecord | null>;
  remove(id: string): void | Promise<void>;
  pending(owner: string): number | Promise<number>;
  stale(uploadingBefore: number, unclaimedBefore: number, limit: number): FileRecord[] | Promise<FileRecord[]>;
}

export class MemoryFileStore implements FileStore {
  readonly #rows = new Map<string, FileRecord>();
  put(r: FileRecord): void {
    this.#rows.set(r.id, { ...r });
  }
  get(id: string): FileRecord | null {
    const r = this.#rows.get(id);
    return r ? { ...r } : null;
  }
  remove(id: string): void {
    this.#rows.delete(id);
  }
  pending(owner: string): number {
    let n = 0;
    for (const r of this.#rows.values()) if (r.owner === owner && r.status === "uploading") n++;
    return n;
  }
  stale(uploadingBefore: number, unclaimedBefore: number, limit: number): FileRecord[] {
    return [...this.#rows.values()]
      .filter((r) => (r.status === "uploading" && r.created < uploadingBefore) || (r.status === "ready" && !r.claimed && r.created < unclaimedBefore))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

export class SqlFileStore implements FileStore {
  readonly #db: SqlDatabase;
  readonly #t: string;
  constructor(db: SqlDatabase, table = "weft_files") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`@weft/server: not a valid table name: ${table}`);
    this.#db = db;
    this.#t = `"${table}"`;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#t} (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, ` +
        `name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, part_bytes INTEGER NOT NULL, status TEXT NOT NULL, ` +
        `upload TEXT NOT NULL, claimed INTEGER NOT NULL, created INTEGER NOT NULL)`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_owner" ON ${this.#t} (owner, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_created" ON ${this.#t} (created)`);
  }
  put(r: FileRecord): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO ${this.#t} (id, kind, owner, name, type, size, part_bytes, status, upload, claimed, created) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.kind, r.owner, r.name, r.type, r.size, r.partBytes, r.status, r.upload, r.claimed ? 1 : 0, r.created);
  }
  static #row(x: Record<string, unknown>): FileRecord {
    return {
      id: String(x.id),
      kind: String(x.kind),
      owner: String(x.owner),
      name: String(x.name),
      type: String(x.type),
      size: Number(x.size),
      partBytes: Number(x.part_bytes),
      status: String(x.status) as FileStatus,
      upload: String(x.upload),
      claimed: Number(x.claimed) === 1,
      created: Number(x.created),
    };
  }
  get(id: string): FileRecord | null {
    const r = this.#db.prepare(`SELECT * FROM ${this.#t} WHERE id = ?`).all(id)[0] as Record<string, unknown> | undefined;
    return r ? SqlFileStore.#row(r) : null;
  }
  remove(id: string): void {
    this.#db.prepare(`DELETE FROM ${this.#t} WHERE id = ?`).run(id);
  }
  pending(owner: string): number {
    const r = this.#db.prepare(`SELECT COUNT(*) AS n FROM ${this.#t} WHERE owner = ? AND status = 'uploading'`).all(owner)[0] as { n: number };
    return Number(r.n);
  }
  stale(uploadingBefore: number, unclaimedBefore: number, limit: number): FileRecord[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM ${this.#t} WHERE (status = 'uploading' AND created < ?) OR (status = 'ready' AND claimed = 0 AND created < ?) LIMIT ?`,
        )
        .all(uploadingBefore, unclaimedBefore, limit) as Record<string, unknown>[]
    ).map(SqlFileStore.#row);
  }
}

export interface PartTarget {
  url: string;
  headers: Record<string, string>;
}

export interface UploadStorage {
  begin(key: string, type: string): Promise<string>;
  partTarget(key: string, upload: string, index: number, size: number, expiresSeconds: number): Promise<PartTarget | null>;
  putPart?(key: string, upload: string, index: number, body: ReadableStream<Uint8Array>, size: number): Promise<void>;
  parts(key: string, upload: string): Promise<{ index: number; etag: string; size: number }[]>;
  complete(key: string, upload: string, parts: { index: number; etag: string }[]): Promise<number>;
  abort(key: string, upload: string): Promise<void>;
  read(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array> | null>;
  size(key: string): Promise<number | null>;
  remove(key: string): Promise<void>;
  downloadUrl?(key: string, o: { expiresSeconds: number; type: string; disposition: string }): Promise<string>;
}

const KEY_RE = /^[a-z0-9]{32}$/;
function checkKey(key: string): string {
  if (!KEY_RE.test(key)) throw new Error("uploads: bad storage key");
  return key;
}

export function diskStorage(o: { dir: string }): UploadStorage {
  if (typeof o?.dir !== "string" || o.dir === "") throw new Error("diskStorage: dir is a directory path");
  const io = async () => {
    const [fs, path, stream] = await Promise.all([import("node:fs"), import("node:path"), import("node:stream")]);
    return { fs, path, stream };
  };
  const partDir = async (upload: string) => {
    const { path } = await io();
    return path.join(o.dir, ".parts", checkKey(upload));
  };
  return {
    async begin(key) {
      checkKey(key);
      const { fs } = await io();
      const upload = randomId();
      await fs.promises.mkdir(await partDir(upload), { recursive: true });
      return upload;
    },
    async partTarget() {
      return null;
    },
    async putPart(key, upload, index, body, size) {
      checkKey(key);
      const { fs, path } = await io();
      const dir = await partDir(upload);
      const tmp = path.join(dir, `${index}.tmp-${randomId().slice(0, 8)}`);
      const out = fs.createWriteStream(tmp, { flags: "wx" });
      let got = 0;
      const hash = await import("node:crypto").then((c) => c.createHash("sha256"));
      try {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value.length;
          if (got > size) {
            await reader.cancel().catch(() => {});
            throw new UploadError("too-large", `part ${index} is over ${size} bytes`);
          }
          hash.update(value);
          if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
        }
        await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
        if (got !== size) throw new UploadError("invalid", `part ${index} is ${got} bytes, not ${size}`);
        await fs.promises.rename(tmp, path.join(dir, `${index}`));
        await fs.promises.writeFile(path.join(dir, `${index}.etag`), hash.digest("hex"));
      } catch (err) {
        out.destroy();
        await fs.promises.rm(tmp, { force: true });
        throw err;
      }
    },
    async parts(key, upload) {
      checkKey(key);
      const { fs, path } = await io();
      const dir = await partDir(upload);
      let names: string[];
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        return [];
      }
      const out: { index: number; etag: string; size: number }[] = [];
      for (const n of names) {
        if (!/^[1-9][0-9]{0,4}$/.test(n)) continue;
        try {
          const etag = await fs.promises.readFile(path.join(dir, `${n}.etag`), "utf8");
          out.push({ index: Number(n), etag, size: (await fs.promises.stat(path.join(dir, n))).size });
        } catch {
        }
      }
      return out.sort((a, b) => a.index - b.index);
    },
    async complete(key, upload, parts) {
      checkKey(key);
      const { fs, path } = await io();
      const dir = await partDir(upload);
      const have = new Map((await this.parts(key, upload)).map((p) => [p.index, p.etag]));
      for (const p of parts) if (have.get(p.index) !== p.etag) throw new UploadError("invalid", `part ${p.index} is missing or changed`);
      const final = path.join(o.dir, key);
      const tmp = `${final}.tmp-${randomId().slice(0, 8)}`;
      const handle = await fs.promises.open(tmp, "wx");
      try {
        for (const p of parts) {
          const data = fs.createReadStream(path.join(dir, String(p.index)));
          for await (const chunk of data) await handle.write(chunk as Uint8Array);
        }
      } finally {
        await handle.close();
      }
      await fs.promises.rename(tmp, final);
      await fs.promises.rm(dir, { recursive: true, force: true });
      return (await fs.promises.stat(final)).size;
    },
    async abort(key, upload) {
      checkKey(key);
      const { fs } = await io();
      await fs.promises.rm(await partDir(upload), { recursive: true, force: true });
    },
    async read(key, range) {
      checkKey(key);
      const { fs, path, stream } = await io();
      const file = path.join(o.dir, key);
      try {
        await fs.promises.access(file);
      } catch {
        return null;
      }
      const rs = fs.createReadStream(file, range ? { start: range.start, end: range.end } : {});
      return stream.Readable.toWeb(rs) as unknown as ReadableStream<Uint8Array>;
    },
    async size(key) {
      checkKey(key);
      const { fs, path } = await io();
      try {
        return (await fs.promises.stat(path.join(o.dir, key))).size;
      } catch {
        return null;
      }
    },
    async remove(key) {
      checkKey(key);
      const { fs, path } = await io();
      await fs.promises.rm(path.join(o.dir, key), { force: true });
    },
  };
}

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string | Secret;
  sessionToken?: string | Secret;
  pathStyle?: boolean;
  prefix?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => Date;
}

function awsEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? utf8.encode(data) : (data as Bytes))));
}

async function hmacRaw(key: Uint8Array, data: string): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key as Bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, utf8.encode(data)));
}

const reveal = (v: string | Secret) => (isSecret(v) ? v.reveal() : v);

function canonicalQuery(params: [string, string][]): string {
  return params
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

async function signingKey(secret: string, day: string, region: string, service: string): Promise<Bytes> {
  let k = await hmacRaw(utf8.encode(`AWS4${secret}`), day);
  k = await hmacRaw(k, region);
  k = await hmacRaw(k, service);
  return hmacRaw(k, "aws4_request");
}

export async function presignS3(r: {
  method: string;
  url: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresSeconds: number;
  headers?: Record<string, string>;
  now?: Date;
}): Promise<string> {
  const u = new URL(r.url);
  const amzDate = (r.now ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${r.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: u.host };
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = v;
  const names = Object.keys(headers).sort();
  const params: [string, string][] = [...u.searchParams.entries()];
  params.push(
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${r.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(r.expiresSeconds)],
    ["X-Amz-SignedHeaders", names.join(";")],
  );
  if (r.sessionToken) params.push(["X-Amz-Security-Token", r.sessionToken]);
  const query = canonicalQuery(params);
  const path = u.pathname.split("/").map((s) => awsEncode(decodeURIComponent(s))).join("/") || "/";
  const canonical = [
    r.method.toUpperCase(),
    path,
    query,
    names.map((n) => `${n}:${headers[n]!.trim()}\n`).join(""),
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonical)}`;
  const sig = hex(await hmacRaw(await signingKey(r.secretAccessKey, day, r.region, "s3"), toSign));
  return `${u.origin}${path}?${query}&X-Amz-Signature=${sig}`;
}

export function s3Storage(o: S3Options): UploadStorage {
  let base: URL;
  try {
    base = new URL(o.endpoint);
  } catch {
    throw new Error("s3Storage: endpoint is a URL");
  }
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
    throw new Error("s3Storage: endpoint must be https (http only for a local MinIO)");
  }
  if (typeof o.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(o.bucket)) throw new Error("s3Storage: bucket is an S3 bucket name");
  if (typeof o.region !== "string" || !/^[a-z0-9-]{1,32}$/.test(o.region)) throw new Error("s3Storage: region is like us-east-1 (auto for R2)");
  if (typeof o.accessKeyId !== "string" || o.accessKeyId === "") throw new Error("s3Storage: accessKeyId is required");
  const prefix = o.prefix ?? "";
  if (typeof prefix !== "string" || !/^([A-Za-z0-9_-]+\/)*$/.test(prefix)) throw new Error("s3Storage: prefix is like uploads/");
  const doFetch = o.fetch ?? ((u, init) => fetch(u, init));
  const now = o.now ?? (() => new Date());
  const objectUrl = (key: string, query = "") => {
    const k = awsEncode(prefix + checkKey(key)).replace(/%2F/g, "/");
    const root = base.href.replace(/\/$/, "");
    const url = o.pathStyle ? `${root}/${o.bucket}/${k}` : `${base.protocol}//${o.bucket}.${base.host}${base.pathname.replace(/\/$/, "")}/${k}`;
    return query ? `${url}?${query}` : url;
  };
  const creds = () => ({ secret: reveal(o.secretAccessKey), token: o.sessionToken !== undefined ? reveal(o.sessionToken) : undefined });

  async function call(method: string, url: string, body = "", extra: Record<string, string> = {}): Promise<Response> {
    const u = new URL(url);
    const amzDate = now().toISOString().replace(/[-:]|\.\d{3}/g, "");
    const day = amzDate.slice(0, 8);
    const payload = await sha256Hex(body);
    const { secret, token } = creds();
    const headers: Record<string, string> = { host: u.host, "x-amz-date": amzDate, "x-amz-content-sha256": payload };
    for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = v;
    if (token) headers["x-amz-security-token"] = token;
    const names = Object.keys(headers).sort();
    const path = u.pathname.split("/").map((s) => awsEncode(decodeURIComponent(s))).join("/") || "/";
    const canonical = [method, path, canonicalQuery([...u.searchParams.entries()]), names.map((n) => `${n}:${headers[n]!.trim()}\n`).join(""), names.join(";"), payload].join("\n");
    const scope = `${day}/${o.region}/s3/aws4_request`;
    const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonical)}`;
    const sig = hex(await hmacRaw(await signingKey(secret, day, o.region, "s3"), toSign));
    const { host: _h, ...send } = headers;
    send.authorization = `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
    const res = await doFetch(url, { method, headers: send, ...(body ? { body } : {}), redirect: "error" });
    return res;
  }
  async function ok(res: Response, what: string): Promise<string> {
    const text = await res.text();
    if (!res.ok) {
      const code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1] ?? `HTTP ${res.status}`;
      throw new Error(`s3: ${what} failed: ${code}`);
    }
    return text;
  }
  const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  return {
    async begin(key, type) {
      const text = await ok(await call("POST", objectUrl(key, "uploads="), "", { "content-type": type }), "CreateMultipartUpload");
      const id = /<UploadId>([^<]{1,1024})<\/UploadId>/.exec(text)?.[1];
      if (!id) throw new Error("s3: CreateMultipartUpload returned no UploadId");
      return id.replace(/&amp;/g, "&");
    },
    async partTarget(key, upload, index, size, expiresSeconds) {
      const url = objectUrl(key, `partNumber=${index}&uploadId=${awsEncode(upload)}`);
      const headers = { "content-length": String(size) };
      const { secret, token } = creds();
      const signed = await presignS3({
        method: "PUT",
        url,
        region: o.region,
        accessKeyId: o.accessKeyId,
        secretAccessKey: secret,
        ...(token ? { sessionToken: token } : {}),
        expiresSeconds,
        headers,
        now: now(),
      });
      return { url: signed, headers: {} };
    },
    async parts(key, upload) {
      const out: { index: number; etag: string; size: number }[] = [];
      let marker = "";
      for (let page = 0; page < 20; page++) {
        const text = await ok(await call("GET", objectUrl(key, `uploadId=${awsEncode(upload)}${marker ? `&part-number-marker=${marker}` : ""}`)), "ListParts");
        for (const m of text.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
          const body = m[1]!;
          const index = Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(body)?.[1]);
          const etag = (/<ETag>([^<]*)<\/ETag>/.exec(body)?.[1] ?? "").replace(/&quot;/g, '"');
          const size = Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1]);
          if (index > 0) out.push({ index, etag, size });
        }
        if (!/<IsTruncated>true<\/IsTruncated>/.test(text)) break;
        marker = /<NextPartNumberMarker>(\d+)<\/NextPartNumberMarker>/.exec(text)?.[1] ?? "";
        if (!marker) break;
      }
      return out.sort((a, b) => a.index - b.index);
    },
    async complete(key, upload, parts) {
      const xml =
        `<CompleteMultipartUpload>` +
        parts.map((p) => `<Part><PartNumber>${p.index}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join("") +
        `</CompleteMultipartUpload>`;
      const text = await ok(await call("POST", objectUrl(key, `uploadId=${awsEncode(upload)}`), xml, { "content-type": "application/xml" }), "CompleteMultipartUpload");
      if (/<Error>/.test(text)) throw new Error(`s3: CompleteMultipartUpload failed: ${/<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1] ?? "error"}`);
      const size = await this.size(key);
      if (size === null) throw new Error("s3: the completed object is missing");
      return size;
    },
    async abort(key, upload) {
      const res = await call("DELETE", objectUrl(key, `uploadId=${awsEncode(upload)}`));
      if (!res.ok && res.status !== 404) await ok(res, "AbortMultipartUpload");
      else await res.body?.cancel();
    },
    async read(key, range) {
      const res = await call("GET", objectUrl(key), "", range ? { range: `bytes=${range.start}-${range.end}` } : {});
      if (res.status === 404) return (await res.body?.cancel(), null);
      if (!res.ok) await ok(res, "GetObject");
      return res.body;
    },
    async size(key) {
      const res = await call("HEAD", objectUrl(key));
      await res.body?.cancel();
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`s3: HeadObject failed: HTTP ${res.status}`);
      return Number(res.headers.get("content-length"));
    },
    async remove(key) {
      const res = await call("DELETE", objectUrl(key));
      if (!res.ok && res.status !== 404) await ok(res, "DeleteObject");
      else await res.body?.cancel();
    },
    async downloadUrl(key, d) {
      const { secret, token } = creds();
      const url = objectUrl(key, `response-content-disposition=${awsEncode(d.disposition)}&response-content-type=${awsEncode(d.type)}`);
      return presignS3({ method: "GET", url, region: o.region, accessKeyId: o.accessKeyId, secretAccessKey: secret, ...(token ? { sessionToken: token } : {}), expiresSeconds: d.expiresSeconds, now: now() });
    },
  };
}

const at = (b: Uint8Array, off: number, ...bytes: number[]) => bytes.every((x, i) => b[off + i] === x);
const ascii = (b: Uint8Array, off: number, s: string) => at(b, off, ...[...s].map((c) => c.charCodeAt(0)));

export function sniffType(head: Uint8Array): string | null {
  if (at(head, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(head, 0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(head, 0, "GIF87a") || ascii(head, 0, "GIF89a")) return "image/gif";
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) return "image/webp";
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WAVE")) return "audio/wav";
  if (ascii(head, 4, "ftyp")) {
    const brand = String.fromCharCode(...head.subarray(8, 12));
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "heim", "heis", "mif1"].includes(brand)) return "image/heic";
    if (brand === "qt  ") return "video/quicktime";
    if (brand.startsWith("M4A")) return "audio/mp4";
    return "video/mp4";
  }
  if (ascii(head, 0, "%PDF-")) return "application/pdf";
  if (at(head, 0, 0x50, 0x4b, 0x03, 0x04) || at(head, 0, 0x50, 0x4b, 0x05, 0x06)) return "application/zip";
  if (at(head, 0, 0x1f, 0x8b)) return "application/gzip";
  if (at(head, 0, 0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  if (ascii(head, 0, "ID3") || (head[0] === 0xff && head.length > 1 && (head[1]! & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(head, 0, "OggS")) return "audio/ogg";
  if (ascii(head, 0, "fLaC")) return "audio/flac";
  return null;
}

const TEXT_TYPES = new Set(["text/plain", "text/csv", "text/markdown", "application/json", "image/svg+xml", "text/html", "text/xml", "application/xml"]);

const SAME_AS: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "application/zip",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "application/zip",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "application/zip",
  "application/epub+zip": "application/zip",
  "video/ogg": "audio/ogg",
  "audio/webm": "video/webm",
  "image/heif": "image/heic",
  "audio/x-m4a": "audio/mp4",
};

function looksText(head: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
  } catch {
    return false;
  }
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}

export function contentMatches(type: string, head: Uint8Array): boolean {
  if (type === "application/octet-stream") return true;
  const sniffed = sniffType(head);
  if (TEXT_TYPES.has(type)) return sniffed === null && looksText(head);
  return sniffed !== null && (sniffed === type || SAME_AS[type] === sniffed);
}

const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|audio\/|video\/|application\/pdf$|text\/plain$)/;

export interface UploadKind {
  maxBytes: number;
  types: readonly string[];
  anonymous?: boolean;
}

export interface ScanInput {
  id: string;
  kind: string;
  name: string;
  type: string;
  size: number;
  read(): Promise<ReadableStream<Uint8Array>>;
}

export interface UploadsOptions<K extends string> {
  key: string | Secret;
  storage: UploadStorage;
  kinds: Record<K, UploadKind>;
  store?: FileStore;
  partBytes?: number;
  maxPending?: number;
  pendingTtlMs?: number;
  unclaimedTtlMs?: number;
  scan?(file: ScanInput): boolean | string | Promise<boolean | string>;
  now?(): number;
}

const STATUS: Record<string, number> = { invalid: 400, forbidden: 403, "not-found": 404, "too-large": 413, type: 415, limit: 429, rejected: 422 };

export class UploadError extends ActionError {
  readonly code: "invalid" | "forbidden" | "not-found" | "too-large" | "type" | "limit" | "rejected";
  constructor(code: UploadError["code"], message: string) {
    super(message, STATUS[code]);
    this.name = "UploadError";
    this.code = code;
  }
}

function randomId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

const UPLOADS = "/_weft/uploads/";
const FILES = "/_weft/files/";
const CONTROL_RE = /[\x00-\x1f\x7f]/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function cleanName(name: unknown): string {
  if (typeof name !== "string") throw new UploadError("invalid", "name is the file's name");
  const base = name.split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f"]/g, "").trim();
  if (base === "" || base === "." || base === "..") throw new UploadError("invalid", "name is the file's name");
  return [...base].slice(0, 200).join("");
}

export class Uploads<K extends string = string> {
  readonly kinds: Readonly<Record<K, Readonly<UploadKind>>>;
  readonly #storage: UploadStorage;
  readonly #store: FileStore;
  readonly #keyText: string;
  readonly #o: { partBytes: number; maxPending: number; pendingTtlMs: number; unclaimedTtlMs: number; scan: UploadsOptions<K>["scan"]; now: () => number };
  #mac: Promise<CryptoKey> | null = null;

  constructor(o: UploadsOptions<K>) {
    const fail = (m: string): never => {
      throw new Error(`defineUploads: ${m}`);
    };
    const key = isSecret(o.key) ? o.key.reveal() : o.key;
    if (typeof key !== "string" || key.length < MIN_SECRET_LENGTH) fail(`key must be at least ${MIN_SECRET_LENGTH} characters`);
    if (!o.storage || typeof o.storage.begin !== "function") fail("storage is diskStorage() or s3Storage()");
    const kinds: Record<string, UploadKind> = {};
    const names = Object.keys(o.kinds ?? {});
    if (names.length === 0) fail("kinds names at least one kind of upload");
    for (const name of names) {
      const k = (o.kinds as Record<string, UploadKind>)[name]!;
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) fail(`not a kind name: ${name}`);
      if (!Number.isInteger(k?.maxBytes) || k.maxBytes < 1 || k.maxBytes > 5 * 1024 * GB) fail(`${name}.maxBytes is 1 byte to 5 TiB`);
      if (!Array.isArray(k.types) || k.types.length === 0) fail(`${name}.types lists MIME types`);
      for (const t of k.types) if (typeof t !== "string" || !/^[a-z]+\/[a-z0-9.+-]+$/.test(t)) fail(`${name}: not a MIME type: ${JSON.stringify(t)}`);
      kinds[name] = Object.freeze({ maxBytes: k.maxBytes, types: Object.freeze([...k.types]), anonymous: k.anonymous === true });
    }
    const int = (what: string, v: number, lo: number, hi: number) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fail(`${what} is ${lo} to ${hi}`));
    if (o.scan !== undefined && typeof o.scan !== "function") fail("scan is a function");
    this.kinds = Object.freeze(kinds) as never;
    this.#storage = o.storage;
    this.#store = o.store ?? new MemoryFileStore();
    this.#keyText = key;
    this.#o = {
      partBytes: int("partBytes", o.partBytes ?? 8 * MB, 5 * MB, 512 * MB),
      maxPending: int("maxPending", o.maxPending ?? 10, 1, 100),
      pendingTtlMs: int("pendingTtlMs", o.pendingTtlMs ?? 24 * 3600_000, 60_000, 30 * 24 * 3600_000),
      unclaimedTtlMs: int("unclaimedTtlMs", o.unclaimedTtlMs ?? 24 * 3600_000, 60_000, 30 * 24 * 3600_000),
      scan: o.scan,
      now: o.now ?? Date.now,
    };
  }

  async #sign(data: string): Promise<string> {
    this.#mac ??= (async () => {
      const base = await crypto.subtle.importKey("raw", utf8.encode(this.#keyText), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: utf8.encode("weft uploads"), info: utf8.encode("url") },
        base,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      );
    })();
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await this.#mac, utf8.encode(data)));
    return hex(sig.subarray(0, 20));
  }

  async #verify(data: string, sig: string | null): Promise<boolean> {
    if (!sig || !/^[0-9a-f]{40}$/.test(sig)) return false;
    const want = await this.#sign(data);
    let d = 0;
    for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sig.charCodeAt(i);
    return d === 0;
  }

  async #owner(ctx: PageContext, kind: Readonly<UploadKind> | null): Promise<string | null> {
    const s = await authState(ctx);
    if (s && !s.pending) return `user:${s.user}`;
    if (kind && !kind.anonymous) return null;
    if (!ctx.session) return null;
    return `session:${await this.#sign(`session:${ctx.session}`)}`;
  }

  async #mine(ctx: PageContext, id: unknown): Promise<FileRecord> {
    const r = typeof id === "string" && KEY_RE.test(id) ? await this.#store.get(id) : null;
    if (!r) throw new UploadError("not-found", "no such upload");
    const kind = (this.kinds as Record<string, Readonly<UploadKind>>)[r.kind] ?? null;
    const owner = await this.#owner(ctx, kind);
    if (owner === null || owner !== r.owner) throw new UploadError("not-found", "no such upload");
    return r;
  }

  #info(r: FileRecord): FileInfo {
    return { id: r.id, kind: r.kind, name: r.name, type: r.type, size: r.size };
  }

  #partCount(r: FileRecord): number {
    return Math.max(1, Math.ceil(r.size / r.partBytes));
  }

  #partSize(r: FileRecord, index: number): number {
    const n = this.#partCount(r);
    if (!Number.isInteger(index) || index < 1 || index > n) throw new UploadError("invalid", `part is 1 to ${n}`);
    return index < n ? r.partBytes : r.size - r.partBytes * (n - 1);
  }

  async start(ctx: PageContext, kindName: K, file: { name: string; size: number; type: string }): Promise<{ id: string; partBytes: number; parts: number }> {
    const kind = (this.kinds as Record<string, Readonly<UploadKind>>)[kindName];
    if (!kind) throw new UploadError("invalid", "unknown kind of upload");
    const owner = await this.#owner(ctx, kind);
    if (owner === null) throw new UploadError("forbidden", "sign in to upload files");
    const name = cleanName(file?.name);
    if (!Number.isSafeInteger(file.size) || file.size < 1) throw new UploadError("invalid", "size is the file's size in bytes");
    if (file.size > kind.maxBytes) throw new UploadError("too-large", `files of this kind are at most ${kind.maxBytes} bytes`);
    if (typeof file.type !== "string" || !kind.types.includes(file.type)) throw new UploadError("type", `files of this kind are ${kind.types.join(", ")}`);
    if ((await this.#store.pending(owner)) >= this.#o.maxPending) throw new UploadError("limit", "too many unfinished uploads");
    const id = randomId();
    const upload = await this.#storage.begin(id, file.type);
    const r: FileRecord = { id, kind: kindName, owner, name, type: file.type, size: file.size, partBytes: this.#o.partBytes, status: "uploading", upload, claimed: false, created: this.#o.now() };
    await this.#store.put(r);
    return { id, partBytes: r.partBytes, parts: this.#partCount(r) };
  }

  async part(ctx: PageContext, id: string, index: number): Promise<PartTarget> {
    const r = await this.#mine(ctx, id);
    if (r.status !== "uploading" || r.upload === "") throw new UploadError("invalid", "the upload is finished");
    const size = this.#partSize(r, index);
    const direct = await this.#storage.partTarget(r.id, r.upload, index, size, 900);
    if (direct) return direct;
    const exp = Math.floor(this.#o.now() / 1000) + 900;
    const sig = await this.#sign(`part:${r.id}:${index}:${size}:${r.owner}:${exp}`);
    return { url: `${UPLOADS}${r.id}/${index}?e=${exp}&s=${sig}`, headers: {} };
  }

  async status(ctx: PageContext, id: string): Promise<FileInfo & { parts: number; partBytes: number; received: number[]; ready: boolean }> {
    const r = await this.#mine(ctx, id);
    const received =
      r.status === "ready" ? [] : r.upload === "" ? Array.from({ length: this.#partCount(r) }, (_, i) => i + 1) : (await this.#storage.parts(r.id, r.upload)).filter((p) => p.size === this.#partSizeOr0(r, p.index)).map((p) => p.index);
    return { ...this.#info(r), parts: this.#partCount(r), partBytes: r.partBytes, received, ready: r.status === "ready" };
  }

  #partSizeOr0(r: FileRecord, index: number): number {
    try {
      return this.#partSize(r, index);
    } catch {
      return -1;
    }
  }

  async #head(id: string, size: number): Promise<Uint8Array> {
    const want = Math.min(size, 4096);
    const stream = await this.#storage.read(id, { start: 0, end: want - 1 });
    if (!stream) throw new UploadError("invalid", "the file is missing");
    const chunks: Uint8Array[] = [];
    let got = 0;
    const reader = stream.getReader();
    while (got < want) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
    await reader.cancel().catch(() => {});
    const out = new Uint8Array(Math.min(got, want));
    let off = 0;
    for (const c of chunks) {
      const take = Math.min(c.length, out.length - off);
      out.set(c.subarray(0, take), off);
      off += take;
      if (off >= out.length) break;
    }
    return out;
  }

  async complete(ctx: PageContext, id: string): Promise<FileInfo> {
    const r = await this.#mine(ctx, id);
    if (r.status === "ready") return this.#info(r);
    let size: number;
    if (r.upload !== "") {
      const n = this.#partCount(r);
      const have = new Map((await this.#storage.parts(r.id, r.upload)).map((p) => [p.index, p]));
      const parts: { index: number; etag: string }[] = [];
      for (let i = 1; i <= n; i++) {
        const p = have.get(i);
        if (!p || p.size !== this.#partSize(r, i)) throw new UploadError("invalid", `part ${i} has not arrived`);
        parts.push({ index: i, etag: p.etag });
      }
      size = await this.#storage.complete(r.id, r.upload, parts);
      r.upload = "";
      await this.#store.put(r);
    } else {
      size = (await this.#storage.size(r.id)) ?? -1;
    }
    const reject = async (code: UploadError["code"], message: string): Promise<never> => {
      await this.#storage.remove(r.id).catch(() => {});
      await this.#store.remove(r.id);
      throw new UploadError(code, message);
    };
    if (size !== r.size) await reject("invalid", `the file is ${size} bytes, not ${r.size}`);
    if (!contentMatches(r.type, await this.#head(r.id, r.size))) await reject("type", `the file's content is not ${r.type}`);
    if (this.#o.scan) {
      let verdict: boolean | string;
      try {
        verdict = await this.#o.scan({ ...this.#info(r), read: async () => (await this.#storage.read(r.id)) ?? new ReadableStream() });
      } catch (err) {
        throw new UploadError("limit", `the file could not be scanned yet: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (verdict !== true) await reject("rejected", typeof verdict === "string" ? verdict : "the file was rejected by the scanner");
    }
    r.status = "ready";
    await this.#store.put(r);
    return this.#info(r);
  }

  async abort(ctx: PageContext, id: string): Promise<boolean> {
    let r: FileRecord;
    try {
      r = await this.#mine(ctx, id);
    } catch {
      return false;
    }
    if (r.status !== "uploading") return false;
    if (r.upload === "") await this.#storage.remove(r.id).catch(() => {});
    else await this.#storage.abort(r.id, r.upload).catch(() => {});
    await this.#store.remove(r.id);
    return true;
  }

  async claim(ctx: PageContext, id: string, kind?: K): Promise<FileInfo & { id: FileRef }> {
    const r = await this.#mine(ctx, id);
    if (r.status !== "ready") throw new UploadError("invalid", "the upload is not finished");
    if (kind !== undefined && r.kind !== kind) throw new UploadError("type", `not a ${kind} upload`);
    if (r.claimed) throw new UploadError("invalid", "the file is already in use");
    r.claimed = true;
    r.owner = `claimed:${r.owner}`;
    await this.#store.put(r);
    holdFile(r.id, ctx.user);
    return this.#info(r) as FileInfo & { id: FileRef };
  }

  track(onError: (err: unknown) => void = () => {}): () => void {
    this.#tracking ??= { count: 0, stop: () => {} };
    const t = this.#tracking;
    if (t.count++ === 0) {
      t.stop = onFileRelease((id) => {
        if (KEY_RE.test(id)) this.remove(id).catch(onError);
      });
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (--t.count === 0) t.stop();
    };
  }
  #tracking: { count: number; stop: () => void } | null = null;

  async link(
    id: string | null | undefined,
    o: { ttlSeconds?: number; download?: boolean } = {},
  ): Promise<(FileInfo & { url: string }) | null> {
    const info = typeof id === "string" ? await this.info(id) : null;
    if (!info) return null;
    const url = await this.url(info.id, o);
    return url === null ? null : { ...info, url };
  }

  async info(id: string): Promise<FileInfo | null> {
    const r = typeof id === "string" && KEY_RE.test(id) ? await this.#store.get(id) : null;
    return r && r.status === "ready" ? this.#info(r) : null;
  }

  async remove(id: string): Promise<boolean> {
    const r = typeof id === "string" && KEY_RE.test(id) ? await this.#store.get(id) : null;
    if (!r) return false;
    if (r.status === "uploading" && r.upload !== "") await this.#storage.abort(r.id, r.upload).catch(() => {});
    else await this.#storage.remove(r.id);
    await this.#store.remove(r.id);
    return true;
  }

  async url(id: string | null | undefined, o: { ttlSeconds?: number; download?: boolean } = {}): Promise<string | null> {
    if (typeof id !== "string" || !KEY_RE.test(id)) return null;
    const r = await this.#store.get(id);
    if (!r || r.status !== "ready") return null;
    const ttl = o.ttlSeconds ?? 300;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 7 * 24 * 3600) throw new UploadError("invalid", "ttlSeconds is 1 second to 7 days");
    const disposition = this.#disposition(r, o.download === true);
    if (this.#storage.downloadUrl) return this.#storage.downloadUrl(r.id, { expiresSeconds: ttl, type: r.type, disposition });
    const exp = Math.floor(this.#o.now() / 1000) + ttl;
    const d = o.download ? 1 : 0;
    return `${FILES}${r.id}?e=${exp}&d=${d}&s=${await this.#sign(`file:${r.id}:${exp}:${d}`)}`;
  }

  #disposition(r: FileRecord, download: boolean): string {
    const inline = !download && INLINE.test(r.type);
    const fallback = r.name.replace(/[^\x20-\x7e]|[\\"%;]/g, "_");
    return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(r.name)}`;
  }

  async sweep(limit = 500): Promise<number> {
    sweepHeldFiles();
    const now = this.#o.now();
    let n = 0;
    for (const r of await this.#store.stale(now - this.#o.pendingTtlMs, now - this.#o.unclaimedTtlMs, limit)) {
      try {
        await this.remove(r.id);
        n++;
      } catch {
      }
    }
    return n;
  }

  async handle(ctx: PageContext, req: Request, path: string): Promise<Response> {
    try {
      const rest = path.slice(UPLOADS.length).split("/");
      if (req.method === "PUT" && rest.length === 2) return await this.#putPart(ctx, req, rest[0]!, rest[1]!);
      if (req.method === "GET" && rest.length === 1) return json(200, await this.status(ctx, rest[0]!));
      if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });
      const declared = Number(req.headers.get("content-length") ?? "0");
      if (declared > 4096) return json(413, { ok: false, error: "Request too large" });
      const text = await req.text();
      if (text.length > 4096) return json(413, { ok: false, error: "Request too large" });
      let body: Record<string, unknown> = {};
      if (text) {
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return json(400, { ok: false, error: "Malformed request body" });
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { ok: false, error: "Malformed request body" });
      }
      if (rest.length === 1 && rest[0] === "start") {
        return json(200, await this.start(ctx, body.kind as K, { name: body.name as string, size: body.size as number, type: body.type as string }));
      }
      if (rest.length === 3 && rest[1] === "part") return json(200, await this.part(ctx, rest[0]!, Number(rest[2])));
      if (rest.length === 2 && rest[1] === "complete") return json(200, await this.complete(ctx, rest[0]!));
      if (rest.length === 2 && rest[1] === "abort") return json(200, { ok: await this.abort(ctx, rest[0]!) });
      return json(404, { ok: false, error: "Not found" });
    } catch (err) {
      if (err instanceof UploadError) return json(STATUS[err.code], { ok: false, code: err.code, error: err.message });
      throw err;
    }
  }

  async #putPart(ctx: PageContext, req: Request, id: string, indexText: string): Promise<Response> {
    if (!this.#storage.putPart) return json(404, { ok: false, error: "Not found" });
    const r = await this.#mine(ctx, id);
    if (r.status !== "uploading" || r.upload === "") throw new UploadError("invalid", "the upload is finished");
    const index = /^[1-9][0-9]{0,4}$/.test(indexText) ? Number(indexText) : NaN;
    const size = this.#partSize(r, index);
    const url = new URL(req.url);
    const exp = Number(url.searchParams.get("e"));
    if (!Number.isInteger(exp) || exp < Math.floor(this.#o.now() / 1000) || !(await this.#verify(`part:${r.id}:${index}:${size}:${r.owner}:${exp}`, url.searchParams.get("s")))) {
      throw new UploadError("forbidden", "the part link expired; ask for a new one");
    }
    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) !== size) throw new UploadError("invalid", `part ${index} is ${size} bytes`);
    if (!req.body) throw new UploadError("invalid", `part ${index} is ${size} bytes`);
    await this.#storage.putPart(r.id, r.upload, index, req.body, size);
    return json(200, { ok: true });
  }

  async serve(req: Request, path: string): Promise<Response> {
    const plain = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    if (req.method !== "GET" && req.method !== "HEAD") return plain(405);
    const id = path.slice(FILES.length);
    if (!KEY_RE.test(id)) return plain(404);
    const url = new URL(req.url);
    const exp = Number(url.searchParams.get("e"));
    const d = url.searchParams.get("d") === "1" ? 1 : 0;
    if (url.searchParams.get("d") !== String(d)) return plain(404);
    const now = Math.floor(this.#o.now() / 1000);
    if (!Number.isInteger(exp) || exp < now || !(await this.#verify(`file:${id}:${exp}:${d}`, url.searchParams.get("s")))) return plain(404);
    const r = await this.#store.get(id);
    if (!r || r.status !== "ready") return plain(404);
    const headers: Record<string, string> = {
      "content-type": r.type,
      "content-disposition": this.#disposition(r, d === 1),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": `private, max-age=${Math.max(0, exp - now)}`,
      "accept-ranges": "bytes",
      "referrer-policy": "no-referrer",
    };
    let range: { start: number; end: number } | undefined;
    const want = req.headers.get("range");
    if (want) {
      const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(want.trim());
      let start = m && m[1] !== "" ? Number(m[1]) : NaN;
      let end = m && m[2] !== "" ? Number(m[2]) : r.size - 1;
      if (m && m[1] === "" && m[2] !== "") {
        start = Math.max(0, r.size - Number(m[2]));
        end = r.size - 1;
      }
      end = Math.min(end, r.size - 1);
      if (!m || Number.isNaN(start) || start > end || start >= r.size) {
        return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${r.size}` } });
      }
      range = { start, end };
    }
    const length = range ? range.end - range.start + 1 : r.size;
    headers["content-length"] = String(length);
    if (range) headers["content-range"] = `bytes ${range.start}-${range.end}/${r.size}`;
    if (req.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
    const body = await this.#storage.read(r.id, range);
    if (!body) return plain(404);
    return new Response(body, { status: range ? 206 : 200, headers });
  }
}

export function defineUploads<const K extends string>(o: UploadsOptions<K>): Uploads<K> {
  return new Uploads<K>(o);
}

export { UPLOADS as UPLOADS_PATH, FILES as FILES_PATH };
