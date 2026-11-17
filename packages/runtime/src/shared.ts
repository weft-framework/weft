import { applyEdit, diffText, moveIndex, transform, type Edit } from "./ot.ts";
import type { ServerMessage, SharedCursor, TextMessage } from "./protocol.ts";

export const SHARED_ATTR = "data-weft-shared";
export const SHARED_REV_ATTR = "data-weft-shared-rev";

const CHUNK = 8 * 1024;
const CARET_MS = 120;

export interface SharedElement {
  value: string;
  readOnly: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection?: string | null;
  setSelectionRange?(start: number, end: number, direction?: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  removeEventListener(type: string, fn: (ev: unknown) => void): void;
  dispatchEvent?(ev: unknown): boolean;
}

export interface SharedOptions {
  send(msg: TextMessage): void;
  event?(type: string, detail: unknown): unknown;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

type Text = Extract<ServerMessage, { t: "text" }>;

export class SharedField {
  readonly doc: string;
  private rev: number;
  private server: string;
  private value: string;
  private sent: Edit | null = null;
  private joined = false;
  private writable = true;
  private others: { rev: number; list: SharedCursor[] } | null = null;
  private caretTimer: unknown = null;
  private caretDue = false;
  private readonly onInput = () => this.local();
  private readonly onCaret = () => this.caret();

  readonly el: SharedElement;
  private readonly opts: SharedOptions;

  constructor(el: SharedElement, opts: SharedOptions) {
    this.el = el;
    this.opts = opts;
    this.doc = el.getAttribute(SHARED_ATTR) ?? "";
    this.rev = Number(el.getAttribute(SHARED_REV_ATTR) ?? "0") || 0;
    this.server = el.value;
    this.value = el.value;
    el.addEventListener("input", this.onInput);
    for (const t of ["select", "keyup", "pointerup", "focus"]) el.addEventListener(t, this.onCaret);
  }

  join(): void {
    this.joined = false;
    this.sent = null;
    this.opts.send({ t: "text", doc: this.doc, rev: this.rev, join: true });
  }

  stop(): void {
    this.el.removeEventListener("input", this.onInput);
    for (const t of ["select", "keyup", "pointerup", "focus"]) this.el.removeEventListener(t, this.onCaret);
    if (this.caretTimer !== null) (this.opts.clearTimeout ?? clearTimeout)(this.caretTimer as never);
  }

  receive(msg: Text): void {
    if (msg.text !== undefined) return this.state(msg.text, msg.rev, msg.writable === true, msg.refused);
    if (!this.joined) return;
    if (msg.mine) return this.confirmed(msg.rev);
    if (msg.edit) return this.remote(msg.edit, msg.rev);
    if (msg.cursors) {
      this.others = { rev: msg.rev, list: msg.cursors };
      this.showCursors();
    }
  }

  offline(): void {
    this.joined = false;
    this.emit("weft:shared", { state: "offline", writable: this.writable });
  }

  private pendingBase(): string {
    return this.sent ? applyEdit(this.server, this.sent) : this.server;
  }

  private local(): void {
    const now = this.el.value;
    if (now === this.value) return;
    this.value = now;
    this.flush();
  }

  private flush(): void {
    if (!this.joined || this.sent || !this.writable) return;
    let edit = diffText(this.server, this.value);
    if (edit.length === 0) return;
    edit = edit.map((s) => ("s" in s && s.s.length > CHUNK ? { i: s.i, s: s.s.slice(0, CHUNK) } : s));
    this.sent = edit;
    this.opts.send({ t: "text", doc: this.doc, rev: this.rev, edit });
    this.emit("weft:shared", { state: "saving", writable: true });
  }

