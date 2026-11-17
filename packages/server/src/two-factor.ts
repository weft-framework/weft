import type { SqlDatabase } from "@weft/data";
import { authState, completeTwoFactor, type SecondFactor } from "./auth.ts";
import type { PageContext } from "./context.ts";
import { seal, unseal } from "./seal.ts";
import { isSecret, type Secret } from "./secret.ts";
import { base64url, fromBase64url, MIN_SECRET_LENGTH } from "./security.ts";

type Maybe<T> = T | Promise<T>;

export interface TwoFactorRecord {
  user: string;
  secret: string;
  lastStep: number;
  failures: number;
  lockedUntil: number;
  created: number;
}

export interface TwoFactorStore {
  get(user: string): Maybe<TwoFactorRecord | null | undefined>;
  add(r: TwoFactorRecord): Maybe<boolean>;
  remove(user: string): Maybe<boolean>;
  advance(user: string, step: number): Maybe<boolean>;
  fail(user: string, max: number, until: number): Maybe<boolean>;
  succeed(user: string): Maybe<void>;
  setRecovery(user: string, hashes: string[]): Maybe<void>;
  useRecovery(user: string, hash: string): Maybe<boolean>;
  countRecovery(user: string): Maybe<number>;
}

export class MemoryTwoFactorStore implements TwoFactorStore {
  readonly #records = new Map<string, TwoFactorRecord>();
  readonly #recovery = new Map<string, Set<string>>();

  get(user: string): TwoFactorRecord | null {
    const r = this.#records.get(user);
    return r ? { ...r } : null;
  }
  add(r: TwoFactorRecord): boolean {
    if (this.#records.has(r.user)) return false;
    this.#records.set(r.user, { ...r });
    return true;
  }
  remove(user: string): boolean {
    this.#recovery.delete(user);
    return this.#records.delete(user);
  }
  advance(user: string, step: number): boolean {
    const r = this.#records.get(user);
    if (!r || r.lastStep >= step) return false;
    r.lastStep = step;
    r.failures = 0;
    return true;
  }
  fail(user: string, max: number, until: number): boolean {
    const r = this.#records.get(user);
    if (!r) return false;
    r.failures++;
    if (r.failures < max) return false;
    r.failures = 0;
    r.lockedUntil = until;
    return true;
  }
  succeed(user: string): void {
    const r = this.#records.get(user);
    if (r) r.failures = 0;
  }
  setRecovery(user: string, hashes: string[]): void {
    this.#recovery.set(user, new Set(hashes));
  }
  useRecovery(user: string, hash: string): boolean {
    return this.#recovery.get(user)?.delete(hash) ?? false;
  }
  countRecovery(user: string): number {
    return this.#recovery.get(user)?.size ?? 0;
  }
}

export class SqlTwoFactorStore implements TwoFactorStore {
  readonly #db: SqlDatabase;
  readonly #t: string;
  readonly #r: string;

  constructor(db: SqlDatabase, table = "weft_two_factor") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`@weft/server: not a valid table name: ${table}`);
    this.#db = db;
    this.#t = `"${table}"`;
    this.#r = `"${table}_recovery"`;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#t} (user_id TEXT PRIMARY KEY NOT NULL, secret TEXT NOT NULL, ` +
        `last_step INTEGER NOT NULL, failures INTEGER NOT NULL, locked_until INTEGER NOT NULL, created INTEGER NOT NULL)`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#r} (user_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (user_id, hash))`,
    );
  }

  get(user: string): TwoFactorRecord | null {
    const row = this.#db
      .prepare(`SELECT secret, last_step, failures, locked_until, created FROM ${this.#t} WHERE user_id = ?`)
      .all(user)[0] as Record<string, string | number | bigint> | undefined;
    if (!row) return null;
    return {
      user,
      secret: String(row.secret),
      lastStep: Number(row.last_step),
      failures: Number(row.failures),
      lockedUntil: Number(row.locked_until),
      created: Number(row.created),
    };
  }
  add(r: TwoFactorRecord): boolean {
    const added = this.#db
      .prepare(
        `INSERT INTO ${this.#t} (user_id, secret, last_step, failures, locked_until, created) VALUES (?, ?, ?, ?, ?, ?) ` +
          `ON CONFLICT(user_id) DO NOTHING RETURNING user_id`,
      )
      .all(r.user, r.secret, r.lastStep, r.failures, r.lockedUntil, r.created);
    return added.length === 1;
  }
  remove(user: string): boolean {
    this.#db.prepare(`DELETE FROM ${this.#r} WHERE user_id = ?`).run(user);
    return this.#db.prepare(`DELETE FROM ${this.#t} WHERE user_id = ? RETURNING user_id`).all(user).length === 1;
  }
  advance(user: string, step: number): boolean {
    return (
      this.#db
        .prepare(`UPDATE ${this.#t} SET last_step = ?, failures = 0 WHERE user_id = ? AND last_step < ? RETURNING user_id`)
        .all(step, user, step).length === 1
    );
  }
  fail(user: string, max: number, until: number): boolean {
    const row = this.#db
      .prepare(
        `UPDATE ${this.#t} SET failures = CASE WHEN failures + 1 >= ? THEN 0 ELSE failures + 1 END, ` +
          `locked_until = CASE WHEN failures + 1 >= ? THEN ? ELSE locked_until END WHERE user_id = ? ` +
          `RETURNING failures, locked_until`,
      )
      .all(max, max, until, user)[0] as { failures: number | bigint; locked_until: number | bigint } | undefined;
    return row !== undefined && Number(row.failures) === 0 && Number(row.locked_until) === until;
  }
  succeed(user: string): void {
    this.#db.prepare(`UPDATE ${this.#t} SET failures = 0 WHERE user_id = ?`).run(user);
  }
  setRecovery(user: string, hashes: string[]): void {
    this.#db.prepare(`DELETE FROM ${this.#r} WHERE user_id = ?`).run(user);
    const add = this.#db.prepare(`INSERT INTO ${this.#r} (user_id, hash) VALUES (?, ?)`);
    for (const h of hashes) add.run(user, h);
  }
  useRecovery(user: string, hash: string): boolean {
    return this.#db.prepare(`DELETE FROM ${this.#r} WHERE user_id = ? AND hash = ? RETURNING hash`).all(user, hash).length === 1;
  }
  countRecovery(user: string): number {
    const row = this.#db.prepare(`SELECT count(*) AS n FROM ${this.#r} WHERE user_id = ?`).all(user)[0] as { n: number | bigint };
    return Number(row.n);
  }
}

