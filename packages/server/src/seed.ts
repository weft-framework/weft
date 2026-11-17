import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Model } from "@weft-framework/data";
import { CompileError, findCompiler, type Compiler } from "./compiler.ts";
import { ConfigError } from "./config.ts";
import { ProjectError, loadProject } from "./project.ts";
import { ModelStorage } from "./storage.ts";

export interface SeedCommandOptions {
  compiler: Compiler;
  reset?: boolean;
  env?: Record<string, string | undefined>;
}

export class SeedError extends Error {}

export interface SeedContext {
  models: Record<string, Model<unknown>>;
}

export async function seedProject(root: string, opts: SeedCommandOptions): Promise<{ database: string; reset: boolean }> {
  root = resolve(root);
  const env = opts.env ?? process.env;
  const outDir = join(root, ".weft", "seed", randomUUID());
  const storage = new ModelStorage();
  try {
    const project = await loadProject(root, { compiler: opts.compiler, outDir, browserAssets: false, cacheKey: outDir });
    const database = project.database;
    if (database === undefined || database === ":memory:") {
      throw new SeedError("no `database` file in weft.config.ts; rows kept in memory would vanish when this command ends");
    }
    const file = ["seed.ts", "seed.js"].map((name) => join(outDir, name)).find((f) => existsSync(f));
    if (!file) {
      throw new SeedError("no src/seed.ts; export `seed()` from it");
    }
    if (opts.reset) {
      if (env.NODE_ENV === "production") {
        throw new SeedError("refusing to reset with NODE_ENV=production");
      }
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        rmSync(database + suffix, { force: true });
      }
    }
    await storage.attach(Object.values(project.models) as Model<unknown>[], { database });
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const seed = mod.seed ?? mod.default;
    if (typeof seed !== "function") {
      throw new SeedError("src/seed: export a function `seed()`");
    }
    await (seed as (ctx: SeedContext) => unknown)({ models: project.models });
    return { database, reset: opts.reset === true };
  } finally {
    storage.close();
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { reset: { type: "boolean" }, yes: { type: "boolean" } },
  });
  const root = resolve(positionals[0] ?? ".");
  const reset = values.reset === true;
  try {
    if (reset && values.yes !== true) {
      throw new SeedError("`weft db reset` deletes the database; run it again with --yes");
    }
    const done = await seedProject(root, { compiler: findCompiler(root), reset });
    console.log(`[weft] ${done.reset ? "reset and seeded" : "seeded"} ${done.database}`);
  } catch (err) {
    if (err instanceof CompileError) {
      console.error(err.diagnostics);
    } else if (err instanceof SeedError || err instanceof ProjectError || err instanceof ConfigError) {
      console.error(`[weft] ${err.message}`);
    } else {
      console.error("[weft] seed:", err instanceof Error ? (err.stack ?? err.message) : err);
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
