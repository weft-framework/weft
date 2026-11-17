import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { diffRules, type Model, type RulesDiff } from "@weft/data";
import { CompileError, findCompiler, type Compiler } from "./compiler.ts";
import { ConfigError } from "./config.ts";
import { ProjectError, loadProject } from "./project.ts";

export class RulesDiffError extends Error {}

const EXPLAIN = Symbol.for("weft.access.explain");
const SKIP = /^(node_modules|\.weft|dist|data)(\/|$)/;

export interface RulesDiffOptions {
  compiler: Compiler;
  runs?: number;
  seed?: number;
}

export interface RulesDiffResult {
  diffs: RulesDiff[];
  widened: boolean;
  text: string;
}

function git(cwd: string, args: string[]): Buffer {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    throw new RulesDiffError(`git ${args[0]}: ${stderr || (err as Error).message}`);
  }
}

export function checkoutProject(root: string, ref: string, into: string): boolean {
  if (ref === "" || ref.startsWith("-") || /[\0\n]/.test(ref)) throw new RulesDiffError(`not a revision: ${JSON.stringify(ref)}`);
  const commit = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).toString().trim();
  const prefix = git(root, ["rev-parse", "--show-prefix"]).toString().trim();
  const listed = git(root, ["ls-tree", "-r", "-z", "--full-name", "--name-only", commit, "--", "."]).toString().split("\0");
  let wrote = 0;
  for (const full of listed) {
    if (full === "" || !full.startsWith(prefix)) continue;
    const rel = full.slice(prefix.length);
    if (SKIP.test(rel) || rel.split("/").some((p) => p === ".." || p === "")) continue;
    const blob = git(root, ["cat-file", "blob", `${commit}:${full}`]);
    const to = join(into, ...rel.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, blob);
    wrote++;
  }
  return wrote > 0;
}

const own = (models: Record<string, unknown>) =>
  new Map(
    (Object.values(models) as Model<unknown>[])
      .filter((m) => typeof (m as unknown as Record<symbol, unknown>)[EXPLAIN] !== "function")
      .map((m) => [m.name, m]),
  );

const short = (v: unknown) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 200 ? s.slice(0, 199) + "…" : s;
};

export function widens(d: RulesDiff): boolean {
  if (d.status === "added") return (d.passed.after?.read ?? 0) + (d.passed.after?.write ?? 0) > 0;
  return d.changes.some((c) => c.change === "widened") || (d.tenant !== undefined && d.tenant.after === null);
}

export function rulesDiffText(d: RulesDiff): string {
  const pct = (n: number) => `${n} of ${d.checks} actor/row pairs`;
  if (d.status === "added") {
    return `Model ${d.model}: added; read admits ${pct(d.passed.after!.read)}, write ${pct(d.passed.after!.write)}`;
  }
  if (d.status === "removed") return `Model ${d.model}: removed`;
  const lines = [`Model ${d.model}: ${widens(d) ? "access WIDENED" : d.changes.length ? "access narrowed" : "changed"}`];
  if (d.tenant) lines.push(`  tenant field: ${d.tenant.before ?? "none"} -> ${d.tenant.after ?? "none (rows no longer kept inside a tenant)"}`);
  for (const c of d.changes) {
    const what = c.change === "widened" ? "now admits" : "now refuses";
    lines.push(`  ${c.rule} ${c.change}: ${what} ${pct(c.pairs)}, for example`);
    lines.push(`    actor: ${short(c.actor)}`);
    lines.push(`    row:   ${short(c.row)}`);
  }
  if (d.fields.added.length) lines.push(`  fields added: ${d.fields.added.join(", ")}`);
  if (d.fields.removed.length) lines.push(`  fields removed: ${d.fields.removed.join(", ")}`);
  return lines.join("\n");
}

export async function diffProjectRules(root: string, ref: string, opts: RulesDiffOptions): Promise<RulesDiffResult> {
  root = resolve(root);
  const run = join(root, ".weft", "rules-diff", randomUUID());
  try {
    const old = join(run, "before");
    const existed = checkoutProject(root, ref, old);
    const load = (dir: string, out: string) =>
      loadProject(dir, { compiler: opts.compiler, outDir: join(run, out), browserAssets: false, cacheKey: join(run, out) });
    const after = own((await load(root, "after-out")).models);
    let before = new Map<string, Model<unknown>>();
    if (existed) {
      try {
        before = own((await load(old, "before-out")).models);
      } catch (err) {
        if (err instanceof CompileError) throw new RulesDiffError(`the project at ${ref} does not compile:\n${err.diagnostics}`);
        throw err;
      }
    }
    const names = [...new Set([...before.keys(), ...after.keys()])].sort();
    const diffs = names.map((n) => diffRules(before.get(n), after.get(n), { runs: opts.runs, seed: opts.seed }));
    const shown = diffs.filter((d) => d.status !== "same");
    const widened = diffs.some(widens);
    const text = shown.length
      ? shown.map(rulesDiffText).join("\n\n") + "\n"
      : `No rule changes against ${ref} (${names.length} model${names.length === 1 ? "" : "s"} compared).\n`;
    return { diffs, widened, text };
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}

const whole = (name: string, v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < (name === "--seed" ? 0 : 1)) throw new RulesDiffError(`${name} is a whole number`);
  return n;
};

async function main(): Promise<void> {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        ref: { type: "string" },
        runs: { type: "string" },
        seed: { type: "string" },
        "fail-on-widen": { type: "boolean" },
      },
    });
    if (values.ref === undefined) throw new RulesDiffError("usage: weft rules diff <ref> [dir]");
    const root = resolve(positionals[0] ?? ".");
    const result = await diffProjectRules(root, values.ref, {
      compiler: findCompiler(root),
      runs: whole("--runs", values.runs),
      seed: whole("--seed", values.seed),
    });
    process.stdout.write(result.text);
    if (values["fail-on-widen"] && result.widened) process.exit(1);
  } catch (err) {
    if (err instanceof CompileError) {
      console.error(err.diagnostics);
    } else if (err instanceof RulesDiffError || err instanceof ProjectError || err instanceof ConfigError) {
      console.error(`[weft] ${err.message}`);
    } else {
      console.error("[weft] rules diff:", err instanceof Error ? err.message : err);
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
