import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSqlite } from "@weft/data/sqlite";
import { findCompiler } from "../src/compiler.ts";
import { parsePlan, PersonalDataError, personalDataCommand } from "../src/personal-data.ts";
import { seedProject } from "../src/seed.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const work = join(here, ".weft", "personal");

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("--plan parsing", () => {
  assert.deepEqual(parsePlan("Task=delete, Comment=keep"), { Task: "delete", Comment: "keep" });
  assert.deepEqual(parsePlan(undefined), {});
  assert.throws(() => parsePlan("Task=burn"), PersonalDataError);
  assert.throws(() => parsePlan("Task"), PersonalDataError);
  assert.throws(() => parsePlan("1x=keep"), PersonalDataError);
});

test("weft data export and erase follow @ref from the person's row", { skip: !hasCargo() }, async () => {
  const root = join(work, "app");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "new", root, "--minimal"], { cwd: repo, stdio: "pipe" });
  const compiler = findCompiler(repo);
  mkdirSync(join(root, "src", "models"), { recursive: true });
  writeFileSync(
    join(root, "src", "models", "People.wx"),
    "model User {\n  id: string\n  email: string\n  @read(true)\n  @write(true)\n}\n\n" +
      "model Note {\n  id: string\n  owner: string @ref(User)\n  text: string\n  @read(true)\n  @write(true)\n}\n\n" +
      "model Task {\n  id: string\n  assignee: string | null @ref(User)\n  @read(true)\n  @write(true)\n}\n",
  );
  writeFileSync(join(root, "weft.config.ts"), `export default { database: "data/app.db" }\n`);
  writeFileSync(
    join(root, "src", "seed.ts"),
    `export async function seed({ models }: any) {\n` +
      `  const a = { id: "op" }\n` +
      `  models.User.as(a).create({ id: "ann", email: "ann@example.test" })\n` +
      `  models.User.as(a).create({ id: "bob", email: "bob@example.test" })\n` +
      `  models.Note.as(a).create({ id: "n1", owner: "ann", text: "hers" })\n` +
      `  models.Note.as(a).create({ id: "n2", owner: "bob", text: "his" })\n` +
      `  models.Task.as(a).create({ id: "t1", assignee: "ann" })\n` +
      `}\n`,
  );
  await seedProject(root, { compiler });

  const out = await personalDataCommand(root, { compiler, command: "export", key: "ann" });
  const ids = (m: string) => ((out.data.rows[m] ?? []) as { id: string }[]).map((r) => r.id).sort();
  assert.deepEqual([ids("User"), ids("Note"), ids("Task")], [["ann"], ["n1"], ["t1"]]);
  assert.equal("steps" in out.data, false, "the erase plan is not exported");

  const db = join(root, "data", "app.db");
  const rows = () => {
    const d = openSqlite(db);
    try {
      const all = (t: string) => d.prepare(`SELECT * FROM "${t}" ORDER BY id`).all() as Record<string, unknown>[];
      return { users: all("User").map((r) => r.id), notes: all("Note").map((r) => r.id), tasks: all("Task").map((r) => `${r.id}:${r.assignee}`) };
    } finally {
      d.close();
    }
  };
  const dry = await personalDataCommand(root, { compiler, command: "erase", key: "ann", dryRun: true });
  assert.equal(dry.erased, undefined);
  assert.deepEqual(dry.summary, ["clear assignee on 1 Task", "delete 1 Note", "delete 1 User"]);
  assert.deepEqual(rows(), { users: ["ann", "bob"], notes: ["n1", "n2"], tasks: ["t1:ann"] }, "a dry run changes nothing");

  const done = await personalDataCommand(root, { compiler, command: "erase", key: "ann" });
  assert.deepEqual(done.erased, { removed: { Note: 1, User: 1 }, unlinked: { Task: 1 } });
  assert.deepEqual(rows(), { users: ["bob"], notes: ["n2"], tasks: ["t1:null"] });

  await assert.rejects(personalDataCommand(root, { compiler, command: "export", key: "ann" }), /no User with that key/);
  await assert.rejects(personalDataCommand(root, { compiler, command: "export", key: "bob", model: "Nope" }), /no model Nope/);
  await assert.rejects(personalDataCommand(root, { compiler, command: "export", key: "" }), /--key/);
  await assert.rejects(
    personalDataCommand(root, { compiler, command: "erase", key: "bob", plan: { Note: "unlink" } }),
    (e) => e instanceof PersonalDataError && /cannot be unlinked/.test(e.message),
  );
  assert.deepEqual(rows().users, ["bob"]);
  rmSync(root, { recursive: true, force: true });
});
