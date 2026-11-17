import type { SqlDatabase } from "@weft-framework/data";
import type { PageContext } from "./context.ts";
import type { EmailSignIn } from "./email-signin.ts";
import type { Identity, Provider } from "./oauth.ts";
import type { Saml } from "./saml.ts";

export interface SessionRecord {
  user: string;
  created: number;
  seen: number;
  tenant?: string;
  pending?: true;
  mfa?: true;
  agent?: string;
  viewAs?: { user: string; tenant?: string; until: number; dev?: true };
  sso?: { c: string; n: string; f: string | null; s: string | null; nq?: string; spnq?: string };
}

export interface SessionInfo {
  id: string;
  created: number;
  seen: number;
  agent: string | null;
  current: boolean;
  mfa: boolean;
  pending: boolean;
}

export interface SessionBroadcast {
  publish(message: string): unknown;
  subscribe(onMessage: (message: string) => void): (() => void) | void;
}

export interface AuthState {
  user: string;
  pending: boolean;
  mfa: boolean;
  tenant?: string;
}

export interface SecondFactor {
  readonly page: string;
  needed(user: string, tenant?: string): Maybe<boolean>;
}

type Maybe<T> = T | Promise<T>;

export interface SessionStore {
  get(sid: string): Maybe<SessionRecord | null | undefined>;
  set(sid: string, record: SessionRecord): Maybe<void>;
  delete(sid: string): Maybe<void>;
  forUser?(user: string): Maybe<{ sid: string; record: SessionRecord }[]>;
}

export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, SessionRecord>();
  private readonly max: number;

  constructor(maxEntries = 100_000) {
    this.max = maxEntries;
  }

  get(sid: string): SessionRecord | null {
    const rec = this.map.get(sid);
    if (!rec) {
      return null;
    }
    this.map.delete(sid);
    this.map.set(sid, rec);
    return rec;
  }

  set(sid: string, record: SessionRecord): void {
    this.map.delete(sid);
    this.map.set(sid, record);
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value!);
    }
  }

  delete(sid: string): void {
    this.map.delete(sid);
  }

  forUser(user: string): { sid: string; record: SessionRecord }[] {
    const out: { sid: string; record: SessionRecord }[] = [];
    for (const [sid, record] of this.map) {
      if (record.user === user) out.push({ sid, record });
    }
    return out;
  }

  get size(): number {
    return this.map.size;
  }
}

interface SessionRow {
  user: string;
  created: number | bigint;
  seen: number | bigint;
  tenant: string | null;
  pending: number | bigint | null;
  mfa: number | bigint | null;
  agent: string | null;
  view_as?: string | null;
}

export class SqlSessionStore implements SessionStore {
  private readonly db: SqlDatabase;
  private readonly table: string;

