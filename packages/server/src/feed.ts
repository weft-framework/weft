import { createHash } from "node:crypto";

type Maybe<T> = T | Promise<T>;

export type FeedFormat = "rss" | "atom";

export interface FeedItem {
  url: string;
  title: string;
  id?: string;
  summary?: string;
  content?: string;
  published: Date | number;
  updated?: Date | number;
  author?: string;
  categories?: readonly string[];
}

export interface Feed {
  title: string;
  siteUrl: string;
  feedUrl: string;
  description?: string;
  language?: string;
  author?: string;
  updated?: Date | number;
  items: readonly FeedItem[];
}

export interface FeedOptions {
  format?: FeedFormat;
  limit?: number;
  maxAge?: number;
}

const MAX_ITEMS = 500;
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function text(s: string): string {
  return s.replace(INVALID_XML, "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function httpUrl(raw: unknown, what: string): string {
  try {
    const u = new URL(String(raw));
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch {}
  throw new Error(`feed: ${what} ${JSON.stringify(String(raw).slice(0, 80))} is not an absolute http(s) URL`);
}

function date(v: Date | number | undefined, what: string): Date | null {
  if (v === undefined) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`feed: bad date for ${what}`);
  return d;
}

function required(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`feed: ${what} is required`);
  return v.trim();
}

interface Clean {
  title: string;
  siteUrl: string;
  feedUrl: string;
  description: string;
  language: string | null;
  author: string | null;
  updated: Date;
  items: {
    url: string;
    id: string;
    title: string;
    summary: string | null;
    content: string | null;
    published: Date;
    updated: Date;
    author: string | null;
    categories: string[];
  }[];
}

function clean(feed: Feed, limit: number): Clean {
  if (!feed || typeof feed !== "object") throw new Error("feed: expected a feed object");
  if (!Array.isArray(feed.items)) throw new Error("feed: items is an array");
  if (feed.language !== undefined && !LANG.test(feed.language)) throw new Error("feed: language is a BCP 47 tag such as en or de-AT");
  const items = feed.items
    .map((it, i) => {
      const url = httpUrl(it.url, `items[${i}].url`);
      const published = date(it.published, `items[${i}].published`);
      if (!published) throw new Error(`feed: items[${i}].published is required`);
      return {
        url,
        id: it.id ? required(it.id, `items[${i}].id`) : url,
        title: required(it.title, `items[${i}].title`),
        summary: it.summary?.trim() || null,
        content: it.content?.trim() || null,
        published,
        updated: date(it.updated, `items[${i}].updated`) ?? published,
        author: it.author?.trim() || null,
        categories: [...(it.categories ?? [])].map((c) => String(c).trim()).filter(Boolean),
      };
    })
    .sort((a, b) => b.published.getTime() - a.published.getTime())
    .slice(0, limit);
  const newest = items.reduce((n, it) => Math.max(n, it.updated.getTime()), 0);
  return {
    title: required(feed.title, "title"),
    siteUrl: httpUrl(feed.siteUrl, "siteUrl"),
    feedUrl: httpUrl(feed.feedUrl, "feedUrl"),
    description: feed.description?.trim() || required(feed.title, "title"),
    language: feed.language ?? null,
    author: feed.author?.trim() || null,
    updated: date(feed.updated, "updated") ?? new Date(newest || 0),
    items,
  };
}

function limitOf(o: FeedOptions): number {
  const n = o.limit ?? 50;
  if (!Number.isInteger(n) || n < 1 || n > MAX_ITEMS) throw new Error(`feed: limit is 1 to ${MAX_ITEMS}`);
  return n;
}

