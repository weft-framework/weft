import { asyncTransaction, enlistAsync } from "@weft-framework/data";
import { numbered, type PgClient, type PgPool } from "@weft-framework/data/postgres";
import type { AccountToken, AccountTokenKind, AccountTokenStore } from "./account.ts";
import { SqlSessionStore, type SessionRecord, type SessionRow, type SessionStore } from "./auth.ts";
import type { EmailToken, EmailTokenStore } from "./email-signin.ts";
import { jobFromRow, type JobFilter, type JobRecord, type JobStatus, type JobStore } from "./jobs.ts";
import type { PasskeyCredential, PasskeyStore } from "./passkey.ts";
import type { TwoFactorRecord, TwoFactorStore } from "./two-factor.ts";
import type { FileRecord, FileStatus, FileStore } from "./uploads.ts";
import type { WebhookKind, WebhookStore } from "./webhooks.ts";

type Row = Record<string, unknown>;

const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SETUP_LOCK = 0x77656674; // "weft"

abstract class PgStore {
  readonly #pool: PgPool;
  readonly #ddl: string[];
  #ready: Promise<void> | null = null;
  /** The quoted table name. */
  protected readonly t: string;

  constructor(pool: PgPool, table: string, ddl: (t: string, name: string) => string[]) {
    if (!TABLE_RE.test(table)) throw new Error(`@weft-framework/server: not a valid table name: ${table}`);
    this.#pool = pool;
    this.t = `"${table}"`;
    this.#ddl = ddl(this.t, table);
  }

  async #setup(): Promise<void> {
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock($1)", [SETUP_LOCK]);
      for (const sql of this.#ddl) await c.query(sql);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release?.();
    }
  }

  protected async q<R = Row>(sql: string, params: unknown[] = []): Promise<R[]> {
    if (!this.#ready) {
      this.#ready = this.#setup();
      this.#ready.catch(() => (this.#ready = null));
    }
    await this.#ready;
    const text = numbered(sql);
    const tx = enlistAsync(this.#pool);
    const res = tx ? await ((await tx) as PgClient).query(text, params) : await this.#pool.query(text, params);
    return res.rows as R[];
  }

  protected atomically<R>(fn: () => Promise<R>): Promise<R> {
    return asyncTransaction(fn);
  }
}

const num = (v: unknown): number => Number(v);

export class PgSessionStore extends PgStore implements SessionStore {
  constructor(pool: PgPool, table = "weft_sessions") {
    super(pool, table, (t, name) => [
      `CREATE TABLE IF NOT EXISTS ${t} (sid text PRIMARY KEY NOT NULL, "user" text NOT NULL, created bigint NOT NULL, ` +
        `seen bigint NOT NULL, tenant text, pending integer, mfa integer, agent text, view_as text)`,
      `CREATE INDEX IF NOT EXISTS "${name}_user" ON ${t} ("user")`,
    ]);
  }

  async get(sid: string): Promise<SessionRecord | null> {
    const [row] = await this.q<SessionRow>(
      `SELECT "user", created, seen, tenant, pending, mfa, agent, view_as FROM ${this.t} WHERE sid = ?`,
      [sid],
    );
    return row ? SqlSessionStore.record(row) : null;
  }

  async forUser(user: string): Promise<{ sid: string; record: SessionRecord }[]> {
    const rows = await this.q<SessionRow & { sid: string }>(
      `SELECT sid, "user", created, seen, tenant, pending, mfa, agent, view_as FROM ${this.t} WHERE "user" = ?`,
      [user],
    );
    return rows.map((row) => ({ sid: String(row.sid), record: SqlSessionStore.record(row) }));
  }

