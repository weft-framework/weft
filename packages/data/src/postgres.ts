import type { Broadcast } from "./bridge.ts";
import type { FilterNode } from "./filter.ts";
import type { AsyncDriver, Model, Scope } from "./model.ts";
import { policyToSql, type SqlValue } from "./policy.ts";
import type { DriverQuery } from "./query.ts";
import { isIdentifier, type FieldKind, type FieldSpec } from "./schema.ts";
import { quoteIdent, type MigrateOptions, type MigrationPlan } from "./sql.ts";
import { enlistAsync, inTransaction, type TxClient, type TxPool } from "./tx.ts";

export interface PgResult {
  rows: unknown[];
}

export interface PgClient extends TxClient {
  query(text: string, values?: unknown[]): Promise<PgResult>;
}

export interface PgPool extends TxPool {
  query(text: string, values?: unknown[]): Promise<PgResult>;
  connect(): Promise<PgClient>;
  listen?(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>;
}

const COLUMN_TYPE: Record<FieldKind, string> = {
  text: "text",
  real: "double precision",
  integer: "bigint",
  bool: "boolean",
  date: "timestamp with time zone",
  json: "jsonb",
};

const SEQ = "_weft_seq";
const HISTORY = "_weft_migrations";

export function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function encode(f: FieldSpec, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  switch (f.kind) {
    case "bool":
      return Boolean(v);
    case "date":
      return v instanceof Date ? v.toISOString() : String(v);
    case "json":
      return JSON.stringify(v);
    case "integer":
      return typeof v === "bigint" ? v.toString() : typeof v === "number" ? String(Math.trunc(v)) : String(BigInt(String(v)));
    case "real":
      return Number(v);
    default:
      return String(v);
  }
}

function decode(f: FieldSpec, v: unknown): unknown {
  if (v === null || v === undefined) return f.optional ? undefined : null;
  switch (f.kind) {
    case "bool":
      return v === true || v === "t" || v === "true" || v === 1;
    case "date":
      return v instanceof Date ? new Date(v.getTime()) : new Date(String(v));
    case "json":
      return typeof v === "string" ? JSON.parse(v) : v;
    case "integer":
      return typeof v === "bigint" ? v : BigInt(typeof v === "number" ? Math.trunc(v) : String(v));
    case "real":
      return Number(v);
    default:
      return v;
  }
}

function filterValue(f: FieldSpec, v: unknown): unknown {
  switch (f.kind) {
    case "text":
      return typeof v === "string" ? v : undefined;
    case "real":
      return typeof v === "number" && !Number.isNaN(v) ? v : undefined;
    case "integer":
      return typeof v === "bigint" ? v.toString() : undefined;
    case "bool":
      return typeof v === "boolean" ? v : undefined;
    case "date": {
      if (!(v instanceof Date)) return undefined;
      return Number.isNaN(v.getTime()) ? undefined : v.toISOString();
    }
    default:
      return undefined;
  }
}

interface FilterSql {
  sql: string;
  params: unknown[];
  exact: boolean;
}

const RANGE: Record<string, string> = { lt: "<", lte: "<=", gt: ">", gte: ">=" };

export class PgTable<T> implements AsyncDriver<T> {
  readonly async = true as const;
  private readonly pool: PgPool;
  private readonly model: Model<T>;
  private readonly table: string;
  private readonly fields: Map<string, FieldSpec>;
  private readonly cols: string;

  constructor(pool: PgPool, model: Model<T>) {
    this.pool = pool;
    this.model = model;
    this.table = quoteIdent(model.name);
    this.fields = new Map(model.fields.map((f) => [f.name, f]));
    this.cols = model.fields.map((f) => quoteIdent(f.name)).join(", ");
  }

  private async run(sql: string, params: unknown[]): Promise<unknown[]> {
    const text = numbered(sql);
    const tx = enlistAsync(this.pool);
    const res = tx ? await ((await tx) as PgClient).query(text, params) : await this.pool.query(text, params);
    return res.rows;
  }

  /** Policy operands: plain columns only (bool as 0/1 to match the policy's bindings). */
  private column = (path: string[]): string | null => {
    const f = this.fields.get(path[0]);
    if (!f || path.length !== 1 || !isIdentifier(path[0])) return null;
    const col = quoteIdent(f.name);
    switch (f.kind) {
      case "bool":
        return `(${col})::int`;
      case "text":
      case "real":
      case "integer":
        return col;
      default:
        return null;
    }
  };

