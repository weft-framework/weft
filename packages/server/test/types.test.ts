import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");
const hasCargo = (() => {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const TSCONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    skipLibCheck: true,
  },
  include: ["out/*.ts"],
};

function project(name: string, files: Record<string, string>): string {
  const dir = join(here, ".weft", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const [f, src] of Object.entries(files)) {
    writeFileSync(join(dir, "src", f), src);
  }
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG));
  execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "compile", join(dir, "src"), "--out", join(dir, "out")], {
    cwd: repo,
    stdio: "pipe",
  });
  return dir;
}

function typecheck(dir: string): string {
  const r = spawnSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
  return (r.stdout + r.stderr).trim();
}

const LIST = [
  "component List<T extends { id: string }>(items: T[], label: (item: T) => string) {",
  "  view {",
  "    <ul>{#each items as item}<li>{label(item)}</li>{/each}</ul>",
  "  }",
  "}",
  "",
].join("\n");

const page = (label: string) =>
  [
    'import { List } from "./List.wx"',
    "",
    "interface User { id: string; name: string }",
    'const users: User[] = [{ id: "1", name: "Ada <3" }]',
    "",
    "component Page() {",
    "  view {",
    `    <List items={users} label={${label}} />`,
    "  }",
    "}",
    "",
  ].join("\n");

test("generic components infer their type arguments per call site", { skip: !hasCargo }, async () => {
  const dir = project("generic-ok", { "List.wx": LIST, "Page.wx": page("(u) => u.name") });
  assert.equal(typecheck(dir), "");
  const lowered = readFileSync(join(dir, "out", "List.ts"), "utf8");
  assert.match(lowered, /defineComponent<never>\("List", <T extends \{ id: string \}>/);

  const { Page } = (await import(pathToFileURL(join(dir, "out", "Page.ts")).href)) as {
    Page: (p: Record<string, never>) => string;
  };
  assert.equal(Page({}), "<ul><li>Ada &lt;3</li></ul>");
});

test("a misuse of the inferred type is a type error", { skip: !hasCargo }, () => {
  const typo = project("generic-typo", { "List.wx": LIST, "Page.wx": page("(u) => u.nmae") });
  assert.match(typecheck(typo), /Property 'nmae' does not exist on type 'User'/);

  const bad = page("(u) => u.name").replace('{ id: "1", name: "Ada <3" }', '{ name: "Ada" }').replace("id: string; name", "name");
  const unconstrained = project("generic-constraint", { "List.wx": LIST, "Page.wx": bad });
  assert.match(typecheck(unconstrained), /id/);
});

const CARD = [
  "component Card(header: Html, footer?: Html, children?: Html) {",
  "  view {",
  "    <section><h2>{header}</h2>{children}<small>{footer}</small></section>",
  "  }",
  "}",
  "",
].join("\n");

test("named slots are typed Html props and render escaped once", { skip: !hasCargo }, async () => {
  const dir = project("slots", {
    "Card.wx": CARD,
    "Page.wx": [
      'import { Card } from "./Card.wx"',
      "",
      "component Page(name: string) {",
      "  view {",
      "    <Card>",
      '      <template slot="header">Hi {name}</template>',
      "      <p>body</p>",
      "    </Card>",
      "  }",
      "}",
      "",
    ].join("\n"),
  });
  assert.equal(typecheck(dir), "");
  const { Page } = (await import(pathToFileURL(join(dir, "out", "Page.ts")).href)) as {
    Page: (p: { name: string }) => string;
  };
  assert.equal(Page({ name: "<b>" }), "<section><h2>Hi &lt;b&gt;</h2><p>body</p><small></small></section>");
});

test("compiled output carries a source map back to the .wx file", { skip: !hasCargo }, () => {
  const dir = project("sourcemap", {
    "Boom.wx": [
      "function explode(): string {",
      '  throw new Error("boom")',
      "}",
      "",
      "component Boom() {",
      "  view {",
      "    <p>{explode()}</p>",
      "  }",
      "}",
      "",
    ].join("\n"),
  });
  const out = readFileSync(join(dir, "out", "Boom.ts"), "utf8");
  assert.match(out, /\/\/# sourceMappingURL=Boom\.ts\.map\n$/);
  const map = JSON.parse(readFileSync(join(dir, "out", "Boom.ts.map"), "utf8"));
  assert.equal(map.version, 3);
  assert.deepEqual(map.sources, ["../src/Boom.wx"], "relative, never absolute");
  assert.ok(map.sourcesContent[0].includes("component Boom"));

  const run = spawnSync(
    process.execPath,
    [
      "--enable-source-maps",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import { Boom } from ${JSON.stringify(pathToFileURL(join(dir, "out", "Boom.ts")).href)};
       try { Boom({}); } catch (e) { console.log(e.stack); }`,
    ],
    { encoding: "utf8" },
  );
  assert.match(run.stdout, /Boom\.wx:2:\d+/, run.stdout + run.stderr);
  assert.match(run.stdout, /Boom\.wx:7:\d+/, run.stdout + run.stderr);
});

test("weft check <dir> reports TypeScript errors at their .wx position", { skip: !hasCargo }, () => {
  const card = [
    "interface User { name: string }",
    "",
    "component Card(user: User) {",
    "  view {",
    "    <p>Hi {user.nmae}</p>",
    "  }",
    "}",
    "",
  ].join("\n");
  const dir = project("check-types", { "Card.wx": card });
  const run = (d: string) =>
    spawnSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "check", d], { cwd: repo, encoding: "utf8" });
  const bad = run(dir);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /src\/Card\.wx:5:17: error: Property 'nmae' does not exist on type 'User'\. \(TS2339\)/, bad.stderr);

  const good = project("check-types-ok", { "Card.wx": card.replace("nmae", "name") });
  const ok = run(good);
  assert.equal(ok.status, 0, ok.stderr);
});

test("type errors inside a model map to the field or rule that caused them", { skip: !hasCargo }, () => {
  const dir = project("check-model", {
    "Doc.wx": [
      "interface User { id: string }",
      "",
      "model Doc {",
      "  id: string",
      "  owner: Usr",
      "  @read(actor.id == owner.nmae)",
      "}",
      "",
    ].join("\n"),
  });
  const r = spawnSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "check", dir], { cwd: repo, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /src\/Doc\.wx:5:10: error: Cannot find name 'Usr'/, r.stderr);
  const fixed = project("check-model-2", {
    "Doc.wx": readFileSync(join(dir, "src", "Doc.wx"), "utf8").replace("Usr", "User"),
  });
  const r2 = spawnSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "check", fixed], { cwd: repo, encoding: "utf8" });
  assert.match(r2.stderr, /src\/Doc\.wx:6:27: error: Property 'nmae' does not exist on type 'User'/, r2.stderr);
});

test("a registered actor type checks every access rule", { skip: !hasCargo }, () => {
  const doc = [
    "interface User { id: string }",
    "",
    "model Doc {",
    "  id: string",
    "  owner: User",
    "  @read(actor.id == owner.id)",
    "}",
    "",
  ].join("\n");
  const run = (d: string) =>
    spawnSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "check", d], { cwd: repo, encoding: "utf8" });
  const open = project("actor-open", { "Doc.wx": doc });
  assert.equal(run(open).status, 0, run(open).stderr);
  const typed = project("actor-typed", {
    "Doc.wx": doc,
    "actor.ts": 'declare module "@weft/data" {\n  interface Register { actor: { id: number } }\n}\nexport {};\n',
  });
  const r = run(typed);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /src\/Doc\.wx:6:9: error: This comparison appears to be unintentional/, r.stderr);
});