  async set(sid: string, r: SessionRecord): Promise<void> {
    await this.q(
      `INSERT INTO ${this.t} (sid, "user", created, seen, tenant, pending, mfa, agent, view_as) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
        `ON CONFLICT (sid) DO UPDATE SET "user" = excluded."user", created = excluded.created, seen = excluded.seen, ` +
        `tenant = excluded.tenant, pending = excluded.pending, mfa = excluded.mfa, agent = excluded.agent, view_as = excluded.view_as`,
      [sid, r.user, r.created, r.seen, r.tenant ?? null, r.pending ? 1 : null, r.mfa ? 1 : null, r.agent ?? null, r.viewAs ? JSON.stringify(r.viewAs) : null],
    );
  }

  async delete(sid: string): Promise<void> {
    await this.q(`DELETE FROM ${this.t} WHERE sid = ?`, [sid]);
  }

  async sweep(before: number): Promise<void> {
    await this.q(`DELETE FROM ${this.t} WHERE seen < ?`, [before]);
  }
}

export class PgJobStore extends PgStore implements JobStore {
  constructor(pool: PgPool, table = "weft_jobs") {
    super(pool, table, (t, name) => [
      `CREATE TABLE IF NOT EXISTS ${t} (id text PRIMARY KEY NOT NULL, name text NOT NULL, args text NOT NULL, ` +
        `actor text, status text NOT NULL, attempts integer NOT NULL, max_attempts integer NOT NULL, run_at bigint NOT NULL, ` +
        `created bigint NOT NULL, updated bigint NOT NULL, worker text, lease_until bigint NOT NULL, error text, ` +
        `job_key text UNIQUE, keep_key integer NOT NULL, progress double precision)`,
      `CREATE INDEX IF NOT EXISTS "${name}_due" ON ${t} (status, run_at)`,
    ]);
  }

  async add(r: JobRecord): Promise<boolean> {
    const rows = await this.q(
      `INSERT INTO ${this.t} (id, name, args, actor, status, attempts, max_attempts, run_at, created, updated, worker, ` +
        `lease_until, error, job_key, keep_key, progress) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
        `ON CONFLICT DO NOTHING RETURNING id`,
      [
        r.id, r.name, JSON.stringify(r.args), r.actor ? JSON.stringify(r.actor) : null, r.status, r.attempts, r.maxAttempts,
        r.runAt, r.created, r.updated, r.worker, r.leaseUntil, r.error, r.key, r.keepKey ? 1 : 0, r.progress,
      ],
    );
    return rows.length === 1;
  }

  async get(id: string): Promise<JobRecord | null> {
    return jobFromRow((await this.q(`SELECT * FROM ${this.t} WHERE id = ?`, [id]))[0]);
  }

