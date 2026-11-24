import type { SqlDatabase } from "@weft-framework/data";
import { signInWith } from "./auth.ts";
import type { PageContext } from "./context.ts";
import type { Identity } from "./oauth.ts";
import { base64url, RateLimit, timingSafeEqual, type RateLimitStore } from "./security.ts";
import { isSafePath } from "@weft-framework/runtime";

type Maybe<T> = T | Promise<T>;

export interface EmailToken {
  id: string;
  email: string;
  code: string;
  session: string;
  next: string;
  expires: number;
  attempts: number;
}

export interface EmailTokenStore {
  add(token: EmailToken): Maybe<void>;
  get(id: string): Maybe<EmailToken | null | undefined>;
  find(session: string, email: string): Maybe<EmailToken | null | undefined>;
  attempt(id: string): Maybe<number>;
  take(id: string): Maybe<boolean>;
  clear(session: string, email: string): Maybe<void>;
  sweep(now: number): Maybe<void>;
}

export class MemoryEmailTokenStore implements EmailTokenStore {
  readonly #tokens = new Map<string, EmailToken>();

  add(t: EmailToken): void {
    this.#tokens.set(t.id, { ...t });
  }
  get(id: string): EmailToken | null {
    const t = this.#tokens.get(id);
    return t ? { ...t } : null;
  }
  find(session: string, email: string): EmailToken | null {
    let best: EmailToken | null = null;
    for (const t of this.#tokens.values()) {
      if (t.session === session && t.email === email && (!best || t.expires > best.expires)) best = t;
    }
    return best ? { ...best } : null;
  }
  attempt(id: string): number {
    const t = this.#tokens.get(id);
    if (!t) return Number.POSITIVE_INFINITY;
    t.attempts += 1;
    return t.attempts;
  }
  take(id: string): boolean {
    return this.#tokens.delete(id);
  }
  clear(session: string, email: string): void {
    for (const [id, t] of this.#tokens) if (t.session === session && t.email === email) this.#tokens.delete(id);
  }
  sweep(now: number): void {
    for (const [id, t] of this.#tokens) if (t.expires <= now) this.#tokens.delete(id);
  }
}

export class SqlEmailTokenStore implements EmailTokenStore {
  private readonly db: SqlDatabase;
  private readonly table: string;

  constructor(db: SqlDatabase, table = "weft_email_tokens") {
    this.db = db;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(`SqlEmailTokenStore: bad table name ${table}`);
    }
    this.table = table;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, email TEXT NOT NULL, code TEXT NOT NULL, ` +
        `session TEXT NOT NULL, next TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL)`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_session ON ${table} (session, email)`);
  }

  private row(r: unknown): EmailToken | null {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    return {
      id: String(o.id),
      email: String(o.email),
      code: String(o.code),
      session: String(o.session),
      next: String(o.next),
      expires: Number(o.expires),
      attempts: Number(o.attempts),
    };
  }
  add(t: EmailToken): void {
    this.db
      .prepare(`INSERT INTO ${this.table} (id, email, code, session, next, expires, attempts) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(t.id, t.email, t.code, t.session, t.next, t.expires, t.attempts);
  }
  get(id: string): EmailToken | null {
    return this.row(this.db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).all(id)[0]);
  }
  find(session: string, email: string): EmailToken | null {
    return this.row(
      this.db.prepare(`SELECT * FROM ${this.table} WHERE session = ? AND email = ? ORDER BY expires DESC LIMIT 1`).all(session, email)[0],
    );
  }
  attempt(id: string): number {
    this.db.prepare(`UPDATE ${this.table} SET attempts = attempts + 1 WHERE id = ?`).run(id);
    const r = this.db.prepare(`SELECT attempts FROM ${this.table} WHERE id = ?`).all(id)[0] as { attempts?: number } | undefined;
    return r ? Number(r.attempts) : Number.POSITIVE_INFINITY;
  }
  take(id: string): boolean {
    return this.db.prepare(`DELETE FROM ${this.table} WHERE id = ? RETURNING id`).all(id).length > 0;
  }
  clear(session: string, email: string): void {
    this.db.prepare(`DELETE FROM ${this.table} WHERE session = ? AND email = ?`).run(session, email);
  }
  sweep(now: number): void {
    this.db.prepare(`DELETE FROM ${this.table} WHERE expires <= ?`).run(now);
  }
}

export interface EmailSignInMessage {
  email: string;
  link: string;
  code: string;
  expires: Date;
}

export interface EmailSignInOptions {
  url: string;
  page: string;
  send(message: EmailSignInMessage): Maybe<void>;
  allow?(email: string): Maybe<boolean>;
  ttlMs?: number;
  codeLength?: number;
  maxAttempts?: number;
  perEmail?: number;
  perSession?: number;
  limits?: RateLimitStore;
  store?: EmailTokenStore;
  now?(): number;
}

export class EmailSignInError extends Error {
  readonly code: "invalid" | "limit";
  constructor(code: "invalid" | "limit", message: string) {
    super(message);
    this.name = "EmailSignInError";
    this.code = code;
  }
}

export const EMAIL_PATH = "/_weft/auth/email";

export interface EmailPending {
  email: string;
  token: string;
  action: string;
}
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const enc = new TextEncoder();

async function sha256(s: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

function digits(n: number): string {
  let out = "";
  const buf = new Uint8Array(1);
  while (out.length < n) {
    crypto.getRandomValues(buf);
    if (buf[0] < 250) out += String(buf[0] % 10);
  }
  return out;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL && EMAIL.test(email) ? email : null;
}

export class EmailSignIn {
  readonly #o: Required<Omit<EmailSignInOptions, "allow" | "store" | "now" | "limits">> & Pick<EmailSignInOptions, "allow">;
  readonly page: string;
  readonly #store: EmailTokenStore;
  readonly #now: () => number;
  readonly #origin: string;
  readonly #byEmail: RateLimit;
  readonly #bySession: RateLimit;
  #swept = 0;

  constructor(o: EmailSignInOptions) {
    let origin: URL;
    try {
      origin = new URL(o.url);
    } catch {
      throw new Error("emailSignIn: `url` is the app's public origin, such as https://app.example");
    }
    const local = origin.hostname === "localhost" || origin.hostname === "127.0.0.1" || origin.hostname === "[::1]";
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && local)) {
      throw new Error("emailSignIn: `url` must use https (http only for localhost)");
    }
    if (typeof o.send !== "function") throw new Error("emailSignIn: `send` delivers the message");
    if (typeof o.page !== "string" || !isSafePath(o.page) || /[?#]/.test(o.page) || o.page.startsWith("/_weft/")) {
      throw new Error("emailSignIn: `page` is the path of the app's confirmation page, such as /sign-in/confirm");
    }
    this.page = o.page;
    const ttlMs = o.ttlMs ?? 15 * 60_000;
    if (!Number.isFinite(ttlMs) || ttlMs < 60_000 || ttlMs > 3_600_000) throw new Error("emailSignIn: ttlMs is 1 minute to 1 hour");
    const codeLength = o.codeLength ?? 6;
    if (!Number.isInteger(codeLength) || codeLength < 6 || codeLength > 10) throw new Error("emailSignIn: codeLength is 6 to 10");
    const maxAttempts = o.maxAttempts ?? 5;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("emailSignIn: maxAttempts is 1 to 10");
    const perEmail = o.perEmail ?? 5;
    const perSession = o.perSession ?? 10;
    for (const [k, v] of [["perEmail", perEmail], ["perSession", perSession]] as const) {
      if (!Number.isInteger(v) || v < 1) throw new Error(`emailSignIn: ${k} is a whole number of requests per hour`);
    }
    this.#o = { url: o.url, page: o.page, send: o.send, allow: o.allow, ttlMs, codeLength, maxAttempts, perEmail, perSession };
    this.#origin = origin.origin;
    this.#store = o.store ?? new MemoryEmailTokenStore();
    this.#now = o.now ?? Date.now;
    this.#byEmail = new RateLimit("signin.email", { capacity: perEmail, refillPerSecond: perEmail / 3600 }, o.limits);
    this.#bySession = new RateLimit("signin.session", { capacity: perSession, refillPerSecond: perSession / 3600 }, o.limits);
  }

  async #sweep(now: number): Promise<void> {
    if (now - this.#swept > 60_000) {
      this.#swept = now;
      await this.#store.sweep(now);
    }
  }

  async request(ctx: PageContext, email: string, opts: { next?: string } = {}): Promise<void> {
    const address = normalizeEmail(email);
    if (!address) throw new EmailSignInError("invalid", "That is not an email address");
    const now = this.#now();
    if (!(await this.#bySession.take(ctx.session, now)) || !(await this.#byEmail.take(address, now))) {
      throw new EmailSignInError("limit", "Too many sign-in emails; try again later");
    }
    await this.#sweep(now);
    if (this.#o.allow && !(await this.#o.allow(address))) return;
    const next = opts.next !== undefined && isSafePath(opts.next) ? opts.next : "/";
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const id = await sha256(`link:${token}`);
    const code = digits(this.#o.codeLength);
    const expires = now + this.#o.ttlMs;
    await this.#store.clear(ctx.session, address);
    await this.#store.add({ id, email: address, code: await sha256(`code:${id}:${code}`), session: ctx.session, next, expires, attempts: 0 });
    const link = `${this.#origin}${this.page}?t=${token}`;
    try {
      await this.#o.send({ email: address, link, code, expires: new Date(expires) });
    } catch (err) {
      await this.#store.take(id);
      throw err;
    }
  }

  async verify(ctx: PageContext, email: string, code: string): Promise<boolean> {
    const address = normalizeEmail(email);
    if (!address || typeof code !== "string") return false;
    const typed = code.replace(/[\s-]/g, "");
    const t = await this.#store.find(ctx.session, address);
    if (!t || t.expires <= this.#now()) return false;
    if ((await this.#store.attempt(t.id)) > this.#o.maxAttempts) {
      await this.#store.take(t.id);
      return false;
    }
    if (!/^\d+$/.test(typed) || !timingSafeEqual(await sha256(`code:${t.id}:${typed}`), t.code)) return false;
    if (!(await this.#store.take(t.id))) return false;
    return (await signInWith(ctx, identityFor(address))) === "ok";
  }

  async pending(ctx: PageContext): Promise<EmailPending | null> {
    if (ctx.url.pathname !== this.page) return null;
    const token = ctx.url.searchParams.get("t") ?? "";
    const t = await this.#lookup(token);
    return t ? { email: t.email, token, action: EMAIL_PATH } : null;
  }

  async consume(token: string): Promise<{ email: string; next: string } | null> {
    const t = await this.#lookup(token);
    if (!t || !(await this.#store.take(t.id))) return null;
    return { email: t.email, next: t.next };
  }

  async #lookup(token: string): Promise<EmailToken | null> {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const t = await this.#store.get(await sha256(`link:${token}`));
    return t && t.expires > this.#now() ? t : null;
  }
}

export function identityFor(email: string): Identity {
  return Object.freeze({
    provider: "email",
    subject: email,
    email,
    emailVerified: true,
    name: null,
    picture: null,
    claims: Object.freeze({ email }),
  });
}

export function emailSignIn(o: EmailSignInOptions): EmailSignIn {
  return new EmailSignIn(o);
}
