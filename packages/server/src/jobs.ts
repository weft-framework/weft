import { defineModel, type Model, type PolicyExpr, type SqlDatabase } from "@weft-framework/data";
import { decodeJson, type ParamSpec } from "./action.ts";
import { authState } from "./auth.ts";
import type { PageContext } from "./context.ts";
import type { Span, Telemetry } from "./otel.ts";

type Maybe<T> = T | Promise<T>;

export type JobStatus = "queued" | "running" | "done" | "dead" | "cancelled";

export interface JobActor {
  user: string;
  tenant?: string;
}

export interface JobRecord {
  id: string;
  name: string;
  args: unknown[];
  actor: JobActor | null;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: number;
  created: number;
  updated: number;
  worker: string | null;
  leaseUntil: number;
  error: string | null;
  key: string | null;
  keepKey: boolean;
  progress: number | null;
}

export interface JobFilter {
  status?: JobStatus;
  name?: string;
  limit?: number;
}

export interface JobStore {
  add(r: JobRecord): Maybe<boolean>;
  get(id: string): Maybe<JobRecord | null | undefined>;
  claim(now: number, worker: string, leaseUntil: number): Maybe<JobRecord | null | undefined>;
  extend(id: string, worker: string, leaseUntil: number, progress: number | null): Maybe<boolean>;
  settle(id: string, worker: string, to: { status: "queued" | "done" | "dead"; runAt?: number; error?: string | null }, now: number): Maybe<boolean>;
  move(id: string, from: JobStatus[], to: { status: "queued" | "cancelled"; runAt?: number; attempts?: number }, now: number): Maybe<boolean>;
  list(f: JobFilter): Maybe<JobRecord[]>;
  counts(): Maybe<Record<JobStatus, number>>;
  sweep(before: number): Maybe<void>;
}

const ENDED = new Set<JobStatus>(["done", "dead", "cancelled"]);

export class MemoryJobStore implements JobStore {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #keys = new Map<string, string>();

