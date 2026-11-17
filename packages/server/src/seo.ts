import type { PageMeta } from "./meta.ts";
import type { Params } from "./router.ts";

type Maybe<T> = T | Promise<T>;

export type ChangeFrequency = "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";

export interface SitemapEntry {
  url: string;
  lastModified?: Date | number;
  changeFrequency?: ChangeFrequency;
  priority?: number;
}

export interface RouteEntry extends Omit<SitemapEntry, "url"> {
  params: Params;
}

export interface SitemapOptions {
  exclude?: readonly (string | RegExp)[];
  params?: Record<string, () => Maybe<Iterable<RouteEntry>>>;
  extra?: () => Maybe<Iterable<Omit<SitemapEntry, "url"> & { url: string }>>;
  changeFrequency?: ChangeFrequency;
  priority?: number;
  maxAge?: number;
}

export interface RobotsRule {
  userAgent: string | readonly string[];
  allow?: readonly string[];
  disallow?: readonly string[];
  crawlDelay?: number;
}

export interface RobotsOptions {
  rules: readonly RobotsRule[];
  sitemap?: string | readonly string[];
}

export interface SitemapRoute {
  pattern: string;
  meta?: unknown;
}

const MAX_URLS = 50_000;
const FREQ = new Set(["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"]);

const xmlEscape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

function httpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export function checkSitemapOptions(o: SitemapOptions): void {
  if (!o || typeof o !== "object") throw new Error("sitemap: options are an object");
  for (const e of o.exclude ?? []) {
    if (typeof e !== "string" && !(e instanceof RegExp)) throw new Error("sitemap: exclude holds paths or regular expressions");
  }
  for (const [pattern, f] of Object.entries(o.params ?? {})) {
    if (typeof f !== "function") throw new Error(`sitemap: params[${JSON.stringify(pattern)}] is a function`);
  }
  if (o.extra !== undefined && typeof o.extra !== "function") throw new Error("sitemap: extra is a function");
  if (o.changeFrequency !== undefined && !FREQ.has(o.changeFrequency)) throw new Error("sitemap: unknown changeFrequency");
  if (o.priority !== undefined && !(o.priority >= 0 && o.priority <= 1)) throw new Error("sitemap: priority is 0 to 1");
  if (o.maxAge !== undefined && !(Number.isInteger(o.maxAge) && o.maxAge >= 0)) throw new Error("sitemap: maxAge is whole seconds");
}

function noindex(meta: unknown): boolean {
  return !!meta && typeof meta === "object" && /\bnoindex\b/i.test(String((meta as PageMeta).robots ?? ""));
}

export function fillPattern(pattern: string, params: Params): string | null {
  const out: string[] = [];
  for (const seg of pattern.split("/").filter((s) => s !== "")) {
    const rest = /^\[\[?\.\.\.([A-Za-z_$][\w$]*)\]\]?$/.exec(seg);
    const one = /^\[([A-Za-z_$][\w$]*)\]$/.exec(seg);
    if (rest) {
      const v = params[rest[1]!];
      const parts = v === undefined ? [] : Array.isArray(v) ? v : [v];
      if (parts.some((p) => typeof p !== "string" || p === "" || p === "." || p === "..")) return null;
      if (parts.length === 0 && !seg.startsWith("[[")) return null;
      out.push(...parts.map(encodeURIComponent));
    } else if (one) {
      const v = params[one[1]!];
      if (typeof v !== "string" || v === "" || v === "." || v === "..") return null;
      out.push(encodeURIComponent(v));
    } else {
      out.push(seg);
    }
  }
  return `/${out.join("/")}`;
}

