import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { componentStyles, styleMark, type Component } from "@weft-framework/runtime";
import { Model } from "@weft-framework/data";
import type { ApiHandlers, ApiMethod } from "./api.ts";
import type { AuthOptions } from "./auth.ts";
import { isAction, type Action } from "./action.ts";
import type { AppOptions, Layout, Route } from "./app.ts";
import { checkOg } from "./app.ts";
import { islandAssets, runtimeAssets } from "./assets.ts";
import { compileTree, type Compiler } from "./compiler.ts";
import { projectStyles, StyleError, type ProjectStyles } from "./tailwind.ts";
import { ConfigError } from "./config.ts";
import { publicFiles, type PublicFilesOptions } from "./files.ts";
import { loadConfig } from "./load-config.ts";
import type { Middleware } from "./middleware.ts";
import type { RobotsOptions, SitemapOptions } from "./seo.ts";
import { patternForFile } from "./router.ts";
import { checkCspSources, type CspSources } from "./security.ts";
import type { EmailTemplate } from "./mail.ts";
import { checkPdfRoute, type PdfPrinter, type PdfRouteOptions } from "./pdf.ts";
import type { Images } from "./images.ts";

export interface ProjectOptions {
  compiler?: Compiler;
  outDir: string;
  publicFiles?: PublicFilesOptions;
  browserAssets?: boolean;
  production?: boolean;
  compileStyles?: boolean;
  onWarn?: (message: string) => void;
  cacheKey?: string;
}

export interface ProjectApp extends Pick<
  AppOptions,
  | "routes"
  | "notFound"
  | "error"
  | "shell"
  | "files"
  | "assets"
  | "actions"
  | "meta"
  | "siteUrl"
  | "cookieName"
  | "htmlAttributes"
  | "csp"
  | "edge"
  | "middleware"
  | "ready"
  | "sharedFields"
  | "offline"
  | "pdf"
  | "images"
  | "sitemap"
  | "robots"
  | "auth"
  | "uploads"
  | "api"
  | "stylesheet"
  | "componentStyles"
> {
  models: Record<string, Model<unknown>>;
  emails: Record<string, EmailTemplate>;
  database?: string;
}

export class ProjectError extends Error {}

type Module = Record<string, unknown>;

const API_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

function isComponent(v: unknown): v is Component<object> {
  return typeof v === "function" && "def" in v;
}

function isModel(v: unknown): v is Model<unknown> {
  return v instanceof Model;
}

function pickComponent(mod: Module, preferred: string, file: string): Component<object> {
  if (isComponent(mod.default)) {
    return mod.default;
  }
  if (isComponent(mod[preferred])) {
    return mod[preferred] as Component<object>;
  }
  const found = Object.values(mod).filter(isComponent);
  if (found.length === 1) {
    return found[0];
  }
  throw new ProjectError(
    found.length === 0
      ? `${file}: no component exported`
      : `${file}: ${found.length} components; name the one to use \`${preferred}\``,
  );
}

function checkExports(mod: Module, file: string, allowLoad: boolean): void {
  if (mod.meta !== undefined && typeof mod.meta !== "function" && (typeof mod.meta !== "object" || mod.meta === null)) {
    throw new ProjectError(`${file}: \`meta\` must be an object or a function`);
  }
  if (mod.csp !== undefined) {
    if (!allowLoad) throw new ProjectError(`${file}: layouts cannot export \`csp\`; export it from each page that needs it`);
    try {
      checkCspSources(mod.csp, file);
    } catch (err) {
      throw new ProjectError((err as Error).message);
    }
  }
  if (mod.og !== undefined) {
    if (!allowLoad) throw new ProjectError(`${file}: layouts cannot export \`og\``);
    try {
      checkOg(mod.og, file);
    } catch (err) {
      throw new ProjectError((err as Error).message);
    }
  }
  if (mod.edge !== undefined && (!allowLoad || typeof mod.edge !== "boolean")) {
    throw new ProjectError(allowLoad ? `${file}: export \`edge = true\` or \`false\`` : `${file}: layouts cannot export \`edge\``);
  }
  if (mod.pdf !== undefined) {
    if (!allowLoad) throw new ProjectError(`${file}: layouts cannot export \`pdf\``);
    try {
      checkPdfRoute(mod.pdf, file);
    } catch (err) {
      throw new ProjectError((err as Error).message);
    }
  }
  if (mod.cache !== undefined && (!allowLoad || mod.cache !== "etag")) {
    throw new ProjectError(allowLoad ? `${file}: export \`cache = "etag"\` or nothing` : `${file}: layouts cannot export \`cache\``);
  }
  if (mod.load !== undefined && (!allowLoad || typeof mod.load !== "function")) {
    throw new ProjectError(
      allowLoad ? `${file}: \`load\` must be a function` : `${file}: layouts cannot export \`load\``,
    );
  }
}

