import {
  LIMITS,
  META_END,
  META_START,
  allStyles,
  decodeClientMessage,
  defineComponent,
  encode,
  escapeAttr,
  escapeHtml,
  isSafePath,
  isHandoff,
  HANDOFF_MAX,
  PROTOCOL_VERSION,
  HELD_FIELD,
  setComponentStyles,
  trustHtml,
  type ClientMessage,
  type Component,
  type ServerMessage,
} from "@weft-framework/runtime";
import { AsyncLocalStorage } from "node:async_hooks";
import { audit, changes, onReadDone, readOnlyActor, tenantOf, type ChangeFeed } from "@weft-framework/data";
import { actorLabel, decision, describe, devLog, frame, frameList, note, readsOf, type DevDecision, type DevLog, type DevSnapshot } from "./devtools.ts";
import { RECORDING_MAX, outcomeOf, redactPath, redactPayload, type Recording } from "./replay.ts";
import { addInspectHub, sessionKey } from "./inspect-hub.ts";
import { allowHeader, guardApiResponse, handlerFor, isApiMethod, isExternal, isUnsafeMethod, type ApiHandler, type ApiHandlers } from "./api.ts";
import type { PageContext } from "./context.ts";
import { isSiteUrl } from "./config.ts";
import {
  attachAuth,
  logout,
  MemorySessionStore,
  noteViewing,
  runsWhileViewing,
  signInWith,
  viewingAs,
  type AuthOptions,
  type AuthState,
  type LoginResult,
  type SessionInfo,
  type SessionRecord,
} from "./auth.ts";
import { identityFor as emailIdentity, type EmailSignIn } from "./email-signin.ts";
import { pkceChallenge, SignInError, type Identity, type Provider } from "./oauth.ts";
import { attachSeal, openWith, sealWith } from "./seal.ts";
import { compress, type CompressOptions } from "./compress.ts";
import { ActionError, decodeForm, decodeJson, heldCount, type Action, type Decoded } from "./action.ts";
import { createHash, createHmac } from "node:crypto";
import { LivePage, Redirect, type PageState, type Reload } from "./live.ts";
import { applySite, mergeMeta, renderMeta, resolveLang, resolveTitle, type PageMeta } from "./meta.ts";
import { copyHeaders, runMiddleware, withExtraHeaders, type Middleware } from "./middleware.ts";
import { checkSitemapOptions, robotsTxt, sitemapEntries, sitemapXml, type RobotsOptions, type SitemapOptions } from "./seo.ts";
import { Router, type Params } from "./router.ts";
import { assignRequestId, requestIdOf, type Logger } from "./log.ts";
import type { Span, Telemetry, TraceContext } from "./otel.ts";
import type { Uploads } from "./uploads.ts";
import { RegionWriteError, type Regions } from "./regions.ts";
import type { CheckedSamlConnection, Saml, SamlResult, SamlSessionRef } from "./saml.ts";
import { htmlAttributeMarkup, parseShell } from "./shell.ts";
import { addNoticeHub } from "./notice.ts";
import { sharedChange, sharedLeave, sharedMessage, type SharedFieldOptions } from "./shared.ts";
import { pointLeave, pointMessage } from "./pointers.ts";
import { currentSession, DepsIndex, type Deps, onStoreWrite, track, withSession } from "./sync.ts";
import { presenceAway, presenceBegin, presenceEnd, presenceHeld, presenceRelease, presenceStartAway } from "./presence.ts";
import {
  base64url,
  fromBase64url,
  MIN_SECRET_LENGTH,
  RateLimiter,
  csrfToken,
  importSecret,
  parseCookies,
  randomId,
  sameOrigin,
  securityHeaders,
  checkCspSources,
  mergeCspSources,
  type CspSources,
  sessionCookie,
  signSession,
  timingSafeEqual,
  verifyCsrf,
  verifySession,
  type Key,
  type RateLimitOptions,
} from "./security.ts";
import { checkPdfRoute, pdfFilename, type PdfPrinter, type PdfRouteOptions } from "./pdf.ts";
import { IMAGES_PATH, type Images } from "./images.ts";

const STYLES = "/_weft/styles.css";
const APP_CSS = "/_weft/app.css";