  private row(raw: unknown): T {
    const r = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const f of this.model.fields) {
      const v = decode(f, r[f.name]);
      if (v !== undefined) out[f.name] = v;
    }
    return out as T;
  }

  private scoped(scopes: Scope[]): { where: string[]; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const s of scopes) {
      const sql = policyToSql(s.where, s.actor, this.column, "pg");
      if (sql) {
        where.push(`(${sql.sql})`);
        params.push(...sql.params.map((p: SqlValue) => (typeof p === "bigint" ? p.toString() : p)));
      }
    }
    return { where, params };
  }

  private filterAll(nodes: readonly FilterNode[]): FilterSql | null {
    const parts = nodes.map((n) => this.filterOne(n));
    const kept = parts.filter((p): p is FilterSql => p !== null);
    if (kept.length === 0) return null;
    return {
      sql: kept.map((p) => `(${p.sql})`).join(" AND "),
      params: kept.flatMap((p) => p.params),
      exact: kept.length === parts.length && kept.every((p) => p.exact),
    };
  }

  private filterOne(n: FilterNode): FilterSql | null {
    if ("or" in n) {
      const parts = n.or.map((all) => this.filterAll(all));
      if (parts.length === 0) return { sql: "FALSE", params: [], exact: true };
      if (parts.some((p) => p === null)) return null;
      const ps = parts as FilterSql[];
      return { sql: ps.map((p) => `(${p.sql})`).join(" OR "), params: ps.flatMap((p) => p.params), exact: ps.every((p) => p.exact) };
    }
    if ("not" in n) {
      const inner = this.filterAll(n.not);
      return inner && inner.exact ? { sql: `NOT (${inner.sql})`, params: inner.params, exact: true } : null;
    }
    const f = this.fields.get(n.field);
    if (!f || f.kind === "json") return null;
    const col = quoteIdent(f.name);
    const v = n.value;
    switch (n.op) {
      case "eq":
      case "ne": {
        if (v === null) return { sql: `${col} IS${n.op === "ne" ? " NOT" : ""} NULL`, params: [], exact: true };
        const p = filterValue(f, v);
        if (p === undefined) return null;
        return { sql: `${col} IS ${n.op === "ne" ? "" : "NOT "}DISTINCT FROM ?`, params: [p], exact: true };
      }
      case "in": {
        const list = v as unknown[];
        const values = list.filter((x) => x !== null);
        const params = values.map((x) => filterValue(f, x));
        if (params.some((p) => p === undefined)) return null;
        const alts: string[] = [];
        if (params.length) alts.push(`(${col} IS NOT NULL AND ${col} IN (${params.map(() => "?").join(", ")}))`);
        if (values.length < list.length) alts.push(`${col} IS NULL`);
        return { sql: alts.length ? alts.join(" OR ") : "FALSE", params, exact: true };
      }
      case "contains":
      case "startsWith": {
        if (f.kind !== "text") return null;
        return {
          sql: `${col} IS NOT NULL AND strpos(${col}, ?) ${n.op === "contains" ? "> 0" : "= 1"}`,
          params: [v as string],
          exact: true,
        };
      }
      default: {
        if (v === null) return { sql: "FALSE", params: [], exact: true };
        const p = filterValue(f, v);
        if (p === undefined) return null;
        const rhs = f.kind === "text" ? `? COLLATE "C"` : "?";
        return { sql: `${col} IS NOT NULL AND ${col} ${RANGE[n.op]} ${rhs}`, params: [p], exact: true };
      }
    }
  }

  private orderBy(order: DriverQuery["order"]): string {
    const parts = order
      .filter((o) => this.fields.get(o.field) && this.fields.get(o.field)!.kind !== "json")
      .map((o) => {
        const f = this.fields.get(o.field)!;
        const col = f.kind === "text" ? `${quoteIdent(f.name)} COLLATE "C"` : quoteIdent(f.name);
        return o.desc ? `${col} DESC NULLS LAST` : `${col} ASC NULLS FIRST`;
      });
    return [...parts, quoteIdent(SEQ)].join(", ");
  }

  async query(scopes: Scope[], q: DriverQuery): Promise<T[]> {
    const { where, params } = this.scoped(scopes);
    const filter = this.filterAll(q.where);
    if (filter) {
      where.push(`(${filter.sql})`);
      params.push(...filter.params);
    }
    let sql =
      `SELECT ${this.cols} FROM ${this.table}` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY ${this.orderBy(q.order)}`;
    if (q.limit !== undefined || q.offset > 0) {
      sql += " LIMIT ? OFFSET ?";
      params.push(q.limit ?? null, q.offset);
    }
    return (await this.run(sql, params)).map((r) => this.row(r));
  }

  async select(scopes: Scope[], key?: unknown): Promise<T[]> {
    const { where, params } = this.scoped(scopes);
    if (key !== undefined) {
      const k = this.fields.get(this.model.key)!;
      where.push(`${quoteIdent(k.name)} = ?`);
      params.push(encode(k, key));
    }
    const sql =
      `SELECT ${this.cols} FROM ${this.table}` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY ${quoteIdent(SEQ)}`;
    return (await this.run(sql, params)).map((r) => this.row(r));
  }

  async insert(row: T): Promise<void> {
    const r = row as Record<string, unknown>;
    const marks = this.model.fields.map(() => "?").join(", ");
    await this.run(
      `INSERT INTO ${this.table} (${this.cols}) VALUES (${marks})`,
      this.model.fields.map((f) => encode(f, r[f.name])),
    );
  }

  async update(key: unknown, row: T): Promise<void> {
    const r = row as Record<string, unknown>;
    const k = this.fields.get(this.model.key)!;
    const rest = this.model.fields.filter((f) => f.name !== k.name);
    if (rest.length === 0) return;
    const set = rest.map((f) => `${quoteIdent(f.name)} = ?`).join(", ");
    await this.run(`UPDATE ${this.table} SET ${set} WHERE ${quoteIdent(k.name)} = ?`, [
      ...rest.map((f) => encode(f, r[f.name])),
      encode(k, key),
    ]);
  }

  async delete(key: unknown): Promise<void> {
    const k = this.fields.get(this.model.key)!;
    await this.run(`DELETE FROM ${this.table} WHERE ${quoteIdent(k.name)} = ?`, [encode(k, key)]);
  }
}

