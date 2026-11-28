import { isElement, TEXT_NODE, type MElement, type MEvent, type MEventTarget, type MNode, type MParent } from "./dom.ts";
import { runHooks } from "./component.ts";
import { isUrlAttr, safeUrl } from "./escape.ts";
import { browserFocus, captureFocus, restoreFocus, type FocusHost } from "./focus.ts";
import type { IslandInstance, IslandRegistry } from "./island.ts";
import { morphChildren, noteServed } from "./morph.ts";
import { PROTOCOL_VERSION, type ClientMessage, type EventPayload, type ServerMessage } from "./protocol.ts";
import { effect, untrack } from "./signal.ts";

const DO_PREFIX = "data-weft-do-";
const DOARGS_PREFIX = "data-weft-doargs-";
const OPT_PREFIX = "data-weft-opt-";
const ISLAND_ATTR = "data-weft-island";
const TEXT_BIND = "data-weft-t";
const ATTR_BIND = "data-weft-ca";
const USE_ATTR = "data-weft-use";
const ON_PREFIX = "data-weft-on-";
const ARGS_PREFIX = "data-weft-args-";
const MOD_PREFIX = "data-weft-mod-";
const CONFIRM_PREFIX = "data-weft-confirm-";
const INSTANCE_ATTR = "data-weft-c";
const OWNER_PREFIX = "data-weft-owner-";
const KEEP_ATTR = "data-weft-keep";
const BUSY_ATTR = "data-weft-busy";
const PENDING_ATTR = "data-weft-pending";

export const DEFAULT_EVENTS = [
  "click",
  "dblclick",
  "input",
  "change",
  "submit",
  "keydown",
  "keyup",
  "focusin",
  "focusout",
  "pointerdown",
  "pointerup",
] as const;

export const CLIENT_EVENTS = ["dragstart", "dragenter", "dragover", "dragleave", "drop", "dragend"] as const;

export interface Conflict {
  reason: "stale" | "expired";
  handler: string;
  type: string;
  form?: Record<string, string>;
  value?: string;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ClientOptions {
  root: MElement & MEventTarget;
  send(msg: ClientMessage): void;
  parse(html: string): MParent;
  setHead?(metaHtml: string, title: string, lang: string): void;
  onNotice?(notice: { text: string; kind: string; data?: unknown }): void;
  onConflict?(conflict: Conflict): void;
  onText?(msg: Extract<ServerMessage, { t: "text" }>): void;
  onPoint?(msg: Extract<ServerMessage, { t: "point" }>): void;
  onHello?(): void;
  onIncompatible?(): void;
  onPatched?(el: MElement): void;
  navigate?(to: string): void;
  onError?(message: string): void;
  events?: readonly string[];
  confirm?(message: string): boolean;
  observe?(el: MElement, onVisible: () => void): () => void;
  hidden?(): boolean;
  timers?: Timers;
  islands?: IslandRegistry;
  createText?(text: string): MNode;
  focus?: FocusHost;
  onExpired?(handoff?: string): void;
  resume?: IslandState[];
}

export interface IslandState {
  name: string;
  state: unknown[];
}

interface LiveIsland {
  el: MElement;
  inst: IslandInstance;
  stops: (() => void)[];
  cleanups: (() => unknown)[];
  attached: Map<MElement, Map<string, () => void>>;
}

function runCleanup(cleanup: unknown, report: (err: unknown) => void): void {
  if (typeof cleanup !== "function") return;
  try {
    (cleanup as () => unknown)();
  } catch (err) {
    report(err);
  }
}

function hasDirective(el: MElement, type: string): boolean {
  return el.hasAttribute(ON_PREFIX + type) || el.hasAttribute(DO_PREFIX + type);
}

interface FieldLike {
  value?: unknown;
  checked?: unknown;
  type?: unknown;
}

interface Mods {
  flags: Set<string>;
  keys: string[];
  debounce?: number;
  throttle?: number;
  every?: number;
}

const NO_MODS: Mods = { flags: new Set(), keys: [] };

function parseMods(raw: string | null): Mods {
  if (!raw) {
    return NO_MODS;
  }
  const out: Mods = { flags: new Set(), keys: [] };
  for (const tok of raw.split(" ")) {
    const eq = tok.indexOf("=");
    if (eq < 0) {
      if (tok) out.flags.add(tok);
      continue;
    }
    const name = tok.slice(0, eq);
    const value = tok.slice(eq + 1);
    const ms = Number(value);
    switch (name) {
      case "key":
        out.keys.push(value);
        break;
      case "debounce":
      case "throttle":
      case "every":
        if (Number.isFinite(ms) && ms > 0) out[name] = ms;
        break;
    }
  }
  return out;
}

const FORM_CONTROLS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "FIELDSET"]);

