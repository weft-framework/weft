import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { useDatabase, type FieldAttrs, type Model, type Operand, type PolicyExpr } from "@weft-framework/data";
import { CompileError, findCompiler, type Compiler } from "./compiler.ts";
import { ConfigError } from "./config.ts";
import { ProjectError, loadProject } from "./project.ts";

export class ExplainError extends Error {}

const EXPLAIN = Symbol.for("weft.access.explain");

type Explainer = (tenant?: string) => string;

export function explainModel(m: Model<unknown>): string {
  const c = m.config;
  const rule = (fn: unknown, where: unknown) =>
    fn === undefined ? "none (nobody)" : where === undefined ? "a rule (checked row by row)" : "a rule, also pushed into SQL";
  const lines = [`Model ${m.name} (key ${m.key})`];
  if (m.tenant !== null) lines.push(`  tenant: ${m.tenant} (rows stay inside the actor's tenant)`);
  for (const [verb, fn, where] of [
    ["read", c.read, c.readWhere],
    ["write", c.write, c.writeWhere],
  ] as const) {
    lines.push(`  ${verb}: ${rule(fn, where)}`);
    if (fn === undefined) continue;
    if (where !== undefined) lines.push(`    in words: ${words(where as PolicyExpr)}`);
    else lines.push(`    as code: ${code(fn)}`);
  }
  for (const [field, fn] of m.fieldReads) {
    const a = (c.attrs as Record<string, FieldAttrs> | undefined)?.[field];
    const consent = a?.consent;
    if (consent !== undefined) {
      const purpose = typeof consent === "string" ? consent : consent.purpose;
      const whose = typeof consent === "object" && consent.subject ? `the person in \`${consent.subject}\`` : "the reader";
      lines.push(`  field ${field}: shown only once ${whose} agreed to "${purpose}" (null otherwise)`);
      if (a?.read !== undefined) lines.push(`    and by its own rule, as code: ${code(a.read)}`);
      continue;
    }
    lines.push(`  field ${field}: read by whom its own rule admits (null for anyone else)`);
    lines.push(`    as code: ${code(fn)}`);
  }
  for (const [verb, fn, where] of [
    ["read", c.read, c.readWhere],
    ["write", c.write, c.writeWhere],
  ] as const) {
    if (fn === undefined) continue;
    if (where !== undefined && constant(where as PolicyExpr) === false) {
      lines.push(`  warning: the ${verb} rule can never pass (dead rule)`);
    } else if (passesForAnyone(m, fn as (a: unknown, r: unknown) => unknown)) {
      const what = verb === "read" ? "every row may be public" : "anyone may write";
      lines.push(`  warning: the ${verb} rule passes with no actor, on a row with every field empty (${what})`);
    }
  }
  return lines.join("\n");
}

export function words(e: PolicyExpr): string {
  const operand = (o: Operand): string => {
    if ("value" in o) return o.value === null ? "empty" : JSON.stringify(o.value);
    if ("field" in o) return `the row's ${o.field.join(".")}`;
    return o.actor.length === 0 ? "the actor" : `the actor's ${o.actor.join(".")}`;
  };
  const inner = (x: PolicyExpr) => ("or" in x || "and" in x ? `(${words(x)})` : words(x));
  if ("or" in e) return e.or.map(inner).join(", or ");
  if ("and" in e) return e.and.map(inner).join(", and ");
  if ("not" in e) return `not ${inner(e.not)}`;
  if ("truthy" in e) return "value" in e.truthy ? (e.truthy.value ? "always" : "never") : `${operand(e.truthy)} is set`;
  const verb = { "==": "is", "!=": "is not", "<": "is less than", "<=": "is at most", ">": "is more than", ">=": "is at least" }[e.cmp];
  return `${operand(e.l)} ${verb} ${operand(e.r)}`;
}

function code(fn: unknown): string {
  const s = String(fn).replace(/\s+/g, " ").trim();
  return s.length > 160 ? s.slice(0, 159) + "…" : s;
}

