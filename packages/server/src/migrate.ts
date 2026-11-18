import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { migrate, planMigrations, type MigrationPlan, type Model } from "@weft-framework/data";
import { CompileError, findCompiler, type Compiler } from "./compiler.ts";
import { ConfigError } from "./config.ts";
import { ProjectError, loadProject } from "./project.ts";

export interface MigrateCommandOptions {
  compiler: Compiler;
  dryRun?: boolean;
  destructive?: boolean;
}

export class MigrateError extends Error {}

/** Hide the password of a database URL before printing it. */
export function redactUrl(database: string): string {
  try {
    const u = new URL(database);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return database;
  }
}

export async function migrateProject(root: string, opts: MigrateCommandOptions): Promise<MigrationPlan & { database: string }> {
  root = resolve(root);
  const outDir = join(root, ".weft", "migrate", randomUUID());
  try {
    const project = await loadProject(root, { compiler: opts.compiler, outDir, browserAssets: false, cacheKey: outDir });
    if (project.database === undefined) {
      throw new MigrateError("no `database` in weft.config.ts; models are kept in memory");
    }
    const models = Object.values(project.models) as Model<unknown>[];
    const pg = await import("@weft-framework/data/postgres");
    if (pg.isPostgresUrl(project.database)) {
      const pool = await pg.openPostgres(project.database);
      try {
        let plan: MigrationPlan;
        if (opts.dryRun) {
          const client = await pool.connect();
          try {
            plan = await pg.planPgMigrations(client, models, { destructive: opts.destructive });
          } finally {
            client.release();
          }
        } else {
          plan = await pg.migratePg(pool, models, { destructive: opts.destructive });
        }
        return { ...plan, database: redactUrl(project.database) };
      } finally {
        await pool.end();
      }
    }
    const { openSqlite } = await import("@weft-framework/data/sqlite");
    if (project.database !== ":memory:") {
      mkdirSync(dirname(project.database), { recursive: true });
    }
    const db = openSqlite(project.database);
    try {
      const plan = opts.dryRun
        ? planMigrations(db, models, { destructive: opts.destructive })
        : migrate(db, models, { destructive: opts.destructive });
      return { ...plan, database: project.database };
    } finally {
      db.close();
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "dry-run": { type: "boolean" }, "allow-destructive": { type: "boolean" } },
  });
  const root = resolve(positionals[0] ?? ".");
  const dryRun = values["dry-run"] === true;
  try {
    const plan = await migrateProject(root, {
      compiler: findCompiler(root),
      dryRun,
      destructive: values["allow-destructive"] === true,
    });
    console.log(`[weft] ${plan.database}`);
    if (plan.steps.length === 0) {
      console.log("  up to date");
    } else {
      console.log(dryRun ? "  would run:" : "  applied:");
      for (const s of plan.steps) console.log(`    ${s.sql};`);
    }
    for (const w of plan.warnings) console.warn(`  warning: ${w}`);
  } catch (err) {
    if (err instanceof CompileError) {
      console.error(err.diagnostics);
    } else if (err instanceof MigrateError || err instanceof ProjectError || err instanceof ConfigError) {
      console.error(`[weft] ${err.message}`);
    } else {
      console.error("[weft] migrate:", err instanceof Error ? err.message : err);
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
