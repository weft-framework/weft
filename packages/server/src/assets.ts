import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserModules, type BrowserModulesOptions } from "./npm.ts";

const RT = "/_weft/rt/";

export function rewriteImports(js: string): string {
  let out = "";
  let i = 0;
  while (i < js.length) {
    const ts = js.indexOf(".ts", i);
    if (ts < 0) {
      out += js.slice(i);
      break;
    }
    const q = js[ts + 3];
    if (q !== '"' && q !== "'") {
      out += js.slice(i, ts + 3);
      i = ts + 3;
      continue;
    }
    const open = js.lastIndexOf(q, ts - 1);
    const spec = open < 0 ? "" : js.slice(open + 1, ts);
    if (open >= 0 && (spec.startsWith("./") || spec.startsWith("../"))) {
      out += js.slice(i, ts) + ".js";
      i = ts + 3;
    } else {
      out += js.slice(i, ts + 3);
      i = ts + 3;
    }
  }
  return out;
}

export function runtimeAssets(): Record<string, string> {
  const src = dirname(fileURLToPath(import.meta.resolve("@weft-framework/runtime")));
  const out: Record<string, string> = {};
  for (const name of readdirSync(src)) {
    if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      const ts = readFileSync(join(src, name), "utf8");
      out[RT + name.replace(/\.ts$/, ".js")] = rewriteImports(stripTypeScriptTypes(ts, { mode: "strip" }));
    } else if (name.endsWith(".js")) {
      out[RT + name] ??= rewriteImports(readFileSync(join(src, name), "utf8"));
    }
  }
  out[ISLANDS_ENTRY] = "export const islands = {};\n";
  out["/_weft/client.js"] =
    `import { boot } from "./rt/boot.js";\n` + `import { islands } from "./islands.js";\n` + `boot({ islands });\n`;
  return out;
}

const ISLANDS_ENTRY = "/_weft/islands.js";
const ISLANDS_DIR = "/_weft/islands/";

const ISLANDS_EXPORT = /^export const islands = \{([\w$.,:" ]*)\};$/m;

export function islandAssets(
  modules: Record<string, string>,
  npm?: BrowserModulesOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  const dirs: Record<string, string> = {};
  const owner = new Map<string, string>();
  const imports: string[] = [];
  const parts: string[] = [];
  for (const [i, rel] of Object.keys(modules).sort().entries()) {
    const ts = modules[rel];
    const keys = (ISLANDS_EXPORT.exec(ts)?.[1] ?? "")
      .split(",")
      .map((n) => n.split(":")[0].trim().replace(/^"(.*)"$/, "$1"))
      .filter((n) => n !== "");
    for (const key of keys) {
      const prev = owner.get(key);
      if (prev !== undefined && !/\.[0-9a-f]{8}$/.test(key)) {
        throw new Error(`island ${key} is defined in both ${prev} and ${rel}`);
      }
      owner.set(key, rel);
    }
    const js = stripTypeScriptTypes(ts, { mode: "strip" }).replace(
      /(\bfrom\s*)(["'])@weft-framework\/runtime\2/g,
      `$1$2${RT}index.js$2`,
    );
    const url = encodeURI(ISLANDS_DIR + rel.replace(/\.client\.ts$/, ".js"));
    out[url] = js;
    if (npm) dirs[url] = join(npm.root, dirname(rel));
    imports.push(`import { islands as m${i} } from ${JSON.stringify(url)};\n`);
    parts.push(`...m${i}`);
  }
  out[ISLANDS_ENTRY] = `${imports.join("")}export const islands = { ${parts.join(", ")} };\n`;
  if (!npm) {
    return out;
  }
  const input: Record<string, { js: string; dir: string }> = {};
  for (const url of Object.keys(dirs)) input[url] = { js: out[url], dir: dirs[url] };
  const resolved = browserModules(input, npm);
  return { ...out, ...resolved.modules, ...resolved.assets };
}
