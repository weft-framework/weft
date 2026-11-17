import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { StyleError } from "./tailwind.ts";

interface Processor {
  process(css: string, opts: { from?: string; map?: false }): PromiseLike<{ css: string }>;
}
type PostCss = (plugins: unknown[]) => Processor;

export type CssPass = (css: string, file: string) => Promise<string>;

const CONFIGS = ["postcss.config.js", "postcss.config.mjs", "postcss.config.cjs"];
const TAILWIND_PLUGINS = new Set(["@tailwindcss/postcss", "tailwindcss"]);

export function postcssConfig(root: string): string | null {
  for (const name of CONFIGS) {
    const file = join(root, name);
    if (existsSync(file)) return file;
  }
  return null;
}

const unwrap = (m: { default?: unknown }): unknown => (m && "default" in m ? m.default : m);

export async function loadPostcss(root: string, production: boolean): Promise<CssPass | null> {
  const file = postcssConfig(root);
  if (!file) return null;
  const name = file.slice(root.length + 1);
  const req = createRequire(join(root, "package.json"));
  let postcssPath: string;
  try {
    postcssPath = req.resolve("postcss");
  } catch {
    throw new StyleError(`${name} found, but postcss is not installed; add it: \`npm install -D postcss\``);
  }
  const postcss = unwrap(await import(pathToFileURL(postcssPath).href)) as PostCss;
  let config: unknown;
  try {
    config = unwrap(await import(`${pathToFileURL(file).href}?t=${Date.now()}`));
    if (typeof config === "function") {
      config = await (config as (ctx: object) => unknown)({ env: production ? "production" : "development", file });
    }
  } catch (err) {
    throw new StyleError(`${name}: ${(err as Error).message}`);
  }
  const plugins: unknown[] = [];
  const raw = (config as { plugins?: unknown } | null)?.plugins ?? [];
  if (Array.isArray(raw)) {
    for (const p of raw) {
      if (!p) continue;
      const id = (p as { postcssPlugin?: string }).postcssPlugin;
      if (id !== undefined && /^(@tailwindcss\/postcss|tailwindcss)$/.test(id)) continue;
      plugins.push(p);
    }
  } else if (typeof raw === "object") {
    for (const [plugin, opts] of Object.entries(raw as Record<string, unknown>)) {
      if (opts === false || TAILWIND_PLUGINS.has(plugin)) continue;
      let factory: unknown;
      try {
        factory = unwrap(await import(pathToFileURL(req.resolve(plugin)).href));
      } catch {
        throw new StyleError(`${name} uses ${plugin}, but it is not installed; add it: \`npm install -D ${plugin}\``);
      }
      plugins.push(typeof factory === "function" ? (factory as (o: unknown) => unknown)(opts === true ? {} : opts) : factory);
    }
  } else {
    throw new StyleError(`${name}: \`plugins\` must be an object or an array`);
  }
  if (plugins.length === 0) return null;
  const processor = postcss(plugins);
  return async (css, from) => {
    try {
      return (await processor.process(css, { from, map: false })).css;
    } catch (err) {
      throw new StyleError(`postcss (${from}): ${(err as Error).message}`);
    }
  };
}