  async claim(now: number, worker: string, leaseUntil: number): Promise<JobRecord | null> {
    const [row] = await this.q(
      `UPDATE ${this.t} SET status = 'running', attempts = attempts + 1, worker = ?, lease_until = ?, updated = ? ` +
        `WHERE id = (SELECT id FROM ${this.t} WHERE (status = 'queued' AND run_at <= ?) OR (status = 'running' AND lease_until < ?) ` +
        `ORDER BY run_at, id COLLATE "C" LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
      [worker, leaseUntil, now, now, now],
    );
    return jobFromRow(row);
  }

  async extend(id: string, worker: string, leaseUntil: number, progress: number | null): Promise<boolean> {
    const rows = await this.q(
      `UPDATE ${this.t} SET lease_until = ?, progress = COALESCE(?::double precision, progress) ` +
        `WHERE id = ? AND status = 'running' AND worker = ? RETURNING id`,
      [leaseUntil, progress, id, worker],
    );
    return rows.length === 1;
  }

  async settle(id: string, worker: string, to: { status: "queued" | "done" | "dead"; runAt?: number; error?: string | null }, now: number): Promise<boolean> {
    const ended = to.status !== "queued";
    const rows = await this.q(
      `UPDATE ${this.t} SET status = ?, worker = NULL, lease_until = 0, updated = ?, run_at = COALESCE(?::bigint, run_at), ` +
        `error = CASE WHEN ?::int = 1 THEN ?::text ELSE error END, ` +
        `job_key = CASE WHEN ?::int = 1 AND keep_key = 0 THEN NULL ELSE job_key END ` +
        `WHERE id = ? AND status = 'running' AND worker = ? RETURNING id`,
      [to.status, now, to.runAt ?? null, to.error !== undefined ? 1 : 0, to.error ?? null, ended ? 1 : 0, id, worker],
    );
    return rows.length === 1;
  }

  async move(id: string, from: JobStatus[], to: { status: "queued" | "cancelled"; runAt?: number; attempts?: number }, now: number): Promise<boolean> {
    if (from.length === 0) return false;
    const marks = from.map(() => "?").join(", ");
    const rows = await this.q(
      `UPDATE ${this.t} SET status = ?, updated = ?, run_at = COALESCE(?::bigint, run_at), attempts = COALESCE(?::int, attempts), ` +
        `job_key = CASE WHEN ?::int = 1 AND keep_key = 0 THEN NULL ELSE job_key END ` +
        `WHERE id = ? AND status IN (${marks}) RETURNING id`,
      [to.status, now, to.runAt ?? null, to.attempts ?? null, to.status === "cancelled" ? 1 : 0, id, ...from],
    );
    return rows.length === 1;
  }

  async list(f: JobFilter): Promise<JobRecord[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.status) (where.push("status = ?"), args.push(f.status));
    if (f.name) (where.push("name = ?"), args.push(f.name));
    const rows = await this.q(
      `SELECT * FROM ${this.t}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created DESC, id COLLATE "C" DESC LIMIT ?`,
      [...args, Math.min(Math.max(1, f.limit ?? 100), 1000)],
    );
    return rows.map((r) => jobFromRow(r)!);
  }

  async counts(): Promise<Record<JobStatus, number>> {
    const c = { queued: 0, running: 0, done: 0, dead: 0, cancelled: 0 };
    for (const r of await this.q<{ status: JobStatus; n: unknown }>(`SELECT status, count(*) AS n FROM ${this.t} GROUP BY status`)) {
      if (r.status in c) c[r.status] = num(r.n);
    }
    return c;
  }

  async sweep(before: number): Promise<void> {
    await this.q(`DELETE FROM ${this.t} WHERE status IN ('done', 'cancelled') AND updated < ?`, [before]);
  }
}

function passkeyRow(o: Row | undefined): PasskeyCredential | null {
  if (!o) return null;
  return {
    id: String(o.id),
    user: String(o.user_id),
    handle: String(o.handle),
    publicKey: JSON.parse(String(o.public_key)) as JsonWebKey,
    alg: num(o.alg),
    signCount: num(o.sign_count),
    transports: JSON.parse(String(o.transports)) as string[],
    backedUp: num(o.backed_up) === 1,
    name: String(o.name),
    created: num(o.created),
    lastUsed: o.last_used === null || o.last_used === undefined ? null : num(o.last_used),
  };
}

export class PgPasskeyStore extends PgStore implements PasskeyStore {
  constructor(pool: PgPool, table = "weft_passkeys") {
    super(pool, table, (t, name) => [
      `CREATE TABLE IF NOT EXISTS ${t} (id text PRIMARY KEY, user_id text NOT NULL, handle text NOT NULL, ` +
        `public_key text NOT NULL, alg integer NOT NULL, sign_count bigint NOT NULL, transports text NOT NULL, ` +
        `backed_up integer NOT NULL, name text NOT NULL, created bigint NOT NULL, last_used bigint)`,
      `CREATE INDEX IF NOT EXISTS "${name}_user" ON ${t} (user_id)`,
    ]);
  }

  async add(c: PasskeyCredential): Promise<void> {
    await this.q(
      `INSERT INTO ${this.t} (id, user_id, handle, public_key, alg, sign_count, transports, backed_up, name, created, last_used) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.id, c.user, c.handle, JSON.stringify(c.publicKey), c.alg, c.signCount, JSON.stringify(c.transports), c.backedUp ? 1 : 0, c.name, c.created, c.lastUsed],
    );
  }

  async get(id: string): Promise<PasskeyCredential | null> {
    return passkeyRow((await this.q(`SELECT * FROM ${this.t} WHERE id = ?`, [id]))[0]);
  }

  async list(user: string): Promise<PasskeyCredential[]> {
    return (await this.q(`SELECT * FROM ${this.t} WHERE user_id = ? ORDER BY created, id COLLATE "C"`, [user])).map((r) => passkeyRow(r)!);
  }

  async update(id: string, patch: Partial<Pick<PasskeyCredential, "signCount" | "lastUsed" | "backedUp" | "name">>): Promise<void> {
    const cols: Record<string, string> = { signCount: "sign_count", lastUsed: "last_used", backedUp: "backed_up", name: "name" };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      args.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
    if (sets.length) await this.q(`UPDATE ${this.t} SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);
  }

  async remove(id: string): Promise<boolean> {
    return (await this.q(`DELETE FROM ${this.t} WHERE id = ? RETURNING id`, [id])).length > 0;
  }
}

export class PgTwoFactorStore extends PgStore implements TwoFactorStore {
  readonly #r: string;

  constructor(pool: PgPool, table = "weft_two_factor") {
    super(pool, table, (t, name) => [
      `CREATE TABLE IF NOT EXISTS ${t} (user_id text PRIMARY KEY NOT NULL, secret text NOT NULL, ` +
        `last_step bigint NOT NULL, failures integer NOT NULL, locked_until bigint NOT NULL, created bigint NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS "${name}_recovery" (user_id text NOT NULL, hash text NOT NULL, PRIMARY KEY (user_id, hash))`,
    ]);
    this.#r = `"${table}_recovery"`;
  }

  async get(user: string): Promise<TwoFactorRecord | null> {
    const [row] = await this.q(`SELECT secret, last_step, failures, locked_until, created FROM ${this.t} WHERE user_id = ?`, [user]);
    if (!row) return null;
    return {
      user,
      secret: String(row.secret),
      lastStep: num(row.last_step),
      failures: num(row.failures),
      lockedUntil: num(row.locked_until),
      created: num(row.created),
    };
  }

  async add(r: TwoFactorRecord): Promise<boolean> {
    const rows = await this.q(
      `INSERT INTO ${this.t} (user_id, secret, last_step, failures, locked_until, created) VALUES (?, ?, ?, ?, ?, ?) ` +
        `ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
      [r.user, r.secret, r.lastStep, r.failures, r.lockedUntil, r.created],
    );
    return rows.length === 1;
  }

  remove(user: string): Promise<boolean> {
    return this.atomically(async () => {
      await this.q(`DELETE FROM ${this.#r} WHERE user_id = ?`, [user]);
      return (await this.q(`DELETE FROM ${this.t} WHERE user_id = ? RETURNING user_id`, [user])).length === 1;
    });
  }

  async advance(user: string, step: number): Promise<boolean> {
    const rows = await this.q(`UPDATE ${this.t} SET last_step = ?, failures = 0 WHERE user_id = ? AND last_step < ? RETURNING user_id`, [step, user, step]);
    return rows.length === 1;
  }

  async fail(user: string, max: number, until: number): Promise<boolean> {
    const [row] = await this.q(
      `UPDATE ${this.t} SET failures = CASE WHEN failures + 1 >= ?::int THEN 0 ELSE failures + 1 END, ` +
        `locked_until = CASE WHEN failures + 1 >= ?::int THEN ?::bigint ELSE locked_until END WHERE user_id = ? ` +
        `RETURNING failures, locked_until`,
      [max, max, until, user],
    );
    return row !== undefined && num(row.failures) === 0 && num(row.locked_until) === until;
  }

  async succeed(user: string): Promise<void> {
    await this.q(`UPDATE ${this.t} SET failures = 0 WHERE user_id = ?`, [user]);
  }

  setRecovery(user: string, hashes: string[]): Promise<void> {
    return this.atomically(async () => {
      await this.q(`DELETE FROM ${this.#r} WHERE user_id = ?`, [user]);
      for (const h of hashes) await this.q(`INSERT INTO ${this.#r} (user_id, hash) VALUES (?, ?)`, [user, h]);
    });
  }

  async useRecovery(user: string, hash: string): Promise<boolean> {
    return (await this.q(`DELETE FROM ${this.#r} WHERE user_id = ? AND hash = ? RETURNING hash`, [user, hash])).length === 1;
  }

  async countRecovery(user: string): Promise<number> {
    const [row] = await this.q(`SELECT count(*) AS n FROM ${this.#r} WHERE user_id = ?`, [user]);
    return num(row?.n ?? 0);
  }
}

