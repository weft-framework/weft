import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fuzzRules, type FuzzReport, type Model } from "@weft-framework/data";
import { CompileError, findCompiler, type Compiler } from "./compiler.ts";
import { ConfigError } from "./config.ts";
import { ProjectError, loadProject } from "./project.ts";

export class RulesTestError extends Error {}

const EXPLAIN = Symbol.for("weft.access.explain");

export interface RulesTestOptions {
  compiler: Compiler;
  runs?: number;
  seed?: number;
  model?: string;
}

export interface RulesTestResult {
  reports: FuzzReport[];
  ok: boolean;
  text: string;
}

const short = (v: unknown) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 200 ? s.slice(0, 199) + "…" : s;
};

export function rulesReportText(r: FuzzReport): string {
  const bad = r.findings.filter((f) => f.kind === "hole" || f.kind === "missing");
  const head = `Model ${r.model}: ${r.checks} checks, read passed ${r.passed.read}, write passed ${r.passed.write}`;
  const lines = [`${head}: ${bad.length ? "FAILED" : "ok"}`];
  const dead = r.findings.filter((f) => f.kind === "unreachable");
  const closed = dead.length === 2;
  if (closed) {
    lines.push("  note: closed to every generated actor (a library's model, whose rules admit only its own code?)");
  }
  for (const f of r.findings) {
    if (closed && f.kind === "unreachable") continue;
    const level = f.kind === "hole" || f.kind === "missing" ? "error" : "warning";
    lines.push(`  ${level} (${f.kind}, ${f.rule}, ${f.store}): ${f.message}`);
    if ("actor" in f) lines.push(`    actor: ${short(f.actor)}`);
    if ("row" in f) lines.push(`    row:   ${short(f.row)}`);
  }
  return lines.join("\n");
}

export async function testRules(root: string, opts: RulesTestOptions): Promise<RulesTestResult> {
  root = resolve(root);
  const outDir = join(root, ".weft", "rules", randomUUID());
  try {
    const project = await loadProject(root, { compiler: opts.compiler, outDir, browserAssets: false, cacheKey: outDir });
    const { openSqlite } = await import("@weft-framework/data/sqlite");
    let models = (Object.values(project.models) as Model<unknown>[]).filter(
      (m) => typeof (m as unknown as Record<symbol, unknown>)[EXPLAIN] !== "function",
    );
    if (opts.model !== undefined) {
      models = models.filter((m) => m.name === opts.model);
      if (models.length === 0) throw new RulesTestError(`no model ${opts.model} in src/models`);
    }
    models.sort((a, b) => a.name.localeCompare(b.name));
    const reports = models.map((m) =>
      fuzzRules(m, { runs: opts.runs, seed: opts.seed, database: () => openSqlite(":memory:") }),
    );
    const ok = reports.every((r) => !r.findings.some((f) => f.kind === "hole" || f.kind === "missing"));
    const text = reports.length ? reports.map(rulesReportText).join("\n\n") + "\n" : "No models in src/models.\n";
    return { reports, ok, text };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

const whole = (name: string, v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < (name === "--seed" ? 0 : 1)) throw new RulesTestError(`${name} is a whole number`);
  return n;
};

async function main(): Promise<void> {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { runs: { type: "string" }, seed: { type: "string" }, model: { type: "string" } },
    });
    const root = resolve(positionals[0] ?? ".");
    const result = await testRules(root, {
      compiler: findCompiler(root),
      runs: whole("--runs", values.runs),
      seed: whole("--seed", values.seed),
      model: values.model,
    });
    process.stdout.write(result.text);
    if (!result.ok) process.exit(1);
  } catch (err) {
    if (err instanceof CompileError) {
      console.error(err.diagnostics);
    } else if (err instanceof RulesTestError || err instanceof ProjectError || err instanceof ConfigError) {
      console.error(`[weft] ${err.message}`);
    } else {
      console.error("[weft] test rules:", err instanceof Error ? err.message : err);
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