  constructor(db: SqlDatabase, table = "weft_sessions") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(`@weft-framework/server: not a valid table name: ${table}`);
    }
    this.db = db;
    this.table = `"${table}"`;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.table} (sid TEXT PRIMARY KEY NOT NULL, user TEXT NOT NULL, ` +
        `created INTEGER NOT NULL, seen INTEGER NOT NULL, tenant TEXT, pending INTEGER, mfa INTEGER, agent TEXT, view_as TEXT)`,
    );
    const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[];
    for (const [name, type] of [
      ["tenant", "TEXT"],
      ["pending", "INTEGER"],
      ["mfa", "INTEGER"],
      ["agent", "TEXT"],
      ["view_as", "TEXT"],
    ]) {
      if (!cols.some((c) => c.name === name)) {
        db.exec(`ALTER TABLE ${this.table} ADD COLUMN ${name} ${type}`);
      }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_user" ON ${this.table} (user)`);
  }

  get(sid: string): SessionRecord | null {
    const row = this.db
      .prepare(`SELECT user, created, seen, tenant, pending, mfa, agent, view_as FROM ${this.table} WHERE sid = ?`)
      .all(sid)[0] as SessionRow | undefined;
    return row ? SqlSessionStore.record(row) : null;
  }

  forUser(user: string): { sid: string; record: SessionRecord }[] {
    const rows = this.db
      .prepare(`SELECT sid, user, created, seen, tenant, pending, mfa, agent, view_as FROM ${this.table} WHERE user = ?`)
      .all(user) as (SessionRow & { sid: string })[];
    return rows.map((row) => ({ sid: String(row.sid), record: SqlSessionStore.record(row) }));
  }

  private static record(row: SessionRow): SessionRecord {
    const rec: SessionRecord = { user: String(row.user), created: Number(row.created), seen: Number(row.seen) };
    if (row.tenant !== null) {
      rec.tenant = String(row.tenant);
    }
    if (Number(row.pending ?? 0) === 1) {
      rec.pending = true;
    }
    if (Number(row.mfa ?? 0) === 1) {
      rec.mfa = true;
    }
    if (row.agent !== null && row.agent !== undefined) {
      rec.agent = String(row.agent);
    }
    if (typeof row.view_as === "string") {
      try {
        const v = JSON.parse(row.view_as) as { user?: unknown; tenant?: unknown; until?: unknown; dev?: unknown };
        if (typeof v.user === "string" && typeof v.until === "number") {
          rec.viewAs = { user: v.user, until: v.until, ...(typeof v.tenant === "string" ? { tenant: v.tenant } : {}) };
          if (v.dev === true) rec.viewAs.dev = true;
        }
      } catch {
      }
    }
    return rec;
  }

  set(sid: string, r: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO ${this.table} (sid, user, created, seen, tenant, pending, mfa, agent, view_as) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
          `ON CONFLICT(sid) DO UPDATE SET user = excluded.user, created = excluded.created, seen = excluded.seen, ` +
          `tenant = excluded.tenant, pending = excluded.pending, mfa = excluded.mfa, agent = excluded.agent, view_as = excluded.view_as`,
      )
      .run(sid, r.user, r.created, r.seen, r.tenant ?? null, r.pending ? 1 : null, r.mfa ? 1 : null, r.agent ?? null, r.viewAs ? JSON.stringify(r.viewAs) : null);
  }

  delete(sid: string): void {
    this.db.prepare(`DELETE FROM ${this.table} WHERE sid = ?`).run(sid);
  }

  sweep(before: number): void {
    this.db.prepare(`DELETE FROM ${this.table} WHERE seen < ?`).run(before);
  }
}

export interface AuthOptions {
  store?: SessionStore;
  idleMs?: number;
  maxAgeMs?: number;
  user?(id: string, tenant?: string): unknown;
  providers?: Provider[];
  signIn?(identity: Identity): string | null | undefined | Promise<string | null | undefined>;
  signInError?: string;
  saml?: Saml;
  email?: EmailSignIn;
  twoFactor?: SecondFactor;
  revocations?: SessionBroadcast;
  viewAs?(operator: string, user: string): Maybe<boolean>;
}

export interface AuthControl {
  refused: string | null;
  login(user: string, multiFactor?: boolean): Promise<LoginResult>;
  logout(): Promise<void>;
  switchTenant(tenant: string | null): Promise<boolean>;
  signInWith(identity: Identity): Promise<LoginResult | "refused">;
  state(): Promise<AuthState | null>;
  completeTwoFactor(): Promise<boolean>;
  sessions(): Promise<SessionInfo[]>;
  revoke(user: string, o: { id?: string; keep: boolean }): Promise<number>;
  startViewAs(user: string, tenant: string | undefined, until: number): Promise<boolean>;
  stopViewAs(): Promise<boolean>;
}

export type LoginResult = "ok" | "two-factor";

const controls = new WeakMap<PageContext, AuthControl>();

export function attachAuth(ctx: PageContext, control: AuthControl): void {
  controls.set(ctx, control);
}

