import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Model } from "@weft/data";
import { patternForFile } from "./router.ts";

export interface DataAccess {
  modules: string[];
  reads: string[];
  writes: string[];
  unscoped: string[];
  uses: string[];
  grants: string[];
  packages: string[];
}

export interface DataManifest {
  weft: 1;
  routes: Record<string, DataAccess>;
  api: Record<string, DataAccess>;
  middleware: DataAccess | null;
  models: Record<string, { readBy: string[]; writtenBy: string[] }>;
  unused: { models: string[]; fields: Record<string, string[]> };
}

const READS = new Set(["get", "all", "where", "find", "query", "count", "exists", "first", "page", "search", "feed", "writable"]);
const WRITES = new Set(["create", "update", "updateLocked", "updateRows", "delete", "deleteRows", "restore", "upsert", "insert"]);
const UNSCOPED_WRITES = new Set(["removeUnscoped", "unlinkUnscoped", "purgeTrash", "purgeExpired"]);

interface ModuleInfo {
  imports: string[];
  packages: string[];
  bindings: Map<string, string[]>;
  source: string;
  code: string;
}

function listModules(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".client.ts")) out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const IMPORT = /\b(?:import|export)\s+(type\s+)?([\w$*{}\s,]*?)\s*from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function resolveImport(root: string, from: string, spec: string): string | null {
  const base = resolve(dirname(join(root, from)), spec);
  for (const cand of [base, base.replace(/\.(wx|js|tsx?)$/, ".ts"), base + ".ts", join(base, "index.ts")]) {
    if (cand.endsWith(".ts") && existsSync(cand) && statSync(cand).isFile()) {
      const rel = relative(root, cand).split(sep).join("/");
      return rel.startsWith("..") ? null : rel;
    }
  }
  return null;
}

function importedNames(clause: string): [string, string][] {
  const out: [string, string][] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1]!.split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (p === "") continue;
      const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(p);
      if (m) out.push([m[1]!, m[2] ?? m[1]!]);
    }
  }
  const rest = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
  const star = /\*\s+as\s+([\w$]+)/.exec(rest);
  if (star) out.push(["*", star[1]!]);
  else if (/^[\w$]+$/.test(rest)) out.push(["default", rest]);
  return out;
}

function modelsOf(v: unknown): Model<unknown>[] {
  if (v instanceof Model) return [v];
  if (typeof v === "object" && v !== null && "model" in v && (v as { model: unknown }).model instanceof Model) {
    return [(v as { model: Model<unknown> }).model];
  }
  if (typeof v === "object" && v !== null && "models" in v) {
    const m = (v as { models: unknown }).models;
    if (typeof m === "object" && m !== null) {
      return Object.values(m)
        .filter((x): x is Model<unknown> => x instanceof Model);
    }
  }
  return [];
}

function skipParens(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === "`") {
      for (j++; j < s.length && s[j] !== c; j++) if (s[j] === "\\") j++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j + 1;
  }
  return s.length;
}

function chain(s: string, i: number): string[] {
  const out: string[] = [];
  const re = /^\s*\??\.\s*([\w$]+)\s*(\()?/;
  for (;;) {
    const m = re.exec(s.slice(i, i + 200));
    if (!m) return out;
    out.push(m[1]!);
    i += m[0].length;
    if (m[2]) i = skipParens(s, i - 1);
  }
}

function code(s: string): string {
  const out = s.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const tpl: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "/") {
      const end = s.indexOf("\n", i);
      const e = end < 0 ? s.length : end;
      blank(i, e);
      i = e;
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      const e = end < 0 ? s.length : end + 2;
      blank(i, e);
      i = e - 1;
    } else if (c === '"' || c === "'" || (c === "`") || (c === "}" && tpl.length > 0 && tpl[tpl.length - 1] === 0)) {
      if (c === "}") tpl.pop();
      const q = c === "}" ? "`" : c;
      let j = i + 1;
      for (; j < s.length && s[j] !== q; j++) {
        if (s[j] === "\\") j++;
        else if (q === "`" && s[j] === "$" && s[j + 1] === "{") {
          tpl.push(0);
          break;
        }
      }
      blank(i + 1, Math.min(j, s.length));
      i = q === "`" && s[j] === "$" ? j + 1 : j;
    } else if (tpl.length > 0 && c === "{") tpl[tpl.length - 1]!++;
    else if (tpl.length > 0 && c === "}") tpl[tpl.length - 1]!--;
  }
  return out.join("");
}