export async function sitemapEntries(siteUrl: string, routes: readonly SitemapRoute[], o: SitemapOptions): Promise<SitemapEntry[]> {
  const origin = new URL(siteUrl).origin;
  const excluded = (path: string) => (o.exclude ?? []).some((e) => (typeof e === "string" ? e === path : (e.lastIndex = 0, e.test(path))));
  const out: SitemapEntry[] = [];
  const seen = new Set<string>();
  const add = (path: string, e: Omit<SitemapEntry, "url">) => {
    if (excluded(path)) return;
    const url = httpUrl(path.startsWith("/") && !path.startsWith("//") ? origin + path : path);
    if (!url || new URL(url).origin !== origin || seen.has(url)) return;
    seen.add(url);
    if (out.length >= MAX_URLS) throw new Error(`sitemap: more than ${MAX_URLS} URLs; split it with \`extra\` and your own index`);
    out.push({ url, ...e });
  };
  const defaults = {
    ...(o.changeFrequency ? { changeFrequency: o.changeFrequency } : {}),
    ...(o.priority !== undefined ? { priority: o.priority } : {}),
  };
  const patterns = new Set(routes.map((r) => r.pattern));
  for (const p of Object.keys(o.params ?? {})) {
    if (!patterns.has(p)) throw new Error(`sitemap: params for ${JSON.stringify(p)}, which is not a route`);
  }
  for (const r of [...routes].sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0))) {
    if (noindex(r.meta)) continue;
    if (!r.pattern.includes("[")) {
      add(r.pattern, defaults);
      continue;
    }
    const list = o.params?.[r.pattern];
    if (!list) continue;
    for (const entry of await list()) {
      const path = entry && typeof entry === "object" ? fillPattern(r.pattern, entry.params ?? {}) : null;
      if (path === null) throw new Error(`sitemap: an entry for ${r.pattern} lacks its params`);
      const { params: _p, ...rest } = entry;
      add(path, { ...defaults, ...rest });
    }
  }
  for (const e of o.extra ? await o.extra() : []) {
    const { url, ...rest } = e;
    add(url, { ...defaults, ...rest });
  }
  return out;
}

export function sitemapXml(entries: readonly SitemapEntry[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const e of entries) {
    const url = httpUrl(e.url);
    if (!url) throw new Error(`sitemap: ${JSON.stringify(String(e.url).slice(0, 80))} is not an absolute http(s) URL`);
    let line = `<url><loc>${xmlEscape(url)}</loc>`;
    if (e.lastModified !== undefined) {
      const d = new Date(e.lastModified);
      if (Number.isNaN(d.getTime())) throw new Error(`sitemap: bad lastModified for ${url}`);
      line += `<lastmod>${d.toISOString()}</lastmod>`;
    }
    if (e.changeFrequency !== undefined) {
      if (!FREQ.has(e.changeFrequency)) throw new Error(`sitemap: bad changeFrequency for ${url}`);
      line += `<changefreq>${e.changeFrequency}</changefreq>`;
    }
    if (e.priority !== undefined) {
      if (!(e.priority >= 0 && e.priority <= 1)) throw new Error(`sitemap: priority for ${url} is 0 to 1`);
      line += `<priority>${e.priority.toFixed(1)}</priority>`;
    }
    lines.push(`${line}</url>`);
  }
  lines.push("</urlset>", "");
  return lines.join("\n");
}

const ROBOTS_VALUE = /^[^\r\n#]*$/;

export function robotsTxt(o: RobotsOptions, sitemapUrl?: string): string {
  if (!o || !Array.isArray(o.rules)) throw new Error("robots: rules is an array");
  const value = (v: unknown, what: string) => {
    if (typeof v !== "string" || !ROBOTS_VALUE.test(v)) throw new Error(`robots: ${what} is one line without #`);
    return v.trim();
  };
  const groups: string[] = [];
  for (const r of o.rules) {
    const agents = typeof r.userAgent === "string" ? [r.userAgent] : [...(r.userAgent ?? [])];
    if (agents.length === 0) throw new Error("robots: each rule names a userAgent");
    const lines = agents.map((a) => `User-agent: ${value(a, "userAgent")}`);
    for (const p of r.allow ?? []) lines.push(`Allow: ${value(p, "allow")}`);
    for (const p of r.disallow ?? []) lines.push(`Disallow: ${value(p, "disallow")}`);
    if (!r.allow?.length && !r.disallow?.length) lines.push("Disallow:");
    if (r.crawlDelay !== undefined) {
      if (!(Number.isFinite(r.crawlDelay) && r.crawlDelay >= 0)) throw new Error("robots: crawlDelay is seconds");
      lines.push(`Crawl-delay: ${r.crawlDelay}`);
    }
    groups.push(lines.join("\n"));
  }
  const maps = [...(typeof o.sitemap === "string" ? [o.sitemap] : (o.sitemap ?? [])), ...(sitemapUrl ? [sitemapUrl] : [])];
  const tail = [...new Set(maps)].map((m) => {
    const u = httpUrl(value(m, "sitemap"));
    if (!u) throw new Error("robots: sitemap URLs are absolute http(s) URLs");
    return `Sitemap: ${u}`;
  });
  return [...groups, ...(tail.length ? [tail.join("\n")] : [])].join("\n\n") + "\n";
}