function emailRow(o: Row | undefined): EmailToken | null {
  if (!o) return null;
  return {
    id: String(o.id),
    email: String(o.email),
    code: String(o.code),
    session: String(o.session),
    next: String(o.next),
    expires: num(o.expires),
    attempts: num(o.attempts),
  };
}

export class PgEmailTokenStore extends PgStore implements EmailTokenStore {
  constructor(pool: PgPool, table = "weft_email_tokens") {
    super(pool, table, (t, name) => [
      `CREATE TABLE IF NOT EXISTS ${t} (id text PRIMARY KEY, email text NOT NULL, code text NOT NULL, ` +
        `session text NOT NULL, next text NOT NULL, expires bigint NOT NULL, attempts integer NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS "${name}_session" ON ${t} (session, email)`,
    ]);
  }

  async add(t: EmailToken): Promise<void> {
    await this.q(`INSERT INTO ${this.t} (id, email, code, session, next, expires, attempts) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
      t.id, t.email, t.code, t.session, t.next, t.expires, t.attempts,
    ]);
  }

  async get(id: string): Promise<EmailToken | null> {
    return emailRow((await this.q(`SELECT * FROM ${this.t} WHERE id = ?`, [id]))[0]);
  }

  async find(session: string, email: string): Promise<EmailToken | null> {
    return emailRow((await this.q(`SELECT * FROM ${this.t} WHERE session = ? AND email = ? ORDER BY expires DESC LIMIT 1`, [session, email]))[0]);
  }

  async attempt(id: string): Promise<number> {
    const [r] = await this.q(`UPDATE ${this.t} SET attempts = attempts + 1 WHERE id = ? RETURNING attempts`, [id]);
    return r ? num(r.attempts) : Number.POSITIVE_INFINITY;
  }

  async take(id: string): Promise<boolean> {
    return (await this.q(`DELETE FROM ${this.t} WHERE id = ? RETURNING id`, [id])).length > 0;
  }

  async clear(session: string, email: string): Promise<void> {
    await this.q(`DELETE FROM ${this.t} WHERE session = ? AND email = ?`, [session, email]);
  }

  async sweep(now: number): Promise<void> {
    await this.q(`DELETE FROM ${this.t} WHERE expires <= ?`, [now]);
  }
}

function accountRow(r: Row | undefined): AccountToken | null {
  if (!r) return null;
  const t: AccountToken = { id: String(r.id), kind: String(r.kind) as AccountTokenKind, user: String(r.user_id), email: String(r.email), expires: num(r.expires) };
  if (r.data !== null && r.data !== undefined) t.data = String(r.data);
  return t;
}

export class PgAccountTokenStore extends PgStore implements AccountTokenStore {
  constructor(pool: PgPool, table = "weft_account_tokens") {
    super(pool, table, (t, name) => [
      `CREATE TABLE IF NOT EXISTS ${t} (id text PRIMARY KEY NOT NULL, kind text NOT NULL, user_id text NOT NULL, ` +
        `email text NOT NULL, expires bigint NOT NULL, data text)`,
      `CREATE INDEX IF NOT EXISTS "${name}_user" ON ${t} (user_id, kind)`,
    ]);
  }

  async add(t: AccountToken): Promise<void> {
    await this.q(`INSERT INTO ${this.t} (id, kind, user_id, email, expires, data) VALUES (?, ?, ?, ?, ?, ?)`, [
      t.id, t.kind, t.user, t.email, t.expires, t.data ?? null,
    ]);
  }

  async get(id: string): Promise<AccountToken | null> {
    return accountRow((await this.q(`SELECT * FROM ${this.t} WHERE id = ?`, [id]))[0]);
  }

  async take(id: string): Promise<AccountToken | null> {
    return accountRow((await this.q(`DELETE FROM ${this.t} WHERE id = ? RETURNING id, kind, user_id, email, expires, data`, [id]))[0]);
  }

  async clear(user: string, kind: AccountTokenKind): Promise<void> {
    await this.q(`DELETE FROM ${this.t} WHERE user_id = ? AND kind = ?`, [user, kind]);
  }

  async sweep(now: number): Promise<void> {
    await this.q(`DELETE FROM ${this.t} WHERE expires <= ?`, [now]);
  }
}

function fileRow(x: Row): FileRecord {
  return {
    id: String(x.id),
    kind: String(x.kind),
    owner: String(x.owner),
    name: String(x.name),
    type: String(x.type),
    size: num(x.size),
    partBytes: num(x.part_bytes),
    status: String(x.status) as FileStatus,
    upload: String(x.upload),
    claimed: num(x.claimed) === 1,
    created: num(x.created),
  };
}

export class PgFileStore extends PgStore implements FileStore {
  constructor(pool: PgPool, table = "weft_files") {
    super(pool, table, (t, name) => [
      `CREATE TABLE IF NOT EXISTS ${t} (id text PRIMARY KEY NOT NULL, kind text NOT NULL, owner text NOT NULL, ` +
        `name text NOT NULL, type text NOT NULL, size bigint NOT NULL, part_bytes bigint NOT NULL, status text NOT NULL, ` +
        `upload text NOT NULL, claimed integer NOT NULL, created bigint NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS "${name}_owner" ON ${t} (owner, status)`,
      `CREATE INDEX IF NOT EXISTS "${name}_created" ON ${t} (created)`,
    ]);
  }

  async put(r: FileRecord): Promise<void> {
    await this.q(
      `INSERT INTO ${this.t} (id, kind, owner, name, type, size, part_bytes, status, upload, claimed, created) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, owner = excluded.owner, ` +
        `name = excluded.name, type = excluded.type, size = excluded.size, part_bytes = excluded.part_bytes, ` +
        `status = excluded.status, upload = excluded.upload, claimed = excluded.claimed, created = excluded.created`,
      [r.id, r.kind, r.owner, r.name, r.type, r.size, r.partBytes, r.status, r.upload, r.claimed ? 1 : 0, r.created],
    );
  }

  async get(id: string): Promise<FileRecord | null> {
    const [r] = await this.q(`SELECT * FROM ${this.t} WHERE id = ?`, [id]);
    return r ? fileRow(r) : null;
  }

  async remove(id: string): Promise<void> {
    await this.q(`DELETE FROM ${this.t} WHERE id = ?`, [id]);
  }

  async pending(owner: string): Promise<number> {
    const [r] = await this.q(`SELECT count(*) AS n FROM ${this.t} WHERE owner = ? AND status = 'uploading'`, [owner]);
    return num(r?.n ?? 0);
  }

  async stale(uploadingBefore: number, unclaimedBefore: number, limit: number): Promise<FileRecord[]> {
    const rows = await this.q(
      `SELECT * FROM ${this.t} WHERE (status = 'uploading' AND created < ?) OR (status = 'ready' AND claimed = 0 AND created < ?) LIMIT ?`,
      [uploadingBefore, unclaimedBefore, limit],
    );
    return rows.map(fileRow);
  }
}

export class PgWebhookStore extends PgStore implements WebhookStore {
  constructor(pool: PgPool, table = "weft_webhooks") {
    super(pool, table, (t, name) => [
      `CREATE TABLE IF NOT EXISTS ${t} (kind text NOT NULL, id text NOT NULL, owner text NOT NULL, ref text, ` +
        `created bigint NOT NULL, data text NOT NULL, seq bigserial, PRIMARY KEY (kind, id))`,
      `CREATE INDEX IF NOT EXISTS "${name}_owner" ON ${t} (kind, owner, created)`,
    ]);
  }

  async put(kind: WebhookKind, id: string, owner: string, ref: string | null, created: number, data: string): Promise<void> {
    await this.q(
      `INSERT INTO ${this.t} (kind, id, owner, ref, created, data) VALUES (?, ?, ?, ?, ?, ?) ` +
        `ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data`,
      [kind, id, owner, ref, created, data],
    );
  }

  async get(kind: WebhookKind, id: string): Promise<string | null> {
    const [r] = await this.q(`SELECT data FROM ${this.t} WHERE kind = ? AND id = ?`, [kind, id]);
    return r ? String(r.data) : null;
  }

  async list(kind: WebhookKind, owner: string, o: { ref?: string; limit: number; before?: number }): Promise<string[]> {
    const where = ["kind = ?", "owner = ?"];
    const args: unknown[] = [kind, owner];
    if (o.ref !== undefined) (where.push("ref = ?"), args.push(o.ref));
    if (o.before !== undefined) (where.push("created < ?"), args.push(o.before));
    const rows = await this.q(`SELECT data FROM ${this.t} WHERE ${where.join(" AND ")} ORDER BY created DESC, seq DESC LIMIT ?`, [...args, o.limit]);
    return rows.map((r) => String(r.data));
  }

  async remove(kind: WebhookKind, id: string): Promise<void> {
    await this.q(`DELETE FROM ${this.t} WHERE kind = ? AND id = ?`, [kind, id]);
  }

  async sweep(kind: WebhookKind, before: number, owner?: string): Promise<number> {
    const rows = owner === undefined
      ? await this.q(`DELETE FROM ${this.t} WHERE kind = ? AND created < ? RETURNING id`, [kind, before])
      : await this.q(`DELETE FROM ${this.t} WHERE kind = ? AND created < ? AND owner = ? RETURNING id`, [kind, before, owner]);
    return rows.length;
  }
}
