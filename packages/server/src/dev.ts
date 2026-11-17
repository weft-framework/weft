import { mkdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Component } from "@weft/runtime";
import { createApp, type App, type AppOptions } from "./app.ts";
import { islandAssets } from "./assets.ts";
import { loadEnvFile } from "./env.ts";
import { CompileError, compileClient, compileFile, findCompiler } from "./compiler.ts";
import { runtimeAssets, serveNode } from "./node.ts";
import { ConfigError, resolveSecret } from "./config.ts";
import { loadConfig } from "./load-config.ts";
import { mailPreview, type EmailTemplate } from "./mail.ts";
import { ProjectError, loadProject } from "./project.ts";
import { randomId, securityHeaders } from "./security.ts";
import { ModelStorage } from "./storage.ts";
import type { Model } from "@weft/data";
import { DEV_CLIENT_JS, DevEvents } from "./dev-events.ts";

function pick(mod: Record<string, unknown>, name: string | undefined, file: string): Component<object> | null {
  const comps = Object.entries(mod).filter(
    ([, v]) => typeof v === "function" && "def" in (v as object),
  ) as [string, Component<object>][];
  const wanted = name ?? basename(file, ".wx");
  const match = comps.find(([k]) => k === wanted)?.[1];
  if (match || name) {
    return match ?? null;
  }
  return comps.length === 1 ? comps[0][1] : null;
}