  add(r: JobRecord): boolean {
    if (r.key !== null && this.#keys.has(r.key)) return false;
    this.#jobs.set(r.id, structuredClone(r));
    if (r.key !== null) this.#keys.set(r.key, r.id);
    return true;
  }
  get(id: string): JobRecord | null {
    const r = this.#jobs.get(id);
    return r ? structuredClone(r) : null;
  }
  claim(now: number, worker: string, leaseUntil: number): JobRecord | null {
    let best: JobRecord | null = null;
    for (const r of this.#jobs.values()) {
      const due = (r.status === "queued" && r.runAt <= now) || (r.status === "running" && r.leaseUntil < now);
      if (due && (!best || r.runAt < best.runAt)) best = r;
    }
    if (!best) return null;
    Object.assign(best, { status: "running", attempts: best.attempts + 1, worker, leaseUntil, updated: now });
    return structuredClone(best);
  }
  extend(id: string, worker: string, leaseUntil: number, progress: number | null): boolean {
    const r = this.#jobs.get(id);
    if (!r || r.status !== "running" || r.worker !== worker) return false;
    r.leaseUntil = leaseUntil;
    if (progress !== null) r.progress = progress;
    return true;
  }
  settle(id: string, worker: string, to: { status: "queued" | "done" | "dead"; runAt?: number; error?: string | null }, now: number): boolean {
    const r = this.#jobs.get(id);
    if (!r || r.status !== "running" || r.worker !== worker) return false;
    r.status = to.status;
    r.worker = null;
    r.leaseUntil = 0;
    r.updated = now;
    if (to.runAt !== undefined) r.runAt = to.runAt;
    if (to.error !== undefined) r.error = to.error;
    if (ENDED.has(r.status)) this.#release(r);
    return true;
  }
  move(id: string, from: JobStatus[], to: { status: "queued" | "cancelled"; runAt?: number; attempts?: number }, now: number): boolean {
    const r = this.#jobs.get(id);
    if (!r || !from.includes(r.status)) return false;
    if (to.status === "queued" && r.key !== null && this.#keys.get(r.key) !== r.id) {
      if (this.#keys.has(r.key)) return false;
      this.#keys.set(r.key, r.id);
    }
    r.status = to.status;
    r.updated = now;
    if (to.runAt !== undefined) r.runAt = to.runAt;
    if (to.attempts !== undefined) r.attempts = to.attempts;
    if (ENDED.has(r.status)) this.#release(r);
    return true;
  }
  #release(r: JobRecord): void {
    if (r.key !== null && !r.keepKey && this.#keys.get(r.key) === r.id) this.#keys.delete(r.key);
  }
  list(f: JobFilter): JobRecord[] {
    const out = [...this.#jobs.values()].filter((r) => (!f.status || r.status === f.status) && (!f.name || r.name === f.name));
    out.sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
    return out.slice(0, f.limit ?? 100).map((r) => structuredClone(r));
  }
  counts(): Record<JobStatus, number> {
    const c = { queued: 0, running: 0, done: 0, dead: 0, cancelled: 0 };
    for (const r of this.#jobs.values()) c[r.status]++;
    return c;
  }
  sweep(before: number): void {
    for (const [id, r] of this.#jobs) {
      if ((r.status === "done" || r.status === "cancelled") && r.updated < before) {
        this.#jobs.delete(id);
        if (r.key !== null && this.#keys.get(r.key) === id) this.#keys.delete(r.key);
      }
    }
  }
}

/** @internal Shared by `SqlJobStore` and `PgJobStore`. */
export function jobFromRow(r: Record<string, unknown> | undefined): JobRecord | null {
  if (!r) return null;
  return {
    id: String(r.id),
    name: String(r.name),
    args: JSON.parse(String(r.args)) as unknown[],
    actor: r.actor === null || r.actor === undefined ? null : (JSON.parse(String(r.actor)) as JobActor),
    status: String(r.status) as JobStatus,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    runAt: Number(r.run_at),
    created: Number(r.created),
    updated: Number(r.updated),
    worker: r.worker === null || r.worker === undefined ? null : String(r.worker),
    leaseUntil: Number(r.lease_until),
    error: r.error === null || r.error === undefined ? null : String(r.error),
    key: r.job_key === null || r.job_key === undefined ? null : String(r.job_key),
    keepKey: r.keep_key === true || Number(r.keep_key) === 1,
    progress: r.progress === null || r.progress === undefined ? null : Number(r.progress),
  };
}

export class SqlJobStore implements JobStore {
  readonly #db: SqlDatabase;
  readonly #t: string;

  constructor(db: SqlDatabase, table = "weft_jobs") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`@weft-framework/server: not a valid table name: ${table}`);
    this.#db = db;
    this.#t = `"${table}"`;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#t} (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, ` +
        `actor TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, run_at INTEGER NOT NULL, ` +
        `created INTEGER NOT NULL, updated INTEGER NOT NULL, worker TEXT, lease_until INTEGER NOT NULL, error TEXT, ` +
        `job_key TEXT UNIQUE, keep_key INTEGER NOT NULL, progress REAL)`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_due" ON ${this.#t} (status, run_at)`);
  }

  add(r: JobRecord): boolean {
    return (
      this.#db
        .prepare(
          `INSERT INTO ${this.#t} (id, name, args, actor, status, attempts, max_attempts, run_at, created, updated, worker, ` +
            `lease_until, error, job_key, keep_key, progress) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
            `ON CONFLICT DO NOTHING RETURNING id`,
        )
        .all(
          r.id, r.name, JSON.stringify(r.args), r.actor ? JSON.stringify(r.actor) : null, r.status, r.attempts, r.maxAttempts,
          r.runAt, r.created, r.updated, r.worker, r.leaseUntil, r.error, r.key, r.keepKey ? 1 : 0, r.progress,
        ).length === 1
    );
  }
  get(id: string): JobRecord | null {
    return jobFromRow(this.#db.prepare(`SELECT * FROM ${this.#t} WHERE id = ?`).all(id)[0] as Record<string, unknown>);
  }
  claim(now: number, worker: string, leaseUntil: number): JobRecord | null {
    const due = `((status = 'queued' AND run_at <= ?) OR (status = 'running' AND lease_until < ?))`;
    const row = this.#db
      .prepare(
        `UPDATE ${this.#t} SET status = 'running', attempts = attempts + 1, worker = ?, lease_until = ?, updated = ? ` +
          `WHERE id = (SELECT id FROM ${this.#t} WHERE ${due} ORDER BY run_at, id LIMIT 1) AND ${due} RETURNING *`,
      )
      .all(worker, leaseUntil, now, now, now, now, now)[0] as Record<string, unknown> | undefined;
    return jobFromRow(row);
  }
  extend(id: string, worker: string, leaseUntil: number, progress: number | null): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE ${this.#t} SET lease_until = ?, progress = COALESCE(?, progress) WHERE id = ? AND status = 'running' AND worker = ? RETURNING id`,
        )
        .all(leaseUntil, progress, id, worker).length === 1
    );
  }
  settle(id: string, worker: string, to: { status: "queued" | "done" | "dead"; runAt?: number; error?: string | null }, now: number): boolean {
    const ended = to.status !== "queued";
    return (
      this.#db
        .prepare(
          `UPDATE ${this.#t} SET status = ?, worker = NULL, lease_until = 0, updated = ?, run_at = COALESCE(?, run_at), ` +
            `error = CASE WHEN ? THEN ? ELSE error END, ` +
            `job_key = CASE WHEN ? AND keep_key = 0 THEN NULL ELSE job_key END ` +
            `WHERE id = ? AND status = 'running' AND worker = ? RETURNING id`,
        )
        .all(to.status, now, to.runAt ?? null, to.error !== undefined ? 1 : 0, to.error ?? null, ended ? 1 : 0, id, worker).length === 1
    );
  }
  move(id: string, from: JobStatus[], to: { status: "queued" | "cancelled"; runAt?: number; attempts?: number }, now: number): boolean {
    const marks = from.map(() => "?").join(", ");
    return (
      this.#db
        .prepare(
          `UPDATE ${this.#t} SET status = ?, updated = ?, run_at = COALESCE(?, run_at), attempts = COALESCE(?, attempts), ` +
            `job_key = CASE WHEN ? AND keep_key = 0 THEN NULL ELSE job_key END ` +
            `WHERE id = ? AND status IN (${marks}) RETURNING id`,
        )
        .all(to.status, now, to.runAt ?? null, to.attempts ?? null, to.status === "cancelled" ? 1 : 0, id, ...from).length === 1
    );
  }
  list(f: JobFilter): JobRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.status) (where.push("status = ?"), args.push(f.status));
    if (f.name) (where.push("name = ?"), args.push(f.name));
    const rows = this.#db
      .prepare(`SELECT * FROM ${this.#t}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created DESC, id DESC LIMIT ?`)
      .all(...(args as never[]), Math.min(Math.max(1, f.limit ?? 100), 1000)) as Record<string, unknown>[];
    return rows.map((r) => jobFromRow(r)!);
  }
  counts(): Record<JobStatus, number> {
    const c = { queued: 0, running: 0, done: 0, dead: 0, cancelled: 0 };
    for (const r of this.#db.prepare(`SELECT status, count(*) AS n FROM ${this.#t} GROUP BY status`).all() as { status: JobStatus; n: number }[]) {
      if (r.status in c) c[r.status] = Number(r.n);
    }
    return c;
  }
  sweep(before: number): void {
    this.#db.prepare(`DELETE FROM ${this.#t} WHERE status IN ('done', 'cancelled') AND updated < ?`).run(before);
  }
}

export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class PgJobStore implements JobStore {
  readonly #db: PgQueryable;
  readonly #t: string;
  readonly #table: string;
  #ready: Promise<void> | null = null;

  constructor(db: PgQueryable, table = "weft_jobs") {
    if (!db || typeof db.query !== "function") throw new TypeError("PgJobStore: needs a Postgres pool (`query(text, values)`)");
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,50}$/.test(table)) throw new Error(`@weft-framework/server: not a valid table name: ${table}`);
    this.#db = db;
    this.#table = table;
    this.#t = `"${table}"`;
  }

