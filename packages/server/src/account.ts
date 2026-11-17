import type { SqlDatabase } from "@weft-framework/data";
import { authState, login, signOutUser, type LoginResult } from "./auth.ts";
import type { PageContext } from "./context.ts";
import { normalizeEmail } from "./email-signin.ts";

import { seal, unseal } from "./seal.ts";
import { base64url, RateLimiter } from "./security.ts";

type Maybe<T> = T | Promise<T>;

export type AccountTokenKind = "reset" | "email" | "signup" | "verify";

export interface AccountToken {
  id: string;
  kind: AccountTokenKind;
  user: string;
  email: string;
  expires: number;
  data?: string;
}

export interface AccountTokenStore {
  add(t: AccountToken): Maybe<void>;
  get(id: string): Maybe<AccountToken | null | undefined>;
  take(id: string): Maybe<AccountToken | null | undefined>;
  clear(user: string, kind: AccountTokenKind): Maybe<void>;
  sweep(now: number): Maybe<void>;
}

export class MemoryAccountTokenStore implements AccountTokenStore {
  readonly #tokens = new Map<string, AccountToken>();
  add(t: AccountToken): void {
    this.#tokens.set(t.id, { ...t });
  }
  get(id: string): AccountToken | null {
    const t = this.#tokens.get(id);
    return t ? { ...t } : null;
  }
  take(id: string): AccountToken | null {
    const t = this.#tokens.get(id);
    this.#tokens.delete(id);
    return t ?? null;
  }
  clear(user: string, kind: AccountTokenKind): void {
    for (const [id, t] of this.#tokens) if (t.user === user && t.kind === kind) this.#tokens.delete(id);
  }
  sweep(now: number): void {
    for (const [id, t] of this.#tokens) if (t.expires <= now) this.#tokens.delete(id);
  }
}

export class SqlAccountTokenStore implements AccountTokenStore {
  readonly #db: SqlDatabase;
  readonly #t: string;

  constructor(db: SqlDatabase, table = "weft_account_tokens") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`@weft-framework/server: not a valid table name: ${table}`);
    this.#db = db;
    this.#t = `"${table}"`;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#t} (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, user_id TEXT NOT NULL, ` +
        `email TEXT NOT NULL, expires INTEGER NOT NULL, data TEXT)`,
    );
    const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[];
    if (!cols.some((c) => c.name === "data")) db.exec(`ALTER TABLE ${this.#t} ADD COLUMN data TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_user" ON ${this.#t} (user_id, kind)`);
  }

  static #row(r: Record<string, unknown> | undefined): AccountToken | null {
    if (!r) return null;
    const t: AccountToken = { id: String(r.id), kind: String(r.kind) as AccountTokenKind, user: String(r.user_id), email: String(r.email), expires: Number(r.expires) };
    if (r.data !== null && r.data !== undefined) t.data = String(r.data);
    return t;
  }
  add(t: AccountToken): void {
    this.#db
      .prepare(`INSERT INTO ${this.#t} (id, kind, user_id, email, expires, data) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(t.id, t.kind, t.user, t.email, t.expires, t.data ?? null);
  }
  get(id: string): AccountToken | null {
    return SqlAccountTokenStore.#row(this.#db.prepare(`SELECT * FROM ${this.#t} WHERE id = ?`).all(id)[0] as Record<string, unknown>);
  }
  take(id: string): AccountToken | null {
    return SqlAccountTokenStore.#row(
      this.#db.prepare(`DELETE FROM ${this.#t} WHERE id = ? RETURNING id, kind, user_id, email, expires, data`).all(id)[0] as Record<string, unknown>,
    );
  }
  clear(user: string, kind: AccountTokenKind): void {
    this.#db.prepare(`DELETE FROM ${this.#t} WHERE user_id = ? AND kind = ?`).run(user, kind);
  }
  sweep(now: number): void {
    this.#db.prepare(`DELETE FROM ${this.#t} WHERE expires <= ?`).run(now);
  }
}

export type AccountMessage =
  | { kind: "password-reset"; to: string; link: string; expires: number }
  | { kind: "password-changed"; to: string }
  | { kind: "email-change"; to: string; link: string; expires: number }
  | { kind: "email-changed"; to: string; newEmail: string }
  | { kind: "sign-up"; to: string; link: string; expires: number }
  | { kind: "account-exists"; to: string }
  | { kind: "verify-email"; to: string; link: string; expires: number };

export type AccountErrorCode = "invalid" | "limit" | "signed-out" | "weak" | "refused" | "expired";

