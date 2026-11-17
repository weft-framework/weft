import { isEdit, type Edit } from "./ot.ts";

export const PROTOCOL_VERSION = 1;

export interface EventPayload {
  type: string;
  value?: string;
  checked?: boolean;
  key?: string;
  form?: Record<string, string>;
  queued?: true;
  stale?: true;
}

export interface EventMessage {
  t: "event";
  id: string;
  handler: string;
  args?: string;
  event: EventPayload;
  seq: number;
  base?: number;
  queued?: true;
}

export interface TextMessage {
  t: "text";
  doc: string;
  rev: number;
  join?: true;
  edit?: Edit;
  sel?: [number, number];
}

export interface SharedCursor {
  id: string;
  label?: string;
  a: number;
  h: number;
}

export interface PointAt {
  on?: string;
  x: number;
  y: number;
}

export interface PointSel {
  on?: string;
  a: number;
  h: number;
}

export interface PointView {
  path: string;
  on?: string;
  y: number;
}

export interface PointMessage {
  t: "point";
  area: string;
  join?: true;
  tab?: string;
  at?: PointAt | null;
  sel?: PointSel | null;
  view?: PointView | null;
}

export interface Pointer {
  id: string;
  label?: string;
  at?: PointAt;
  sel?: PointSel;
  view?: PointView;
}

export type ClientMessage = EventMessage | TextMessage | PointMessage;

export type ServerMessage =
  | { t: "hello"; session: string; p?: number }
  | { t: "patch"; id: string; html: string; ack?: number; v?: number }
  | { t: "conflict"; ack: number; reason: "stale" }
  | { t: "redirect"; to: string }
  | { t: "error"; message: string; ack?: number }
  | { t: "ack"; ack: number }
  | { t: "expired"; handoff?: string }
  | { t: "head"; meta: string; title: string; lang: string }
  | { t: "notice"; text: string; kind: string; data?: unknown }
  | {
      t: "text";
      doc: string;
      rev: number;
      text?: string;
      writable?: boolean;
      refused?: string;
      edit?: Edit;
      mine?: true;
      cursors?: SharedCursor[];
    }
  | { t: "point"; area: string; list: Pointer[] };

export const NOTICE_KIND = /^[a-z][a-z0-9_.-]{0,31}$/;

export const LIMITS = {
  message: 64 * 1024,
  name: 128,
  value: 16 * 1024,
  formFields: 256,
} as const;

const NAME_RE = /^[\p{ID_Start}_$][\p{ID_Continue}\p{Join_Control}$:.-]*$/u;

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isName(v: unknown): v is string {
  return typeof v === "string" && v.length <= LIMITS.name && NAME_RE.test(v);
}

function isToken(v: unknown): v is string {
  return typeof v === "string" && /^[0-9]{1,9}$/.test(v);
}

function isShort(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max;
}

