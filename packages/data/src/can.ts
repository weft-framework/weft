export interface RowAsker {
  allows(verb: "read" | "write", key: unknown): boolean;
}

const origin = new WeakMap<object, { by: RowAsker; key: unknown }>();

export function tagRow<R>(row: R, by: RowAsker, key: unknown): R {
  if (typeof row === "object" && row !== null && key !== undefined && key !== null) origin.set(row, { by, key });
  return row;
}

export function rowSource(row: unknown): { by: RowAsker; key: unknown } | null {
  if (typeof row !== "object" || row === null) return null;
  return origin.get(row) ?? null;
}

export function can(verb: "read" | "write", row: unknown): boolean {
  if (verb !== "read" && verb !== "write") return false;
  if (typeof row !== "object" || row === null) return false;
  const o = origin.get(row);
  if (!o) return false;
  try {
    return o.by.allows(verb, o.key) === true;
  } catch {
    return false;
  }
}

const KEY = Symbol.for("weft.can");
const g = globalThis as Record<symbol, Set<typeof can> | undefined>;
(g[KEY] ??= new Set()).add(can);
