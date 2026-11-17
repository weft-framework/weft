export interface FieldOps<V> {
  eq?: V | null;
  ne?: V | null;
  in?: readonly (V | null)[];
  lt?: V;
  lte?: V;
  gt?: V;
  gte?: V;
  contains?: string;
  startsWith?: string;
}

export type Filter<T> = {
  [K in keyof T]?: T[K] | null | FieldOps<NonNullable<T[K]>>;
} & {
  $or?: Filter<T>[];
  $not?: Filter<T>;
};

export type OpName = keyof FieldOps<unknown>;

const OPS = new Set<string>(["eq", "ne", "in", "lt", "lte", "gt", "gte", "contains", "startsWith"]);

export type FilterNode =
  | { field: string; op: OpName; value: unknown }
  | { or: FilterNode[][] }
  | { not: FilterNode[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return false;
  }
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function parseFilter(filter: unknown, fields: ReadonlySet<string>, model: string): FilterNode[] {
  if (!isPlainObject(filter)) {
    throw new Error(`${model}: a filter is a plain object`);
  }
  const out: FilterNode[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$or") {
      if (!Array.isArray(value)) {
        throw new Error(`${model}: $or takes an array of filters`);
      }
      out.push({ or: value.map((f) => parseFilter(f, fields, model)) });
      continue;
    }
    if (key === "$not") {
      out.push({ not: parseFilter(value, fields, model) });
      continue;
    }
    if (!fields.has(key)) {
      throw new Error(`${model}: no field \`${key}\` to filter on`);
    }
    if (value === undefined) {
      throw new Error(`${model}: filter on \`${key}\` is undefined (use null to match a missing value)`);
    }
    if (!isPlainObject(value)) {
      out.push({ field: key, op: "eq", value });
      continue;
    }
    const ops = Object.entries(value);
    if (ops.length === 0) {
      throw new Error(`${model}: empty operator object for \`${key}\``);
    }
    for (const [op, v] of ops) {
      if (!OPS.has(op)) {
        throw new Error(`${model}: unknown filter operator \`${op}\` on \`${key}\``);
      }
      if (v === undefined) {
        throw new Error(`${model}: \`${key}.${op}\` is undefined`);
      }
      if (op === "in" && !Array.isArray(v)) {
        throw new Error(`${model}: \`${key}.in\` takes an array`);
      }
      if ((op === "contains" || op === "startsWith") && typeof v !== "string") {
        throw new Error(`${model}: \`${key}.${op}\` takes a string`);
      }
      out.push({ field: key, op: op as OpName, value: v });
    }
  }
  return out;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === "object") return typeof b === "object" && b !== null && JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

export function compareText(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    x = x >= 0xe000 ? x - 0x800 : x >= 0xd800 ? x + 0x2000 : x;
    y = y >= 0xe000 ? y - 0x800 : y >= 0xd800 ? y + 0x2000 : y;
    return x - y;
  }
  return a.length - b.length;
}

function rank(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return 1;
  return 2;
}

export function compareSame(a: unknown, b: unknown): number | null {
  const num = (v: unknown) => typeof v === "number" || typeof v === "bigint";
  if (num(a) && num(b)) {
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string") return compareText(a, b);
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (a instanceof Date && b instanceof Date) {
    const d = a.getTime() - b.getTime();
    return Number.isNaN(d) ? null : d;
  }
  return null;
}

export function compareValues(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb || ra === 0) return ra - rb;
  if (a instanceof Date && typeof b === "string") return compareText(a.toISOString(), b);
  if (typeof a === "string" && b instanceof Date) return compareText(a, b.toISOString());
  return compareSame(a, b) ?? 0;
}

function test(node: FilterNode, row: Record<string, unknown>): boolean {
  if ("or" in node) return node.or.some((all) => matches(all, row));
  if ("not" in node) return !matches(node.not, row);
  const v = row[node.field];
  const x = node.value;
  switch (node.op) {
    case "eq":
      return sameValue(v, x);
    case "ne":
      return !sameValue(v, x);
    case "in":
      return (x as unknown[]).some((e) => sameValue(v, e));
    case "contains":
      return typeof v === "string" && v.includes(x as string);
    case "startsWith":
      return typeof v === "string" && v.startsWith(x as string);
    default: {
      if (v === null || v === undefined || x === null || x === undefined) return false;
      const c = compareSame(v, x);
      if (c === null) return false;
      return node.op === "lt" ? c < 0 : node.op === "lte" ? c <= 0 : node.op === "gt" ? c > 0 : c >= 0;
    }
  }
}

export function matches(nodes: readonly FilterNode[], row: unknown): boolean {
  const r = row as Record<string, unknown>;
  return nodes.every((n) => test(n, r));
}
