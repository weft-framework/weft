import { readFileSync, statSync } from "node:fs";
import { builtinModules, stripTypeScriptTypes } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

export const NPM_PREFIX = "/_weft/npm/";
export const LOCAL_PREFIX = "/_weft/local/";

export class NpmError extends Error {}

export interface BrowserModulesOptions {
  root: string;
  mode?: "development" | "production";
  onWarn?: (message: string) => void;
}

const CONDITIONS = ["browser", "import", "module", "default"];
const EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".json", "/index.js", "/index.mjs", "/index.cjs", "/index.json"];
const LOCAL_EXTENSIONS = ["", ".ts", ".js", ".mjs", "/index.ts", "/index.js"];
const BUILTINS = new Set(builtinModules);

interface Pkg {
  dir: string;
  name: string;
  version: string;
  json: Record<string, unknown>;
}

type Target = { file: string; pkg: Pkg | null } | { empty: string };

const REQUIRE = /\brequire\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
const ESM_SYNTAX = /(^|[\n;])\s*(import\b\s*[\w*{"'$]|export\b\s*[\w*{])/;
const NAMED_EXPORT =
  /\bexports\.([A-Za-z_$][\w$]*)\s*=|Object\.defineProperty\(\s*(?:module\.)?exports\s*,\s*["']([A-Za-z_$][\w$]*)["']/g;
const REEXPORT = /\bmodule\.exports\s*=\s*require\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
const RESERVED = new Set(
  "default break case catch class const continue debugger delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await __weftCjs".split(
    " ",
  ),
);

const isBare = (s: string) => !/^(\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(s) || s.startsWith("node:");

function splitSpec(spec: string): [string, string] {
  const parts = spec.split("/");
  const n = spec.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, n).join("/");
  const rest = parts.slice(n).join("/");
  return [name, rest === "" ? "." : `./${rest}`];
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function probe(base: string, exts: string[]): string | null {
  for (const e of exts) {
    if (isFile(base + e)) return base + e;
  }
  return null;
}

const pkgCache = new Map<string, Pkg | null>();

function readPkg(dir: string): Pkg | null {
  if (pkgCache.has(dir)) return pkgCache.get(dir)!;
  let pkg: Pkg | null = null;
  const file = join(dir, "package.json");
  if (isFile(file)) {
    try {
      const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      pkg = { dir, name: String(json.name ?? ""), version: String(json.version ?? "0.0.0"), json };
    } catch {
      pkg = null;
    }
  }
  pkgCache.set(dir, pkg);
  return pkg;
}

function findPackage(name: string, from: string): Pkg | null {
  let dir = from;
  for (;;) {
    const cand = join(dir, "node_modules", name);
    const pkg = readPkg(cand);
    if (pkg) return { ...pkg, name: pkg.name || name };
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function ownerOf(file: string): Pkg | null {
  let dir = dirname(file);
  for (;;) {
    const pkg = readPkg(dir);
    if (pkg && pkg.name) return pkg;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function exportTarget(target: unknown, star: string | null): string | null | undefined {
  if (typeof target === "string") {
    return star === null ? target : target.split("*").join(star);
  }
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = exportTarget(t, star);
      if (r) return r;
    }
    return undefined;
  }
  if (target === null) return null;
  if (typeof target === "object") {
    for (const [cond, value] of Object.entries(target as Record<string, unknown>)) {
      if (CONDITIONS.includes(cond)) {
        const r = exportTarget(value, star);
        if (r !== undefined) return r;
      }
    }
  }
  return undefined;
}

function resolveExports(pkg: Pkg, sub: string): string | null | undefined {
  let exp = pkg.json.exports;
  if (exp === undefined) return undefined;
  const subpathMap =
    typeof exp === "object" && exp !== null && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith("."));
  if (!subpathMap) exp = { ".": exp };
  const map = exp as Record<string, unknown>;
  if (sub in map) return exportTarget(map[sub], null) ?? null;
  let best: [string, string] | null = null;
  for (const key of Object.keys(map)) {
    const i = key.indexOf("*");
    if (i < 0) continue;
    const [pre, post] = [key.slice(0, i), key.slice(i + 1)];
    if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= key.length - 1) {
      if (!best || pre.length > best[0].length) best = [key, sub.slice(pre.length, sub.length - post.length)];
    }
  }
  return best ? (exportTarget(map[best[0]], best[1]) ?? null) : null;
}

function browserRemap(pkg: Pkg, key: string): string | false | undefined {
  const b = pkg.json.browser;
  if (typeof b !== "object" || b === null) return undefined;
  const map = b as Record<string, unknown>;
  for (const k of [key, key.replace(/^\.\//, ""), `${key}.js`]) {
    const v = map[k];
    if (v === false) return false;
    if (typeof v === "string") return v;
  }
  return undefined;
}

function resolveBare(spec: string, fromDir: string, importer: Pkg | null): Target | null {
  if (BUILTINS.has(spec) || spec.startsWith("node:")) return { empty: spec };
  if (importer) {
    const remap = browserRemap(importer, spec);
    if (remap === false) return { empty: spec };
    if (typeof remap === "string") return resolveFile(join(importer.dir, remap), importer);
  }
  const [name, sub] = splitSpec(spec);
  const pkg = findPackage(name, fromDir);
  if (!pkg) return null;
  const viaExports = resolveExports(pkg, sub);
  if (viaExports === null) return null;
  if (viaExports !== undefined) return resolveFile(join(pkg.dir, viaExports), pkg);
  if (sub !== ".") return resolveFile(join(pkg.dir, sub), pkg);
  const browser = typeof pkg.json.browser === "string" ? pkg.json.browser : undefined;
  const entry = [pkg.json.module, browser, pkg.json.main].find((e): e is string => typeof e === "string") ?? "index.js";
  return resolveFile(join(pkg.dir, entry), pkg);
}

function resolveFile(path: string, pkg: Pkg | null): Target | null {
  const file = probe(path, EXTENSIONS);
  if (!file) return null;
  const owner = pkg ?? ownerOf(file);
  if (owner) {
    const rel = "./" + relative(owner.dir, file).split(sep).join("/");
    const remap = browserRemap(owner, rel);
    if (remap === false) return { empty: rel };
    if (typeof remap === "string") {
      const again = probe(join(owner.dir, remap), EXTENSIONS);
      if (again) return { file: again, pkg: owner };
    }
  }
  return { file, pkg: owner };
}

const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);

export function rewriteSpecifiers(code: string, map: (spec: string) => string | null): string {
  let out = "";
  let last = 0;
  let i = 0;
  let prev = "";
  let word = "";
  const braces: number[] = [];
  let depth = 0;
  const n = code.length;
  const isId = (c: string | undefined) => c !== undefined && /[\w$]/.test(c);
  const skipString = (q: string, at: number): number => {
    let j = at + 1;
    while (j < n && code[j] !== q && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
    return j + 1;
  };
  const template = (at: number): number => {
    let j = at;
    while (j < n) {
      const c = code[j];
      if (c === "\\") j += 2;
      else if (c === "`") return j + 1;
      else if (c === "$" && code[j + 1] === "{") {
        braces.push(depth);
        depth += 1;
        return -(j + 2);
      } else j += 1;
    }
    return n;
  };
  while (i < n) {
    const c = code[i]!;
    if (c === "/" && code[i + 1] === "/") {
      const e = code.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const e = code.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipString(c, i);
      const lead = word === "from" || word === "import" || (word === "(" && prev === "import");
      if (lead) {
        const spec = code.slice(i + 1, end - 1);
        const url = spec.includes("\n") ? null : map(spec);
        if (url !== null) {
          out += code.slice(last, i + 1) + url;
          last = end - 1;
        }
      }
      prev = word;
      word = "str";
      i = end;
      continue;
    }
    if (c === "`") {
      const r = template(i + 1);
      i = r < 0 ? -r : r;
      prev = word;
      word = r < 0 ? "{" : "str";
      continue;
    }
    if (c === "}" && braces.length > 0 && braces[braces.length - 1] === depth - 1) {
      braces.pop();
      depth -= 1;
      const r = template(i + 1);
      i = r < 0 ? -r : r;
      prev = word;
      word = r < 0 ? "{" : "str";
      continue;
    }
    if (c === "/") {
      const regexOk = word === "" || (!isId(word[word.length - 1]) && word !== ")" && word !== "]" && word !== "str") || REGEX_AFTER_WORD.has(word);
      if (regexOk) {
        let j = i + 1;
        let cls = false;
        while (j < n && code[j] !== "\n") {
          const d = code[j];
          if (d === "\\") j += 2;
          else {
            if (d === "[") cls = true;
            else if (d === "]") cls = false;
            else if (d === "/" && !cls) break;
            j += 1;
          }
        }
        j += 1;
        while (isId(code[j])) j += 1;
        prev = word;
        word = "str";
        i = j;
        continue;
      }
    }
    if (isId(c)) {
      let j = i;
      while (isId(code[j])) j += 1;
      prev = word;
      word = code.slice(i, j);
      if (code[i - 1] === ".") word = "." + word;
      i = j;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    prev = word;
    word = c;
    i += 1;
  }
  return out + code.slice(last);
}

export function browserModules(
  modules: Record<string, { js: string; dir: string }>,
  opts: BrowserModulesOptions,
): { modules: Record<string, string>; assets: Record<string, string> } {
  const mode = opts.mode ?? "development";
  const warn = opts.onWarn ?? (() => {});
  const assets: Record<string, string> = {};
  const urlOf = new Map<string, string>();
  const cjsNames = new Map<string, string[]>();
  const queue: { file: string; pkg: Pkg | null; local: boolean }[] = [];
  const srcRoot = resolve(opts.root);

  const enqueue = (t: Target, local: boolean): string => {
    if ("empty" in t) {
      const url = `${NPM_PREFIX}_empty/${encodeURIComponent(t.empty)}.js`;
      assets[url] = "export default {};\nexport const __weftCjs = true;\n";
      return url;
    }
    let url = urlOf.get(t.file);
    if (url) return url;
    if (local) {
      const rel = relative(srcRoot, t.file).split(sep).join("/");
      if (rel.startsWith("..")) throw new NpmError(`client import outside src/: ${t.file}`);
      url = LOCAL_PREFIX + encodeURI(rel.replace(/\.ts$/, ".js"));
    } else if (t.pkg) {
      const rel = relative(t.pkg.dir, t.file).split(sep).join("/");
      url = `${NPM_PREFIX}${encodeURI(`${t.pkg.name}@${t.pkg.version}/${rel}`)}`;
    } else {
      throw new NpmError(`${t.file} belongs to no package`);
    }
    if (extname(url) === ".json") url += ".js";
    if (extname(url) === ".cjs") url = url.slice(0, -4) + ".cjs.js";
    urlOf.set(t.file, url);
    queue.push({ file: t.file, pkg: t.pkg, local });
    return url;
  };

  const resolveFrom = (spec: string, fromDir: string, importer: Pkg | null, local: boolean): Target | null => {
    if (isBare(spec)) return resolveBare(spec, fromDir, importer);
    if (spec.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(spec)) return null;
    const base = resolve(fromDir, spec);
    if (local) {
      const f = probe(base, LOCAL_EXTENSIONS);
      return f ? { file: f, pkg: null } : null;
    }
    return resolveFile(base, importer);
  };

  const out: Record<string, string> = {};
  for (const [key, { js, dir }] of Object.entries(modules)) {
    out[key] = rewriteSpecifiers(js, (spec) => {
      if (spec.startsWith("/_weft/") || spec === "@weft-framework/runtime") return null;
      if (BUILTINS.has(spec) || spec.startsWith("node:")) {
        throw new NpmError(`${key}: \`${spec}\` is a Node built-in and cannot run in the browser`);
      }
      const t = resolveFrom(spec, dir, null, !isBare(spec));
      if (!t) {
        throw new NpmError(
          isBare(spec)
            ? `${key}: cannot resolve \`${spec}\` for the browser; is it installed (npm install ${splitSpec(spec)[0]})?`
            : `${key}: cannot find \`${spec}\` from ${dir}`,
        );
      }
      return enqueue(t, !isBare(spec));
    });
  }

  while (queue.length > 0) {
    const { file, pkg, local } = queue.shift()!;
    const url = urlOf.get(file)!;
    let code = readFileSync(file, "utf8");
    const dir = dirname(file);
    const map = (spec: string): string | null => {
      if (spec === "@weft-framework/runtime") return "/_weft/rt/index.js";
      const t = resolveFrom(spec, dir, pkg, local && !isBare(spec));
      if (!t) {
        warn(`${url}: cannot resolve \`${spec}\` for the browser`);
        return null;
      }
      return enqueue(t, local && !isBare(spec));
    };
    if (file.endsWith(".json")) {
      assets[url] = `export default ${code.trim() || "null"};\nexport const __weftCjs = true;\n`;
      continue;
    }
    if (file.endsWith(".ts")) {
      code = stripTypeScriptTypes(code, { mode: "strip" });
    }
    code = code.replace(/\bprocess\.env\.NODE_ENV\b/g, JSON.stringify(mode));
    if (local || file.endsWith(".mjs") || ESM_SYNTAX.test(code)) {
      assets[url] = rewriteSpecifiers(code, map);
    } else {
      assets[url] = wrapCommonJs(code, namedExports(file, cjsNames, 0), map);
    }
  }
  return { modules: out, assets };
}

function namedExports(file: string, cache: Map<string, string[]>, depth: number): string[] {
  const hit = cache.get(file);
  if (hit) return hit;
  let code: string;
  try {
    code = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const m of code.matchAll(NAMED_EXPORT)) names.add(m[1] ?? m[2]);
  if (depth < 4) {
    for (const m of code.matchAll(REEXPORT)) {
      const t = m[2].startsWith(".") ? probe(resolve(dirname(file), m[2]), EXTENSIONS) : null;
      if (t) for (const n of namedExports(t, cache, depth + 1)) names.add(n);
    }
  }
  const out = [...names].filter((n) => !RESERVED.has(n));
  cache.set(file, out);
  return out;
}

function wrapCommonJs(code: string, names: string[], map: (spec: string) => string | null): string {
  const deps = new Map<string, string>();
  const imports: string[] = [];
  for (const m of code.matchAll(REQUIRE)) {
    const spec = m[2];
    if (deps.has(spec)) continue;
    const url = map(spec);
    if (url === null) continue;
    const id = `__weft${deps.size}`;
    deps.set(spec, id);
    imports.push(`import * as ${id} from ${JSON.stringify(url)};\n`);
  }
  const table = [...deps].map(([spec, id]) => `${JSON.stringify(spec)}: ${id}`).join(", ");
  const named = names.length > 0 ? `export const { ${names.join(", ")} } = __m.exports;\n` : "";
  return (
    imports.join("") +
    `const __deps = { ${table} };\n` +
    `const __m = { exports: {} };\n` +
    `(function (module, exports, require, global) {\n${code}\n}).call(__m.exports, __m, __m.exports, (s) => {\n` +
    `  const d = __deps[s];\n` +
    `  if (!d) throw new Error("weft: cannot require " + s + " in the browser");\n` +
    `  return d.__weftCjs ? d.default : d;\n` +
    `}, globalThis);\n` +
    `export default __m.exports;\n` +
    `export const __weftCjs = true;\n` +
    named
  );
}
