import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { islandAssets } from "../src/assets.ts";
import { browserModules, NpmError } from "../src/npm.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "weft-npm-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

const pkg = (o: object) => JSON.stringify(o);

const PROJECT = {
  "node_modules/cond/package.json": pkg({
    name: "cond",
    version: "1.2.3",
    exports: {
      ".": { node: "./node.js", browser: "./browser.js", default: "./index.js" },
      "./feature/*": "./features/*.js",
      "./private/*": null,
    },
  }),
  "node_modules/cond/node.js": "export const where = 'node';\n",
  "node_modules/cond/index.js": "export const where = 'default';\n",
  "node_modules/cond/browser.js":
    "import { greet } from 'old-cjs';\nimport util from './util';\nexport const where = 'browser';\nexport const msg = greet(util.name);\n",
  "node_modules/cond/util.js": "export default { name: 'weft' };\n",
  "node_modules/cond/features/a.js": "export const a = 'feature a';\n",
  "node_modules/old-cjs/package.json": pkg({ name: "old-cjs", version: "0.1.0", main: "lib/index" }),
  "node_modules/old-cjs/lib/index.js":
    "const data = require('./data.json');\nconst fs = require('fs');\n" +
    "exports.greet = function (n) { return data.hello + ', ' + n + (process.env.NODE_ENV === 'production' ? '' : ' (dev)'); };\n" +
    "exports.hasFs = typeof fs.readFileSync;\n",
  "node_modules/old-cjs/lib/data.json": '{ "hello": "hi" }',
  "node_modules/@s/mod/package.json": pkg({
    name: "@s/mod",
    version: "2.0.0",
    main: "cjs.js",
    module: "esm.js",
    browser: { "./esm.js": "./esm.browser.js" },
  }),
  "node_modules/@s/mod/esm.js": "export default 'server esm';\n",
  "node_modules/@s/mod/esm.browser.js": "export default 'browser esm';\n",
  "node_modules/whole/package.json": pkg({ name: "whole", version: "1.0.0" }),
  "node_modules/whole/index.js": "module.exports = function whole() { return 42; };\nmodule.exports.extra = 1;\n",
  "src/pages/util.ts": "export const twice = (n: number): number => n * 2;\n",
};

async function run(assets: Record<string, string>, entry: string): Promise<Record<string, unknown>> {
  const out = mkdtempSync(join(tmpdir(), "weft-npm-run-"));
  const base = pathToFileURL(out).href;
  for (const [url, js] of Object.entries(assets)) {
    const p = join(out, decodeURI(url));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p.replace(/\.js$/, ".mjs"), js.replace(/(["'])\/_weft\/([^"']*?)\.js\1/g, `$1${base}/_weft/$2.mjs$1`));
  }
  try {
    return (await import(`${base}${entry.replace(/\.js$/, ".mjs")}`)) as Record<string, unknown>;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test("packages resolve with browser conditions and run as ES modules", async () => {
  const root = tree(PROJECT);
  try {
    const island =
      `import { where, msg } from "cond";\nimport { a } from "cond/feature/a";\nimport mod from "@s/mod";\n` +
      `import whole, { extra } from "whole";\nimport { greet, hasFs } from "old-cjs";\nimport { twice } from "./util.ts";\n` +
      `export const out = { where, msg, a, mod, whole: whole(), extra, hasFs, twice: twice(21), greet: greet("x") };\n`;
    const src = join(root, "src");
    const { modules, assets } = browserModules(
      { "/_weft/islands/pages/X.js": { js: island, dir: join(src, "pages") } },
      { root: src },
    );
    const js = modules["/_weft/islands/pages/X.js"];
    assert.match(js, /from "\/_weft\/npm\/cond@1\.2\.3\/browser\.js"/);
    assert.match(js, /from "\/_weft\/npm\/@s\/mod@2\.0\.0\/esm\.browser\.js"/);
    assert.match(js, /from "\/_weft\/local\/pages\/util\.js"/);
    assert.ok(!Object.keys(assets).some((u) => u.includes("node.js")), "the node condition is not taken");
    const mod = await run({ ...assets, "/_weft/islands/pages/X.js": js }, "/_weft/islands/pages/X.js");
    assert.deepEqual(mod.out, {
      where: "browser",
      msg: "hi, weft (dev)",
      a: "feature a",
      mod: "browser esm",
      whole: 42,
      extra: 1,
      hasFs: "undefined",
      twice: 42,
      greet: "hi, x (dev)",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production mode replaces NODE_ENV", async () => {
  const root = tree(PROJECT);
  try {
    const src = join(root, "src");
    const { modules, assets } = browserModules(
      { "/_weft/islands/Y.js": { js: `import { greet } from "old-cjs";\nexport const g = greet("p");\n`, dir: src } },
      { root: src, mode: "production" },
    );
    const mod = await run({ ...assets, ...modules }, "/_weft/islands/Y.js");
    assert.equal(mod.g, "hi, p");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("island code gets clear errors; package internals only warnings", () => {
  const root = tree(PROJECT);
  try {
    const src = join(root, "src");
    const one = (js: string) => browserModules({ "/_weft/islands/Z.js": { js, dir: src } }, { root: src });
    assert.throws(() => one(`import x from "missing-pkg";`), /cannot resolve `missing-pkg`.*npm install missing-pkg/);
    assert.throws(() => one(`import fs from "node:fs";`), NpmError);
    assert.throws(() => one(`import x from "cond/private/x";`), /cannot resolve/);
    assert.throws(() => one(`import x from "./nope.ts";`), /cannot find/);
    const warnings: string[] = [];
    writeFileSync(join(root, "node_modules/cond/util.js"), "import 'not-installed';\nexport default { name: 'w' };\n");
    browserModules(
      { "/_weft/islands/Z.js": { js: `import { where } from "cond";`, dir: src } },
      { root: src, onWarn: (m) => warnings.push(m) },
    );
    assert.ok(warnings.some((w) => w.includes("not-installed")), warnings.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("islandAssets resolves client imports from each module's directory", () => {
  const root = tree(PROJECT);
  try {
    const client = `import { defineIsland } from "@weft/runtime";\nimport { twice } from "./util.ts";\nexport const islands = {};\n`;
    const out = islandAssets({ "pages/X.client.ts": client }, { root: join(root, "src") });
    assert.match(out["/_weft/islands/pages/X.js"], /from "\/_weft\/rt\/index\.js"/);
    assert.match(out["/_weft/islands/pages/X.js"], /from "\/_weft\/local\/pages\/util\.js"/);
    assert.match(out["/_weft/local/pages/util.js"], /export const twice = \(n\s*\)\s*=> n \* 2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
