import type { Model } from "./model.ts";
import type { Operand, PolicyExpr } from "./policy.ts";
import { isIdentifier } from "./schema.ts";
import { quoteIdent } from "./sql.ts";
import { asyncTransaction, enlistAsync, type TxPool } from "./tx.ts";

export interface PgPoliciesOptions {
  role?: string;
  createRole?: boolean;
}

export interface PgPoliciesResult {
  /** Statements to run in order (idempotent: policies are dropped and recreated). */
  sql: string[];
  /** Models left without RLS, and why (no `readWhere`, or nothing translatable). */
  skipped: { model: string; reason: string }[];
}

const ACTOR = "nullif(current_setting('weft.actor', true), '')::jsonb";
const GRANTS = "coalesce(nullif(current_setting('weft.grants', true), '')::jsonb, '{}'::jsonb)";

function jsonLiteral(v: unknown): string {
  return `'${JSON.stringify(v ?? null).replace(/'/g, "''")}'::jsonb`;
}

function pathLiteral(path: string[]): string {
  const inner = path.map((p) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",");
  return `'{${inner.replace(/'/g, "''")}}'`;
}

type Side = { sql: string } | { constant: unknown };

export function policyToRls(expr: PolicyExpr, columns: ReadonlySet<string>): string | null {
  const out = go(expr);
  return out && out.sql;

  function go(e: PolicyExpr): { sql: string; exact: boolean } | null {
    if ("and" in e) {
      const parts = e.and.map(go);
      const kept = parts.filter((p): p is { sql: string; exact: boolean } => p !== null);
      if (kept.length === 0) return null;
      return { sql: kept.map((p) => `(${p.sql})`).join(" AND "), exact: kept.length === parts.length && kept.every((p) => p.exact) };
    }
    if ("or" in e) {
      const parts = e.or.map(go);
      if (parts.some((p) => p === null)) return null;
      return { sql: (parts as { sql: string }[]).map((p) => `(${p.sql})`).join(" OR "), exact: (parts as { exact: boolean }[]).every((p) => p.exact) };
    }
    if ("not" in e) {
      const inner = go(e.not);
      return inner && inner.exact ? { sql: `NOT coalesce((${inner.sql}), false)`, exact: true } : null;
    }
    if ("truthy" in e) {
      const s = side(e.truthy);
      if (!s) return null;
      if ("constant" in s) return { sql: truthyConst(s.constant) ? "TRUE" : "FALSE", exact: true };
      return { sql: `(${s.sql} IS NOT NULL AND ${s.sql} NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb))`, exact: true };
    }
    const l = side(e.l);
    const r = side(e.r);
    if (!l || !r) return null;
    const ls = "constant" in l ? jsonLiteral(l.constant) : l.sql;
    const rs = "constant" in r ? jsonLiteral(r.constant) : r.sql;
    const nullish = (s: Side) => "constant" in s && (s.constant === null || s.constant === undefined);
    switch (e.cmp) {
      case "==":
        return { sql: `${norm(ls)} IS NOT DISTINCT FROM ${norm(rs)}`, exact: true };
      case "!=":
        return { sql: `${norm(ls)} IS DISTINCT FROM ${norm(rs)}`, exact: true };
      default:
        if (nullish(l) || nullish(r)) return null;
        return { sql: `coalesce(${ls} ${e.cmp} ${rs}, false)`, exact: true };
    }
  }

  function side(o: Operand): Side | null {
    if ("value" in o) return { constant: o.value };
    if ("actor" in o) {
      if (o.actor.some((p) => p === "__proto__" || p === "prototype" || p === "constructor")) return null;
      return { sql: `(${ACTOR} #> ${pathLiteral(o.actor)})` };
    }
    if (o.field.length !== 1 || !columns.has(o.field[0]!) || !isIdentifier(o.field[0]!)) return null;
    return { sql: `to_jsonb(${quoteIdent(o.field[0]!)})` };
  }
}

function norm(sql: string): string {
  return `nullif(${sql}, 'null'::jsonb)`;
}

function truthyConst(v: unknown): boolean {
  return !(v === null || v === undefined || v === false || v === 0 || v === "" || Number.isNaN(v));
}