  ready(): Promise<void> {
    this.#ready ??= (async () => {
      await this.#db.query(
        `CREATE TABLE IF NOT EXISTS ${this.#t} (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, ` +
          `actor TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, run_at BIGINT NOT NULL, ` +
          `created BIGINT NOT NULL, updated BIGINT NOT NULL, worker TEXT, lease_until BIGINT NOT NULL, error TEXT, ` +
          `job_key TEXT UNIQUE, keep_key BOOLEAN NOT NULL, progress DOUBLE PRECISION)`,
      );
      await this.#db.query(`CREATE INDEX IF NOT EXISTS "${this.#table}_due" ON ${this.#t} (status, run_at)`);
    })().catch((err: unknown) => {
      this.#ready = null;
      throw err;
    });
    return this.#ready;
  }

  async #q(text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
    await this.ready();
    return (await this.#db.query(text, values)).rows;
  }

  async add(r: JobRecord): Promise<boolean> {
    const rows = await this.#q(
      `INSERT INTO ${this.#t} (id, name, args, actor, status, attempts, max_attempts, run_at, created, updated, worker, ` +
        `lease_until, error, job_key, keep_key, progress) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ` +
        `ON CONFLICT DO NOTHING RETURNING id`,
      [
        r.id, r.name, JSON.stringify(r.args), r.actor ? JSON.stringify(r.actor) : null, r.status, r.attempts, r.maxAttempts,
        r.runAt, r.created, r.updated, r.worker, r.leaseUntil, r.error, r.key, r.keepKey, r.progress,
      ],
    );
    return rows.length === 1;
  }
  async get(id: string): Promise<JobRecord | null> {
    return jobFromRow((await this.#q(`SELECT * FROM ${this.#t} WHERE id = $1`, [id]))[0]);
  }
  async claim(now: number, worker: string, leaseUntil: number): Promise<JobRecord | null> {
    const rows = await this.#q(
      `UPDATE ${this.#t} SET status = 'running', attempts = attempts + 1, worker = $1, lease_until = $2, updated = $3 ` +
        `WHERE id = (SELECT id FROM ${this.#t} WHERE (status = 'queued' AND run_at <= $3) OR (status = 'running' AND lease_until < $3) ` +
        `ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
      [worker, leaseUntil, now],
    );
    return jobFromRow(rows[0]);
  }
  async extend(id: string, worker: string, leaseUntil: number, progress: number | null): Promise<boolean> {
    const rows = await this.#q(
      `UPDATE ${this.#t} SET lease_until = $1, progress = COALESCE($2::double precision, progress) ` +
        `WHERE id = $3 AND status = 'running' AND worker = $4 RETURNING id`,
      [leaseUntil, progress, id, worker],
    );
    return rows.length === 1;
  }
  async settle(id: string, worker: string, to: { status: "queued" | "done" | "dead"; runAt?: number; error?: string | null }, now: number): Promise<boolean> {
    const rows = await this.#q(
      `UPDATE ${this.#t} SET status = $1, worker = NULL, lease_until = 0, updated = $2, run_at = COALESCE($3::bigint, run_at), ` +
        `error = CASE WHEN $4::boolean THEN $5::text ELSE error END, ` +
        `job_key = CASE WHEN $6::boolean AND NOT keep_key THEN NULL ELSE job_key END ` +
        `WHERE id = $7 AND status = 'running' AND worker = $8 RETURNING id`,
      [to.status, now, to.runAt ?? null, to.error !== undefined, to.error ?? null, to.status !== "queued", id, worker],
    );
    return rows.length === 1;
  }
  async move(id: string, from: JobStatus[], to: { status: "queued" | "cancelled"; runAt?: number; attempts?: number }, now: number): Promise<boolean> {
    const rows = await this.#q(
      `UPDATE ${this.#t} SET status = $1, updated = $2, run_at = COALESCE($3::bigint, run_at), attempts = COALESCE($4::integer, attempts), ` +
        `job_key = CASE WHEN $5::boolean AND NOT keep_key THEN NULL ELSE job_key END ` +
        `WHERE id = $6 AND status = ANY($7::text[]) RETURNING id`,
      [to.status, now, to.runAt ?? null, to.attempts ?? null, to.status === "cancelled", id, [...from]],
    );
    return rows.length === 1;
  }
  async list(f: JobFilter): Promise<JobRecord[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.status) (args.push(f.status), where.push(`status = $${args.length}`));
    if (f.name) (args.push(f.name), where.push(`name = $${args.length}`));
    args.push(Math.min(Math.max(1, f.limit ?? 100), 1000));
    const rows = await this.#q(
      `SELECT * FROM ${this.#t}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created DESC, id DESC LIMIT $${args.length}`,
      args,
    );
    return rows.map((r) => jobFromRow(r)!);
  }
  async counts(): Promise<Record<JobStatus, number>> {
    const c = { queued: 0, running: 0, done: 0, dead: 0, cancelled: 0 };
    for (const r of await this.#q(`SELECT status, count(*) AS n FROM ${this.#t} GROUP BY status`)) {
      const s = String(r.status) as JobStatus;
      if (s in c) c[s] = Number(r.n);
    }
    return c;
  }
  async sweep(before: number): Promise<void> {
    await this.#q(`DELETE FROM ${this.#t} WHERE status IN ('done', 'cancelled') AND updated < $1`, [before]);
  }
}

