import {
  assignProps,
  collectSignals,
  effect,
  escapeAttr,
  runHooks,
  styleOf,
  untrack,
  withRenderContext,
  type Component,
  type ComponentDef,
  type EventMessage,
  type Instance,
  type RenderContext,
  type ServerMessage,
  type Signal,
} from "@weft/runtime";
import { randomId } from "./security.ts";

export class Redirect {
  readonly to: string;
  constructor(to: string) {
    this.to = to;
  }
}

export function redirect(to: string): Redirect {
  return new Redirect(to);
}

const ARG_RENDERS = 8;

interface BoundArgs {
  token: string;
  args: unknown[];
  render: number;
}

interface ArgTable {
  byKey: Map<string, BoundArgs>;
  byToken: Map<string, BoundArgs & { key: string }>;
  next: number;
  render: number;
}

function argTable(): ArgTable {
  return { byKey: new Map(), byToken: new Map(), next: 0, render: 0 };
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 0;
let nextUnkeyed = 0;

function argsKey(args: unknown[]): string {
  return args
    .map((v) => {
      switch (typeof v) {
        case "string":
          return JSON.stringify(v);
        case "number":
          return Object.is(v, -0) ? "n-0" : `n${v}`;
        case "bigint":
          return `b${v}`;
        case "boolean":
          return v ? "t" : "f";
        case "undefined":
          return "u";
        case "symbol":
          return `s${nextUnkeyed++}`;
        default: {
          if (v === null) {
            return "z";
          }
          const obj = v as object;
          let id = objectIds.get(obj);
          if (id === undefined) {
            id = nextObjectId++;
            objectIds.set(obj, id);
          }
          return `o${id}`;
        }
      }
    })
    .join(",");
}

interface Rec {
  id: string;
  def: ComponentDef<object>;
  props: object;
  inst: Instance;
  args: ArgTable;
  children: Map<string, Rec>;
  template: string;
  sent: string;
  key?: string;
  untrack?: () => void;
  cleanups: (() => unknown)[];
  inlined?: Set<string>;
  renders: number;
  ms: number;
  path: string;
  signals: Signal<unknown>[];
}

export type PageState = [path: string, name: string, count: number, values: [number, unknown][]][];

function plainData(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "object" || depth > 16) return false;
  if (Array.isArray(v)) return v.every((x) => plainData(x, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v as object).every((x) => plainData(x, depth + 1));
}

const kindOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export interface InspectNode {
  id: string;
  name: string;
  island: boolean;
  renders: number;
  ms: number;
  children: InspectNode[];
}

export type Reload = { props: object } | { message: ServerMessage } | null;

export interface LivePageOptions {
  onError?(err: unknown, msg?: EventMessage): void;
  maxInstances?: number;
  aroundRender?(render: () => void): void;
  restore?: PageState;
  sealArgs?(action: string, args: readonly unknown[]): string;
  onInvalidate?(): void;
}

export class LivePage {
  readonly id: string;
  private readonly root: Rec;
  private readonly byId = new Map<string, Rec>();
  private readonly opts: LivePageOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private readonly marker = randomId(12);
  private readonly invalidate = (): void => {
    if (!this.closed) this.opts.onInvalidate?.();
  };
  private working = false;
  private closed = false;
  private fresh: Rec[] = [];
  private pendingAwaits = 0;

  constructor(component: Component<object>, props: object, opts: LivePageOptions = {}) {
    this.id = randomId();
    this.opts = opts;
    if (opts.restore) {
      for (const [path, name, count, values] of opts.restore) this.restoring.set(path, { name, count, values });
    }
    this.root = this.create("r", component.def, props, "r");
  }

  private readonly restoring = new Map<string, { name: string; count: number; values: [number, unknown][] }>();

  snapshot(): PageState {
    const out: PageState = [];
    const walk = (rec: Rec): void => {
      if (rec.signals.length > 0) {
        const values: [number, unknown][] = [];
        rec.signals.forEach((s, i) => {
          const v = untrack(() => s.value);
          if (plainData(v)) values.push([i, v]);
        });
        if (values.length > 0) out.push([rec.path, rec.def.name, rec.signals.length, values]);
      }
      for (const c of rec.children.values()) walk(c);
    };
    walk(this.root);
    return out;
  }

  inspect(): InspectNode {
    const node = (rec: Rec): InspectNode => ({
      id: rec.id,
      name: rec.def.name,
      island: Boolean(rec.def.island),
      renders: rec.renders,
      ms: Math.round(rec.ms * 100) / 100,
      children: [...rec.children.values()].map(node),
    });
    return node(this.root);
  }

  styles(): string[] {
    const out = new Set<string>();
    for (const rec of this.byId.values()) {
      if (rec.def.css) out.add(styleOf(rec.def.css));
      for (const css of rec.inlined ?? []) out.add(styleOf(css));
    }
    return [...out];
  }

  render(): string {
    this.renderAll();
    this.markSent(this.root);
    return this.wrap(this.root);
  }

  get rootId(): string {
    return this.root.id;
  }

  html(): string {
    return this.wrap(this.root);
  }

  current(): ServerMessage {
    return { t: "patch", id: this.root.id, html: this.inner(this.root) };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.dispose(this.root);
  }

  get awaiting(): boolean {
    return this.pendingAwaits > 0;
  }

  inert(): boolean {
    for (const rec of this.byId.values()) {
      if (!rec.def.inert) return false;
    }
    return !this.awaiting;
  }

  quiet(): boolean {
    for (const rec of this.byId.values()) {
      if (Object.keys(rec.inst.handlers ?? {}).length > 0 || (rec.inst.mount?.length ?? 0) > 0) return false;
    }
    return !this.awaiting;
  }

  componentOf(id: string): string | undefined {
    return this.byId.get(id)?.def.name;
  }

  get size(): number {
    return this.byId.size;
  }

  dispatch(msg: EventMessage): Promise<ServerMessage[]> {
    const run = this.queue.then(() => this.apply(msg));
    this.queue = run.catch(() => undefined);
    return run;
  }

  refresh(reload?: () => Promise<Reload>): Promise<ServerMessage[]> {
    const run = this.queue.then(async (): Promise<ServerMessage[]> => {
      if (reload) {
        const next = await reload();
        if (next === null) {
          return [];
        }
        if ("message" in next) {
          return [next.message];
        }
        assignProps(this.root.props, next.props);
      }
      this.renderAll();
      const out: ServerMessage[] = [];
      this.collectPatches(this.root, undefined, out);
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private renderAll(): void {
    const around = this.opts.aroundRender;
    const was = this.working;
    this.working = true;
    this.pendingAwaits = 0;
    try {
      if (around) {
        around(() => this.renderTree(this.root));
      } else {
        this.renderTree(this.root);
      }
    } finally {
      this.working = was;
    }
    this.mountFresh();
  }

  private mountFresh(): void {
    const fresh = this.fresh;
    this.fresh = [];
    for (let i = fresh.length - 1; i >= 0; i -= 1) {
      const rec = fresh[i];
      if (this.closed || !this.byId.has(rec.id)) {
        continue;
      }
      rec.cleanups = runHooks(rec.inst.mount, (err) => this.opts.onError?.(err));
    }
  }

  private changed(): void {
    if (!this.working) {
      this.invalidate();
    }
  }

  private async apply(msg: EventMessage): Promise<ServerMessage[]> {
    const ack = msg.seq;
    const rec = this.byId.get(msg.id);
    const handler =
      rec && Object.hasOwn(rec.inst.handlers, msg.handler) ? rec.inst.handlers[msg.handler] : undefined;
    if (!rec || typeof handler !== "function") {
      return [{ t: "error", message: "Unknown handler", ack }];
    }
    let args: unknown[] = [];
    if (msg.args !== undefined) {
      const bound = rec.args.byToken.get(msg.args);
      if (!bound) {
        return [{ t: "error", message: "Stale event", ack }];
      }
      args = bound.args;
    }

    let result: unknown;
    this.working = true;
    try {
      result = await (handler as (...a: unknown[]) => unknown)(...args, msg.event);
    } catch (err) {
      this.opts.onError?.(err, msg);
      return [{ t: "error", message: "Handler failed", ack }];
    } finally {
      this.working = false;
    }

    if (result instanceof Redirect) {
      return [{ t: "redirect", to: result.to }];
    }
    this.renderAll();
    const out: ServerMessage[] = [];
    this.collectPatches(this.root, ack, out);
    if (out.length === 0) {
      out.push({ t: "ack", ack });
    }
    return out;
  }

  private create(id: string, def: ComponentDef<object>, props: object, path: string): Rec {
    const max = this.opts.maxInstances ?? 10_000;
    if (this.byId.size >= max) {
      throw new Error(`@weft/server: live page exceeded ${max} component instances`);
    }
    const live = { ...props };
    const made = collectSignals(() => def.setup(live));
    const saved = this.restoring.get(path);
    if (saved) {
      this.restoring.delete(path);
      if (saved.name === def.name && saved.count === made.signals.length) {
        for (const [i, v] of saved.values) {
          const s = made.signals[i];
          if (!s) continue;
          const was = untrack(() => s.value);
          if (was !== null && was !== undefined && kindOf(was) !== kindOf(v)) continue;
          try {
            s.value = v;
          } catch (err) {
            this.opts.onError?.(err);
          }
        }
      }
    }
    const rec: Rec = {
      id,
      def,
      props: live,
      inst: made.value,
      path,
      signals: made.signals,
      args: argTable(),
      children: new Map(),
      template: "",
      sent: "",
      cleanups: [],
      renders: 0,
      ms: 0,
    };
    this.byId.set(id, rec);
    this.fresh.push(rec);
    return rec;
  }

  private dispose(rec: Rec): void {
    for (const c of rec.children.values()) {
      this.dispose(c);
    }
    this.byId.delete(rec.id);
    rec.untrack?.();
    rec.untrack = undefined;
    const report = (err: unknown) => this.opts.onError?.(err);
    runHooks(rec.cleanups, report);
    rec.cleanups = [];
    runHooks(rec.inst.destroy, report);
  }

  private renderTree(rec: Rec): void {
    const table = rec.args;
    table.render += 1;
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    let pendingKey: string | null = null;
    rec.inlined = undefined;
    const ctx: RenderContext = {
      child: <P extends object>(def: ComponentDef<P>, props: P): string => {
        const itemKey = pendingKey;
        pendingKey = null;
        if (def.inert && !def.island) {
          if (def.css) (rec.inlined ??= new Set()).add(def.css);
          return def.setup(props).render();
        }
        let key = itemKey === null ? "" : `${def.name}#${itemKey}`;
        if (key === "" || seen.has(key)) {
          const n = counts.get(def.name) ?? 0;
          counts.set(def.name, n + 1);
          key = `${def.name}:${n}`;
        }
        seen.add(key);
        let child = rec.children.get(key);
        if (child && child.def === (def as ComponentDef<object>)) {
          if (def.static) {
            return this.placeholder(child.id);
          }
          assignProps(child.props, props);
        } else {
          if (child) {
            this.dispose(child);
          }
          child = this.create(`${rec.id}.${this.nextId++}`, def as ComponentDef<object>, props, `${rec.path}/${key}`);
          if (key.includes("#")) {
            child.key = itemKey ?? undefined;
          }
          rec.children.set(key, child);
        }
        this.renderTree(child);
        return this.placeholder(child.id);
      },
      owner: (): string => rec.id,
      ...(this.opts.sealArgs ? { sealArgs: this.opts.sealArgs } : {}),
      bindArgs: (args: unknown[]): string => {
        const key = argsKey(args);
        let bound = table.byKey.get(key);
        if (!bound) {
          const entry = { token: String(table.next++), args, render: table.render, key };
          table.byKey.set(key, entry);
          table.byToken.set(entry.token, entry);
          bound = entry;
        }
        bound.args = args;
        bound.render = table.render;
        return bound.token;
      },
      invalidate: this.invalidate,
      awaiting: () => {
        this.pendingAwaits += 1;
      },
      keyed: (key: string, render: () => string): string => {
        pendingKey = key;
        try {
          return render();
        } finally {
          pendingKey = null;
        }
      },
    };
    rec.untrack?.();
    let first = true;
    rec.untrack = effect(() => {
      if (first) {
        first = false;
        const started = performance.now();
        rec.template = withRenderContext(ctx, rec.inst.render);
        rec.ms = performance.now() - started;
        rec.renders += 1;
      } else {
        this.changed();
      }
    });
    for (const [token, bound] of table.byToken) {
      if (table.render - bound.render >= ARG_RENDERS) {
        table.byToken.delete(token);
        table.byKey.delete(bound.key);
      }
    }
    for (const [key, child] of rec.children) {
      if (!seen.has(key)) {
        this.dispose(child);
        rec.children.delete(key);
      }
    }
  }

  private placeholder(id: string): string {
    return `\u0000${this.marker}:${id}\u0000`;
  }

  private inner(rec: Rec, keep = false): string {
    if (!rec.template.includes("\u0000")) {
      return rec.template;
    }
    const re = new RegExp(`\u0000${this.marker}:([^\u0000]+)\u0000`, "g");
    return rec.template.replace(re, (_, id: string) => {
      const child = this.byId.get(id);
      if (!child) return "";
      if (keep && this.unchanged(child)) {
        return `<weft-c data-weft-c="${child.id}" data-weft-keep></weft-c>`;
      }
      return this.wrap(child, keep);
    });
  }

  private unchanged(rec: Rec): boolean {
    if (rec.template !== rec.sent) return false;
    for (const c of rec.children.values()) {
      if (!this.unchanged(c)) return false;
    }
    return true;
  }

  private wrap(rec: Rec, keep = false): string {
    const key = rec.key === undefined ? "" : ` data-weft-key="${escapeAttr(rec.key)}"`;
    const isl = rec.def.island;
    const island = isl ? ` data-weft-island="${escapeAttr(typeof isl === "string" ? isl : rec.def.name)}"` : "";
    return `<weft-c data-weft-c="${rec.id}"${key}${island}>${this.inner(rec, keep)}</weft-c>`;
  }

  private markSent(rec: Rec): void {
    rec.sent = rec.template;
    for (const c of rec.children.values()) {
      this.markSent(c);
    }
  }

  private collectPatches(rec: Rec, ack: number | undefined, out: ServerMessage[]): void {
    if (rec.template !== rec.sent) {
      out.push(
        ack === undefined
          ? { t: "patch", id: rec.id, html: this.inner(rec, true) }
          : { t: "patch", id: rec.id, html: this.inner(rec, true), ack },
      );
      this.markSent(rec);
      return;
    }
    for (const c of rec.children.values()) {
      this.collectPatches(c, ack, out);
    }
  }
}