function listModules(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (name.endsWith(".ts")) {
        out.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };
  if (existsSync(dir)) {
    walk(dir);
  }
  return out;
}

export async function loadProject(root: string, opts: ProjectOptions): Promise<ProjectApp> {
  const src = join(root, "src");
  if (opts.compiler) {
    if (!existsSync(join(src, "pages"))) {
      throw new ProjectError(`${root}: no src/pages directory`);
    }
    compileTree(opts.compiler, src, opts.outDir);
  } else if (!existsSync(join(opts.outDir, "pages"))) {
    throw new ProjectError(`${opts.outDir}: not a compiled project (no pages/); run \`weft build\``);
  }
  const pagesOut = join(opts.outDir, "pages");
  const isClient = (f: string) => f.endsWith(".client.ts");
  const files = listModules(pagesOut).filter((f) => !isClient(f));
  const clientModules: Record<string, string> = {};
  for (const rel of listModules(opts.outDir).filter(isClient)) {
    clientModules[rel] = readFileSync(join(opts.outDir, rel), "utf8");
  }
  let assets: Record<string, string> = {};
  if (opts.browserAssets !== false) {
    try {
      assets = {
        ...runtimeAssets(),
        ...islandAssets(clientModules, {
          root: src,
          mode: opts.production ? "production" : "development",
          onWarn: opts.onWarn,
        }),
      };
    } catch (err) {
      throw new ProjectError((err as Error).message);
    }
  }
  const mark = styleMark();
  const load = async (rel: string): Promise<Module> =>
    (await import(pathToFileURL(join(pagesOut, rel)).href)) as Module;
  const shown = (rel: string) => `src/pages/${rel.replace(/\.ts$/, "")}`;

  const layouts = new Map<string, Layout>();
  for (const rel of files.filter((f) => f === "_layout.ts" || f.endsWith("/_layout.ts"))) {
    const mod = await load(rel);
    checkExports(mod, shown(rel), false);
    layouts.set(rel.slice(0, -"_layout.ts".length).replace(/\/$/, ""), {
      component: pickComponent(mod, "Layout", shown(rel)) as Component<never>,
      meta: mod.meta as Layout["meta"],
    });
  }
  const chain = (rel: string): Layout[] => {
    const dirs = rel.split("/").slice(0, -1);
    const out: Layout[] = [];
    for (let i = 0; i <= dirs.length; i++) {
      const l = layouts.get(dirs.slice(0, i).join("/"));
      if (l) {
        out.push(l);
      }
    }
    return out;
  };
  const route = async (rel: string): Promise<Route<never>> => {
    const mod = await load(rel);
    checkExports(mod, shown(rel), true);
    return {
      component: pickComponent(mod, "Page", shown(rel)) as Component<never>,
      load: mod.load as Route<never>["load"],
      meta: mod.meta as Route<never>["meta"],
      ...(mod.cache === "etag" ? { cache: "etag" as const } : {}),
      ...(mod.csp !== undefined ? { csp: mod.csp as CspSources } : {}),
      ...(mod.pdf !== undefined ? { pdf: mod.pdf as true | PdfRouteOptions } : {}),
      ...(typeof mod.edge === "boolean" ? { edge: mod.edge } : {}),
      ...(mod.og !== undefined ? { og: mod.og as Route<never>["og"] } : {}),
      layouts: chain(rel),
    };
  };

  const routes: Record<string, Route<never>> = {};
  const owner: Record<string, string> = {};
  for (const rel of files) {
    if (rel.split("/").some((part) => part.startsWith("_")) || rel.startsWith("api/")) {
      continue;
    }
    const pattern = patternForFile(rel);
    if (owner[pattern]) {
      throw new ProjectError(`${shown(rel)} and ${shown(owner[pattern])} both serve ${pattern}`);
    }
    owner[pattern] = rel;
    routes[pattern] = await route(rel);
  }

  const actions: Record<string, Action<never[]>> = {};
  const actionFrom: Record<string, string> = {};
  for (const rel of listModules(opts.outDir).filter((f) => !isClient(f))) {
    const full = join(opts.outDir, rel);
    if (!readFileSync(full, "utf8").includes("defineAction(")) {
      continue;
    }
    const mod = (await import(pathToFileURL(full).href)) as Module;
    for (const v of Object.values(mod)) {
      if (!isAction(v)) {
        continue;
      }
      const prev = actions[v.name];
      if (prev && prev !== v) {
        throw new ProjectError(`action ${v.name} is defined in both src/${actionFrom[v.name]} and src/${rel}`);
      }
      actions[v.name] = v as Action<never[]>;
      actionFrom[v.name] ??= rel;
    }
  }

  const api: Record<string, ApiHandlers> = {};
  for (const rel of files.filter((f) => f.startsWith("api/"))) {
    const pattern = patternForFile(rel);
    if (owner[pattern]) {
      throw new ProjectError(`${shown(rel)} and ${shown(owner[pattern])} both serve ${pattern}`);
    }
    owner[pattern] = rel;
    const mod = await load(rel);
    api[pattern] = apiHandlers(mod, shown(rel));
  }

  const models: Record<string, Model<unknown>> = {};
  const modelFrom: Record<string, string> = {};
  for (const rel of listModules(join(opts.outDir, "models")).filter((f) => !isClient(f))) {
    const mod = (await import(pathToFileURL(join(opts.outDir, "models", rel)).href)) as Module;
    let found = 0;
    for (const value of Object.values(mod)) {
      if (!isModel(value)) {
        continue;
      }
      found += 1;
      const prev = modelFrom[value.name];
      if (prev) {
        throw new ProjectError(`model ${value.name} is defined in both src/models/${prev} and src/models/${rel}`);
      }
      models[value.name] = value;
      modelFrom[value.name] = rel;
    }
    if (found === 0) {
      throw new ProjectError(`src/models/${rel.replace(/\.ts$/, "")}: no model exported`);
    }
  }

  const emails: Record<string, EmailTemplate> = {};
  for (const rel of listModules(join(opts.outDir, "emails")).filter((f) => !isClient(f))) {
    const name = rel.replace(/\.ts$/, "");
    const file = `src/emails/${name}`;
    if (!/^[A-Za-z0-9_/-]{1,200}$/.test(name)) throw new ProjectError(`${file}: email template names use letters, digits, _, - and /`);
    const mod = (await import(pathToFileURL(join(opts.outDir, "emails", rel)).href)) as Module;
    const component = pickComponent(mod, "Email", file);
    if (mod.subject !== undefined && typeof mod.subject !== "string" && typeof mod.subject !== "function") {
      throw new ProjectError(`${file}: \`subject\` is a string or a function of the props`);
    }
    const isProps = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
    if (mod.preview !== undefined && !isProps(mod.preview)) throw new ProjectError(`${file}: \`preview\` is sample props (an object)`);
    if (mod.previews !== undefined && (!isProps(mod.previews) || !Object.values(mod.previews as object).every(isProps))) {
      throw new ProjectError(`${file}: \`previews\` maps sample names to props`);
    }
    const previews: Record<string, object> = { ...(mod.preview ? { default: mod.preview as object } : {}) };
    for (const [k, v] of Object.entries((mod.previews ?? {}) as Record<string, object>)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(k)) throw new ProjectError(`${file}: sample name "${k}" uses letters, digits, _ and -`);
      previews[k] = v;
    }
    emails[name] = {
      component,
      ...(mod.subject !== undefined ? { subject: mod.subject as EmailTemplate["subject"] } : {}),
      previews,
      file,
    };
  }

  let config;
  try {
    config = await loadConfig(root, opts.cacheKey);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new ProjectError(err.message);
    }
    throw err;
  }

  const middlewareFile = ["middleware.ts", "middleware.js"].map((name) => join(opts.outDir, name)).find((file) => existsSync(file));
  let middleware: Middleware | readonly Middleware[] | undefined;
  if (middlewareFile) {
    const mod = (await import(pathToFileURL(middlewareFile).href)) as Module;
    const exported = mod.middleware ?? mod.default;
    if (typeof exported === "function") {
      middleware = exported as Middleware;
    } else if (Array.isArray(exported) && exported.every((item) => typeof item === "function")) {
      middleware = exported as Middleware[];
    } else {
      throw new ProjectError("src/middleware: export a function or an array of functions");
    }
  }

  const readyFile = ["ready.ts", "ready.js"].map((name) => join(opts.outDir, name)).find((file) => existsSync(file));
  let ready: Record<string, () => unknown> | undefined;
  if (readyFile) {
    const mod = (await import(pathToFileURL(readyFile).href)) as Module;
    const exported = mod.ready ?? mod.default;
    if (
      !exported ||
      typeof exported !== "object" ||
      Array.isArray(exported) ||
      !Object.values(exported).every((check) => typeof check === "function")
    ) {
      throw new ProjectError("src/ready: export `ready`, an object of check functions by name");
    }
    ready = exported as Record<string, () => unknown>;
  }

  const sharedFile = ["shared.ts", "shared.js"].map((name) => join(opts.outDir, name)).find((file) => existsSync(file));
  let sharedFields: AppOptions["sharedFields"];
  if (sharedFile) {
    const mod = (await import(pathToFileURL(sharedFile).href)) as Module;
    const { label, saveMs, maxLength } = mod as { label?: unknown; saveMs?: unknown; maxLength?: unknown };
    const count = (v: unknown) => v === undefined || (typeof v === "number" && Number.isInteger(v) && v > 0);
    if ((label !== undefined && typeof label !== "function") || !count(saveMs) || !count(maxLength)) {
      throw new ProjectError("src/shared: export `label(actor)` (a function), `saveMs` and `maxLength` (positive whole numbers)");
    }
    sharedFields = {
      ...(label ? { label: label as (actor: unknown) => string | null | undefined } : {}),
      ...(saveMs !== undefined ? { saveMs: saveMs as number } : {}),
      ...(maxLength !== undefined ? { maxLength: maxLength as number } : {}),
    };
  }

  const pdfFile = ["pdf.ts", "pdf.js"].map((name) => join(opts.outDir, name)).find((file) => existsSync(file));
  let pdf: PdfPrinter | undefined;
  if (pdfFile) {
    const mod = (await import(pathToFileURL(pdfFile).href)) as { pdf?: unknown };
    const p = mod.pdf as PdfPrinter | undefined;
    if (!p || typeof p.print !== "function" || typeof p.close !== "function") {
      throw new ProjectError("src/pdf: export `pdf = definePdf()`");
    }
    pdf = p;
  }
  const imagesFile = ["images.ts", "images.js"].map((name) => join(opts.outDir, name)).find((file) => existsSync(file));
  let images: Images | undefined;
  if (imagesFile) {
    const mod = (await import(pathToFileURL(imagesFile).href)) as { images?: unknown };
    const i = mod.images as Images | undefined;
    if (!i || typeof i.handle !== "function" || typeof i.srcset !== "function") {
      throw new ProjectError("src/images: export `images = defineImages()`");
    }
    images = i;
  }
  const liveFile = ["live.ts", "live.js"].map((name) => join(opts.outDir, name)).find((file) => existsSync(file));
  let offline: AppOptions["offline"];
  if (liveFile) {
    const mod = (await import(pathToFileURL(liveFile).href)) as { offline?: unknown };
    const o = mod.offline as { stale?: unknown } | undefined;
    const keys = o && typeof o === "object" ? Object.keys(o) : [];
    if (o !== undefined && (typeof o !== "object" || o === null || keys.some((k) => k !== "stale") ||
        (o.stale !== undefined && o.stale !== "run" && o.stale !== "refuse"))) {
      throw new ProjectError("src/live: export `offline = { stale: \"run\" | \"refuse\" }`");
    }
    if (o?.stale) offline = { stale: o.stale as "run" | "refuse" };
  }

  const seoFile = ["seo.ts", "seo.js"].map((name) => join(opts.outDir, name)).find((file) => existsSync(file));
  let seo: { sitemap?: SitemapOptions; robots?: RobotsOptions } = {};
  if (seoFile) {
    const mod = (await import(pathToFileURL(seoFile).href)) as Module;
    for (const key of ["sitemap", "robots"] as const) {
      const v = mod[key];
      if (v !== undefined && (v === null || typeof v !== "object" || Array.isArray(v))) {
        throw new ProjectError(`src/seo: \`${key}\` is an options object`);
      }
    }
    if (mod.sitemap !== undefined && !config.siteUrl) {
      throw new ProjectError("src/seo: a sitemap needs `siteUrl` in weft.config.ts");
    }
    seo = {
      ...(mod.sitemap ? { sitemap: mod.sitemap as SitemapOptions } : {}),
      ...(mod.robots ? { robots: mod.robots as RobotsOptions } : {}),
    };
  }

  const uploadsFile = ["uploads.ts", "uploads.js"].map((name) => join(opts.outDir, name)).find((file) => existsSync(file));
  let uploads: AppOptions["uploads"];
  if (uploadsFile) {
    const mod = (await import(pathToFileURL(uploadsFile).href)) as Module;
    const u = mod.uploads as { handle?: unknown; serve?: unknown } | undefined;
    if (typeof u?.handle !== "function" || typeof u.serve !== "function") {
      throw new ProjectError("src/uploads: export `uploads`, a `defineUploads({...})`");
    }
    uploads = u as NonNullable<AppOptions["uploads"]>;
  }
  const authFile = ["auth.ts", "auth.js"].map((name) => join(opts.outDir, name)).find((file) => existsSync(file));
  let auth: AppOptions["auth"];
  if (authFile) {
    const mod = (await import(pathToFileURL(authFile).href)) as Module;
    const hasProviders = mod.providers !== undefined;
    const hasEmail = mod.email !== undefined;
    if (typeof mod.user !== "function" && !hasProviders && !hasEmail) {
      throw new ProjectError("src/auth: export a function `user(id)` returning the actor for a user id");
    }
    if (mod.user !== undefined && typeof mod.user !== "function") {
      throw new ProjectError("src/auth: `user` must be a function `user(id)`");
    }
    auth = mod.user ? { user: mod.user as (id: string, tenant?: string) => unknown } : {};
    if (hasProviders && !Array.isArray(mod.providers)) {
      throw new ProjectError("src/auth: `providers` is an array of sign-in providers");
    }
    if (hasEmail && typeof (mod.email as { consume?: unknown } | null)?.consume !== "function") {
      throw new ProjectError("src/auth: `email` is an `emailSignIn({...})`");
    }
    if (hasProviders || hasEmail) {
      if (typeof mod.signIn !== "function") {
        throw new ProjectError("src/auth: export `signIn(identity)` returning the user id an identity signs in as, or null");
      }
      if (hasProviders) auth.providers = mod.providers as NonNullable<AuthOptions["providers"]>;
      if (hasEmail) auth.email = mod.email as NonNullable<AuthOptions["email"]>;
      auth.signIn = mod.signIn as NonNullable<AuthOptions["signIn"]>;
      if (mod.signInError !== undefined) {
        if (typeof mod.signInError !== "string") {
          throw new ProjectError("src/auth: `signInError` is a path such as \"/signin\"");
        }
        auth.signInError = mod.signInError;
      }
    }
    if (mod.twoFactor !== undefined) {
      if (typeof (mod.twoFactor as { needed?: unknown } | null)?.needed !== "function") {
        throw new ProjectError("src/auth: `twoFactor` is a `defineTwoFactor({...})`");
      }
      auth.twoFactor = mod.twoFactor as NonNullable<AuthOptions["twoFactor"]>;
    }
    if (mod.sessions !== undefined) {
      const s = mod.sessions as { get?: unknown; set?: unknown; delete?: unknown } | null;
      if (typeof s?.get !== "function" || typeof s.set !== "function" || typeof s.delete !== "function") {
        throw new ProjectError("src/auth: `sessions` is a session store such as `new SqlSessionStore(db)`");
      }
      auth.store = mod.sessions as NonNullable<AuthOptions["store"]>;
    }
    if (mod.viewAs !== undefined) {
      if (typeof mod.viewAs !== "function") throw new ProjectError("src/auth: `viewAs` is a function `viewAs(operator, user)`");
      auth.viewAs = mod.viewAs as NonNullable<AuthOptions["viewAs"]>;
    }
  }

  const themeFile = ["theme.ts", "theme.js"].map((name) => join(opts.outDir, name)).find((file) => existsSync(file));
  let theme: ProjectTheme | undefined;
  if (themeFile) {
    const exported = ((await import(pathToFileURL(themeFile).href)) as Module).default as ProjectTheme | undefined;
    if (
      !exported ||
      typeof exported.css !== "function" ||
      typeof exported.tailwind !== "function" ||
      typeof exported.htmlAttributes !== "function"
    ) {
      throw new ProjectError("src/theme: export default defineTheme({...}) from @weft-framework/theme");
    }
    theme = exported;
  }

  const notFound = files.includes("_404.ts") ? await route("_404.ts") : undefined;
  const error = files.includes("_error.ts") ? await route("_error.ts") : undefined;

  const stylesFile = join(opts.outDir, "styles.json");
  let styles: ProjectStyles = { components: {} };
  if (opts.compileStyles ?? opts.compiler !== undefined) {
    try {
      styles = await projectStyles(root, componentStyles(mark), { minify: opts.production, theme });
    } catch (err) {
      if (err instanceof StyleError) {
        throw new ProjectError(err.message);
      }
      throw err;
    }
    writeFileSync(stylesFile, JSON.stringify(styles));
  } else if (existsSync(stylesFile)) {
    styles = JSON.parse(readFileSync(stylesFile, "utf8")) as ProjectStyles;
  }

  const shellFile = opts.compiler ? join(src, "index.html") : join(opts.outDir, "index.html");
  const publicDir = join(root, "public");
  return {
    routes,
    notFound,
    error,
    shell: existsSync(shellFile) ? readFileSync(shellFile, "utf8") : undefined,
    files: existsSync(publicDir) ? publicFiles(publicDir, opts.publicFiles) : undefined,
    assets,
    ...(styles.global !== undefined ? { stylesheet: styles.global } : {}),
    ...(Object.keys(styles.components).length > 0 ? { componentStyles: styles.components } : {}),
    actions,
    api,
    models,
    emails,
    database:
      config.database === undefined || config.database === ":memory:" || /^postgres(ql)?:\/\//i.test(config.database)
        ? config.database
        : config.database.startsWith("pglite:")
          ? config.database === "pglite:" || config.database === "pglite:memory"
            ? config.database
            : `pglite:${resolve(root, config.database.slice("pglite:".length))}`
          : resolve(root, config.database),
    middleware,
    ...(ready ? { ready } : {}),
    ...(sharedFields ? { sharedFields } : {}),
    ...(offline ? { offline } : {}),
    ...(pdf ? { pdf } : {}),
    ...(images ? { images } : {}),
    ...seo,
    ...(auth ? { auth } : {}),
    ...(uploads ? { uploads } : {}),
    meta: config.meta,
    siteUrl: config.siteUrl,
    cookieName: config.cookieName,
    ...(config.csp ? { csp: config.csp } : {}),
    ...(config.edge !== undefined ? { edge: config.edge } : {}),
    ...htmlAttributesOf(theme, config.htmlAttributes),
  };
}

