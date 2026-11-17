import { escapeAttr, escapeHtml } from "@weft/runtime";

export interface MetaTag {
  name?: string;
  property?: string;
  httpEquiv?: string;
  content: string;
}

export interface LinkTag {
  rel: string;
  href: string;
  type?: string;
  sizes?: string;
  hreflang?: string;
  media?: string;
}

export interface OpenGraph {
  title?: string;
  description?: string;
  type?: string;
  url?: string;
  image?: string;
  imageAlt?: string;
  siteName?: string;
  locale?: string;
}

export interface TwitterCard {
  card?: "summary" | "summary_large_image" | "app" | "player";
  site?: string;
  creator?: string;
  title?: string;
  description?: string;
  image?: string;
}

export interface PageMeta {
  title?: string;
  titleTemplate?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  lang?: string;
  themeColor?: string;
  openGraph?: OpenGraph;
  twitter?: TwitterCard;
  jsonLd?: unknown;
  tags?: MetaTag[];
  links?: LinkTag[];
}

export function mergeMeta(...layers: (PageMeta | undefined)[]): PageMeta {
  const out: PageMeta = {};
  for (const m of layers) {
    if (!m) {
      continue;
    }
    for (const key of Object.keys(m) as (keyof PageMeta)[]) {
      const v = m[key];
      if (v === undefined) {
        continue;
      }
      if (key === "openGraph" || key === "twitter") {
        out[key] = { ...(out[key] as object), ...(v as object) } as never;
      } else if (key === "tags" || key === "links") {
        out[key] = [...((out[key] as unknown[]) ?? []), ...(v as unknown[])] as never;
      } else {
        out[key] = v as never;
      }
    }
  }
  return out;
}

export function applySite(meta: PageMeta, siteUrl: string | undefined): PageMeta {
  if (!siteUrl) {
    return meta;
  }
  const abs = (value: string | undefined): string | undefined =>
    value !== undefined && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
      ? siteUrl + value
      : value;
  return {
    ...meta,
    canonical: abs(meta.canonical),
    openGraph: meta.openGraph
      ? { ...meta.openGraph, url: abs(meta.openGraph.url), image: abs(meta.openGraph.image) }
      : undefined,
    twitter: meta.twitter ? { ...meta.twitter, image: abs(meta.twitter.image) } : undefined,
  };
}

export function resolveTitle(meta: PageMeta): string {
  const title = meta.title ?? "";
  const tpl = meta.titleTemplate;
  if (!tpl || !tpl.includes("%s")) {
    return title;
  }
  if (title === "") {
    return tpl
      .replace(/\s*[|\-\u2013\u2014:\u00b7]?\s*%s\s*[|\-\u2013\u2014:\u00b7]?\s*/, " ")
      .trim();
  }
  return tpl.replace("%s", () => title);
}

export function resolveLang(meta: PageMeta): string {
  const lang = meta.lang ?? "en";
  return /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : "en";
}

function metaTag(attr: "name" | "property" | "http-equiv", key: string, content: string): string {
  return `<meta ${attr}="${escapeAttr(key)}" content="${escapeAttr(content)}">`;
}

export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => {
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

export function renderMeta(meta: PageMeta, opts: { nonce?: string } = {}): string {
  const parts: string[] = [`<title>${escapeHtml(resolveTitle(meta))}</title>`];
  if (meta.description !== undefined) {
    parts.push(metaTag("name", "description", meta.description));
  }
  if (meta.robots !== undefined) {
    parts.push(metaTag("name", "robots", meta.robots));
  }
  if (meta.themeColor !== undefined) {
    parts.push(metaTag("name", "theme-color", meta.themeColor));
  }
  if (meta.canonical !== undefined) {
    parts.push(`<link rel="canonical" href="${escapeAttr(meta.canonical)}">`);
  }
  const og = meta.openGraph;
  if (og) {
    const fields: [string, string | undefined][] = [
      ["og:title", og.title],
      ["og:description", og.description],
      ["og:type", og.type],
      ["og:url", og.url],
      ["og:image", og.image],
      ["og:image:alt", og.imageAlt],
      ["og:site_name", og.siteName],
      ["og:locale", og.locale],
    ];
    for (const [key, value] of fields) {
      if (value !== undefined) {
        parts.push(metaTag("property", key, value));
      }
    }
  }
  const tw = meta.twitter;
  if (tw) {
    const fields: [string, string | undefined][] = [
      ["twitter:card", tw.card],
      ["twitter:site", tw.site],
      ["twitter:creator", tw.creator],
      ["twitter:title", tw.title],
      ["twitter:description", tw.description],
      ["twitter:image", tw.image],
    ];
    for (const [key, value] of fields) {
      if (value !== undefined) {
        parts.push(metaTag("name", key, value));
      }
    }
  }
  for (const t of meta.tags ?? []) {
    if (t.name !== undefined) {
      parts.push(metaTag("name", t.name, t.content));
    } else if (t.property !== undefined) {
      parts.push(metaTag("property", t.property, t.content));
    } else if (t.httpEquiv !== undefined) {
      parts.push(metaTag("http-equiv", t.httpEquiv, t.content));
    }
  }
  for (const l of meta.links ?? []) {
    let tag = `<link rel="${escapeAttr(l.rel)}" href="${escapeAttr(l.href)}"`;
    for (const k of ["type", "sizes", "hreflang", "media"] as const) {
      if (l[k] !== undefined) {
        tag += ` ${k}="${escapeAttr(l[k])}"`;
      }
    }
    parts.push(tag + ">");
  }
  if (meta.jsonLd !== undefined) {
    const nonce = opts.nonce ? ` nonce="${escapeAttr(opts.nonce)}"` : "";
    parts.push(`<script type="application/ld+json"${nonce}>${scriptJson(meta.jsonLd)}</script>`);
  }
  return parts.join("");
}
