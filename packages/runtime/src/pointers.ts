import { isSafePath, type PointAt, type PointMessage, type Pointer, type PointSel, type PointView } from "./protocol.ts";

export const POINT_ATTR = "data-weft-point";
export const POINT_ON_ATTR = "data-weft-point-on";

const SEND_MS = 50;
const GONE_MS = 4000;

interface Choice {
  presenting: boolean;
  following: string | null;
  navTo: string | null;
}
const choices = new Map<string, Choice>();
const byElement = new WeakMap<object, PointerArea>();

let tabId: string | null = null;
const TAB_RE = /^[A-Za-z0-9_-]{8,64}$/;

function tabOf(storage: PointOptions["storage"]): string {
  if (tabId) return tabId;
  try {
    const got = storage?.getItem("weft-tab");
    if (got && TAB_RE.test(got)) return (tabId = got);
  } catch {
  }
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?(a: Uint8Array): Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  tabId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    storage?.setItem("weft-tab", tabId);
  } catch {
  }
  return tabId;
}

export function resetPointerChoices(): void {
  choices.clear();
  tabId = null;
}

export function pointerAreaOf(el: unknown): PointerArea | null {
  return (typeof el === "object" && el !== null && byElement.get(el)) || null;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PointElement {
  getAttribute(name: string): string | null;
  getBoundingClientRect(): Box;
  contains(other: unknown): boolean;
  querySelectorAll?(selector: string): ArrayLike<unknown>;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  removeEventListener(type: string, fn: (ev: unknown) => void): void;
  dispatchEvent?(ev: unknown): boolean;
}

interface Anchored {
  getAttribute(name: string): string | null;
  getBoundingClientRect(): Box;
  closest?(selector: string): Anchored | null;
  parentNode?: unknown;
}

interface Sel {
  rangeCount: number;
  isCollapsed: boolean;
  anchorNode: unknown;
  anchorOffset: number;
  focusNode: unknown;
  focusOffset: number;
}

interface PointDocument {
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  removeEventListener(type: string, fn: (ev: unknown) => void): void;
  getSelection?(): Sel | null;
  createRange?(): RangeLike;
}

interface RangeLike {
  setStart(node: unknown, offset: number): void;
  setEnd(node: unknown, offset: number): void;
  toString(): string;
}

interface PointWindow {
  scrollY: number;
  scrollTo(x: number, y: number): void;
  addEventListener(type: string, fn: (ev: unknown) => void, opts?: unknown): void;
  removeEventListener(type: string, fn: (ev: unknown) => void): void;
  location: { pathname: string; search: string };
}

export interface PointOptions {
  send(msg: PointMessage): void;
  window?: PointWindow;
  navigate?(path: string): void;
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  document?: PointDocument;
  event?(type: string, detail: unknown): unknown;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000;
const sameAt = (a: PointAt | null, b: PointAt | null) => a === b || (!!a && !!b && a.on === b.on && a.x === b.x && a.y === b.y);
const sameSel = (a: PointSel | null, b: PointSel | null) => a === b || (!!a && !!b && a.on === b.on && a.a === b.a && a.h === b.h);
const sameView = (a: PointView | null, b: PointView | null) => a === b || (!!a && !!b && a.path === b.path && a.on === b.on && a.y === b.y);
const ON_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export class PointerArea {
  readonly area: string;
  readonly el: PointElement;
  private readonly opts: PointOptions;
  private joined = false;
  private at: PointAt | null = null;
  private sel: PointSel | null = null;
  private sentAt: PointAt | null = null;
  private sentSel: PointSel | null = null;
  private view: PointView | null = null;
  private sentView: PointView | null = null;
  private readonly choice: Choice;
  private missingSince: number | null = null;
  private goneTimer: unknown = null;
  private timer: unknown = null;
  private readonly onScroll = () => {
    if (this.choice.presenting) this.present(true);
  };
  private readonly onMove = (ev: unknown) => this.move(ev as { clientX: number; clientY: number; target: unknown });
  private readonly onLeave = () => this.leave();
  private readonly onSelect = () => this.select();

  constructor(el: PointElement, opts: PointOptions) {
    this.el = el;
    this.opts = opts;
    this.area = el.getAttribute(POINT_ATTR) ?? "";
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerleave", this.onLeave);
    opts.document?.addEventListener("selectionchange", this.onSelect);
    opts.window?.addEventListener("scroll", this.onScroll, { passive: true });
    byElement.set(el, this);
    let choice = choices.get(this.area);
    if (!choice) {
      choice = { presenting: false, following: null, navTo: null };
      choices.set(this.area, choice);
    }
    this.choice = choice;
    if (choice.following && choice.navTo !== null && this.here() !== choice.navTo) {
      this.stopFollowing("left");
    }
    if (choice.presenting) this.view = this.where();
  }

  get presenting(): boolean {
    return this.choice.presenting;
  }

  get following(): string | null {
    return this.choice.following;
  }

  present(on: boolean): void {
    const was = this.choice.presenting;
    this.choice.presenting = on && !!this.opts.window;
    if (this.choice.presenting && this.choice.following) this.stopFollowing("stopped");
    this.view = this.choice.presenting ? this.where() : null;
    this.soon();
    if (was !== this.choice.presenting) this.emit("weft:present", { presenting: this.choice.presenting });
  }

  follow(id: string | null): void {
    if (id === null) return this.stopFollowing("stopped");
    if (!this.opts.window || !this.opts.navigate) return;
    if (this.choice.presenting) this.present(false);
    this.choice.following = id;
    this.choice.navTo = null;
    this.missingSince = null;
    this.emit("weft:follow", { following: id });
  }

  private stopFollowing(reason: "stopped" | "gone" | "left"): void {
    if (this.choice.following === null) return;
    this.choice.following = null;
    this.choice.navTo = null;
    this.missingSince = null;
    if (this.goneTimer !== null) (this.opts.clearTimeout ?? clearTimeout)(this.goneTimer as never);
    this.goneTimer = null;
    this.emit("weft:follow", { following: null, reason });
  }

  private here(): string {
    const loc = this.opts.window?.location;
    return loc ? loc.pathname + loc.search : "";
  }

  private where(): PointView | null {
    const path = this.here();
    if (!isSafePath(path) || path.length > 2048) return null;
    const all = this.el.querySelectorAll?.(`[${POINT_ON_ATTR}]`);
    if (all) {
      for (let i = 0; i < all.length; i++) {
        const a = all[i] as Anchored;
        const on = a.getAttribute(POINT_ON_ATTR) ?? "";
        const box = a.getBoundingClientRect();
        if (!ON_RE.test(on) || !(box.height > 0) || box.top + box.height <= 0) continue;
        return { path, on, y: round(-box.top / box.height) };
      }
    }
    const box = this.el.getBoundingClientRect();
    return { path, y: box.height > 0 ? round(-box.top / box.height) : 0 };
  }

  private go(view: PointView): void {
    const win = this.opts.window;
    if (!win) return;
    if (view.path !== this.here()) {
      if (this.choice.navTo === view.path || !isSafePath(view.path)) return;
      this.choice.navTo = view.path;
      this.opts.navigate?.(view.path);
      return;
    }
    this.choice.navTo = view.path;
    const anchor = view.on === undefined ? (this.el as unknown as Anchored) : anchorEl(this.el, view.on);
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    const target = Math.max(0, win.scrollY + box.top + view.y * box.height);
    if (Math.abs(target - win.scrollY) > 2) win.scrollTo(0, target);
  }

  private emit(type: string, detail: unknown): void {
    const ev = this.opts.event?.(type, detail);
    if (ev !== undefined && this.el.dispatchEvent) this.el.dispatchEvent(ev);
  }

  join(): void {
    this.joined = true;
    this.sentAt = this.sentSel = this.sentView = null;
    this.opts.send({ t: "point", area: this.area, join: true, tab: tabOf(this.opts.storage) });
    if (this.at || this.sel || this.view) this.soon();
    this.emit("weft:present", { presenting: this.choice.presenting });
  }

  stop(): void {
    this.el.removeEventListener("pointermove", this.onMove);
    this.el.removeEventListener("pointerleave", this.onLeave);
    this.opts.document?.removeEventListener("selectionchange", this.onSelect);
    this.opts.window?.removeEventListener("scroll", this.onScroll);
    if (this.timer !== null) (this.opts.clearTimeout ?? clearTimeout)(this.timer as never);
    if (this.goneTimer !== null) (this.opts.clearTimeout ?? clearTimeout)(this.goneTimer as never);
    this.timer = this.goneTimer = null;
    if (byElement.get(this.el) === this) byElement.delete(this.el);
  }

  receive(list: Pointer[]): void {
    this.emit("weft:pointers", { pointers: list });
    const id = this.choice.following;
    if (id === null) return;
    const leader = list.find((p) => p.id === id);
    if (leader && !leader.view) return this.stopFollowing("stopped");
    if (leader?.view) {
      this.missingSince = null;
      return this.go(leader.view);
    }
    const now = Date.now();
    this.missingSince ??= now;
    if (now - this.missingSince >= GONE_MS) return this.stopFollowing("gone");
    if (this.goneTimer === null) {
      this.goneTimer = (this.opts.setTimeout ?? setTimeout)(() => {
        this.goneTimer = null;
        if (this.choice.following === id && this.missingSince !== null) this.stopFollowing("gone");
      }, GONE_MS);
    }
  }

  private anchor(node: unknown): { on?: string; box: Box } {
    let n = node as Anchored | null;
    while (n && typeof n.closest !== "function") n = (n.parentNode as Anchored | null) ?? null;
    const found = n?.closest?.(`[${POINT_ON_ATTR}]`) ?? null;
    if (found && found !== (this.el as unknown) && this.el.contains(found)) {
      const on = found.getAttribute(POINT_ON_ATTR) ?? "";
      if (ON_RE.test(on)) return { on, box: found.getBoundingClientRect() };
    }
    return { box: this.el.getBoundingClientRect() };
  }

  private move(ev: { clientX: number; clientY: number; target: unknown }): void {
    const { on, box } = this.anchor(ev.target);
    if (!(box.width > 0) || !(box.height > 0)) return;
    const x = round((ev.clientX - box.left) / box.width);
    const y = round((ev.clientY - box.top) / box.height);
    this.at = on === undefined ? { x, y } : { on, x, y };
    this.soon();
  }

  private leave(): void {
    this.at = null;
    this.soon();
  }

  private select(): void {
    const doc = this.opts.document;
    const s = doc?.getSelection?.();
    let next: PointSel | null = null;
    if (s && s.rangeCount > 0 && !s.isCollapsed && this.el.contains(s.anchorNode) && this.el.contains(s.focusNode)) {
      const a = this.anchorNode(s.anchorNode);
      const f = this.anchorNode(s.focusNode);
      const root = a === f ? a : (this.el as unknown);
      const on = root === this.el ? undefined : (root as Anchored).getAttribute(POINT_ON_ATTR) ?? undefined;
      const ao = this.offset(root, s.anchorNode, s.anchorOffset);
      const fo = this.offset(root, s.focusNode, s.focusOffset);
      if (ao !== null && fo !== null) next = on === undefined ? { a: ao, h: fo } : { on, a: ao, h: fo };
    }
    if (sameSel(next, this.sel)) return;
    this.sel = next;
    this.soon();
  }

  private anchorNode(node: unknown): unknown {
    let n = node as Anchored | null;
    while (n && typeof n.closest !== "function") n = (n.parentNode as Anchored | null) ?? null;
    const found = n?.closest?.(`[${POINT_ON_ATTR}]`) ?? null;
    return found && found !== (this.el as unknown) && this.el.contains(found) && ON_RE.test(found.getAttribute(POINT_ON_ATTR) ?? "")
      ? found
      : this.el;
  }

  private offset(root: unknown, node: unknown, offset: number): number | null {
    const r = this.opts.document?.createRange?.();
    if (!r) return null;
    try {
      r.setStart(root, 0);
      r.setEnd(node, offset);
      return r.toString().length;
    } catch {
      return null;
    }
  }

  private soon(): void {
    if (!this.joined || this.timer !== null) return;
    this.timer = (this.opts.setTimeout ?? setTimeout)(() => {
      this.timer = null;
      this.flush();
    }, SEND_MS);
  }

  private flush(): void {
    const msg: PointMessage = { t: "point", area: this.area };
    if (!sameAt(this.at, this.sentAt)) msg.at = this.at;
    if (!sameSel(this.sel, this.sentSel)) msg.sel = this.sel;
    if (!sameView(this.view, this.sentView)) msg.view = this.view;
    if (msg.at === undefined && msg.sel === undefined && msg.view === undefined) return;
    this.sentAt = this.at;
    this.sentSel = this.sel;
    this.sentView = this.view;
    this.opts.send(msg);
  }
}

function anchorEl(area: PointElement, on: string | undefined): Anchored | null {
  if (on === undefined) return area as unknown as Anchored;
  const all = area.querySelectorAll?.(`[${POINT_ON_ATTR}]`);
  if (!all) return null;
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as Anchored;
    if (el.getAttribute(POINT_ON_ATTR) === on) return el;
  }
  return null;
}

export function pointerPlace(area: PointElement, p: Pointer): { x: number; y: number } | null {
  if (!p.at) return null;
  const el = anchorEl(area, p.at.on);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  const base = area.getBoundingClientRect();
  return { x: box.left - base.left + p.at.x * box.width, y: box.top - base.top + p.at.y * box.height };
}

interface TextNodeLike {
  nodeType: number;
  data?: string;
  childNodes?: ArrayLike<unknown>;
}

function findText(root: unknown, at: number): { node: unknown; offset: number } | null {
  let left = at;
  let last: { node: unknown; offset: number } | null = null;
  const walk = (n: TextNodeLike): { node: unknown; offset: number } | null => {
    if (n.nodeType === 3) {
      const len = (n.data ?? "").length;
      if (left <= len) return { node: n, offset: left };
      left -= len;
      last = { node: n, offset: len };
      return null;
    }
    const kids = n.childNodes;
    if (kids) for (let i = 0; i < kids.length; i++) {
      const got = walk(kids[i] as TextNodeLike);
      if (got) return got;
    }
    return null;
  };
  return walk(root as TextNodeLike) ?? last;
}

export function pointerRange(area: PointElement, p: Pointer, doc: PointDocument): RangeLike | null {
  if (!p.sel || !doc.createRange) return null;
  const root = anchorEl(area, p.sel.on);
  if (!root) return null;
  const from = findText(root, Math.min(p.sel.a, p.sel.h));
  const to = findText(root, Math.max(p.sel.a, p.sel.h));
  if (!from || !to) return null;
  const r = doc.createRange();
  try {
    r.setStart(from.node, from.offset);
    r.setEnd(to.node, to.offset);
  } catch {
    return null;
  }
  return r;
}
