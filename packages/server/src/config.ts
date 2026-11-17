import type { LinkTag, MetaTag, OpenGraph, PageMeta, TwitterCard } from "./meta.ts";
import { checkCspSources, type CspSources } from "./security.ts";

export interface SecretSource {
  env: string;
}

export interface WeftConfig {
  port?: number;
  host?: string;
  secret?: SecretSource;
  siteUrl?: string;
  meta?: PageMeta;
  cookieName?: string;
  htmlAttributes?: (req: Request) => Record<string, string | boolean | null | undefined>;
  database?: string;
  csp?: CspSources;
  edge?: false | { maxAge?: number; stale?: number };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST = /^[A-Za-z0-9._:-]{1,253}$/;
const COOKIE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const KEYS = new Set(["port", "host", "secret", "siteUrl", "meta", "cookieName", "database", "htmlAttributes", "csp", "edge"]);

function fail(message: string): never {
  throw new ConfigError(`weft.config.ts: ${message}`);
}

export function isSiteUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    (url.pathname === "/" || url.pathname === "")
  );
}

export function parseConfig(raw: unknown): WeftConfig {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail("the config must be an object");
  }
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (!KEYS.has(key)) {
      fail(`unknown option "${key}"`);
    }
  }
  const out: WeftConfig = {};
  if (src.port !== undefined) {
    if (typeof src.port !== "number" || !Number.isInteger(src.port) || src.port < 0 || src.port > 65535) {
      fail("port must be an integer from 0 to 65535");
    }
    out.port = src.port;
  }
  if (src.host !== undefined) {
    if (typeof src.host !== "string" || !HOST.test(src.host)) {
      fail("host must be a hostname or IP address");
    }
    out.host = src.host;
  }
  if (src.secret !== undefined) {
    out.secret = parseSecret(src.secret);
  }
  if (src.siteUrl !== undefined) {
    if (typeof src.siteUrl !== "string" || !isSiteUrl(src.siteUrl)) {
      fail("siteUrl must be an http(s) origin with no path, query, or credentials");
    }
    out.siteUrl = new URL(src.siteUrl).origin;
  }
  if (src.cookieName !== undefined) {
    if (typeof src.cookieName !== "string" || !COOKIE.test(src.cookieName)) {
      fail("cookieName is not a valid cookie name");
    }
    out.cookieName = src.cookieName;
  }
  if (src.htmlAttributes !== undefined) {
    if (typeof src.htmlAttributes !== "function") {
      fail("htmlAttributes must be a function of the request");
    }
    out.htmlAttributes = src.htmlAttributes as WeftConfig["htmlAttributes"];
  }
  if (src.meta !== undefined) {
    out.meta = parseMeta(src.meta);
  }
  if (src.database !== undefined) {
    if (
      typeof src.database !== "string" ||
      src.database.trim() === "" ||
      src.database.length > 1024 ||
      src.database.includes("\0") ||
      /^[a-z][a-z0-9+.-]*:\/\//i.test(src.database)
    ) {
      fail('database must be a file path (relative to the project) or ":memory:"');
    }
    out.database = src.database;
  }
  if (src.edge !== undefined) {
    const e = src.edge as { maxAge?: unknown; stale?: unknown } | false;
    const secs = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 31_536_000);
    if (e !== false && (typeof e !== "object" || e === null || Array.isArray(e) || Object.keys(e).some((k) => k !== "maxAge" && k !== "stale") || !secs(e.maxAge) || !secs(e.stale))) {
      fail("edge must be false or { maxAge, stale } in whole seconds (0 to 31536000)");
    }
    out.edge = e as WeftConfig["edge"];
  }
  if (src.csp !== undefined) {
    try {
      out.csp = checkCspSources(src.csp, "weft.config.ts");
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
  }
  return out;
}

function parseSecret(raw: unknown): SecretSource {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail('secret must be { env: "NAME" }, naming an environment variable');
  }
  const keys = Object.keys(raw);
  const env = (raw as Record<string, unknown>).env;
  if (keys.length !== 1 || keys[0] !== "env" || typeof env !== "string" || !ENV_NAME.test(env)) {
    fail('secret must be { env: "NAME" }, naming an environment variable');
  }
  return { env };
}

export function resolveSecret(
  config: WeftConfig,
  env: Record<string, string | undefined>,
  production: boolean,
): string | null {
  if (!config.secret && production && env.WEFT_SECRET) {
    return resolveSecret({ ...config, secret: { env: "WEFT_SECRET" } }, env, production);
  }
  if (config.secret) {
    const value = env[config.secret.env];
    if (typeof value !== "string" || value.length < 32) {
      fail(
        value === undefined || value === ""
          ? `environment variable ${config.secret.env} is not set`
          : `environment variable ${config.secret.env} must be at least 32 characters`,
      );
    }
    return value;
  }
  if (production) {
    fail('production requires a session secret: set WEFT_SECRET (32+ characters) or secret: { env: "NAME" }');
  }
  return null;
}

