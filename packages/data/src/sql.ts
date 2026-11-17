import type { FilterNode } from "./filter.ts";
import type { Driver, Model, Scope } from "./model.ts";
import { policyToSql, type SqlValue } from "./policy.ts";
import type { DriverQuery } from "./query.ts";
import { enlist, inTransaction } from "./tx.ts";
import { isIdentifier, type FieldKind, type FieldSpec } from "./schema.ts";

export interface SqlStatement {
  all(...params: SqlValue[]): unknown[];
  run(...params: SqlValue[]): unknown;
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}

export function quoteIdent(name: string): string {
  if (!isIdentifier(name)) {
    throw new Error(`not a valid SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

const COLUMN_TYPE: Record<FieldKind, string> = {
  text: "TEXT",
  real: "REAL",
  integer: "INTEGER",
  bool: "INTEGER",
  date: "TEXT",
  json: "TEXT",
};

function encode(f: FieldSpec, v: unknown): SqlValue {
  if (v === undefined || v === null) {
    return null;
  }
  switch (f.kind) {
    case "bool":
      return v ? 1 : 0;
    case "date":
      return v instanceof Date ? v.toISOString() : String(v);
    case "json":
      return JSON.stringify(v);
    case "integer":
      return typeof v === "bigint" || typeof v === "number" ? v : BigInt(String(v));
    case "real":
      return Number(v);
    default:
      return String(v);
  }
}

function decode(f: FieldSpec, v: unknown): unknown {
  if (v === null || v === undefined) {
    return f.optional ? undefined : null;
  }
  switch (f.kind) {
    case "bool":
      return v === 1 || v === 1n;
    case "date":
      return new Date(String(v));
    case "json":
      return JSON.parse(String(v));
    case "integer":
      return typeof v === "bigint" ? v : typeof v === "number" && Number.isInteger(v) ? BigInt(v) : BigInt(String(v));
    default:
      return v;
  }
}

function filterValue(f: FieldSpec, v: unknown): SqlValue | undefined {
  switch (f.kind) {
    case "text":
      return typeof v === "string" ? v : undefined;
    case "real":
      return typeof v === "number" && !Number.isNaN(v) ? v : undefined;
    case "integer":
      return typeof v === "bigint" ? v : undefined;
    case "bool":
      return typeof v === "boolean" ? (v ? 1 : 0) : undefined;
    case "date": {
      if (!(v instanceof Date)) return undefined;
      const y = v.getUTCFullYear();
      return Number.isNaN(v.getTime()) || y < 0 || y > 9999 ? undefined : v.toISOString();
    }
    default:
      return undefined;
  }
}

interface FilterSql {
  sql: string;
  params: SqlValue[];
  exact: boolean;
}

const RANGE: Record<string, string> = { lt: "<", lte: "<=", gt: ">", gte: ">=" };

export class SqlTable<T> implements Driver<T> {
  private readonly db: SqlDatabase;
  private readonly model: Model<T>;
  private readonly table: string;
  private readonly fields: Map<string, FieldSpec>;
  private readonly cols: string;
  private readonly stmts = new Map<string, SqlStatement>();

  constructor(db: SqlDatabase, model: Model<T>) {
    this.db = db;
    this.model = model;
    this.table = quoteIdent(model.name);
    this.fields = new Map(model.fields.map((f) => [f.name, f]));
    this.cols = model.fields.map((f) => quoteIdent(f.name)).join(", ");
  }

  private stmt(sql: string): SqlStatement {
    enlist(this.db);
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private column = (path: string[]): string | null => {
    const f = this.fields.get(path[0]);
    if (!f || !path.every(isIdentifier)) {
      return null;
    }
    const col = quoteIdent(f.name);
    if (f.kind === "json") {
      const sub = path.slice(1).map((p) => `."${p}"`).join("");
      return `json_extract(${col}, '$${sub}')`;
    }
    return path.length === 1 && f.kind !== "date" ? col : null;
  };

  private row(raw: unknown): T {
    const r = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const f of this.model.fields) {
      const v = decode(f, r[f.name]);
      if (v !== undefined) {
        out[f.name] = v;
      }
    }
    return out as T;
  }

  private scoped(scopes: Scope[]): { where: string[]; params: SqlValue[] } {
    const where: string[] = [];
    const params: SqlValue[] = [];
    for (const s of scopes) {
      const sql = policyToSql(s.where, s.actor, this.column);
      if (sql) {
        where.push(`(${sql.sql})`);
        params.push(...sql.params);
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
      if (parts.length === 0) return { sql: "0", params: [], exact: true };
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
        const not = n.op === "ne" ? " NOT" : "";
        if (v === null) return { sql: `${col} IS${not} NULL`, params: [], exact: true };
        const p = filterValue(f, v);
        return p === undefined ? null : { sql: `${col} IS${not} ?`, params: [p], exact: true };
      }
      case "in": {
        const list = v as unknown[];
        const values = list.filter((x) => x !== null);
        const params = values.map((x) => filterValue(f, x));
        if (params.some((p) => p === undefined)) return null;
        const alts: string[] = [];
        if (params.length) alts.push(`(${col} IS NOT NULL AND ${col} IN (${params.map(() => "?").join(", ")}))`);
        if (values.length < list.length) alts.push(`${col} IS NULL`);
        return { sql: alts.length ? alts.join(" OR ") : "0", params: params as SqlValue[], exact: true };
      }
      case "contains":
      case "startsWith": {
        if (f.kind !== "text") return null;
        return {
          sql: `${col} IS NOT NULL AND instr(${col}, ?) ${n.op === "contains" ? "> 0" : "= 1"}`,
          params: [v as string],
          exact: true,
        };
      }
      default: {
        if (v === null) return { sql: "0", params: [], exact: true };
        const p = filterValue(f, v);
        return p === undefined ? null : { sql: `${col} IS NOT NULL AND ${col} ${RANGE[n.op]} ?`, params: [p], exact: true };
      }
    }
  }

  query(scopes: Scope[], q: DriverQuery): T[] {
    const { where, params } = this.scoped(scopes);
    const filter = this.filterAll(q.where);
    if (filter) {
      where.push(`(${filter.sql})`);
      params.push(...filter.params);
    }
    const order = q.order
      .filter((o) => this.fields.get(o.field) && this.fields.get(o.field)!.kind !== "json")
      .map((o) => `${quoteIdent(o.field)} ${o.desc ? "DESC" : "ASC"}`);
    let sql =
      `SELECT ${this.cols} FROM ${this.table}` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY ${[...order, "rowid"].join(", ")}`;
    if (q.limit !== undefined || q.offset > 0) {
      sql += " LIMIT ? OFFSET ?";
      params.push(q.limit ?? -1, q.offset);
    }
    return this.stmt(sql).all(...params).map((r) => this.row(r));
  }

  select(scopes: Scope[], key?: unknown): T[] {
    const { where, params } = this.scoped(scopes);
    if (key !== undefined) {
      const k = this.fields.get(this.model.key)!;
      where.push(`${quoteIdent(k.name)} = ?`);
      params.push(encode(k, key));
    }
    const sql =
      `SELECT ${this.cols} FROM ${this.table}` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY rowid`;
    return this.stmt(sql).all(...params).map((r) => this.row(r));
  }

  insert(row: T): void {
    const r = row as Record<string, unknown>;
    const marks = this.model.fields.map(() => "?").join(", ");
    this.stmt(`INSERT INTO ${this.table} (${this.cols}) VALUES (${marks})`).run(
      ...this.model.fields.map((f) => encode(f, r[f.name])),
    );
  }

  update(key: unknown, row: T): void {
    const r = row as Record<string, unknown>;
    const k = this.fields.get(this.model.key)!;
    const rest = this.model.fields.filter((f) => f.name !== k.name);
    if (rest.length === 0) {
      return;
    }
    const set = rest.map((f) => `${quoteIdent(f.name)} = ?`).join(", ");
    this.stmt(`UPDATE ${this.table} SET ${set} WHERE ${quoteIdent(k.name)} = ?`).run(
      ...rest.map((f) => encode(f, r[f.name])),
      encode(k, key),
    );
  }

  delete(key: unknown): void {
    const k = this.fields.get(this.model.key)!;
    this.stmt(`DELETE FROM ${this.table} WHERE ${quoteIdent(k.name)} = ?`).run(encode(k, key));
  }
}

export interface MigrationPlan {
  steps: { model: string; sql: string }[];
  warnings: string[];
  rebuilt: string[];
}

const HISTORY = "_weft_migrations";

function columnDef(f: FieldSpec, isKey: boolean, refKey?: string): string {
  const name = quoteIdent(f.name);
  let def = `${name} ${COLUMN_TYPE[f.kind]}`;
  if (isKey) {
    def += " PRIMARY KEY";
  }
  if (isKey || !f.nullable) {
    def += " NOT NULL";
  }
  if (f.kind === "bool") {
    def += ` CHECK (${name} IN (0, 1))`;
  } else if (f.kind === "json") {
    def += ` CHECK (json_valid(${name}))`;
  }
  if (f.ref !== undefined && refKey !== undefined) {
    def += ` REFERENCES ${quoteIdent(f.ref)}(${quoteIdent(refKey)})`;
  }
  return def;
}

function indexesFor(m: Model<unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of m.fields) {
    if (f.name === m.key) continue;
    const unique = f.unique;
    if (!unique && !f.index && f.ref === undefined) continue;
    const name = `${m.name}_${f.name}_${unique ? "key" : "idx"}`;
    out.set(
      name,
      `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(name)} ON ${quoteIdent(m.name)} (${quoteIdent(f.name)})`,
    );
  }
  return out;
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number | bigint;
}

export interface MigrateOptions {
  destructive?: boolean;
}

export function planMigrations(db: SqlDatabase, models: Model<unknown>[], opts: MigrateOptions = {}): MigrationPlan {
  const plan: MigrationPlan = { steps: [], warnings: [], rebuilt: [] };
  const keys = new Map(models.map((m) => [m.name, m.key]));
  const refKey = (m: Model<unknown>, f: FieldSpec): string | undefined => {
    if (f.ref === undefined) return undefined;
    const k = keys.get(f.ref);
    if (k === undefined) {
      plan.warnings.push(`${m.name}.${f.name}: @ref(${f.ref}) names a model not in this database`);
    }
    return k;
  };
  for (const m of models) {
    const table = quoteIdent(m.name);
    const step = (sql: string) => plan.steps.push({ model: m.name, sql });
    const existing = db.prepare(`SELECT name, type, "notnull" FROM pragma_table_info(?)`).all(m.name) as ColumnInfo[];
    const haveIndexes = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`).all(m.name) as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    if (existing.length === 0) {
      const cols = m.fields.map((f) => columnDef(f, f.name === m.key, refKey(m, f))).join(", ");
      step(`CREATE TABLE ${table} (${cols}) STRICT`);
      for (const sql of indexesFor(m).values()) step(sql);
      continue;
    }
    const have = new Map(existing.map((c) => [c.name, c]));
    const used = new Set<string>();
    const hasNulls = (col: string) =>
      (db.prepare(`SELECT 1 FROM ${table} WHERE ${quoteIdent(col)} IS NULL LIMIT 1`).all() as unknown[]).length > 0;
    let rebuild = false;
    const renames: [string, string][] = [];
    const added: FieldSpec[] = [];
    const target: { def: string; name: string; from: string | null }[] = [];
    for (const f of m.fields) {
      const isKey = f.name === m.key;
      let col = have.get(f.name);
      if (f.renamed !== undefined && have.has(f.renamed)) {
        if (col) {
          plan.warnings.push(`${m.name}.${f.name}: both \`${f.name}\` and \`${f.renamed}\` exist; @renamed(${f.renamed}) ignored`);
        } else {
          col = have.get(f.renamed);
          renames.push([f.renamed, f.name]);
        }
      }
      if (!col) {
        if (isKey) {
          plan.warnings.push(`${m.name}: key column \`${f.name}\` is missing; recreate the table`);
          continue;
        }
        added.push(f);
        target.push({ def: columnDef({ ...f, nullable: true }, false, refKey(m, f)), name: f.name, from: null });
        if (!f.nullable) {
          plan.warnings.push(`${m.name}.${f.name}: added as nullable; existing rows have no value`);
        }
        continue;
      }
      used.add(col.name);
      let from = quoteIdent(col.name);
      if (col.type.toUpperCase() !== COLUMN_TYPE[f.kind]) {
        if (opts.destructive && !isKey) {
          rebuild = true;
          from = `CAST(${from} AS ${COLUMN_TYPE[f.kind]})`;
        } else {
          plan.warnings.push(
            `${m.name}.${f.name}: column is ${col.type}, model needs ${COLUMN_TYPE[f.kind]}` +
              (isKey ? "" : " (`weft migrate --allow-destructive` converts it)"),
          );
        }
      }
      const notNull = Number(col.notnull) === 1;
      let nullable = f.nullable;
      if (!isKey && notNull && f.nullable) {
        rebuild = true;
      } else if (!isKey && !notNull && !f.nullable) {
        if (hasNulls(col.name)) {
          nullable = true;
          plan.warnings.push(`${m.name}.${f.name}: has NULLs, so it stays nullable`);
        } else {
          rebuild = true;
        }
      }
      target.push({ def: columnDef({ ...f, nullable }, isKey, refKey(m, f)), name: f.name, from });
    }
    const undeclared = existing.filter((c) => !used.has(c.name));
    for (const c of undeclared) {
      if (opts.destructive) {
        rebuild = true;
      } else {
        plan.warnings.push(
          `${m.name}.${c.name}: column is no longer declared; left in place (\`weft migrate --allow-destructive\` drops it)`,
        );
      }
    }
    if (!rebuild) {
      const dropped = new Set<string>();
      for (const [from, to] of renames) {
        step(`ALTER TABLE ${table} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(to)}`);
        for (const suffix of ["key", "idx"]) {
          const old = `${m.name}_${from}_${suffix}`;
          if (haveIndexes.has(old)) {
            step(`DROP INDEX ${quoteIdent(old)}`);
            dropped.add(old);
          }
        }
      }
      for (const f of added) {
        step(`ALTER TABLE ${table} ADD COLUMN ${columnDef({ ...f, nullable: true }, false, refKey(m, f))}`);
      }
      for (const [name, sql] of indexesFor(m)) {
        if (!haveIndexes.has(name) || dropped.has(name)) step(sql);
      }
      continue;
    }
    const kept = opts.destructive ? [] : undeclared;
    const tmp = quoteIdent(`_weft_rebuild_${m.name}`);
    const defs = [
      ...target.map((t) => t.def),
      ...kept.map((c) => `${quoteIdent(c.name)} ${c.type}${Number(c.notnull) === 1 ? " NOT NULL" : ""}`),
    ];
    const copied = [
      ...target.filter((t) => t.from !== null).map((t) => [quoteIdent(t.name), t.from!] as const),
      ...kept.map((c) => [quoteIdent(c.name), quoteIdent(c.name)] as const),
    ];
    step(`CREATE TABLE ${tmp} (${defs.join(", ")}) STRICT`);
    step(
      `INSERT INTO ${tmp} (${copied.map((c) => c[0]).join(", ")}) ` +
        `SELECT ${copied.map((c) => c[1]).join(", ")} FROM ${table} ORDER BY rowid`,
    );
    step(`DROP TABLE ${table}`);
    step(`ALTER TABLE ${tmp} RENAME TO ${table}`);
    for (const sql of indexesFor(m).values()) step(sql);
    plan.rebuilt.push(m.name);
  }
  return plan;
}