interface PgColumn {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

type Queryable = Pick<PgClient, "query">;

function columnDef(f: FieldSpec, isKey: boolean): string {
  let def = `${quoteIdent(f.name)} ${COLUMN_TYPE[f.kind]}`;
  if (isKey) def += " PRIMARY KEY";
  if (isKey || !f.nullable) def += " NOT NULL";
  return def;
}

function indexesFor(m: Model<unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of m.fields) {
    if (f.name === m.key) continue;
    if (!f.unique && !f.index && f.ref === undefined) continue;
    const name = `${m.name}_${f.name}_${f.unique ? "key" : "idx"}`;
    out.set(name, `CREATE ${f.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(name)} ON ${quoteIdent(m.name)} (${quoteIdent(f.name)})`);
  }
  return out;
}

export async function planPgMigrations(db: Queryable, models: Model<unknown>[], opts: MigrateOptions = {}): Promise<MigrationPlan> {
  const plan: MigrationPlan = { steps: [], warnings: [], rebuilt: [] };
  const keys = new Map(models.map((m) => [m.name, m.key]));
  const constraints = new Set(
    ((await db.query(`SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = current_schema()`)).rows as { conname: string }[]).map(
      (r) => r.conname,
    ),
  );
  const later: { model: string; sql: string }[] = [];
  for (const m of models) {
    const table = quoteIdent(m.name);
    const step = (sql: string) => plan.steps.push({ model: m.name, sql });
    const existing = (
      await db.query(
        numbered(
          `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position`,
        ),
        [m.name],
      )
    ).rows as PgColumn[];
    const haveIndexes = new Set(
      ((await db.query(numbered(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ?`), [m.name])).rows as { indexname: string }[]).map(
        (r) => r.indexname,
      ),
    );
    const fk = (f: FieldSpec) => {
      if (f.ref === undefined) return;
      const target = keys.get(f.ref);
      if (target === undefined) {
        plan.warnings.push(`${m.name}.${f.name}: @ref(${f.ref}) names a model not in this database`);
        return;
      }
      const name = `${m.name}_${f.name}_fkey`;
      if (constraints.has(name)) return;
      later.push({
        model: m.name,
        sql: `ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(name)} FOREIGN KEY (${quoteIdent(f.name)}) REFERENCES ${quoteIdent(f.ref)} (${quoteIdent(target)})`,
      });
    };
    if (existing.length === 0) {
      const cols = [`${quoteIdent(SEQ)} bigserial`, ...m.fields.map((f) => columnDef(f, f.name === m.key))];
      step(`CREATE TABLE ${table} (${cols.join(", ")})`);
      for (const sql of indexesFor(m).values()) step(sql);
      for (const f of m.fields) fk(f);
      continue;
    }
    const have = new Map(existing.map((c) => [c.column_name, c]));
    const used = new Set<string>([SEQ]);
    if (!have.has(SEQ)) step(`ALTER TABLE ${table} ADD COLUMN ${quoteIdent(SEQ)} bigserial`);
    const dropped = new Set<string>();
    for (const f of m.fields) {
      const isKey = f.name === m.key;
      let col = have.get(f.name);
      if (f.renamed !== undefined && have.has(f.renamed)) {
        if (col) {
          plan.warnings.push(`${m.name}.${f.name}: both \`${f.name}\` and \`${f.renamed}\` exist; @renamed(${f.renamed}) ignored`);
        } else {
          col = have.get(f.renamed);
          step(`ALTER TABLE ${table} RENAME COLUMN ${quoteIdent(f.renamed)} TO ${quoteIdent(f.name)}`);
          for (const suffix of ["key", "idx"]) {
            const old = `${m.name}_${f.renamed}_${suffix}`;
            if (haveIndexes.has(old)) {
              step(`DROP INDEX ${quoteIdent(old)}`);
              dropped.add(old);
            }
          }
        }
      }
      if (!col) {
        if (isKey) {
          plan.warnings.push(`${m.name}: key column \`${f.name}\` is missing; recreate the table`);
          continue;
        }
        step(`ALTER TABLE ${table} ADD COLUMN ${columnDef({ ...f, nullable: true }, false)}`);
        if (!f.nullable) plan.warnings.push(`${m.name}.${f.name}: added as nullable; existing rows have no value`);
        fk(f);
        continue;
      }
      used.add(col.column_name);
      const name = quoteIdent(f.name);
      if (col.data_type !== COLUMN_TYPE[f.kind]) {
        if (opts.destructive && !isKey) {
          step(`ALTER TABLE ${table} ALTER COLUMN ${name} TYPE ${COLUMN_TYPE[f.kind]} USING ${name}::${COLUMN_TYPE[f.kind]}`);
          plan.rebuilt.push(`${m.name}.${f.name}`);
        } else {
          plan.warnings.push(
            `${m.name}.${f.name}: column is ${col.data_type}, model needs ${COLUMN_TYPE[f.kind]}` +
              (isKey ? "" : " (`weft migrate --allow-destructive` converts it)"),
          );
        }
      }
      const notNull = col.is_nullable === "NO";
      if (!isKey && notNull && f.nullable) {
        step(`ALTER TABLE ${table} ALTER COLUMN ${name} DROP NOT NULL`);
      } else if (!isKey && !notNull && !f.nullable) {
        const nulls = (await db.query(`SELECT 1 FROM ${table} WHERE ${quoteIdent(col.column_name)} IS NULL LIMIT 1`)).rows.length > 0;
        if (nulls) plan.warnings.push(`${m.name}.${f.name}: has NULLs, so it stays nullable`);
        else step(`ALTER TABLE ${table} ALTER COLUMN ${name} SET NOT NULL`);
      }
      fk(f);
    }
    for (const c of existing) {
      if (used.has(c.column_name)) continue;
      if (opts.destructive) {
        step(`ALTER TABLE ${table} DROP COLUMN ${quoteIdent(c.column_name)}`);
      } else {
        plan.warnings.push(
          `${m.name}.${c.column_name}: column is no longer declared; left in place (\`weft migrate --allow-destructive\` drops it)`,
        );
      }
    }
    for (const [name, sql] of indexesFor(m)) {
      if (!haveIndexes.has(name) || dropped.has(name)) step(sql);
    }
  }
  plan.steps.push(...later);
  return plan;
}

