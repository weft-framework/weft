import {
  argumentsOf,
  dateFormat,
  formatNodes,
  listFormat,
  MessageSyntaxError,
  numberFormat,
  parse,
  relativeFormat,
  type MessageParams,
} from "./icu.ts";

export { argumentsOf, format, MessageSyntaxError, parse, type MessageParams } from "./icu.ts";

export interface Catalog {
  readonly [key: string]: string | Catalog;
}

export function messages<const T extends Catalog>(catalog: T): T {
  return catalog;
}

export type Translation<T> = { readonly [K in keyof T]?: T[K] extends string ? string : Translation<T[K]> };

export function translation<T extends Catalog>(): <const U extends Translation<T>>(catalog: U & Exact<U, T>) => U {
  return (catalog) => catalog;
}

type Exact<U, T> = { [K in keyof U]: K extends keyof T ? (U[K] extends string ? unknown : Exact<U[K], T[K]>) : never };

export type Keys<C> = {
  [K in keyof C & string]: C[K] extends string ? K : `${K}.${Keys<C[K]>}`;
}[keyof C & string];

export type MessageAt<C, K extends string> = K extends `${infer H}.${infer R}`
  ? H extends keyof C
    ? MessageAt<C[H], R>
    : never
  : K extends keyof C
    ? C[K]
    : never;

type ParamsArg<M> = M extends string
  ? string extends M
    ? [params?: Record<string, unknown>]
    : keyof MessageParams<M> extends never
      ? [params?: Record<string, never>]
      : [params: MessageParams<M>]
  : [params?: Record<string, unknown>];

export type CatalogSource<C extends Catalog = Catalog> =
  | C
  | Translation<C>
  | (() => Promise<C | Translation<C> | { default: C | Translation<C> }>);

export interface CatalogSet<C extends Catalog = Catalog> {
  readonly name: string;
  readonly sources: Readonly<Record<string, CatalogSource<C>>>;
}

export type RelativeUnit = Intl.RelativeTimeFormatUnit;

export interface Translator<C> {
  <K extends Keys<C>>(key: K, ...params: ParamsArg<MessageAt<C, K>>): string;
  readonly locale: string;
  readonly dir: "ltr" | "rtl";
  has(key: string): boolean;
  number(value: number | bigint, options?: Intl.NumberFormatOptions): string;
  date(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
  time(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
  relative(value: number, unit: RelativeUnit, options?: Intl.RelativeTimeFormatOptions): string;
  relative(value: Date | number, options?: Intl.RelativeTimeFormatOptions & { now?: Date | number }): string;
  list(items: Iterable<string>, options?: Intl.ListFormatOptions): string;
}

const RTL = new Set(["ar", "arc", "ckb", "dv", "fa", "ha-arab", "he", "iw", "khw", "ks", "ps", "sd", "syr", "ug", "ur", "yi"]);

export function direction(locale: string): "ltr" | "rtl" {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & {
      getTextInfo?: () => { direction?: string };
      textInfo?: { direction?: string };
    };
    const info = l.getTextInfo?.() ?? l.textInfo;
    if (info?.direction === "rtl" || info?.direction === "ltr") return info.direction;
    if (l.script) return ["Arab", "Hebr", "Thaa", "Syrc", "Nkoo", "Adlm", "Rohg"].includes(l.script) ? "rtl" : "ltr";
    return RTL.has(l.language) ? "rtl" : "ltr";
  } catch {
    return RTL.has(locale.toLowerCase().split("-")[0]) ? "rtl" : "ltr";
  }
}

function lookup(catalog: Catalog | undefined, key: string): string | undefined {
  let node: string | Catalog | undefined = catalog;
  for (const part of key.split(".")) {
    if (node === undefined || typeof node === "string" || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

const UNITS: [RelativeUnit, number][] = [
  ["year", 365 * 24 * 3600e3],
  ["month", 30 * 24 * 3600e3],
  ["week", 7 * 24 * 3600e3],
  ["day", 24 * 3600e3],
  ["hour", 3600e3],
  ["minute", 60e3],
  ["second", 1e3],
];

function makeTranslator<C>(
  locale: string,
  layers: Catalog[],
  fallback: Catalog[],
  fallbackLocale: string,
  onMissing: (key: string, locale: string) => void,
  onError: (err: unknown, key: string, locale: string) => void,
): Translator<C> {
  const find = (list: Catalog[], key: string) => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = lookup(list[i], key);
      if (m !== undefined) return m;
    }
    return undefined;
  };
  const t = (key: string, params: Record<string, unknown> = {}) => {
    let message = find(layers, key);
    let lang = locale;
    if (message === undefined) {
      message = find(fallback, key);
      lang = fallbackLocale;
      onMissing(key, locale);
    }
    if (message === undefined) return key;
    try {
      return formatNodes(parse(message), params, lang);
    } catch (err) {
      onError(err, key, locale);
      return key;
    }
  };
  const date = (value: Date | number | string) => (value instanceof Date ? value : new Date(value));
  function relative(value: Date | number, unitOrOptions?: unknown, options?: Intl.RelativeTimeFormatOptions): string {
    if (typeof unitOrOptions === "string") {
      return relativeFormat(locale, options ?? { numeric: "auto" }).format(Number(value), unitOrOptions as RelativeUnit);
    }
    const opts = (unitOrOptions ?? {}) as Intl.RelativeTimeFormatOptions & { now?: Date | number };
    const { now, ...rest } = opts;
    const diff = date(value).getTime() - (now === undefined ? Date.now() : date(now).getTime());
    const [unit, size] = UNITS.find(([, ms]) => Math.abs(diff) >= ms) ?? ["second", 1e3];
    const fmt = relativeFormat(locale, Object.keys(rest).length ? rest : { numeric: "auto" });
    return fmt.format(Math.round(diff / size), unit);
  }
  return Object.assign(t, {
    locale,
    dir: direction(locale),
    has: (key: string) => find(layers, key) !== undefined,
    number: (value: number | bigint, options?: Intl.NumberFormatOptions) => numberFormat(locale, options).format(value),
    date: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) =>
      dateFormat(locale, options ?? { dateStyle: "medium" }).format(date(value)),
    time: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) =>
      dateFormat(locale, options ?? { timeStyle: "short" }).format(date(value)),
    relative: relative as Translator<C>["relative"],
    list: (items: Iterable<string>, options?: Intl.ListFormatOptions) => listFormat(locale, options).format(items),
  }) as unknown as Translator<C>;
}

