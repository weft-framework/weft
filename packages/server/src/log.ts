import { Secret } from "./secret.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_REDACT = /pass(word|phrase)?|secret|token|authori[sz]ation|cookie|api[-_]?key|private[-_]?key|credential/i;
const MAX_DEPTH = 6;
const MAX_STRING = 4096;
const MAX_KEYS = 100;

export interface LoggerOptions {
  level?: LogLevel;
  write?(line: string, level: LogLevel): void;
  redactKeys?: RegExp;
  base?: Record<string, unknown>;
  now?(): number;
}

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function redact(value: unknown, keys: RegExp = DEFAULT_REDACT): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (v instanceof Secret) return "[secret]";
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
    if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}...[${v.length - MAX_STRING} more]` : v;
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "undefined" || typeof v === "function" || typeof v === "symbol") return undefined;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
    if (v instanceof Uint8Array || v instanceof ArrayBuffer) return `[${v.byteLength} bytes]`;
    if (typeof v !== "object") return undefined;
    if (seen.has(v)) return "[circular]";
    if (depth >= MAX_DEPTH) return "[object]";
    seen.add(v);
    try {
      if (v instanceof Error) {
        const out: Record<string, unknown> = { name: v.name, message: walk(v.message, depth + 1) };
        if (v.stack) out.stack = walk(v.stack, depth + 1);
        if ("code" in v) out.code = walk((v as { code: unknown }).code, depth + 1);
        if (v.cause !== undefined) out.cause = walk(v.cause, depth + 1);
        return out;
      }
      if (Array.isArray(v)) {
        const list = v.slice(0, MAX_KEYS).map((x) => walk(x, depth + 1) ?? null);
        if (v.length > MAX_KEYS) list.push(`[${v.length - MAX_KEYS} more]`);
        return list;
      }
      if (v instanceof Map) return walk(Object.fromEntries([...v].slice(0, MAX_KEYS).map(([k, x]) => [String(k), x])), depth);
      if (v instanceof Set) return walk([...v], depth);
      const out: Record<string, unknown> = {};
      let n = 0;
      for (const k of Object.keys(v)) {
        if (++n > MAX_KEYS) {
          out["..."] = `${Object.keys(v).length - MAX_KEYS} more keys`;
          break;
        }
        keys.lastIndex = 0;
        if (keys.test(k)) {
          out[k] = "[redacted]";
          continue;
        }
        let x: unknown;
        try {
          x = (v as Record<string, unknown>)[k];
        } catch {
          x = "[unreadable]";
        }
        const w = walk(x, depth + 1);
        if (w !== undefined) out[k] = w;
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return walk(value, 0);
}

export function createLogger(o: LoggerOptions = {}): Logger {
  const level = o.level ?? "info";
  if (!(level in RANK)) throw new Error(`createLogger: level is debug, info, warn or error`);
  const keys = o.redactKeys ?? DEFAULT_REDACT;
  if (!(keys instanceof RegExp)) throw new Error("createLogger: redactKeys is a regular expression");
  const write =
    o.write ??
    ((line: string, l: LogLevel) => {
      if (l === "error") console.error(line);
      else console.log(line);
    });
  const now = o.now ?? Date.now;
  const make = (base: Record<string, unknown>): Logger => {
    const emit = (l: LogLevel, msg: string, fields?: Record<string, unknown>) => {
      if (RANK[l] < RANK[level]) return;
      try {
        const body = redact({ ...base, ...fields }, keys) as Record<string, unknown>;
        const head: Record<string, unknown> = { time: new Date(now()).toISOString(), level: l, msg: String(msg) };
        const clash: Record<string, unknown> = {};
        for (const k of Object.keys(head)) {
          if (k in body) {
            clash[k] = body[k];
            delete body[k];
          }
        }
        const line = JSON.stringify({ ...head, ...body, ...(Object.keys(clash).length ? { fields: clash } : {}) });
        write(line, l);
      } catch {
      }
    };
    return {
      level,
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (fields) => make({ ...base, ...fields }),
    };
  };
  return make({ ...(o.base ?? {}) });
}

const ids = new WeakMap<Request, string>();
const INCOMING_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function assignRequestId(req: Request, trustIncoming: boolean): string {
  const incoming = req.headers.get("x-request-id");
  const id =
    trustIncoming && incoming && INCOMING_ID.test(incoming)
      ? incoming
      : Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  ids.set(req, id);
  return id;
}

export function requestIdOf(req: Request): string | null {
  return ids.get(req) ?? null;
}
