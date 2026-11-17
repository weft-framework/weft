const KEY = Symbol.for("weft.can");

export function can(verb: "read" | "write", row: unknown): boolean {
  const checkers = (globalThis as Record<symbol, Set<(v: string, r: unknown) => boolean> | undefined>)[KEY];
  if (!checkers) return false;
  for (const check of checkers) {
    try {
      if (check(verb, row) === true) return true;
    } catch {
    }
  }
  return false;
}