export async function migratePg(pool: PgPool, models: Model<unknown>[], opts: MigrateOptions = {}): Promise<MigrationPlan> {
  if (inTransaction()) throw new Error("migratePg: not inside a transaction (it runs its own)");
  const client = await pool.connect();
  let failed: unknown;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('weft_migrations'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${HISTORY} (id bigserial PRIMARY KEY, model text NOT NULL, sql text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const plan = await planPgMigrations(client, models, opts);
    for (const step of plan.steps) {
      await client.query(step.sql);
      await client.query(numbered(`INSERT INTO ${HISTORY} (model, sql) VALUES (?, ?)`), [step.model, step.sql]);
    }
    await client.query("COMMIT");
    return plan;
  } catch (err) {
    failed = err;
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release(failed);
  }
}

export interface UsePostgresOptions extends MigrateOptions {
  migrate?: boolean;
  onWarning?(message: string): void;
}

export async function usePostgres(pool: PgPool, models: Model<never>[], opts: UsePostgresOptions = {}): Promise<MigrationPlan> {
  const list = models as unknown as Model<unknown>[];
  let plan: MigrationPlan;
  if (opts.migrate === false) {
    const client = await pool.connect();
    try {
      plan = await planPgMigrations(client, list, opts);
    } finally {
      client.release();
    }
  } else {
    plan = await migratePg(pool, list, opts);
  }
  for (const w of plan.warnings) (opts.onWarning ?? ((m: string) => console.warn(`[weft/data] ${m}`)))(w);
  for (const m of list) m.use(new PgTable(pool, m));
  const { replicate } = await import("./replica.ts");
  for (const m of list) if (m.config.replica) await replicate(m);
  return plan;
}

export function isPostgresUrl(database: string): boolean {
  return /^postgres(ql)?:\/\//i.test(database) || database.startsWith("pglite:");
}

export type ClosablePgPool = PgPool & { end(): Promise<void> };

async function optional(name: string, why: string): Promise<Record<string, unknown>> {
  try {
    return (await import(name)) as Record<string, unknown>;
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(`${why} needs the \`${name}\` package: npm i ${name}`);
    }
    throw err;
  }
}

