import type { PageContext } from "./context.ts";

export { Redirect, redirect } from "./live.ts";
export type { PageContext };

export type ParamType = "string" | "number" | "boolean" | "file" | "record";

const RECORD_KEYS = 200;
const RECORD_KEY = /^[^\[\]\u0000-\u001f]{1,200}$/;

export interface ParamSpec {
  name: string;
  type: ParamType;
  list?: boolean;
  optional?: boolean;
  held?: boolean;
}

export type ActionContext = PageContext;

const ACTION = Symbol.for("weft.action");
const BOUND = Symbol.for("weft.boundAction");

export interface Action<A extends unknown[] = never[], R = unknown> {
  readonly [ACTION]: true;
  readonly name: string;
  readonly params: readonly ParamSpec[];
  run(ctx: ActionContext, ...args: A): R | Promise<R>;
  with(...held: unknown[]): BoundAction;
}

export interface BoundAction {
  readonly [BOUND]: true;
  readonly name: string;
  readonly args: readonly unknown[];
}

export function heldCount(params: readonly ParamSpec[]): number {
  let n = 0;
  while (n < params.length && params[n]!.held) n++;
  return n;
}

export function defineAction<A extends unknown[], R>(
  name: string,
  params: readonly ParamSpec[],
  run: (ctx: ActionContext, ...args: A) => R | Promise<R>,
): Action<A, R> {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    throw new Error(`@weft-framework/server: invalid action name: ${name}`);
  }
  const seen = new Set<string>();
  for (const p of params) {
    if (seen.has(p.name) || p.name.startsWith("_weft")) {
      throw new Error(`@weft-framework/server: action ${name}: bad parameter ${p.name}`);
    }
    seen.add(p.name);
  }
  const held = heldCount(params);
  if (params.slice(0, held).some((p) => p.type === "file")) {
    throw new Error(`@weft-framework/server: action ${name}: a held parameter cannot be a file`);
  }
  if (params.slice(held).some((p) => p.held) || params.slice(0, held).some((p) => p.optional)) {
    throw new Error(`@weft-framework/server: action ${name}: held parameters come first and are never optional`);
  }
  const specs = Object.freeze(params.map((p) => Object.freeze({ ...p })));
  const bind = (...args: unknown[]): BoundAction => {
    if (held === 0) throw new Error(`@weft-framework/server: ${name}.with(..): the action has no Held<T> parameters`);
    if (args.length !== held) throw new Error(`@weft-framework/server: ${name}.with(..): expected ${held} held value(s), got ${args.length}`);
    const checked = decodeJson(specs.slice(0, held), Object.fromEntries(specs.slice(0, held).map((p, i) => [p.name, args[i]])));
    if (!checked.ok) throw new Error(`@weft-framework/server: ${name}.with(..): ${checked.error}`);
    return Object.freeze({ [BOUND]: true as const, name, args: Object.freeze(checked.args) });
  };
  return Object.freeze({ [ACTION]: true as const, name, params: specs, run, with: bind });
}

export function isAction(v: unknown): v is Action<unknown[]> {
  return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[ACTION] === true;
}

export class ActionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function fail(message: string, status = 400): never {
  throw new ActionError(message, status);
}

export type Decoded = { ok: true; args: unknown[] } | { ok: false; error: string };

export function decodeForm(params: readonly ParamSpec[], form: FormData | URLSearchParams): Decoded {
  const args: unknown[] = [];
  for (const p of params) {
    if (p.type === "record") {
      const rec = decodeRecord(p.name, form);
      if (typeof rec === "string") return { ok: false, error: rec };
      args.push(rec);
      continue;
    }
    const raw = form.getAll(p.name);
    if (p.type === "file") {
      if (raw.some((v) => typeof v === "string")) {
        return { ok: false, error: `${p.name}: expected a file upload` };
      }
      const files = (raw as unknown as File[]).filter((f) => f.size > 0 || f.name !== "");
      if (p.list) {
        args.push(files);
      } else if (files.length === 0) {
        if (!p.optional) return { ok: false, error: `${p.name} is required` };
        args.push(undefined);
      } else {
        args.push(files[0]);
      }
      continue;
    }
    if (raw.some((v) => typeof v !== "string")) {
      return { ok: false, error: `${p.name}: files are not accepted` };
    }
    const values = raw as string[];
    if (p.type === "boolean" && !p.list) {
      args.push(values.length > 0 && !["false", "0", "off"].includes(values[0]));
      continue;
    }
    if (p.list) {
      const out: unknown[] = [];
      for (const v of values) {
        const one = fromString(p, v);
        if (one === INVALID) {
          return { ok: false, error: `${p.name}: expected ${p.type} values` };
        }
        out.push(one);
      }
      args.push(out);
      continue;
    }
    const v = values[0];
    if (v === undefined || (v === "" && p.type !== "string")) {
      if (!p.optional) {
        return { ok: false, error: `${p.name} is required` };
      }
      args.push(undefined);
      continue;
    }
    const one = fromString(p, v);
    if (one === INVALID) {
      return { ok: false, error: `${p.name}: expected a ${p.type}` };
    }
    args.push(one);
  }
  return { ok: true, args };
}

const INVALID = Symbol("invalid");

function decodeRecord(name: string, form: FormData | URLSearchParams): Record<string, string> | string {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  const prefix = `${name}[`;
  for (const [field, value] of form.entries()) {
    if (!field.startsWith(prefix) || !field.endsWith("]")) continue;
    const key = field.slice(prefix.length, -1);
    if (!RECORD_KEY.test(key)) return `${name}: invalid key`;
    if (typeof value !== "string") return `${name}: files are not accepted`;
    if (seen.has(key)) return `${name}[${key}] is given twice`;
    seen.add(key);
    if (seen.size > RECORD_KEYS) return `${name}: at most ${RECORD_KEYS} entries`;
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return entries.length <= RECORD_KEYS && entries.every(([k, x]) => RECORD_KEY.test(k) && typeof x === "string");
}

function fromString(p: ParamSpec, v: string): unknown {
  switch (p.type) {
    case "file":
    case "record":
      return INVALID;
    case "string":
      return v;
    case "number": {
      const n = v.trim() === "" ? NaN : Number(v);
      return Number.isFinite(n) ? n : INVALID;
    }
    case "boolean":
      return v === "true" ? true : v === "false" ? false : INVALID;
  }
}

export function decodeJson(params: readonly ParamSpec[], body: unknown): Decoded {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "expected an object of arguments" };
  }
  const obj = body as Record<string, unknown>;
  const known = new Set(params.map((p) => p.name));
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) {
      return { ok: false, error: `unknown argument ${k}` };
    }
  }
  const args: unknown[] = [];
  for (const p of params) {
    const v = Object.hasOwn(obj, p.name) ? obj[p.name] : undefined;
    if (p.type === "file" && v !== undefined && v !== null) {
      return { ok: false, error: `${p.name}: files are sent as a multipart form, not JSON` };
    }
    if (v === undefined || v === null) {
      if (!p.optional) {
        return { ok: false, error: `${p.name} is required` };
      }
      args.push(undefined);
      continue;
    }
    const ok = p.list ? Array.isArray(v) && v.every((x) => isType(p.type, x)) : isType(p.type, v);
    if (!ok) {
      return { ok: false, error: `${p.name}: expected ${p.list ? `${p.type}[]` : p.type}` };
    }
    args.push(p.list ? [...(v as unknown[])] : v);
  }
  return { ok: true, args };
}

function isType(t: ParamType, v: unknown): boolean {
  if (t === "file") return false;
  if (t === "record") return isRecord(v);
  return t === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === t;
}