export type LocaleSource = "url" | "cookie" | "header" | "default";

export function match(requested: readonly string[], supported: readonly string[]): string | null {
  const lower = supported.map((s) => s.toLowerCase());
  for (const want of requested) {
    const w = want.toLowerCase();
    const exact = lower.indexOf(w);
    if (exact >= 0) return supported[exact];
    const lang = w.split("-")[0];
    const base = lower.indexOf(lang);
    if (base >= 0) return supported[base];
    const sibling = lower.findIndex((s) => s.split("-")[0] === lang);
    if (sibling >= 0) return supported[sibling];
  }
  return null;
}

export function acceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .slice(0, 32)
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), i };
    })
    .filter((e) => /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(e.tag) && e.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((e) => e.tag);
}

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface Pattern {
  canonical: string[];
  localized: Record<string, string[]>;
}

const segments = (path: string) => path.split("/").filter(Boolean);

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const decoded = (segment: string) => safeDecode(segment).toLowerCase();

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const p = pattern[i];
    const rest = /^\[\.\.\.(\w+)\]$/.exec(p);
    if (rest) {
      if (i !== pattern.length - 1 || parts.length <= i) return null;
      params[rest[1]] = parts.slice(i).join("/");
      return params;
    }
    if (i >= parts.length) return null;
    const param = /^\[(\w+)\]$/.exec(p);
    if (param) params[param[1]] = parts[i];
    else if (decoded(p) !== decoded(parts[i])) return null;
  }
  return parts.length === pattern.length ? params : null;
}

function fill(pattern: string[], params: Record<string, string>): string {
  return (
    "/" +
    pattern
      .map((p) => {
        const name = /^\[(?:\.\.\.)?(\w+)\]$/.exec(p)?.[1];
        return name === undefined ? encodeURIComponent(safeDecode(p)) : params[name];
      })
      .join("/")
  );
}

