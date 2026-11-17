import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSqlite } from "@weft/data/sqlite";
import { findCompiler } from "../src/compiler.ts";
import { SeedError, seedProject } from "../src/seed.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const work = join(here, ".weft", "seed");

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("weft db seed fills the database through the rules; reset starts over", { skip: !hasCargo() }, async () => {
  const root = join(work, "notes");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "new", root, "--minimal"], { cwd: repo, stdio: "pipe" });
  const compiler = findCompiler(repo);
  mkdirSync(join(root, "src", "models"), { recursive: true });
  writeFileSync(
    join(root, "src", "models", "Note.ts"),
    `import { defineModel } from "@weft/data"\n` +
      `export const Note = defineModel<any>("Note", { fields: { id: "string", owner: "string", title: "string" }, read: () => true, write: (a: any, n: any) => n.owner === a.id })\n`,
  );
  writeFileSync(
    join(root, "src", "factories.ts"),
    `import { defineFactory } from "@weft/data"\nimport { Note } from "./models/Note.ts"\n` +
      `export const notes = defineFactory(Note, (n: number) => ({ id: "n" + n, owner: "ada", title: "Note " + n }))\n`,
  );
  const seedFile = join(root, "src", "seed.ts");

  writeFileSync(seedFile, `export function seed() {}\n`);
  await assert.rejects(seedProject(root, { compiler }), (e) => e instanceof SeedError && /no `database`/.test(e.message));

  writeFileSync(join(root, "weft.config.ts"), `export default { database: "data/app.db" }\n`);
  rmSync(seedFile);
  await assert.rejects(seedProject(root, { compiler }), /no src\/seed\.ts/);

  writeFileSync(seedFile, `import { notes } from "./factories.ts"\nexport async function seed() { notes.createMany({ id: "ada" }, 3) }\n`);
  const db = join(root, "data", "app.db");
  const count = () => {
    const d = openSqlite(db);
    try {
      return (d.prepare(`SELECT COUNT(*) AS n FROM "Note"`).get() as { n: number }).n;
    } finally {
      d.close();
    }
  };
  assert.deepEqual(await seedProject(root, { compiler }), { database: db, reset: false });
  assert.equal(count(), 3);
  await assert.rejects(seedProject(root, { compiler }));
  assert.equal(count(), 3);
  assert.deepEqual(await seedProject(root, { compiler, reset: true }), { database: db, reset: true });
  assert.equal(count(), 3, "reset: only the new seed's rows");

  await assert.rejects(seedProject(root, { compiler, reset: true, env: { NODE_ENV: "production" } }), /production/);
  assert.equal(count(), 3, "nothing deleted");

  writeFileSync(seedFile, `import { notes } from "./factories.ts"\nexport async function seed() { notes.create({ id: "bob" }) }\n`);
  await assert.rejects(seedProject(root, { compiler, reset: true }), /write rule refused/);

  const cli = (args: string[]) => spawnSync("cargo", ["run", "-q", "-p", "weft-cli", "--", ...args], { cwd: repo, encoding: "utf8" });
  const noYes = cli(["db", "reset", root]);
  assert.notEqual(noYes.status, 0);
  assert.match(noYes.stderr, /--yes/);
  const bad = cli(["db", "drop", root]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /expected `seed`, `reset`/);
  rmSync(root, { recursive: true, force: true });
});