interface BusyMark {
  disabled: boolean;
}

interface Throttle {
  trailing: MEvent | null;
}

export class WeftClient {
  private readonly opts: ClientOptions;
  private readonly timers: Timers;
  private readonly listener: (ev: MEvent) => void;
  private seq = 0;
  private version = 0;
  private readonly asked = new Map<number, Omit<Conflict, "reason">>();
  private readonly pending = new Map<number, string>();
  private readonly busy = new Map<MElement, BusyMark>();
  private readonly pendingRoots = new Set<MElement>();
  private readonly onceDone = new WeakMap<MElement, Set<string>>();
  private readonly debounces = new WeakMap<MElement, Map<string, unknown>>();
  private readonly throttles = new WeakMap<MElement, Map<string, Throttle>>();
  private readonly timeouts = new Set<unknown>();
  private readonly loaded = new WeakSet<MElement>();
  private readonly observed = new Map<MElement, () => void>();
  private readonly polls = new Map<MElement, { handle: unknown; ms: number }>();
  private readonly islands = new Map<string, LiveIsland>();
  private readonly optimistic = new Map<number, { island: LiveIsland; snapshot: unknown[] }>();

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? (globalThis as unknown as Timers);
    this.listener = (ev) => this.handle(ev);
  }

  private listened(): string[] {
    return [...new Set<string>([...(this.opts.events ?? DEFAULT_EVENTS), ...CLIENT_EVENTS])];
  }

  start(): void {
    for (const type of this.listened()) {
      this.opts.root.addEventListener(type, this.listener);
    }
    applyCssVars(this.opts.root);
    this.mountIslands(this.opts.root);
    if (this.opts.resume?.length) {
      this.restoreIslands(this.opts.resume);
    }
    this.scanTriggers();
  }

  islandStates(): IslandState[] {
    const out: IslandState[] = [];
    walk(this.opts.root, (el) => {
      const id = el.getAttribute(INSTANCE_ATTR);
      const island = id ? this.islands.get(id) : undefined;
      const name = el.getAttribute(ISLAND_ATTR);
      if (island && name) {
        out.push({ name, state: island.inst.snapshot() });
      }
    });
    return out;
  }

  private restoreIslands(saved: IslandState[]): void {
    const byName = new Map<string, unknown[][]>();
    for (const s of saved) {
      const list = byName.get(s.name) ?? [];
      list.push(s.state);
      byName.set(s.name, list);
    }
    walk(this.opts.root, (el) => {
      const id = el.getAttribute(INSTANCE_ATTR);
      const island = id ? this.islands.get(id) : undefined;
      const name = el.getAttribute(ISLAND_ATTR);
      const state = name ? byName.get(name)?.shift() : undefined;
      if (island && state) {
        try {
          island.inst.restore(state);
        } catch (err) {
          this.opts.onError?.(`could not restore ${name}: ${String(err)}`);
        }
      }
    });
  }

  stop(): void {
    for (const type of this.listened()) {
      this.opts.root.removeEventListener(type, this.listener);
    }
    for (const h of this.timeouts) {
      this.timers.clearTimeout(h);
    }
    this.timeouts.clear();
    for (const { handle } of this.polls.values()) {
      this.timers.clearInterval(handle);
    }
    this.polls.clear();
    for (const unobserve of this.observed.values()) {
      unobserve();
    }
    this.observed.clear();
    for (const island of this.islands.values()) {
      this.unmount(island);
    }
    this.islands.clear();
  }

  handle(ev: MEvent): ClientMessage | null {
    const type = ev.type;
    let first: ClientMessage | null = null;
    let el = this.closest(ev.target, (e) => hasDirective(e, type));
    while (el) {
      if (!this.closest(el, (e) => e.hasAttribute(INSTANCE_ATTR))) {
        break;
      }
      const mods = parseMods(el.getAttribute(MOD_PREFIX + ev.type));
      if (this.accepts(el, ev, mods)) {
        if (wantsPrevent(el, ev, mods)) {
          ev.preventDefault?.();
        }
        const sent = this.fire(el, ev.type, ev, mods);
        first ??= sent;
        if (mods.flags.has("stop")) {
          ev.stopPropagation?.();
          break;
        }
      }
      if (el === this.opts.root) {
        break;
      }
      el = this.closest(el.parentNode, (e) => hasDirective(e, type));
    }
    return first;
  }

  apply(msg: ServerMessage): void {
    switch (msg.t) {
      case "patch": {
        if (msg.v !== undefined) this.version = msg.v;
        const found = this.findInstance(msg.id);
        const next = found ? this.opts.parse(msg.html) : null;
        const focus = this.opts.focus;
        const mark = found && next && focus ? captureFocus(focus, found) : null;
        const target = found && next && keepExisting(found, next) ? found : null;
        if (found && !target) {
          this.opts.onExpired?.();
        }
        if (target && next) {
          morphChildren(target, next);
          if (focus && mark) {
            restoreFocus(focus, target, mark);
          }
          for (const el of [...this.busy.keys()]) {
            if (el !== target && within(el, target)) this.busy.delete(el);
          }
        }
        this.answered(msg.ack);
        this.refreshBusy();
        if (target) {
          applyCssVars(target);
          this.mountIslands(target);
          for (const island of this.islands.values()) {
            if (island.el !== target && within(target, island.el)) this.attachUses(island);
          }
        }
        this.scanTriggers();
        if (target) this.opts.onPatched?.(target);
        break;
      }
      case "redirect":
        this.pending.clear();
        this.optimistic.clear();
        this.refreshBusy();
        this.opts.navigate?.(msg.to);
        break;
      case "error":
        if (msg.ack !== undefined) {
          const undo = this.optimistic.get(msg.ack);
          undo?.island.inst.restore(undo.snapshot);
        }
        this.answered(msg.ack);
        this.opts.onError?.(msg.message);
        break;
      case "ack":
        this.answered(msg.ack);
        break;
      case "conflict": {
        const info = this.asked.get(msg.ack);
        const undo = this.optimistic.get(msg.ack);
        undo?.island.inst.restore(undo.snapshot);
        this.answered(msg.ack);
        if (info) this.opts.onConflict?.({ ...info, reason: msg.reason });
        break;
      }
      case "hello":
        if (msg.p !== undefined && msg.p !== PROTOCOL_VERSION) {
          this.opts.onIncompatible?.();
          break;
        }
        this.pending.clear();
        this.optimistic.clear();
        this.refreshBusy();
        this.opts.onHello?.();
        break;
      case "expired":
        for (const info of this.asked.values()) this.opts.onConflict?.({ ...info, reason: "expired" });
        this.asked.clear();
        this.pending.clear();
        this.optimistic.clear();
        this.refreshBusy();
        this.opts.onExpired?.(msg.handoff);
        break;
      case "head":
        this.opts.setHead?.(msg.meta, msg.title, msg.lang);
        break;
      case "text":
        this.opts.onText?.(msg);
        break;
      case "point":
        this.opts.onPoint?.(msg);
        break;
      case "notice":
        this.opts.onNotice?.(
          msg.data === undefined ? { text: msg.text, kind: msg.kind } : { text: msg.text, kind: msg.kind, data: msg.data },
        );
        break;
    }
  }

  scanTriggers(): void {
    const root = this.opts.root;
    for (const [el, poll] of this.polls) {
      const ms = el.hasAttribute(ON_PREFIX + "every")
        ? parseMods(el.getAttribute(MOD_PREFIX + "every")).every
        : undefined;
      if (!within(el, root) || ms !== poll.ms) {
        this.timers.clearInterval(poll.handle);
        this.polls.delete(el);
      }
    }
    for (const [el, unobserve] of this.observed) {
      if (!within(el, root) || !el.hasAttribute(ON_PREFIX + "visible")) {
        unobserve();
        this.observed.delete(el);
      }
    }
    const observe = this.opts.observe;
    walk(root, (el) => {
      if (el.hasAttribute(ON_PREFIX + "load") && !this.loaded.has(el)) {
        this.loaded.add(el);
        this.trigger(el, "load");
      }
      if (observe && el.hasAttribute(ON_PREFIX + "visible") && !this.observed.has(el)) {
        this.observed.set(el, observe(el, () => this.trigger(el, "visible")));
      }
      if (el.hasAttribute(ON_PREFIX + "every") && !this.polls.has(el)) {
        const ms = parseMods(el.getAttribute(MOD_PREFIX + "every")).every;
        if (ms !== undefined) {
          const handle = this.timers.setInterval(() => {
            if (!this.opts.hidden?.()) this.trigger(el, "every");
          }, ms);
          this.polls.set(el, { handle, ms });
        }
      }
    });
  }

  private trigger(el: MElement, type: string): void {
    if (!within(el, this.opts.root) || !el.hasAttribute(ON_PREFIX + type)) {
      return;
    }
    const mods = parseMods(el.getAttribute(MOD_PREFIX + type));
    const ev: MEvent = { type, target: el };
    if (this.accepts(el, ev, mods)) {
      this.fire(el, type, ev, mods);
    }
  }

  private accepts(el: MElement, ev: MEvent, mods: Mods): boolean {
    if (this.onceDone.get(el)?.has(ev.type)) {
      return false;
    }
    if (mods.flags.has("self") && ev.target !== el) {
      return false;
    }
    if (mods.keys.length > 0 && !mods.keys.some((k) => keyMatches(k, ev.key))) {
      return false;
    }
    for (const sys of ["ctrl", "shift", "alt", "meta"] as const) {
      if (mods.flags.has(sys) && ev[`${sys}Key`] !== true) {
        return false;
      }
    }
    return true;
  }

  private fire(el: MElement, type: string, ev: MEvent, mods: Mods): ClientMessage | null {
    if (mods.flags.has("once")) {
      slot(this.onceDone, el, () => new Set<string>()).add(type);
    }
    if (mods.debounce !== undefined) {
      const timers = slot(this.debounces, el, () => new Map<string, unknown>());
      const prev = timers.get(type);
      if (prev !== undefined) {
        this.cancel(prev);
      }
      timers.set(
        type,
        this.after(mods.debounce, () => {
          timers.delete(type);
          this.send(el, type, ev);
        }),
      );
      return null;
    }
    if (mods.throttle !== undefined) {
      const states = slot(this.throttles, el, () => new Map<string, Throttle>());
      const open = states.get(type);
      if (open) {
        open.trailing = ev;
        return null;
      }
      const st: Throttle = { trailing: null };
      states.set(type, st);
      const ms = mods.throttle;
      const arm = (): void => {
        this.after(ms, () => {
          if (st.trailing) {
            const next = st.trailing;
            st.trailing = null;
            this.send(el, type, next);
            arm();
          } else {
            states.delete(type);
          }
        });
      };
      arm();
    }
    return this.send(el, type, ev);
  }

  private send(el: MElement, type: string, ev: MEvent): ClientMessage | null {
    if (!within(el, this.opts.root)) {
      return null;
    }
    const handler = el.getAttribute(ON_PREFIX + type);
    const local = el.getAttribute(DO_PREFIX + type);
    const id = this.ownerOf(el, type);
    if ((!handler && !local) || !id) {
      return null;
    }
    const message = el.getAttribute(CONFIRM_PREFIX + type);
    if (message !== null && !(this.opts.confirm?.(message) ?? false)) {
      return null;
    }
    if (!handler) {
      this.callClient(el, type, local as string, parseArgs(el.getAttribute(DOARGS_PREFIX + type)), ev);
      return null;
    }
    const opt = el.getAttribute(OPT_PREFIX + type);
    let undo: { island: LiveIsland; snapshot: unknown[] } | undefined;
    if (opt) {
      const island = this.islandOf(el, type);
      if (island) {
        undo = { island, snapshot: island.inst.snapshot() };
      }
      this.callClient(el, type, opt, [], ev);
    }
    this.seq += 1;
    if (undo) {
      this.optimistic.set(this.seq, undo);
    }
    const msg: ClientMessage = {
      t: "event",
      id,
      handler,
      event: payloadOf(ev, el),
      seq: this.seq,
    };
    const args = el.getAttribute(ARGS_PREFIX + type);
    if (args) {
      msg.args = args;
    }
    if (this.version > 0) msg.base = this.version;
    this.pending.set(this.seq, id);
    const { form, value } = msg.event;
    this.asked.set(this.seq, { handler, type, ...(form ? { form } : {}), ...(value !== undefined ? { value } : {}) });
    if (this.asked.size > 100) this.asked.delete(this.asked.keys().next().value!);
    this.refreshBusy();
    this.opts.send(msg);
    return msg;
  }

  private answered(ack: number | undefined): void {
    if (ack === undefined) {
      return;
    }
    this.optimistic.delete(ack);
    this.asked.delete(ack);
    if (this.pending.delete(ack)) {
      this.refreshBusy();
    }
  }

  private mountIslands(scope: MElement): void {
    for (const [id, island] of this.islands) {
      if (!within(island.el, this.opts.root)) {
        this.unmount(island);
        this.islands.delete(id);
      }
    }
    const registry = this.opts.islands;
    if (!registry) {
      return;
    }
    const fresh: LiveIsland[] = [];
    walk(scope, (el) => {
      const name = el.getAttribute(ISLAND_ATTR);
      const id = el.getAttribute(INSTANCE_ATTR);
      if (!name || !id) {
        return;
      }
      let island = this.islands.get(id);
      if (!island) {
        const def = Object.hasOwn(registry, name) ? registry[name] : undefined;
        if (!def) {
          this.opts.onError?.(`no island module for ${name}`);
          return;
        }
        island = { el, inst: def.setup(), stops: [], cleanups: [], attached: new Map() };
        this.islands.set(id, island);
        fresh.push(island);
      }
      island.el = el;
      this.bindIsland(island);
    });
    const report = (err: unknown) => this.opts.onError?.(`client hook failed: ${String(err)}`);
    for (let i = fresh.length - 1; i >= 0; i -= 1) {
      fresh[i].cleanups = runHooks(fresh[i].inst.mount, report);
    }
  }

  private unmount(island: LiveIsland): void {
    for (const stop of island.stops) stop();
    island.stops = [];
    for (const byEntry of island.attached.values()) {
      for (const detach of byEntry.values()) detach();
    }
    island.attached.clear();
    const report = (err: unknown) => this.opts.onError?.(`client hook failed: ${String(err)}`);
    runHooks(island.cleanups, report);
    island.cleanups = [];
    runHooks(island.inst.destroy, report);
  }

  private bindIsland(island: LiveIsland): void {
    for (const stop of island.stops) stop();
    island.stops = [];
    const binds = island.inst.binds;
    const at = (raw: string): (() => unknown) | undefined => {
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 && n < binds.length ? binds[n] : undefined;
    };
    walkOwn(island.el, (el) => {
      const t = el.getAttribute(TEXT_BIND);
      const textBind = t === null ? undefined : at(t);
      if (textBind) {
        island.stops.push(effect(() => this.setText(el, textBind())));
      }
      for (const tok of (el.getAttribute(ATTR_BIND) ?? "").split(" ")) {
        const eq = tok.indexOf("=");
        if (eq <= 0) continue;
        const bool = tok[eq - 1] === "?";
        const name = tok.slice(0, bool ? eq - 1 : eq);
        const bind = at(tok.slice(eq + 1));
        if (bind) {
          island.stops.push(effect(() => setAttr(el, name, bool, bind())));
        }
      }
    });
    this.attachUses(island);
  }

  private attachUses(island: LiveIsland): void {
    const uses = island.inst.uses ?? [];
    const key = island.el.getAttribute(ISLAND_ATTR);
    const seen = new Map<MElement, Set<string>>();
    walkIsland(island.el, key, (el) => {
      const raw = el.getAttribute(USE_ATTR);
      if (raw === null || uses.length === 0) return;
      let list: unknown;
      try {
        list = JSON.parse(raw);
      } catch {
        this.opts.onError?.("malformed attachment marker");
        return;
      }
      if (!Array.isArray(list) || list[0] !== key) return;
      const keep = new Set<string>();
      seen.set(el, keep);
      let byEntry = island.attached.get(el);
      for (const entry of list.slice(1)) {
        const n: unknown = Array.isArray(entry) ? entry[0] : undefined;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n >= uses.length) continue;
        const key = JSON.stringify(entry);
        keep.add(key);
        if (byEntry?.has(key)) continue;
        noteServed(el);
        const [fn, get] = uses[n];
        const value = (entry as unknown[]).length > 1 ? (entry as unknown[])[1] : undefined;
        byEntry ??= new Map();
        island.attached.set(el, byEntry);
        byEntry.set(key, this.attach(el, fn as (el: MElement, v: unknown) => unknown, get ?? (() => value)));
      }
    });
    for (const [el, byEntry] of island.attached) {
      const keep = seen.get(el);
      for (const [key, detach] of byEntry) {
        if (!keep?.has(key)) {
          detach();
          byEntry.delete(key);
        }
      }
      if (byEntry.size === 0) island.attached.delete(el);
    }
  }

  private attach(el: MElement, fn: (el: MElement, v: unknown) => unknown, get: () => unknown): () => void {
    const name = fn.name || "attachment";
    const report = (err: unknown) => this.opts.onError?.(`use:${name} failed: ${String(err)}`);
    let cleanup: unknown;
    const stop = effect(() => {
      const value = get();
      untrack(() => {
        runCleanup(cleanup, report);
        cleanup = undefined;
        try {
          cleanup = fn(el, value);
        } catch (err) {
          report(err);
        }
      });
    });
    return () => {
      stop();
      runCleanup(cleanup, report);
      cleanup = undefined;
    };
  }

  private setText(el: MElement, value: unknown): void {
    const text = value === null || value === undefined ? "" : String(value);
    const kids = Array.from(el.childNodes);
    if (kids.length === 1 && kids[0].nodeType === TEXT_NODE) {
      kids[0].nodeValue = text;
      return;
    }
    for (const k of kids) el.removeChild(k);
    if (text !== "" && this.opts.createText) {
      el.insertBefore(this.opts.createText(text), null);
    }
  }

  private ownerOf(el: MElement, type: string): string | null {
    return (
      el.getAttribute(OWNER_PREFIX + type) ||
      (this.closest(el, (e) => e.hasAttribute(INSTANCE_ATTR))?.getAttribute(INSTANCE_ATTR) ?? null)
    );
  }

  private islandOf(el: MElement, type: string): LiveIsland | undefined {
    const id = this.ownerOf(el, type);
    return id ? this.islands.get(id) : undefined;
  }

  private callClient(el: MElement, type: string, name: string, args: unknown[], ev: MEvent): boolean {
    const island = this.islandOf(el, type);
    const fns = island?.inst.fns;
    if (!fns || !Object.hasOwn(fns, name)) {
      this.opts.onError?.(`no client function ${name}`);
      return false;
    }
    try {
      (fns[name] as (...a: unknown[]) => unknown)(...args, payloadOf(ev, el));
    } catch (err) {
      this.opts.onError?.(`client function ${name} failed: ${String(err)}`);
    }
    return true;
  }

  private refreshBusy(): void {
    const roots = new Set<MElement>();
    for (const id of new Set(this.pending.values())) {
      const inst = this.findInstance(id);
      if (inst) roots.add(inst);
    }
    for (const [el, mark] of [...this.busy]) {
      if (![...roots].some((r) => within(el, r))) {
        el.removeAttribute("aria-busy");
        if (mark.disabled) el.removeAttribute("disabled");
        this.busy.delete(el);
      }
    }
    for (const r of [...this.pendingRoots]) {
      if (!roots.has(r)) {
        r.removeAttribute(PENDING_ATTR);
        this.pendingRoots.delete(r);
      }
    }
    for (const r of roots) {
      if (!this.pendingRoots.has(r)) {
        r.setAttribute(PENDING_ATTR, "");
        this.pendingRoots.add(r);
      }
      walk(r, (el) => {
        if (!el.hasAttribute(BUSY_ATTR) || this.busy.has(el)) {
          return;
        }
        const disable = FORM_CONTROLS.has(el.nodeName) && !el.hasAttribute("disabled");
        el.setAttribute("aria-busy", "true");
        if (disable) el.setAttribute("disabled", "");
        this.busy.set(el, { disabled: disable });
      });
    }
  }

  private after(ms: number, fn: () => void): unknown {
    const h = this.timers.setTimeout(() => {
      this.timeouts.delete(h);
      fn();
    }, ms);
    this.timeouts.add(h);
    return h;
  }

  private cancel(h: unknown): void {
    this.timeouts.delete(h);
    this.timers.clearTimeout(h);
  }

  private closest(start: unknown, pred: (el: MElement) => boolean): MElement | null {
    let node = start as { parentNode: unknown } | null;
    while (node) {
      if (isElement(node) && pred(node)) {
        return node;
      }
      if (node === this.opts.root) {
        return null;
      }
      node = node.parentNode as { parentNode: unknown } | null;
    }
    return null;
  }

  private findInstance(id: string): MElement | null {
    let found: MElement | null = null;
    walk(this.opts.root, (el) => {
      if (!found && el.getAttribute(INSTANCE_ATTR) === id) found = el;
    });
    return found;
  }
}

