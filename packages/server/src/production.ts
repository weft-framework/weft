import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, type App } from "./app.ts";
import { BUILD_FORMAT, type BuildManifest } from "./build.ts";
import { ConfigError, resolveSecret } from "./config.ts";
import { loadConfig } from "./load-config.ts";
import { serveBun, type BunServeApi } from "./bun.ts";
import { serveNode } from "./node.ts";
import { ProjectError, loadProject } from "./project.ts";
import { loadEnvFile } from "./env.ts";
import { ModelStorage } from "./storage.ts";
import { parseTrustedProxies } from "./client-address.ts";

export interface ProductionOptions {
  env?: Record<string, string | undefined>;
  listen?: boolean;
}

export interface ProductionServer {
  app: App;
  manifest: BuildManifest;
  url?: string;
  close(): Promise<void>;
}

export class ProductionError extends Error {}

function readManifest(dist: string): BuildManifest {
  const file = join(dist, "manifest.json");
  if (!existsSync(file)) {
    throw new ProductionError(`${dist}: no manifest.json; run \`weft build\``);
  }
  const m = JSON.parse(readFileSync(file, "utf8")) as BuildManifest;
  if (m.weft !== BUILD_FORMAT) {
    throw new ProductionError(`${dist}: built by an incompatible Weft (format ${String(m.weft)}); rebuild`);
  }
  return m;
}

function readAssets(dist: string, manifest: BuildManifest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of Object.keys(manifest.assets)) {
    const parts = path.split("/").filter((p) => p !== "").map(decodeURI);
    out[path] = readFileSync(join(dist, "client", ...parts), "utf8");
  }
  return out;
}

function port(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new ProductionError(`PORT must be an integer from 0 to 65535, not ${JSON.stringify(value)}`);
  }
  return n;
}

function ms(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 600_000) {
    throw new ProductionError(`${name} must be a whole number of milliseconds from 0 to 600000, not ${JSON.stringify(value)}`);
  }
  return n;
}

export async function startProduction(distUrl: URL | string, opts: ProductionOptions = {}): Promise<ProductionServer> {
  const env = opts.env ?? process.env;
  const dist = resolve(typeof distUrl === "string" ? distUrl : fileURLToPath(distUrl));
  const root = dirname(dist);
  loadEnvFile(join(root, ".env"), env);
  const manifest = readManifest(dist);
  const config = await loadConfig(root);
  const secret = resolveSecret(config, env, true)!;
  const project = await loadProject(root, { outDir: join(dist, "server"), browserAssets: false });
  const storage = new ModelStorage();
  await storage.attach(Object.values(project.models), { database: project.database });

  const bun = (globalThis as { Bun?: BunServeApi }).Bun;
  const listen = opts.listen ?? true;
  const { models: _models, database: _database, emails: _emails, ...appOptions } = project;
  const app = createApp({
    ...appOptions,
    secret,
    assets: readAssets(dist, manifest),
    clientEntry: manifest.clientEntry,
    immutableAssets: true,
    transports: bun && listen ? ["ws", "sse"] : ["sse"],
  });

  const drain = { delayMs: ms(env.WEFT_DRAIN_DELAY_MS, "WEFT_DRAIN_DELAY_MS", 0), timeoutMs: ms(env.WEFT_DRAIN_TIMEOUT_MS, "WEFT_DRAIN_TIMEOUT_MS", 10_000) };
  const shutdown = async (stop: () => Promise<void> | void) => {
    await app.drain(drain);
    await stop();
    app.close();
    storage.close();
  };
  if (!listen) {
    return { app, manifest, close: () => shutdown(() => undefined) };
  }

  const p = port(env.PORT, config.port ?? 3000);
  const trustedProxies = parseTrustedProxies(env.WEFT_TRUSTED_PROXIES);
  const host = env.HOST || config.host || "127.0.0.1";
  let server: ProductionServer;
  if (bun) {
    const s = serveBun(app, { port: p, hostname: host, trustProxy: env.WEFT_TRUST_PROXY === "1", trustedProxies }, bun);
    server = { app, manifest, url: s.url, close: () => shutdown(() => s.close()) };
  } else {
    const s = await serveNode(app, { port: p, host, trustProxy: env.WEFT_TRUST_PROXY === "1", trustedProxies });
    server = { app, manifest, url: s.url, close: () => shutdown(() => s.close()) };
  }
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (closing) {
        return;
      }
      closing = true;
      void server.close().then(() => process.exit(0));
    });
  }
  console.log(`[weft] build ${manifest.buildId} serving at ${server.url}`);
  return server;
}

export async function runProduction(distUrl: URL | string): Promise<void> {
  try {
    await startProduction(distUrl);
  } catch (err) {
    const known = err instanceof ConfigError || err instanceof ProjectError || err instanceof ProductionError;
    console.error(known ? `[weft] ${(err as Error).message}` : err);
    process.exit(1);
  }
}