export type TwoFactorErrorCode = "signed-out" | "invalid" | "expired" | "conflict" | "locked" | "required" | "not-enrolled";

export class TwoFactorError extends Error {
  readonly code: TwoFactorErrorCode;
  readonly until?: number;
  constructor(code: TwoFactorErrorCode, message: string, until?: number) {
    super(message);
    this.name = "TwoFactorError";
    this.code = code;
    if (until !== undefined) this.until = until;
  }
}

export interface TwoFactorOptions {
  key: Secret | string;
  issuer: string;
  page: string;
  require?(user: string, tenant?: string): Maybe<boolean>;
  store?: TwoFactorStore;
  digits?: 6 | 8;
  window?: number;
  maxAttempts?: number;
  lockMs?: number;
  recoveryCodes?: number;
  now?: () => number;
}

export interface TwoFactorSetup {
  secret: string;
  uri: string;
  state: string;
}

export interface TwoFactorStatus {
  user: string;
  pending: boolean;
  enabled: boolean;
  required: boolean;
  mfa: boolean;
  recoveryLeft: number;
}

const STEP_MS = 30_000;
const SETUP_TTL_MS = 10 * 60_000;
const SECRET_BYTES = 20;
const RECOVERY = "0123456789abcdefghjkmnpqrstvwxyz";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const enc = new TextEncoder();