interface ProjectTheme {
  css(): string;
  tailwind(): string;
  htmlAttributes(req: Request): Record<string, string>;
}

type HtmlAttributes = NonNullable<AppOptions["htmlAttributes"]>;

function htmlAttributesOf(theme: ProjectTheme | undefined, own: HtmlAttributes | undefined): { htmlAttributes?: HtmlAttributes } {
  if (!theme) return own ? { htmlAttributes: own } : {};
  return { htmlAttributes: (req) => ({ ...theme.htmlAttributes(req), ...own?.(req) }) };
}

function apiHandlers(mod: Module, file: string): ApiHandlers {
  const handlers: ApiHandlers = {};
  for (const method of API_METHODS) {
    const fn = mod[method];
    if (fn === undefined) {
      continue;
    }
    if (typeof fn !== "function" || isComponent(fn)) {
      throw new ProjectError(`${file}: \`${method}\` must be a function that returns a Response`);
    }
    handlers[method] = fn as ApiHandlers[ApiMethod];
  }
  if (mod.default !== undefined) {
    if (typeof mod.default !== "function" || isComponent(mod.default)) {
      throw new ProjectError(`${file}: the default export must be a function that returns a Response`);
    }
    handlers.default = mod.default as ApiHandlers["default"];
  }
  if (Object.keys(handlers).length === 0) {
    throw new ProjectError(`${file}: export a request method or a default function returning a Response`);
  }
  return handlers;
}