function keepExisting(target: MElement, next: MParent): boolean {
  const marks: MElement[] = [];
  for (const node of Array.from(next.childNodes)) {
    walk(node as MElement, (el) => {
      if (el.hasAttribute(KEEP_ATTR)) marks.push(el);
    });
  }
  for (const mark of marks) {
    const id = mark.getAttribute(INSTANCE_ATTR);
    let have: MElement | null = null;
    walk(target, (el) => {
      if (!have && el !== target && el.getAttribute(INSTANCE_ATTR) === id) have = el;
    });
    const parent = mark.parentNode as MParent | null;
    if (!have || !parent) return false;
    parent.insertBefore(have, mark);
    parent.removeChild(mark);
  }
  return true;
}

function within(el: MElement, ancestor: MElement): boolean {
  let node: { parentNode: unknown } | null = el;
  while (node) {
    if (node === ancestor) return true;
    node = node.parentNode as { parentNode: unknown } | null;
  }
  return false;
}

function walk(from: MElement, visit: (el: MElement) => void): void {
  const stack: unknown[] = [from];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isElement(node)) {
      continue;
    }
    visit(node);
    const kids = Array.from(node.childNodes);
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      stack.push(kids[i]);
    }
  }
}

function walkOwn(from: MElement, visit: (el: MElement) => void): void {
  const stack: unknown[] = [from];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isElement(node) || (node !== from && node.hasAttribute(INSTANCE_ATTR))) {
      continue;
    }
    visit(node);
    const kids = Array.from(node.childNodes);
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      stack.push(kids[i]);
    }
  }
}