  private state(text: string, rev: number, writable: boolean, refused?: string): void {
    const mine = refused || !writable ? [] : diffText(this.server, this.value);
    this.server = text;
    this.rev = rev;
    this.sent = null;
    this.joined = true;
    this.writable = writable;
    this.el.readOnly = !writable;
    let next = text;
    for (const st of mine) {
      if ("s" in st) next = applyEdit(next, [{ i: Math.min(st.i, next.length), s: st.s }]);
      else {
        const d = Math.min(st.d, next.length);
        const n = Math.min(st.n, next.length - d);
        if (n > 0) next = applyEdit(next, [{ d, n }]);
      }
    }
    this.show(next, diffText(this.el.value, next));
    this.emit("weft:shared", refused ? { state: "refused", writable, reason: refused } : { state: "joined", writable });
    this.flush();
    this.caret();
  }

  private confirmed(rev: number): void {
    if (!this.sent || rev !== this.rev + 1) return this.join();
    this.server = applyEdit(this.server, this.sent);
    this.rev = rev;
    this.sent = null;
    this.flush();
    if (!this.sent) {
      this.emit("weft:shared", { state: "saved", writable: this.writable });
      if (this.caretDue) this.caret();
    }
  }

  private remote(edit: Edit, rev: number): void {
    if (rev !== this.rev + 1) return this.join();
    const typed = diffText(this.pendingBase(), this.value);
    let incoming = edit;
    if (this.sent) [this.sent, incoming] = transform(this.sent, incoming, false);
    const [, onScreen] = transform(typed, incoming, false);
    this.server = applyEdit(this.server, edit);
    this.rev = rev;
    this.show(applyEdit(this.value, onScreen), onScreen);
    this.showCursors();
  }

  private show(next: string, edit: Edit): void {
    const el = this.el;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    this.value = next;
    if (el.value === next) return;
    el.value = next;
    if (a !== null && b !== null && el.setSelectionRange) {
      el.setSelectionRange(moveIndex(a, edit, true), moveIndex(b, edit, true), el.selectionDirection ?? undefined);
    }
  }

  private caret(): void {
    if (!this.joined) return;
    if (this.sent || this.value !== this.server) {
      this.caretDue = true;
      return;
    }
    if (this.caretTimer !== null) {
      this.caretDue = true;
      return;
    }
    this.caretDue = false;
    const a = this.el.selectionStart ?? 0;
    const h = this.el.selectionEnd ?? a;
    const backward = this.el.selectionDirection === "backward";
    this.opts.send({ t: "text", doc: this.doc, rev: this.rev, sel: backward ? [h, a] : [a, h] });
    this.caretTimer = (this.opts.setTimeout ?? setTimeout)(() => {
      this.caretTimer = null;
      if (this.caretDue) this.caret();
    }, CARET_MS);
  }

  private showCursors(): void {
    const o = this.others;
    if (!o || o.rev !== this.rev) return;
    const typed = [...(this.sent ?? []), ...diffText(this.pendingBase(), this.value)];
    const at = (n: number) => Math.min(moveIndex(n, typed), this.value.length);
    this.emit("weft:cursors", {
      cursors: o.list.map((c) => (c.label === undefined ? { id: c.id, a: at(c.a), h: at(c.h) } : { id: c.id, label: c.label, a: at(c.a), h: at(c.h) })),
    });
  }

  private emit(type: string, detail: unknown): void {
    const ev = this.opts.event?.(type, detail);
    if (ev !== undefined && this.el.dispatchEvent) this.el.dispatchEvent(ev);
  }
}

interface SharedHook {
  render(row: unknown, field: string): { doc: string; rev: number; text: string } | null;
}

const HOOK = Symbol.for("weft.shared");
const hook = (): SharedHook | undefined => (globalThis as Record<symbol, SharedHook | undefined>)[HOOK];

const attrEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function sharedAttrs(row: unknown, field: string): string {
  const got = hook()?.render(row, field);
  return got ? ` ${SHARED_ATTR}="${attrEscape(got.doc)}" ${SHARED_REV_ATTR}="${got.rev}"` : "";
}

export function sharedValue(row: unknown, field: string): string {
  const got = hook()?.render(row, field);
  if (got) return got.text;
  const v = typeof row === "object" && row !== null ? (row as Record<string, unknown>)[field] : undefined;
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}
