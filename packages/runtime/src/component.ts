import { escapeAttr, setHeldSealer } from "./escape.ts";

export type Handler = (...args: never[]) => unknown;

export interface Instance {
  handlers: Record<string, Handler>;
  render: () => string;
  mount?: (() => unknown)[];
  destroy?: (() => unknown)[];
}

export function runHooks(hooks: (() => unknown)[] | undefined, onError: (err: unknown) => void): (() => unknown)[] {
  const cleanups: (() => unknown)[] = [];
  for (const hook of hooks ?? []) {
    try {
      const ret = hook();
      if (typeof ret === "function") {
        cleanups.push(ret as () => unknown);
      }
    } catch (err) {
      onError(err);
    }
  }
  return cleanups;
}

export interface ComponentDef<P extends object> {
  readonly name: string;
  readonly setup: (props: P) => Instance;
  readonly island?: boolean | string;
  readonly css?: string;
  readonly static?: boolean;
  readonly inert?: boolean;
}

export interface ComponentOptions {
  island?: boolean | string;
  css?: string;
  static?: boolean;
  inert?: boolean;
}

const stylesheets = new Set<string>();
const defined: string[] = [];
const transformed = new Map<string, string>();

export function styleOf(css: string): string {
  return transformed.get(css) ?? css;
}

export function allStyles(): string {
  return [...stylesheets].map(styleOf).join("\n");
}

export function styleMark(): number {
  return defined.length;
}

export function componentStyles(since = 0): string[] {
  return [...new Set(defined.slice(since))];
}

export function setComponentStyles(map: Readonly<Record<string, string>>): void {
  for (const [from, to] of Object.entries(map)) {
    transformed.set(from, to);
  }
}

export type Component<P extends object> = ((props: P) => string) & {
  readonly def: ComponentDef<P>;
};

export type GenericComponent<F extends (props: never) => string> = F & {
  readonly def: ComponentDef<never>;
};

export interface RenderContext {
  child<P extends object>(def: ComponentDef<P>, props: P): string;
  bindArgs(args: unknown[]): string;
  keyed?(key: string, render: () => string): string;
  invalidate?(): void;
  awaiting?(): void;
  owner?(): string;
  sealArgs?(action: string, args: readonly unknown[]): string;
}

let current: RenderContext | null = null;
setHeldSealer((action, args) => (current?.sealArgs ? current.sealArgs(action, args) : null));

export function renderAwaiting(): void {
  current?.awaiting?.();
}

export function withRenderContext<T>(ctx: RenderContext | null, fn: () => T): T {
  const prev = current;
  current = ctx;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

export function defineComponent<P extends object>(
  name: string,
  setup: (props: P) => Instance,
  opts: ComponentOptions = {},
): Component<P> {
  const def: ComponentDef<P> = Object.freeze({
    name,
    setup,
    ...(opts.island ? { island: opts.island } : {}),
    ...(opts.css ? { css: opts.css } : {}),
    ...(opts.static ? { static: true } : {}),
    ...(opts.inert ? { inert: true } : {}),
  });
  if (opts.css) {
    stylesheets.add(opts.css);
    defined.push(opts.css);
  }
  const call = (props: P): string => {
    if (current) {
      return current.child(def, props);
    }
    return withRenderContext(STATIC, () => setup(props).render());
  };
  return Object.assign(call, { def });
}

const STATIC: RenderContext = {
  child: (def, props) => withRenderContext(STATIC, () => def.setup(props).render()),
  bindArgs: () => "",
};

export function bindArgs(args: unknown[]): string {
  return (current ?? STATIC).bindArgs(args);
}

export function ownerAttr(event: string): string {
  const id = current?.owner?.();
  return id ? ` data-weft-owner-${event}="${escapeAttr(id)}"` : "";
}

export function keyed(key: string, render: () => string): string {
  const ctx = current;
  return ctx?.keyed ? ctx.keyed(key, render) : render();
}

interface Settlement {
  status: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  waiters: Set<() => void>;
}

const settlements = new WeakMap<object, Settlement>();

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

export function awaitBlock<T>(
  value: T,
  pending?: () => string,
  then?: (value: Awaited<T>) => string,
  katch?: (error: unknown) => string,
): string {
  if (!isThenable(value)) {
    return then ? then(value as Awaited<T>) : "";
  }
  let s = settlements.get(value);
  if (!s) {
    const entry: Settlement = { status: "pending", waiters: new Set() };
    s = entry;
    settlements.set(value, entry);
    const settle = (status: "fulfilled" | "rejected", v: unknown) => {
      entry.status = status;
      entry.value = v;
      const waiters = [...entry.waiters];
      entry.waiters.clear();
      for (const w of waiters) {
        w();
      }
    };
    value.then(
      (v) => settle("fulfilled", v),
      (e) => settle("rejected", e),
    );
  }
  switch (s.status) {
    case "fulfilled":
      return then ? then(s.value as Awaited<T>) : "";
    case "rejected":
      return katch ? katch(s.value) : "";
    default: {
      const invalidate = current?.invalidate;
      if (invalidate) {
        s.waiters.add(invalidate);
      }
      current?.awaiting?.();
      return pending ? pending() : "";
    }
  }
}

export function assignProps<P extends object>(target: P, next: P): void {
  const t = target as Record<string, unknown>;
  for (const key of Object.keys(t)) {
    if (!Object.hasOwn(next, key)) {
      delete t[key];
    }
  }
  Object.assign(t, next);
}
