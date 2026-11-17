import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { createApp } from "../packages/server/src/app.ts";
import { findCompiler } from "../packages/server/src/compiler.ts";
import { runtimeAssets, serveNode } from "../packages/server/src/node.ts";
import { loadProject } from "../packages/server/src/project.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PAGES = ["/", "/list", "/counter"];

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "5" },
    concurrency: { type: "string", default: "32" },
    pages: { type: "string", default: "1000" },
    json: { type: "string" },
    url: { type: "string" },
  },
});
const seconds = Number(values.seconds);
const concurrency = Number(values.concurrency);
const livePages = Number(values.pages);

async function weftApp() {
  const root = join(here, "apps", "weft");
  const { models: _models, database: _db, ...build } = await loadProject(root, {
    compiler: findCompiler(root),
    outDir: join(root, ".weft", "bench", randomUUID()),
  });
  return createApp({
    ...build,
    secret: randomUUID() + randomUUID(),
    assets: { ...runtimeAssets(), ...build.assets },
    transports: ["sse"],
    onError: (e) => console.error(e),
  });
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;

async function load(url: string) {
  const ttfb: number[] = [];
  let errors = 0;
  const end = performance.now() + seconds * 1000;
  const loop = async () => {
    while (performance.now() < end) {
      const t0 = performance.now();
      try {
        const res = await fetch(url);
        ttfb.push(performance.now() - t0);
        await res.arrayBuffer();
        if (!res.ok) errors++;
      } catch {
        errors++;
      }
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, loop));
  const elapsed = (performance.now() - started) / 1000;
  ttfb.sort((a, b) => a - b);
  return { requests: ttfb.length, rps: ttfb.length / elapsed, p50: quantile(ttfb, 0.5), p99: quantile(ttfb, 0.99), errors };
}

async function jsShipped(base: string, page: string) {
  const html = await (await fetch(base + page)).text();
  const queue = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => new URL(m[1], base + page).href);
  const seen = new Set<string>();
  let raw = 0;
  let gzip = 0;
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    if (/type="application\/(ld\+)?json"/.test(m[0])) continue;
    raw += Buffer.byteLength(m[1]);
    gzip += gzipSync(m[1]).length;
  }
  while (queue.length) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await fetch(url);
    if (!res.ok) continue;
    const text = await res.text();
    raw += Buffer.byteLength(text);
    gzip += gzipSync(text).length;
    for (const m of text.matchAll(/(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith(".") || spec.startsWith("/")) queue.push(new URL(spec, url).href);
    }
  }
  return { files: seen.size, raw, gzip };
}

async function memoryPerPage(app: Awaited<ReturnType<typeof weftApp>>, n: number) {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) return null;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      gc();
      await new Promise((r) => setTimeout(r, 10));
    }
    return process.memoryUsage().heapUsed;
  };
  const before = await settle();
  const keep: Response[] = [];
  for (let i = 0; i < n; i++) {
    const res = await app.fetch(new Request("http://bench.test/counter"));
    await res!.text();
    keep.push(res!);
  }
  const after = await settle();
  return Math.round((after - before) / n);
}

async function main() {
  const app = values.url ? null : await weftApp();
  const server = app ? await serveNode(app, { port: 0, host: "127.0.0.1" }) : null;
  const base = values.url ?? server!.url;
  const results: Record<string, unknown> = {};
  for (const page of PAGES) {
    await load(base + page).catch(() => {});
    const [ttfb, js] = [await load(base + page), await jsShipped(base, page)];
    results[page] = { ...ttfb, js };
  }
  await server?.close();
  app?.close();
  const fresh = app ? await weftApp() : null;
  const memory = fresh ? await memoryPerPage(fresh, livePages) : null;
  fresh?.close();

  const out = {
    framework: values.url ? values.url : "weft",
    node: process.version,
    seconds,
    concurrency,
    pages: results,
    memoryPerLivePage: memory,
  };
  const fmt = (n: number, d = 1) => n.toFixed(d);
  console.log(`| page | req/s | TTFB p50 ms | TTFB p99 ms | JS files | JS bytes | JS gzip |`);
  console.log(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const [page, r] of Object.entries(results) as [string, Awaited<ReturnType<typeof load>> & { js: Awaited<ReturnType<typeof jsShipped>> }][]) {
    console.log(`| ${page} | ${fmt(r.rps, 0)} | ${fmt(r.p50)} | ${fmt(r.p99)} | ${r.js.files} | ${r.js.raw} | ${r.js.gzip} |`);
    if (r.errors) console.log(`  (${r.errors} errors)`);
  }
  console.log(memory === null ? "memory per live page: run with --expose-gc" : `memory per live page: ${memory} bytes (${livePages} pages)`);
  if (values.json) writeFileSync(values.json, JSON.stringify(out, null, 2) + "\n");
}

await main();