function walkIsland(from: MElement, key: string | null, visit: (el: MElement) => void): void {
  const stack: unknown[] = [from];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isElement(node) || (node !== from && node.getAttribute(ISLAND_ATTR) === key)) {
      continue;
    }
    visit(node);
    const kids = Array.from(node.childNodes);
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      stack.push(kids[i]);
    }
  }
}

function setAttr(el: MElement, name: string, bool: boolean, value: unknown): void {
  const sc = name === "class" ? el.getAttribute("data-weft-sc") : null;
  if (bool ? !value : value === null || value === undefined || value === false) {
    if (sc) el.setAttribute(name, sc);
    else el.removeAttribute(name);
  } else {
    const s = bool ? "" : isUrlAttr(name) ? safeUrl(value, name) : String(value);
    el.setAttribute(name, sc ? `${s} ${sc}` : s);
  }
}

export function applyCssVars(root: MElement): void {
  walk(root, (el) => {
    const raw = el.getAttribute("data-weft-vars");
    const style = (el as unknown as { style?: { setProperty(k: string, v: string): void } }).style;
    if (!raw || !style) return;
    let vars: unknown;
    try {
      vars = JSON.parse(raw);
    } catch {
      return;
    }
    if (!vars || typeof vars !== "object") return;
    for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
      if (k.startsWith("--") && typeof v === "string") style.setProperty(k, v);
    }
  });
}

