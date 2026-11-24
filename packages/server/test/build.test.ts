import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BuildError, build, versionAssets, versionImports } from "../src/build.ts";
import { findCompiler } from "../src/compiler.ts";
import { startProduction } from "../src/production.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const work = join(here, ".weft", "build");
const ORIGIN = "http://prod.test";
const SECRET = "build-test-secret-0123456789abcdef!";

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("browser modules are versioned as one set", () => {
  assert.equal(
    versionImports(`import { a } from "/_weft/rt/index.js";\nimport("/_weft/islands/x.js");\nimport "./rel.js";`, "/_weft/v1/"),
    `import { a } from "/_weft/v1/rt/index.js";\nimport("/_weft/v1/islands/x.js");\nimport "./rel.js";`,
  );
  const a = versionAssets({ "/_weft/client.js": `import "./rt/boot.js";`, "/_weft/rt/boot.js": "x" });
  const b = versionAssets({ "/_weft/client.js": `import "./rt/boot.js";`, "/_weft/rt/boot.js": "y" });
  assert.match(a.buildId, /^[0-9a-f]{12}$/);
  assert.notEqual(a.buildId, b.buildId, "any module change versions every module");
  assert.deepEqual(Object.keys(a.assets).sort(), [`/_weft/${a.buildId}/client.js`, `/_weft/${a.buildId}/rt/boot.js`]);
});

test("a built project is served from dist alone", { skip: !hasCargo() }, async () => {
  const root = join(work, "shop");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "new", root, "--minimal"], { cwd: repo, stdio: "pipe" });
  writeFileSync(join(root, "weft.config.ts"), `export default { database: "data/app.db" }\n`);
  mkdirSync(join(root, "src", "models"), { recursive: true });
  writeFileSync(
    join(root, "src", "models", "Item.ts"),
    `import { defineModel } from "@weft-framework/data"\n` +
      `interface Item { id: string }\n` +
      `export const Item = defineModel<Item>("Item", { fields: { id: "string" }, read: () => true, write: () => true })\n`,
  );

  const m = await build(root, { compiler: findCompiler(repo) });
  assert.deepEqual(m.routes, ["/", "/about", "/blog", "/blog/[slug]"]);
  assert.deepEqual(m.models, ["Item"]);
  assert.equal(m.clientEntry, `/_weft/${m.buildId}/client.js`);
  const dist = join(root, "dist");
  for (const f of ["manifest.json", "server.mjs", "server/pages/index.ts", "server/index.html", `client/_weft/${m.buildId}/client.js`]) {
    assert.ok(existsSync(join(dist, f)), f);
  }
  const contract = JSON.parse(readFileSync(join(dist, "openapi.json"), "utf8"));
  assert.equal(contract.openapi, "3.1.0");
  assert.equal(contract.info.title, "shop");
  assert.equal(contract.components.schemas.Item["x-weft-key"], "id");
  const data = JSON.parse(readFileSync(join(dist, "data-manifest.json"), "utf8"));
  assert.deepEqual(data.models.Item, { readBy: [], writtenBy: [] }, "no page touches Item");
  assert.deepEqual(Object.keys(data.routes).sort(), m.routes);
  assert.deepEqual(data.routes["/"].reads, []);
  assert.ok("/about" in m.edge.static, JSON.stringify(m.edge));
  const about = readFileSync(join(dist, "edge", m.edge.static["/about"]!), "utf8");
  assert.ok(about.includes("<h1>About</h1>") && !about.includes("weft-csrf") && !about.includes("nonce="), about);
  assert.ok(m.edge.origin["/"], "the counter page is live");
  assert.equal(m.edge.origin["/blog/[slug]"], "load");
  const split = JSON.parse(readFileSync(join(dist, "edge", "routes.json"), "utf8"));
  assert.equal(split.immutable, `/_weft/${m.buildId}/`);
  const pages = Object.keys(split.static).filter((p) => m.routes.includes(p));
  assert.equal(split.static["/robots.txt"], "robots.txt", "public files too");
  assert.deepEqual([...pages, ...split.cacheable, ...Object.keys(split.origin)].sort(), m.routes, "every route placed once");
  for (const [path, file] of Object.entries(split.static as Record<string, string>)) {
    assert.ok(existsSync(join(dist, "edge", file)), path);
  }
  const index = readFileSync(join(dist, "client", "_weft", m.buildId, "rt", "index.js"), "utf8");
  assert.ok(!index.includes(".ts\""), "browser modules import .js");

  await assert.rejects(startProduction(dist, { listen: false, env: {} }), /production requires a session secret/);

  const server = await startProduction(dist, { listen: false, env: { WEFT_SECRET: SECRET } });
  try {
    const home = await server.app.fetch(new Request(ORIGIN + "/"));
    const html = await home!.text();
    assert.equal(home!.status, 200);
    assert.ok(html.includes(`src="${m.clientEntry}"`), html);
    const shared = (await server.app.fetch(new Request(ORIGIN + "/about")))!;
    assert.equal(await shared.text(), about, "the origin serves what the CDN holds");
    assert.match(shared.headers.get("cache-control")!, /^public, max-age=0, s-maxage=\d+/);
    const entry = await server.app.fetch(new Request(ORIGIN + m.clientEntry));
    assert.equal(entry!.status, 200);
    assert.match(entry!.headers.get("cache-control") ?? "", /immutable/);
    const old = await server.app.fetch(new Request(ORIGIN + "/_weft/client.js"));
    assert.equal(old!.status, 404, "only the versioned paths exist");
    assert.ok(existsSync(join(root, "data", "app.db")), "models live in the configured database");
  } finally {
    await server.close();
  }

  await build(root, { compiler: findCompiler(repo) });
  writeFileSync(join(root, "notes.txt"), "keep");
  mkdirSync(join(root, "elsewhere"));
  writeFileSync(join(root, "elsewhere", "keep.txt"), "keep");
  await assert.rejects(build(root, { compiler: findCompiler(repo), out: join(root, "elsewhere") }), BuildError);
  await assert.rejects(build(root, { compiler: findCompiler(repo), out: root }), BuildError);
  await assert.rejects(build(root, { compiler: findCompiler(repo), out: join(root, "src", "out") }), BuildError);
  assert.ok(existsSync(join(root, "elsewhere", "keep.txt")));
});

test("a build needs neither the database nor runtime secrets", { skip: !hasCargo() }, async () => {
  const root = join(work, "nodb");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "new", root, "--minimal"], { cwd: repo, stdio: "pipe" });
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(
    join(root, "src", "lib", "db.ts"),
    `import { defineModel } from "@weft-framework/data"\n` +
      `import { openPostgres, usePostgres } from "@weft-framework/data/postgres"\n` +
      `import { secretEnv } from "@weft-framework/server"\n` +
      `export const key = secretEnv("NODB_TEST_SIGNING_KEY", { minLength: 32 })\n` +
      `export const Note = defineModel<{ id: string }>("Note", { fields: { id: "string" }, read: () => true, write: () => true })\n` +
      `export const pool = await openPostgres("pglite:./data/never/created")\n` +
      `await usePostgres(pool, [Note as never])\n`,
  );
  writeFileSync(join(root, "src", "pages", "notes.wx"), `import { key } from "../lib/db.ts"\nexport function load() { return { n: key.name } }\ncomponent Page(n: string) { view { <p>{n}</p> } }\n`);
  const m = await build(root, { compiler: findCompiler(repo) });
  assert.ok(m.routes.includes("/notes"));
  assert.equal(existsSync(join(root, "data", "never")), false);
  assert.equal(process.env.WEFT_PHASE, undefined);
});