function noBuildYet(path: string): Response {
  if (path === "/_weft/dev.js") {
    return new Response(DEV_CLIENT_JS, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const nonce = randomId(16);
  const html =
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Build failed</title></head>` +
    `<body><p>The project does not build yet; the error is shown above once loaded.</p>` +
    `<script type="module" nonce="${nonce}" src="/_weft/dev.js"></script></body></html>\n`;
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...securityHeaders({ nonce, secure: false }) },
  });
}

type Build = Omit<AppOptions, "secret" | "transports"> & {
  models?: Record<string, Model<unknown>>;
  emails?: Record<string, EmailTemplate>;
  database?: string;
};

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      component: { type: "string" },
      route: { type: "string", default: "/" },
    },
  });
  const target = resolve(positionals[0] ?? ".");
  const isFile = target.endsWith(".wx");
  if (!isFile && !statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
    console.error("usage: dev.ts [project-dir | file.wx] [--port N] [--host H]");
    process.exit(2);
  }
  const root = isFile ? dirname(target) : target;
  const compiler = findCompiler(root);
  const devDir = join(root, ".weft", "dev");
  rmSync(devDir, { recursive: true, force: true });

  let version = 0;
  let templates: Record<string, EmailTemplate> = {};
  const buildProject = async (): Promise<Build> => {
    const outDir = join(devDir, String(version));
    return loadProject(root, {
      compiler,
      outDir,
      publicFiles: { cacheControl: "no-cache" },
      cacheKey: String(version),
      onWarn: (m) => console.warn(`weft: ${m}`),
    });
  };
  const buildFile = async (): Promise<Build> => {
    const outDir = join(devDir, String(version));
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, `${basename(target, ".wx")}.ts`);
    writeFileSync(out, compileFile(compiler, target));
    const mod = (await import(pathToFileURL(out).href)) as Record<string, unknown>;
    const component = pick(mod, values.component, target);
    if (!component) {
      throw new ProjectError(`no component ${values.component ?? basename(target, ".wx")}; choose one with --component`);
    }
    const client = compileClient(compiler, target);
    return {
      routes: { [values.route]: { component: component as Component<never>, title: component.def.name } },
      assets: islandAssets(client ? { [`${basename(target, ".wx")}.client.ts`]: client } : {}, {
        root: dirname(target),
        onWarn: (m) => console.warn(`weft: ${m}`),
      }),
    };
  };

  let configPort: number | undefined;
  let configHost: string | undefined;
  let secret = randomId(32);
  if (!isFile) {
    try {
      loadEnvFile(join(root, ".env"));
      const config = await loadConfig(root);
      configPort = config.port;
      configHost = config.host;
      secret = resolveSecret(config, process.env, process.env.NODE_ENV === "production") ?? secret;
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`[weft] ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }
  const port = Number(values.port ?? configPort ?? 3000);
  const host = values.host ?? configHost ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("[weft] port must be an integer from 0 to 65535");
    process.exit(2);
  }
  const runtime = runtimeAssets();
  const devAssets = {
    "/_weft/client.js": `${runtime["/_weft/client.js"]}import "./dev.js";\n`,
    "/_weft/dev.js": DEV_CLIENT_JS,
  };
  let app: App | null = null;
  const storage = new ModelStorage();
  const events = new DevEvents();

  const rebuild = async (): Promise<boolean> => {
    version += 1;
    const started = performance.now();
    try {
      const { models, database, emails, ...build } = await (isFile ? buildFile() : buildProject());
      templates = emails ?? {};
      await storage.attach(Object.values(models ?? {}), {
        database,
        onWarning: (m) => console.warn(`[weft] database: ${m}`),
      });
      const next = createApp({
        ...build,
        secret,
        assets: { ...runtime, ...build.assets, ...devAssets },
        transports: ["sse"],
        devtools: true,
      });
      app?.close();
      app = next;
      const ms = Math.round(performance.now() - started);
      const pages = Object.keys(build.routes).sort().join("  ");
      console.log(`[weft] build ${version} ready in ${ms} ms: ${pages}`);
      rmSync(join(devDir, String(version - 2)), { recursive: true, force: true });
      return true;
    } catch (err) {
      let text: string;
      if (err instanceof CompileError) {
        text = err.diagnostics;
      } else if (err instanceof ProjectError || err instanceof ConfigError) {
        text = err.message;
      } else {
        text = err instanceof Error ? (err.stack ?? err.message) : String(err);
      }
      console.error(err instanceof CompileError ? text : `[weft] ${text}`);
      events.fail(text.split(root + sep).join(""));
      return false;
    }
  };

  await rebuild();

  const reload = () => events.reload();

  const devApp: App = {
    drain: async (o) => (app ? app.drain(o) : true),
    close: () => {
      app?.close();
      storage.close();
      events.close();
    },
    websocket: {
      open: (ws) => (app ? app.websocket.open(ws) : ws.close(1013, "no build")),
      message: async (ws, data) => app?.websocket.message(ws, data),
      close: (ws) => app?.websocket.close(ws),
    },
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === "/_weft/dev/events") {
        return events.response();
      }
      const preview = mailPreview(req, templates);
      if (preview) {
        return preview;
      }
      if (app) {
        return app.fetch(req, server);
      }
      return noBuildYet(path);
    },
  };

  const server = await serveNode(devApp, { port, host });
  console.log(`[weft] serving ${isFile ? basename(target) : root} at ${server.url}${isFile ? values.route : "/"}`);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: "build" | "reload" = "reload";
  const schedule = (what: "build" | "reload") => {
    if (what === "build") {
      pending = "build";
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(async () => {
      timer = null;
      const kind = pending;
      pending = "reload";
      if (kind === "reload" || (await rebuild())) {
        reload();
      }
    }, 80);
  };
  if (isFile) {
    watch(target, () => schedule("build"));
  } else {
    watch(join(root, "src"), { recursive: true }, () => schedule("build"));
    const pub = join(root, "public");
    if (statSync(pub, { throwIfNoEntry: false })?.isDirectory()) {
      watch(pub, { recursive: true }, () => schedule("reload"));
    }
    for (const name of ["weft.config.ts", "weft.config.js", "postcss.config.js", "postcss.config.mjs", "postcss.config.cjs"]) {
      const file = join(root, name);
      if (statSync(file, { throwIfNoEntry: false })?.isFile()) {
        watch(file, () => schedule("build"));
      }
    }
  }
}

await main();