function parseArgs(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function slot<V>(map: WeakMap<MElement, V>, el: MElement, make: () => V): V {
  let v = map.get(el);
  if (v === undefined) {
    v = make();
    map.set(el, v);
  }
  return v;
}

function keyMatches(want: string, key: string | undefined): boolean {
  if (key === undefined) return false;
  if (want === "Space") return key === " ";
  if (want.length === 1) return key.toLowerCase() === want;
  return key === want;
}

function wantsPrevent(el: MElement, ev: MEvent, mods: Mods): boolean {
  if (mods.flags.has("prevent")) return true;
  if (mods.flags.has("passive")) return false;
  if (ev.type === "submit") return true;
  if (ev.type === "click") {
    const t = (el as unknown as FieldLike).type;
    return !(el.nodeName === "INPUT" && (t === "checkbox" || t === "radio"));
  }
  return false;
}

function payloadOf(ev: MEvent, source: MElement): EventPayload {
  const out: EventPayload = { type: ev.type };
  const field = source as unknown as FieldLike;
  if (typeof field.value === "string") {
    out.value = field.value;
  }
  if (typeof field.checked === "boolean" && (field.type === "checkbox" || field.type === "radio")) {
    out.checked = field.checked;
  }
  if (typeof ev.key === "string") {
    out.key = ev.key;
  }
  if (ev.type === "submit") {
    out.form = collectForm(source);
  }
  return out;
}

function collectForm(form: MElement): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  const stack: unknown[] = Array.from(form.childNodes).reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isElement(node)) {
      continue;
    }
    const name = node.getAttribute("name");
    const field = node as unknown as FieldLike;
    if (name && typeof field.value === "string" && !node.hasAttribute("disabled")) {
      const isToggle = field.type === "checkbox" || field.type === "radio";
      if (!isToggle || field.checked === true) {
        out[name] = field.value;
      }
    }
    const kids = Array.from(node.childNodes);
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      stack.push(kids[i]);
    }
  }
  return out;
}

