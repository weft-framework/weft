import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, type App } from "../src/app.ts";
import { findCompiler } from "../src/compiler.ts";
import { ProjectError, loadProject } from "../src/project.ts";
import { htmlAttributeMarkup, parseShell } from "../src/shell.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const work = join(here, ".weft", "theme");
const ORIGIN = "http://demo.test";
const SECRET = "theme-test-secret-0123456789abcdef";

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function project(name: string, files: Record<string, string>): string {
  const root = join(work, name);
  rmSync(root, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

async function get(app: App, path: string, cookie?: string) {
  const res = (await app.fetch(new Request(ORIGIN + path, cookie ? { headers: { cookie } } : {})))!;
  return { res, text: await res.text() };
}

const THEME = `import { defineTheme } from "@weft-framework/theme";

export default defineTheme({
  shared: { radius: "0.75rem" },
  themes: {
    light: { scheme: "light", tokens: { background: "#ffffff", primary: "#123456" } },
    dark: { scheme: "dark", tokens: { background: "#0b0b0b", primary: "#abcdef" } },
  },
  light: "light",
  dark: "dark",
});
`;

const PAGE = `component Page() {
  view {
    <main class="bg-background dark:text-primary rounded-lg">
      <button class="go">Go</button>
    </main>
  }
  style {
    .go { @apply bg-primary rounded-md; }
  }
}
`;

test("theme: tokens, Tailwind utilities and the dark variant from src/theme.ts", { skip: !hasCargo() }, async () => {
  const root = project("tw", { "src/app.css": '@import "tailwindcss";\n', "src/theme.ts": THEME, "src/pages/index.wx": PAGE });
  const loaded = await loadProject(root, { compiler: findCompiler(repo), outDir: join(root, ".weft", "build") });
  const app = createApp({ secret: SECRET, ...loaded, onError: () => {} });

  const page = await get(app, "/");
  assert.ok(page.text.startsWith("<!doctype html>\n<html data-theme=\"system\" lang=\"en\">"), page.text.slice(0, 80));
  const href = /href="(\/_weft\/app\.css\?v=[^"]+)"/.exec(page.text)?.[1];
  const sheet = (await get(app, href!)).text;
  assert.ok(sheet.includes(':root[data-theme="dark"]') && sheet.includes("--primary: #abcdef;"), sheet);
  assert.match(sheet, /\.bg-background \{\s*background-color: var\(--background\);/);
  assert.match(sheet, /\.rounded-lg \{\s*border-radius: var\(--radius\);/);
  assert.ok(sheet.includes('.dark\\:text-primary:where([data-theme="dark"], [data-theme="dark"] *) {\n    color: var(--primary);'), sheet);
  assert.match(sheet, /prefers-color-scheme: dark[\s\S]*data-theme="system"/, "system follows the OS");
  assert.match(page.text, /\.go:where\([^)]+\)\s*\{[^}]*background-color: var\(--primary\)/);
  assert.match(page.text, /border-radius: calc\(var\(--radius\) - 2px\)/);

  assert.ok((await get(app, "/", "weft-theme=dark")).text.includes('<html data-theme="dark" lang="en">'));
  const forged = await get(app, "/", 'weft-theme="><script>alert(1)</script>');
  assert.ok(forged.text.includes('<html data-theme="system" lang="en">'));
});

test("theme: without Tailwind the tokens are the global stylesheet", { skip: !hasCargo() }, async () => {
  const root = project("plain", {
    "src/theme.ts": THEME,
    "src/app.css": "body { background: var(--background); }\n",
    "src/pages/index.wx": "component Page() { view { <p>hi</p> } }\n",
  });
  const loaded = await loadProject(root, { compiler: findCompiler(repo), outDir: join(root, ".weft", "build") });
  assert.ok(loaded.stylesheet?.startsWith(":root {\n  --radius: 0.75rem;"), loaded.stylesheet);
  assert.ok(loaded.stylesheet?.endsWith("body { background: var(--background); }\n"), "app.css comes after, to override");
  assert.ok(!loaded.stylesheet?.includes("@theme"), "no Tailwind input in plain CSS");

  const bad = project("bad", { "src/theme.ts": "export default { css: 1 };\n", "src/pages/index.wx": "component Page() { view { <p/> } }\n" });
  await assert.rejects(
    loadProject(bad, { compiler: findCompiler(repo), outDir: join(bad, ".weft", "build") }),
    (e: unknown) => e instanceof ProjectError && /src\/theme/.test(e.message),
  );
});

test("htmlAttributes: names are checked, values escaped, the shell keeps lang", () => {
  assert.equal(htmlAttributeMarkup({ "data-theme": 'a"b', dir: "rtl", hidden: true, off: false, x: undefined }), ' data-theme="a&quot;b" dir="rtl" hidden');
  for (const name of ["onload", "a b", "x\"y", "Data-X"]) {
    assert.throws(() => htmlAttributeMarkup({ [name]: "1" }), /refused attribute name/, name);
  }
  assert.equal(htmlAttributeMarkup({ lang: "cs", dir: "ltr" }), ' dir="ltr"', "lang goes to the shell's %lang%");
  const shell = parseShell("<!doctype html><HTML lang=\"%lang%\"><head><!--weft:head--></head><body><!--weft:body--></body></HTML>");
  assert.equal(
    shell.render({ lang: "cs", head: "", body: "", nonce: "n", html: ' dir="ltr"' }),
    '<!doctype html><HTML dir="ltr" lang="cs"><head></head><body></body></HTML>',
  );
});