export class AccountError extends Error {
  readonly code: AccountErrorCode;
  constructor(code: AccountErrorCode, message: string) {
    super(message);
    this.name = "AccountError";
    this.code = code;
  }
}

export interface AccountOptions {
  url: string;
  send(message: AccountMessage): Maybe<void>;
  findUser(email: string): Maybe<string | null | undefined>;
  emailOf(user: string): Maybe<string | null | undefined>;
  setPassword?(user: string, hash: string): Maybe<void>;
  setEmail?(user: string, email: string): Maybe<void>;
  resetPage?: string;
  emailPage?: string;
  resetTtlMs?: number;
  emailTtlMs?: number;
  minPasswordLength?: number;
  checkPassword?(password: string, user: string): Maybe<string | null | undefined>;
  perEmail?: number;
  perSession?: number;
  createUser?(email: string, passwordHash: string | null): Maybe<string>;
  markVerified?(user: string, email: string): Maybe<void>;
  allowSignUp?(email: string, ctx: PageContext): Maybe<boolean | string>;
  clientKey?(ctx: PageContext): string | null | undefined;
  perClient?: number;
  minFormMs?: number;
  signUpPage?: string;
  verifyPage?: string;
  signUpTtlMs?: number;
  store?: AccountTokenStore;
  now?: () => number;
}

const MAX_PASSWORD = 1024;

function safePath(p: string, name: string): string {
  if (typeof p !== "string" || !p.startsWith("/") || p.startsWith("//") || p.includes("\\")) {
    throw new Error(`defineAccount: \`${name}\` is a same-origin path`);
  }
  return p;
}

async function tokenId(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`account:${token}`));
  return base64url(new Uint8Array(d));
}

export class Account {
  readonly #o: AccountOptions;
  readonly #origin: string;
  readonly #store: AccountTokenStore;
  readonly #now: () => number;
  readonly #resetPage: string;
  readonly #emailPage: string;
  readonly #resetTtl: number;
  readonly #emailTtl: number;
  readonly #minLength: number;
  readonly #byEmail: RateLimiter;
  readonly #bySession: RateLimiter;
  readonly #byClient: RateLimiter;
  readonly #minForm: number;
  readonly #signUpPage: string;
  readonly #verifyPage: string;
  readonly #signUpTtl: number;
  #swept = 0;

