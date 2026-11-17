import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, type App } from "../src/app.ts";
import { build } from "../src/build.ts";
import { startProduction } from "../src/production.ts";
import { findCompiler } from "../src/compiler.ts";
import { ProjectError, loadProject } from "../src/project.ts";
import { StyleError, projectStyles } from "../src/tailwind.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const work = join(here, ".weft", "tailwind");
const ORIGIN = "http://demo.test";
const SECRET = "tailwind-test-secret-0123456789abcdef";

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

async function get(app: App, path: string) {
  const res = (await app.fetch(new Request(ORIGIN + path)))!;
  return { res, text: await res.text() };
}

const PAGE = `component Page() {
  view {
    <main class="mx-auto max-w-2xl p-6">
      <h1 class="text-3xl font-bold text-brand">Hello</h1>
      <button class="btn">Go</button>
    </main>
  }
  style {
    .btn { @apply rounded-md px-4 py-2 bg-brand; color: theme(--color-white); @variant hover { @apply opacity-80 } }
    @variant md { .btn { @apply text-lg } }
  }
}
`;

test("tailwind: app.css from used classes, component @apply scoped, kept for builds", { skip: !hasCargo() }, async () => {
  const root = project("tw-app", {
    "src/app.css": '@import "tailwindcss";\n@theme { --color-brand: #0a7f5a; }\n',
    "src/pages/index.wx": PAGE,
  });
  const compiler = findCompiler(repo);
  const outDir = join(root, ".weft", "build");
  const loaded = await loadProject(root, { compiler, outDir });
  const app = createApp({ secret: SECRET, ...loaded, onError: () => {} });

  const page = await get(app, "/");
  const href = /<link rel="stylesheet" href="(\/_weft\/app\.css\?v=[0-9a-z]+)">/.exec(page.text)?.[1];
  assert.ok(href, page.text);
  assert.ok(page.text.indexOf(href) < page.text.search(/<style[ >]/), "global sheet comes before component styles");

  const global = await get(app, href);
  assert.equal(global.res.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(global.res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  for (const cls of [".text-3xl", ".font-bold", ".max-w-2xl", ".text-brand"]) {
    assert.ok(global.text.includes(cls), `${cls} generated from the page's classes`);
  }
  assert.ok(global.text.includes("--color-brand: #0a7f5a"), "the theme is the project's");
  assert.ok(!global.text.includes(".text-9xl"), "unused utilities are not generated");

  const critical = /<style>([^<]*)<\/style>/.exec(page.text)?.[1] ?? "";
  const hash = createHash("sha256").update(critical).digest("base64");
  assert.ok(page.res.headers.get("content-security-policy")!.includes(`'sha256-${hash}'`), "allowed by its hash");
  assert.match(critical, /\.btn:where\(\.[\w-]+\) \{[^}]*border-radius: var\(--radius-md/, critical);
  assert.match(critical, /background-color: var\(--color-brand/, critical);
  assert.ok(critical.includes("color: #fff"), "theme() resolved");
  assert.ok(!critical.includes("@apply") && !critical.includes("@variant"), critical);
  assert.match(critical, /&:hover \{\s*@media \(hover: hover\) \{\s*opacity: 80%/, "nested @variant applies to the rule");
  assert.match(critical, /@media \(width >= 48rem\) \{\s*\.btn:where\(\.[\w-]+\) \{\s*font-size/, "block @variant keeps scoping");
  const bundle = await get(app, (/href="(\/_weft\/styles\.css\?v=[^"]+)"/.exec(page.text) ?? [])[1] ?? "/_weft/styles.css");
  assert.ok(bundle.text.includes("var(--color-brand"), bundle.text);
  assert.ok(!bundle.text.includes("@apply"), bundle.text);

  const built = await loadProject(root, { outDir });
  assert.equal(built.stylesheet, loaded.stylesheet);
  assert.deepEqual(built.componentStyles, loaded.componentStyles);

  await build(root, { compiler });
  const server = await startProduction(join(root, "dist"), { listen: false, env: { WEFT_SECRET: SECRET } });
  try {
    const html = await (await server.app.fetch(new Request(ORIGIN + "/")))!.text();
    const prodHref = /href="(\/_weft\/app\.css\?v=[^"]+)"/.exec(html)?.[1];
    assert.ok(prodHref, html);
    const sheet = await (await server.app.fetch(new Request(ORIGIN + prodHref)))!.text();
    assert.ok(sheet.includes(".text-3xl{") && sheet.length < global.text.length, "minified");
    const prodCritical = /<style>([^<]*)<\/style>/.exec(html)?.[1] ?? "";
    assert.match(prodCritical, /\.btn:where\(\.[\w-]+\)\{[^}]*background-color:var\(--color-brand/, prodCritical);
  } finally {
    await server.close();
  }
});

test("tailwind: a plain app.css is served as written; missing Tailwind is named", { skip: !hasCargo() }, async () => {
  const css = "body { margin: 0; font-family: system-ui }\n";
  const root = project("plain-app", {
    "src/app.css": css,
    "src/pages/index.wx": "component Page() {\n  view { <p>Hi</p> }\n}\n",
  });
  const compiler = findCompiler(repo);
  const loaded = await loadProject(root, { compiler, outDir: join(root, ".weft", "build") });
  assert.equal(loaded.stylesheet, css);
  assert.equal(loaded.componentStyles, undefined);
  const app = createApp({ secret: SECRET, ...loaded, onError: () => {} });
  const href = /href="(\/_weft\/app\.css\?v=[^"]+)"/.exec((await get(app, "/")).text)?.[1];
  assert.equal((await get(app, href!)).text, css);

  const bare = project("bare-app", { "src/pages/index.wx": "component Page() {\n  view { <p>Hi</p> }\n}\n" });
  const app2 = createApp({ secret: SECRET, ...(await loadProject(bare, { compiler, outDir: join(bare, ".weft", "b") })) });
  assert.ok(!(await get(app2, "/")).text.includes("/_weft/app.css"));
  assert.equal((await get(app2, "/_weft/app.css")).res.status, 404);

  const lone = mkdtempSync(join(tmpdir(), "weft-no-tw-"));
  try {
    mkdirSync(join(lone, "src"));
    writeFileSync(join(lone, "src", "app.css"), '@import "tailwindcss";\n');
    await assert.rejects(projectStyles(lone, []), (err: unknown) => err instanceof StyleError && /npm install -D tailwindcss/.test(String(err)));
    rmSync(join(lone, "src", "app.css"));
    await assert.rejects(projectStyles(lone, [".a:where(.S){@apply p-4}"]), /a component style uses Tailwind/);
    assert.deepEqual(await projectStyles(lone, [".a:where(.S){color:red}"]), { components: {} });
  } finally {
    rmSync(lone, { recursive: true, force: true });
  }
});

test("tailwind: the `weft new --tailwind` starter compiles and serves", { skip: !hasCargo() }, async () => {
  const root = join(work, "starter-tw");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "new", root, "--minimal", "--tailwind"], { cwd: repo, stdio: "pipe" });
  const compiler = findCompiler(repo);
  const app = createApp({ secret: SECRET, ...(await loadProject(root, { compiler, outDir: join(root, ".weft", "b") })), onError: () => {} });
  const home = await get(app, "/");
  assert.equal(home.res.status, 200);
  assert.ok(!home.text.includes('href="/styles.css"'), "the public stylesheet is gone");
  const href = /href="(\/_weft\/app\.css\?v=[^"]+)"/.exec(home.text)?.[1];
  const sheet = (await get(app, href!)).text;
  assert.ok(sheet.includes("--color-accent: #2c5d8f"), "the starter's tokens are the theme");
  assert.match(sheet, /@layer base \{[\s\S]*\.site-header/, "the starter's rules sit under the utilities");
});

test("tailwind: an unknown utility in @apply names the problem", { skip: !hasCargo() }, async () => {
  const root = project("bad-apply", {
    "src/app.css": '@import "tailwindcss";\n',
    "src/pages/index.wx": "component Page() {\n  view { <p class=\"x\">Hi</p> }\n  style { .x { @apply not-a-utility } }\n}\n",
  });
  await assert.rejects(
    loadProject(root, { compiler: findCompiler(repo), outDir: join(root, ".weft", "build") }),
    (err: unknown) => err instanceof ProjectError && /component style: .*not-a-utility/.test(err.message),
  );
});
