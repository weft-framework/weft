const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const HTML_PATTERN = /[&<>"']/g;

export class Html {
  readonly html: string;
  constructor(html: string) {
    this.html = html;
  }
  toString(): string {
    return this.html;
  }
}

export function trustHtml(html: string): Html {
  return new Html(html);
}

export function escapeHtml(value: unknown): string {
  if (value instanceof Html) {
    return value.html;
  }
  if (value === undefined || value === null) {
    return "";
  }
  const s = typeof value === "string" ? value : String(value);
  return s.replace(HTML_PATTERN, (ch) => HTML_ENTITIES[ch]);
}

export function escapeAttr(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  const s = typeof value === "string" ? value : String(value);
  return s.replace(HTML_PATTERN, (ch) => HTML_ENTITIES[ch]);
}

const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "poster", "cite", "background", "ping"]);

export const BLOCKED_URL = "about:invalid#weft-blocked";

const SAFE_DATA = /^data:image\/(?:png|gif|jpe?g|webp|avif|bmp)[;,]/;

export function isUrlAttr(attr: string): boolean {
  return URL_ATTRS.has(attr.toLowerCase());
}

export function safeUrl(value: unknown, attr = "href"): string {
  if (value === undefined || value === null) {
    return "";
  }
  const s = typeof value === "string" ? value : String(value);
  const compact = s.replace(/[\u0000- \u007f]+/g, "").toLowerCase();
  if (compact.startsWith("javascript:") || compact.startsWith("vbscript:")) {
    return BLOCKED_URL;
  }
  if (compact.startsWith("data:")) {
    const a = attr.toLowerCase();
    return (a === "src" || a === "poster") && SAFE_DATA.test(compact) ? s : BLOCKED_URL;
  }
  return s;
}

export function escapeUrl(value: unknown, attr = "href"): string {
  return escapeAttr(safeUrl(value, attr));
}

const ACTION = Symbol.for("weft.action");
const BOUND = Symbol.for("weft.boundAction");

export const HELD_FIELD = "_weft_held";

let sealHeld: (action: string, args: readonly unknown[]) => string | null = () => null;

export function setHeldSealer(fn: (action: string, args: readonly unknown[]) => string | null): void {
  sealHeld = fn;
}

export function actionAttr(attr: "action" | "formaction", value: unknown): string {
  if (typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BOUND] === true) {
    const b = value as { name: string; args: readonly unknown[] };
    const token = sealHeld(b.name, b.args);
    if (token === null) {
      throw new Error(`${b.name}.with(..): a bound action renders only in a live server page`);
    }
    const method = attr === "action" ? "method" : "formmethod";
    const n = escapeAttr(b.name);
    const t = escapeAttr(token);
    return ` ${attr}="?/${n}&amp;${HELD_FIELD}=${t}" ${method}="post" data-weft-action="${n}" data-weft-held="${t}"`;
  }
  const name =
    typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[ACTION] === true
      ? (value as { name: string }).name
      : null;
  if (name === null) {
    return ` ${attr}="${escapeUrl(value, attr)}"`;
  }
  const method = attr === "action" ? "method" : "formmethod";
  const n = escapeAttr(name);
  return ` ${attr}="?/${n}" ${method}="post" data-weft-action="${n}"`;
}

export function cssVars(scope: string, values: unknown[]): string {
  const vars: Record<string, string> = {};
  values.forEach((v, i) => {
    if (v !== null && v !== undefined && v !== false) vars[`--${scope}-${i}`] = String(v);
  });
  return ` data-weft-vars="${escapeAttr(JSON.stringify(vars))}"`;
}

export type Attrs = { readonly [name: string]: unknown };

const ATTR_NAME = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

function refusedSpreadName(lower: string): boolean {
  return (
    (lower.length > 2 && lower.startsWith("on")) ||
    lower === "srcdoc" ||
    (lower.startsWith("data-weft-") && lower !== "data-weft-message")
  );
}

const RUNTIME_SPREAD = new Set(["data-weft-point"]);
const runtimeMade = new WeakSet<object>();

export function runtimeAttrs(attrs: Record<string, string>): Readonly<Record<string, string>> {
  const out = Object.freeze({ ...attrs });
  runtimeMade.add(out);
  return out;
}

export const FORWARDED_EVENTS = "data-weft-events";

const forwarded = new WeakMap<ForwardedEvents, string>();

export class ForwardedEvents {
  constructor(html: string) {
    forwarded.set(this, String(html));
  }
}

export function forwardEvents(html: string): ForwardedEvents {
  return new ForwardedEvents(html);
}

export function spreadAttrs(attrs: unknown, written: readonly string[] = []): string {
  if (attrs === null || attrs === undefined || typeof attrs !== "object") {
    return "";
  }
  let out = "";
  const trusted = runtimeMade.has(attrs);
  for (const [name, value] of Object.entries(attrs as Record<string, unknown>)) {
    const lower = name.toLowerCase();
    if (name === FORWARDED_EVENTS) {
      if (value instanceof ForwardedEvents) out += forwarded.get(value) ?? "";
      continue;
    }
    const allowed = trusted && RUNTIME_SPREAD.has(lower) && typeof value === "string";
    if (!ATTR_NAME.test(name) || (refusedSpreadName(lower) && !allowed) || written.includes(lower)) {
      continue;
    }
    if (value === null || value === undefined || value === false || typeof value === "function") {
      continue;
    }
    if (lower === "action" || lower === "formaction") {
      out += actionAttr(lower, value);
    } else if (value === true) {
      out += ` ${name}`;
    } else if (isUrlAttr(lower)) {
      out += ` ${name}="${escapeUrl(value, lower)}"`;
    } else {
      out += ` ${name}="${escapeAttr(value)}"`;
    }
  }
  return out;
}

export function restProps<T extends object>(props: object, named: readonly string[]): T {
  const skip = (k: string | symbol) => typeof k !== "string" || k === "children" || named.includes(k);
  const target = props as Record<string | symbol, unknown>;
  return new Proxy(Object.create(null) as T, {
    get: (_, k) => (skip(k) ? undefined : target[k]),
    has: (_, k) => !skip(k) && Object.hasOwn(target, k),
    ownKeys: () => Reflect.ownKeys(target).filter((k) => !skip(k) && Object.getOwnPropertyDescriptor(target, k)?.enumerable),
    getOwnPropertyDescriptor: (_, k) =>
      skip(k) || !Object.hasOwn(target, k)
        ? undefined
        : { value: target[k], writable: false, enumerable: true, configurable: true },
  });
}