function contentVersion(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

let bundleCache: { css: string; version: string } | null = null;

function styleBundle(): { css: string; version: string } | null {
  const css = allStyles();
  if (!css) {
    return null;
  }
  if (bundleCache?.css !== css) {
    bundleCache = { css, version: contentVersion(css) };
  }
  return bundleCache;
}

export type { PageContext };

export class NotFound {
  readonly notFound = true;
}

export function notFound(): NotFound {
  return new NotFound();
}

export type MetaSource<D> = PageMeta | ((ctx: PageContext, data: D) => PageMeta | Promise<PageMeta>);

export interface Layout {
  component: Component<never>;
  meta?: MetaSource<undefined>;
}

export interface Route<P extends object = object> {
  component: Component<P>;
  load?(ctx: PageContext): P | Redirect | NotFound | Promise<P | Redirect | NotFound>;
  meta?: MetaSource<P>;
  title?: string;
  layouts?: readonly Layout[];
  status?: number;
  cache?: "etag";
  csp?: CspSources;
  pdf?: true | PdfRouteOptions;
  edge?: boolean;
  og?: Component<never> | OgImage;
}

const isComponent = (v: unknown): boolean => typeof v === "function" && "def" in v;

export interface OgImage {
  component: Component<never>;
  width?: number;
  height?: number;
}

export function checkOg(raw: unknown, where: string): Component<never> | OgImage {
  if (isComponent(raw)) return raw as Component<never>;
  const o = raw as Partial<OgImage> | null;
  const size = (n: unknown) => n === undefined || (Number.isInteger(n) && (n as number) >= 200 && (n as number) <= 2400);
  if (typeof o !== "object" || o === null || !isComponent(o.component) || !size(o.width) || !size(o.height) ||
    Object.keys(o).some((k) => k !== "component" && k !== "width" && k !== "height")) {
    throw new TypeError(`${where}: og is a component, or { component, width, height } with sizes 200-2400`);
  }
  return o as OgImage;
}

export function edgeReason(
  route: Route<never>,
  app: { middleware?: unknown; htmlAttributes?: unknown },
): string | null {
  if (route.edge === false) return "edge: false";
  if (route.load) return "load";
  if (typeof route.meta === "function" || route.layouts?.some((l) => typeof l.meta === "function")) return "meta from the request";
  if (route.cache === "etag") return 'cache: "etag"';
  if (route.status !== undefined && route.status !== 200) return `status ${route.status}`;
  if (route.edge !== true) {
    const mw = app.middleware;
    if (Array.isArray(mw) ? mw.length > 0 : mw !== undefined) return "middleware (the page may export `edge = true`)";
    if (app.htmlAttributes !== undefined) return "htmlAttributes (the page may export `edge = true`)";
  }
  return null;
}

const POSTS = /\/_weft\/action\/|<form\b[^>]*\bmethod\s*=\s*["']?post\b/i;

function hashInline(html: string, nonce: string): { html: string; script: string[]; style: string[] } | null {
  const attr = ` nonce="${escapeAttr(nonce)}"`;
  const script = new Set<string>();
  const style = new Set<string>();
  let ok = true;
  const out = html.replace(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi, (m, tag: string, attrs: string, body: string) => {
    if (!attrs.includes(attr)) return m;
    const rest = attrs.split(attr).join("");
    if (/\bsrc\s*=/i.test(rest)) ok = false;
    (tag.toLowerCase() === "script" ? script : style).add(`'sha256-${createHash("sha256").update(body).digest("base64")}'`);
    return `<${tag}${rest}>${body}</${tag}>`;
  });
  return ok && !out.includes(nonce) ? { html: out, script: [...script], style: [...style] } : null;
}

export interface CspViolation {
  route: string | null;
  directive: string;
  blocked: string;
  source: string | null;
}

export interface AppOptions {
  secret: string;
  routes: Record<string, Route<never>>;
  notFound?: Route<never>;
  error?: Route<never>;
  api?: Record<string, ApiHandlers>;
  middleware?: Middleware | readonly Middleware[];
  devtools?: boolean;
  patchBudget?: number | false;
  onPatchBudget?: (over: PatchOver) => void;
  queryWarnings?: { repeat?: number; rows?: number } | false;
  onQueryWarning?: (w: QueryWarning) => void;
  shell?: string;
  meta?: PageMeta;
  siteUrl?: string;
  sitemap?: SitemapOptions;
  robots?: RobotsOptions;
  files?(path: string, req: Request): Promise<Response | null> | Response | null;
  clientScript?: string;
  assets?: Record<string, string>;
  stylesheet?: string;
  htmlAttributes?: (req: Request) => Record<string, string | boolean | null | undefined>;
  componentStyles?: Record<string, string>;
  clientEntry?: string;
  immutableAssets?: boolean;
  transports?: readonly ("ws" | "sse")[];
  streamTimeoutMs?: number;
  instance?: string;
  stickyCookie?: string;
  auth?: AuthOptions;
  uploads?: Uploads<string>;
  regions?: Regions;
  compress?: boolean | CompressOptions;
  cookieName?: string;
  rateLimit?: RateLimitOptions;
  pageTtlMs?: number;
  maxPages?: number;
  maxPagesPerSession?: number;
  degrade?: {
    pages?: number;
    heapBytes?: number;
    onDegrade?(info: { route: string; reason: "pages" | "memory"; pages: number; heapBytes: number | null }): void;
  };
  heartbeatMs?: number;
  sync?: ChangeFeed | false;
  sharedFields?: SharedFieldOptions;
  offline?: { stale?: "run" | "refuse" };
  syncDelayMs?: number;
  presenceGraceMs?: number;
  actions?: Record<string, Action<never[]>>;
  maxActionBytes?: number;
  prefetch?: false | { links?: number; minVisits?: number; share?: number };
  csp?: CspSources;
  cspReport?: (violation: CspViolation) => void;
  pdf?: PdfPrinter;
  edge?: false | { maxAge?: number; stale?: number };
  images?: Images;
  maxApiBytes?: number;
  ready?: Record<string, () => unknown>;
  readyTimeoutMs?: number;
  logger?: Logger;
  trustRequestId?: boolean;
  onError?(err: unknown): void;
  reportError?(err: unknown, report: ErrorReport): void;
  telemetry?: Telemetry;
  now?(): number;
}

const READ_SPANS = 100;

interface ReadScope {
  trace: TraceContext | null;
  open: boolean;
  reads: number;
  models: Map<string, { reads: number; rows: number }> | null;
}

export interface QueryWarning {
  kind: "repeat" | "rows";
  route: string;
  cause: string;
  model: string;
  reads: number;
  rows: number;
}

export interface ErrorReport {
  kind: "page" | "event" | "action" | "api" | "upload" | "request";
  route?: string;
  component?: string;
  handler?: string;
  actor: string | null;
  requestId: string | null;
  method?: string;
  path?: string;
  instance: string;
}

export interface DrainOptions {
  delayMs?: number;
  timeoutMs?: number;
  handoff?: boolean;
}

export interface UpgradeServer {
  upgrade(req: Request, opts: { data: SocketData }): boolean;
}

export interface SocketData {
  lid: string;
  sid: string;
}

export interface LiveSocket {
  data: SocketData;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

export interface App {
  fetch(req: Request, server?: UpgradeServer): Promise<Response | undefined>;
  websocket: {
    open(ws: LiveSocket): void;
    message(ws: LiveSocket, data: string | Uint8Array): Promise<void>;
    close(ws: LiveSocket): void;
  };
  drain(opts?: DrainOptions): Promise<boolean>;
  close(): void;
}

interface Entry {
  page: LivePage;
  sid: string;
  seen: number;
  route: Route<never>;
  ctx: PageContext;
  deps: { load: Deps<Entry>; render: Deps<Entry> };
  sinks: Set<(msg: ServerMessage) => void>;
  attached: number;
  stale: boolean;
  version: number;
  foreign: boolean;
  reload: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  head: { meta: string; title: string; lang: string };
  awayTimer: ReturnType<typeof setTimeout> | null;
  sidKey?: string;
  dev?: DevLog;
  why?: string[];
  cost?: { events: number; refreshes: number; ms: number; bytes: number; dataBytes: number };
}

function jsonBytes(v: unknown): number {
  try {
    return (JSON.stringify(v)?.length ?? 0) * 2;
  } catch {
    return 0;
  }
}

function charge(e: Entry, kind: "events" | "refreshes", ms: number, outs: readonly ServerMessage[]): void {
  if (!e.cost) return;
  e.cost[kind]++;
  e.cost.ms += ms;
  for (const o of outs) e.cost.bytes += enc.encode(JSON.stringify(o)).length;
}

function because(e: Entry, cause: string): void {
  if (!e.dev) return;
  const why = (e.why ??= []);
  if (why.length < 5) {
    if (!why.includes(cause)) why.push(cause);
  } else if (why.length === 5) {
    why.push("and more");
  }
}

function changeCause(change: { op: string; model: string; key: unknown }, part: string): string {
  let key: string;
  try {
    key = JSON.stringify(change.key) ?? String(change.key);
  } catch {
    key = String(change.key);
  }
  if (key.length > 40) key = key.slice(0, 39) + "…";
  return `${change.op} ${change.model} ${key} (read in ${part})`;
}

interface Stream {
  entry: Entry;
  push(msg: ServerMessage): void;
}

const LIVE = "/_weft/live";
const ACTION = "/_weft/action/";
const SESSION = "/_weft/session";
const HEALTH = "/_weft/health";
const SITEMAP = "/sitemap.xml";
const ROBOTS = "/robots.txt";
const READY = "/_weft/ready";
const AUTH = "/_weft/auth/";
const DEV_VIEW_AS = "/_weft/dev/view-as";
const DEV_VIEW_MS = 3600_000;
const DEV_INSPECT = "/_weft/dev/inspect";
const DEV_FRAME = "/_weft/dev/frame";
const DEV_RECORDING = "/_weft/dev/recording";
const enc = new TextEncoder();

export interface PatchOver {
  route: string;
  cause: string;
  bytes: number;
  budget: number;
  components: { name: string; bytes: number }[];
}

export function createApp(opts: AppOptions): App {
  if (typeof opts.secret !== "string" || opts.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `@weft-framework/server: the secret must be at least ${MIN_SECRET_LENGTH} characters of random data`,
    );
  }
  if (opts.siteUrl !== undefined && !isSiteUrl(opts.siteUrl)) {
    throw new Error("@weft-framework/server: siteUrl must be an http(s) origin");
  }
  const keyP: Promise<Key> = importSecret(opts.secret);
  const handoffKeyP: Promise<CryptoKey> = crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(`weft-handoff\0${opts.secret}`))
    .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  const now = opts.now ?? Date.now;
  const ttl = opts.pageTtlMs ?? 30 * 60_000;
  const maxPages = opts.maxPages ?? 10_000;
  const maxPerSession = opts.maxPagesPerSession ?? 32;
  const degrade = opts.degrade;
  if (degrade !== undefined) {
    const { pages: p, heapBytes: h } = degrade;
    if (p !== undefined && (!Number.isInteger(p) || p < 1)) throw new Error("@weft-framework/server: degrade.pages is a positive integer");
    if (h !== undefined && (!Number.isFinite(h) || h < 16 * 1024 * 1024)) throw new Error("@weft-framework/server: degrade.heapBytes is at least 16 MiB");
  }
  let heap = { at: -Infinity, bytes: null as number | null };
  const heapUsed = (): number | null => {
    const t = now();
    if (t - heap.at >= 1000) {
      const mem = (globalThis as { process?: { memoryUsage?(): { heapUsed: number } } }).process?.memoryUsage;
      heap = { at: t, bytes: typeof mem === "function" ? mem().heapUsed : null };
    }
    return heap.bytes;
  };
  const degradedAt = new Map<string, number>();
  function overloaded(route: Route<never>): boolean {
    if (degrade === undefined) return false;
    let reason: "pages" | "memory" | null = null;
    if (degrade.pages !== undefined && pages.size >= degrade.pages) reason = "pages";
    const bytes = degrade.heapBytes === undefined ? null : heapUsed();
    if (reason === null && bytes !== null && bytes > degrade.heapBytes!) reason = "memory";
    if (reason === null) return false;
    const pattern = patternOf.get(route) ?? "unknown";
    const k = `${pattern} ${reason}`;
    const t = now();
    if (degrade.onDegrade && (degradedAt.get(k) ?? -Infinity) <= t - 60_000) {
      if (degradedAt.size >= 1000) degradedAt.clear();
      degradedAt.set(k, t);
      try {
        degrade.onDegrade({ route: pattern, reason, pages: pages.size, heapBytes: bytes });
      } catch (err) {
        onError(err);
      }
    }
    return true;
  }
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const limiter = new RateLimiter(opts.rateLimit ?? { capacity: 30, refillPerSecond: 10 });
  const apiLimiter = new RateLimiter(opts.rateLimit ?? { capacity: 60, refillPerSecond: 20 });
  const prefetchLimiter = new RateLimiter({ capacity: 8, refillPerSecond: 2 });
  const logger = opts.logger;
  const onError =
    opts.onError ?? (logger ? (err: unknown) => logger.error("unhandled error", { error: err }) : (err: unknown) => console.error("[weft]", err));
  const patchBudget = opts.patchBudget === undefined ? (opts.devtools ? 64 * 1024 : false) : opts.patchBudget;
  if (patchBudget !== false && (!Number.isInteger(patchBudget) || patchBudget < 1024)) {
    throw new Error("createApp: patchBudget is a whole number of bytes, at least 1024, or false");
  }
  const onPatchBudget =
    opts.onPatchBudget ??
    ((o: PatchOver) => {
      const text = `patch budget: ${o.cause} on ${o.route} sent ${o.bytes} bytes (budget ${o.budget})`;
      const top = o.components.map((c) => `${c.name} ${c.bytes}`).join(", ");
      if (logger) logger.warn(text, { components: top });
      else console.warn(`[weft] ${text}: ${top}`);
    });
  const budgetSeen = new Map<string, number>();
  const checkBudget = (e: Entry, cause: string, outs: readonly ServerMessage[]): void => {
    if (patchBudget === false) return;
    let bytes = 0;
    const by = new Map<string, number>();
    for (const o of outs) {
      if (o.t !== "patch") continue;
      const n = enc.encode(o.html).length;
      bytes += n;
      const name = e.page.componentOf(o.id) ?? "unknown";
      by.set(name, (by.get(name) ?? 0) + n);
    }
    if (bytes <= patchBudget) return;
    const components = [...by].map(([name, n]) => ({ name, bytes: n })).sort((a, b) => b.bytes - a.bytes);
    const route = patternOf.get(e.route) ?? "unknown";
    const key = `${route}\0${cause}\0${components[0]!.name}`;
    const at = Date.now();
    if ((budgetSeen.get(key) ?? -Infinity) > at - 60_000) return;
    budgetSeen.delete(key);
    if (budgetSeen.size >= 1000) budgetSeen.delete(budgetSeen.keys().next().value!);
    budgetSeen.set(key, at);
    if (e.dev) {
      const what = `patch budget: ${cause} sent ${bytes} bytes, budget ${patchBudget}`;
      note(e.dev.messages, { at, dir: "warn", what, out: components.map((c) => `${c.name} ${c.bytes} B`) });
    }
    try {
      onPatchBudget({ route, cause, bytes, budget: patchBudget, components });
    } catch (err) {
      onError(err);
    }
  };
  const untrackFiles = opts.uploads?.track(onError);

  const pages = new Map<string, Entry>();
  const readers = new DepsIndex<Entry>();

  interface CacheRec {
    key: string;
    tag: string;
    until: number;
    sid: string;
    deps: { load: Deps<CacheRec>; render: Deps<CacheRec> };
  }
  const ETAG_TTL = 60 * 60_000;
  const ETAG_MAX = 10_000;
  const cacheReaders = new DepsIndex<CacheRec>();
  const etags = new Map<string, CacheRec>();
  const uncachable = new Set<Route<never>>();
  const purge = (r: CacheRec): void => {
    if (etags.get(r.key) === r) etags.delete(r.key);
    r.deps.load.release();
    r.deps.render.release();
  };
  const etagKey = (req: Request, url: URL, sid: string): string =>
    createHash("sha256")
      .update(`${sid}\0${url.pathname}${url.search}\0${req.headers.get("accept-language") ?? ""}\0${req.headers.get("cookie") ?? ""}`)
      .digest("base64url");
  const matchesTag = (header: string | null, tag: string): boolean =>
    header !== null && header.split(",").some((t) => t.trim().replace(/^W\//, "") === `"${tag}"`);
  const streams = new Map<string, Stream>();

  function touch(lid: string, e: Entry): void {
    e.seen = now();
    pages.delete(lid);
    pages.set(lid, e);
  }

  let draining = false;
  let inFlight = 0;
  if (opts.sitemap) {
    if (!opts.siteUrl) throw new Error("createApp: sitemap needs siteUrl, the origin its URLs are on");
    checkSitemapOptions(opts.sitemap);
  }
  const robots = opts.robots
    ? robotsTxt(opts.robots, opts.sitemap ? new URL(SITEMAP, opts.siteUrl).href : undefined)
    : null;

  async function seoRequest(req: Request, path: string): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    }
    let body: string;
    let type: string;
    if (path === ROBOTS) {
      body = robots!;
      type = "text/plain; charset=utf-8";
    } else {
      try {
        const list = Object.entries(opts.routes).map(([pattern, r]) => ({ pattern, meta: r.meta }));
        body = sitemapXml(await sitemapEntries(opts.siteUrl!, list, opts.sitemap!));
      } catch (err) {
        onError(err);
        return status(500);
      }
      type = "application/xml; charset=utf-8";
    }
    return new Response(req.method === "HEAD" ? null : body, {
      headers: {
        "content-type": type,
        "cache-control": `public, max-age=${opts.sitemap?.maxAge ?? 3600}`,
        "x-content-type-options": "nosniff",
      },
    });
  }
  const readyChecks = Object.entries(opts.ready ?? {});
  for (const [name, check] of readyChecks) {
    if (typeof check !== "function") throw new Error(`createApp: ready check ${JSON.stringify(name)} is a function`);
  }
  const readyTimeoutMs = opts.readyTimeoutMs ?? 2000;
  if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 60_000) {
    throw new Error("createApp: readyTimeoutMs is 1 to 60 000");
  }

  async function readyNow(): Promise<boolean> {
    const results = await Promise.all(
      readyChecks.map(async ([name, check]) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${readyTimeoutMs} ms`)), readyTimeoutMs);
          });
          const value = await Promise.race([Promise.resolve().then(check), timeout]);
          if (value === false) throw new Error("returned false");
          return true;
        } catch (err) {
          onError(new Error(`ready check ${JSON.stringify(name)} failed: ${(err as Error)?.message ?? String(err)}`, { cause: err }));
          return false;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return results.every(Boolean);
  }

  const HELD_TTL = 24 * 60 * 60_000;
  const HELD_MAX = 4096;
  const heldKey = createHash("sha256").update("weft-held\0").update(opts.secret).digest();
  const heldMac = (sid: string, body: string): string =>
    createHmac("sha256", heldKey).update(`${sid}\0${body}`).digest("base64url");
  function sealHeld(sid: string, action: string, args: readonly unknown[]): string {
    const body = Buffer.from(JSON.stringify([action, now() + HELD_TTL, args])).toString("base64url");
    const token = `${body}.${heldMac(sid, body)}`;
    if (token.length > HELD_MAX) throw new Error(`@weft-framework/server: ${action}.with(..): the held values are too large`);
    return token;
  }
  function openHeld(sid: string, action: string, token: string | null): unknown[] | null {
    if (typeof token !== "string" || token.length > HELD_MAX) return null;
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    if (!timingSafeEqual(token.slice(dot + 1), heldMac(sid, body))) return null;
    try {
      const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
      if (!Array.isArray(v) || v.length !== 3 || v[0] !== action || typeof v[1] !== "number" || !Array.isArray(v[2])) return null;
      return v[1] > now() ? (v[2] as unknown[]) : null;
    } catch {
      return null;
    }
  }

  const HANDOFF_TTL = 5 * 60_000;
  const handoffBinding = (sid: string, url: URL): Uint8Array<ArrayBuffer> =>
    new TextEncoder().encode(`weft-handoff\0${sid}\0${url.pathname}${url.search}`);

  async function sealHandoff(e: Entry): Promise<string | null> {
    let state: PageState;
    try {
      state = e.page.snapshot();
    } catch {
      return null;
    }
    if (state.length === 0) return null;
    const json = JSON.stringify({ at: now(), s: state });
    if (json.length > HANDOFF_MAX) return null;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: handoffBinding(e.sid, e.ctx.url) },
        await handoffKeyP,
        new TextEncoder().encode(json),
      ),
    );
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    const token = base64url(out);
    return isHandoff(token) ? token : null;
  }

  async function openHandoff(token: string | null, sid: string, url: URL): Promise<PageState | null> {
    if (!isHandoff(token)) return null;
    const bytes = fromBase64url(token);
    if (!bytes || bytes.length < 12 + 16) return null;
    let text: string;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(bytes.slice(0, 12)), additionalData: handoffBinding(sid, url) },
        await handoffKeyP,
        new Uint8Array(bytes.slice(12)),
      );
      text = new TextDecoder().decode(plain);
    } catch {
      return null;
    }
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return null;
    }
    const o = v as { at?: unknown; s?: unknown };
    if (typeof o?.at !== "number" || !Array.isArray(o.s)) return null;
    const t = now();
    if (o.at > t + 60_000 || t - o.at > HANDOFF_TTL) return null;
    const ok = o.s.every(
      (x: unknown) =>
        Array.isArray(x) &&
        x.length === 4 &&
        typeof x[0] === "string" &&
        typeof x[1] === "string" &&
        Number.isInteger(x[2]) &&
        Array.isArray(x[3]) &&
        x[3].every((p: unknown) => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && p[0] >= 0),
    );
    return ok ? (o.s as PageState) : null;
  }

  function drop(lid: string, handoff?: string | null): void {
    const e = pages.get(lid);
    if (e?.timer) {
      clearTimeout(e.timer);
    }
    pages.delete(lid);
    if (e?.awayTimer) clearTimeout(e.awayTimer);
    if (e) presenceRelease(e.ctx);
    if (e) sharedLeave(e);
    if (e) pointLeave(e);
    e?.deps.load.release();
    e?.deps.render.release();
    for (const sink of e?.sinks ?? []) {
      try {
        sink(handoff ? { t: "expired", handoff } : { t: "expired" });
      } catch {
      }
    }
    e?.sinks.clear();
    e?.page.close();
  }

  function register(entry: Entry): void {
    const sid = entry.sid;
    const t = now();
    for (const [lid, e] of pages) {
      if (t - e.seen <= ttl) {
        break;
      }
      drop(lid);
    }
    let mine = 0;
    for (const e of pages.values()) {
      if (e.sid === sid) {
        mine += 1;
      }
    }
    if (mine >= maxPerSession) {
      const victim = idleOldest(sid);
      if (victim) {
        drop(victim);
      }
    }
    if (pages.size >= maxPages) {
      const victim = idleOldest(null);
      if (victim) {
        drop(victim);
      }
    }
    entry.seen = t;
    pages.set(entry.page.id, entry);
    entry.deps.load.adopt(entry);
    entry.deps.render.adopt(entry);
    live.add(entry.ctx);
    watchAway(entry);
  }

  const live = new WeakSet<PageContext>();

  const presenceGrace = opts.presenceGraceMs ?? 15_000;
  const staleMode = opts.offline?.stale ?? "run";
  if (staleMode !== "run" && staleMode !== "refuse") throw new Error("offline.stale must be \"run\" or \"refuse\"");

  function watchAway(e: Entry): void {
    if (e.sinks.size > 0 || e.awayTimer) return;
    e.awayTimer = setTimeout(() => {
      e.awayTimer = null;
      if (e.sinks.size === 0) presenceAway(e.ctx, true);
    }, presenceGrace);
    (e.awayTimer as { unref?(): void }).unref?.();
  }

  function pageFor(lid: string | null, sid: string | null): Entry | null {
    if (!lid || !sid) {
      return null;
    }
    const e = pages.get(lid);
    if (!e || e.sid !== sid) {
      return null;
    }
    if (now() - e.seen > ttl) {
      drop(lid);
      return null;
    }
    touch(lid, e);
    return e;
  }

  const cookieName = opts.cookieName ?? "weft_sid";
  const instance = opts.instance ?? randomId(6);

  const patternOf = new Map<unknown, string>();
  for (const [pattern, r] of Object.entries(opts.routes)) patternOf.set(r, pattern);
  for (const [pattern, h] of Object.entries(opts.api ?? {})) patternOf.set(h, pattern);
  const reported = new WeakSet<object>();
  const rethrown = new WeakSet<object>();
  const telemetry = opts.telemetry ?? null;
  const traces = new WeakMap<Request, TraceContext>();
  const routeOfReq = new WeakMap<Request, string>();
  const qw = opts.queryWarnings === undefined ? (opts.devtools ? {} : false) : opts.queryWarnings;
  const queryLimits = qw === false ? null : { repeat: qw.repeat ?? 10, rows: qw.rows ?? 5000 };
  if (
    queryLimits &&
    (!Number.isInteger(queryLimits.repeat) || queryLimits.repeat < 2 || !Number.isInteger(queryLimits.rows) || queryLimits.rows < 1)
  ) {
    throw new Error("createApp: queryWarnings.repeat is a whole number of at least 2, rows at least 1");
  }
  const onQueryWarning =
    opts.onQueryWarning ??
    ((w: QueryWarning) => {
      const text =
        w.kind === "repeat"
          ? `${w.cause} on ${w.route} read ${w.model} ${w.reads} times (an N+1? load the rows in one read)`
          : `${w.cause} on ${w.route} read ${w.rows} rows of ${w.model}`;
      if (logger) logger.warn(`query warning: ${text}`, { model: w.model, reads: w.reads, rows: w.rows });
      else console.warn(`[weft] query warning: ${text}`);
    });
  const queryWarned = new Map<string, number>();
  const checkReads = (scope: ReadScope, route: string, cause: string, dev: DevLog | undefined): void => {
    if (!queryLimits || !scope.models) return;
    for (const [model, t] of scope.models) {
      const kinds: QueryWarning["kind"][] = [];
      if (t.reads >= queryLimits.repeat) kinds.push("repeat");
      if (t.rows >= queryLimits.rows) kinds.push("rows");
      for (const kind of kinds) {
        const key = `${route}\0${cause}\0${model}\0${kind}`;
        const at = Date.now();
        if ((queryWarned.get(key) ?? -Infinity) > at - 60_000) continue;
        queryWarned.delete(key);
        if (queryWarned.size >= 1000) queryWarned.delete(queryWarned.keys().next().value!);
        queryWarned.set(key, at);
        const w: QueryWarning = { kind, route, cause, model, reads: t.reads, rows: t.rows };
        if (dev) {
          const what = kind === "repeat" ? `query warning: ${model} read ${t.reads} times` : `query warning: ${t.rows} rows of ${model}`;
          note(dev.messages, { at, dir: "warn", what: `${what} (${cause})`, out: [] });
        }
        try {
          onQueryWarning(w);
        } catch (err) {
          onError(err);
        }
      }
    }
  };
  const newScope = (trace: TraceContext | null): ReadScope | null =>
    readScope && (trace || queryLimits) ? { trace, open: true, reads: 0, models: queryLimits ? new Map() : null } : null;
  const readScope = telemetry?.span || queryLimits ? new AsyncLocalStorage<ReadScope>() : null;
  const unReads = readScope
    ? onReadDone((r) => {
        const scope = readScope.getStore();
        if (!scope || !scope.open) return;
        if (scope.models) {
          const t = scope.models.get(r.model) ?? { reads: 0, rows: 0 };
          t.reads += 1;
          t.rows += r.rows;
          scope.models.set(r.model, t);
        }
        if (!scope.trace || !telemetry?.span || ++scope.reads > READ_SPANS) return;
        const span = telemetry.span(`read ${r.model}`, {
          parent: scope.trace,
          elapsedMs: r.ms,
          attributes: { "weft.model": r.model, "weft.data.rows": r.rows, "weft.data.scoped": r.scoped },
        });
        span.end();
      })
    : null;

  function report(
    err: unknown,
    kind: ErrorReport["kind"],
    where: { route?: unknown; ctx?: PageContext | null; req?: Request | null; handler?: string } = {},
  ): void {
    if (err !== null && typeof err === "object") {
      if (reported.has(err)) return;
      reported.add(err);
    }
    const req = where.req ?? where.ctx?.request ?? null;
    const user = where.ctx?.user as { id?: unknown } | null | undefined;
    const id = user && (typeof user.id === "string" || typeof user.id === "number") ? String(user.id) : null;
    const route = where.route as Route<never> | undefined;
    const pattern = route ? patternOf.get(route) : undefined;
    const component = route && typeof route === "object" && "component" in route ? (route.component as { def?: { name?: unknown } }).def?.name : undefined;
    const info: ErrorReport = {
      kind,
      ...(pattern !== undefined ? { route: pattern } : {}),
      ...(typeof component === "string" && component !== "" ? { component } : {}),
      ...(where.handler ? { handler: where.handler } : {}),
      actor: id,
      requestId: req ? requestIdOf(req) : null,
      ...(req ? { method: req.method, path: new URL(req.url).pathname } : {}),
      instance,
    };
    if (!opts.onError && logger) {
      logger.error("unhandled error", { error: err, ...info });
    } else {
      try {
        onError(err);
      } catch (e) {
        if (e !== null && typeof e === "object") rethrown.add(e);
        throw e;
      }
    }
    if (opts.reportError) {
      try {
        opts.reportError(err, info);
      } catch (e) {
        onError(e);
      }
    }
    if (telemetry) {
      try {
        telemetry.error(err, info, (req && traces.get(req)) ?? null);
      } catch (e) {
        onError(e);
      }
    }
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(instance)) {
    throw new Error("@weft-framework/server: instance names are 1-64 of A-Z a-z 0-9 . _ -");
  }
  if (opts.stickyCookie !== undefined && (!/^[A-Za-z0-9_-]{1,64}$/.test(opts.stickyCookie) || opts.stickyCookie === cookieName)) {
    throw new Error("@weft-framework/server: stickyCookie must be a plain cookie name other than the session cookie");
  }
  function stamped(req: Request, res: Response, secure: boolean): Response {
    res.headers.set("x-weft-instance", instance);
    const sticky = opts.stickyCookie;
    if (sticky && parseCookies(req.headers.get("cookie"))[sticky] !== instance) {
      const parts = [`${sticky}=${instance}`, "Path=/", "HttpOnly", "SameSite=Lax"];
      if (secure) {
        parts.push("Secure");
      }
      res.headers.append("set-cookie", parts.join("; "));
    }
    return res;
  }
  const wsEnabled = (opts.transports ?? ["ws", "sse"]).includes("ws");
  const stateless = opts.transports !== undefined && opts.transports.length === 0;
  const edgeCache = opts.edge === false || opts.devtools ? null : { maxAge: opts.edge?.maxAge ?? 300, stale: opts.edge?.stale ?? 86_400 };
  if (edgeCache && ![edgeCache.maxAge, edgeCache.stale].every((n) => Number.isInteger(n) && n >= 0 && n <= 31_536_000)) {
    throw new RangeError("createApp: edge maxAge and stale are whole seconds, 0 to 31536000");
  }
  let shellShared = true;
  const unshared = (res: Response): Response => {
    if (!/\bs-maxage=/.test(res.headers.get("cache-control") ?? "")) return res;
    if (res.headers.has("set-cookie") || /\bcookie\b/i.test(res.headers.get("vary") ?? "")) {
      res.headers.set("cache-control", "private, no-store");
      res.headers.delete("etag");
    }
    return res;
  };
  const deadHandlers = new Set<Route<never>>();
  const assets = new Map<string, string>();
  for (const [path, source] of Object.entries(opts.assets ?? {})) {
    if (!path.startsWith("/_weft/") || path.startsWith(LIVE)) {
      throw new Error(`@weft-framework/server: asset paths must be under /_weft/: ${path}`);
    }
    assets.set(path, source);
  }
  if (opts.clientScript !== undefined) {
    assets.set("/_weft/client.js", opts.clientScript);
  }
  const clientEntry = opts.clientEntry ?? "/_weft/client.js";
  if (opts.clientEntry !== undefined && !assets.has(clientEntry)) {
    throw new Error(`@weft-framework/server: clientEntry ${clientEntry} is not among the assets`);
  }
  const assetCache = opts.immutableAssets ? "public, max-age=31536000, immutable" : "no-cache";
  if (opts.componentStyles) {
    setComponentStyles(opts.componentStyles);
  }
  const appCss = opts.stylesheet !== undefined ? { css: opts.stylesheet, version: contentVersion(opts.stylesheet) } : null;
  const appCssLink = appCss ? `<link rel="stylesheet" href="${APP_CSS}?v=${appCss.version}">` : "";

  async function sessionOf(req: Request): Promise<string | null> {
    const cookies = parseCookies(req.headers.get("cookie"));
    return verifySession(await keyP, cookies[cookieName]);
  }

  const authStore = opts.auth?.store ?? new MemorySessionStore();
  const devViewing = opts.devtools === true && process.env.NODE_ENV !== "production";
  const idleMs = opts.auth?.idleMs ?? 14 * 24 * 3600_000;
  const maxAgeMs = opts.auth?.maxAgeMs ?? 30 * 24 * 3600_000;
  const twoFactor = opts.auth?.twoFactor ?? null;
  if (twoFactor && (typeof twoFactor.needed !== "function" || !isSafePath(twoFactor.page))) {
    throw new Error("@weft-framework/server: auth.twoFactor is a `defineTwoFactor({...})` with a same-origin `page`");
  }
  const PENDING_MS = 10 * 60_000;

  async function publicSessionId(sid: string): Promise<string> {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`weft-session\n${sid}`));
    return base64url(new Uint8Array(d)).slice(0, 22);
  }

  async function dropSessionIds(ids: Set<string>): Promise<void> {
    const sids = new Set([...pages.values()].map((e) => e.sid));
    for (const sid of sids) {
      if (ids.has(await publicSessionId(sid))) dropSession(sid);
    }
  }

  const revocations = opts.auth?.revocations ?? null;
  if (revocations) {
    revocations.subscribe((message) => {
      let ids: unknown;
      try {
        const m = JSON.parse(message) as { v?: unknown; t?: unknown; ids?: unknown };
        ids = m?.v === 1 && m.t === "revoke" ? m.ids : null;
      } catch {
        return;
      }
      if (Array.isArray(ids) && ids.length <= 1000 && ids.every((x) => typeof x === "string")) {
        dropSessionIds(new Set(ids as string[])).catch(onError);
      }
    });
  }

  async function revokeSids(sids: string[]): Promise<void> {
    for (const sid of sids) {
      await authStore.delete(sid);
      dropSession(sid);
    }
    if (revocations && sids.length > 0) {
      const ids = await Promise.all(sids.map(publicSessionId));
      for (let i = 0; i < ids.length; i += 1000) {
        await revocations.publish(JSON.stringify({ v: 1, t: "revoke", ids: ids.slice(i, i + 1000) }));
      }
    }
  }

  function sessionsOf(user: string) {
    if (typeof authStore.forUser !== "function") {
      throw new Error("@weft-framework/server: this session store cannot list a user's sessions (it needs forUser)");
    }
    return authStore.forUser(user);
  }

  async function userOf(sid: string | null): Promise<unknown> {
    if (!sid) {
      return null;
    }
    const rec = await authStore.get(sid);
    if (!rec) {
      return null;
    }
    const t = now();
    if (rec.pending) {
      if (t - rec.created > PENDING_MS) {
        await authStore.delete(sid);
      }
      return null;
    }
    if (t - rec.seen > idleMs || t - rec.created > maxAgeMs) {
      await authStore.delete(sid);
      return null;
    }
    if (twoFactor && !rec.mfa && (await twoFactor.needed(rec.user, rec.tenant))) {
      const { mfa: _mfa, ...kept } = rec;
      await authStore.set(sid, { ...kept, created: t, seen: t, pending: true });
      return null;
    }
    if (t - rec.seen > Math.min(60_000, idleMs / 10)) {
      await authStore.set(sid, { ...rec, seen: t });
    }
    const actor = opts.auth?.user ? await opts.auth.user(rec.user, rec.tenant) : { id: rec.user };
    if (actor === null || actor === undefined) {
      await authStore.delete(sid);
      return null;
    }
    if (rec.viewAs) {
      const seen = await viewedBy(rec.user, rec.viewAs, t);
      if (seen) {
        return seen;
      }
      const { viewAs: _gone, ...kept } = rec;
      await authStore.set(sid, kept);
    }
    return actor;
  }

  async function viewedBy(operator: string, v: NonNullable<SessionRecord["viewAs"]>, t: number): Promise<object | null> {
    const hook = opts.auth?.viewAs;
    const dev = v.dev === true;
    if (dev ? !devViewing : typeof hook !== "function") return null;
    if (!(v.until > t) || v.user === operator) {
      return null;
    }
    try {
      if (!dev && (await hook!(operator, v.user)) !== true) {
        return null;
      }
      const target = opts.auth?.user ? await opts.auth.user(v.user, v.tenant) : { id: v.user };
      if (target === null || typeof target !== "object" || (v.tenant !== undefined && tenantOf(target) !== v.tenant)) {
        return null;
      }
      const ro = readOnlyActor(target as object, { via: operator });
      noteViewing(ro, { user: v.user, operator, until: v.until, ...(v.tenant !== undefined ? { tenant: v.tenant } : {}) });
      return ro;
    } catch (err) {
      onError(err);
      return null;
    }
  }

  function dropSession(sid: string): void {
    for (const [lid, e] of [...pages]) {
      if (e.sid === sid) {
        drop(lid);
      }
    }
  }

  interface Rotation {
    sid: string;
    cookie: string;
  }

  async function contextFor(
    req: Request,
    url: URL,
    params: Params,
    sid: string,
    refused: string | null,
    onRotate: (r: Rotation) => void = () => undefined,
  ): Promise<PageContext> {
    const ctx: PageContext = {
      request: req,
      url,
      params,
      query: url.searchParams,
      session: sid,
      user: await userOf(sid),
    };
    const rotate = async (user: string | null, o: { mfa?: boolean; tenant?: string; sso?: SessionRecord["sso"] } = {}): Promise<LoginResult> => {
      const pending = user !== null && !o.mfa && twoFactor !== null && (await twoFactor.needed(user, o.tenant));
      const old = ctx.session;
      const next = randomId(24);
      const t = now();
      await authStore.delete(old);
      if (user !== null) {
        const rec: SessionRecord = { user, created: t, seen: t };
        if (o.tenant !== undefined) rec.tenant = o.tenant;
        if (o.sso !== undefined) rec.sso = o.sso;
        const agent = req.headers.get("user-agent");
        if (agent) rec.agent = agent.slice(0, 256);
        if (pending) rec.pending = true;
        else if (o.mfa) rec.mfa = true;
        await authStore.set(next, rec);
      }
      dropSession(old);
      const value = await signSession(await keyP, next);
      const cookie = sessionCookie(cookieName, value, {
        secure: url.protocol === "https:",
        maxAgeSeconds: user !== null && !pending ? maxAgeMs / 1000 : undefined,
      });
      ctx.session = next;
      ctx.user = user !== null && !pending ? await userOf(next) : null;
      onRotate({ sid: next, cookie });
      return pending ? "two-factor" : "ok";
    };
    const state = async (): Promise<AuthState | null> => {
      const rec = await authStore.get(ctx.session);
      if (!rec) return null;
      if (rec.pending ? now() - rec.created > PENDING_MS : ctx.user === null) return null;
      const s: AuthState = { user: rec.user, pending: rec.pending === true, mfa: rec.mfa === true };
      if (rec.tenant !== undefined) s.tenant = rec.tenant;
      return s;
    };
    const switchTenant = async (tenant: string | null): Promise<boolean> => {
      const sid = ctx.session;
      const rec = ctx.user !== null ? await authStore.get(sid) : null;
      if (!rec || rec.viewAs) {
        return false;
      }
      const next: SessionRecord = { user: rec.user, created: rec.created, seen: rec.seen };
      if (rec.agent !== undefined) next.agent = rec.agent;
      if (rec.sso !== undefined) next.sso = rec.sso;
      if (tenant !== null) {
        next.tenant = tenant;
      }
      if (rec.mfa) {
        next.mfa = true;
      } else if (twoFactor && (await twoFactor.needed(next.user, next.tenant))) {
        return false;
      }
      const actor = opts.auth?.user ? await opts.auth.user(next.user, next.tenant) : { id: next.user };
      if (actor === null || actor === undefined || (tenant !== null && tenantOf(actor) !== tenant)) {
        return false;
      }
      await authStore.set(sid, next);
      reload(sid, actor);
      return true;
    };
    const reload = (sid: string, actor: unknown): void => {
      ctx.user = actor;
      for (const e of pages.values()) {
        if (e.sid === sid) {
          e.ctx.user = actor;
          because(e, "the session's actor changed (view as)");
          schedule(e, true);
        }
      }
    };
    const startViewAs = async (user: string, tenant: string | undefined, until: number): Promise<boolean> => {
      const sid = ctx.session;
      const rec = ctx.user !== null ? await authStore.get(sid) : null;
      if (!rec || rec.pending || rec.viewAs) {
        return false;
      }
      const v: NonNullable<SessionRecord["viewAs"]> = { user, until };
      if (tenant !== undefined) v.tenant = tenant;
      const seen = await viewedBy(rec.user, v, now());
      if (!seen) {
        return false;
      }
      await authStore.set(sid, { ...rec, viewAs: v });
      reload(sid, seen);
      return true;
    };
    const stopViewAs = async (): Promise<boolean> => {
      const sid = ctx.session;
      const rec = await authStore.get(sid);
      if (!rec || !rec.viewAs) {
        return false;
      }
      const { viewAs: _gone, ...kept } = rec;
      await authStore.set(sid, kept);
      reload(sid, await userOf(sid));
      return true;
    };
    attachAuth(ctx, {
      refused,
      login: (user, mfa) => rotate(user, { mfa }),
      logout: async () => {
        await rotate(null);
      },
      state,
      completeTwoFactor: async () => {
        const s = await state();
        if (!s) return false;
        const sso = (await authStore.get(ctx.session))?.sso;
        await rotate(s.user, { mfa: true, tenant: s.tenant, ...(sso ? { sso } : {}) });
        return true;
      },
      sessions: async () => {
        const me = await state();
        if (!me || me.pending) return [];
        const t = now();
        const out: SessionInfo[] = [];
        for (const { sid, record: r } of await sessionsOf(me.user)) {
          if (r.pending ? t - r.created > PENDING_MS : t - r.seen > idleMs || t - r.created > maxAgeMs) continue;
          out.push({
            id: await publicSessionId(sid),
            created: r.created,
            seen: r.seen,
            agent: r.agent ?? null,
            current: sid === ctx.session,
            mfa: r.mfa === true,
            pending: r.pending === true,
          });
        }
        return out.sort((a, b) => b.created - a.created);
      },
      revoke: async (user, o) => {
        const sids: string[] = [];
        for (const { sid, record } of await sessionsOf(user)) {
          if (record.user !== user || (o.keep && sid === ctx.session)) continue;
          if (o.id !== undefined && (await publicSessionId(sid)) !== o.id) continue;
          sids.push(sid);
        }
        await revokeSids(sids);
        if (sids.includes(ctx.session)) {
          await rotate(null);
        }
        return sids.length;
      },
      switchTenant,
      startViewAs,
      stopViewAs,
      signInWith: async (identity) => {
        const fn = opts.auth?.signIn;
        if (typeof fn !== "function") {
          throw new Error("@weft-framework/server: signing in by email or a provider needs auth.signIn(identity) to say which user it is");
        }
        const user = await fn(identity);
        if (user === null || user === undefined) {
          return "refused";
        }
        if (typeof user !== "string" || user === "") {
          throw new Error("@weft-framework/server: auth.signIn must return a user id string, or null to refuse");
        }
        return rotate(user);
      },
    });
    attachSeal(ctx, { key: () => keyP, session: () => ctx.session });
    return ctx;
  }

  const NOT_HERE = "only work in actions and in API handlers for POST, PUT, PATCH and DELETE";
  const VIEWING = "Read-only while viewing as another user";

  const providers = new Map<string, Provider>();
  for (const p of opts.auth?.providers ?? []) {
    if (providers.has(p.id)) {
      throw new Error(`@weft-framework/server: two sign-in providers are called ${p.id}`);
    }
    providers.set(p.id, p);
  }
  if (providers.size > 0 && typeof opts.auth?.signIn !== "function") {
    throw new Error("@weft-framework/server: sign-in providers need auth.signIn(identity) to say which user signs in");
  }
  const signInError = opts.auth?.signInError ?? "/";
  if (!isSafePath(signInError)) {
    throw new Error("@weft-framework/server: auth.signInError must be a same-origin path");
  }
  const SIGN_IN_COOKIE = "weft_signin";
  const SIGN_IN_TTL_MS = 10 * 60_000;
  const emailAuth = opts.auth?.email ?? null;
  if (providers.has("email")) {
    throw new Error("@weft-framework/server: the sign-in provider id `email` is taken by email sign-in");
  }
  if (emailAuth && typeof opts.auth?.signIn !== "function") {
    throw new Error("@weft-framework/server: email sign-in needs auth.signIn(identity) to say which user signs in");
  }
  const samlAuth = opts.auth?.saml ?? null;
  if (providers.has("saml")) {
    throw new Error("@weft-framework/server: the sign-in provider id `saml` is taken by SAML sign-in");
  }
  if (samlAuth && typeof opts.auth?.signIn !== "function") {
    throw new Error("@weft-framework/server: SAML sign-in needs auth.signIn(identity) to say which user signs in");
  }
  const samlKeyP: Promise<CryptoKey> = crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(`weft-saml\0${opts.secret}`))
    .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  const SAML_RESULT_TTL_MS = 2 * 60_000;
  const SAML_AAD = new TextEncoder().encode("weft-saml-result");
  async function sealSamlResult(value: unknown): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({ e: now() + SAML_RESULT_TTL_MS, v: value }));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: SAML_AAD }, await samlKeyP, plain));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return base64url(out);
  }
  async function openSamlResult(token: string | null): Promise<unknown> {
    if (token === null || token.length > 16_384) return null;
    const bytes = fromBase64url(token);
    if (!bytes || bytes.length < 12 + 16) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(bytes.slice(0, 12)), additionalData: SAML_AAD },
        await samlKeyP,
        new Uint8Array(bytes.slice(12)),
      );
      const p = JSON.parse(new TextDecoder().decode(plain)) as { e?: unknown; v?: unknown };
      return typeof p.e === "number" && p.e > now() ? p.v : null;
    } catch {
      return null;
    }
  }

  function authRedirect(location: string, cookies: string[]): Response {
    const h = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    for (const c of cookies) h.append("set-cookie", c);
    return new Response(null, { status: 303, headers: h });
  }

  function signedIn(outcome: LoginResult, next: unknown): string {
    const to = typeof next === "string" && isSafePath(next) ? next : "/";
    if (outcome !== "two-factor" || !twoFactor) return to;
    const page = new URL(twoFactor.page, "http://x");
    page.searchParams.set("next", to);
    return `${page.pathname}${page.search}`;
  }

  function signInFailure(code: "denied" | "failed" | "refused" | "expired", cookies: string[] = []): Response {
    const to = new URL(signInError, "http://x");
    to.searchParams.set("error", code);
    return authRedirect(`${to.pathname}${to.search}`, cookies);
  }

  async function emailRequest(req: Request, url: URL, sid: string | null, auth: EmailSignIn): Promise<Response> {
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    if (!sameOrigin(req)) {
      return status(403);
    }
    const buf = await readLimited(req, 4096);
    const token = buf ? new URLSearchParams(new TextDecoder().decode(buf)).get("t") ?? "" : "";
    const used = await auth.consume(token);
    if (!used) {
      return signInFailure("expired");
    }
    let rotated: Rotation | null = null;
    const ctx = await contextFor(req, url, {}, sid ?? randomId(24), null, (r) => (rotated = r));
    let outcome: LoginResult | "refused";
    try {
      outcome = await signInWith(ctx, emailIdentity(used.email));
    } catch (err) {
      onError(err);
      return signInFailure("failed");
    }
    if (outcome === "refused") {
      return signInFailure("refused");
    }
    const r = rotated as Rotation | null;
    return authRedirect(signedIn(outcome, used.next), r ? [r.cookie] : []);
  }

  async function signInRequest(req: Request, url: URL, path: string, sid: string | null): Promise<Response> {
    const rest = path.slice(AUTH.length).split("/");
    if (emailAuth && rest.length === 1 && rest[0] === "email") {
      return emailRequest(req, url, sid, emailAuth);
    }
    if (samlAuth && rest[0] === "saml") {
      return samlRequest(req, url, rest.slice(1), sid, samlAuth);
    }
    const provider = providers.get(rest[0]);
    const callback = rest.length === 2 && rest[1] === "callback";
    if (!provider || (rest.length !== 1 && !callback)) {
      return status(404);
    }
    if (req.method !== "GET") {
      return new Response(null, { status: 405, headers: { allow: "GET" } });
    }
    const key = await keyP;
    const secure = url.protocol === "https:";
    const base = opts.siteUrl ? new URL(opts.siteUrl).origin : url.origin;
    const redirectUri = `${base}${AUTH}${provider.id}/callback`;
    const flowCookie = (value: string, maxAge: number) =>
      `${SIGN_IN_COOKIE}=${value}; Path=${AUTH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
    const failed = (code: "denied" | "failed" | "refused"): Response => signInFailure(code, [flowCookie("", 0)]);

    if (!callback) {
      const site = req.headers.get("sec-fetch-site");
      if (site !== null && site !== "same-origin" && site !== "none") {
        return status(403);
      }
      const asked = url.searchParams.get("next");
      const next = asked !== null && isSafePath(asked) ? asked : "/";
      let session = sid;
      const cookies: string[] = [];
      if (!session) {
        session = randomId(24);
        cookies.push(sessionCookie(cookieName, await signSession(key, session), { secure }));
      }
      const flow = { p: provider.id, s: randomId(32), n: randomId(32), v: randomId(48), next };
      let location: string;
      try {
        location = await provider.authorize({ redirectUri, state: flow.s, nonce: flow.n, challenge: await pkceChallenge(flow.v) });
      } catch (err) {
        onError(err);
        return failed("failed");
      }
      const sealed = await sealWith(key, flow, { purpose: "signin", ttlMs: SIGN_IN_TTL_MS }, session);
      const res = authRedirect(location, [...cookies, flowCookie(sealed, SIGN_IN_TTL_MS / 1000)]);
      return new Response(null, { status: 302, headers: res.headers });
    }

    const opened = sid ? await openWith(key, parseCookies(req.headers.get("cookie"))[SIGN_IN_COOKIE], { purpose: "signin" }, sid) : null;
    const flow = opened?.value as { p?: unknown; s?: unknown; n?: unknown; v?: unknown; next?: unknown } | undefined;
    const state = url.searchParams.get("state");
    if (
      !sid ||
      !flow ||
      flow.p !== provider.id ||
      typeof flow.s !== "string" ||
      typeof flow.n !== "string" ||
      typeof flow.v !== "string" ||
      typeof flow.next !== "string" ||
      state === null ||
      !timingSafeEqual(state, flow.s)
    ) {
      return failed("failed");
    }
    const error = url.searchParams.get("error");
    if (error !== null) {
      return failed(error === "access_denied" ? "denied" : "failed");
    }
    const code = url.searchParams.get("code");
    if (code === null || code === "" || code.length > 4096) {
      return failed("failed");
    }
    let identity: Identity;
    try {
      identity = await provider.identify({ code, redirectUri, verifier: flow.v, nonce: flow.n });
    } catch (err) {
      onError(err);
      return failed(err instanceof SignInError ? err.code : "failed");
    }
    let rotated: Rotation | null = null;
    const ctx = await contextFor(req, url, {}, sid, null, (r) => (rotated = r));
    let outcome: LoginResult | "refused";
    try {
      outcome = await signInWith(ctx, identity);
    } catch (err) {
      onError(err);
      return failed("failed");
    }
    if (outcome === "refused") {
      return failed("refused");
    }
    const r = rotated as Rotation | null;
    return authRedirect(signedIn(outcome, flow.next), [flowCookie("", 0), ...(r ? [r.cookie] : [])]);
  }

  async function samlRequest(req: Request, url: URL, rest: string[], sid: string | null, saml: Saml): Promise<Response> {
    const [id, step] = rest;
    if (id === "logout" && step === undefined) {
      return samlLogout(req, url, sid, saml);
    }
    const steps = [undefined, "acs", "finish", "metadata", "slo"];
    if (id === undefined || rest.length > 2 || !steps.includes(step)) {
      return status(404);
    }
    const methods = step === "acs" ? ["POST"] : step === "slo" ? ["GET", "POST"] : ["GET"];
    if (!methods.includes(req.method)) {
      return new Response(null, { status: 405, headers: { allow: methods.join(", ") } });
    }
    const key = await keyP;
    const secure = url.protocol === "https:";
    const base = opts.siteUrl ? new URL(opts.siteUrl).origin : url.origin;
    const flowCookie = (value: string, maxAge: number) =>
      `${SIGN_IN_COOKIE}=${value}; Path=${AUTH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
    const failed = (code: "denied" | "failed" | "refused"): Response => signInFailure(code, [flowCookie("", 0)]);
    let conn: CheckedSamlConnection | null;
    try {
      conn = await saml.resolve(id);
    } catch (err) {
      onError(err);
      return step === "acs" || step === "finish" ? failed("failed") : status(500);
    }
    if (!conn) {
      return status(404);
    }
    const provider = `saml:${conn.id}`;

    if (step === "metadata") {
      return new Response(saml.metadata(base, conn), {
        headers: { "content-type": "application/samlmetadata+xml; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (step === "slo") {
      return samlSingleLogout(req, url, sid, saml, conn, base);
    }

    if (step === undefined) {
      const site = req.headers.get("sec-fetch-site");
      if (site !== null && site !== "same-origin" && site !== "none") {
        return status(403);
      }
      const asked = url.searchParams.get("next");
      const next = asked !== null && isSafePath(asked) ? asked : "/";
      let session = sid;
      const cookies: string[] = [];
      if (!session) {
        session = randomId(24);
        cookies.push(sessionCookie(cookieName, await signSession(key, session), { secure }));
      }
      const flow = { p: provider, r: saml.newRequestId(), next };
      let location: string;
      try {
        location = saml.authorize(conn, { requestId: flow.r, base });
      } catch (err) {
        onError(err);
        return failed("failed");
      }
      const sealed = await sealWith(key, flow, { purpose: "signin", ttlMs: SIGN_IN_TTL_MS }, session);
      const res = authRedirect(location, [...cookies, flowCookie(sealed, SIGN_IN_TTL_MS / 1000)]);
      return new Response(null, { status: 302, headers: res.headers });
    }

    if (step === "acs") {
      const buf = await readLimited(req, 512 * 1024 + 16_384);
      if (!buf) {
        return failed("failed");
      }
      const response = new URLSearchParams(new TextDecoder().decode(buf)).get("SAMLResponse");
      let result: SamlResult;
      try {
        result = saml.verify(conn, response ?? "", { base });
      } catch (err) {
        if (!(err instanceof SignInError)) onError(err);
        return failed(err instanceof SignInError ? err.code : "failed");
      }
      if (!(await saml.claim(`${conn.id}:${result.assertionId}`, result.expires))) {
        return failed("failed");
      }
      let identity = result.identity;
      let token = await sealSamlResult({ c: conn.id, r: result.inResponseTo, i: identity });
      if (token.length > 6000) {
        identity = { ...identity, claims: { ...identity.claims, attributes: {}, truncated: true } };
        token = await sealSamlResult({ c: conn.id, r: result.inResponseTo, i: identity });
      }
      return authRedirect(`${AUTH}saml/${conn.id}/finish?r=${token}`, []);
    }

    const opened = sid ? await openWith(key, parseCookies(req.headers.get("cookie"))[SIGN_IN_COOKIE], { purpose: "signin" }, sid) : null;
    const flow = opened?.value as { p?: unknown; r?: unknown; next?: unknown } | undefined;
    const got = (await openSamlResult(url.searchParams.get("r"))) as { c?: unknown; r?: unknown; i?: Identity } | null;
    if (
      !sid ||
      !flow ||
      !got ||
      flow.p !== provider ||
      typeof flow.r !== "string" ||
      typeof flow.next !== "string" ||
      got.c !== conn.id ||
      typeof got.r !== "string" ||
      typeof got.i !== "object" ||
      got.i === null ||
      !timingSafeEqual(got.r, flow.r) ||
      !(await saml.claim(`${conn.id}:finish:${flow.r}`, now() + SAML_RESULT_TTL_MS))
    ) {
      return failed("failed");
    }
    let rotated: Rotation | null = null;
    const ctx = await contextFor(req, url, {}, sid, null, (r) => (rotated = r));
    let outcome: LoginResult | "refused";
    try {
      outcome = await signInWith(ctx, got.i);
    } catch (err) {
      onError(err);
      return failed("failed");
    }
    if (outcome === "refused") {
      return failed("refused");
    }
    const r = rotated as Rotation | null;
    const ref = samlRef(got.i);
    if (r && ref) {
      const rec = await authStore.get(r.sid);
      if (rec) await authStore.set(r.sid, { ...rec, sso: ref });
    }
    return authRedirect(signedIn(outcome, flow.next), [flowCookie("", 0), ...(r ? [r.cookie] : [])]);
  }

  function samlRef(identity: Identity): SamlSessionRef | null {
    const k = identity.claims as Record<string, unknown>;
    if (typeof k.connection !== "string" || typeof k.nameId !== "string") return null;
    const ref: SamlSessionRef = {
      c: k.connection,
      n: k.nameId,
      f: typeof k.nameIdFormat === "string" ? k.nameIdFormat : null,
      s: typeof k.sessionIndex === "string" ? k.sessionIndex : null,
    };
    if (typeof k.nameQualifier === "string") ref.nq = k.nameQualifier;
    if (typeof k.spNameQualifier === "string") ref.spnq = k.spNameQualifier;
    return ref;
  }

  const SAML_LOGOUT_COOKIE = "weft_saml_logout";

  async function samlLogout(req: Request, url: URL, sid: string | null, saml: Saml): Promise<Response> {
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    if (!sameOrigin(req)) {
      return status(403);
    }
    const buf = await readLimited(req, 4096);
    const asked = buf ? new URLSearchParams(new TextDecoder().decode(buf)).get("next") : null;
    const next = asked !== null && isSafePath(asked) ? asked : "/";
    const rec = sid ? await authStore.get(sid) : null;
    const ref = rec?.sso;
    let rotated: Rotation | null = null;
    const ctx = await contextFor(req, url, {}, sid ?? randomId(24), null, (r) => (rotated = r));
    await logout(ctx);
    const r = rotated as Rotation | null;
    const cookies = r ? [r.cookie] : [];
    let conn: CheckedSamlConnection | null = null;
    try {
      conn = ref ? await saml.resolve(ref.c) : null;
    } catch (err) {
      onError(err);
    }
    if (!ref || !conn) {
      return authRedirect(next, cookies);
    }
    const base = opts.siteUrl ? new URL(opts.siteUrl).origin : url.origin;
    const requestId = saml.newRequestId();
    let location: string | null;
    try {
      location = saml.logoutRequest(conn, ref, { requestId, base });
    } catch (err) {
      onError(err);
      location = null;
    }
    if (location === null) {
      return authRedirect(next, cookies);
    }
    const flow = await sealWith(await keyP, { c: conn.id, r: requestId, next }, { purpose: "saml-logout", ttlMs: SIGN_IN_TTL_MS });
    const secure = url.protocol === "https:";
    cookies.push(`${SAML_LOGOUT_COOKIE}=${flow}; Path=${AUTH}saml/; HttpOnly; SameSite=Lax; Max-Age=${SIGN_IN_TTL_MS / 1000}${secure ? "; Secure" : ""}`);
    return authRedirect(location, cookies);
  }

  async function samlSingleLogout(req: Request, url: URL, sid: string | null, saml: Saml, conn: CheckedSamlConnection, base: string): Promise<Response> {
    let form: URLSearchParams | null = null;
    if (req.method === "POST") {
      const buf = await readLimited(req, 512 * 1024 + 16_384);
      if (!buf) return status(413);
      form = new URLSearchParams(new TextDecoder().decode(buf));
    }
    const secure = url.protocol === "https:";
    const clear = `${SAML_LOGOUT_COOKIE}=; Path=${AUTH}saml/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
    let msg: ReturnType<Saml["readLogout"]>;
    try {
      msg = saml.readLogout(conn, { search: url.search, form, base });
    } catch (err) {
      if (!(err instanceof SignInError)) onError(err);
      const isResponse = form ? form.has("SAMLResponse") : url.searchParams.has("SAMLResponse");
      return isResponse ? authRedirect("/", [clear]) : status(400);
    }

    if (msg.kind === "response") {
      const opened = await openWith(await keyP, parseCookies(req.headers.get("cookie"))[SAML_LOGOUT_COOKIE], { purpose: "saml-logout" });
      const flow = opened?.value as { c?: unknown; r?: unknown; next?: unknown } | undefined;
      const ours = flow && flow.c === conn.id && typeof flow.r === "string" && msg.inResponseTo !== null && timingSafeEqual(msg.inResponseTo, flow.r);
      const next = ours && typeof flow.next === "string" && isSafePath(flow.next) ? flow.next : "/";
      return authRedirect(next, [clear]);
    }

    if (!(await saml.claim(`${conn.id}:slo:${msg.id}`, msg.expires))) {
      return status(400);
    }
    const matches = (ref: SessionRecord["sso"]) =>
      ref !== undefined && ref.c === conn.id && ref.n === msg.nameId && (msg.sessionIndexes.length === 0 || (ref.s !== null && msg.sessionIndexes.includes(ref.s)));
    const cookies: string[] = [];
    const mine = sid ? await authStore.get(sid) : null;
    if (sid && mine && matches(mine.sso)) {
      let rotated: Rotation | null = null;
      const ctx = await contextFor(req, url, {}, sid, null, (r) => (rotated = r));
      await logout(ctx);
      const r = rotated as Rotation | null;
      if (r) cookies.push(r.cookie);
    }
    try {
      const user = await saml.userFor({ connection: conn.id, tenant: conn.tenant ?? null, nameId: msg.nameId, sessionIndexes: msg.sessionIndexes });
      if (user !== null) {
        const sids: string[] = [];
        for (const { sid: s, record } of await sessionsOf(user)) {
          if (record.user === user && matches(record.sso)) sids.push(s);
        }
        await revokeSids(sids);
      }
    } catch (err) {
      onError(err);
    }
    const location = saml.logoutResponse(conn, { inResponseTo: msg.id, base, relay: msg.relay });
    if (location === null) {
      return new Response(null, { status: 204, headers: cookies.length ? { "set-cookie": cookies[0]! } : {} });
    }
    return authRedirect(location, cookies);
  }

  const router = new Router<Route<never>>(opts.routes);

  const appCsp = opts.csp === undefined ? undefined : checkCspSources(opts.csp, "createApp");
  const cspByRoute = new Map<Route<never>, CspSources>();
  for (const [pattern, route] of Object.entries(opts.routes)) {
    const own = route.csp === undefined ? undefined : checkCspSources(route.csp, `route ${pattern}`);
    cspByRoute.set(route as Route<never>, mergeCspSources(appCsp, own));
  }
  const cspSourcesOf = (route: Route<never>): CspSources => cspByRoute.get(route) ?? appCsp ?? {};
  for (const [pattern, route] of Object.entries(opts.routes)) {
    if (route.pdf !== undefined) checkPdfRoute(route.pdf, `route ${pattern}`);
    if (route.og !== undefined) {
      checkOg(route.og, `route ${pattern}`);
      if (!opts.pdf?.capture) throw new TypeError(`route ${pattern}: og images are drawn by the \`pdf\` printer (src/pdf.ts: export const pdf = definePdf())`);
    }
  }
  const pdfLimiter = new RateLimiter({ capacity: 3, refillPerSecond: 0.1 });
  async function printRoute(req: Request, url: URL, path: string, spec: true | PdfRouteOptions, sid: string | null): Promise<Response> {
    if (!pdfLimiter.take(sid ?? "anon")) return status(429);
    const forward = (h: Headers) => {
      const out = new Headers();
      for (const name of ["cookie", "accept-language", "user-agent"]) {
        const v = h.get(name);
        if (v !== null) out.set(name, v);
      }
      return out;
    };
    const pageUrl = `${url.origin}${path.slice(0, -4)}${url.search}`;
    const inner = new Request(pageUrl, { headers: forward(req.headers) });
    PRINTING.add(inner);
    const res = (await app.fetch(inner)) ?? status(404);
    if (res.status !== 200 || !(res.headers.get("content-type") ?? "").startsWith("text/html")) return res;
    const html = await res.text();
    let bytes: Uint8Array;
    try {
      bytes = await opts.pdf!.print({
        url: pageUrl,
        html,
        fetch: async (u) => (await app.fetch(new Request(u, { headers: forward(req.headers) }))) ?? status(404),
        ...(spec === true ? {} : { format: spec.format, landscape: spec.landscape }),
      });
    } catch (err) {
      onError(err);
      return new Response("This page could not be printed right now.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const headers = new Headers({
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${pdfFilename(path.slice(0, -4), spec)}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const cookie = res.headers.get("set-cookie");
    if (cookie) headers.set("set-cookie", cookie);
    return new Response(bytes as BodyInit, { headers });
  }
  const ogLimiter = new RateLimiter({ capacity: 10, refillPerSecond: 0.5 });
  const ogCache = new Map<string, { tag: string; png: Uint8Array }>();
  let ogHeld = 0;
  async function ogImage(req: Request, url: URL, path: string, spec: Component<never> | OgImage): Promise<Response> {
    const card = isComponent(spec) ? { component: spec as Component<never> } : (spec as OgImage);
    const pageUrl = `${url.origin}${path.slice(0, -".og.png".length) || "/"}`;
    const inner = new Request(pageUrl);
    OG_RENDER.set(inner, card.component as Component<object>);
    const res = (await app.fetch(inner)) ?? status(404);
    if (res.status !== 200 || !(res.headers.get("content-type") ?? "").startsWith("text/html")) {
      await res.body?.cancel();
      return status(res.status === 200 ? 404 : res.status);
    }
    const html = await res.text();
    const drawn = html.replace(/ nonce="[^"]*"/g, "").replace(/<meta name="weft-csrf" content="[^"]*">/g, "");
    const tag = createHash("sha256").update(drawn).digest("base64url").slice(0, 27);
    const headers = {
      "content-type": "image/png",
      etag: `"${tag}"`,
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    };
    if (matchesTag(req.headers.get("if-none-match"), tag)) return new Response(null, { status: 304, headers });
    let hit = ogCache.get(path);
    if (hit?.tag !== tag) {
      if (!ogLimiter.take("og")) return status(429);
      const anon = async (u: string) => (await app.fetch(new Request(u))) ?? status(404);
      let png: Uint8Array;
      try {
        png = await opts.pdf!.capture!({ url: pageUrl, html, fetch: anon, width: card.width ?? 1200, height: card.height ?? 630 });
      } catch (err) {
        onError(err);
        return new Response("This image could not be drawn right now.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "30" },
        });
      }
      if (hit) ogHeld -= hit.png.byteLength;
      ogCache.delete(path);
      hit = { tag, png };
      ogCache.set(path, hit);
      ogHeld += png.byteLength;
      for (const [k, v] of ogCache) {
        if (ogHeld <= 32 * 1024 * 1024 && ogCache.size <= 256) break;
        ogCache.delete(k);
        ogHeld -= v.png.byteLength;
      }
    }
    return new Response(req.method === "HEAD" ? null : (hit.png as BodyInit), { headers });
  }

  const onCspReport =
    opts.cspReport ??
    (opts.devtools
      ? (v: CspViolation) => {
          const key = CSP_KEY_OF[v.directive.replace(/-elem$|-attr$/, "")];
          const fix =
            key && /^[a-z]+:\/\//.test(v.blocked)
              ? `; if this page needs it, add "${v.blocked}" to csp.${key} on ${v.route ?? "the route"}`
              : "";
          console.warn(`[weft] csp: ${v.route ?? "a page"} blocked ${v.blocked} (${v.directive})${v.source ? ` from ${v.source}` : ""}${fix}`);
        }
      : null);
  const cspReportLimiter = new RateLimiter({ capacity: 20, refillPerSecond: 1 });

  const likelyOpts = opts.prefetch === false ? null : (opts.prefetch ?? {});
  const likelyLinks = likelyOpts?.links ?? 2;
  const likelyMin = likelyOpts?.minVisits ?? 20;
  const likelyShare = likelyOpts?.share ?? 0.2;
  if (likelyOpts) {
    if (!Number.isInteger(likelyLinks) || likelyLinks < 1 || likelyLinks > 5) throw new RangeError("prefetch.links is a whole number from 1 to 5");
    if (!Number.isInteger(likelyMin) || likelyMin < 1) throw new RangeError("prefetch.minVisits is a whole number, 1 or more");
    if (!(likelyShare > 0 && likelyShare <= 1)) throw new RangeError("prefetch.share is a number above 0, at most 1");
  }
  const transitions = new Map<string, { total: number; to: Map<string, number> }>();
  const patternAt = (path: string): string | undefined => {
    const found = router.match(path);
    return found ? patternOf.get(found.route.value) : undefined;
  };
  function noteVisit(req: Request, url: URL, to: string): void {
    if (!likelyOpts) return;
    let from: URL;
    try {
      from = new URL(req.headers.get("referer") ?? "");
    } catch {
      return;
    }
    if (from.origin !== url.origin || from.pathname === url.pathname) return;
    const pattern = patternAt(from.pathname);
    if (pattern === undefined) return;
    let t = transitions.get(pattern);
    if (!t) transitions.set(pattern, (t = { total: 0, to: new Map() }));
    t.total += 1;
    t.to.set(to, (t.to.get(to) ?? 0) + 1);
    if (t.total > 10_000) {
      t.total = 0;
      for (const [k, n] of t.to) {
        const half = Math.floor(n / 2);
        if (half === 0) t.to.delete(k);
        else t.to.set(k, half);
        t.total += half;
      }
    }
    if (t.to.size > 32) {
      const least = [...t.to].sort((a, b) => a[1] - b[1])[0]!;
      t.to.delete(least[0]);
      t.total -= least[1];
    }
  }
  function likelyFrom(route: Route<never>, body: string, url: URL): string[] {
    if (!likelyOpts) return [];
    const from = patternOf.get(route);
    const t = from === undefined ? undefined : transitions.get(from);
    if (!t || t.total < likelyMin) return [];
    const scored: { path: string; score: number; at: number }[] = [];
    const seen = new Set<string>([url.pathname + url.search]);
    for (const m of body.matchAll(/<a\b[^>]*?\shref="([^"]{1,512})"/g)) {
      let to: URL;
      try {
        to = new URL(m[1]!.replaceAll("&amp;", "&"), url);
      } catch {
        continue;
      }
      const path = to.pathname + to.search;
      if (to.origin !== url.origin || seen.has(path)) continue;
      seen.add(path);
      const pattern = patternAt(to.pathname);
      const share = pattern === undefined ? 0 : (t.to.get(pattern) ?? 0) / t.total;
      if (share >= likelyShare) scored.push({ path, score: share, at: scored.length });
      if (seen.size > 500) break;
    }
    return scored
      .sort((a, b) => b.score - a.score || a.at - b.at)
      .slice(0, likelyLinks)
      .map((s) => s.path);
  }
  const apiRouter = new Router<ApiHandlers>(opts.api ?? {});
  const shell = parseShell(opts.shell);

  function idleOldest(sid: string | null): string | null {
    let fallback: string | null = null;
    for (const [lid, e] of pages) {
      if (sid !== null && e.sid !== sid) {
        continue;
      }
      fallback ??= lid;
      if (e.sinks.size === 0) {
        return lid;
      }
    }
    return fallback;
  }

  async function resolveMeta<D>(src: MetaSource<D> | undefined, ctx: PageContext, data: D): Promise<PageMeta | undefined> {
    return typeof src === "function" ? await src(ctx, data) : src;
  }

  function composeRoot(route: Route<never>, ctx: PageContext): Component<object> {
    const page = route.component as Component<object>;
    const layouts = (route.layouts ?? []).map((l) => l.component as unknown as Component<object>);
    return defineComponent(
      "Root",
      (props: object) => ({
        handlers: {},
        render: () => {
          let html = page(props);
          for (let i = layouts.length - 1; i >= 0; i--) {
            html = layouts[i]({ children: trustHtml(html), path: ctx.url.pathname, params: ctx.params });
          }
          return html;
        },
      }),
      { inert: true },
    );
  }

  async function renderPage(
    req: Request,
    route: Route<never>,
    params: Params,
    status = 200,
    depth: "page" | "error" = "page",
  ): Promise<Response> {
    let made: PageContext | null = null;
    try {
      return await renderDocument(req, route, params, status, depth, (c) => {
        made = c;
        if (isPrefetch(req)) presenceStartAway(c);
      });
    } catch (err) {
      if (err instanceof RegionWriteError && opts.regions && !opts.regions.isPrimary && depth === "page") {
        opts.regions.remember(route);
        return await opts.regions.forward(req);
      }
      report(err, "page", { route, ctx: made, req });
      if (depth === "error" || !opts.error) {
        throw err;
      }
      try {
        return await renderPage(req, opts.error, {}, 500, "error");
      } catch (again) {
        report(again, "page", { route: opts.error, req });
        return serverError(new URL(req.url).protocol === "https:");
      }
    } finally {
      if (made && !live.has(made)) presenceRelease(made);
    }
  }

  async function renderDocument(
    req: Request,
    route: Route<never>,
    params: Params,
    status: number,
    depth: "page" | "error",
    onCtx: (ctx: PageContext) => void,
  ): Promise<Response> {
    const key = await keyP;
    const url = new URL(req.url);
    const secure = url.protocol === "https:";
    let sid = await sessionOf(req);
    let setCookie: string | null = null;
    if (!sid) {
      sid = randomId(24);
      setCookie = sessionCookie(cookieName, await signSession(key, sid), { secure });
    }
    const etagRoute =
      route.cache === "etag" && feed !== null && !setCookie && depth === "page" && status === 200 &&
      (req.method === "GET" || req.method === "HEAD") && !uncachable.has(route);
    const cacheKey = etagRoute ? etagKey(req, url, sid) : "";
    if (etagRoute) {
      const held = etags.get(cacheKey);
      if (held && held.until <= now()) purge(held);
      else if (held && matchesTag(req.headers.get("if-none-match"), held.tag)) {
        return stamped(req, new Response(null, {
          status: 304,
          headers: { etag: `"${held.tag}"`, "cache-control": "private, no-cache", vary: "Cookie, Accept-Language" },
        }), secure);
      }
    }
    const ctx = await contextFor(req, url, params, sid, NOT_HERE);
    onCtx(ctx);
    const withCookie = (res: Response): Response => {
      if (setCookie) {
        res.headers.append("set-cookie", setCookie);
      }
      return stamped(req, res, secure);
    };

    const ogCard = OG_RENDER.get(req);
    const printing = PRINTING.has(req) || ogCard !== undefined;
    const oneShot = stateless || printing || overloaded(route);
    const deps = (etagRoute
      ? { load: cacheReaders.deps(), render: cacheReaders.deps() }
      : { load: readers.deps(), render: readers.deps() }) as { load: Deps<Entry>; render: Deps<Entry> };
    const loaded = await runLoad(route, ctx, deps);
    if (loaded instanceof Redirect) {
      return withCookie(new Response(null, { status: 303, headers: { location: loaded.to } }));
    }
    if (loaded instanceof NotFound) {
      if (!opts.notFound || route === opts.notFound) {
        return withCookie(status404());
      }
      return renderPage(req, opts.notFound, params, 404);
    }
    const props = { ...params, ...(loaded as object) };

    const meta = await pageMeta(route, ctx, props);

    const root = ogCard ?? (route.layouts?.length ? composeRoot(route, ctx) : (route.component as Component<object>));
    let entry: Entry | null = null;
    const stream = { open: false, dirty: false, wake: null as (() => void) | null };
    const restore =
      !setCookie && req.headers.get("x-weft-nav") === "1"
        ? await openHandoff(req.headers.get("x-weft-handoff"), sid, url)
        : null;
    let sealed = false;
    const page = new LivePage(root, props, {
      ...(restore ? { restore } : {}),
      sealArgs: (action, args) => {
        sealed = true;
        return sealHeld(sid, action, args);
      },
      onError: (err, msg) => report(err, "event", { route, ctx, ...(msg ? { handler: msg.handler } : {}) }),
      onInvalidate: () => {
        if (stream.open) {
          stream.dirty = true;
          const wake = stream.wake;
          stream.wake = null;
          wake?.();
        } else if (entry) {
          schedule(entry, false);
        }
      },
      aroundRender: feed || etagRoute
        ? (render) => {
            deps.render = deps.render.renew();
            track(deps.render, render);
          }
        : undefined,
    });
    let streaming = false;
    try {
      let body = withSession(sid, () => page.render());
      const timeout = opts.streamTimeoutMs ?? 10_000;
      const streamable = req.method !== "HEAD" && timeout > 0 && page.awaiting;
      const deadline = now() + timeout;
      stream.open = streamable;
      const settle = async (): Promise<boolean> => {
        while (!stream.dirty) {
          const left = deadline - now();
          if (left <= 0 || (entry && pages.get(page.id) !== entry)) {
            return false;
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          await new Promise<void>((resolve) => {
            stream.wake = resolve;
            timer = setTimeout(resolve, left);
          });
          clearTimeout(timer);
          stream.wake = null;
        }
        stream.dirty = false;
        await withSession(sid, () => page.refresh());
        return true;
      };
      const endStream = () => {
        stream.open = false;
        stream.wake = null;
        if (oneShot) {
          page.close();
        } else if (stream.dirty && entry) {
          schedule(entry, false);
        }
      };
      if (streamable && (req.headers.get("x-weft-nav") === "1" || printing)) {
        try {
          while (page.awaiting && (await settle())) {
          }
          body = page.html();
        } finally {
          endStream();
        }
      }
      streaming = streamable && stream.open;
      const readsAny = (d: { reads: Map<string, unknown>; stores: Set<unknown> }) =>
        d.reads.size > 0 || d.stores.size > 0;
      const inert = !streaming && page.inert() && !readsAny(deps.load) && !readsAny(deps.render) && !presenceHeld(ctx);
      const still = !streaming && page.quiet() && !presenceHeld(ctx);
      const edge =
        edgeCache !== null && shellShared && inert && !sealed && depth === "page" && status === 200 && !printing &&
        (req.method === "GET" || req.method === "HEAD") && edgeReason(route, opts) === null && !POSTS.test(body);
      let cachedTag: string | null = null;
      if (etagRoute && !still) {
        uncachable.add(route);
        onError(new Error(`@weft-framework/server: ${url.pathname}: \`cache: "etag"\` is for pages without server event handlers, presence or streaming; serving it uncached`));
      } else if (etagRoute) {
        const old = etags.get(cacheKey);
        if (old) purge(old);
        const rec: CacheRec = {
          key: cacheKey,
          tag: randomId(12),
          until: now() + ETAG_TTL,
          sid,
          deps: deps as unknown as CacheRec["deps"],
        };
        rec.deps.load.adopt(rec);
        rec.deps.render.adopt(rec);
        etags.set(cacheKey, rec);
        while (etags.size > ETAG_MAX) purge(etags.values().next().value!);
        cachedTag = rec.tag;
      }
      if (opts.regions && !opts.regions.isPrimary && depth === "page" && !inert && !still) {
        page.close();
        opts.regions.remember(route);
        return await opts.regions.forward(req);
      }
      const noLive = inert || (etagRoute && still);
      const critical = page.styles().join("");
      if (noLive && !oneShot) {
        page.close();
      }
      if (oneShot && !streaming) {
        page.close();
      }
      if (stateless) {
        if (/ data-weft-on-[a-z]/.test(body) && !deadHandlers.has(route)) {
          deadHandlers.add(route);
          onError(
            new Error(
              `@weft-framework/server: ${new URL(req.url).pathname} binds server event handlers, ` +
                "which a stateless host (transports: []) cannot run; use actions or client functions",
            ),
          );
        }
      } else if (!noLive && !oneShot) {
        entry = {
          page,
          sid,
          seen: 0,
          route,
          ctx,
          deps,
          sinks: new Set(),
          attached: 0,
          stale: false,
          version: 0,
          foreign: false,
          reload: false,
          timer: null,
          head: headOf(meta, req),
          awayTimer: null,
        };
        if (opts.devtools) {
          entry.dev = devLog();
          frame(entry.dev, "the page opened", pageHtml(entry));
          entry.cost = { events: 0, refreshes: 0, ms: 0, bytes: 0, dataBytes: jsonBytes(props) };
        } else if (watched.size > 0 && watching(keyOf(entry))) {
          entry.dev = devLog();
          frame(entry.dev, "the page opened", pageHtml(entry));
        }
        register(entry);
      }

      const nonce = randomId(16);
      const csrf = edge ? "" : await csrfToken(key, sid);
      const script =
        assets.has(clientEntry) && !inert
          ? `<script type="module" nonce="${nonce}" src="${escapeAttr(clientEntry)}"></script>`
          : "";
      const transport = wsEnabled || oneShot || noLive ? "" : `<meta name="weft-transport" content="sse">`;
      const live = oneShot || noLive ? "" : `<meta name="weft-live" content="${escapeAttr(page.id)}">`;
      const bundle = styleBundle();
      const next = inert ? [] : likelyFrom(route, body, url);
      const likelyMeta = next.length ? `<meta name="weft-likely" content="${escapeAttr(next.join(" "))}">` : "";
      const head =
        `${META_START}${renderMeta(meta, { nonce })}${META_END}` +
        live +
        (edge ? "" : `<meta name="weft-csrf" content="${escapeAttr(csrf)}">`) +
        `${transport}${likelyMeta}${appCssLink}` +
        `<style nonce="${nonce}">weft-c{display:contents}${critical}</style>${script}`;
      const tail = bundle ? `<link rel="stylesheet" href="${STYLES}?v=${bundle.version}">` : "";
      const mark = `<!--weft-stream-${randomId(12)}-->`;
      const asked = edge ? new Request(req.url) : req;
      let html = shell.render({
        lang: langOf(meta, asked),
        head,
        body: body + tail + (streaming ? mark : ""),
        nonce,
        html: htmlAttributeMarkup(opts.htmlAttributes?.(asked)),
      });
      const hashed = edge ? hashInline(html, nonce) : null;
      if (edge && !hashed) {
        shellShared = false;
        return renderDocument(req, route, params, status, depth, () => undefined);
      }
      if (hashed) {
        html = hashed.html;
        const tag = `"${createHash("sha256").update(html).digest("base64url").slice(0, 27)}"`;
        const headers = new Headers({
          "content-type": "text/html; charset=utf-8",
          "cache-control": `public, max-age=0, s-maxage=${edgeCache!.maxAge}, stale-while-revalidate=${edgeCache!.stale}`,
          etag: tag,
          ...securityHeaders({
            nonce: "",
            hashes: hashed,
            secure,
            sources: cspSourcesOf(route),
            ...(onCspReport ? { report: CSP_REPORT } : {}),
          }),
        });
        const fresh = matchesTag(req.headers.get("if-none-match"), tag.slice(1, -1));
        const res = stamped(req, new Response(fresh || req.method === "HEAD" ? null : html, { status: fresh ? 304 : 200, headers }), secure);
        res.headers.delete("set-cookie");
        return res;
      }

      const headers = new Headers({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...securityHeaders({ nonce, secure, sources: cspSourcesOf(route), ...(onCspReport ? { report: CSP_REPORT } : {}) }),
      });
      if (cachedTag !== null) {
        headers.set("cache-control", "private, no-cache");
        headers.set("etag", `"${cachedTag}"`);
        headers.set("vary", "Cookie, Accept-Language");
      }
      if (emailAuth && url.pathname === emailAuth.page) {
        headers.set("referrer-policy", "no-referrer");
      }
      const httpStatus = depth === "error" ? 500 : (route.status ?? status);
      if (!streaming) {
        return withCookie(new Response(req.method === "HEAD" ? null : html, { status: httpStatus, headers }));
      }
      headers.set("x-accel-buffering", "no");
      const cut = html.indexOf(mark);
      const [shellStart, shellEnd] = [html.slice(0, cut), html.slice(cut + mark.length)];
      const rootSel = JSON.stringify(`weft-c[data-weft-c="${page.rootId}"]`);
      const fill =
        `<script nonce="${nonce}">(function(){var s=document.currentScript,t=s.previousElementSibling,` +
        `r=document.querySelector(${rootSel.replace(/</g, "\\u003c")});` +
        `if(t&&r)r.replaceWith(t.content);if(t)t.remove();s.remove()})()</script>`;
      let cancelled = false;
      const chunks = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(shellStart));
        },
        async pull(controller) {
          try {
            while (!cancelled && page.awaiting && (await settle())) {
              if (cancelled) {
                break;
              }
              controller.enqueue(enc.encode(`<template data-weft-stream>${page.html()}</template>${fill}`));
            }
          } catch (err) {
            onError(err);
          }
          endStream();
          if (!cancelled) {
            controller.enqueue(enc.encode(shellEnd));
            controller.close();
          }
        },
        cancel() {
          cancelled = true;
          stream.dirty = true;
          stream.wake?.();
        },
      });
      return withCookie(new Response(chunks, { status: httpStatus, headers }));
    } catch (err) {
      if (streaming) {
        stream.open = false;
        if (oneShot) {
          page.close();
        }
      }
      if (entry && pages.get(page.id) === entry) {
        drop(page.id);
      } else {
        page.close();
      }
      throw err;
    }
  }

  async function pageMeta(route: Route<never>, ctx: PageContext, props: object): Promise<PageMeta> {
    const metas: (PageMeta | undefined)[] = [opts.meta];
    await withSession(ctx.session, async () => {
      for (const l of route.layouts ?? []) {
        metas.push(await resolveMeta(l.meta, ctx, undefined));
      }
      metas.push(route.title !== undefined ? { title: route.title } : undefined);
      if (route.og) {
        const image = ctx.url.pathname === "/" ? "/.og.png" : `${ctx.url.pathname.replace(/\/+$/, "")}.og.png`;
        metas.push({ openGraph: { image }, twitter: { card: "summary_large_image", image } });
      }
      metas.push(await resolveMeta(route.meta as MetaSource<object> | undefined, ctx, props));
    });
    return applySite(mergeMeta(...metas), opts.siteUrl);
  }

  function headOf(meta: PageMeta, req: Request): { meta: string; title: string; lang: string } {
    return { meta: renderMeta(meta), title: resolveTitle(meta), lang: langOf(meta, req) };
  }

  function langOf(meta: PageMeta, req: Request): string {
    if (meta.lang === undefined && opts.htmlAttributes) {
      const lang = opts.htmlAttributes(req).lang;
      if (typeof lang === "string") return resolveLang({ lang });
    }
    return resolveLang(meta);
  }

  async function runLoad(route: Route<never>, ctx: PageContext, deps: { load: Deps<Entry> }): Promise<unknown> {
    if (!route.load) {
      return {};
    }
    const load = route.load;
    let loaded: unknown;
    try {
      if (feed) {
        deps.load = deps.load.renew();
        presenceBegin(ctx);
        try {
          loaded = await withSession(ctx.session, () => track(deps.load, () => load(ctx)));
        } catch (err) {
          if (err instanceof Redirect || err instanceof NotFound) presenceEnd(ctx);
          throw err;
        }
        presenceEnd(ctx);
      } else {
        loaded = await withSession(ctx.session, () => load(ctx));
      }
    } catch (err) {
      if (!(err instanceof Redirect) && !(err instanceof NotFound)) {
        throw err;
      }
      loaded = err;
    }
    if (loaded instanceof Redirect && !isSafePath(loaded.to)) {
      throw new Error(`@weft-framework/server: redirect target must be a same-origin path: ${loaded.to}`);
    }
    return loaded;
  }

  const devDecisions = new Map<string, DevDecision[]>();
  const devList = (sid: string): DevDecision[] => {
    let list = devDecisions.get(sid);
    if (!list) {
      if (devDecisions.size >= 256) devDecisions.delete(devDecisions.keys().next().value as string);
      list = [];
      devDecisions.set(sid, list);
    }
    return list;
  };
  const devNote = (sid: string, action: string, actor: string) =>
    note(devList(sid), { at: now(), model: "(view as)", action, outcome: "allowed", count: 0, actor });
  const unaudit = opts.devtools
    ? audit(
        (ev) => {
          const sid = currentSession();
          if (sid === undefined) return;
          note(devList(sid), decision(ev));
        },
        { reads: true },
      )
    : null;

  function costOf(e: Entry): Pick<DevSnapshot, "cost" | "capacity"> {
    const held = (x: Entry) => x.page.html().length * 2 + (x.cost?.dataBytes ?? 0);
    const c = e.cost ?? { events: 0, refreshes: 0, ms: 0, bytes: 0, dataBytes: 0 };
    const cost = { events: c.events, refreshes: c.refreshes, ms: Math.round(c.ms * 100) / 100, bytes: c.bytes, heldBytes: held(e) };
    const proc = (globalThis as { process?: { getBuiltinModule?(m: string): unknown; memoryUsage?(): { heapUsed: number } } }).process;
    const v8 = proc?.getBuiltinModule?.("node:v8") as { getHeapStatistics?(): { heap_size_limit: number } } | undefined;
    let limit = v8?.getHeapStatistics?.().heap_size_limit ?? null;
    if (degrade?.heapBytes !== undefined) limit = limit === null ? degrade.heapBytes : Math.min(limit, degrade.heapBytes);
    const used = proc?.memoryUsage?.().heapUsed ?? null;
    if (limit === null || used === null) return { cost, capacity: null };
    let total = 0;
    let count = 0;
    for (const x of pages.values()) {
      if (x.route === e.route) {
        total += held(x);
        count++;
      }
    }
    const perPage = Math.max(1, Math.round(total / Math.max(1, count)));
    const free = Math.max(0, limit - used);
    return { cost, capacity: { route: patternOf.get(e.route) ?? "unknown", heapLimit: limit, heapUsed: used, perPage, pages: Math.floor(free / perPage) } };
  }

  async function devViewAs(req: Request): Promise<Response> {
    if (req.method !== "POST") return status(405);
    if (!sameOrigin(req) || !(req.headers.get("content-type") ?? "").startsWith("application/json")) return status(403);
    const sid = await sessionOf(req);
    const rec = sid ? await authStore.get(sid) : undefined;
    const answer = (body: object, code = 200) =>
      new Response(JSON.stringify(body), {
        status: code,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    if (!sid || !rec || rec.pending) return answer({ ok: false, reason: "Sign in first: view as works for a signed-in session." }, 409);
    let body: { user?: unknown; tenant?: unknown };
    try {
      const text = await req.text();
      if (text.length > 4096) return status(413);
      body = JSON.parse(text) as typeof body;
    } catch {
      return status(400);
    }
    if (body.user === null) {
      if (rec.viewAs?.dev) {
        const { viewAs: _gone, ...kept } = rec;
        await authStore.set(sid, kept);
        reloadSession(sid, await userOf(sid));
        devNote(sid, "stop", `id ${rec.user}`);
      }
      return answer({ ok: true, viewing: null });
    }
    const user = body.user;
    const tenant = body.tenant;
    if (typeof user !== "string" || user === "" || user.length > 256) return answer({ ok: false, reason: "Give a user id." }, 400);
    if (tenant !== undefined && (typeof tenant !== "string" || tenant === "" || tenant.length > 256)) {
      return answer({ ok: false, reason: "A tenant is an id." }, 400);
    }
    if (rec.viewAs && !rec.viewAs.dev) return answer({ ok: false, reason: "This session is already viewing as someone." }, 409);
    const v: NonNullable<SessionRecord["viewAs"]> = { user, until: now() + DEV_VIEW_MS, dev: true };
    if (tenant !== undefined) v.tenant = tenant;
    const seen = await viewedBy(rec.user, v, now());
    if (!seen) {
      const why = user === rec.user ? "That is you." : "The app does not know that user (in that tenant).";
      return answer({ ok: false, reason: why }, 404);
    }
    await authStore.set(sid, { ...rec, viewAs: v });
    reloadSession(sid, seen);
    devNote(sid, "start", `id ${user} (via id ${rec.user})`);
    return answer({ ok: true, viewing: { user, ...(tenant !== undefined ? { tenant } : {}), until: v.until } });
  }

  function reloadSession(sid: string, actor: unknown): void {
    for (const e of pages.values()) {
      if (e.sid === sid) {
        e.ctx.user = actor;
        because(e, "the session's actor changed (view as)");
        schedule(e, true);
      }
    }
  }

  function pageHtml(e: Entry): string {
    const cur = e.page.current();
    return cur.t === "patch" ? cur.html : "";
  }

  function devRecording(e: Entry): Response {
    const rec: Recording = {
      weft: "recording",
      v: 1,
      path: redactPath(e.ctx.url),
      actor: actorLabel(e.ctx.user),
      at: e.dev?.opened ?? Date.now(),
      steps: e.dev?.steps ?? [],
    };
    return new Response(JSON.stringify(rec, null, 2) + "\n", {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": 'attachment; filename="page.weft-recording.json"',
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  function devFrame(e: Entry, n: number): Response {
    const f = e.dev?.frames.find((x) => x.n === n);
    if (!f) return status(404);
    return new Response(JSON.stringify({ n: f.n, at: f.at, what: f.what, html: f.html }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const watched = new Map<string, { until: number; timer: ReturnType<typeof setTimeout> }>();
  const keyOf = (e: Entry): string => (e.sidKey ??= sessionKey(e.sid));
  const watching = (key: string): boolean => (watched.get(key)?.until ?? 0) > now();
  const unwatch = (key: string): void => {
    const w = watched.get(key);
    if (w) clearTimeout(w.timer);
    watched.delete(key);
    if (opts.devtools) return;
    for (const e of pages.values()) if (keyOf(e) === key) e.dev = undefined;
  };
  const removeHub = addInspectHub({
    pages: (key) => [...pages.values()].filter((e) => keyOf(e) === key).map((e) => ({ page: e.page.id, path: e.ctx.url.pathname })),
    watch(key, until) {
      if (until <= now()) {
        unwatch(key);
        return;
      }
      const old = watched.get(key);
      if (old) clearTimeout(old.timer);
      const timer = setTimeout(() => unwatch(key), Math.min(until - now(), 2 ** 31 - 1));
      (timer as { unref?(): void }).unref?.();
      watched.set(key, { until, timer });
      for (const e of pages.values()) {
        if (!e.dev && keyOf(e) === key) {
          e.dev = devLog();
          frame(e.dev, "inspection started", pageHtml(e));
        }
      }
    },
    view(key, page) {
      const e = pages.get(page);
      if (!e?.dev || keyOf(e) !== key || !watching(key)) return null;
      return {
        page,
        path: e.ctx.url.pathname,
        tree: e.page.inspect(),
        messages: e.dev.messages,
        frames: frameList(e.dev),
        reads: { load: readsOf(e.deps.load), render: readsOf(e.deps.render) },
      };
    },
    frame(key, page, n) {
      const e = pages.get(page);
      if (!e?.dev || keyOf(e) !== key || !watching(key)) return null;
      const f = e.dev.frames.find((x) => x.n === n);
      return f ? { n: f.n, at: f.at, what: f.what, html: f.html } : null;
    },
  });

  function inspect(e: Entry): Response {
    const seeing = viewingAs(e.ctx);
    const snap: DevSnapshot = {
      viewing: seeing ? { user: seeing.user, operator: seeing.operator, until: seeing.until, ...(seeing.tenant ? { tenant: seeing.tenant } : {}) } : null,
      lid: e.page.id,
      path: e.ctx.url.pathname,
      tree: e.page.inspect(),
      messages: e.dev?.messages ?? [],
      frames: frameList(e.dev),
      decisions: devDecisions.get(e.sid) ?? [],
      reads: { load: readsOf(e.deps.load), render: readsOf(e.deps.render) },
      stores: e.deps.load.stores.size,
      ...costOf(e),
    };
    return new Response(JSON.stringify(snap), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const feed = opts.sync === false || stateless ? null : (opts.sync ?? changes);
  const syncDelay = opts.syncDelayMs ?? 15;
  const unwatchStores = feed
    ? onStoreWrite((store, sid) => {
        for (const r of cacheReaders.readersOfStore(store)) {
          if (store.scope === "app" || r.sid === sid) purge(r);
        }
        for (const e of readers.readersOfStore(store)) {
          if (e.deps.load.stores.has(store) && (store.scope === "app" || e.sid === sid)) {
            because(e, `${store.scope} store ${store.name} written (read in load)`);
            schedule(e, true);
          }
        }
      })
    : null;
  const unGap = feed?.onGap(() => {
    for (const r of [...etags.values()]) purge(r);
    for (const e of pages.values()) {
      if (e.deps.load.reads.size > 0 || e.deps.render.reads.size > 0) {
        because(e, "changes from other instances may have been missed (feed gap)");
        schedule(e, true);
      }
    }
  });
  const unNotices = stateless
    ? null
    : addNoticeHub((model, row, notice, self) => {
        const key = (row as Record<string, unknown>)[model.key];
        const change = { model: model.name, op: "update" as const, key, before: row, after: row };
        const sid = self ? undefined : currentSession();
        const msg: ServerMessage = notice.data === undefined
          ? { t: "notice", text: notice.text, kind: notice.kind }
          : { t: "notice", text: notice.text, kind: notice.kind, data: notice.data };
        let n = 0;
        for (const e of readers.readersOf(model.name)) {
          if (e.sid === sid || e.sinks.size === 0) continue;
          if (e.deps.load.admits(change) || e.deps.render.admits(change)) {
            send(e, msg);
            n++;
          }
        }
        return n;
      });
  const unsubscribe = feed?.subscribe((change) => {
    sharedChange(change);
    for (const r of cacheReaders.readersOf(change.model)) {
      if (r.deps.load.concerns(change) || r.deps.render.concerns(change)) purge(r);
    }
    for (const e of readers.readersOf(change.model)) {
      const inLoad = e.deps.load.concerns(change);
      if (inLoad || e.deps.render.concerns(change)) {
        if (e.dev) because(e, changeCause(change, inLoad ? "load" : "render"));
        schedule(e, true);
      }
    }
  });

  const dispatching = new Set<Entry>();

  function schedule(e: Entry, reload: boolean): void {
    e.reload ||= reload;
    if (reload && !dispatching.has(e)) e.foreign = true;
    if (e.timer === null) {
      e.timer = setTimeout(() => void refresh(e), syncDelay);
      (e.timer as { unref?(): void }).unref?.();
    }
  }

  function send(e: Entry, msg: ServerMessage): void {
    for (const sink of e.sinks) {
      sink(msg);
    }
  }

  function sharedOn(e: Entry, msg: Extract<ClientMessage, { t: "text" }>): void {
    sharedMessage(e, e.ctx.user, msg, (m) => send(e, m), {
      ...opts.sharedFields,
      onError: (err) => report(err, "event", { route: e.route, ctx: e.ctx, handler: "(shared field)" }),
    });
  }

  async function dispatchTo(e: Entry, sid: string, msg: Extract<ClientMessage, { t: "event" }>, req?: Request): Promise<ServerMessage[]> {
    const stale = (msg.base ?? 0) !== e.version || e.foreign;
    if (msg.queued) msg.event.queued = true;
    if (stale) msg.event.stale = true;
    if (msg.queued && stale && staleMode === "refuse") {
      return [{ t: "conflict", ack: msg.seq, reason: "stale" }];
    }
    const started = performance.now();
    let span: Span | null = null;
    if (telemetry?.span) {
      try {
        const component = e.page.componentOf(msg.id) ?? "unknown";
        const handler = component === "unknown" ? "unknown" : msg.handler;
        const attrs = { "weft.component": component, "weft.handler": handler };
        span = telemetry.span(`event ${component}.${handler}`, {
          parent: (req && traces.get(req)) ?? null,
          attributes: { ...attrs, "http.route": patternOf.get(e.route) },
          metric: { name: "weft.live.event.duration", attributes: attrs },
        });
      } catch (err) {
        onError(err);
      }
    }
    let outs: ServerMessage[];
    const scope = newScope(span ? span.context : null);
    const run = () => withSession(sid, () => e.page.dispatch(msg));
    dispatching.add(e);
    try {
      outs = await (scope ? readScope!.run(scope, run) : run());
    } catch (err) {
      span?.end({ error: err });
      throw err;
    } finally {
      dispatching.delete(e);
      if (scope) scope.open = false;
    }
    if (span) {
      const failed = outs.find((o) => o.t === "error");
      span.end(failed ? { error: new Error(failed.message) } : {});
    }
    charge(e, "events", performance.now() - started, outs);
    if (patchBudget !== false || scope?.models) {
      const component = e.page.componentOf(msg.id);
      const cause = component === undefined ? "unknown.unknown" : `${component}.${msg.handler}`;
      checkBudget(e, cause, outs);
      if (scope) checkReads(scope, patternOf.get(e.route) ?? "unknown", cause, e.dev);
    }
    if (e.dev) {
      note(e.dev.messages, {
        at: Date.now(),
        dir: "in",
        what: `${msg.event.type} -> ${msg.handler} on ${msg.id}`,
        ms: Math.round((performance.now() - started) * 100) / 100,
        out: outs.map(describe),
      });
      if (outs.some((o) => o.t === "patch")) frame(e.dev, `${msg.event.type} -> ${msg.handler}`, pageHtml(e));
      if (e.dev.steps.length < RECORDING_MAX) {
        e.dev.steps.push({
          at: Date.now() - e.dev.opened,
          id: msg.id,
          handler: msg.handler,
          event: redactPayload(msg.event),
          ...(msg.args !== undefined ? { args: msg.args } : {}),
          outcome: outcomeOf(outs),
        });
      }
    }
    return outs;
  }

  async function refresh(e: Entry): Promise<void> {
    e.timer = null;
    if (pages.get(e.page.id) !== e) {
      return;
    }
    if (e.sinks.size === 0) {
      e.stale = true;
      return;
    }
    e.stale = false;
    const withLoad = e.reload;
    e.reload = false;
    const foreign = e.foreign;
    e.foreign = false;
    const why = e.why ?? [];
    e.why = undefined;
    const reload = async (): Promise<Reload> => {
      if (!e.route.load) {
        return { props: { ...e.ctx.params } };
      }
      const loaded = await runLoad(e.route, e.ctx, e.deps);
      if (loaded instanceof Redirect) {
        return { message: { t: "redirect", to: loaded.to } };
      }
      if (loaded instanceof NotFound) {
        return { message: { t: "redirect", to: e.ctx.url.pathname + e.ctx.url.search } };
      }
      fresh = { ...e.ctx.params, ...(loaded as object) };
      if (e.cost) e.cost.dataBytes = jsonBytes(fresh);
      return { props: fresh };
    };
    let fresh: object | null = null;
    try {
      const started = performance.now();
      const scope = queryLimits ? newScope(null) : null;
      const again = () => withSession(e.sid, () => e.page.refresh(withLoad ? reload : undefined));
      let msgs: ServerMessage[];
      try {
        msgs = await (scope ? readScope!.run(scope, again) : again());
      } finally {
        if (scope) scope.open = false;
      }
      if (withLoad && foreign && msgs.some((m) => m.t === "patch")) {
        e.version += 1;
        msgs = msgs.map((m) => (m.t === "patch" ? { ...m, v: e.version } : m));
      }
      for (const msg of msgs) {
        send(e, msg);
      }
      charge(e, "refreshes", performance.now() - started, msgs);
      const cause = withLoad ? "data change" : "re-render";
      checkBudget(e, cause, msgs);
      if (scope) checkReads(scope, patternOf.get(e.route) ?? "unknown", cause, e.dev);
      if (e.dev && msgs.length > 0) {
        note(e.dev.messages, {
          at: Date.now(),
          dir: "push",
          what:
            (withLoad ? "data changed: load and render again" : "render again (a settled await or a store)") +
            (why.length > 0 ? ` because: ${why.join("; ")}` : ""),
          ms: Math.round((performance.now() - started) * 100) / 100,
          out: msgs.map(describe),
        });
        if (msgs.some((m) => m.t === "patch")) frame(e.dev, withLoad ? "data changed" : "rendered again", pageHtml(e));
      }
      if (fresh && pages.get(e.page.id) === e) {
        const head = headOf(await pageMeta(e.route, e.ctx, fresh), e.ctx.request);
        if (head.meta !== e.head.meta || head.title !== e.head.title || head.lang !== e.head.lang) {
          e.head = head;
          send(e, { t: "head", ...head });
        }
      }
    } catch (err) {
      onError(err);
    }
  }

  function attach(e: Entry, sink: (msg: ServerMessage) => void): () => void {
    e.sinks.add(sink);
    if (e.awayTimer) {
      clearTimeout(e.awayTimer);
      e.awayTimer = null;
    }
    presenceAway(e.ctx, false);
    if (e.attached++ > 0) {
      sink(e.page.current());
    }
    if (e.stale) {
      schedule(e, false);
    }
    return () => {
      e.sinks.delete(sink);
      if (pages.get(e.page.id) === e) watchAway(e);
    };
  }

  const sockets = new Map<LiveSocket, () => void>();

  function openSse(entry: Entry): Response {
    const id = randomId();
    let timer: ReturnType<typeof setInterval> | null = null;
    let detach: (() => void) | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const stream: Stream = {
          entry,
          push(msg) {
            controller.enqueue(enc.encode(`data: ${encode(msg)}\n\n`));
          },
        };
        streams.set(id, stream);
        stream.push({ t: "hello", session: id, p: PROTOCOL_VERSION });
        detach = attach(entry, (msg) => stream.push(msg));
        timer = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), heartbeatMs);
        (timer as { unref?(): void }).unref?.();
      },
      cancel() {
        streams.delete(id);
        detach?.();
        if (timer !== null) {
          clearInterval(timer);
        }
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-weft-instance": instance,
      },
    });
  }

  async function uploadRequest(req: Request, url: URL, path: string, sid: string | null): Promise<Response> {
    const refuse = (code: number, error: string) =>
      new Response(JSON.stringify({ ok: false, error }), {
        status: code,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    if (!sameOrigin(req)) {
      return refuse(403, "Cross-origin request refused");
    }
    if (!sid) {
      return refuse(403, "Session expired; reload the page");
    }
    if (req.method !== "PUT" && !(await verifyCsrf(await keyP, sid, req.headers.get("x-weft-csrf")))) {
      return refuse(403, "Session expired; reload the page");
    }
    if (req.method !== "PUT" && !limiter.take(sid)) {
      return refuse(429, "Too many requests");
    }
    const ctx = await contextFor(req, url, {}, sid, null);
    if (viewingAs(ctx)) {
      return refuse(403, VIEWING);
    }
    try {
      return await withSession(sid, () => opts.uploads!.handle(ctx, req, path));
    } catch (err) {
      report(err, "upload", { ctx });
      return refuse(500, "Server error");
    }
  }

  async function postEvent(req: Request): Promise<Response> {
    if (!sameOrigin(req)) {
      return status(403);
    }
    const sid = await sessionOf(req);
    if (!sid || !(await verifyCsrf(await keyP, sid, req.headers.get("x-weft-csrf")))) {
      return status(403);
    }
    const stream = streams.get(req.headers.get("x-weft-session") ?? "");
    if (!stream || stream.entry.sid !== sid || !pages.has(stream.entry.page.id)) {
      return status(404);
    }
    if (!limiter.take(sid)) {
      return status(429);
    }
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > LIMITS.message) {
      return status(413);
    }
    const raw = await req.text();
    if (raw.length > LIMITS.message) {
      return status(413);
    }
    const msg = decodeClientMessage(raw);
    if (!msg) {
      return status(400);
    }
    touch(stream.entry.page.id, stream.entry);
    if (msg.t === "text") {
      sharedOn(stream.entry, msg);
      return status(204);
    }
    if (msg.t === "point") {
      pointMessage(stream.entry, stream.entry.ctx, msg, (m) => send(stream.entry, m));
      return status(204);
    }
    const outs = await dispatchTo(stream.entry, sid, msg, req);
    for (const out of outs) {
      stream.push(out);
    }
    return status(204);
  }

  const actions = new Map<string, Action<never[]>>();
  for (const [name, a] of Object.entries(opts.actions ?? {})) {
    if (a.name !== name) {
      throw new Error(`@weft-framework/server: action registered as ${name} is named ${a.name}`);
    }
    actions.set(name, a);
  }
  const maxActionBytes = opts.maxActionBytes ?? 256 * 1024;

  function actionName(url: URL): string | null {
    if (!url.search.startsWith("?/")) {
      return null;
    }
    const name = url.search.slice(2).split("&")[0];
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : "";
  }

  async function postAction(req: Request, name: string, params: Params, standalone = false): Promise<Response> {
    const url = new URL(req.url);
    const jsonBody = (req.headers.get("content-type") ?? "").split(";")[0].trim() === "application/json";
    const json = standalone || jsonBody || req.headers.get("x-weft-enhanced") === "1";
    const answer = (code: number, body: { ok: boolean; error?: string; value?: unknown; redirect?: string }) =>
      json ? jsonResponse(code, body) : formFailure(code, body.error ?? "Request refused", url);
    if (!sameOrigin(req)) {
      return answer(403, { ok: false, error: "Cross-origin request refused" });
    }
    const sid = await sessionOf(req);
    if (!sid) {
      return answer(403, { ok: false, error: "Session expired; reload the page" });
    }
    if (json && !(await verifyCsrf(await keyP, sid, req.headers.get("x-weft-csrf")))) {
      return answer(403, { ok: false, error: "Session expired; reload the page" });
    }
    const action = actions.get(name);
    if (!action) {
      return answer(404, { ok: false, error: "Unknown action" });
    }
    if (!limiter.take(sid)) {
      return answer(429, { ok: false, error: "Too many requests" });
    }
    if (Number(req.headers.get("content-length") ?? "0") > maxActionBytes) {
      return answer(413, { ok: false, error: "Request too large" });
    }
    const buf = await req.arrayBuffer();
    if (buf.byteLength > maxActionBytes) {
      return answer(413, { ok: false, error: "Request too large" });
    }
    const held = heldCount(action.params);
    let heldArgs: unknown[] = [];
    if (held > 0) {
      const opened = openHeld(sid, name, url.searchParams.get(HELD_FIELD));
      const checked = opened && opened.length === held
        ? decodeJson(action.params.slice(0, held), Object.fromEntries(action.params.slice(0, held).map((p, i) => [p.name, opened[i]])))
        : null;
      if (!checked?.ok) {
        return answer(400, { ok: false, error: "This form has expired; reload the page" });
      }
      heldArgs = checked.args;
    }
    const fields = action.params.slice(held);
    let decoded: Decoded;
    try {
      decoded = jsonBody
        ? decodeJson(fields, JSON.parse(new TextDecoder().decode(buf)))
        : decodeForm(
            fields,
            await new Response(buf, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData(),
          );
    } catch {
      return answer(400, { ok: false, error: "Malformed request body" });
    }
    if (!decoded.ok) {
      return answer(400, { ok: false, error: decoded.error });
    }
    let rotated: Rotation | null = null;
    const ctx = await contextFor(req, url, params, sid, null, (r) => (rotated = r));
    if (viewingAs(ctx) && !runsWhileViewing(action)) {
      return answer(403, { ok: false, error: VIEWING });
    }
    const res = await (async (): Promise<Response> => {
      let value: unknown;
      try {
        value = await withSession(sid, () => action.run(ctx, ...([...heldArgs, ...decoded.args] as never[])));
      } catch (err) {
        if (err instanceof ActionError) {
          return answer(err.status, { ok: false, error: String(err.message ?? "Request refused") });
        }
        if (err instanceof NotFound) {
          return answer(404, { ok: false, error: "Not found" });
        }
        if (!(err instanceof Redirect)) {
          report(err, "action", { ctx, handler: name });
          return answer(500, { ok: false, error: "Server error" });
        }
        value = err;
      }
      if (value instanceof Redirect) {
        if (!isSafePath(value.to)) {
          onError(new Error(`@weft-framework/server: redirect target must be a same-origin path: ${value.to}`));
          return answer(500, { ok: false, error: "Server error" });
        }
        return json ? jsonResponse(200, { ok: true, redirect: value.to }) : seeOther(value.to);
      }
      if (!json) {
        return seeOther(url.pathname);
      }
      const body: { ok: true; value?: unknown; redirect?: string } = { ok: true };
      if (value !== undefined) {
        body.value = value;
      }
      if (rotated && !standalone) {
        body.redirect = url.pathname;
      }
      return jsonResponse(200, body);
    })();
    const r = rotated as Rotation | null;
    if (r) {
      res.headers.append("set-cookie", r.cookie);
      res.headers.set("x-weft-csrf", await csrfToken(await keyP, r.sid));
    }
    return res;
  }

  async function sessionBootstrap(req: Request): Promise<Response> {
    if (!sameOrigin(req)) {
      return jsonResponse(403, { error: "Cross-origin request refused" });
    }
    const key = await keyP;
    let sid = await sessionOf(req);
    let setCookie: string | null = null;
    if (!sid) {
      sid = randomId(24);
      setCookie = sessionCookie(cookieName, await signSession(key, sid), {
        secure: new URL(req.url).protocol === "https:",
      });
    }
    const res = jsonResponse(200, { csrf: await csrfToken(key, sid) });
    if (setCookie) {
      res.headers.append("set-cookie", setCookie);
    }
    return res;
  }

  const maxApiBytes = opts.maxApiBytes ?? 256 * 1024;

  async function callApi(req: Request, handlers: ApiHandlers, params: Params): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const allow = allowHeader(handlers);
    if (method === "OPTIONS" && !handlers.OPTIONS) {
      return new Response(null, {
        status: 204,
        headers: { allow, "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }
    const fn = isApiMethod(method) ? handlerFor(handlers, method) : undefined;
    if (!fn) {
      return new Response(null, { status: 405, headers: { allow, "x-content-type-options": "nosniff" } });
    }
    if (isExternal(fn)) {
      return callExternal(req, url, method, handlers, fn, params);
    }
    if (isUnsafeMethod(method) && !sameOrigin(req)) {
      return jsonResponse(403, { error: "Cross-origin request refused" });
    }
    const key = await keyP;
    const secure = url.protocol === "https:";
    let sid = await sessionOf(req);
    if (isUnsafeMethod(method)) {
      if (!sid || !(await verifyCsrf(key, sid, req.headers.get("x-weft-csrf")))) {
        return jsonResponse(403, { error: "Session expired; reload the page" });
      }
    }
    let setCookie: string | null = null;
    if (!sid) {
      sid = randomId(24);
      setCookie = sessionCookie(cookieName, await signSession(key, sid), { secure });
    }
    let active: string = sid;
    const stamp = async (res: Response, head: boolean): Promise<Response> => {
      const headers = copyHeaders(res.headers);
      if (setCookie) {
        headers.append("set-cookie", setCookie);
      }
      if (!headers.has("x-content-type-options")) {
        headers.set("x-content-type-options", "nosniff");
      }
      if (!headers.has("cache-control")) {
        headers.set("cache-control", "no-store");
      }
      headers.set("x-weft-csrf", await csrfToken(key, active));
      if (head) {
        await res.body?.cancel().catch(() => undefined);
      }
      return new Response(head ? null : res.body, { status: res.status, statusText: res.statusText, headers });
    };
    if (!apiLimiter.take(sid)) {
      return stamp(jsonResponse(429, { error: "Too many requests" }), false);
    }
    let next = req;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const declared = Number(req.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > maxApiBytes) {
        return stamp(jsonResponse(413, { error: "Request too large" }), false);
      }
      const buf = await readLimited(req, maxApiBytes);
      if (!buf) {
        return stamp(jsonResponse(413, { error: "Request too large" }), false);
      }
      next = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: buf.byteLength > 0 ? new Uint8Array(buf) : undefined,
      });
    }
    const ctx = await contextFor(next, url, params, sid, isUnsafeMethod(method) ? null : NOT_HERE, (r) => {
      active = r.sid;
      setCookie = r.cookie;
    });
    const head = method === "HEAD" && !handlers.HEAD;
    if (isUnsafeMethod(method) && viewingAs(ctx)) {
      return stamp(jsonResponse(403, { error: VIEWING }), false);
    }
    try {
      const value = await withSession(sid, () => fn(ctx));
      if (!(value instanceof Response)) {
        onError(new Error("@weft-framework/server: an api handler did not return a Response"));
        return stamp(jsonResponse(500, { error: "Server error" }), false);
      }
      if (!guardApiResponse(value, url.origin)) {
        onError(new Error("@weft-framework/server: an api response redirected off-site"));
        await value.body?.cancel().catch(() => undefined);
        return stamp(jsonResponse(500, { error: "Server error" }), false);
      }
      return stamp(value, head);
    } catch (err) {
      if (err instanceof Redirect) {
        if (!isSafePath(err.to)) {
          onError(new Error("@weft-framework/server: redirect target must be a same-origin path"));
          return stamp(jsonResponse(500, { error: "Server error" }), false);
        }
        return stamp(new Response(null, { status: 303, headers: { location: err.to } }), false);
      }
      if (err instanceof NotFound) {
        return stamp(jsonResponse(404, { error: "Not found" }), false);
      }
      report(err, "api", { route: handlers, ctx });
      return stamp(jsonResponse(500, { error: "Server error" }), false);
    }
  }

  async function callExternal(
    req: Request,
    url: URL,
    method: string,
    handlers: ApiHandlers,
    fn: ApiHandler,
    params: Params,
  ): Promise<Response> {
    const plain = (res: Response, head: boolean): Response => {
      const headers = copyHeaders(res.headers);
      headers.delete("set-cookie");
      if (!headers.has("x-content-type-options")) headers.set("x-content-type-options", "nosniff");
      if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
      if (head) void res.body?.cancel().catch(() => undefined);
      return new Response(head ? null : res.body, { status: res.status, statusText: res.statusText, headers });
    };
    let next = req;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const declared = Number(req.headers.get("content-length") ?? "0");
      const buf = Number.isFinite(declared) && declared > maxApiBytes ? null : await readLimited(req, maxApiBytes);
      if (!buf) return plain(jsonResponse(413, { error: "Request too large" }), false);
      next = new Request(req.url, { method: req.method, headers: req.headers, body: buf.byteLength > 0 ? new Uint8Array(buf) : undefined });
    }
    const ctx = await contextFor(next, url, params, randomId(24), "do not work in external API handlers (no browser session)");
    try {
      const value = await fn(ctx);
      if (!(value instanceof Response)) {
        onError(new Error("@weft-framework/server: an api handler did not return a Response"));
        return plain(jsonResponse(500, { error: "Server error" }), false);
      }
      if (!guardApiResponse(value, url.origin)) {
        onError(new Error("@weft-framework/server: an api response redirected off-site"));
        await value.body?.cancel().catch(() => undefined);
        return plain(jsonResponse(500, { error: "Server error" }), false);
      }
      return plain(value, method === "HEAD" && !handlers.HEAD);
    } catch (err) {
      if (err instanceof NotFound) return plain(jsonResponse(404, { error: "Not found" }), false);
      report(err, "api", { route: handlers, ctx });
      return plain(jsonResponse(500, { error: "Server error" }), false);
    }
  }

  function harden(res: Response, secure: boolean): Response {
    const headers = copyHeaders(res.headers);
    const type = headers.get("content-type") ?? "";
    if (type.includes("text/html")) {
      for (const [name, value] of Object.entries(securityHeaders({ nonce: randomId(16), secure }))) {
        headers.set(name, value);
      }
      if (!headers.has("cache-control")) {
        headers.set("cache-control", "no-store");
      }
    } else if (!headers.has("x-content-type-options")) {
      headers.set("x-content-type-options", "nosniff");
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  const regionRouted = new WeakSet<Request>();

  const app: App = {
    async fetch(req, server) {
      if (opts.regions && !regionRouted.has(req)) {
        const regions = opts.regions;
        const served = await regions.handle(req);
        if (served) return served;
        const routed = await regions.route(req, {
          routeOf: (p) => router.match(p)?.route.value ?? null,
          holdsPage: (lid) => lid !== null && pages.has(lid),
        });
        if (routed instanceof Response) return routed;
        const next = routed ?? req;
        regionRouted.add(next);
        const res = await app.fetch(next, server);
        return res ? regions.stamp(next, res) : res;
      }
      const url = new URL(req.url);
      const path = url.pathname;
      try {
        if (path === HEALTH || path === READY) {
          if (req.method !== "GET" && req.method !== "HEAD") {
            return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
          }
          const ok = path === HEALTH || (!draining && (await readyNow()));
          return new Response(req.method === "HEAD" ? null : ok ? "ok\n" : "unavailable\n", {
            status: ok ? 200 : 503,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
          });
        }
        if (path === LIVE && req.method === "GET") {
          if (!wsEnabled || req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
            return status(426);
          }
          if (!sameOrigin(req)) {
            return status(403);
          }
          const sid = await sessionOf(req);
          const entry = pageFor(url.searchParams.get("lid"), sid);
          const data = entry && sid ? { lid: entry.page.id, sid } : { lid: "", sid: "" };
          if (!server?.upgrade(req, { data })) {
            return status(426);
          }
          return undefined;
        }
        if (path === `${LIVE}/sse` && req.method === "GET") {
          const entry = pageFor(url.searchParams.get("lid"), await sessionOf(req));
          return entry ? openSse(entry) : status(404);
        }
        if (path === DEV_VIEW_AS && devViewing) {
          return await devViewAs(req);
        }
        if (path === DEV_INSPECT && opts.devtools && req.method === "GET") {
          const entry = pageFor(url.searchParams.get("lid"), await sessionOf(req));
          return entry ? inspect(entry) : status(404);
        }
        if (path === DEV_RECORDING && opts.devtools && req.method === "GET") {
          const entry = pageFor(url.searchParams.get("lid"), await sessionOf(req));
          return entry ? devRecording(entry) : status(404);
        }
        if (path === DEV_FRAME && opts.devtools && req.method === "GET") {
          const entry = pageFor(url.searchParams.get("lid"), await sessionOf(req));
          const n = Number(url.searchParams.get("n"));
          return entry && Number.isInteger(n) && n >= 0 ? devFrame(entry, n) : status(404);
        }
        if (path === IMAGES_PATH && opts.images) {
          if (req.method !== "GET" && req.method !== "HEAD") return status(405);
          const pass = new Headers();
          for (const name of ["cookie", "accept-language", "user-agent"]) {
            const v = req.headers.get(name);
            if (v !== null) pass.set(name, v);
          }
          return await opts.images.handle(req, async (src, ifNoneMatch) => {
            const h = new Headers(pass);
            if (ifNoneMatch) h.set("if-none-match", ifNoneMatch);
            return (await app.fetch(new Request(`${url.origin}${src}`, { headers: h }))) ?? status(404);
          });
        }
        if (path === CSP_REPORT && onCspReport) {
          if (req.method !== "POST") return status(405);
          if (!cspReportLimiter.take("csp")) return status(429);
          const text = await readCapped(req, 8192);
          for (const v of text === null ? [] : parseCspReports(text, url.origin, patternAt)) {
            try {
              onCspReport(v);
            } catch (err) {
              onError(err);
            }
          }
          return new Response(null, { status: 204 });
        }
        if (path === `${LIVE}/event`) {
          return req.method === "POST" ? await postEvent(req) : status(405);
        }
        if (path === `${LIVE}/leave`) {
          if (req.method !== "POST") {
            return status(405);
          }
          if (!sameOrigin(req)) {
            return status(403);
          }
          const entry = pageFor(url.searchParams.get("lid"), await sessionOf(req));
          if (entry) {
            if (entry.awayTimer) {
              clearTimeout(entry.awayTimer);
              entry.awayTimer = null;
            }
            presenceAway(entry.ctx, true);
          }
          return status(204);
        }
        if (path === SESSION) {
          return req.method === "GET" ? await sessionBootstrap(req) : status(405);
        }
        if ((path === STYLES || (path === APP_CSS && appCss)) && (req.method === "GET" || req.method === "HEAD")) {
          const bundle = path === APP_CSS ? appCss : styleBundle();
          if (!bundle) {
            return status(404);
          }
          return new Response(req.method === "HEAD" ? null : bundle.css, {
            headers: {
              "content-type": "text/css; charset=utf-8",
              "cache-control": url.searchParams.get("v") === bundle.version ? "public, max-age=31536000, immutable" : "no-cache",
              "x-content-type-options": "nosniff",
            },
          });
        }
        const asset = req.method === "GET" ? assets.get(path) : undefined;
        if (asset !== undefined) {
          return new Response(asset, {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": assetCache,
              "x-content-type-options": "nosniff",
            },
          });
        }
        if ((path === SITEMAP && opts.sitemap) || (path === ROBOTS && robots !== null)) {
          return await seoRequest(req, path);
        }
        const standalone = path.startsWith(ACTION);
        const signingIn = path.startsWith(AUTH) && (providers.size > 0 || emailAuth !== null || samlAuth !== null);
        const uploading = opts.uploads !== undefined && path.startsWith("/_weft/uploads/");
        if (opts.uploads && path.startsWith("/_weft/files/")) {
          return opts.uploads.serve(req, path);
        }
        if (path.startsWith("/_weft/") && !standalone && !signingIn && !uploading) {
          return status(404);
        }
        const sid = await sessionOf(req);
        const gate = await runMiddleware(opts.middleware, { request: req, url, session: sid, user: await userOf(sid) });
        if (gate.response) {
          return harden(gate.response, url.protocol === "https:");
        }
        const finish = (res: Response) => unshared(withExtraHeaders(res, gate.headers));
        if (signingIn) {
          return finish(await signInRequest(req, url, path, sid));
        }
        if (uploading) {
          return finish(await uploadRequest(req, url, path, sid));
        }
        if (standalone) {
          if (req.method !== "POST") {
            return finish(new Response(null, { status: 405, headers: { allow: "POST" } }));
          }
          let name = "";
          try {
            name = decodeURIComponent(path.slice(ACTION.length));
          } catch {
          }
          return finish(await postAction(req, /^[A-Za-z_$][\w$]*$/.test(name) ? name : "", {}, true));
        }
        const routed = gate.rewrite ?? path;
        const apiHit = apiRouter.match(routed);
        if (apiHit) {
          const pattern = patternOf.get(apiHit.route.value);
          if (pattern !== undefined) routeOfReq.set(req, pattern);
          return finish(await callApi(req, apiHit.route.value, apiHit.params));
        }
        if (opts.pdf && req.method === "GET" && routed.endsWith(".pdf") && path.endsWith(".pdf")) {
          const page = router.match(routed.slice(0, -4));
          const spec = page?.route.value.pdf;
          if (spec) return finish(await printRoute(req, url, path, spec, sid));
        }
        if ((req.method === "GET" || req.method === "HEAD") && routed.endsWith(".og.png") && path.endsWith(".og.png")) {
          const spec = router.match(routed.slice(0, -".og.png".length) || "/")?.route.value.og;
          if (spec && opts.pdf?.capture) return finish(await ogImage(req, url, path, spec));
        }
        const found = router.match(routed);
        if (found) {
          const pattern = patternOf.get(found.route.value);
          if (pattern !== undefined) routeOfReq.set(req, pattern);
          const action = req.method === "POST" ? actionName(url) : null;
          if (action !== null) {
            return finish(await postAction(req, action, found.params));
          }
          if (req.method !== "GET" && req.method !== "HEAD") {
            return finish(status(405));
          }
          if (req.method === "GET" && isPrefetch(req) && !prefetchLimiter.take(sid ?? "anon")) {
            return finish(status(429));
          }
          if (req.method === "GET" && !isPrefetch(req) && pattern !== undefined) noteVisit(req, url, pattern);
          return finish(await renderPage(req, found.route.value, found.params));
        }
        if (opts.files && (req.method === "GET" || req.method === "HEAD")) {
          const file = await opts.files(path, req);
          if (file) {
            return finish(file);
          }
        }
        if (opts.notFound && (req.method === "GET" || req.method === "HEAD")) {
          if (req.method === "GET" && isPrefetch(req) && !prefetchLimiter.take(sid ?? "anon")) {
            return finish(status(429));
          }
          return finish(await renderPage(req, opts.notFound, {}, 404));
        }
        return finish(status404());
      } catch (err) {
        if (err !== null && typeof err === "object" && rethrown.has(err)) throw err;
        report(err, "request", { req });
        return status(500);
      }
    },

    websocket: {
      open(ws) {
        const entry = pageFor(ws.data.lid, ws.data.sid);
        if (!entry) {
          ws.send(encode({ t: "expired" }));
          ws.close(1008, "expired");
          return;
        }
        ws.send(encode({ t: "hello", session: randomId(), p: PROTOCOL_VERSION }));
        sockets.set(ws, attach(entry, (msg) => ws.send(encode(msg))));
      },
      async message(ws, data) {
        const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
        const entry = pageFor(ws.data.lid, ws.data.sid);
        if (!entry) {
          ws.send(encode({ t: "expired" }));
          ws.close(1008, "expired");
          return;
        }
        if (!limiter.take(ws.data.sid)) {
          ws.send(encode({ t: "error", message: "Rate limited" }));
          return;
        }
        const msg = decodeClientMessage(raw);
        if (!msg) {
          ws.close(1008, "bad message");
          return;
        }
        if (msg.t === "text") {
          sharedOn(entry, msg);
          return;
        }
        if (msg.t === "point") {
          pointMessage(entry, entry.ctx, msg, (m) => send(entry, m));
          return;
        }
        try {
          const outs = await dispatchTo(entry, entry.sid, msg);
          for (const out of outs) {
            ws.send(encode(out));
          }
        } catch (err) {
          report(err, "event", { route: entry.route, ctx: entry.ctx, handler: msg.handler });
          ws.send(encode({ t: "error", message: "Server error", ack: msg.seq }));
        }
      },
      close(ws) {
        sockets.get(ws)?.();
        sockets.delete(ws);
      },
    },

    async drain(o = {}) {
      const delayMs = o.delayMs ?? 0;
      const timeoutMs = o.timeoutMs ?? 10_000;
      for (const [k, v] of [["delayMs", delayMs], ["timeoutMs", timeoutMs]] as const) {
        if (!Number.isFinite(v) || v < 0) throw new RangeError(`drain: ${k} is a number of ms, 0 or more`);
      }
      draining = true;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const until = Date.now() + timeoutMs;
      while (inFlight > 0 && Date.now() < until) {
        await new Promise((r) => setTimeout(r, Math.min(25, Math.max(1, until - Date.now()))));
      }
      const settled = inFlight === 0;
      for (const [lid, e] of [...pages]) {
        let token: string | null = null;
        if (e.sinks.size > 0 && o.handoff !== false) {
          try {
            token = await sealHandoff(e);
          } catch {
            token = null;
          }
        }
        drop(lid, token);
      }
      return settled;
    },

    close() {
      removeHub();
      for (const r of [...etags.values()]) purge(r);
      for (const w of watched.values()) clearTimeout(w.timer);
      watched.clear();
      unReads?.();
      unsubscribe?.();
      unNotices?.();
      untrackFiles?.();
      unGap?.();
      unaudit?.();
      devDecisions.clear();
      unwatchStores?.();
      for (const lid of [...pages.keys()]) {
        drop(lid);
      }
      streams.clear();
      sockets.clear();
    },
  };
  {
    const route = app.fetch;
    app.fetch = async (req, server) => {
      inFlight++;
      let trace: TraceContext | null = null;
      if (telemetry) {
        try {
          trace = telemetry.startRequest(req);
          traces.set(req, trace);
        } catch (err) {
          onError(err);
        }
      }
      let status = 500;
      const scope = newScope(trace);
      const call = scope ? () => readScope!.run(scope, () => route(req, server)) : () => route(req, server);
      try {
        if (!logger) {
          const res = await call();
          status = res ? res.status : 101;
          return res;
        }
        const id = assignRequestId(req, opts.trustRequestId === true);
        const started = Date.now();
        const line = { requestId: id, method: req.method, path: new URL(req.url).pathname };
        let res: Response | undefined;
        try {
          res = await call();
        } catch (err) {
          logger.error("request failed", { ...line, ms: Date.now() - started, error: err });
          throw err;
        }
        if (res) {
          try {
            res.headers.set("x-request-id", id);
          } catch {
            res = new Response(res.body, res);
            res.headers.set("x-request-id", id);
          }
        }
        status = res ? res.status : 101;
        logger.info("request", { ...line, status, ms: Date.now() - started });
        return res;
      } finally {
        inFlight--;
        if (scope) {
          scope.open = false;
          if (scope.models && scope.models.size > 0) {
            checkReads(scope, routeOfReq.get(req) ?? "unknown", `${req.method} request`, undefined);
          }
        }
        if (telemetry && trace) {
          try {
            const route = routeOfReq.get(req);
            const info = { method: req.method, path: new URL(req.url).pathname, status };
            telemetry.endRequest(trace, route !== undefined ? { ...info, route } : info);
          } catch (err) {
            onError(err);
          }
        }
      }
    };
  }
  const compression = opts.compress === false ? null : opts.compress === true ? {} : (opts.compress ?? {});
  if (compression) {
    const route = app.fetch;
    app.fetch = async (req, server) => {
      const res = await route(req, server);
      return res ? compress(req, res, compression) : res;
    };
  }
  return app;
}

const CSP_REPORT = "/_weft/csp";
const PRINTING = new WeakSet<Request>();
const OG_RENDER = new WeakMap<Request, Component<object>>();
const CSP_KEY_OF: Record<string, string> = {
  "connect-src": "connect",
  "img-src": "img",
  "media-src": "media",
  "font-src": "font",
  "frame-src": "frame",
  "style-src": "style",
  "form-action": "form",
  "worker-src": "worker",
};

async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

export function parseCspReports(text: string, origin: string, patternAt: (path: string) => string | undefined): CspViolation[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const bodies: Record<string, unknown>[] = [];
  if (Array.isArray(raw)) {
    for (const r of raw.slice(0, 10)) {
      const o = r as { type?: unknown; body?: unknown };
      if (o && o.type === "csp-violation" && o.body && typeof o.body === "object") bodies.push(o.body as Record<string, unknown>);
    }
  } else if (raw && typeof raw === "object" && (raw as Record<string, unknown>)["csp-report"]) {
    const r = (raw as Record<string, unknown>)["csp-report"];
    if (r && typeof r === "object") bodies.push(r as Record<string, unknown>);
  }
  const str = (b: Record<string, unknown>, ...keys: string[]) => {
    for (const k of keys) if (typeof b[k] === "string") return (b[k] as string).slice(0, 2048);
    return "";
  };
  const out: CspViolation[] = [];
  for (const b of bodies) {
    let page: URL;
    try {
      page = new URL(str(b, "documentURL", "document-uri"));
    } catch {
      continue;
    }
    if (page.origin !== origin) continue;
    const directive = str(b, "effectiveDirective", "effective-directive", "violated-directive").split(" ")[0]!;
    if (!/^[a-z-]{1,32}$/.test(directive)) continue;
    const where = (u: string, ownPath: boolean): string | null => {
      if (/^(inline|eval|data|blob|wasm-eval|trusted-types-sink)$/.test(u)) return u;
      try {
        const p = new URL(u);
        if (p.protocol === "data:" || p.protocol === "blob:") return p.protocol.slice(0, -1);
        if (p.origin === origin) return ownPath ? p.pathname.slice(0, 200) : "self";
        return /^(https?|wss?):$/.test(p.protocol) ? p.origin : null;
      } catch {
        return null;
      }
    };
    const blocked = where(str(b, "blockedURL", "blocked-uri"), false);
    if (blocked === null) continue;
    out.push({
      route: patternAt(page.pathname) ?? null,
      directive,
      blocked,
      source: where(str(b, "sourceFile", "source-file"), true),
    });
  }
  return out;
}

function isPrefetch(req: Request): boolean {
  if (req.headers.get("x-weft-prefetch") === "1") {
    return true;
  }
  const purpose = (req.headers.get("purpose") ?? req.headers.get("sec-purpose") ?? "").toLowerCase();
  return purpose === "prefetch";
}

async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) {
    return new Uint8Array();
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    seen += value.byteLength;
    if (seen > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(seen);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function serverError(secure: boolean): Response {
  return new Response("Server error", {
    status: 500,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...securityHeaders({ nonce: randomId(16), secure }),
    },
  });
}

function status(code: number): Response {
  return new Response(null, { status: code });
}

function seeOther(to: string): Response {
  return new Response(null, { status: 303, headers: { location: to } });
}

function jsonSafe(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: String(value.message) };
  if (value === null || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "stack") continue;
    out[k] = jsonSafe(v, depth + 1);
  }
  return out;
}

function jsonResponse(code: number, body: unknown): Response {
  return new Response(JSON.stringify(jsonSafe(body)), {
    status: code,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function formFailure(code: number, message: string, url: URL): Response {
  const html =
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(message)}</title>` +
    `<p>${escapeHtml(message)}</p><p><a href="${escapeAttr(url.pathname)}">Back</a></p>`;
  return new Response(html, {
    status: code,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...securityHeaders({ nonce: randomId(16), secure: url.protocol === "https:" }),
    },
  });
}

function status404(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}
