import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSqlite } from "@weft/data/sqlite";
import { findCompiler } from "../src/compiler.ts";
import { MigrateError, migrateProject } from "../src/migrate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const work = join(here, ".weft", "migrate");

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function model(fields: string, attrs = ""): string {
  return (
    `import { defineModel } from "@weft/data"\n` +
    `export const Note = defineModel<any>("Note", { fields: { ${fields} }, ${attrs} read: () => true, write: () => true })\n`
  );
}

test("weft migrate plans, applies and waits for --allow-destructive", { skip: !hasCargo() }, async () => {
  const root = join(work, "notes");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "new", root, "--minimal"], { cwd: repo, stdio: "pipe" });
  const compiler = findCompiler(repo);
  const modelFile = join(root, "src", "models", "Note.ts");
  mkdirSync(dirname(modelFile), { recursive: true });

  await assert.rejects(migrateProject(root, { compiler }), MigrateError, "no database configured");

  writeFileSync(join(root, "weft.config.ts"), `export default { database: "data/app.db" }\n`);
  writeFileSync(modelFile, model(`id: "string", title: "string", stars: "string"`));
  const dry = await migrateProject(root, { compiler, dryRun: true });
  assert.equal(dry.steps.length, 1);
  assert.match(dry.steps[0].sql, /^CREATE TABLE "Note"/);
  const first = await migrateProject(root, { compiler });
  assert.deepEqual(first.steps, dry.steps);
  const db = () => openSqlite(join(root, "data", "app.db"));
  {
    const d = db();
    d.exec(`INSERT INTO "Note" VALUES ('n1', 'Hi', '3')`);
    d.close();
  }

  writeFileSync(modelFile, model(`id: "string", heading: "string", stars: "number"`, `attrs: { heading: { renamed: "title" } },`));
  const safe = await migrateProject(root, { compiler });
  assert.deepEqual(safe.steps.map((s) => s.sql), [`ALTER TABLE "Note" RENAME COLUMN "title" TO "heading"`]);
  assert.deepEqual(safe.warnings, [
    "Note.stars: column is TEXT, model needs REAL (`weft migrate --allow-destructive` converts it)",
  ]);
  const forced = await migrateProject(root, { compiler, destructive: true });
  assert.deepEqual(forced.rebuilt, ["Note"]);
  const d = db();
  assert.deepEqual({ ...(d.prepare(`SELECT * FROM "Note"`).all()[0] as object) }, { id: "n1", heading: "Hi", stars: 3 });
  const history = d.prepare(`SELECT count(*) AS n FROM _weft_migrations`).all()[0] as { n: number };
  assert.equal(Number(history.n), 1 + 1 + forced.steps.length);
  d.close();
});