export function pgPolicies(models: readonly Model<any, any>[], opts: PgPoliciesOptions = {}): PgPoliciesResult {
  const role = opts.role ?? "weft_app";
  if (!isIdentifier(role)) throw new Error(`pgPolicies: role ${JSON.stringify(role)} is not an identifier`);
  const r = quoteIdent(role);
  const sql: string[] = [];
  const skipped: PgPoliciesResult["skipped"] = [];
  if (opts.createRole !== false) {
    sql.push(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`);
  }
  for (const m of models) {
    const c = m.config as { readWhere?: PolicyExpr; writeWhere?: PolicyExpr };
    const t = quoteIdent(m.name);
    const columns = new Set(m.fields.map((f) => f.name));
    const tenant = m.tenant;
    const scoped = (where: PolicyExpr | undefined): PolicyExpr | undefined => {
      if (tenant === null) return where;
      const inTenant: PolicyExpr = { cmp: "==", l: { field: [tenant] }, r: { actor: ["tenant"] } };
      return where ? { and: [inTenant, where] } : inTenant;
    };
    const read = scoped(c.readWhere);
    const readSql = read && policyToRls(read, columns);
    if (!readSql) {
      skipped.push({ model: m.name, reason: c.readWhere ? "read rule not expressible in SQL" : "no readWhere" });
      continue;
    }
    const key = quoteIdent(m.key);
    const shared = (rights: string) => `(${GRANTS} -> '${m.name}' -> '${rights}') @> jsonb_build_array(to_jsonb(${key}))`;
    const readable = `(${readSql}) OR ${shared("read")} OR ${shared("write")}`;
    const write = scoped(c.writeWhere);
    const writeSql = write ? policyToRls(write, columns) : null;
    // No writeWhere: the JS `write` function decides; RLS then only requires the row to be readable.
    const writable = writeSql ? `(${writeSql}) OR ${shared("write")}` : readable;
    if (opts.createRole !== false) {
      sql.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO ${r}`);
      // the hidden insertion-order column is a serial
      sql.push(
        `DO $$ DECLARE s text; BEGIN s := pg_get_serial_sequence('${t}', '_weft_seq'); ` +
          `IF s IS NOT NULL THEN EXECUTE 'GRANT USAGE ON SEQUENCE ' || s || ' TO ${r}'; END IF; END $$`,
      );
    }
    sql.push(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    for (const [name, body] of [
      ["weft_read", `FOR SELECT TO ${r} USING (${readable})`],
      ["weft_insert", `FOR INSERT TO ${r} WITH CHECK (${writable})`],
      ["weft_update", `FOR UPDATE TO ${r} USING (${writable}) WITH CHECK (${writable})`],
      ["weft_delete", `FOR DELETE TO ${r} USING (${writable})`],
    ] as const) {
      sql.push(`DROP POLICY IF EXISTS ${name} ON ${t}`);
      sql.push(`CREATE POLICY ${name} ON ${t} ${body}`);
    }
  }
  return { sql, skipped };
}

export async function applyPgPolicies(pool: TxPool, models: readonly Model<any, any>[], opts: PgPoliciesOptions = {}): Promise<PgPoliciesResult> {
  const result = pgPolicies(models, opts);
  await asyncTransaction(async () => {
    const client = await enlistAsync(pool)!;
    for (const s of result.sql) await client.query(s);
  });
  return result;
}

export interface WithActorOptions {
  role?: string;
  grants?: Record<string, { read?: (string | number)[]; write?: (string | number)[] }>;
}

export async function withActor<R>(pool: TxPool, actor: unknown, fn: () => R | Promise<R>, opts: WithActorOptions = {}): Promise<R> {
  const role = opts.role ?? "weft_app";
  if (!isIdentifier(role)) throw new Error(`withActor: role ${JSON.stringify(role)} is not an identifier`);
  return asyncTransaction(async () => {
    const client = await enlistAsync(pool)!;
    const plain = actorJson(actor);
    await client.query("SELECT set_config('weft.actor', $1, true), set_config('weft.grants', $2, true)", [
      JSON.stringify(plain),
      JSON.stringify(opts.grants ?? {}),
    ]);
    await client.query(`SET LOCAL ROLE ${quoteIdent(role)}`);
    return await fn();
  });
}

function actorJson(actor: unknown): unknown {
  const seen = new WeakSet<object>();
  return JSON.parse(
    JSON.stringify(actor ?? null, (k, v) => {
      if (k === "__proto__" || typeof v === "function" || typeof v === "symbol") return undefined;
      if (typeof v === "bigint") return v.toString();
      if (v && typeof v === "object") {
        if (seen.has(v)) return undefined;
        seen.add(v);
      }
      return v;
    }),
  );
}

