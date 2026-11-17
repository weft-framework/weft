import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CompileError, compileTree, findCompiler, type Compiler } from "./compiler.ts";
import { ConfigError } from "./config.ts";
import { openApi } from "./contract.ts";
import { dataManifest } from "./datamap.ts";
import { ProjectError, loadProject, type ProjectApp } from "./project.ts";
import { createApp, edgeReason } from "./app.ts";

export const BUILD_FORMAT = 1;

export interface BuildManifest {
  weft: number;
  buildId: string;
  clientEntry: string;
  routes: string[];
  api: string[];
  actions: string[];
  models: string[];
  notFound: boolean;
  error: boolean;
  middleware: boolean;
  assets: Record<string, number>;
  edge: EdgePlan;
}

export interface EdgePlan {
  static: Record<string, string>;
  cacheable: string[];
  origin: Record<string, string>;
}

export interface BuildOptions {
  compiler: Compiler;
  out?: string;
}

export class BuildError extends Error {}

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function checkOut(root: string, out: string): void {
  if (within(root, out)) {
    throw new BuildError(`refusing to build into ${out}: it contains the project`);
  }
  for (const dir of ["src", "public", "node_modules"]) {
    if (within(out, join(root, dir))) {
      throw new BuildError(`refusing to build into ${out}: it is inside ${dir}/`);
    }
  }
  if (!existsSync(out) || readdirSync(out).length === 0) {
    return;
  }
  try {
    const prev = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { weft?: unknown };
    if (typeof prev.weft === "number") {
      return;
    }
  } catch {
  }
  throw new BuildError(`refusing to replace ${out}: not empty and not a previous build`);
}

export function versionImports(js: string, prefix: string): string {
  return js.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(["'])\/_weft\//g, `$1$2${prefix}`);
}

export function versionAssets(assets: Record<string, string>): { assets: Record<string, string>; buildId: string } {
  const h = createHash("sha256");
  for (const path of Object.keys(assets).sort()) {
    h.update(path).update("\0").update(assets[path]).update("\0");
  }
  const buildId = h.digest("hex").slice(0, 12);
  const prefix = `/_weft/${buildId}/`;
  const out: Record<string, string> = {};
  for (const [path, source] of Object.entries(assets)) {
    if (!path.startsWith("/_weft/")) {
      throw new BuildError(`asset outside /_weft/: ${path}`);
    }
    out[prefix + path.slice("/_weft/".length)] = versionImports(source, prefix);
  }
  return { assets: out, buildId };
}

export async function build(root: string, opts: BuildOptions): Promise<BuildManifest> {
  root = resolve(root);
  const out = resolve(opts.out ?? join(root, "dist"));
  if (!existsSync(join(root, "src", "pages"))) {
    throw new BuildError(`${root}: no src/pages directory`);
  }
  checkOut(root, out);
  rmSync(out, { recursive: true, force: true });
  const serverDir = join(out, "server");
  mkdirSync(serverDir, { recursive: true });

  compileTree(opts.compiler, join(root, "src"), serverDir);
  const shell = join(root, "src", "index.html");
  if (existsSync(shell)) {
    cpSync(shell, join(serverDir, "index.html"));
  }

  const project = await loadProject(root, {
    outDir: serverDir,
    production: true,
    compileStyles: true,
    onWarn: (m) => console.warn(`  warning  ${m}`),
  });
  const { assets, buildId } = versionAssets(project.assets ?? {});
  const clientEntry = `/_weft/${buildId}/client.js`;
  if (!(clientEntry in assets)) {
    throw new BuildError("the browser runtime has no client entry");
  }
  const sizes: Record<string, number> = {};
  for (const [path, source] of Object.entries(assets)) {
    const file = join(out, "client", ...path.split("/").filter((p) => p !== "").map(decodeURI));
    if (!within(file, join(out, "client"))) {
      throw new BuildError(`asset path escapes the output: ${path}`);
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
    sizes[path] = Buffer.byteLength(source);
  }

  const manifest: BuildManifest = {
    weft: BUILD_FORMAT,
    buildId,
    clientEntry,
    routes: Object.keys(project.routes).sort(),
    api: Object.keys(project.api ?? {}).sort(),
    actions: Object.keys(project.actions ?? {}).sort(),
    models: Object.keys(project.models).sort(),
    notFound: project.notFound !== undefined,
    error: project.error !== undefined,
    middleware: project.middleware !== undefined,
    assets: sizes,
    edge: await splitEdge(project, root, out, assets, clientEntry),
  };
  writeFileSync(
    join(out, "edge", "routes.json"),
    JSON.stringify({ weft: BUILD_FORMAT, buildId, ...manifest.edge, immutable: `/_weft/${buildId}/` }, null, 2) + "\n",
  );
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const pkgFile = join(root, "package.json");
  const pkg = (existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, "utf8")) : {}) as { name?: unknown; version?: unknown };
  const contract = openApi(
    { actions: project.actions, api: project.api, models: project.models },
    {
      title: typeof pkg.name === "string" ? pkg.name : "weft-app",
      version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    },
  );
  writeFileSync(join(out, "openapi.json"), JSON.stringify(contract, null, 2) + "\n");
  const data = await dataManifest(serverDir);
  writeFileSync(join(out, "data-manifest.json"), JSON.stringify(data, null, 2) + "\n");
  for (const name of data.unused.models) console.warn(`  warning  model ${name}: no code reads it (dist/data-manifest.json)`);
  for (const [name, fields] of Object.entries(data.unused.fields)) {
    console.warn(`  warning  ${name}: no code reads ${fields.map((f) => `\`${f}\``).join(", ")} (written, or never used)`);
  }
  writeFileSync(
    join(out, "server.mjs"),
    "// Production entry written by `weft build`: node dist/server.mjs (or bun).\n" +
      'import { runProduction } from "@weft-framework/server/production";\n\n' +
      "await runProduction(new URL(\".\", import.meta.url));\n",
  );
  return manifest;
}

async function splitEdge(project: ProjectApp, root: string, out: string, assets: Record<string, string>, clientEntry: string): Promise<EdgePlan> {
  const dir = join(out, "edge");
  mkdirSync(dir, { recursive: true });
  const { models: _models, database: _database, emails: _emails, ...appOptions } = project;
  const plan: EdgePlan = { static: {}, cacheable: [], origin: {} };
  const candidates: string[] = [];
  for (const pattern of Object.keys(project.routes).sort()) {
    const why = appOptions.edge === false ? "edge: false" : edgeReason(project.routes[pattern]!, appOptions);
    if (why) plan.origin[pattern] = why;
    else if (pattern.includes("[")) plan.cacheable.push(pattern);
    else candidates.push(pattern);
  }
  const write = (path: string, body: string | Uint8Array): string => {
    const page = typeof body === "string" && !path.endsWith(".css");
    const rel = path === "/" ? "index.html" : page ? `${decodeURIComponent(path.slice(1))}/index.html` : decodeURIComponent(path.slice(1));
    const file = join(dir, ...rel.split("/"));
    if (!within(file, dir) || file === dir) throw new BuildError(`edge path escapes the output: ${path}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
    return rel;
  };
  const app = createApp({
    ...appOptions,
    secret: randomBytes(32).toString("hex"),
    assets,
    clientEntry,
    immutableAssets: true,
    transports: ["sse"],
    onError: () => {},
  });
  const get = async (path: string) => (await app.fetch(new Request(`http://build.invalid${path}`))) ?? null;
  try {
    for (const pattern of candidates) {
      const res = await get(pattern);
      if (!res || res.status !== 200 || !/\bs-maxage=/.test(res.headers.get("cache-control") ?? "")) {
        await res?.body?.cancel();
        plan.origin[pattern] = "renders per visitor (live data, browser code or a form that posts)";
        continue;
      }
      const html = await res.text();
      plan.static[pattern] = write(pattern, html);
      for (const m of html.matchAll(/href="(\/_weft\/(?:styles|app)\.css)\?v=[^"]*"/g)) {
        const sheet = m[1]!;
        if (sheet in plan.static) continue;
        const css = await get(sheet);
        if (css?.status === 200) plan.static[sheet] = write(sheet, await css.text());
      }
    }
    await publicToEdge(project, root, get, write, plan);
  } finally {
    app.close();
  }
  return plan;
}