  constructor(o: AccountOptions) {
    let u: URL;
    try {
      u = new URL(o.url);
    } catch {
      throw new Error("defineAccount: `url` is the app's public origin, such as https://app.example");
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
      throw new Error("defineAccount: `url` must use https (http only for localhost)");
    }
    for (const k of ["send", "findUser", "emailOf"] as const) {
      if (typeof o[k] !== "function") throw new Error(`defineAccount: \`${k}\` is required`);
    }
    const range = (name: string, v: number, lo: number, hi: number) => {
      if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`defineAccount: ${name} is ${lo} to ${hi}`);
      return v;
    };
    this.#o = o;
    this.#origin = u.origin;
    this.#store = o.store ?? new MemoryAccountTokenStore();
    this.#now = o.now ?? Date.now;
    this.#resetPage = safePath(o.resetPage ?? "/reset-password", "resetPage");
    this.#emailPage = safePath(o.emailPage ?? "/confirm-email", "emailPage");
    this.#resetTtl = range("resetTtlMs", o.resetTtlMs ?? 30 * 60_000, 5 * 60_000, 2 * 3600_000);
    this.#emailTtl = range("emailTtlMs", o.emailTtlMs ?? 24 * 3600_000, 10 * 60_000, 7 * 24 * 3600_000);
    this.#minLength = range("minPasswordLength", o.minPasswordLength ?? 10, 8, 128);
    const perEmail = range("perEmail", o.perEmail ?? 3, 1, 100);
    const perSession = range("perSession", o.perSession ?? 10, 1, 1000);
    this.#byEmail = new RateLimiter({ capacity: perEmail, refillPerSecond: perEmail / 3600 });
    this.#bySession = new RateLimiter({ capacity: perSession, refillPerSecond: perSession / 3600 });
    const perClient = range("perClient", o.perClient ?? 20, 1, 10_000);
    this.#byClient = new RateLimiter({ capacity: perClient, refillPerSecond: perClient / 3600 });
    this.#minForm = range("minFormMs", o.minFormMs ?? 2000, 0, 60_000);
    this.#signUpPage = safePath(o.signUpPage ?? "/sign-up/confirm", "signUpPage");
    this.#verifyPage = safePath(o.verifyPage ?? "/verify-email", "verifyPage");
    this.#signUpTtl = range("signUpTtlMs", o.signUpTtlMs ?? 24 * 3600_000, 10 * 60_000, 7 * 24 * 3600_000);
  }

  async requestPasswordReset(ctx: PageContext, email: string): Promise<void> {
    const address = this.#limit(ctx, email);
    const user = await this.#o.findUser(address);
    if (typeof user !== "string" || user === "") return;
    await this.#issue({ kind: "reset", user, email: address, ttl: this.#resetTtl, page: this.#resetPage, message: "password-reset" });
  }

  async checkResetToken(token: string): Promise<boolean> {
    const t = await this.#find(token, "reset");
    return t !== null;
  }

  async resetPassword(ctx: PageContext, token: string, password: string): Promise<boolean> {
    if (typeof this.#o.setPassword !== "function") throw new Error("defineAccount: resetting passwords needs `setPassword`");
    const peeked = await this.#find(token, "reset");
    if (!peeked) return false;
    await this.#checkPassword(password, peeked.user);
    const t = await this.#store.take(peeked.id);
    if (!t || t.kind !== "reset" || t.expires <= this.#now()) return false;
    if (normalizeEmail(await this.#o.emailOf(t.user)) !== t.email) return false;
    const { hashPassword } = await import("./password.ts");
    await this.#o.setPassword(t.user, await hashPassword(password));
    await this.#store.clear(t.user, "reset");
    await signOutUser(ctx, t.user);
    await this.#o.send({ kind: "password-changed", to: t.email });
    return true;
  }

  async requestEmailChange(ctx: PageContext, email: string): Promise<void> {
    const me = await this.#signedIn(ctx);
    const address = this.#limit(ctx, email);
    if (normalizeEmail(await this.#o.emailOf(me)) === address) {
      throw new AccountError("invalid", "That is already the account's address");
    }
    if (await this.#taken(address)) return;
    await this.#issue({ kind: "email", user: me, email: address, ttl: this.#emailTtl, page: this.#emailPage, message: "email-change" });
  }

  async confirmEmailChange(ctx: PageContext, token: string): Promise<string | null> {
    if (typeof this.#o.setEmail !== "function") throw new Error("defineAccount: changing addresses needs `setEmail`");
    const me = await this.#signedIn(ctx);
    const peeked = await this.#find(token, "email");
    if (!peeked || peeked.user !== me) return null;
    const t = await this.#store.take(peeked.id);
    if (!t || t.kind !== "email" || t.user !== me || t.expires <= this.#now()) return null;
    if (await this.#taken(t.email)) return null;
    const old = normalizeEmail(await this.#o.emailOf(me));
    await this.#o.setEmail(me, t.email);
    await this.#store.clear(me, "email");
    if (old) await this.#o.send({ kind: "email-changed", to: old, newEmail: t.email });
    return t.email;
  }

  async signUpForm(ctx: PageContext): Promise<string> {
    return seal(ctx, { t: this.#now() }, { purpose: "signup-form", ttlMs: 3600_000, session: true });
  }

  async signUp(
    ctx: PageContext,
    input: { email: string; password?: string | null; form: string; trap?: string | null },
  ): Promise<void> {
    if (typeof this.#o.createUser !== "function") throw new Error("defineAccount: sign-up needs `createUser`");
    const f = (await unseal(ctx, typeof input.form === "string" ? input.form : null, { purpose: "signup-form", session: true })) as
      | { t?: unknown }
      | undefined;
    if (!f || typeof f.t !== "number" || this.#now() - f.t > 3600_000) throw new AccountError("expired", "Reload the page and try again");
    if ((typeof input.trap === "string" && input.trap !== "") || this.#now() - f.t < this.#minForm) return;
    const password = input.password ?? null;
    if (password !== null) await this.#checkPassword(password, "");
    const client = this.#o.clientKey?.(ctx);
    if (typeof client === "string" && client !== "" && !this.#byClient.take(client, this.#now())) {
      throw new AccountError("limit", "Too many requests; try again later");
    }
    const address = this.#limit(ctx, input.email);
    if (this.#o.allowSignUp) {
      const ok = await this.#o.allowSignUp(address, ctx);
      if (ok !== true) throw new AccountError("refused", typeof ok === "string" && ok !== "" ? ok : "This address cannot sign up");
    }
    if (await this.#taken(address)) {
      await this.#o.send({ kind: "account-exists", to: address });
      return;
    }
    let data = "";
    if (password !== null) {
      const { hashPassword } = await import("./password.ts");
      data = await hashPassword(password);
    }
    await this.#issue({ kind: "signup", user: "", email: address, ttl: this.#signUpTtl, page: this.#signUpPage, message: "sign-up", data });
  }

  async completeSignUp(ctx: PageContext, token: string): Promise<{ user: string; login: LoginResult } | null> {
    if (typeof this.#o.createUser !== "function") throw new Error("defineAccount: sign-up needs `createUser`");
    const peeked = await this.#find(token, "signup");
    if (!peeked) return null;
    const t = await this.#store.take(peeked.id);
    if (!t || t.kind !== "signup" || t.expires <= this.#now()) return null;
    if (await this.#taken(t.email)) return null;
    const user = await this.#o.createUser(t.email, t.data ? t.data : null);
    if (typeof user !== "string" || user === "") throw new Error("defineAccount: createUser must return the new user id");
    await this.#o.markVerified?.(user, t.email);
    return { user, login: await login(ctx, user) };
  }

  async requestVerification(ctx: PageContext): Promise<void> {
    if (typeof this.#o.markVerified !== "function") throw new Error("defineAccount: verification needs `markVerified`");
    const me = await this.#signedIn(ctx);
    const address = this.#limit(ctx, (await this.#o.emailOf(me)) ?? "");
    await this.#issue({ kind: "verify", user: me, email: address, ttl: this.#signUpTtl, page: this.#verifyPage, message: "verify-email" });
  }

  async verifyEmail(token: string): Promise<boolean> {
    if (typeof this.#o.markVerified !== "function") throw new Error("defineAccount: verification needs `markVerified`");
    const peeked = await this.#find(token, "verify");
    if (!peeked) return false;
    const t = await this.#store.take(peeked.id);
    if (!t || t.kind !== "verify" || t.expires <= this.#now()) return false;
    if (normalizeEmail(await this.#o.emailOf(t.user)) !== t.email) return false;
    await this.#o.markVerified(t.user, t.email);
    return true;
  }

  #limit(ctx: PageContext, email: string): string {
    const address = normalizeEmail(email);
    if (!address) throw new AccountError("invalid", "That is not an email address");
    const now = this.#now();
    if (!this.#bySession.take(ctx.session, now) || !this.#byEmail.take(address, now)) {
      throw new AccountError("limit", "Too many requests; try again later");
    }
    return address;
  }

  async #signedIn(ctx: PageContext): Promise<string> {
    const s = await authState(ctx);
    if (!s || s.pending) throw new AccountError("signed-out", "Sign in first");
    return s.user;
  }

  async #taken(address: string): Promise<boolean> {
    const other = await this.#o.findUser(address);
    return typeof other === "string" && other !== "";
  }

  async #find(token: unknown, kind: AccountTokenKind): Promise<AccountToken | null> {
    if (typeof token !== "string" || token.length < 20 || token.length > 128) return null;
    const t = await this.#store.get(await tokenId(token));
    return t && t.kind === kind && t.expires > this.#now() ? t : null;
  }

  async #issue(o: {
    kind: AccountTokenKind;
    user: string;
    email: string;
    ttl: number;
    page: string;
    message: "password-reset" | "email-change" | "sign-up" | "verify-email";
    data?: string;
  }): Promise<void> {
    const { kind, user, email, ttl, page, message } = o;
    const now = this.#now();
    if (now - this.#swept > 60_000) {
      this.#swept = now;
      await this.#store.sweep(now);
    }
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const id = await tokenId(token);
    const expires = now + ttl;
    if (user !== "") await this.#store.clear(user, kind);
    await this.#store.add({ id, kind, user, email, expires, ...(o.data !== undefined ? { data: o.data } : {}) });
    const link = new URL(page, this.#origin);
    link.searchParams.set("token", token);
    try {
      await this.#o.send({ kind: message, to: email, link: link.href, expires });
    } catch (err) {
      await this.#store.take(id);
      throw err;
    }
  }

  async #checkPassword(password: unknown, user: string): Promise<void> {
    if (typeof password !== "string" || [...password].length < this.#minLength) {
      throw new AccountError("weak", `Use at least ${this.#minLength} characters`);
    }
    if (new TextEncoder().encode(password).length > MAX_PASSWORD) {
      throw new AccountError("weak", `Use at most ${MAX_PASSWORD} bytes`);
    }
    const reason = await this.#o.checkPassword?.(password, user);
    if (typeof reason === "string" && reason !== "") throw new AccountError("weak", reason);
  }
}

export function defineAccount(o: AccountOptions): Account {
  return new Account(o);
}