export function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Uint8Array | null {
  const clean = s.toUpperCase().replace(/[\s=]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function totp(secret: Uint8Array, step: number, digits: 6 | 8 = 6): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = mac[19] & 15;
  const n = (((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3]) % 10 ** digits;
  return String(n).padStart(digits, "0");
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export class TwoFactor implements SecondFactor {
  readonly page: string;
  readonly #issuer: string;
  readonly #store: TwoFactorStore;
  readonly #require: TwoFactorOptions["require"];
  readonly #digits: 6 | 8;
  readonly #window: number;
  readonly #max: number;
  readonly #lockMs: number;
  readonly #codes: number;
  readonly #now: () => number;
  readonly #keys: Promise<{ aes: CryptoKey; mac: CryptoKey }>;

  constructor(o: TwoFactorOptions) {
    const raw = isSecret(o.key) ? o.key.reveal() : o.key;
    if (typeof raw !== "string" || raw.length < MIN_SECRET_LENGTH) {
      throw new Error(`defineTwoFactor: \`key\` must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    if (typeof o.issuer !== "string" || o.issuer.trim() === "" || o.issuer.length > 64 || o.issuer.includes(":")) {
      throw new Error("defineTwoFactor: `issuer` is the app's name, 1-64 characters without ':'");
    }
    if (typeof o.page !== "string" || !o.page.startsWith("/") || o.page.startsWith("//") || o.page.includes("\\")) {
      throw new Error("defineTwoFactor: `page` is a same-origin path such as /two-factor");
    }
    if (o.require !== undefined && typeof o.require !== "function") throw new Error("defineTwoFactor: `require` is a function");
    const digits = o.digits ?? 6;
    if (digits !== 6 && digits !== 8) throw new Error("defineTwoFactor: digits is 6 or 8");
    const range = (name: string, v: number, lo: number, hi: number) => {
      if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`defineTwoFactor: ${name} is ${lo} to ${hi}`);
      return v;
    };
    this.page = o.page;
    this.#issuer = o.issuer;
    this.#store = o.store ?? new MemoryTwoFactorStore();
    this.#require = o.require;
    this.#digits = digits;
    this.#window = range("window", o.window ?? 1, 0, 2);
    this.#max = range("maxAttempts", o.maxAttempts ?? 5, 3, 20);
    this.#lockMs = range("lockMs", o.lockMs ?? 15 * 60_000, 60_000, 24 * 3600_000);
    this.#codes = range("recoveryCodes", o.recoveryCodes ?? 10, 4, 20);
    this.#now = o.now ?? Date.now;
    this.#keys = (async () => {
      const base = await crypto.subtle.importKey("raw", enc.encode(raw), "HKDF", false, ["deriveKey"]);
      const derive = (info: string, alg: AesKeyGenParams | HmacImportParams, use: KeyUsage[]) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: enc.encode("weft two-factor"), info: enc.encode(info) },
          base,
          alg,
          false,
          use,
        );
      return {
        aes: await derive("secret", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
        mac: await derive("recovery", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
      };
    })();
  }

  async needed(user: string, tenant?: string): Promise<boolean> {
    if (await this.#store.get(user)) return true;
    return this.#require ? (await this.#require(user, tenant)) === true : false;
  }

  async enabled(user: string): Promise<boolean> {
    return Boolean(await this.#store.get(user));
  }

  async status(ctx: PageContext): Promise<TwoFactorStatus | null> {
    const s = await authState(ctx);
    if (!s) return null;
    const enabled = await this.enabled(s.user);
    return {
      user: s.user,
      pending: s.pending,
      enabled,
      required: enabled || (this.#require ? (await this.#require(s.user, s.tenant)) === true : false),
      mfa: s.mfa,
      recoveryLeft: enabled ? await this.#store.countRecovery(s.user) : 0,
    };
  }

  async setup(ctx: PageContext, o: { account?: string } = {}): Promise<TwoFactorSetup> {
    const s = await this.#who(ctx);
    if (await this.#store.get(s.user)) throw new TwoFactorError("conflict", "Two-factor sign-in is already on");
    const account = o.account ?? s.user;
    if (typeof account !== "string" || account === "" || account.length > 128) {
      throw new TypeError("twoFactor.setup: `account` is 1-128 characters");
    }
    const secret = base32(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
    const label = `${encodeURIComponent(this.#issuer)}:${encodeURIComponent(account)}`;
    const q = new URLSearchParams({ secret, issuer: this.#issuer, algorithm: "SHA1", digits: String(this.#digits), period: "30" });
    const state = await seal(ctx, { u: s.user, s: secret }, { purpose: "two-factor-setup", ttlMs: SETUP_TTL_MS, session: true });
    return { secret, uri: `otpauth://totp/${label}?${q.toString().replace(/\+/g, "%20")}`, state };
  }

  async enable(ctx: PageContext, state: string, code: string): Promise<string[] | null> {
    const s = await this.#who(ctx);
    const v = (await unseal(ctx, typeof state === "string" ? state : null, { purpose: "two-factor-setup", session: true })) as
      | { u?: unknown; s?: unknown }
      | undefined;
    if (!v || v.u !== s.user || typeof v.s !== "string") throw new TwoFactorError("expired", "Start setting it up again");
    const secret = fromBase32(v.s);
    if (!secret || secret.length !== SECRET_BYTES) throw new TwoFactorError("invalid", "Not a two-factor secret");
    const step = await this.#match(secret, code, -1);
    if (step === null) return null;
    const added = await this.#store.add({
      user: s.user,
      secret: await this.#encrypt(s.user, secret),
      lastStep: step,
      failures: 0,
      lockedUntil: 0,
      created: this.#now(),
    });
    if (!added) throw new TwoFactorError("conflict", "Two-factor sign-in is already on");
    const codes = await this.#newRecovery(s.user);
    await completeTwoFactor(ctx);
    return codes;
  }

  async verify(ctx: PageContext, code: string): Promise<boolean> {
    const s = await authState(ctx);
    if (!s || !s.pending) throw new TwoFactorError("signed-out", "No sign-in is waiting for a code");
    if (!(await this.#check(s.user, code, true))) return false;
    await completeTwoFactor(ctx);
    return true;
  }

  async confirm(ctx: PageContext, code: string): Promise<boolean> {
    const s = await this.#signedIn(ctx);
    if (!(await this.#check(s.user, code, false))) return false;
    await completeTwoFactor(ctx);
    return true;
  }

  async regenerateRecoveryCodes(ctx: PageContext, code: string): Promise<string[] | null> {
    const s = await this.#signedIn(ctx);
    if (!(await this.#check(s.user, code, false))) return null;
    return this.#newRecovery(s.user);
  }

  async disable(ctx: PageContext, code: string): Promise<boolean> {
    const s = await this.#signedIn(ctx);
    if (this.#require && (await this.#require(s.user, s.tenant)) === true) {
      throw new TwoFactorError("required", "Two-factor sign-in is required for this account");
    }
    if (!(await this.#check(s.user, code, false))) return false;
    return this.#store.remove(s.user);
  }

  async reset(user: string): Promise<boolean> {
    return this.#store.remove(user);
  }

  async #who(ctx: PageContext) {
    const s = await authState(ctx);
    if (!s) throw new TwoFactorError("signed-out", "Sign in first");
    return s;
  }

  async #signedIn(ctx: PageContext) {
    const s = await authState(ctx);
    if (!s || s.pending) throw new TwoFactorError("signed-out", "Sign in first");
    if (!(await this.#store.get(s.user))) throw new TwoFactorError("not-enrolled", "Two-factor sign-in is not on");
    return s;
  }

  async #check(user: string, input: string, recovery: boolean): Promise<boolean> {
    const rec = await this.#store.get(user);
    if (!rec) throw new TwoFactorError("not-enrolled", "Set up two-factor sign-in first");
    const now = this.#now();
    if (rec.lockedUntil > now) {
      throw new TwoFactorError("locked", "Too many wrong codes; try again later", rec.lockedUntil);
    }
    const code = typeof input === "string" ? input.replace(/[\s-]/g, "").toLowerCase() : "";
    let ok = false;
    if (/^\d+$/.test(code) && code.length === this.#digits) {
      const secret = await this.#decrypt(user, rec.secret);
      const step = await this.#match(secret, code, rec.lastStep);
      ok = step !== null && (await this.#store.advance(user, step));
    } else if (recovery && code.length === 10) {
      const typed = code.replace(/o/g, "0").replace(/[il]/g, "1");
      ok = [...typed].every((c) => RECOVERY.includes(c)) && (await this.#store.useRecovery(user, await this.#hash(user, typed)));
      if (ok) await this.#store.succeed(user);
    }
    if (!ok) {
      if (await this.#store.fail(user, this.#max, now + this.#lockMs)) {
        throw new TwoFactorError("locked", "Too many wrong codes; try again later", now + this.#lockMs);
      }
    }
    return ok;
  }

  async #match(secret: Uint8Array, input: string, after: number): Promise<number | null> {
    const code = typeof input === "string" ? input.replace(/[\s-]/g, "") : "";
    if (!/^\d+$/.test(code) || code.length !== this.#digits) return null;
    const now = Math.floor(this.#now() / STEP_MS);
    let found: number | null = null;
    for (let w = -this.#window; w <= this.#window; w++) {
      const step = now + w;
      if (sameString(await totp(secret, step, this.#digits), code) && step > after && found === null) found = step;
    }
    return found;
  }

  async #newRecovery(user: string): Promise<string[]> {
    const codes: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < this.#codes; i++) {
      const raw = [...crypto.getRandomValues(new Uint8Array(10))].map((b) => RECOVERY[b & 31]).join("");
      codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
      hashes.push(await this.#hash(user, raw));
    }
    await this.#store.setRecovery(user, hashes);
    return codes;
  }

  async #hash(user: string, code: string): Promise<string> {
    const { mac } = await this.#keys;
    return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", mac, enc.encode(`${user}\n${code}`))));
  }

  async #encrypt(user: string, secret: Uint8Array): Promise<string> {
    const { aes } = await this.#keys;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(user) }, aes, new Uint8Array(secret));
    return `v1.${base64url(iv)}.${base64url(new Uint8Array(ct))}`;
  }

  async #decrypt(user: string, stored: string): Promise<Uint8Array> {
    const [v, iv, ct] = stored.split(".");
    const ivb = fromBase64url(iv ?? "");
    const ctb = fromBase64url(ct ?? "");
    if (v !== "v1" || !ivb || !ctb) throw new Error("@weft/server: a stored two-factor secret is malformed");
    const { aes } = await this.#keys;
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(ivb), additionalData: enc.encode(user) }, aes, new Uint8Array(ctb));
      return new Uint8Array(pt);
    } catch (err) {
      throw new Error("@weft/server: a stored two-factor secret does not open with this key (or belongs to another user)", { cause: err });
    }
  }
}

export function defineTwoFactor(o: TwoFactorOptions): TwoFactor {
  return new TwoFactor(o);
}