interface SharedPool {
  pool: Promise<ClosablePgPool>;
  refs: number;
}

const SHARED = Symbol.for("weft.data.postgres.shared");

function sharedPools(): Map<string, SharedPool> {
  const slot = globalThis as { [SHARED]?: Map<string, SharedPool> };
  return (slot[SHARED] ??= new Map());
}

function isMemory(database: string): boolean {
  return database === "pglite:" || database === "pglite:memory";
}

export async function openPostgres(database: string): Promise<ClosablePgPool> {
  if (isMemory(database)) return openPool(database);
  const pools = sharedPools();
  let shared = pools.get(database);
  if (!shared) {
    const opening = openPool(database);
    shared = { pool: opening, refs: 0 };
    pools.set(database, shared);
    opening.catch(() => pools.delete(database));
  }
  const entry = shared;
  entry.refs++;
  let pool: ClosablePgPool;
  try {
    pool = await entry.pool;
  } catch (err) {
    entry.refs--;
    throw err;
  }
  let released = false;
  return new Proxy(pool, {
    get(target, key, receiver) {
      if (key === "end") {
        return async () => {
          if (released) return;
          released = true;
          entry.refs--;
          if (entry.refs === 0 && pools.get(database) === entry) {
            pools.delete(database);
            await target.end();
          }
        };
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function openPool(database: string): Promise<ClosablePgPool> {
  if (database.startsWith("pglite:")) {
    const dir = database.slice("pglite:".length);
    const mod = await optional("@electric-sql/pglite", "a pglite: database");
    const PGlite = mod.PGlite as new (dataDir?: string) => PgliteLike & { close(): Promise<void> };
    const db = new PGlite(dir === "" || dir === "memory" ? undefined : dir);
    return Object.assign(pgliteAsPool(db), { end: () => db.close() });
  }
  const mod = await optional("pg", "a postgres:// database");
  const pg = (mod.default ?? mod) as { Pool: new (o: { connectionString: string }) => ClosablePgPool };
  return new pg.Pool({ connectionString: database });
}

export interface PgliteLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  listen?(channel: string, cb: (payload: string) => void): Promise<() => Promise<void>>;
}

const MAX_PAYLOAD = 7500;

export interface PgBroadcastOptions {
  /** Channel name (default `weft_changes`). */
  channel?: string;
  retryMs?: { min: number; max: number };
  onError?(err: unknown): void;
}

export interface PgBroadcast extends Broadcast {
  onGap(fn: () => void): () => void;
  ready(): Promise<void>;
  close(): Promise<void>;
}

type NotifyClient = PgClient & {
  on?(event: "notification", fn: (msg: { channel: string; payload?: string }) => void): void;
  on?(event: "error" | "end", fn: (err?: unknown) => void): void;
};

function shrink(message: string): string {
  if (Buffer.byteLength(message) <= MAX_PAYLOAD) return message;
  const msg = JSON.parse(message) as { change: { model: string; op: string; key?: unknown } };
  const c = msg.change;
  const key = typeof c.key === "string" || typeof c.key === "number" ? c.key : undefined;
  msg.change = { model: c.model, op: c.op, ...(key !== undefined && String(key).length < 512 ? { key } : {}), redacted: true } as never;
  return JSON.stringify(msg);
}

export function pgBroadcast(pool: PgPool, opts: PgBroadcastOptions = {}): PgBroadcast {
  const channel = opts.channel ?? "weft_changes";
  if (!isIdentifier(channel)) throw new Error(`pgBroadcast: channel must be an identifier, got ${JSON.stringify(channel)}`);
  const report = opts.onError ?? ((err: unknown) => console.error("[weft/data] pgBroadcast:", err));
  const retry = opts.retryMs ?? { min: 250, max: 10_000 };
  const listeners = new Set<(m: string) => void>();
  const gaps = new Set<() => void>();
  let closed = false;
  let stop: (() => Promise<void>) | null = null;
  let delay = retry.min;
  let first = true;
  let readyResolve!: () => void;
  const ready = new Promise<void>((r) => (readyResolve = r));
  const deliver = (payload: string) => {
    for (const l of [...listeners]) l(payload);
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    try {
      if (pool.listen) {
        stop = await pool.listen(channel, deliver);
      } else {
        const client = (await pool.connect()) as NotifyClient;
        if (typeof client.on !== "function") {
          client.release();
          throw new Error("pgBroadcast: the pool's clients cannot receive notifications (use pg.Pool)");
        }
        let lost = false;
        const drop = (err?: unknown) => {
          if (lost) return;
          lost = true;
          stop = null;
          client.release(err ?? new Error("connection ended"));
          if (!closed) {
            if (err) report(err);
            setTimeout(() => void connect(), delay);
            delay = Math.min(delay * 2, retry.max);
          }
        };
        client.on("notification", (msg) => {
          if (msg.channel === channel && typeof msg.payload === "string") deliver(msg.payload);
        });
        client.on("error", drop);
        client.on("end", () => drop());
        await client.query(`LISTEN ${quoteIdent(channel)}`);
        stop = async () => {
          lost = true;
          await client.query(`UNLISTEN ${quoteIdent(channel)}`).catch(() => undefined);
          client.release();
        };
      }
      delay = retry.min;
      if (!first) for (const g of [...gaps]) g();
      first = false;
      readyResolve();
    } catch (err) {
      report(err);
      if (!closed) {
        setTimeout(() => void connect(), delay);
        delay = Math.min(delay * 2, retry.max);
      }
    }
  };
  void connect();

  return {
    publish(message: string) {
      return pool.query("SELECT pg_notify($1, $2)", [channel, shrink(message)]);
    },
    subscribe(on) {
      listeners.add(on);
      return () => listeners.delete(on);
    },
    onGap(fn) {
      gaps.add(fn);
      return () => gaps.delete(fn);
    },
    ready: () => ready,
    async close() {
      closed = true;
      const s = stop;
      stop = null;
      if (s) await s();
    },
  };
}

export function pgliteAsPool(db: PgliteLike): PgPool {
  let queue: Promise<unknown> = Promise.resolve();
  let held = false;
  const direct = (text: string, values?: unknown[]) => db.query(text, values as unknown[]);
  const pool: PgPool = {
    query: async (text, values) => {
      if (!held) return direct(text, values);
      const wait = queue;
      await wait;
      return direct(text, values);
    },
    connect: async () => {
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      const prev = queue;
      queue = prev.then(() => mine);
      await prev;
      held = true;
      return {
        query: direct,
        release: () => {
          held = false;
          release();
        },
      };
    },
  };
  if (db.listen) {
    const listen = db.listen.bind(db);
    pool.listen = (channel, onMessage) => listen(channel, onMessage);
  }
  return pool;
}

export { PgAuditLog, type PgAuditLogOptions } from "./pg-audit.ts";
export { applyPgPolicies, pgPolicies, policyToRls, withActor, type PgPoliciesOptions, type PgPoliciesResult, type WithActorOptions } from "./pg-rls.ts";
