// SPDX-License-Identifier: MIT
//
// The published packages: built by scripts/build-packages.mjs, installed
// into a scratch project's node_modules and used from plain Node, which
// will not strip types there - so this fails if anything published is
// still TypeScript.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackages } from "../../scripts/build-packages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = join(ROOT, "target", "npm-check");

test("the built packages run from node_modules without type stripping", () => {
  const built = buildPackages({ quiet: true });
  rmSync(APP, { recursive: true, force: true });
  for (const [name, dir] of Object.entries(built)) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.files[0], "dist");
    // Besides dist/, only hand-written browser files (theme, i18n client.js).
    for (const f of pkg.files.slice(1)) {
      assert.match(f, /^[\w-]+\.(js|d\.ts)$/, `${name}: ${f}`);
    }
    for (const target of Object.values(pkg.exports)) {
      const extra = pkg.files.includes(target.default.slice(2));
      assert.match(target.default, extra ? /^\.\/[\w-]+\.js$/ : /^\.\/dist\/.+\.js$/);
      assert.match(target.types, extra ? /^\.\/[\w-]+\.d\.ts$/ : /^\.\/dist\/.+\.d\.ts$/);
    }
    cpSync(dir, join(APP, "node_modules", ...name.split("/")), { recursive: true });
  }
  mkdirSync(APP, { recursive: true });
  writeFileSync(join(APP, "package.json"), '{ "name": "npm-check", "private": true, "type": "module" }\n');
  writeFileSync(
    join(APP, "check.mjs"),
    `import { defineComponent, escapeHtml } from "@weft/runtime";
import { createApp } from "@weft/server";
import { edgeHandler } from "@weft/server/edge";
import "@weft/server/node";
import { defineModel } from "@weft/data";
import { runtimeAssets } from "./node_modules/@weft/server/dist/assets.js";

const Hello = defineComponent("Hello", () => ({ handlers: {}, render: () => "<p>" + escapeHtml("hi <you>") + "</p>" }));
const app = createApp({ secret: "x".repeat(40), sync: false, routes: { "/": { component: Hello } } });
const html = await (await app.fetch(new Request("http://t/"))).text();
const edge = await (await edgeHandler({ secret: "x".repeat(40), routes: { "/": { component: Hello } } })(new Request("http://t/"))).text();
defineModel("Thing", { fields: { id: "string" }, read: () => true, write: () => true });
const assets = runtimeAssets();
console.log(JSON.stringify({
  page: html.includes("<p>hi &lt;you&gt;</p>"),
  edge: edge.includes("weft-csrf") && !edge.includes("weft-live"),
  client: "/_weft/client.js" in assets && "/_weft/rt/boot.js" in assets,
  plainJs: !/\bimport type\b/.test(assets["/_weft/rt/boot.js"]),
}));
app.close();
`,
  );
  // --no-experimental-strip-types: a stray .ts anywhere would fail to load.
  const out = execFileSync(process.execPath, ["--no-experimental-strip-types", "check.mjs"], { cwd: APP, encoding: "utf8" });
  assert.deepEqual(JSON.parse(out.trim().split("\n").pop()), { page: true, edge: true, client: true, plainJs: true });
  rmSync(APP, { recursive: true, force: true });
});