async function publicToEdge(
  project: ProjectApp,
  root: string,
  get: (path: string) => Promise<Response | null>,
  write: (path: string, body: Uint8Array) => string,
  plan: EdgePlan,
): Promise<void> {
  const pub = join(root, "public");
  if (!project.files || !existsSync(pub)) return;
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (files.length >= 10_000) return;
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.isFile()) files.push(join(d, e.name));
    }
  };
  walk(pub);
  for (const file of files) {
    const path = "/" + relative(pub, file).split(/[\/]/).map(encodeURIComponent).join("/");
    if (path in plan.static) continue;
    const res = await get(path);
    if (!res || res.status !== 200 || /(no-store|private)/.test(res.headers.get("cache-control") ?? "")) {
      await res?.body?.cancel();
      continue;
    }
    const body = new Uint8Array(await res.arrayBuffer());
    if (Buffer.compare(body, readFileSync(file)) === 0) plan.static[path] = write(path, body);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string" } },
  });
  const root = resolve(positionals[0] ?? ".");
  const started = performance.now();
  try {
    const m = await build(root, { compiler: findCompiler(root), out: values.out });
    const ms = Math.round(performance.now() - started);
    const bytes = Object.values(m.assets).reduce((a, b) => a + b, 0);
    console.log(`[weft] build ${m.buildId} in ${ms} ms`);
    console.log(`  routes   ${m.routes.join("  ") || "-"}`);
    if (m.api.length > 0) {
      console.log(`  api      ${m.api.join("  ")}`);
    }
    if (m.actions.length > 0) {
      console.log(`  actions  ${m.actions.join("  ")}`);
    }
    if (m.models.length > 0) {
      console.log(`  models   ${m.models.join("  ")}`);
    }
    console.log(`  client   ${Object.keys(m.assets).length} modules, ${(bytes / 1024).toFixed(1)} KiB`);
    const pages = Object.keys(m.edge.static).filter((p) => m.routes.includes(p));
    console.log(`  edge     ${pages.join("  ") || "-"}${m.edge.cacheable.length ? `  (cacheable: ${m.edge.cacheable.join("  ")})` : ""}`);
    console.log(`\nStart it with: node ${relative(process.cwd(), join(values.out ? resolve(values.out) : join(root, "dist"), "server.mjs"))}`);
  } catch (err) {
    if (err instanceof CompileError) {
      console.error(err.diagnostics);
    } else if (err instanceof BuildError || err instanceof ProjectError || err instanceof ConfigError) {
      console.error(`[weft] ${err.message}`);
    } else {
      console.error("[weft]", err);
    }
    process.exit(1);
  }
}

function isEntry(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  await main();
}