function control(ctx: PageContext): AuthControl {
  const c = controls.get(ctx);
  if (!c) {
    throw new Error("@weft-framework/server: login/logout/switchTenant need the context of a request being handled");
  }
  if (c.refused !== null) {
    throw new Error(`@weft-framework/server: login/logout/switchTenant ${c.refused}`);
  }
  return c;
}

export function signInWith(ctx: PageContext, identity: Identity): Promise<LoginResult | "refused"> {
  return control(ctx).signInWith(identity);
}

export function authState(ctx: PageContext): Promise<AuthState | null> {
  const c = controls.get(ctx);
  if (!c) {
    throw new Error("@weft-framework/server: the login state needs the context of a request being handled");
  }
  return c.state();
}

export function listSessions(ctx: PageContext): Promise<SessionInfo[]> {
  const c = controls.get(ctx);
  if (!c) {
    throw new Error("@weft-framework/server: listSessions needs the context of a request being handled");
  }
  return c.sessions();
}

export async function revokeSession(ctx: PageContext, id: string): Promise<boolean> {
  if (typeof id !== "string" || id === "") return false;
  const c = control(ctx);
  const me = await c.state();
  if (!me || me.pending) return false;
  return (await c.revoke(me.user, { id, keep: true })) > 0;
}

export async function signOutEverywhere(ctx: PageContext, o: { keepThis?: boolean } = {}): Promise<number> {
  const c = control(ctx);
  const me = await c.state();
  if (!me || me.pending) return 0;
  return c.revoke(me.user, { keep: o.keepThis !== false });
}

export function signOutUser(ctx: PageContext, user: string): Promise<number> {
  if (typeof user !== "string" || user === "") {
    throw new TypeError("@weft-framework/server: signOutUser needs a user id");
  }
  return control(ctx).revoke(user, { keep: false });
}

export function completeTwoFactor(ctx: PageContext): Promise<boolean> {
  return control(ctx).completeTwoFactor();
}

export function switchTenant(ctx: PageContext, tenant: string | null): Promise<boolean> {
  if (tenant !== null && (typeof tenant !== "string" || tenant === "")) {
    throw new TypeError("@weft-framework/server: switchTenant needs a non-empty tenant id or null");
  }
  return control(ctx).switchTenant(tenant);
}

export function login(ctx: PageContext, userId: string, opts: { multiFactor?: boolean } = {}): Promise<LoginResult> {
  if (typeof userId !== "string" || userId === "") {
    throw new TypeError("@weft-framework/server: login needs a non-empty user id");
  }
  return control(ctx).login(userId, opts.multiFactor === true);
}

export function logout(ctx: PageContext): Promise<void> {
  return control(ctx).logout();
}

export interface Viewing {
  user: string;
  tenant?: string;
  operator: string;
  until: number;
}

const viewing = new WeakMap<object, Viewing>();
const whileViewing = new WeakSet<object>();

export function noteViewing(actor: object, v: Viewing): void {
  viewing.set(actor, Object.freeze({ ...v }));
}

export function viewingAs(ctx: PageContext): Viewing | null {
  const u = ctx.user;
  return typeof u === "object" && u !== null ? (viewing.get(u) ?? null) : null;
}

export function allowWhileViewing<A extends object>(action: A): A {
  whileViewing.add(action);
  return action;
}

export function runsWhileViewing(action: object): boolean {
  return whileViewing.has(action);
}

export function viewAs(ctx: PageContext, user: string, o: { tenant?: string; until: number }): Promise<boolean> {
  if (typeof user !== "string" || user === "") throw new TypeError("@weft-framework/server: viewAs needs a user id");
  if (!o || typeof o.until !== "number" || !Number.isFinite(o.until)) throw new TypeError("@weft-framework/server: viewAs needs `until` (ms)");
  if (o.tenant !== undefined && (typeof o.tenant !== "string" || o.tenant === "")) throw new TypeError("@weft-framework/server: viewAs tenant is an id");
  return control(ctx).startViewAs(user, o.tenant, o.until);
}

export function stopViewingAs(ctx: PageContext): Promise<boolean> {
  return control(ctx).stopViewAs();
}
