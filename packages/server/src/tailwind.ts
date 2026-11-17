import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPostcss } from "./postcss.ts";

export class StyleError extends Error {}

export interface ProjectStyles {
  global?: string;
  components: Record<string, string>;
}

export interface StyleOptions {
  minify?: boolean;
  theme?: { css(): string; tailwind(): string };
}

const GLOBAL_TW = /@import\s+(["'])tailwindcss(\/[^"']*)?\1|@tailwind\b|@theme\b|@apply\b|@utility\b|@plugin\b|@source\b|@custom-variant\b|@config\b/;
const COMPONENT_TW = /@apply\b|@variant\b|(^|[^\w-])-{0,2}theme\(|@reference\b/;

interface TailwindNode {
  compile(
    css: string,
    opts: { base: string; onDependency: (path: string) => void },
  ): Promise<{
    root: null | "none" | { base: string; pattern: string };
    sources: { base: string; pattern: string; negated: boolean }[];
    build(candidates: string[]): string;
  }>;
  optimize(css: string, opts?: { minify?: boolean }): { code: string };
}
interface TailwindOxide {
  Scanner: new (opts: { sources: { base: string; pattern: string; negated: boolean }[] }) => { scan(): string[] };
}

async function loadTailwind(root: string): Promise<{ node: TailwindNode; oxide: TailwindOxide } | null> {
  const req = createRequire(join(root, "package.json"));
  let nodePath: string;
  let oxidePath: string;
  try {
    nodePath = req.resolve("@tailwindcss/node");
    oxidePath = createRequire(nodePath).resolve("@tailwindcss/oxide");
  } catch {
    return null;
  }
  const node = (await import(pathToFileURL(nodePath).href)) as TailwindNode;
  const oxide = (await import(pathToFileURL(oxidePath).href)) as TailwindOxide;
  return { node, oxide };
}

const MISSING =
  "uses Tailwind, but it is not installed; add it to the project: `npm install -D tailwindcss @tailwindcss/node`";

function finish(css: string): string {
  return css
    .replace(/^\/\*! tailwindcss[^*]*\*\/\s*/, "")
    .trim()
    .replace(/<\//g, "<\\/");
}

const cache = new Map<string, string>();

export async function projectStyles(root: string, componentCss: readonly string[], opts: StyleOptions = {}): Promise<ProjectStyles> {
  const out = await tailwindStyles(root, componentCss, opts);
  const pass = await loadPostcss(root, opts.minify === true);
  if (!pass) return out;
  if (out.global !== undefined) out.global = await pass(out.global, join(root, "src", "app.css"));
  for (const css of componentCss) {
    const input = (out.components[css] ?? css).replace(/<\\\//g, "</");
    out.components[css] = finish(await pass(input, join(root, "src", "component.css")));
  }
  return out;
}

async function tailwindStyles(root: string, componentCss: readonly string[], opts: StyleOptions): Promise<ProjectStyles> {
  const src = join(root, "src");
  const appFile = join(src, "app.css");
  const file = existsSync(appFile) ? readFileSync(appFile, "utf8") : undefined;
  const appTw = file !== undefined && GLOBAL_TW.test(file);
  const themeCss = opts.theme?.css() ?? "";
  const themeTw = opts.theme?.tailwind() ?? "";
  const app = file === undefined ? (themeCss ? themeCss : undefined) : appTw ? `${file}\n${themeTw}${themeCss}` : themeCss + file;
  const needy = componentCss.filter((css) => COMPONENT_TW.test(css));
  const out: ProjectStyles = { components: {} };
  if (!appTw && needy.length === 0) {
    if (app !== undefined) {
      out.global = app;
    }
    return out;
  }
  const tw = await loadTailwind(root);
  if (!tw) {
    throw new StyleError(`${appTw ? "src/app.css" : "a component style"} ${MISSING}`);
  }
  const minify = (css: string) => (opts.minify ? tw.node.optimize(css, { minify: true }).code : css);
  const fail = (where: string, err: unknown): never => {
    throw new StyleError(`${where}: ${(err as Error).message}`);
  };

  if (app !== undefined) {
    if (appTw) {
      try {
        const compiler = await tw.node.compile(app, { base: src, onDependency: () => {} });
        const sources =
          compiler.root === "none"
            ? []
            : compiler.root === null
              ? [{ base: src, pattern: "**/*", negated: false }]
              : [{ ...compiler.root, negated: false }];
        const candidates = new tw.oxide.Scanner({ sources: [...sources, ...compiler.sources] }).scan();
        out.global = minify(compiler.build(candidates));
      } catch (err) {
        fail("src/app.css", err);
      }
    } else {
      out.global = app;
    }
  }

  const reference = appTw ? JSON.stringify(appFile.replace(/\\/g, "/")) : `"tailwindcss"`;
  const refKey = `${appTw ? `${reference}\n${app}` : reference}\n${themeTw}`;
  for (const css of needy) {
    const key = `${refKey}\n${opts.minify ? 1 : 0}\n${css}`;
    let done = cache.get(key);
    if (done === undefined) {
      try {
        const input = `@reference ${reference};\n${themeTw}${css.replace(/<\\\//g, "</")}`;
        const compiler = await tw.node.compile(input, { base: src, onDependency: () => {} });
        done = finish(minify(compiler.build([])));
      } catch (err) {
        fail("component style", err);
      }
      cache.set(key, done!);
    }
    out.components[css] = done!;
  }
  return out;
}
