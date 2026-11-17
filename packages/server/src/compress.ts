const COMPRESSIBLE = new Set([
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/manifest+json",
  "application/wasm",
  "application/xml",
  "application/atom+xml",
  "application/rss+xml",
  "image/svg+xml",
  "text/javascript",
]);

export interface CompressOptions {
  minBytes?: number;
}

function mediaType(res: Response): string {
  return (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

export function compressibleType(type: string): boolean {
  if (type === "text/event-stream") {
    return false;
  }
  return type.startsWith("text/") || COMPRESSIBLE.has(type) || type.endsWith("+json") || type.endsWith("+xml");
}

export function acceptsGzip(header: string | null): boolean {
  if (!header) {
    return false;
  }
  let star: boolean | null = null;
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) {
        q = Number(m[1]);
      }
    }
    if (name.trim() === "gzip") {
      return q > 0;
    }
    if (name.trim() === "*") {
      star = q > 0;
    }
  }
  return star === true;
}

export function compress(req: Request, res: Response, opts: CompressOptions = {}): Response {
  const type = mediaType(res);
  if (
    !compressibleType(type) ||
    res.body === null ||
    req.method === "HEAD" ||
    res.status < 200 ||
    res.status === 204 ||
    res.status === 206 ||
    res.status === 304 ||
    res.headers.has("content-encoding") ||
    /\bno-transform\b/i.test(res.headers.get("cache-control") ?? "") ||
    res.headers.get("x-accel-buffering") === "no"
  ) {
    return res;
  }
  const headers = new Headers(res.headers);
  const vary = headers.get("vary");
  if (!vary || !/(^|,)\s*(accept-encoding|\*)\s*(,|$)/i.test(vary)) {
    headers.set("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
  }
  const length = res.headers.get("content-length");
  const small = length !== null && Number(length) < (opts.minBytes ?? 1024);
  const Stream = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (small || !Stream || !acceptsGzip(req.headers.get("accept-encoding"))) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  headers.set("content-encoding", "gzip");
  headers.delete("content-length");
  const etag = headers.get("etag");
  if (etag && !etag.startsWith("W/")) {
    headers.set("etag", `W/${etag}`);
  }
  const body = res.body.pipeThrough(new Stream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}