interface BrowserGlobals {
  document?: {
    createElement(tag: string): unknown;
    createTextNode(text: string): unknown;
    visibilityState?: string;
    activeElement?: unknown;
  };
  location?: { assign(url: string): void };
  confirm?(message: string): boolean;
  IntersectionObserver?: new (
    cb: (entries: { isIntersecting: boolean }[]) => void,
  ) => { observe(el: unknown): void; disconnect(): void };
}

export function browserClient(
  root: MElement & MEventTarget,
  send: (msg: ClientMessage) => void,
  extra: Pick<ClientOptions, "onError" | "events" | "islands" | "navigate" | "onExpired" | "resume" | "setHead" | "onNotice" | "onText" | "onPoint" | "onHello" | "onPatched" | "onConflict" | "onIncompatible"> = {},
): WeftClient {
  const g = globalThis as BrowserGlobals;
  const doc = g.document;
  const IO = g.IntersectionObserver;
  const confirm = g.confirm;
  return new WeftClient({
    ...extra,
    root,
    send,
    parse(html) {
      if (!doc) {
        throw new Error("browserClient requires a DOM");
      }
      const t = doc.createElement("template") as { innerHTML: string; content: MParent };
      t.innerHTML = html;
      return t.content;
    },
    navigate(to) {
      if (extra.navigate) {
        extra.navigate(to);
      } else {
        g.location?.assign(to);
      }
    },
    confirm: confirm ? (m) => confirm.call(globalThis, m) : undefined,
    observe: IO
      ? (el, onVisible) => {
          const io = new IO((entries) => {
            if (entries.some((e) => e.isIntersecting)) onVisible();
          });
          io.observe(el);
          return () => io.disconnect();
        }
      : undefined,
    hidden: () => doc?.visibilityState === "hidden",
    createText: doc ? (s) => doc.createTextNode(s) as MNode : undefined,
    focus: browserFocus(),
  });
}