function emptyAccess(): Omit<DataAccess, "modules" | "packages"> & { modules: Set<string>; packages: Set<string> } {
  return { modules: new Set(), packages: new Set(), reads: [], writes: [], unscoped: [], uses: [], grants: [] };
}

function unusedData(
  modules: Map<string, ModuleInfo>,
  own: Map<string, ReturnType<typeof emptyAccess>>,
  objects: Map<string, Model<unknown>>,
): DataManifest["unused"] {
  const read = new Set<string>();
  for (const a of own.values()) for (const m of [...a.reads, ...a.unscoped, ...a.uses, ...a.grants]) read.add(m);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fields: Record<string, string[]> = {};
  for (const [name, model] of objects) {
    const decl = new RegExp(`defineModel\\s*(?:<[^>]*>)?\\s*\\(\\s*["'\`]${esc(name)}["'\`]`);
    if (![...modules.values()].some((m) => decl.test(m.source))) continue;
    const key = (model as { key?: unknown }).key;
    const unread = Object.keys(model.config.fields ?? {}).filter((f) => {
      if (f === key || f === "id") return false;
      const n = esc(f);
      const inCode = new RegExp(`(?:\\?\\.|\\.)\\s*${n}(?![\\w$])|[{,]\\s*${n}\\s*[,}=]`);
      const inStrings = new RegExp(`\\[\\s*["'\`]${n}["'\`]\\s*\\]|["'\`]${n}["'\`](?!\\s*:)`);
      return ![...modules.values()].some((m) => inCode.test(m.code) || inStrings.test(m.source));
    });
    if (unread.length > 0) fields[name] = unread.sort();
  }
  return {
    models: [...objects.keys()].filter((m) => !read.has(m)).sort(),
    fields: Object.fromEntries(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

export async function dataManifest(serverDir: string): Promise<DataManifest> {
  const root = resolve(serverDir);
  const files = listModules(root);
  const modules = new Map<string, ModuleInfo>();
  const exportsOf = new Map<string, Map<string, string[]>>();
  const objects = new Map<string, Model<unknown>>();

  for (const rel of files) {
    const source = readFileSync(join(root, rel), "utf8");
    const own = new Map<string, string[]>();
    if (/\bexport\b/.test(source)) {
      try {
        const mod = (await import(pathToFileURL(join(root, rel)).href)) as Record<string, unknown>;
        for (const [name, v] of Object.entries(mod)) {
          const ms = modelsOf(v);
          for (const x of ms) objects.set(x.name, x);
          if (ms.length > 0) own.set(name, ms.map((x) => x.name));
        }
      } catch {
      }
    }
    exportsOf.set(rel, own);
    modules.set(rel, { imports: [], packages: [], bindings: new Map(own), source, code: code(source) });
  }
  for (const [rel, info] of modules) {
    for (const m of info.source.matchAll(IMPORT)) {
      const spec = m[3] ?? m[4]!;
      if (!spec.startsWith(".")) {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        if (!pkg.startsWith("node:")) info.packages.push(pkg);
        continue;
      }
      const target = resolveImport(root, rel, spec);
      if (target === null) continue;
      info.imports.push(target);
      if (m[1] || m[2] === undefined) continue;
      const theirs = exportsOf.get(target);
      if (!theirs) continue;
      for (const [imported, local] of importedNames(m[2])) {
        if (imported === "*") {
          for (const [name, ms] of theirs) info.bindings.set(`${local}.${name}`, ms);
        } else if (theirs.has(imported)) info.bindings.set(local, theirs.get(imported)!);
      }
    }
  }

  const own = new Map<string, ReturnType<typeof emptyAccess>>();
  for (const [rel, info] of modules) {
    const a = emptyAccess();
    const imports = [...info.source.matchAll(IMPORT)].map((m) => [m.index, m.index + m[0].length] as const);
    for (const [name, ms] of info.bindings) {
      const re = new RegExp(`(?<![\\w$.])${name.replace(/[.$]/g, "\\$&")}(?![\\w$])`, "g");
      for (const m of info.code.matchAll(re)) {
        if (imports.some(([s, e]) => m.index >= s && m.index < e)) continue;
        const calls = chain(info.code, m.index + m[0].length);
        const before = info.code.slice(Math.max(0, m.index - 80), m.index);
        if (calls.length === 0 && /(?:\b(?:const|let|var)\s*(?:\{[^}=]*)?|\b(?:type|interface|typeof|keyof)\s+)$/.test(before)) continue;
        if (calls.length === 0 && /^\s*[<\]]/.test(info.code.slice(m.index + m[0].length, m.index + m[0].length + 4))) continue;
        const [first, ...rest] = calls;
        const add = (list: string[]) => list.push(...ms);
        if (first === "publicUnscoped") add(a.unscoped);
        else if (first !== undefined && UNSCOPED_WRITES.has(first)) add(a.writes);
        else if (first === "as") {
          const ops = rest.filter((c) => c !== "using" && c !== "trash");
          if (rest.includes("using")) add(a.grants);
          const op = ops[0];
          if (op !== undefined && READS.has(op)) add(a.reads);
          else if (op !== undefined && WRITES.has(op)) add(a.writes);
          else add(a.uses);
        } else if (first === "name" || first === "feed" || first === "lockedFields") {
        } else add(a.uses);
      }
    }
    for (const p of info.packages) a.packages.add(p);
    own.set(rel, a);
  }

  const collect = (entry: string[]): DataAccess => {
    const seen = new Set<string>();
    const stack = [...entry];
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (seen.has(f) || !modules.has(f)) continue;
      seen.add(f);
      stack.push(...modules.get(f)!.imports);
    }
    const sorted = (pick: (a: ReturnType<typeof emptyAccess>) => Iterable<string>) =>
      [...new Set([...seen].flatMap((f) => [...pick(own.get(f)!)]))].sort();
    return {
      modules: [...seen].sort(),
      reads: sorted((a) => a.reads),
      writes: sorted((a) => a.writes),
      unscoped: sorted((a) => a.unscoped),
      uses: sorted((a) => a.uses),
      grants: sorted((a) => a.grants),
      packages: sorted((a) => a.packages),
    };
  };

  const layoutsFor = (rel: string): string[] => {
    const dirs = rel.split("/").slice(0, -1);
    const out: string[] = [];
    for (let i = 0; i <= dirs.length; i++) {
      const f = ["pages", ...dirs.slice(0, i), "_layout.ts"].join("/");
      if (modules.has(f)) out.push(f);
    }
    return out;
  };
  const routes: Record<string, DataAccess> = {};
  const api: Record<string, DataAccess> = {};
  for (const rel of files.filter((f) => f.startsWith("pages/")).map((f) => f.slice("pages/".length))) {
    const parts = rel.split("/");
    if (rel.startsWith("api/")) {
      if (!parts.some((p) => p.startsWith("_"))) api[patternForFile(rel)] = collect([`pages/${rel}`]);
    } else if (!parts.some((p) => p.startsWith("_"))) {
      routes[patternForFile(rel)] = collect([`pages/${rel}`, ...layoutsFor(rel)]);
    }
  }
  const middleware = modules.has("middleware.ts") ? collect(["middleware.ts"]) : null;

  const models: DataManifest["models"] = {};
  const note = (model: string, kind: "readBy" | "writtenBy", who: string) => {
    models[model] ??= { readBy: [], writtenBy: [] };
    if (!models[model][kind].includes(who)) models[model][kind].push(who);
  };
  for (const ms of exportsOf.values()) for (const list of ms.values()) for (const m of list) models[m] ??= { readBy: [], writtenBy: [] };
  const entries: [string, DataAccess][] = [
    ...Object.entries(routes),
    ...Object.entries(api).map(([p, a]): [string, DataAccess] => [`api ${p}`, a]),
    ...(middleware ? [["middleware", middleware] as [string, DataAccess]] : []),
  ];
  for (const [who, a] of entries) {
    for (const m of [...a.reads, ...a.unscoped, ...a.uses, ...a.grants]) note(m, "readBy", who);
    for (const m of [...a.writes, ...a.uses]) note(m, "writtenBy", who);
  }
  for (const v of Object.values(models)) {
    v.readBy.sort();
    v.writtenBy.sort();
  }
  return {
    weft: 1,
    routes,
    api,
    middleware,
    models: Object.fromEntries(Object.entries(models).sort(([a], [b]) => (a < b ? -1 : 1))),
    unused: unusedData(modules, own, objects),
  };
}