function isSeq(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function parse(raw: string, max: number): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length > max) {
    return null;
  }
  try {
    const v: unknown = JSON.parse(raw);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function decodePayload(v: unknown): EventPayload | null {
  if (!isRecord(v) || !isShort(v.type, LIMITS.name) || v.type === "") {
    return null;
  }
  const out: EventPayload = { type: v.type };
  if (v.value !== undefined) {
    if (!isShort(v.value, LIMITS.value)) return null;
    out.value = v.value;
  }
  if (v.checked !== undefined) {
    if (typeof v.checked !== "boolean") return null;
    out.checked = v.checked;
  }
  if (v.key !== undefined) {
    if (!isShort(v.key, LIMITS.name)) return null;
    out.key = v.key;
  }
  if (v.form !== undefined) {
    if (!isRecord(v.form)) return null;
    const entries = Object.entries(v.form);
    if (entries.length > LIMITS.formFields) return null;
    const form: Record<string, string> = Object.create(null);
    for (const [name, value] of entries) {
      if (!isShort(name, LIMITS.name) || !isShort(value, LIMITS.value)) {
        return null;
      }
      form[name] = value;
    }
    out.form = form;
  }
  return out;
}

export function decodeClientMessage(raw: string): ClientMessage | null {
  const v = parse(raw, LIMITS.message);
  if (v?.t === "text") return decodeText(v);
  if (v?.t === "point") return decodePoint(v);
  if (!v || v.t !== "event") {
    return null;
  }
  if (!isName(v.id) || !isName(v.handler) || !isSeq(v.seq)) {
    return null;
  }
  if (v.args !== undefined && !isToken(v.args)) {
    return null;
  }
  if ((v.base !== undefined && !isSeq(v.base)) || (v.queued !== undefined && v.queued !== true)) {
    return null;
  }
  const event = decodePayload(v.event);
  if (!event) {
    return null;
  }
  const msg: EventMessage = { t: "event", id: v.id, handler: v.handler, event, seq: v.seq };
  if (v.args !== undefined) {
    msg.args = v.args;
  }
  if (v.base !== undefined) msg.base = v.base;
  if (v.queued === true) msg.queued = true;
  return msg;
}

const DOC_MAX = 512;
const POS_MAX = 10_000_000;

const isPos = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= POS_MAX;
const isDoc = (v: unknown): v is string => typeof v === "string" && v !== "" && v.length <= DOC_MAX;
const isSel = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && isPos(v[0]) && isPos(v[1]);

function decodeText(v: Record<string, unknown>): TextMessage | null {
  if (!isDoc(v.doc) || !isPos(v.rev)) return null;
  if (v.join !== undefined && v.join !== true) return null;
  if (v.edit !== undefined && !isEdit(v.edit, 64, LIMITS.value)) return null;
  if (v.sel !== undefined && !isSel(v.sel)) return null;
  const parts = [v.join, v.edit, v.sel].filter((x) => x !== undefined).length;
  if (parts !== 1) return null;
  const out: TextMessage = { t: "text", doc: v.doc, rev: v.rev };
  if (v.join === true) out.join = true;
  if (v.edit !== undefined) out.edit = (v.edit as Edit).map((s) => ("s" in s ? { i: s.i, s: s.s } : { d: s.d, n: s.n }));
  if (v.sel !== undefined) out.sel = [(v.sel as number[])[0]!, (v.sel as number[])[1]!];
  return out;
}

const ON_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const isFraction = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function decodeAt(v: unknown): PointAt | null | undefined {
  if (v === null) return null;
  if (!isRecord(v) || !isFraction(v.x) || !isFraction(v.y)) return undefined;
  if (v.on !== undefined && (typeof v.on !== "string" || !ON_RE.test(v.on))) return undefined;
  return v.on === undefined ? { x: v.x, y: v.y } : { on: v.on, x: v.x, y: v.y };
}

function decodeSel(v: unknown): PointSel | null | undefined {
  if (v === null) return null;
  if (!isRecord(v) || !isPos(v.a) || !isPos(v.h)) return undefined;
  if (v.on !== undefined && (typeof v.on !== "string" || !ON_RE.test(v.on))) return undefined;
  return v.on === undefined ? { a: v.a, h: v.h } : { on: v.on, a: v.a, h: v.h };
}

const TAB_RE = /^[A-Za-z0-9_-]{8,64}$/;

function decodeView(v: unknown): PointView | null | undefined {
  if (v === null) return null;
  if (!isRecord(v) || !isFraction(v.y) || typeof v.path !== "string" || v.path.length > 2048) return undefined;
  if (!isSafePath(v.path) || /[\u0000-\u001f\u007f\\]/.test(v.path)) return undefined;
  if (v.on !== undefined && (typeof v.on !== "string" || !ON_RE.test(v.on))) return undefined;
  return v.on === undefined ? { path: v.path, y: v.y } : { path: v.path, on: v.on, y: v.y };
}

function decodePoint(v: Record<string, unknown>): PointMessage | null {
  if (!isDoc(v.area)) return null;
  if (v.join !== undefined) {
    if (v.join !== true || v.at !== undefined || v.sel !== undefined || v.view !== undefined) return null;
    if (v.tab !== undefined && (typeof v.tab !== "string" || !TAB_RE.test(v.tab))) return null;
    return v.tab === undefined ? { t: "point", area: v.area, join: true } : { t: "point", area: v.area, join: true, tab: v.tab };
  }
  if (v.tab !== undefined) return null;
  if (v.at === undefined && v.sel === undefined && v.view === undefined) return null;
  const out: PointMessage = { t: "point", area: v.area };
  if (v.at !== undefined) {
    const at = decodeAt(v.at);
    if (at === undefined) return null;
    out.at = at;
  }
  if (v.sel !== undefined) {
    const sel = decodeSel(v.sel);
    if (sel === undefined) return null;
    out.sel = sel;
  }
  if (v.view !== undefined) {
    const view = decodeView(v.view);
    if (view === undefined) return null;
    out.view = view;
  }
  return out;
}

function decodePointers(v: unknown): Pointer[] | null {
  if (!Array.isArray(v) || v.length > 256) return null;
  const out: Pointer[] = [];
  for (const c of v) {
    if (!isRecord(c) || typeof c.id !== "string" || c.id.length > 64) return null;
    if (c.label !== undefined && (typeof c.label !== "string" || c.label.length > 200)) return null;
    const p: Pointer = { id: c.id };
    if (c.label !== undefined) p.label = c.label;
    if (c.at !== undefined) {
      const at = decodeAt(c.at);
      if (!at) return null;
      p.at = at;
    }
    if (c.sel !== undefined) {
      const sel = decodeSel(c.sel);
      if (!sel) return null;
      p.sel = sel;
    }
    if (c.view !== undefined) {
      const view = decodeView(c.view);
      if (!view) return null;
      p.view = view;
    }
    out.push(p);
  }
  return out;
}

function decodeCursors(v: unknown): SharedCursor[] | null {
  if (!Array.isArray(v) || v.length > 256) return null;
  const out: SharedCursor[] = [];
  for (const c of v) {
    if (!isRecord(c) || typeof c.id !== "string" || c.id.length > 64 || !isPos(c.a) || !isPos(c.h)) return null;
    if (c.label !== undefined && (typeof c.label !== "string" || c.label.length > 200)) return null;
    out.push(c.label === undefined ? { id: c.id, a: c.a, h: c.h } : { id: c.id, label: c.label, a: c.a, h: c.h });
  }
  return out;
}

export function isSafePath(to: string): boolean {
  if (typeof to !== "string" || to.length === 0) return false;
  if (!/^\/(?![/\\])/.test(to)) return false;
  if (/[\u0000-\u001f\u007f]/.test(to)) return false;
  if (/%2f|%5c/i.test(to)) return false;
  const path = to.replace(/[?#][\s\S]*$/, "");
  return !/(?:^|\/)\.\.(?:\/|$)/.test(path);
}

export const HANDOFF_MAX = 6144;

export function isHandoff(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= HANDOFF_MAX && /^[A-Za-z0-9_-]+$/.test(v);
}

export function decodeServerMessage(raw: string): ServerMessage | null {
  const v = parse(raw, Number.MAX_SAFE_INTEGER);
  if (!v) {
    return null;
  }
  const ack = v.ack === undefined ? undefined : isSeq(v.ack) ? v.ack : null;
  if (ack === null) {
    return null;
  }
  switch (v.t) {
    case "hello":
      if (typeof v.session !== "string" || v.session === "") return null;
      if (v.p !== undefined && !isSeq(v.p)) return null;
      return v.p === undefined ? { t: "hello", session: v.session } : { t: "hello", session: v.session, p: v.p as number };
    case "patch":
      if (!isName(v.id) || typeof v.html !== "string") return null;
      if (v.v !== undefined && !isSeq(v.v)) return null;
      {
        const out: Extract<ServerMessage, { t: "patch" }> = { t: "patch", id: v.id, html: v.html };
        if (ack !== undefined) out.ack = ack;
        if (v.v !== undefined) out.v = v.v as number;
        return out;
      }
    case "conflict":
      return ack !== undefined && v.reason === "stale" ? { t: "conflict", ack, reason: "stale" } : null;
    case "redirect":
      return typeof v.to === "string" && isSafePath(v.to)
        ? { t: "redirect", to: v.to }
        : null;
    case "ack":
      return ack === undefined ? null : { t: "ack", ack };
    case "expired":
      if (v.handoff === undefined) return { t: "expired" };
      return isHandoff(v.handoff) ? { t: "expired", handoff: v.handoff } : { t: "expired" };
    case "head":
      return typeof v.meta === "string" && typeof v.title === "string" && typeof v.lang === "string"
        ? { t: "head", meta: v.meta, title: v.title, lang: v.lang }
        : null;
    case "notice":
      if (typeof v.text !== "string" || v.text.length > 500 || typeof v.kind !== "string" || !NOTICE_KIND.test(v.kind)) {
        return null;
      }
      return v.data === undefined ? { t: "notice", text: v.text, kind: v.kind } : { t: "notice", text: v.text, kind: v.kind, data: v.data };
    case "text": {
      if (!isDoc(v.doc) || !isPos(v.rev)) return null;
      const out: Extract<ServerMessage, { t: "text" }> = { t: "text", doc: v.doc, rev: v.rev };
      if (v.text !== undefined) {
        if (typeof v.text !== "string" || typeof v.writable !== "boolean") return null;
        out.text = v.text;
        out.writable = v.writable;
        if (v.refused !== undefined) {
          if (typeof v.refused !== "string" || v.refused.length > 500) return null;
          out.refused = v.refused;
        }
      } else if (v.edit !== undefined) {
        if (!isEdit(v.edit, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) return null;
        out.edit = v.edit;
      } else if (v.mine === true) {
        out.mine = true;
      } else if (v.cursors !== undefined) {
        const cursors = decodeCursors(v.cursors);
        if (!cursors) return null;
        out.cursors = cursors;
      } else {
        return null;
      }
      return out;
    }
    case "point": {
      if (!isDoc(v.area)) return null;
      const list = decodePointers(v.list);
      return list ? { t: "point", area: v.area, list } : null;
    }
    case "error":
      if (typeof v.message !== "string") return null;
      return ack === undefined
        ? { t: "error", message: v.message }
        : { t: "error", message: v.message, ack };
    default:
      return null;
  }
}
