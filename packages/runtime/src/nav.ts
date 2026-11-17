import { isElement, type MParent } from "./dom.ts";
import { isUrlAttr, safeUrl } from "./escape.ts";

export const META_START = "<!--weft:meta-->";
export const META_END = "<!--/weft:meta-->";

const MAX_DOC = 2 * 1024 * 1024;
const PREFETCH_TTL = 15_000;
const PREFETCH_MAX = 8;
const HOVER_MS = 80;
const LIKELY_MAX = 5;
const LIKELY_DELAY_MS = 1500;

export function parseLikely(content: string | null): string[] {
  if (!content) return [];
  return content
    .split(/\s+/)
    .filter((p) => p.length > 0 && p.length <= 512 && /^\/(?![/\\])/.test(p))
    .slice(0, LIKELY_MAX);
}

const DROP = new Set(["SCRIPT", "BASE", "OBJECT", "EMBED"]);

export interface SplitDoc {
  lang: string | null;
  title: string;
  meta: string;
  body: string;
  live: string | null;
  csrf: string;
  transport: string | null;
  likely: string[];
}

export interface AnchorInfo {
  href: string | null;
  target: string | null;
  rel: string | null;
  download: boolean;
  reload: boolean;
}

export interface NavClick {
  target: unknown;
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  preventDefault(): void;
}

export interface HistoryApi {
  state: unknown;
  pushState(data: unknown, title: string, url?: string | null): void;
  replaceState(data: unknown, title: string, url?: string | null): void;
  scrollRestoration?: string;
}

