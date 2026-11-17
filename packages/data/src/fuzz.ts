import { ChangeFeed } from "./changes.ts";
import { Model, type Actor, type ModelConfig } from "./model.ts";
import type { FieldAttrs } from "./schema.ts";
import { useDatabase, type SqlDatabase } from "./sql.ts";

export type FuzzKind = "hole" | "missing" | "throws" | "unreachable";

export interface FuzzFinding {
  kind: FuzzKind;
  rule: "read" | "write";
  store: "memory" | "sql";
  message: string;
  actor?: unknown;
  row?: unknown;
}

export interface FuzzReport {
  model: string;
  checks: number;
  passed: { read: number; write: number };
  findings: FuzzFinding[];
}

export interface FuzzOptions {
  runs?: number;
  rows?: number;
  seed?: number;
  actors?: Actor[];
  values?: Record<string, unknown[]>;
  database?: () => SqlDatabase & { close?(): void };
}

const POOL = ["a", "b", "c", "k0", "k1", "k2", "t1", "t2", "admin", "member", "owner", ""];
const ROLES = ["owner", "admin", "member", "guest", "viewer"];
const NUMBERS = [0, 1, 2, -1, 42, 1_700_000_000_000];

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unionParts(type: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if ("<({[".includes(c)) depth++;
    else if (">)}]".includes(c)) depth--;
    else if (c === "|" && depth === 0) {
      out.push(type.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(type.slice(start).trim());
  return out.filter((p) => p !== "");
}

function valueOf(type: string, pick: <V>(xs: readonly V[]) => V, depth = 0): unknown {
  const t = pick(unionParts(type));
  if (t === "null") return null;
  if (t === "undefined") return null;
  if (t === "string") return pick(POOL);
  if (t === "number") return pick(NUMBERS);
  if (t === "boolean") return pick([true, false]);
  if (t === "Date") return new Date(pick(NUMBERS.filter((n) => n >= 0)));
  if (/^(["']).*\1$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  const arr = /^(.*)\[\]$/.exec(t) ?? /^Array<(.*)>$/.exec(t);
  if (arr && depth < 2) return pick([0, 1, 2]) === 0 ? [] : [valueOf(arr[1]!, pick, depth + 1), valueOf(arr[1]!, pick, depth + 1)];
  return pick(POOL);
}

function copyConfig<T>(config: ModelConfig<T>): ModelConfig<T> {
  const attrs: Record<string, FieldAttrs> = {};
  for (const [f, a] of Object.entries(config.attrs ?? {})) {
    const { ref: _ref, ...rest } = a as FieldAttrs & { ref?: unknown };
    attrs[f] = rest;
  }
  return { ...config, attrs };
}

const picker =
  (rand: () => number) =>
  <V>(xs: readonly V[]): V =>
    xs[Math.floor(rand() * xs.length)]!;

function makeActors(rand: () => number, runs: number, given: Actor[] = []): Actor[] {
  const pick = picker(rand);
  const actors: Actor[] = [null, ...given];
  for (let i = 0; i < runs; i++) {
    const a: Record<string, unknown> = { id: pick(POOL.filter((p) => p !== "")) };
    if (rand() < 0.7) a.role = pick(ROLES);
    if (rand() < 0.7) a.tenant = pick(["t1", "t2"]);
    if (rand() < 0.3) a.roles = [pick(ROLES)];
    if (rand() < 0.5) {
      const answers = new Map<string, boolean>();
      const yes = rand();
      a.can = (permission: unknown, scope?: unknown) => {
        const k = JSON.stringify([permission, scope ?? null]);
        if (!answers.has(k)) answers.set(k, rand() < yes);
        return answers.get(k)!;
      };
    }
    actors.push(a);
  }
  return actors;
}

function makeRowsOf<T>(model: Model<T>, rand: () => number, count: number, values?: Record<string, unknown[]>): T[] {
  const pick = picker(rand);
  const rows: T[] = [];
  for (let i = 0; i < count; i++) {
    const row: Record<string, unknown> = {};
    for (const f of model.fields) {
      const given = values?.[f.name];
      if (f.name === model.key) row[f.name] = /\bnumber\b/.test(f.type) && !/\bstring\b/.test(f.type) ? i + 1 : `k${i}`;
      else if (given && given.length > 0) row[f.name] = pick(given);
      else if (f.name === model.tenant) row[f.name] = pick(["t1", "t2"]);
      else if (f.name === model.trashField) row[f.name] = rand() < 0.2 ? 1_700_000_000_000 : null;
      else if (f.file) row[f.name] = null;
      else row[f.name] = valueOf(f.type, pick);
    }
    rows.push(row as T);
  }
  return rows;
}

export function fuzzRules<T>(model: Model<T>, opts: FuzzOptions = {}): FuzzReport {
  const runs = opts.runs ?? 40;
  const rowCount = opts.rows ?? 40;
  if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(rowCount) || rowCount < 1) {
    throw new Error("fuzzRules: runs and rows are whole numbers of at least 1");
  }
  const rand = random(opts.seed ?? 1);
  const config = model.config;
  const report: FuzzReport = { model: model.name, checks: 0, passed: { read: 0, write: 0 }, findings: [] };
  const seen = new Set<string>();
  const find = (f: FuzzFinding) => {
    const id = `${f.kind}:${f.rule}:${f.store}`;
    if (seen.has(id)) return;
    seen.add(id);
    report.findings.push(f);
  };
  const thrown = { read: 0, write: 0 };
  const rule = (which: "read" | "write", actor: Actor, row: T): boolean => {
    const fn = config[which];
    if (!fn) return false;
    if (!model.inTenant(actor, row)) return false;
    try {
      return fn(actor, structuredClone(row)) === true;
    } catch (err) {
      thrown[which]++;
      if (actor !== null) {
        find({
          kind: "throws",
          rule: which,
          store: "memory",
          message: `the ${which} rule threw (${err instanceof Error ? err.message : String(err)}); it counts as no`,
          actor,
          row,
        });
      }
      return false;
    }
  };

  const actors = makeActors(rand, runs, opts.actors);
  const key = model.key;
  const makeRows = () => makeRowsOf(model, rand, rowCount, opts.values);

  const run = (store: "memory" | "sql", db?: SqlDatabase) => {
    const copy = new Model<T>(model.name, copyConfig(config)).publishTo(new ChangeFeed());
    if (db) useDatabase(db, [copy as unknown as Model<never>], { onWarning: () => {} });
    const rows: T[] = [];
    for (const r of makeRows()) {
      try {
        copy.driver.insert(structuredClone(r));
        rows.push(r);
      } catch {
      }
    }
    const keyOf = (r: T) => String((r as Record<string, unknown>)[key]);
    const live = (r: T) => model.trashField === null || (r as Record<string, unknown>)[model.trashField] === null;

    for (const actor of actors) {
      const want = new Set(rows.filter((r) => live(r) && rule("read", actor, r)).map(keyOf));
      report.checks += rows.length;
      report.passed.read += want.size;
      const attempt = (fn: () => T[]): T[] | null => {
        try {
          return fn();
        } catch {
          return null;
        }
      };
      for (const [how, got] of [
        ["all()", attempt(() => copy.as(actor).all())],
        ["query().all()", attempt(() => copy.as(actor).query().all())],
      ] as const) {
        if (got === null) continue;
        const keys = new Set(got.map(keyOf));
        const extra = got.find((r) => !want.has(keyOf(r)));
        if (extra) {
          find({ kind: "hole", rule: "read", store, message: `${how} returned a row the read rule refuses`, actor, row: extra });
        }
        const lost = rows.find((r) => want.has(keyOf(r)) && !keys.has(keyOf(r)));
        if (lost) {
          find({
            kind: "missing",
            rule: "read",
            store,
            message: `${how} left out a row the read rule allows (readWhere is narrower than read)`,
            actor,
            row: lost,
          });
        }
      }
    }

    for (const actor of actors.slice(0, Math.max(8, Math.ceil(actors.length / 3)))) {
      for (const r of rows) {
        if (!live(r)) continue;
        const k = (r as Record<string, unknown>)[key];
        const writes = rule("write", actor, r);
        if (writes) report.passed.write++;
        const allowed = writes && rule("read", actor, r);
        let n = 0;
        try {
          n = copy.as(actor).update((x) => (x as Record<string, unknown>)[key] === k, {} as Partial<T>);
        } catch {
          n = 0;
        }
        if (n > 0 && !allowed) find({ kind: "hole", rule: "write", store, message: "update changed a row the rules refuse", actor, row: r });
        if (n === 0 && allowed) {
          find({
            kind: "missing",
            rule: "write",
            store,
            message: "update refused a row the rules allow (writeWhere is narrower than write)",
            actor,
            row: r,
          });
        }
        let d = 0;
        try {
          d = copy.as(actor).delete((x) => (x as Record<string, unknown>)[key] === k);
        } catch {
          d = 0;
        }
        if (d > 0) {
          if (!allowed) find({ kind: "hole", rule: "write", store, message: "delete removed a row the rules refuse", actor, row: r });
          if (model.trashField === null) copy.driver.insert(structuredClone(r));
          else copy.driver.update(k, structuredClone(r));
        }
      }
    }
  };

  run("memory");
  if (opts.database) {
    const db = opts.database();
    try {
      run("sql", db);
    } finally {
      db.close?.();
    }
  }

  for (const which of ["read", "write"] as const) {
    if (config[which] && report.passed[which] === 0) {
      find({
        kind: "unreachable",
        rule: which,
        store: "memory",
        message:
          `no generated actor passed the ${which} rule` +
          (thrown[which] > 0 ? ` (it threw ${thrown[which]} times)` : "") +
          "; give actors or values that should pass with --actors / values",
      });
    }
  }
  return report;
}

export interface RuleChange {
  rule: "read" | "write";
  change: "widened" | "narrowed";
  pairs: number;
  actor: unknown;
  row: unknown;
}

export interface RulesDiff {
  model: string;
  status: "added" | "removed" | "changed" | "same";
  checks: number;
  changes: RuleChange[];
  passed: { before: { read: number; write: number } | null; after: { read: number; write: number } | null };
  fields: { added: string[]; removed: string[] };
  tenant?: { before: string | null; after: string | null };
}

export type DiffOptions = Omit<FuzzOptions, "database">;

function admits<T>(model: Model<T>, which: "read" | "write", actor: Actor, row: T): boolean {
  const fn = model.config[which];
  if (!fn || !model.inTenant(actor, row)) return false;
  try {
    return fn(actor, structuredClone(row)) === true;
  } catch {
    return false;
  }
}

export function diffRules(
  before: Model<unknown> | undefined,
  after: Model<unknown> | undefined,
  opts: DiffOptions = {},
): RulesDiff {
  const either = after ?? before;
  if (!either) throw new Error("diffRules: give the model before, after, or both");
  if (before && after && before.name !== after.name) throw new Error("diffRules: the models have different names");
  const runs = opts.runs ?? 40;
  const rowCount = opts.rows ?? 40;
  if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(rowCount) || rowCount < 1) {
    throw new Error("diffRules: runs and rows are whole numbers of at least 1");
  }
  const seed = opts.seed ?? 1;
  const rand = random(seed);
  const actors = makeActors(rand, runs, opts.actors);
  const newRows = after ? makeRowsOf(after, rand, rowCount, opts.values) : [];
  const oldRows = before ? makeRowsOf(before, random(seed + 1), rowCount, opts.values) : [];
  const rows = Array.from({ length: rowCount }, (_, i) => ({ ...(oldRows[i] as object), ...(newRows[i] as object) }));

  const names = (m?: Model<unknown>) => new Set(m?.fields.map((f) => f.name) ?? []);
  const was = names(before);
  const now = names(after);
  const out: RulesDiff = {
    model: either.name,
    status: !before ? "added" : !after ? "removed" : "same",
    checks: actors.length * rows.length,
    changes: [],
    passed: { before: before ? { read: 0, write: 0 } : null, after: after ? { read: 0, write: 0 } : null },
    fields: {
      added: before && after ? [...now].filter((f) => !was.has(f)) : [],
      removed: before && after ? [...was].filter((f) => !now.has(f)) : [],
    },
  };
  if (before && after && before.tenant !== after.tenant) out.tenant = { before: before.tenant, after: after.tenant };

  const found = new Map<string, RuleChange>();
  for (const actor of actors) {
    for (const row of rows) {
      for (const which of ["read", "write"] as const) {
        const old = before ? admits(before, which, actor, row) : false;
        const neu = after ? admits(after, which, actor, row) : false;
        if (old && out.passed.before) out.passed.before[which]++;
        if (neu && out.passed.after) out.passed.after[which]++;
        if (!before || !after || old === neu) continue;
        const change = neu ? "widened" : "narrowed";
        const id = `${which}:${change}`;
        const seen = found.get(id);
        if (seen) seen.pairs++;
        else found.set(id, { rule: which, change, pairs: 1, actor, row });
      }
    }
  }
  out.changes = [...found.values()].sort((a, b) => (a.change === b.change ? a.rule.localeCompare(b.rule) : a.change === "widened" ? -1 : 1));
  if (out.status === "same" && (out.changes.length || out.fields.added.length || out.fields.removed.length || out.tenant)) {
    out.status = "changed";
  }
  return out;
}