export function rssXml(feed: Feed, o: Pick<FeedOptions, "limit"> = {}): string {
  const f = clean(feed, limitOf(o));
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    "<channel>",
    `<title>${text(f.title)}</title>`,
    `<link>${text(f.siteUrl)}</link>`,
    `<description>${text(f.description)}</description>`,
    `<atom:link href="${text(f.feedUrl)}" rel="self" type="application/rss+xml"/>`,
    `<lastBuildDate>${f.updated.toUTCString()}</lastBuildDate>`,
  ];
  if (f.language) out.push(`<language>${text(f.language)}</language>`);
  for (const it of f.items) {
    const parts = [`<item>`, `<title>${text(it.title)}</title>`, `<link>${text(it.url)}</link>`, `<guid isPermaLink="${it.id === it.url}">${text(it.id)}</guid>`, `<pubDate>${it.published.toUTCString()}</pubDate>`];
    if (it.summary) parts.push(`<description>${text(it.summary)}</description>`);
    if (it.content) parts.push(`<content:encoded>${text(it.content)}</content:encoded>`);
    if (it.author ?? f.author) parts.push(`<dc:creator>${text((it.author ?? f.author)!)}</dc:creator>`);
    for (const c of it.categories) parts.push(`<category>${text(c)}</category>`);
    parts.push("</item>");
    out.push(parts.join(""));
  }
  out.push("</channel>", "</rss>", "");
  return out.join("\n");
}

export function atomXml(feed: Feed, o: Pick<FeedOptions, "limit"> = {}): string {
  const f = clean(feed, limitOf(o));
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom"${f.language ? ` xml:lang="${text(f.language)}"` : ""}>`,
    `<title>${text(f.title)}</title>`,
    `<subtitle>${text(f.description)}</subtitle>`,
    `<id>${text(f.feedUrl)}</id>`,
    `<link href="${text(f.siteUrl)}" rel="alternate" type="text/html"/>`,
    `<link href="${text(f.feedUrl)}" rel="self" type="application/atom+xml"/>`,
    `<updated>${f.updated.toISOString()}</updated>`,
  ];
  if (f.author) out.push(`<author><name>${text(f.author)}</name></author>`);
  for (const it of f.items) {
    const parts = [`<entry>`, `<title>${text(it.title)}</title>`, `<link href="${text(it.url)}" rel="alternate"/>`, `<id>${text(it.id)}</id>`, `<published>${it.published.toISOString()}</published>`, `<updated>${it.updated.toISOString()}</updated>`];
    if (it.author) parts.push(`<author><name>${text(it.author)}</name></author>`);
    if (it.summary) parts.push(`<summary type="text">${text(it.summary)}</summary>`);
    if (it.content) parts.push(`<content type="html">${text(it.content)}</content>`);
    for (const c of it.categories) parts.push(`<category term="${text(c)}"/>`);
    parts.push("</entry>");
    out.push(parts.join(""));
  }
  out.push("</feed>", "");
  return out.join("\n");
}

export function feedXml(feed: Feed, o: FeedOptions = {}): string {
  const format = o.format ?? "rss";
  if (format === "rss") return rssXml(feed, o);
  if (format === "atom") return atomXml(feed, o);
  throw new Error('feed: format is "rss" or "atom"');
}

export function defineFeed(load: () => Maybe<Feed>, o: FeedOptions = {}): (request?: Request) => Promise<Response> {
  const format = o.format ?? "rss";
  if (format !== "rss" && format !== "atom") throw new Error('feed: format is "rss" or "atom"');
  limitOf(o);
  const maxAge = o.maxAge ?? 900;
  if (!Number.isInteger(maxAge) || maxAge < 0) throw new Error("feed: maxAge is whole seconds");
  const type = format === "rss" ? "application/rss+xml; charset=utf-8" : "application/atom+xml; charset=utf-8";
  return async (request?: Request) => {
    const body = feedXml(await load(), o);
    const etag = `W/"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
    const headers = { "content-type": type, "cache-control": `public, max-age=${maxAge}`, etag, "x-content-type-options": "nosniff" };
    const match = request?.headers.get("if-none-match");
    if (match && match.split(",").some((t) => t.trim() === etag || t.trim() === "*")) return new Response(null, { status: 304, headers });
    if (request?.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(body, { status: 200, headers });
  };
}