export interface NavigationOptions {
  current(): URL;
  fetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<Response>;
  refreshHeaders?(): Record<string, string>;
  parse(html: string): MParent;
  morph(fragment: MParent): void;
  setMeta(metaHtml: string, lang: string | null, title: string): boolean;
  onPage?(page: SplitDoc): void;
  reload(url: string): void;
  scroll(): { x: number; y: number };
  scrollTo(pos: { x: number; y: number }): void;
  scrollToHash(hash: string): void;
  history: HistoryApi;
  listen(type: string, fn: (ev: NavClick) => void): () => void;
  now?(): number;
  saveData?(): boolean;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export interface Navigation {
  stop(): void;
  go(href: string, mode?: NavMode): Promise<boolean>;
  likely(paths: readonly string[]): void;
}

export type NavMode = "push" | "replace" | "skip" | "refresh";

interface CacheEntry {
  at: number;
  html: string;
  finalPath: string;
}

interface ScrollState {
  weft: 1;
  x: number;
  y: number;
}

export function navigationUrl(href: string, base: URL): URL | null {
  if (typeof href !== "string") {
    return null;
  }
  const trimmed = href.trim();
  if (trimmed === "" || /[\u0000-\u001f\u007f\\]/.test(trimmed)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== base.origin) {
    return null;
  }
  if (url.username !== "" || url.password !== "") {
    return null;
  }
  return url;
}

export function anchorFrom(node: unknown): AnchorInfo | null {
  let current = node as {
    nodeName?: string;
    parentNode?: unknown;
    isContentEditable?: boolean;
    getAttribute?(name: string): string | null;
  } | null;
  while (current) {
    if (current.isContentEditable) {
      return null;
    }
    const name = current.nodeName?.toUpperCase();
    if ((name === "A" || name === "AREA") && current.getAttribute) {
      const get = current.getAttribute.bind(current);
      return {
        href: get("href"),
        target: get("target"),
        rel: get("rel"),
        download: get("download") !== null,
        reload: get("data-weft-reload") !== null,
      };
    }
    current = (current.parentNode ?? null) as typeof current;
  }
  return null;
}

export function splitDocument(html: string): SplitDoc | null {
  if (typeof html !== "string" || html.length === 0 || html.length > MAX_DOC) {
    return null;
  }
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html;
  const start = head.indexOf(META_START);
  const end = head.indexOf(META_END);
  if (start < 0 || end < start) {
    return null;
  }
  const meta = head.slice(start + META_START.length, end);
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(meta);
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  const bodyClose = html.lastIndexOf("</body>");
  if (!bodyOpen || bodyClose < bodyOpen.index + bodyOpen[0].length) {
    return null;
  }
  const live = metaContent(head, "weft-live") || null;
  const csrf = metaContent(head, "weft-csrf");
  if (csrf === null) {
    return null;
  }
  const htmlTag = /<html\b[^>]*>/i.exec(head);
  const langMatch = htmlTag ? /\blang\s*=\s*["']([^"']+)["']/i.exec(htmlTag[0]) : null;
  const lang = langMatch && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(langMatch[1]) ? langMatch[1] : null;
  return {
    lang,
    title: titleMatch ? decodeEntities(titleMatch[1]) : "",
    meta,
    body: html.slice(bodyOpen.index + bodyOpen[0].length, bodyClose),
    live,
    csrf,
    transport: metaContent(head, "weft-transport"),
    likely: parseLikely(metaContent(head, "weft-likely")),
  };
}

export function sanitizeTree(root: MParent): void {
  for (const kid of Array.from(root.childNodes)) {
    if (!isElement(kid)) {
      continue;
    }
    if (DROP.has(kid.nodeName.toUpperCase())) {
      root.removeChild(kid);
      continue;
    }
    for (const { name, value } of Array.from(kid.attributes)) {
      const attr = name.toLowerCase();
      if (attr.startsWith("on") || attr === "srcdoc") {
        kid.removeAttribute(name);
        continue;
      }
      if (dangerousUrl(attr, value)) {
        kid.setAttribute(name, "#");
      }
    }
    sanitizeTree(kid);
  }
}

export function installNavigation(opts: NavigationOptions): Navigation {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const cache = new Map<string, CacheEntry>();
  let generation = 0;
  let inflight: AbortController | null = null;
  let hover: unknown = null;
  let likelyTimer: unknown = null;
  let stopped = false;
  let shown = opts.current().pathname + opts.current().search;

  if (opts.history.scrollRestoration !== undefined) {
    opts.history.scrollRestoration = "manual";
  }
  if (!readState(opts.history.state)) {
    opts.history.replaceState(blankState(), "");
  }

  const stops = [
    opts.listen("click", (ev) => {
      const raw = anchorFrom(ev.target)?.href;
      if (raw && /^(javascript|vbscript|data):/i.test(raw.replace(/[\u0000-\u001f\s]+/g, ""))) {
        ev.preventDefault();
        return;
      }
      const url = clickUrl(ev, opts.current());
      if (!url) {
        return;
      }
      ev.preventDefault();
      void go(url.href, "push");
    }),
    opts.listen("mouseover", (ev) => arm(ev)),
    opts.listen("focusin", (ev) => arm(ev)),
    opts.listen("popstate", () => {
      void go(opts.current().href, "skip");
    }),
  ];

  function arm(ev: NavClick): void {
    const url = clickUrl(ev, opts.current(), true);
    if (!url || opts.saveData?.()) {
      return;
    }
    if (hover !== null) {
      clearTimer(hover);
    }
    hover = setTimer(() => {
      hover = null;
      void prefetch(url);
    }, HOVER_MS);
  }

  async function prefetch(url: URL): Promise<void> {
    const key = cacheKey(url);
    const hit = cache.get(key);
    if (hit && now() - hit.at < PREFETCH_TTL) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), 5000);
    try {
      const res = await opts.fetch(url.pathname + url.search, {
        headers: { accept: "text/html", "x-weft-nav": "1", "x-weft-prefetch": "1" },
        signal: controller.signal,
      });
      if (!res.ok) {
        return;
      }
      const type = mediaType(res);
      const finalUrl = finalSameOrigin(res, url);
      if (type !== "text/html" || !finalUrl) {
        return;
      }
      const html = await res.text();
      if (!splitDocument(html)) {
        return;
      }
      cache.delete(key);
      cache.set(key, { at: now(), html, finalPath: finalUrl.pathname + finalUrl.search });
      while (cache.size > PREFETCH_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        cache.delete(oldest);
      }
    } catch {
      return;
    } finally {
      clearTimer(timer);
    }
  }

  function likely(paths: readonly string[]): void {
    if (likelyTimer !== null) {
      clearTimer(likelyTimer);
      likelyTimer = null;
    }
    if (stopped || paths.length === 0 || opts.saveData?.()) {
      return;
    }
    const base = opts.current();
    const here = base.pathname + base.search;
    const urls = paths
      .slice(0, LIKELY_MAX)
      .map((p) => navigationUrl(p, base))
      .filter((u): u is URL => u !== null && u.pathname + u.search !== here);
    if (urls.length === 0) {
      return;
    }
    const at = generation;
    likelyTimer = setTimer(() => {
      likelyTimer = null;
      void (async () => {
        for (const u of urls) {
          if (stopped || generation !== at) return;
          await prefetch(u);
        }
      })();
    }, LIKELY_DELAY_MS);
  }

  async function go(href: string, mode: NavMode = "push"): Promise<boolean> {
    if (likelyTimer !== null) {
      clearTimer(likelyTimer);
      likelyTimer = null;
    }
    const refresh = mode === "refresh";
    if (stopped) {
      return false;
    }
    const base = opts.current();
    const url = navigationUrl(href, base);
    if (!url) {
      opts.reload(href);
      return false;
    }
    if (!refresh && url.pathname + url.search === shown) {
      if (url.hash !== base.hash && mode !== "skip") {
        remember();
        const next = url.pathname + url.search + url.hash;
        if (mode === "replace") {
          opts.history.replaceState(blankState(), "", next);
        } else {
          opts.history.pushState(blankState(), "", next);
        }
      }
      opts.scrollToHash(url.hash);
      return true;
    }
    const id = ++generation;
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    const key = cacheKey(url);
    const cached = cache.get(key);
    let html: string | null = null;
    let landed = url;
    if (refresh) {
      cache.delete(key);
    }
    if (!refresh && cached && now() - cached.at < PREFETCH_TTL && cached.finalPath === url.pathname + url.search) {
      html = cached.html;
      cache.delete(key);
    } else {
      try {
        const res = await opts.fetch(url.pathname + url.search, {
          headers: { ...(refresh ? opts.refreshHeaders?.() : undefined), accept: "text/html", "x-weft-nav": "1" },
          signal: controller.signal,
        });
        if (id !== generation) {
          return false;
        }
        if (refresh && !res.ok) {
          return false;
        }
        const finalUrl = finalSameOrigin(res, url);
        const type = mediaType(res);
        const length = Number(res.headers.get("content-length") ?? "0");
        if (!finalUrl || type !== "text/html" || (Number.isFinite(length) && length > MAX_DOC)) {
          opts.reload(url.href);
          return false;
        }
        html = await res.text();
        landed = finalUrl;
      } catch (err) {
        if (id !== generation || aborted(err) || refresh) {
          return false;
        }
        opts.reload(url.href);
        return false;
      }
    }
    if (id !== generation || html === null) {
      return false;
    }
    const page = splitDocument(html);
    if (!page) {
      opts.reload(url.href);
      return false;
    }
    let fragment: MParent;
    try {
      fragment = opts.parse(page.body);
      sanitizeTree(fragment);
    } catch {
      opts.reload(url.href);
      return false;
    }
    if (!opts.setMeta(page.meta, page.lang, page.title)) {
      opts.reload(url.href);
      return false;
    }
    const next = landed.pathname + landed.search + (mode === "skip" ? opts.current().hash : landed.hash);
    const moved = landed.pathname + landed.search !== url.pathname + url.search;
    shown = landed.pathname + landed.search;
    if (refresh) {
      if (moved) {
        opts.history.replaceState(blankState(), "", next);
      }
      opts.morph(fragment);
      opts.onPage?.(page);
      likely(page.likely);
      if (moved) {
        opts.scrollTo({ x: 0, y: 0 });
      }
      return true;
    }
    if (mode === "skip") {
      opts.morph(fragment);
      opts.onPage?.(page);
      likely(page.likely);
      opts.scrollTo(readState(opts.history.state) ?? { x: 0, y: 0 });
      return true;
    }
    remember();
    if (mode === "replace") {
      opts.history.replaceState(blankState(), "", next);
    } else {
      opts.history.pushState(blankState(), "", next);
    }
    opts.morph(fragment);
    opts.onPage?.(page);
    likely(page.likely);
    if (landed.hash) {
      opts.scrollToHash(landed.hash);
    } else {
      opts.scrollTo({ x: 0, y: 0 });
    }
    return true;
  }

  function remember(): void {
    const pos = opts.scroll();
    opts.history.replaceState(
      {
        weft: 1,
        x: Number.isFinite(pos.x) ? pos.x : 0,
        y: Number.isFinite(pos.y) ? pos.y : 0,
      },
      "",
    );
  }

  return {
    go,
    likely,
    stop() {
      stopped = true;
      generation += 1;
      inflight?.abort();
      if (hover !== null) {
        clearTimer(hover);
      }
      if (likelyTimer !== null) {
        clearTimer(likelyTimer);
      }
      for (const stop of stops) {
        stop();
      }
    },
  };
}