function splitPath(href: string): [string, string] {
  const at = href.search(/[?#]/);
  return at < 0 ? [href, ""] : [href.slice(0, at), href.slice(at)];
}

export interface I18nConfig<L extends string, C extends Catalog> {
  locales: readonly L[];
  defaultLocale: NoInfer<L>;
  messages: C;
  catalogs?: { [K in L]?: CatalogSource<NoInfer<C>> };
  prefix?: "as-needed" | "always" | "never";
  routes?: Record<string, Partial<Record<NoInfer<L>, string>>>;
  cookie?: string | false;
  onMissing?: (key: string, locale: string) => void;
  onError?: (err: unknown, key: string, locale: string) => void;
}

export interface Negotiated<L extends string> {
  locale: L;
  from: LocaleSource;
  path: string;
  canonical: string;
}

export interface I18n<L extends string, C extends Catalog> {
  readonly locales: readonly L[];
  readonly defaultLocale: L;
  negotiate(req: Request): Negotiated<L>;
  locale(req: Request): L;
  translator(locale: string): Promise<Translator<C>>;
  translator<E extends Catalog>(locale: string, extra: CatalogSet<E>): Promise<Translator<C & E>>;
  catalog<E extends Catalog>(name: string, sources: { [K in L]?: CatalogSource<E> }): CatalogSet<E>;
  href(path: string, locale: string): string;
  resolve(pathname: string): { locale: L | null; path: string; canonical: string };
  alternates(path: string): { locale: L | "x-default"; href: string }[];
  middleware: (ctx: { request: Request; url: URL }) => Response | { rewrite: string } | undefined;
  htmlAttributes: (req: Request) => { lang: string; dir: "ltr" | "rtl" };
  missing(): Record<string, string[]>;
}

const DEV = typeof process !== "undefined" && process.env?.NODE_ENV !== "production";

export function defineI18n<const L extends string, C extends Catalog>(config: I18nConfig<L, C>): I18n<L, C> {
  const locales = [...config.locales];
  if (locales.length === 0) throw new Error("@weft/i18n: locales is empty");
  for (const l of locales) {
    try {
      new Intl.Locale(l);
    } catch {
      throw new Error(`@weft/i18n: "${l}" is not a locale tag`);
    }
  }
  const def = config.defaultLocale;
  if (!locales.includes(def)) throw new Error(`@weft/i18n: defaultLocale "${def}" is not in locales`);
  const prefix = config.prefix ?? "as-needed";
  const cookie = config.cookie === undefined ? "weft-locale" : config.cookie;
  const misses = new Map<string, Set<string>>();
  const onMissing = (key: string, locale: string) => {
    let set = misses.get(locale);
    if (!set) misses.set(locale, (set = new Set()));
    if (set.has(key)) return;
    set.add(key);
    if (config.onMissing) config.onMissing(key, locale);
    else if (DEV && locale !== def) console.warn(`@weft/i18n: "${key}" has no ${locale} translation; using ${def}`);
  };
  const onError =
    config.onError ??
    ((err: unknown, key: string, locale: string) => {
      console.error(`@weft/i18n: ${locale} "${key}": ${err instanceof MessageSyntaxError ? err.message : String(err)}`);
    });

  const patterns: Pattern[] = Object.entries(config.routes ?? {}).map(([canonical, byLocale]) => ({
    canonical: segments(canonical),
    localized: Object.fromEntries(
      Object.entries(byLocale as Record<string, string>).map(([l, p]) => [l, segments(p)]),
    ),
  }));

  const loaded = new Map<string, Promise<Catalog>>();
  const load = (key: string, source: CatalogSource | undefined): Promise<Catalog> => {
    if (source === undefined) return Promise.resolve({});
    let p = loaded.get(key);
    if (!p) {
      p =
        typeof source === "function"
          ? (source as () => Promise<unknown>)().then((m) => {
              const c = (m && typeof m === "object" && "default" in m ? (m as { default: unknown }).default : m) as Catalog;
              return c ?? {};
            })
          : Promise.resolve(source as Catalog);
      p.catch(() => loaded.delete(key));
      loaded.set(key, p);
    }
    return p;
  };
  const supported = (locale: string): L => (match([locale], locales) ?? def) as L;

  function localeOfPrefix(parts: string[]): L | null {
    if (prefix === "never" || parts.length === 0) return null;
    const i = locales.findIndex((l) => l.toLowerCase() === parts[0].toLowerCase());
    return i >= 0 ? locales[i] : null;
  }

  function canonicalOf(parts: string[], locale: L): string {
    for (const p of patterns) {
      const loc = p.localized[locale];
      if (!loc) continue;
      const params = matchSegments(loc, parts);
      if (params) return fill(p.canonical, params);
    }
    return "/" + parts.join("/");
  }

  function resolve(pathname: string) {
    const parts = segments(pathname);
    const locale = localeOfPrefix(parts);
    const rest = locale === null ? parts : parts.slice(1);
    const path = "/" + rest.join("/");
    return { locale, path, canonical: canonicalOf(rest, locale ?? def) };
  }

  function localizedPath(canonical: string, locale: L): string {
    const parts = segments(canonical);
    for (const p of patterns) {
      const params = matchSegments(p.canonical, parts);
      const loc = p.localized[locale];
      if (params && loc) return fill(loc, params);
    }
    return "/" + parts.join("/");
  }

  function href(path: string, locale: string): string {
    const l = supported(locale);
    const [pathname, tail] = splitPath(path);
    const local = localizedPath(pathname, l);
    const prefixed = prefix === "always" || (prefix === "as-needed" && l !== def);
    const out = prefixed ? `/${l}${local === "/" ? "" : local}` : local;
    return (out === "" ? "/" : out) + tail;
  }

  function negotiate(req: Request): Negotiated<L> {
    const url = new URL(req.url);
    const r = resolve(url.pathname);
    if (r.locale !== null) return { locale: r.locale, from: "url", path: r.path, canonical: r.canonical };
    const base = (locale: L, from: LocaleSource): Negotiated<L> => ({
      locale,
      from,
      path: r.path,
      canonical: canonicalOf(segments(r.path), prefix === "as-needed" ? def : locale),
    });
    if (prefix === "as-needed") return base(def, "url");
    const saved = cookie ? cookieValue(req, cookie) : null;
    const fromCookie = saved ? match([saved], locales) : null;
    if (fromCookie) return base(fromCookie as L, "cookie");
    const fromHeader = match(acceptLanguage(req.headers.get("accept-language")), locales);
    if (fromHeader) return base(fromHeader as L, "header");
    return base(def, "default");
  }

  function preferred(req: Request): L {
    const saved = cookie ? cookieValue(req, cookie) : null;
    return (match([saved ?? "", ...acceptLanguage(req.headers.get("accept-language"))].filter(Boolean), locales) ?? def) as L;
  }

  const middleware = (ctx: { request: Request; url: URL }) => {
    const { url } = ctx;
    if (url.pathname.startsWith("/_weft/")) return undefined;
    const r = resolve(url.pathname);
    const redirect = (to: string) => {
      const target = new URL(to + url.search, url);
      return target.pathname === url.pathname ? undefined : Response.redirect(target.toString(), 307);
    };
    if (prefix === "always" && r.locale === null) {
      return redirect(href(r.canonical, preferred(ctx.request)));
    }
    const locale = r.locale ?? (prefix === "as-needed" ? def : preferred(ctx.request));
    const want = href(r.canonical, locale);
    if (prefix !== "never" && (r.locale !== null || prefix === "as-needed")) {
      const moved = redirect(splitPath(want)[0]);
      if (moved) return moved;
    }
    return r.canonical === url.pathname ? undefined : { rewrite: r.canonical };
  };

  return {
    locales,
    defaultLocale: def,
    negotiate,
    locale: (req) => negotiate(req).locale,
    async translator(locale: string, extra?: CatalogSet) {
      const l = supported(locale);
      const base = config.messages;
      const own = l === def ? base : await load(`:${l}`, config.catalogs?.[l]);
      const extraDef = extra ? await load(`${extra.name}:${def}`, extra.sources[def]) : undefined;
      const extraOwn = extra && l !== def ? await load(`${extra.name}:${l}`, extra.sources[l]) : extraDef;
      const layers = [own, ...(extraOwn ? [extraOwn] : [])];
      const fallback = [base, ...(extraDef ? [extraDef] : [])];
      return makeTranslator(l, layers, fallback, def, onMissing, onError);
    },
    catalog: (name, sources) => {
      if (!/^[\w-]+$/.test(name)) throw new Error(`@weft/i18n: bad catalog name "${name}"`);
      return { name, sources: sources as Record<string, CatalogSource> };
    },
    href,
    resolve,
    alternates(path: string) {
      const [pathname] = splitPath(path);
      const canonical = resolve(pathname).canonical;
      const out: { locale: L | "x-default"; href: string }[] = locales.map((l) => ({ locale: l, href: href(canonical, l) }));
      out.push({ locale: "x-default", href: href(canonical, def) });
      return out;
    },
    middleware,
    htmlAttributes: (req: Request) => {
      const locale = negotiate(req).locale;
      return { lang: locale, dir: direction(locale) };
    },
    missing: () => Object.fromEntries([...misses].map(([l, keys]) => [l, [...keys].sort()])),
  } as I18n<L, C>;
}

export function catalogEntries(catalog: Catalog, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(catalog)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push([key, v]);
    else out.push(...catalogEntries(v, key));
  }
  return out;
}

export function compareCatalogs(base: Catalog, other: Catalog): { missing: string[]; extra: string[]; mismatched: string[] } {
  const a = new Map(catalogEntries(base));
  const b = new Map(catalogEntries(other));
  const missing = [...a.keys()].filter((k) => !b.has(k));
  const extra = [...b.keys()].filter((k) => !a.has(k));
  const mismatched: string[] = [];
  for (const [k, m] of b) {
    const want = a.get(k);
    if (want === undefined) continue;
    const x = [...argumentsOf(want).keys()].sort().join(",");
    const y = [...argumentsOf(m).keys()].sort().join(",");
    if (x !== y) mismatched.push(k);
  }
  return { missing, extra, mismatched };
}