export interface JobContext {
  user: unknown;
  job: { id: string; name: string; attempt: number; maxAttempts: number };
  signal: AbortSignal;
  progress(fraction: number): void;
}

export interface JobOptions {
  attempts?: number;
  backoff?(attempt: number): number;
  timeoutMs?: number;
}

const JOB = Symbol.for("weft.job");

export interface Job<A extends unknown[] = never[]> {
  readonly [JOB]: true;
  readonly name: string;
  readonly params: readonly ParamSpec[];
  readonly options: Required<Omit<JobOptions, "backoff">> & Pick<JobOptions, "backoff">;
  run(ctx: JobContext, ...args: A): unknown;
}

export class JobError extends Error {
  readonly retry: boolean;
  constructor(message: string, opts: { retry?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "JobError";
    this.retry = opts.retry !== false;
  }
}

function range(what: string, v: number, lo: number, hi: number): number {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} is ${lo} to ${hi}`);
  return v;
}

export function defineJob<A extends unknown[]>(
  name: string,
  params: readonly ParamSpec[],
  run: (ctx: JobContext, ...args: A) => unknown,
  opts: JobOptions = {},
): Job<A> {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) throw new Error(`defineJob: not a valid job name: ${name}`);
  if (typeof run !== "function") throw new Error(`defineJob ${name}: the body is a function`);
  if (opts.backoff !== undefined && typeof opts.backoff !== "function") throw new Error(`defineJob ${name}: backoff is a function`);
  return Object.freeze({
    [JOB]: true as const,
    name,
    params: Object.freeze([...params]),
    options: Object.freeze({
      attempts: range(`defineJob ${name}: attempts`, opts.attempts ?? 5, 1, 100),
      timeoutMs: range(`defineJob ${name}: timeoutMs`, opts.timeoutMs ?? 10 * 60_000, 1000, 24 * 3600_000),
      ...(opts.backoff ? { backoff: opts.backoff } : {}),
    }),
    run,
  });
}

export function isJob(v: unknown): v is Job<unknown[]> {
  return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[JOB] === true;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface Cron {
  readonly expression: string;
  next(after: number): number;
}

export function parseCron(expression: string): Cron {
  if (typeof expression !== "string") throw new Error("cron: an expression is a string");
  const src = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = src.split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron: "${expression}" needs five fields (minute hour day month weekday)`);
  const field = (text: string, lo: number, hi: number, names?: string[], offset = 0): Set<number> => {
    const out = new Set<number>();
    for (const item of text.toLowerCase().split(",")) {
      const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new Error(`cron: bad field "${text}" in "${expression}"`);
      const value = (s: string) => {
        const i = names ? names.indexOf(s) : -1;
        const n = i >= 0 ? i + offset : /^\d+$/.test(s) ? Number(s) : NaN;
        if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`cron: ${s} is out of range in "${expression}"`);
        return n;
      };
      let a = lo;
      let b = hi;
      if (m[1] !== "*") {
        const [x, y] = m[1].split("-");
        a = value(x);
        b = y !== undefined ? value(y) : m[2] !== undefined ? hi : a;
        if (b < a) throw new Error(`cron: range ${m[1]} runs backwards in "${expression}"`);
      }
      const step = m[2] !== undefined ? Number(m[2]) : 1;
      if (step < 1 || step > hi - lo + 1) throw new Error(`cron: bad step in "${expression}"`);
      for (let v = a; v <= b; v += step) out.add(v);
    }
    return out;
  };
  const minutes = field(parts[0], 0, 59);
  const hours = field(parts[1], 0, 23);
  const doms = field(parts[2], 1, 31);
  const months = field(parts[3], 1, 12, MONTHS, 1);
  const dows = field(parts[4], 0, 7, DAYS);
  if (dows.has(7)) dows.add(0);
  const domAny = parts[2] === "*" || parts[2].startsWith("*/") && doms.size === 31;
  const dowAny = parts[4] === "*" || parts[4].startsWith("*/") && dows.size >= 7;
  const dayMatches = (d: Date) => {
    const dom = doms.has(d.getUTCDate());
    const dow = dows.has(d.getUTCDay());
    if (domAny && dowAny) return true;
    if (domAny) return dow;
    if (dowAny) return dom;
    return dom || dow;
  };
  return Object.freeze({
    expression,
    next(after: number): number {
      let t = Math.floor(after / 60_000) * 60_000 + 60_000;
      for (let i = 0; i < 200_000; i++) {
        const d = new Date(t);
        if (!months.has(d.getUTCMonth() + 1)) {
          t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
          continue;
        }
        if (!dayMatches(d)) {
          t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
          continue;
        }
        if (!hours.has(d.getUTCHours())) {
          t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
          continue;
        }
        if (!minutes.has(d.getUTCMinutes())) {
          t += 60_000;
          continue;
        }
        return t;
      }
      throw new Error(`cron: "${expression}" never fires`);
    },
  });
}