function clickUrl(ev: NavClick, base: URL, prefetch = false): URL | null {
  if (!prefetch && ev.defaultPrevented) {
    return null;
  }
  if (ev.button !== undefined && ev.button !== 0) {
    return null;
  }
  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) {
    return null;
  }
  const anchor = anchorFrom(ev.target);
  if (!anchor?.href || anchor.download || anchor.reload) {
    return null;
  }
  const target = (anchor.target ?? "").toLowerCase();
  if (target !== "" && target !== "_self") {
    return null;
  }
  if ((anchor.rel ?? "").split(/\s+/).includes("external")) {
    return null;
  }
  return navigationUrl(anchor.href, base);
}

function cacheKey(url: URL): string {
  return url.origin + url.pathname + url.search;
}

function mediaType(res: Response): string {
  return (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

function finalSameOrigin(res: Response, requested: URL): URL | null {
  try {
    const finalUrl = new URL(res.url || requested.href);
    if (finalUrl.origin !== requested.origin || finalUrl.username !== "" || finalUrl.password !== "") {
      return null;
    }
    return finalUrl;
  } catch {
    return null;
  }
}

function aborted(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
}

function blankState(): ScrollState {
  return { weft: 1, x: 0, y: 0 };
}

function readState(value: unknown): { x: number; y: number } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const state = value as Record<string, unknown>;
  if (state.weft !== 1) {
    return null;
  }
  const x = typeof state.x === "number" && Number.isFinite(state.x) ? state.x : 0;
  const y = typeof state.y === "number" && Number.isFinite(state.y) ? state.y : 0;
  return { x, y };
}

function metaContent(html: string, name: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const found = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!found || found[1] !== name) {
      continue;
    }
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    return content ? decodeEntities(content[1]) : "";
  }
  return null;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
    const lower = entity.toLowerCase();
    if (named[lower]) {
      return named[lower];
    }
    if (entity[0] !== "#") {
      return all;
    }
    const hex = entity[1] === "x" || entity[1] === "X";
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) {
      return all;
    }
    return String.fromCodePoint(code);
  });
}

function dangerousUrl(attr: string, value: string): boolean {
  return isUrlAttr(attr) && safeUrl(value, attr) !== value;
}