export function constant(e: PolicyExpr): boolean | null {
  const operand = (o: Operand): { v: unknown } | null => ("value" in o ? { v: o.value } : null);
  if ("or" in e) {
    const vs = e.or.map(constant);
    if (vs.includes(true)) return true;
    return vs.every((v) => v === false) ? false : null;
  }
  if ("and" in e) {
    const vs = e.and.map(constant);
    if (vs.includes(false)) return false;
    return vs.every((v) => v === true) ? true : null;
  }
  if ("not" in e) {
    const v = constant(e.not);
    return v === null ? null : !v;
  }
  if ("truthy" in e) {
    const o = operand(e.truthy);
    return o === null ? null : Boolean(o.v);
  }
  const l = operand(e.l);
  const r = operand(e.r);
  if (l === null || r === null) return null;
  const a = l.v as number | string | boolean | null;
  const b = r.v as number | string | boolean | null;
  switch (e.cmp) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    default:
      if (a === null || b === null) return false;
      return e.cmp === "<" ? a < b : e.cmp === "<=" ? a <= b : e.cmp === ">" ? a > b : a >= b;
  }
}

function passesForAnyone(m: Model<unknown>, fn: (a: unknown, r: unknown) => unknown): boolean {
  const row = Object.fromEntries(m.fields.map((f) => [f.name, null]));
  const yes = (actor: unknown) => {
    try {
      return fn(actor, { ...row }) === true;
    } catch {
      return false;
    }
  };
  return yes(null) && yes({});
}

export interface ExplainOptions {
  compiler: Compiler;
  tenant?: string;
}

export async function explainProject(root: string, opts: ExplainOptions): Promise<string> {
  root = resolve(root);
  const outDir = join(root, ".weft", "explain", randomUUID());
  try {
    const project = await loadProject(root, { compiler: opts.compiler, outDir, browserAssets: false, cacheKey: outDir });
    const models = Object.values(project.models) as Model<unknown>[];
    const access = new Set<Explainer>();
    const own: Model<unknown>[] = [];
    for (const m of models) {
      const ex = (m as unknown as Record<symbol, unknown>)[EXPLAIN];
      if (typeof ex === "function") access.add(ex as Explainer);
      else own.push(m);
    }
    if (access.size > 1) throw new ExplainError("src/models exports the models of more than one access configuration");
    let close = () => {};
    if (opts.tenant !== undefined) {
      if (access.size === 0) throw new ExplainError("--tenant needs @weft-framework/core's models in src/models");
      if (project.database === undefined || project.database === ":memory:") {
        throw new ExplainError("--tenant needs a `database` file in weft.config.ts");
      }
      const pg = await import("@weft-framework/data/postgres");
      if (pg.isPostgresUrl(project.database)) {
        const pool = await pg.openPostgres(project.database);
        close = () => void pool.end();
        // Access models are `replica: true`: their rows are loaded into memory for sync reads.
        await pg.usePostgres(pool, models as unknown as Model<never>[], { migrate: false, onWarning: () => {} });
      } else {
        const { openSqlite } = await import("@weft-framework/data/sqlite");
        const db = openSqlite(project.database, { readOnly: true });
        close = () => db.close();
        useDatabase(db, models as unknown as Model<never>[], { migrate: false, onWarning: () => {} });
      }
    }
    try {
      const parts: string[] = [];
      parts.push(own.length ? own.sort((a, b) => a.name.localeCompare(b.name)).map(explainModel).join("\n\n") : "No models in src/models.");
      for (const ex of access) {
        try {
          parts.push(ex(opts.tenant).trimEnd());
        } catch (e) {
          if (e instanceof Error && (e as { code?: unknown }).code === "not-found") throw new ExplainError(`no tenant ${opts.tenant}`);
          throw e;
        }
      }
      return parts.join("\n\n") + "\n";
    } finally {
      close();
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { tenant: { type: "string" } } });
  const root = resolve(positionals[0] ?? ".");
  try {
    process.stdout.write(await explainProject(root, { compiler: findCompiler(root), tenant: values.tenant }));
  } catch (err) {
    if (err instanceof CompileError) {
      console.error(err.diagnostics);
    } else if (err instanceof ExplainError || err instanceof ProjectError || err instanceof ConfigError) {
      console.error(`[weft] ${err.message}`);
    } else {
      console.error("[weft] explain:", err instanceof Error ? err.message : err);
    }
    process.exit(1);
  }
}

function isEntry(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  await main();
}
