export interface MiddlewareContext {
  request: Request;
  url: URL;
  session: string | null;
  user: unknown;
}

export type MiddlewareResult =
  | void
  | null
  | Response
  | { headers?: Record<string, string> | Headers; rewrite?: string };

export function safeRewrite(path: unknown): string | null {
  if (typeof path !== "string" || path.length > 2048 || !/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/.test(path)) {
    return null;
  }
  if (path.includes("//") || /(^|\/)\.\.?(\/|$)/.test(path) || path === "/_weft" || path.startsWith("/_weft/")) {
    return null;
  }
  return path;
}

export type Middleware = (ctx: MiddlewareContext) => MiddlewareResult | Promise<MiddlewareResult>;

const BLOCKED = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "x-frame-options",
  "x-content-type-options",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "set-cookie",
  "set-cookie2",
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "location",
  "trailer",
  "upgrade",
  "te",
]);

const NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

export function safeHeaders(input: Record<string, string> | Headers | undefined): [string, string][] {
  if (!input) {
    return [];
  }
  const entries = input instanceof Headers ? [...input.entries()] : Object.entries(input);
  const out: [string, string][] = [];
  for (const [rawName, rawValue] of entries) {
    if (out.length >= 32) {
      break;
    }
    if (typeof rawValue !== "string") {
      continue;
    }
    const name = rawName.toLowerCase();
    if (!NAME.test(name) || BLOCKED.has(name) || rawValue.length > 512 || /[\r\n\0]/.test(rawValue)) {
      continue;
    }
    out.push([name, rawValue]);
  }
  return out;
}

export async function runMiddleware(
  mw: Middleware | readonly Middleware[] | undefined,
  ctx: MiddlewareContext,
): Promise<{ response?: Response; headers: [string, string][]; rewrite?: string }> {
  if (!mw) {
    return { headers: [] };
  }
  const list = Array.isArray(mw) ? mw : [mw];
  const headers: [string, string][] = [];
  let rewrite: string | undefined;
  for (const fn of list) {
    if (typeof fn !== "function") {
      throw new Error("@weft/server: middleware must be a function");
    }
    const result = await fn(ctx);
    if (result instanceof Response) {
      return { response: result, headers };
    }
    if (result && typeof result === "object") {
      if ("headers" in result) headers.push(...safeHeaders(result.headers));
      if ("rewrite" in result) rewrite = safeRewrite(result.rewrite) ?? rewrite;
    }
  }
  return rewrite === undefined ? { headers: headers.slice(0, 32) } : { headers: headers.slice(0, 32), rewrite };
}

export function withExtraHeaders(res: Response, extra: readonly (readonly [string, string])[]): Response {
  if (extra.length === 0) {
    return res;
  }
  const headers = copyHeaders(res.headers);
  for (const [name, value] of extra) {
    if (!headers.has(name)) {
      headers.append(name, value);
    }
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function copyHeaders(src: Headers): Headers {
  const headers = new Headers();
  src.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") {
      headers.set(name, value);
    }
  });
  for (const cookie of src.getSetCookie?.() ?? []) {
    headers.append("set-cookie", cookie);
  }
  return headers;
}
