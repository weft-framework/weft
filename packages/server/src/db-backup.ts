import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { defineBackups, type BackupFile, type BackupTarget } from "./backup.ts";
import { CompileError, findCompiler, type Compiler } from "./compiler.ts";
import { ConfigError } from "./config.ts";
import { ProjectError, loadProject } from "./project.ts";

export class BackupCommandError extends Error {}

export type BackupCommand =
  | { command: "backup" }
  | { command: "list" }
  | { command: "restore"; name: string; env?: Record<string, string | undefined> };

export type BackupCommandResult =
  | { command: "backup"; database: string; file: BackupFile }
  | { command: "list"; database: string; files: BackupFile[] }
  | { command: "restore"; database: string; previous: string | null };

export async function backupProject(root: string, compiler: Compiler, cmd: BackupCommand): Promise<BackupCommandResult> {
  root = resolve(root);
  const outDir = join(root, ".weft", "backup", randomUUID());
  try {
    const project = await loadProject(root, { compiler, outDir, browserAssets: false, cacheKey: outDir });
    const database = project.database;
    if (database === undefined || database === ":memory:") {
      throw new BackupCommandError("no `database` file in weft.config.ts; there is nothing to back up");
    }
    if (/^postgres(ql)?:\/\//i.test(database) || database.startsWith("pglite:")) {
      throw new BackupCommandError("`weft db` backs up SQLite files; for Postgres use definePgBackups (pg_dump) from @weft-framework/server/backup");
    }
    const file = ["backup.ts", "backup.js"].map((name) => join(outDir, name)).find((f) => existsSync(f));
    if (!file) {
      throw new BackupCommandError("no src/backup.ts; export `target` from it (dirBackups(...) or s3Backups(...))");
    }
    const mod = (await import(pathToFileURL(file).href)) as { target?: BackupTarget; keep?: number };
    if (!mod.target || typeof mod.target.put !== "function") {
      throw new BackupCommandError("src/backup: export `target`, a dirBackups(...) or s3Backups(...)");
    }
    const backups = defineBackups({ database, target: mod.target, ...(mod.keep !== undefined ? { keep: mod.keep } : {}) });
    switch (cmd.command) {
      case "backup":
        return { command: "backup", database, file: await backups.run() };
      case "list":
        return { command: "list", database, files: await backups.list() };
      case "restore": {
        if ((cmd.env ?? process.env).NODE_ENV === "production") {
          throw new BackupCommandError("refusing to restore with NODE_ENV=production; stop the server and unset it to confirm");
        }
        return { command: "restore", database, ...(await backups.restore(cmd.name)) };
      }
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { command: { type: "string" }, name: { type: "string" }, yes: { type: "boolean" } },
  });
  const root = resolve(positionals[0] ?? ".");
  try {
    const command = values.command;
    let cmd: BackupCommand;
    if (command === "backup" || command === "list") {
      cmd = { command };
    } else if (command === "restore") {
      if (!values.name) throw new BackupCommandError("`weft db restore` needs --name <file> (see `weft db backups`)");
      if (values.yes !== true) throw new BackupCommandError("`weft db restore` replaces the database; stop the server and run it again with --yes");
      cmd = { command, name: values.name };
    } else {
      throw new BackupCommandError("expected backup, backups or restore");
    }
    const r = await backupProject(root, findCompiler(root), cmd);
    if (r.command === "backup") {
      console.log(`[weft] backed up ${r.database} as ${r.file.name} (${r.file.size} bytes)`);
    } else if (r.command === "list") {
      console.log(`[weft] backups of ${r.database}:`);
      if (r.files.length === 0) console.log("  none");
      for (const f of r.files) console.log(`  ${f.name}  ${f.size} bytes  ${new Date(f.time).toISOString()}`);
    } else {
      console.log(`[weft] restored ${r.database}${r.previous ? `; the previous database is at ${r.previous}` : ""}`);
    }
  } catch (err) {
    if (err instanceof CompileError) {
      console.error(err.diagnostics);
    } else if (err instanceof BackupCommandError || err instanceof ProjectError || err instanceof ConfigError) {
      console.error(`[weft] ${err.message}`);
    } else {
      console.error("[weft] db:", err instanceof Error ? err.message : err);
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