function parseMeta(raw: unknown): PageMeta {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("meta must be an object");
  }
  const src = raw as Record<string, unknown>;
  const allowed = new Set([
    "title",
    "titleTemplate",
    "description",
    "canonical",
    "robots",
    "lang",
    "themeColor",
    "openGraph",
    "twitter",
    "jsonLd",
    "tags",
    "links",
  ]);
  for (const key of Object.keys(src)) {
    if (!allowed.has(key)) {
      fail(`unknown meta field "${key}"`);
    }
  }
  const meta: PageMeta = {};
  const text = (key: "title" | "titleTemplate" | "description" | "canonical" | "robots" | "lang" | "themeColor", max: number) => {
    if (src[key] === undefined) {
      return;
    }
    meta[key] = line(src[key], max, `meta.${key}`);
  };
  text("title", 300);
  text("titleTemplate", 300);
  text("description", 2000);
  text("canonical", 2000);
  text("robots", 200);
  text("lang", 40);
  text("themeColor", 40);
  if (src.openGraph !== undefined) {
    meta.openGraph = parseOpenGraph(src.openGraph);
  }
  if (src.twitter !== undefined) {
    meta.twitter = parseTwitter(src.twitter);
  }
  if (src.jsonLd !== undefined) {
    const json = JSON.stringify(plainJson(src.jsonLd, "meta.jsonLd", 0));
    if (json.length > 16_000) {
      fail("meta.jsonLd is too large");
    }
    meta.jsonLd = JSON.parse(json) as unknown;
  }
  if (src.tags !== undefined) {
    meta.tags = parseTags(src.tags);
  }
  if (src.links !== undefined) {
    meta.links = parseLinks(src.links);
  }
  return meta;
}

function line(value: unknown, max: number, field: string): string {
  if (typeof value !== "string") {
    fail(`${field} must be a string`);
  }
  if (value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${field} contains control characters or is too long`);
  }
  return value;
}

function parseOpenGraph(raw: unknown): OpenGraph {
  return pickStrings(raw, "meta.openGraph", ["title", "description", "type", "url", "image", "imageAlt", "siteName", "locale"], 2000);
}

function parseTwitter(raw: unknown): TwitterCard {
  const card = pickStrings(raw, "meta.twitter", ["card", "site", "creator", "title", "description", "image"], 2000);
  if (card.card !== undefined && !["summary", "summary_large_image", "app", "player"].includes(card.card)) {
    fail('meta.twitter.card must be "summary", "summary_large_image", "app", or "player"');
  }
  return card as TwitterCard;
}

function pickStrings<K extends string>(raw: unknown, field: string, keys: readonly K[], max: number): Partial<Record<K, string>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`${field} must be an object`);
  }
  const src = raw as Record<string, unknown>;
  const allowed = new Set<string>(keys);
  for (const key of Object.keys(src)) {
    if (!allowed.has(key)) {
      fail(`unknown ${field} field "${key}"`);
    }
  }
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    if (src[key] !== undefined) {
      out[key] = line(src[key], max, `${field}.${key}`);
    }
  }
  return out;
}

function parseTags(raw: unknown): MetaTag[] {
  if (!Array.isArray(raw) || raw.length > 20) {
    fail("meta.tags must be an array of at most 20 tags");
  }
  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      fail(`meta.tags[${i}] must be an object`);
    }
    const src = item as Record<string, unknown>;
    const content = line(src.content, 2000, `meta.tags[${i}].content`);
    const name = src.name === undefined ? undefined : line(src.name, 200, `meta.tags[${i}].name`);
    const property = src.property === undefined ? undefined : line(src.property, 200, `meta.tags[${i}].property`);
    const httpEquiv = src.httpEquiv === undefined ? undefined : line(src.httpEquiv, 200, `meta.tags[${i}].httpEquiv`);
    const which = [name, property, httpEquiv].filter((v) => v !== undefined);
    if (which.length !== 1) {
      fail(`meta.tags[${i}] needs exactly one of name, property, httpEquiv`);
    }
    return { content, name, property, httpEquiv };
  });
}

function parseLinks(raw: unknown): LinkTag[] {
  if (!Array.isArray(raw) || raw.length > 20) {
    fail("meta.links must be an array of at most 20 links");
  }
  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      fail(`meta.links[${i}] must be an object`);
    }
    const src = item as Record<string, unknown>;
    const link: LinkTag = {
      rel: line(src.rel, 200, `meta.links[${i}].rel`),
      href: line(src.href, 2000, `meta.links[${i}].href`),
    };
    for (const key of ["type", "sizes", "hreflang", "media"] as const) {
      if (src[key] !== undefined) {
        link[key] = line(src[key], 200, `meta.links[${i}].${key}`);
      }
    }
    return link;
  });
}

function plainJson(value: unknown, field: string, depth: number): unknown {
  if (depth > 8) {
    fail(`${field} is too deep`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > 4000) {
      fail(`${field} is too large`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(`${field} must be finite numbers, strings, booleans, arrays, and plain objects`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 40) {
      fail(`${field} is too large`);
    }
    return value.map((item) => plainJson(item, field, depth + 1));
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      fail(`${field} must be plain data`);
    }
    const src = value as Record<string, unknown>;
    const keys = Object.keys(src);
    if (keys.length > 40) {
      fail(`${field} is too large`);
    }
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        fail(`${field} has an invalid key`);
      }
      out[key] = plainJson(src[key], field, depth + 1);
    }
    return out;
  }
  fail(`${field} must be plain data`);
}
