export type Node =
  | string
  | { k: "arg"; name: string }
  | { k: "number"; name: string; style: string }
  | { k: "date"; name: string; style: string; time: boolean }
  | { k: "plural"; name: string; ordinal: boolean; offset: number; options: Record<string, Node[]> }
  | { k: "select"; name: string; options: Record<string, Node[]> }
  | { k: "pound" };

export type ArgKind = "any" | "number" | "date" | "select";

export class MessageSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} at ${offset}`);
    this.name = "MessageSyntaxError";
    this.offset = offset;
  }
}

const NAME = /^[A-Za-z_$][\w$]*$/;
const PLURAL_KEYS = new Set(["zero", "one", "two", "few", "many", "other"]);

class Parser {
  i = 0;
  readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  fail(message: string, at = this.i): never {
    throw new MessageSyntaxError(message, at);
  }

  ws(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i += 1;
  }

  word(): string {
    this.ws();
    const start = this.i;
    while (this.i < this.src.length && !/[\s,{}]/.test(this.src[this.i])) this.i += 1;
    return this.src.slice(start, this.i);
  }

  expect(ch: string): void {
    this.ws();
    if (this.src[this.i] !== ch) this.fail(`expected "${ch}"`);
    this.i += 1;
  }

  message(inPlural: boolean, top: boolean): Node[] {
    const out: Node[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push(text);
      text = "";
    };
    while (this.i < this.src.length) {
      const ch = this.src[this.i];
      if (ch === "'") {
        const next = this.src[this.i + 1];
        if (next === "'") {
          text += "'";
          this.i += 2;
        } else if (next === "{" || next === "}" || next === "|" || (next === "#" && inPlural)) {
          this.i += 1;
          for (;;) {
            if (this.i >= this.src.length) break;
            const c = this.src[this.i];
            if (c === "'") {
              if (this.src[this.i + 1] === "'") {
                text += "'";
                this.i += 2;
                continue;
              }
              this.i += 1;
              break;
            }
            text += c;
            this.i += 1;
          }
        } else {
          text += "'";
          this.i += 1;
        }
      } else if (ch === "{") {
        flush();
        out.push(this.argument());
      } else if (ch === "}") {
        if (top) this.fail('unmatched "}"');
        break;
      } else if (ch === "#" && inPlural) {
        flush();
        out.push({ k: "pound" });
        this.i += 1;
      } else {
        text += ch;
        this.i += 1;
      }
    }
    flush();
    return out;
  }

  argument(): Node {
    const open = this.i;
    this.i += 1;
    const name = this.word();
    if (!NAME.test(name)) this.fail(`bad argument name "${name}"`, open + 1);
    this.ws();
    if (this.src[this.i] === "}") {
      this.i += 1;
      return { k: "arg", name };
    }
    this.expect(",");
    const type = this.word();
    this.ws();
    if (type === "plural" || type === "selectordinal" || type === "select") {
      this.expect(",");
      return type === "select" ? this.select(name) : this.plural(name, type === "selectordinal");
    }
    if (type !== "number" && type !== "date" && type !== "time") this.fail(`unknown argument type "${type}"`);
    let style = "";
    if (this.src[this.i] === ",") {
      this.i += 1;
      this.ws();
      const start = this.i;
      while (this.i < this.src.length && this.src[this.i] !== "}") this.i += 1;
      style = this.src.slice(start, this.i).trim();
    }
    this.expect("}");
    if (type === "number") return { k: "number", name, style };
    return { k: "date", name, style, time: type === "time" };
  }

  options(plural: boolean): Record<string, Node[]> {
    const options: Record<string, Node[]> = {};
    for (;;) {
      this.ws();
      if (this.i >= this.src.length) this.fail("unterminated argument");
      if (this.src[this.i] === "}") {
        this.i += 1;
        break;
      }
      const at = this.i;
      const key = this.word();
      if (!key) this.fail("expected an option");
      if (plural && !PLURAL_KEYS.has(key) && !/^=\d+(\.\d+)?$/.test(key)) this.fail(`bad plural option "${key}"`, at);
      if (Object.hasOwn(options, key)) this.fail(`duplicate option "${key}"`, at);
      this.expect("{");
      options[key] = this.message(plural, false);
      this.expect("}");
    }
    if (!Object.hasOwn(options, "other")) this.fail('an "other" option is required');
    return options;
  }

  plural(name: string, ordinal: boolean): Node {
    this.ws();
    let offset = 0;
    const m = /^offset:\s*(\d+)/.exec(this.src.slice(this.i));
    if (m) {
      offset = Number(m[1]);
      this.i += m[0].length;
    }
    return { k: "plural", name, ordinal, offset, options: this.options(true) };
  }

  select(name: string): Node {
    return { k: "select", name, options: this.options(false) };
  }
}

const parsed = new Map<string, Node[]>();

export function parse(message: string): Node[] {
  let nodes = parsed.get(message);
  if (!nodes) {
    nodes = new Parser(message).message(false, true);
    if (parsed.size > 5000) parsed.clear();
    parsed.set(message, nodes);
  }
  return nodes;
}

export function argumentsOf(message: string): Map<string, ArgKind> {
  const out = new Map<string, ArgKind>();
  const put = (name: string, kind: ArgKind) => {
    const was = out.get(name);
    if (!was || was === "any") out.set(name, kind);
  };
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (typeof n === "string" || n.k === "pound") continue;
      if (n.k === "arg") put(n.name, "any");
      else if (n.k === "number") put(n.name, "number");
      else if (n.k === "date") put(n.name, "date");
      else if (n.k === "plural") put(n.name, "number");
      else put(n.name, "select");
      if (n.k === "plural" || n.k === "select") for (const o of Object.values(n.options)) walk(o);
    }
  };
  walk(parse(message));
  return out;
}

const cache = new Map<string, unknown>();

function cached<T>(kind: string, locale: string, opts: object | undefined, make: () => T): T {
  const key = `${kind}|${locale}|${opts === undefined ? "" : JSON.stringify(opts)}`;
  let v = cache.get(key) as T | undefined;
  if (v === undefined) {
    v = make();
    if (cache.size > 500) cache.clear();
    cache.set(key, v);
  }
  return v;
}

export function numberFormat(locale: string, opts?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cached("n", locale, opts, () => new Intl.NumberFormat(locale, opts));
}

export function dateFormat(locale: string, opts?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached("d", locale, opts, () => new Intl.DateTimeFormat(locale, opts));
}

export function pluralRules(locale: string, ordinal: boolean): Intl.PluralRules {
  return cached("p", locale, { ordinal }, () => new Intl.PluralRules(locale, { type: ordinal ? "ordinal" : "cardinal" }));
}

export function relativeFormat(locale: string, opts?: Intl.RelativeTimeFormatOptions): Intl.RelativeTimeFormat {
  return cached("r", locale, opts, () => new Intl.RelativeTimeFormat(locale, opts));
}

export function listFormat(locale: string, opts?: Intl.ListFormatOptions): Intl.ListFormat {
  return cached("l", locale, opts, () => new Intl.ListFormat(locale, opts));
}

function numberStyle(style: string): Intl.NumberFormatOptions | undefined {
  if (style === "") return undefined;
  if (style === "integer") return { maximumFractionDigits: 0 };
  if (style === "percent") return { style: "percent" };
  const currency = /^currency\/([A-Za-z]{3})$/.exec(style);
  if (currency) return { style: "currency", currency: currency[1].toUpperCase() };
  const unit = /^unit\/([a-z-]+)$/.exec(style);
  if (unit) return { style: "unit", unit: unit[1] };
  return undefined;
}

function dateStyle(style: string, time: boolean): Intl.DateTimeFormatOptions {
  const s = style === "short" || style === "medium" || style === "long" || style === "full" ? style : "medium";
  return time ? { timeStyle: s } : { dateStyle: s };
}

function toNumber(v: unknown): number {
  return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(String(v));
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(typeof v === "number" ? v : String(v));
}

function show(v: unknown, locale: string): string {
  if (typeof v === "number") return numberFormat(locale).format(v);
  if (v instanceof Date) return dateFormat(locale).format(v);
  return v === null || v === undefined ? "" : String(v);
}

export function formatNodes(nodes: Node[], params: Record<string, unknown>, locale: string, pound?: string): string {
  let out = "";
  for (const n of nodes) {
    if (typeof n === "string") {
      out += n;
      continue;
    }
    if (n.k === "pound") {
      out += pound ?? "#";
      continue;
    }
    if (!Object.hasOwn(params, n.name)) {
      out += `{${n.name}}`;
      continue;
    }
    const v = params[n.name];
    if (n.k === "arg") out += show(v, locale);
    else if (n.k === "number") out += numberFormat(locale, numberStyle(n.style)).format(toNumber(v));
    else if (n.k === "date") out += dateFormat(locale, dateStyle(n.style, n.time)).format(toDate(v));
    else if (n.k === "select") {
      const key = String(v);
      out += formatNodes(Object.hasOwn(n.options, key) ? n.options[key] : n.options.other, params, locale, pound);
    } else {
      const value = toNumber(v);
      const exact = n.options[`=${value}`];
      const shifted = value - n.offset;
      const branch = exact ?? n.options[pluralRules(locale, n.ordinal).select(shifted)] ?? n.options.other;
      out += formatNodes(branch, params, locale, numberFormat(locale).format(shifted));
    }
  }
  return out;
}

export function format(message: string, params: Record<string, unknown> = {}, locale = "en"): string {
  return formatNodes(parse(message), params, locale);
}

type Ws = " " | "\n" | "\t" | "\r";
type Trim<S extends string> = S extends `${Ws}${infer R}` ? Trim<R> : S extends `${infer R}${Ws}` ? Trim<R> : S;
type HasBrace<S extends string> = S extends `${string}${"{" | "}"}${string}` ? true : false;
type IsName<S extends string> = S extends "" ? false : S extends `${string}${Ws | "#" | "'" | "," | "{" | "}"}${string}` ? false : true;
type Add<Acc, N extends string, T> = IsName<N> extends true ? Acc & { [P in N]: T } : Acc;
type Kind<T extends string> = T extends "number" ? number : T extends "date" | "time" ? Date | number : string | number;
type Pop<S extends unknown[]> = S extends [...infer R, unknown] ? R : [];
type Top<S extends unknown[]> = S extends [...unknown[], infer L] ? L : "M";

type Scan<S extends string, Stack extends unknown[], Acc> =
  Top<Stack> extends "O"
    ? S extends `${infer K}{${infer After}`
      ? K extends `${string}}${infer Rest}`
        ? Scan<`${Rest}{${After}`, Pop<Stack>, Acc>
        : Scan<After, [...Stack, "M"], Acc>
      : S extends `${string}}${infer Rest}`
        ? Scan<Rest, Pop<Stack>, Acc>
        : Acc
    : S extends `${infer Before}{${infer After}`
      ? Before extends `${string}}${infer Rest}`
        ? Scan<`${Rest}{${After}`, Pop<Stack>, Acc>
        : Arg<After, Stack, Acc>
      : S extends `${string}}${infer Rest}`
        ? Scan<Rest, Pop<Stack>, Acc>
        : Acc;

type Arg<S extends string, Stack extends unknown[], Acc> =
  S extends `${infer N},${infer R}`
    ? HasBrace<N> extends true
      ? Plain<S, Stack, Acc>
      : R extends `${infer T},${infer R2}`
        ? HasBrace<T> extends true
          ? Typed<Trim<N>, R, Stack, Acc>
          : Trim<T> extends "plural" | "selectordinal"
            ? Scan<R2, [...Stack, "O"], Add<Acc, Trim<N>, number>>
            : Trim<T> extends "select"
              ? Scan<R2, [...Stack, "O"], Add<Acc, Trim<N>, string>>
              : R2 extends `${string}}${infer R3}`
                ? Scan<R3, Stack, Add<Acc, Trim<N>, Kind<Trim<T>>>>
                : Acc
        : Typed<Trim<N>, R, Stack, Acc>
    : Plain<S, Stack, Acc>;

type Plain<S extends string, Stack extends unknown[], Acc> = S extends `${infer N}}${infer R}`
  ? Scan<R, Stack, Add<Acc, Trim<N>, string | number>>
  : Acc;

type Typed<N extends string, R extends string, Stack extends unknown[], Acc> = R extends `${infer T}}${infer R2}`
  ? Scan<R2, Stack, Add<Acc, N, Kind<Trim<T>>>>
  : Acc;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type MessageParams<S extends string> = string extends S
  ? Record<string, unknown>
  : Simplify<Scan<S, ["M"], {}>>;
