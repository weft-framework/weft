import { isSafePath } from "@weft/runtime";
import type { PageContext } from "./context.ts";

export type ApiMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export type ApiHandler = (ctx: PageContext) => Response | Promise<Response>;

const EXTERNAL = Symbol.for("weft.api.external");

export function external(handler: ApiHandler): ApiHandler {
  if (typeof handler !== "function") throw new Error("external: wraps an API handler function");
  const fn: ApiHandler = (ctx) => handler(ctx);
  Object.defineProperty(fn, EXTERNAL, { value: true });
  return fn;
}

export function isExternal(handler: ApiHandler): boolean {
  return Object.hasOwn(handler, EXTERNAL) && (handler as unknown as Record<symbol, unknown>)[EXTERNAL] === true;
}

export interface ApiHandlers {
  GET?: ApiHandler;
  HEAD?: ApiHandler;
  POST?: ApiHandler;
  PUT?: ApiHandler;
  PATCH?: ApiHandler;
  DELETE?: ApiHandler;
  OPTIONS?: ApiHandler;
  default?: ApiHandler;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const KNOWN = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE.has(method);
}

export function isApiMethod(method: string): method is ApiMethod {
  return KNOWN.has(method);
}

export function handlerFor(handlers: ApiHandlers, method: string): ApiHandler | undefined {
  const specific = (handlers as Record<string, ApiHandler | undefined>)[method];
  if (specific) {
    return specific;
  }
  if (method === "HEAD" && handlers.GET) {
    return handlers.GET;
  }
  return handlers.default;
}

export function allowHeader(handlers: ApiHandlers): string {
  const methods: string[] = [];
  const has = (method: ApiMethod) => handlers[method] !== undefined || handlers.default !== undefined;
  if (has("GET")) {
    methods.push("GET");
  }
  if (handlers.HEAD || has("GET")) {
    methods.push("HEAD");
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    if (has(method)) {
      methods.push(method);
    }
  }
  methods.push("OPTIONS");
  return methods.join(", ");
}

export function safeLocation(location: string, ownOrigin: string): boolean {
  if (location.length === 0 || location.length > 2048 || /[\r\n\0]/.test(location) || location.includes("\\")) {
    return false;
  }
  if (isSafePath(location)) {
    return true;
  }
  try {
    const url = new URL(location);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === ownOrigin &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function guardApiResponse(res: Response, ownOrigin: string): Response | null {
  const location = res.headers.get("location");
  if (location !== null && !safeLocation(location, ownOrigin)) {
    return null;
  }
  return res;
}
