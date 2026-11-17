import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { splitPath } from "./router.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
};

export interface PublicFilesOptions {
  cacheControl?: string;
}

export type FileHandler = (path: string, req: Request) => Promise<Response | null>;

const HASHED = /^(.*)\.([a-f0-9]{16})(\.[a-z0-9]{1,8})?$/i;
const IMMUTABLE = "public, max-age=31536000, immutable";
const hashes = new Map<string, { sig: string; hash: string }>();

async function contentHash(file: string, size: number, mtimeMs: number): Promise<string> {
  const sig = `${size}:${mtimeMs}`;
  const hit = hashes.get(file);
  if (hit?.sig === sig) {
    return hit.hash;
  }
  const hash = await new Promise<string>((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("end", () => resolve(digest.digest("hex").slice(0, 16)));
  });
  hashes.set(file, { sig, hash });
  if (hashes.size > 10_000) {
    const oldest = hashes.keys().next().value;
    if (oldest !== undefined) {
      hashes.delete(oldest);
    }
  }
  return hash;
}

export function publicFiles(dir: string, opts: PublicFilesOptions = {}): FileHandler {
  const cacheControl = opts.cacheControl ?? "public, max-age=0, must-revalidate";
  let rootP: Promise<string | null> | null = null;
  const root = () => (rootP ??= realpath(dir).catch(() => null));

  return async (path, req) => {
    const requested = splitPath(path);
    if (!requested || requested.length === 0) {
      return null;
    }
    for (const [i, p] of requested.entries()) {
      if (p.includes("/") || p.includes("\\") || (p.startsWith(".") && !(i === 0 && p === ".well-known"))) {
        return null;
      }
    }
    let parts = requested;
    let fingerprint: string | null = null;
    const hashed = HASHED.exec(requested[requested.length - 1]);
    if (hashed && hashed[1] !== "") {
      fingerprint = hashed[2].toLowerCase();
      parts = requested.slice(0, -1).concat(hashed[1] + (hashed[3] ?? ""));
    }
    const base = await root();
    if (!base) {
      return null;
    }
    let file: string;
    try {
      file = await realpath(join(base, ...parts));
    } catch {
      return null;
    }
    if (!file.startsWith(base + sep)) {
      return null;
    }
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) {
      return null;
    }

    if (fingerprint !== null && (await contentHash(file, st.size, st.mtimeMs)) !== fingerprint) {
      return null;
    }
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = new Headers({
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": String(st.size),
      "cache-control": fingerprint ? IMMUTABLE : cacheControl,
      etag,
      "last-modified": st.mtime.toUTCString(),
      "x-content-type-options": "nosniff",
    });
    if (extname(file).toLowerCase() === ".svg") {
      headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    const inm = req.headers.get("if-none-match");
    if (inm && inm.split(",").some((t) => t.trim() === etag)) {
      headers.delete("content-length");
      return new Response(null, { status: 304, headers });
    }
    if (req.method === "HEAD") {
      return new Response(null, { headers });
    }
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
    return new Response(body, { headers });
  };
}

export async function assetManifest(dir: string): Promise<Record<string, string>> {
  const base = await realpath(dir).catch(() => null);
  if (!base) {
    return {};
  }
  const out: Record<string, string> = {};
  const walk = async (rel: string[], realDir: string): Promise<void> => {
    for (const name of (await readdir(realDir)).sort()) {
      if (name.includes("\0") || name.includes("/") || name.includes("\\")) {
        continue;
      }
      if (name.startsWith(".") && !(rel.length === 0 && name === ".well-known")) {
        continue;
      }
      const child = join(realDir, name);
      const st = await stat(child).catch(() => null);
      if (!st) {
        continue;
      }
      if (st.isDirectory()) {
        const next = await realpath(child).catch(() => null);
        if (!next || !next.startsWith(base + sep)) {
          continue;
        }
        await walk([...rel, name], next);
        continue;
      }
      if (!st.isFile()) {
        continue;
      }
      const file = await realpath(child).catch(() => null);
      if (!file || !file.startsWith(base + sep)) {
        continue;
      }
      const hash = await contentHash(file, st.size, st.mtimeMs);
      const dot = name.lastIndexOf(".");
      const hashed = dot > 0 ? `${name.slice(0, dot)}.${hash}${name.slice(dot)}` : `${name}.${hash}`;
      out["/" + [...rel, name].join("/")] = "/" + [...rel, hashed].join("/");
    }
  };
  await walk([], base);
  return out;
}