export interface Schedule {
  name?: string;
  cron: string;
  job: Job<never[]> | Job<unknown[]>;
  args?: Record<string, unknown>;
  as?: JobActor;
}

export interface ScheduleInfo {
  name: string;
  cron: string;
  job: string;
  next: number;
  as: JobActor | null;
}

export interface JobProgressRow {
  id: string;
  user: string;
  name: string;
  status: string;
  progress: number | null;
  updated: number;
}

export interface JobsOptions {
  jobs: readonly Job<never[]>[] | readonly Job<unknown[]>[] | Record<string, unknown>;
  track?: { prefix?: string };
  store?: JobStore;
  user?(id: string, tenant?: string): unknown;
  concurrency?: number;
  pollMs?: number;
  leaseMs?: number;
  schedule?: readonly Schedule[];
  keepDoneMs?: number;
  onError?(err: unknown, job: JobRecord | null): void;
  telemetry?: Pick<Telemetry, "span">;
  now?(): number;
  random?(): number;
}

export interface EnqueueOptions {
  delayMs?: number;
  runAt?: number;
  key?: string;
  as?: JobActor | null;
  track?: boolean;
}

class Tracker {
  readonly tracker = true;
}
const TRACKER = new Tracker();
const PROGRESS_STATUS: Record<JobStatus, string> = { queued: "queued", running: "running", done: "done", dead: "failed", cancelled: "cancelled" };

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class Jobs {
  readonly #jobs = new Map<string, Job<unknown[]>>();
  readonly #store: JobStore;
  readonly #user: JobsOptions["user"];
  readonly #concurrency: number;
  readonly #pollMs: number;
  readonly #leaseMs: number;
  readonly #keepDone: number;
  readonly #onError: (err: unknown, job: JobRecord | null) => void;
  readonly #telemetry: Pick<Telemetry, "span"> | null;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #worker = randomId();
  readonly #schedules: { name: string; expression: string; cron: Cron; job: Job<unknown[]>; args: unknown[]; as: JobActor | null; next: number }[] = [];
  readonly #running = new Set<Promise<void>>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #swept = 0;
  readonly models: { JobProgress?: Model<JobProgressRow> } = {};
  readonly #progress: Model<JobProgressRow> | null = null;

  constructor(o: JobsOptions) {
    const list = Array.isArray(o.jobs) ? o.jobs : Object.values(o.jobs ?? {}).filter(isJob);
    for (const j of list) {
      if (!isJob(j)) throw new Error("createJobs: `jobs` holds jobs made with defineJob");
      if (this.#jobs.has(j.name)) throw new Error(`createJobs: two jobs are called ${j.name}`);
      this.#jobs.set(j.name, j as Job<unknown[]>);
    }
    this.#store = o.store ?? new MemoryJobStore();
    this.#user = o.user;
    this.#concurrency = range("createJobs: concurrency", o.concurrency ?? 4, 1, 64);
    this.#pollMs = range("createJobs: pollMs", o.pollMs ?? 1000, 10, 60_000);
    this.#leaseMs = range("createJobs: leaseMs", o.leaseMs ?? 60_000, 5000, 3600_000);
    this.#keepDone = range("createJobs: keepDoneMs", o.keepDoneMs ?? 24 * 3600_000, 60_000, 90 * 24 * 3600_000);
    this.#onError = o.onError ?? ((err, job) => console.error(`[weft] job ${job?.name ?? "queue"}:`, err));
    this.#telemetry = o.telemetry ?? null;
    this.#now = o.now ?? Date.now;
    this.#random = o.random ?? Math.random;
    if (o.track !== undefined) {
      const prefix = o.track?.prefix ?? "Weft";
      if (!/^[A-Z][A-Za-z0-9]{0,31}$/.test(prefix)) throw new Error("createJobs: track.prefix is a model name");
      const mine = (a: unknown, r: { user: string }) =>
        a instanceof Tracker || (typeof a === "object" && a !== null && typeof (a as { id?: unknown }).id === "string" && (a as { id: string }).id === r.user);
      const where: PolicyExpr = { or: [{ cmp: "==", l: { field: ["user"] }, r: { actor: ["id"] } }, { truthy: { actor: ["tracker"] } }] };
      this.#progress = defineModel<JobProgressRow>(`${prefix}JobProgress`, {
        fields: { id: "string", user: "string", name: "string", status: "string", progress: "number | null", updated: "number" },
        read: mine,
        write: (a: unknown) => a instanceof Tracker,
        readWhere: where,
        writeWhere: { truthy: { actor: ["tracker"] } },
      });
      this.models.JobProgress = this.#progress;
    }
    const now = this.#now();
    const names = new Set<string>();
    for (const s of o.schedule ?? []) {
      if (!isJob(s.job) || this.#jobs.get(s.job.name) !== s.job) throw new Error("createJobs: a schedule's job must be one of `jobs`");
      const name = s.name ?? s.job.name;
      if (names.has(name)) throw new Error(`createJobs: two schedules are called ${name} (give one a name)`);
      names.add(name);
      const cron = parseCron(s.cron);
      this.#schedules.push({ name, expression: s.cron.trim(), cron, job: s.job as Job<unknown[]>, args: this.#args(s.job as Job<unknown[]>, s.args ?? {}), as: s.as ?? null, next: cron.next(now) });
    }
  }

  #args(job: Job<unknown[]>, args: Record<string, unknown>): unknown[] {
    const d = decodeJson(job.params, args);
    if (!d.ok) throw new TypeError(`job ${job.name}: ${d.error}`);
    return JSON.parse(JSON.stringify(d.args.map((a) => (a === undefined ? null : a)))) as unknown[];
  }

  async enqueue<A extends unknown[]>(ctx: PageContext | null, job: Job<A>, args: Record<string, unknown> = {}, o: EnqueueOptions = {}): Promise<string | false> {
    const j = this.#jobs.get(job?.name);
    if (!j || j !== (job as unknown)) throw new Error(`jobs: ${job?.name ?? "that"} is not one of this queue's jobs`);
    const stored = this.#args(j, args);
    let actor: JobActor | null = null;
    if (o.as !== undefined) {
      if (o.as !== null && (typeof o.as.user !== "string" || o.as.user === "")) throw new TypeError("jobs: `as` needs a user id");
      actor = o.as === null ? null : { user: o.as.user, ...(o.as.tenant !== undefined ? { tenant: o.as.tenant } : {}) };
    } else if (ctx) {
      const s = await authState(ctx);
      if (s && !s.pending) actor = { user: s.user, ...(s.tenant !== undefined ? { tenant: s.tenant } : {}) };
    }
    if (o.key !== undefined && (typeof o.key !== "string" || o.key === "" || o.key.length > 256 || o.key.startsWith("cron:"))) {
      throw new TypeError("jobs: `key` is 1-256 characters, not starting cron:");
    }
    if (o.track !== undefined && typeof o.track !== "boolean") throw new TypeError("jobs: `track` is true or false");
    if (o.track && !this.#progress) throw new TypeError("jobs: `track` needs createJobs({ track: {} })");
    if (o.track && !actor) throw new TypeError("jobs: a tracked job needs the user who follows it (a signed-in ctx, or `as`)");
    const now = this.#now();
    const runAt = o.runAt ?? now + Math.max(0, o.delayMs ?? 0);
    if (!Number.isFinite(runAt)) throw new TypeError("jobs: bad runAt");
    const id = await this.#add(j, stored, actor, runAt, o.key ?? null, false);
    if (id && o.track && actor) {
      this.#progress!.as(TRACKER).create({ id, user: actor.user, name: j.name, status: "queued", progress: null, updated: now });
    }
    return id;
  }

  progress(actor: unknown, id: string): { name: string; status: string; progress: number | null } | null {
    if (!this.#progress || typeof id !== "string") return null;
    const r = this.#progress.as(actor as never).get(id);
    return r ? { name: r.name, status: r.status, progress: r.progress } : null;
  }

  names(): string[] {
    return [...this.#jobs.keys()];
  }

  schedules(): ScheduleInfo[] {
    return this.#schedules.map((s) => ({ name: s.name, cron: s.expression, job: s.job.name, next: s.next, as: s.as }));
  }

  runSchedule(name: string): Promise<string | false> {
    const s = this.#schedules.find((x) => x.name === name);
    if (!s) return Promise.reject(new Error(`jobs: no schedule called ${String(name).slice(0, 64)}`));
    const now = this.#now();
    return this.#add(s.job, s.args, s.as, now, `cron:${s.name}:now:${now}`, true);
  }

  #track(id: string, patch: Partial<Pick<JobProgressRow, "status" | "progress">>): void {
    if (!this.#progress) return;
    try {
      this.#progress.as(TRACKER).update((r) => r.id === id, { ...patch, updated: this.#now() });
    } catch (err) {
      this.#onError(err, null);
    }
  }

  async #add(j: Job<unknown[]>, args: unknown[], actor: JobActor | null, runAt: number, key: string | null, keepKey: boolean): Promise<string | false> {
    const now = this.#now();
    const id = randomId();
    const added = await this.#store.add({
      id, name: j.name, args, actor, status: "queued", attempts: 0, maxAttempts: j.options.attempts, runAt,
      created: now, updated: now, worker: null, leaseUntil: 0, error: null, key, keepKey, progress: null,
    });
    if (added) this.#wake();
    return added ? id : false;
  }

  get(id: string): Promise<JobRecord | null> {
    return Promise.resolve(this.#store.get(id)).then((r) => r ?? null);
  }
  list(f: JobFilter = {}): Promise<JobRecord[]> {
    return Promise.resolve(this.#store.list(f));
  }
  counts(): Promise<Record<JobStatus, number>> {
    return Promise.resolve(this.#store.counts());
  }
  async retry(id: string): Promise<boolean> {
    const ok = await this.#store.move(id, ["dead", "cancelled"], { status: "queued", runAt: this.#now(), attempts: 0 }, this.#now());
    if (ok) {
      this.#track(id, { status: "queued", progress: null });
      this.#wake();
    }
    return ok;
  }
  async cancel(id: string): Promise<boolean> {
    const ok = await this.#store.move(id, ["queued", "dead"], { status: "cancelled" }, this.#now());
    if (ok) this.#track(id, { status: "cancelled" });
    return ok;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#wake();
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await Promise.allSettled([...this.#running]);
  }

  #wake(): void {
    if (!this.#started) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.tick()
        .catch((err) => this.#onError(err, null))
        .finally(() => {
          if (this.#started && !this.#timer) {
            this.#timer = setTimeout(() => this.#wake(), this.#pollMs);
            (this.#timer as { unref?(): void }).unref?.();
          }
        });
    }, 0);
    (this.#timer as { unref?(): void }).unref?.();
  }

  async tick(): Promise<void> {
    const now = this.#now();
    for (const s of this.#schedules) {
      if (s.next > now) continue;
      let slot = s.next;
      for (let n = s.cron.next(slot); n <= now; n = s.cron.next(slot)) slot = n;
      s.next = s.cron.next(slot);
      await this.#add(s.job, s.args, s.as, slot, `cron:${s.name}:${slot}`, true);
    }
    if (now - this.#swept > 60_000) {
      this.#swept = now;
      await this.#store.sweep(now - this.#keepDone);
      if (this.#progress) {
        const before = now - this.#keepDone;
        this.#progress.as(TRACKER).delete((r) => r.status !== "queued" && r.status !== "running" && r.updated < before);
      }
    }
    const runs: Promise<void>[] = [];
    while (this.#running.size < this.#concurrency) {
      const rec = await this.#store.claim(this.#now(), this.#worker, this.#now() + this.#leaseMs);
      if (!rec) break;
      const p = this.#run(rec).finally(() => this.#running.delete(p));
      this.#running.add(p);
      runs.push(p);
    }
    await Promise.allSettled(runs);
  }

  async drain(max = 1000): Promise<void> {
    for (let i = 0; i < max; i++) {
      await this.tick();
      if (this.#running.size > 0) continue;
      const due = (await this.list({ status: "queued", limit: 1000 })).some((r) => r.runAt <= this.#now());
      if (!due) return;
    }
  }

  #backoff(job: Job<unknown[]>, attempt: number): number {
    if (job.options.backoff) {
      const ms = job.options.backoff(attempt);
      return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 7 * 24 * 3600_000) : 1000;
    }
    const base = Math.min(3600_000, 1000 * 2 ** Math.min(attempt - 1, 22));
    return Math.round(base * (0.8 + 0.4 * this.#random()));
  }

  async #run(rec: JobRecord): Promise<void> {
    const job = this.#jobs.get(rec.name);
    if (!job) {
      await this.#store.settle(rec.id, this.#worker, { status: "queued", runAt: this.#now() + this.#leaseMs }, this.#now());
      return;
    }
    let span: Span | null = null;
    try {
      span = this.#telemetry?.span?.(`job ${rec.name}`, {
        kind: "consumer",
        attributes: { "weft.job.name": rec.name, "weft.job.id": rec.id, "weft.job.attempt": rec.attempts },
        metric: { name: "weft.job.duration", attributes: { "weft.job.name": rec.name } },
      }) ?? null;
    } catch (err) {
      this.#onError(err, rec);
    }
    const outcome = { value: "done" as "done" | "retry" | "dead", error: undefined as unknown };
    try {
      await this.#attempt(rec, job, outcome);
    } finally {
      try {
        span?.end({
          ...(outcome.value !== "done" ? { error: outcome.error ?? new Error("failed") } : {}),
          attributes: { "weft.job.outcome": outcome.value },
        });
      } catch (err) {
        this.#onError(err, rec);
      }
    }
  }

  async #attempt(rec: JobRecord, job: Job<unknown[]>, outcome: { value: "done" | "retry" | "dead"; error: unknown }): Promise<void> {
    const fail = async (err: unknown, retry: boolean) => {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000) || "failed";
      const again = retry && rec.attempts < rec.maxAttempts;
      outcome.value = again ? "retry" : "dead";
      outcome.error = err;
      const held = await this.#store.settle(
        rec.id,
        this.#worker,
        again ? { status: "queued", runAt: this.#now() + this.#backoff(job, rec.attempts), error: message } : { status: "dead", error: message },
        this.#now(),
      );
      if (held) this.#track(rec.id, { status: PROGRESS_STATUS[again ? "queued" : "dead"] });
    };
    let actor: unknown = null;
    try {
      if (rec.actor) {
        actor = this.#user ? await this.#user(rec.actor.user, rec.actor.tenant) : { id: rec.actor.user };
        if (actor === null || actor === undefined) {
          await fail(new Error(`the user who queued it (${rec.actor.user}) no longer exists`), false);
          return;
        }
      }
    } catch (err) {
      this.#onError(err, rec);
      await fail(err, true);
      return;
    }
    const controller = new AbortController();
    let progress: number | null = null;
    let shown = -1;
    let shownAt = 0;
    this.#track(rec.id, { status: "running" });
    const renew = setInterval(() => {
      Promise.resolve(this.#store.extend(rec.id, this.#worker, this.#now() + this.#leaseMs, progress))
        .then((held) => {
          if (!held) controller.abort(new Error("lease lost"));
        })
        .catch((err) => this.#onError(err, rec));
    }, Math.max(1000, Math.floor(this.#leaseMs / 3)));
    (renew as { unref?(): void }).unref?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`timed out after ${job.options.timeoutMs} ms`);
        controller.abort(err);
        reject(err);
      }, job.options.timeoutMs);
      (timer as { unref?(): void }).unref?.();
    });
    const ctx: JobContext = {
      user: actor,
      job: { id: rec.id, name: rec.name, attempt: rec.attempts, maxAttempts: rec.maxAttempts },
      signal: controller.signal,
      progress: (f) => {
        if (typeof f !== "number" || !Number.isFinite(f)) return;
        progress = Math.min(1, Math.max(0, f));
        const t = this.#now();
        if (progress !== shown && (t - shownAt >= 500 || progress === 1)) {
          shown = progress;
          shownAt = t;
          this.#track(rec.id, { progress });
        }
      },
    };
    const args = job.params.map((p, i) => (rec.args[i] === null && p.optional ? undefined : rec.args[i]));
    try {
      await Promise.race([Promise.resolve().then(() => job.run(ctx, ...args)), timeout]);
      if (await this.#store.settle(rec.id, this.#worker, { status: "done", error: null }, this.#now())) {
        this.#track(rec.id, { status: "done", ...(progress !== null ? { progress: 1 } : {}) });
      }
    } catch (err) {
      this.#onError(err, rec);
      await fail(err, !(err instanceof JobError) || err.retry);
    } finally {
      clearInterval(renew);
      clearTimeout(timer);
    }
  }
}

export function createJobs(o: JobsOptions): Jobs {
  return new Jobs(o);
}