export function migrate(db: SqlDatabase, models: Model<unknown>[], opts: MigrateOptions = {}): MigrationPlan {
  if (inTransaction()) {
    throw new Error("migrate: not inside a transaction (it runs its own)");
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${HISTORY} (` +
      `id INTEGER PRIMARY KEY, model TEXT NOT NULL, sql TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT`,
  );
  const plan = planMigrations(db, models, opts);
  if (plan.steps.length === 0) {
    return plan;
  }
  const fkWasOn = plan.rebuilt.length > 0 && Number((db.prepare("PRAGMA foreign_keys").all()[0] as { foreign_keys: number }).foreign_keys) === 1;
  if (fkWasOn) db.exec("PRAGMA foreign_keys = OFF");
  const record = db.prepare(`INSERT INTO ${HISTORY} (model, sql, applied_at) VALUES (?, ?, ?)`);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const step of plan.steps) {
        db.exec(step.sql);
        record.run(step.model, step.sql, new Date().toISOString());
      }
      if (plan.rebuilt.length > 0) {
        const bad = db.prepare("PRAGMA foreign_key_check").all() as { table: string; parent: string }[];
        if (bad.length > 0) {
          throw new Error(`migrate: ${bad.length} row(s) would break foreign keys (first: ${bad[0].table} -> ${bad[0].parent})`);
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
  }
  return plan;
}

export interface UseDatabaseOptions {
  migrate?: boolean;
  destructive?: boolean;
  onWarning?(message: string): void;
}

export function useDatabase(db: SqlDatabase, models: Model<never>[], opts: UseDatabaseOptions = {}): MigrationPlan {
  const list = models as unknown as Model<unknown>[];
  db.exec("PRAGMA foreign_keys = ON");
  const plan = opts.migrate === false ? planMigrations(db, list, opts) : migrate(db, list, opts);
  for (const w of plan.warnings) {
    (opts.onWarning ?? ((m: string) => console.warn(`[weft/data] ${m}`)))(w);
  }
  for (const m of list) {
    m.use(new SqlTable(db, m));
  }
  return plan;
}
