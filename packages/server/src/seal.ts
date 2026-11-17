import type { Grant } from "@weft/data";
import type { PageContext } from "./context.ts";
import { base64url, fromBase64url, macBytes, type Key } from "./security.ts";

export interface SealOptions {
  purpose: string;
  ttlMs?: number;
  session?: boolean;
}

export interface UnsealOptions {
  purpose: string;
  session?: boolean;
}

const DAY = 24 * 60 * 60 * 1000;
const PURPOSE = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_TOKEN = 8192;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function checkPurpose(purpose: string): void {
  if (typeof purpose !== "string" || !PURPOSE.test(purpose)) {
    throw new Error("seal: purpose is 1-64 letters, digits, `_`, `-` or `.`");
  }
}

function tagInput(purpose: string, sid: string | null, body: string): string {
  return `seal:${purpose}:${sid ?? ""}:${body}`;
}

export async function sealWith(key: Key, value: unknown, opts: SealOptions, sid: string | null = null): Promise<string> {
  checkPurpose(opts.purpose);
  const ttl = opts.ttlMs ?? DAY;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("seal: ttlMs is a positive number of milliseconds");
  }
  const json = JSON.stringify({ v: value, e: Date.now() + ttl });
  if (value === undefined || json === undefined) {
    throw new Error("seal: the value must be JSON");
  }
  const body = base64url(enc.encode(json));
  const token = `${body}.${base64url(await macBytes(key, tagInput(opts.purpose, sid, body)))}`;
  if (token.length > MAX_TOKEN) {
    throw new Error(`seal: the sealed value is over ${MAX_TOKEN} characters`);
  }
  return token;
}

export async function openWith(
  key: Key,
  token: string | null | undefined,
  opts: UnsealOptions,
  sid: string | null = null,
): Promise<{ value: unknown; expires: number } | null> {
  checkPurpose(opts.purpose);
  if (typeof token !== "string" || token.length > MAX_TOKEN) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || token.indexOf(".", dot + 1) !== -1) return null;
  const body = token.slice(0, dot);
  const tag = fromBase64url(token.slice(dot + 1));
  const expected = await macBytes(key, tagInput(opts.purpose, sid, body));
  if (!tag || tag.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < tag.length; i++) diff |= tag[i] ^ expected[i];
  if (diff !== 0) return null;
  const raw = fromBase64url(body);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(raw));
  } catch {
    return null;
  }
  const p = parsed as { v?: unknown; e?: unknown };
  if (typeof p !== "object" || p === null || typeof p.e !== "number" || !(p.e > Date.now())) return null;
  return { value: p.v, expires: p.e };
}

export interface SealControl {
  key(): Promise<Key>;
  session(): string;
}

const controls = new WeakMap<PageContext, SealControl>();

export function attachSeal(ctx: PageContext, control: SealControl): void {
  controls.set(ctx, control);
}

function control(ctx: PageContext): SealControl {
  const c = controls.get(ctx);
  if (!c) throw new Error("@weft/server: seal/unseal need the context of a request being handled");
  return c;
}

export async function seal(ctx: PageContext, value: unknown, opts: SealOptions): Promise<string> {
  const c = control(ctx);
  return sealWith(await c.key(), value, opts, opts.session ? c.session() : null);
}

export async function unseal(ctx: PageContext, token: string | null | undefined, opts: UnsealOptions): Promise<unknown> {
  const c = control(ctx);
  const out = await openWith(await c.key(), token, opts, opts.session ? c.session() : null);
  return out?.value;
}

const GRANT = "weft.grant";

export interface GrantOptions {
  ttlMs?: number;
  session?: boolean;
}

export async function grantToken(
  ctx: PageContext,
  model: string | { name: string },
  key: string | number,
  rights: "read" | "write",
  opts: GrantOptions = {},
): Promise<string> {
  if (rights !== "read" && rights !== "write") throw new Error(`grant rights are "read" or "write"`);
  if (typeof key !== "string" && !(typeof key === "number" && Number.isFinite(key))) {
    throw new Error("grant: the key is a string or a finite number");
  }
  const name = typeof model === "string" ? model : model.name;
  return seal(ctx, { m: name, k: key, r: rights }, { purpose: GRANT, ttlMs: opts.ttlMs, session: opts.session });
}

export async function acceptGrant(
  ctx: PageContext,
  token: string | null | undefined,
  opts: { session?: boolean } = {},
): Promise<Grant | null> {
  const c = control(ctx);
  const out = await openWith(await c.key(), token, { purpose: GRANT, session: opts.session }, opts.session ? c.session() : null);
  if (!out) return null;
  const g = out.value as { m?: unknown; k?: unknown; r?: unknown };
  if (
    typeof g !== "object" ||
    g === null ||
    typeof g.m !== "string" ||
    !(typeof g.k === "string" || typeof g.k === "number") ||
    (g.r !== "read" && g.r !== "write")
  ) {
    return null;
  }
  return { model: g.m, key: g.k, rights: g.r, expires: out.expires };
}
