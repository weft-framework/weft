import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findCompiler } from "../src/compiler.ts";
import { RulesDiffError, diffProjectRules } from "../src/rules-diff.ts";
import { RulesTestError, testRules } from "../src/rules-test.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const work = join(here, ".weft", "rules");

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const NOTE = `model Note {
  id: string
  owner: string
  shared: boolean
  body: string
  @read(owner == actor.id || shared)
  @write(owner == actor.id)
}
`;

const NARROW = `import { defineModel } from "@weft/data";
export const Narrow = defineModel<{ id: string; owner: string; shared: boolean }>("Narrow", {
  fields: { id: "string", owner: "string", shared: "boolean" },
  read: (a, r) => r.owner === a?.id || r.shared,
  write: (a, r) => r.owner === a?.id,
  readWhere: { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } },
  writeWhere: { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } },
});
`;

test("weft test rules passes sound rules and fails a narrower SQL form", { skip: !hasCargo() }, async () => {
  const root = join(work, "app");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "new", root, "--minimal"], { cwd: repo, stdio: "pipe" });
  mkdirSync(join(root, "src", "models"), { recursive: true });
  writeFileSync(join(root, "src", "models", "Note.wx"), NOTE);
  const compiler = findCompiler(repo);

  const sound = await testRules(root, { compiler, model: "Note", runs: 20 });
  assert.equal(sound.ok, true, sound.text);
  assert.match(sound.text, /^Model Note: \d+ checks, read passed [1-9]\d*, write passed [1-9]\d*: ok\n$/);
  await assert.rejects(testRules(root, { compiler, model: "Nope" }), RulesTestError);

  writeFileSync(join(root, "src", "models", "Narrow.ts"), NARROW);
  const narrow = await testRules(root, { compiler, runs: 20 });
  assert.equal(narrow.ok, false);
  assert.match(narrow.text, /Model Narrow: .*: FAILED\n {2}error \(missing, read, sql\): all\(\) left out a row the read rule allows/);
  assert.match(narrow.text, /\n {4}row: {3}\{"id":"k\d+","owner":"[^"]*","shared":true\}/);
  assert.match(narrow.text, /Model Note: .*: ok/);

  const cli = spawnSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "test", "rules", root, "--runs", "10"], { cwd: repo, encoding: "utf8" });
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stdout, /Model Narrow: .*FAILED/);
  const bad = spawnSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "test", "rules", root, "--runs", "0"], { cwd: repo, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--runs is a whole number/);
  rmSync(root, { recursive: true, force: true });
});

test("weft rules diff reports widened and narrowed access against a git revision", { skip: !hasCargo() }, async () => {
  const root = join(work, "diff");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "new", root, "--minimal"], { cwd: repo, stdio: "pipe" });
  mkdirSync(join(root, "src", "models"), { recursive: true });
  writeFileSync(join(root, "src", "models", "Note.wx"), NOTE);
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, stdio: "pipe" });
  g("init", "-q");
  g("add", "-A");
  g("commit", "-q", "-m", "before");
  const compiler = findCompiler(repo);

  const same = await diffProjectRules(root, "HEAD", { compiler, runs: 20 });
  assert.equal(same.widened, false);
  assert.match(same.text, /^No rule changes against HEAD \(1 model compared\)\.\n$/);

  const wider = NOTE.replace("@read(owner == actor.id || shared)", "@read(true)").replace(
    "@write(owner == actor.id)",
    "@write(owner == actor.id && shared)",
  );
  writeFileSync(join(root, "src", "models", "Note.wx"), wider);
  writeFileSync(join(root, "src", "models", "Narrow.ts"), NARROW);
  const changed = await diffProjectRules(root, "HEAD", { compiler, runs: 20 });
  assert.equal(changed.widened, true);
  assert.match(changed.text, /Model Narrow: added; read admits [1-9]\d* of \d+ actor\/row pairs/);
  assert.match(changed.text, /Model Note: access WIDENED\n {2}read widened: now admits \d+ of \d+ actor\/row pairs, for example\n {4}actor: .*\n {4}row: {3}\{.*"shared":false/);
  assert.match(changed.text, /\n {2}write narrowed: now refuses /);
  await assert.rejects(diffProjectRules(root, "--output=x", { compiler }), RulesDiffError);
  await assert.rejects(diffProjectRules(root, "no-such-ref", { compiler }), /git rev-parse/);

  const cli = (...extra: string[]) =>
    spawnSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "rules", "diff", "HEAD", root, "--runs", "10", ...extra], { cwd: repo, encoding: "utf8" });
  assert.equal(cli().status, 0);
  const gate = cli("--fail-on-widen");
  assert.equal(gate.status, 1, gate.stderr);
  assert.match(gate.stdout, /Model Note: access WIDENED/);
  rmSync(root, { recursive: true, force: true });
});
