import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StyleError, projectStyles } from "../src/tailwind.ts";

const work = join(dirname(fileURLToPath(import.meta.url)), ".weft", "postcss");

function project(name: string, files: Record<string, string>): string {
  const root = join(work, name);
  rmSync(root, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const POSTCSS = {
  "node_modules/postcss/package.json": `{ "name": "postcss", "version": "8.0.0", "main": "index.js" }`,
  "node_modules/postcss/index.js": `module.exports = (plugins) => ({
  process: async (css, opts) => {
    for (const p of plugins) css = p.run(css, opts);
    return { css };
  },
});`,
  "node_modules/upper-colors/package.json": `{ "name": "upper-colors", "main": "index.js" }`,
  "node_modules/upper-colors/index.js": `module.exports = (opts) => ({
  postcssPlugin: "upper-colors",
  run: (css) => css.replace(/red/g, opts.to || "RED"),
});`,
  "node_modules/@tailwindcss/postcss/package.json": `{ "name": "@tailwindcss/postcss", "main": "index.js" }`,
  "node_modules/@tailwindcss/postcss/index.js": `module.exports = () => { throw new Error("must not run"); };`,
  "package.json": `{ "name": "p", "type": "module" }`,
};

test("postcss: the project's plugins run over app.css and component sheets", async () => {
  const root = project("object", {
    ...POSTCSS,
    "postcss.config.js": `export default { plugins: { "@tailwindcss/postcss": {}, "upper-colors": { to: "crimson" }, off: false } };`,
    "src/app.css": "body { color: red }",
  });
  const sheet = ".a:where(.S){color:red}";
  const out = await projectStyles(root, [sheet]);
  assert.equal(out.global, "body { color: crimson }");
  assert.equal(out.components[sheet], ".a:where(.S){color:crimson}");
});

test("postcss: array and function configs; no config, no pass", async () => {
  const root = project("array", {
    ...POSTCSS,
    "postcss.config.mjs": `import up from "upper-colors";
export default (ctx) => ({ plugins: [up({ to: ctx.env }), null] });`,
    "src/app.css": "p { color: red }",
  });
  assert.equal((await projectStyles(root, [])).global, "p { color: development }");
  assert.equal((await projectStyles(root, [], { minify: true })).global, "p { color: production }");

  const plain = project("none", { ...POSTCSS, "src/app.css": "p { color: red }" });
  assert.deepEqual(await projectStyles(plain, [".x{color:red}"]), { global: "p { color: red }", components: {} });
});

test("postcss: a missing postcss or plugin is named", async () => {
  const lone = project("lone", {
    "package.json": `{ "name": "p", "type": "module" }`,
    "postcss.config.js": `export default { plugins: { autoprefixer: {} } };`,
  });
  await assert.rejects(projectStyles(lone, []), (e: unknown) => e instanceof StyleError && /npm install -D postcss/.test(String(e)));
  const noPlugin = project("noplugin", { ...POSTCSS, "postcss.config.js": `export default { plugins: { autoprefixer: {} } };` });
  await assert.rejects(projectStyles(noPlugin, []), /uses autoprefixer, but it is not installed/);
});
