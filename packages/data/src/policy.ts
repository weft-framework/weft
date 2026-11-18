export type Operand =
  | { field: string[] }
  | { actor: string[] }
  | { value: string | number | boolean | null };

export type PolicyExpr =
  | { or: PolicyExpr[] }
  | { and: PolicyExpr[] }
  | { not: PolicyExpr }
  | { truthy: Operand }
  | { cmp: "==" | "!=" | "<" | "<=" | ">" | ">="; l: Operand; r: Operand };

export type SqlValue = string | number | bigint | null;

export interface Sql {
  sql: string;
  params: SqlValue[];
}

export type ColumnResolver = (path: string[]) => string | null;

export type SqlDialect = "sqlite" | "pg";

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function actorValue(actor: unknown, path: string[]): unknown {
  let v: unknown = actor;
  for (const key of path) {
    if (v === null || (typeof v !== "object" && typeof v !== "function") || UNSAFE_KEYS.has(key)) {
      return undefined;
    }
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

function bindable(v: unknown): SqlValue | undefined {
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v === "boolean") {
    return v ? 1 : 0;
  }
  if (typeof v === "string" || typeof v === "bigint") {
    return v;
  }
  if (typeof v === "number") {
    return Number.isNaN(v) ? undefined : v;
  }
  return undefined;
}

type Side = { sql: string; params: SqlValue[] } | { constant: unknown };

export function policyToSql(expr: PolicyExpr, actor: unknown, column: ColumnResolver, dialect: SqlDialect = "sqlite"): Sql | null {
  const pg = dialect === "pg";
  const TRUE = pg ? "TRUE" : "1";
  const FALSE = pg ? "FALSE" : "0";
  const out = go(expr);
  return out && { sql: out.sql, params: out.params };

  function go(e: PolicyExpr): Out | null {
    if ("and" in e) {
      const parts = e.and.map(go);
      const kept = parts.filter((p): p is Out => p !== null);
      if (kept.length === 0) {
        return null;
      }
      return { ...combine("AND", kept), exact: kept.length === parts.length && kept.every((p) => p.exact) };
    }
    if ("or" in e) {
      const parts = e.or.map(go);
      if (parts.some((p) => p === null)) {
        return null;
      }
      return { ...combine("OR", parts as Out[]), exact: (parts as Out[]).every((p) => p.exact) };
    }
    if ("not" in e) {
      const inner = go(e.not);
      return inner && inner.exact ? { sql: `NOT (${inner.sql})`, params: inner.params, exact: true } : null;
    }
    if ("truthy" in e) {
      const s = side(e.truthy);
      if (!s) {
        return null;
      }
      if ("constant" in s) {
        return { sql: s.constant ? TRUE : FALSE, params: [], exact: true };
      }
      if (pg) {
        return null;
      }
      const x = s.sql;
      return {
        sql:
          `(${x} IS NOT NULL AND NOT (typeof(${x}) IN ('integer', 'real') AND ${x} = 0)` +
          ` AND NOT (typeof(${x}) = 'text' AND ${x} = ''))`,
        params: [],
        exact: true,
      };
    }
    const l = side(e.l);
    const r = side(e.r);
    if (!l || !r) {
      return null;
    }
    if ("constant" in l && "constant" in r) {
      return { sql: constCompare(e.cmp, l.constant, r.constant) ? TRUE : FALSE, params: [], exact: true };
    }
    const ls = toSql(l);
    const rs = toSql(r);
    if (!ls || !rs) {
      return null;
    }
    const isNull = ("constant" in l && l.constant == null) || ("constant" in r && r.constant == null);
    let op: string;
    switch (e.cmp) {
      case "==":
        op = pg ? "IS NOT DISTINCT FROM" : "IS";
        break;
      case "!=":
        op = pg ? "IS DISTINCT FROM" : "IS NOT";
        break;
      default:
        if (isNull) {
          return null;
        }
        op = e.cmp;
    }
    return { sql: `${ls.sql} ${op} ${rs.sql}`, params: [...ls.params, ...rs.params], exact: true };
  }

  function side(o: Operand): Side | null {
    if ("value" in o) {
      return { constant: o.value };
    }
    if ("actor" in o) {
      return { constant: actorValue(actor, o.actor) };
    }
    const col = column(o.field);
    return col === null ? null : { sql: col, params: [] };
  }

  function toSql(s: Side): Sql | null {
    if (!("constant" in s)) {
      return s;
    }
    const v = bindable(s.constant);
    return v === undefined ? null : { sql: "?", params: [v] };
  }
}

interface Out extends Sql {
  exact: boolean;
}

function combine(op: "AND" | "OR", parts: Sql[]): Sql {
  if (parts.length === 1) {
    return parts[0];
  }
  return {
    sql: parts.map((p) => `(${p.sql})`).join(` ${op} `),
    params: parts.flatMap((p) => p.params),
  };
}

function constCompare(op: string, a: unknown, b: unknown): boolean {
  switch (op) {
    case "==":
      return a == b;
    case "!=":
      return a != b;
    case "<":
      return (a as number) < (b as number);
    case "<=":
      return (a as number) <= (b as number);
    case ">":
      return (a as number) > (b as number);
    default:
      return (a as number) >= (b as number);
  }
}
