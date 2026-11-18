import { rowSource, type Change, type Model } from "@weft-framework/data";
import { applyEdit, diffText, moveIndex, transform, type Edit, type ServerMessage, type SharedCursor, type TextMessage } from "@weft-framework/runtime";

export interface SharedFieldOptions {
  label?: (actor: unknown) => string | null | undefined;
  saveMs?: number;
  maxLength?: number;
}

type Send = (msg: ServerMessage) => void;
type Text = Extract<ServerMessage, { t: "text" }>;

interface Member {
  id: string;
  label?: string;
  sel: [number, number] | null;
  send: Send;
  actor: unknown;
}

interface Doc {
  id: string;
  model: Model<any, any>;
  key: unknown;
  field: string;
  text: string;
  rev: number;
  saved: string;
  log: { rev: number; edit: Edit }[];
  members: Map<object, Member>;
  saveAs: unknown;
  saveTimer: ReturnType<typeof setTimeout> | null;
  cursorTimer: ReturnType<typeof setTimeout> | null;
  saveMs: number;
  maxLength: number;
  onError: (err: unknown) => void;
}

const LOG = 200;
const CURSOR_MS = 50;
const KNOWN = 10_000;

const known = new Map<string, { model: Model<any, any>; key: unknown; field: string }>();
const docs = new Map<string, Doc>();

const docName = (model: string, field: string, key: unknown) =>
  "s." + Buffer.from(JSON.stringify([model, field, key]), "utf8").toString("base64url");

const sameKey = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function isTextField(model: Model<any, any>, field: string): boolean {
  const kind = (model.config.fields as Record<string, string>)[field];
  return typeof kind === "string" && /^string(\s*\|\s*null)?$/.test(kind.trim()) && field !== model.key;
}

function render(row: unknown, field: string): { doc: string; rev: number; text: string } | null {
  const src = rowSource(row);
  if (!src || typeof field !== "string") return null;
  const model = (src.by as unknown as { model?: Model<any, any> }).model;
  if (!model || !isTextField(model, field)) return null;
  const id = docName(model.name, field, src.key);
  if (id.length > 512) return null;
  known.delete(id);
  known.set(id, { model, key: src.key, field });
  if (known.size > KNOWN) known.delete(known.keys().next().value!);
  const d = docs.get(id);
  if (d) return { doc: id, rev: d.rev, text: d.text };
  const v = (row as Record<string, unknown>)[field];
  return { doc: id, rev: 0, text: typeof v === "string" ? v : "" };
}

(globalThis as Record<symbol, unknown>)[Symbol.for("weft.shared")] = { render };

function scoped(d: Doc, actor: unknown) {
  return d.model.as(actor) as unknown as {
    get(key: unknown): Record<string, unknown> | undefined;
    allows(verb: "read" | "write", key: unknown): boolean;
  };
}

function readable(d: Pick<Doc, "model" | "key" | "field">, actor: unknown): boolean {
  const row = (d.model.as(actor) as unknown as { get(key: unknown): Record<string, unknown> | undefined }).get(d.key);
  if (row === undefined) return false;
  const rule = d.model.fieldReads.find(([f]) => f === d.field)?.[1];
  if (!rule) return true;
  const raw = d.model.syncDriver().select([], d.key).find((r: Record<string, unknown>) => sameKey(r[d.model.key], d.key));
  try {
    return raw !== undefined && rule(actor as never, raw) === true;
  } catch {
    return false;
  }
}

function stored(d: Doc): string | undefined {
  const row = d.model.syncDriver().select([], d.key).find((r: Record<string, unknown>) => sameKey(r[d.model.key], d.key)) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  const v = row[d.field];
  return typeof v === "string" ? v : "";
}

let counter = 0;
const memberId = () => `m${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function state(d: Doc, m: Member, refused?: string): void {
  const writable = scoped(d, m.actor).allows("write", d.key);
  const msg: Text = { t: "text", doc: d.id, rev: d.rev, text: d.text, writable };
  if (refused) msg.refused = refused;
  m.send(msg);
}

function take(d: Doc, edit: Edit, from: Member | null): void {
  d.text = applyEdit(d.text, edit);
  d.rev += 1;
  d.log.push({ rev: d.rev, edit });
  if (d.log.length > LOG) d.log.shift();
  for (const m of d.members.values()) {
    if (m.sel) m.sel = [moveIndex(m.sel[0], edit, m === from), moveIndex(m.sel[1], edit, m === from)];
    m.send(m === from ? { t: "text", doc: d.id, rev: d.rev, mine: true } : { t: "text", doc: d.id, rev: d.rev, edit });
  }
  cursorsSoon(d);
}

function cursorsSoon(d: Doc): void {
  if (d.cursorTimer !== null) return;
  d.cursorTimer = setTimeout(() => {
    d.cursorTimer = null;
    for (const [entry, m] of d.members) {
      const cursors: SharedCursor[] = [];
      for (const [other, o] of d.members) {
        if (other === entry || !o.sel) continue;
        cursors.push(o.label === undefined ? { id: o.id, a: o.sel[0], h: o.sel[1] } : { id: o.id, label: o.label, a: o.sel[0], h: o.sel[1] });
      }
      m.send({ t: "text", doc: d.id, rev: d.rev, cursors });
    }
  }, CURSOR_MS);
  d.cursorTimer.unref?.();
}

function saveSoon(d: Doc): void {
  if (d.saveTimer !== null) clearTimeout(d.saveTimer);
  d.saveTimer = setTimeout(() => save(d), d.saveMs);
  d.saveTimer.unref?.();
}

function save(d: Doc): void {
  if (d.saveTimer !== null) clearTimeout(d.saveTimer);
  d.saveTimer = null;
  if (d.text === d.saved) return;
  const before = d.saved;
  const text = d.text;
  d.saved = text;
  let ok = false;
  try {
    const handle = d.model.as(d.saveAs) as unknown as {
      query(): { where(f: Record<string, unknown>): { update(p: Record<string, unknown>): number } };
    };
    ok = handle.query().where({ [d.model.key]: d.key }).update({ [d.field]: text }) === 1;
  } catch (err) {
    d.onError(err);
  }
  if (ok) return;
  d.saved = before;
  const now = stored(d);
  if (now === undefined) return gone(d);
  d.saved = now;
  const back = diffText(d.text, now);
  if (back.length) take(d, back, null);
  for (const m of d.members.values()) state(d, m, "The change could not be saved; this is the saved text.");
}

function gone(d: Doc): void {
  for (const m of d.members.values()) m.send({ t: "text", doc: d.id, rev: d.rev, text: "", writable: false, refused: "This row is gone." });
  drop(d);
}

function drop(d: Doc): void {
  if (d.saveTimer !== null) clearTimeout(d.saveTimer);
  if (d.cursorTimer !== null) clearTimeout(d.cursorTimer);
  docs.delete(d.id);
}

export function sharedMessage(entry: object, actor: unknown, msg: TextMessage, send: Send, opts: SharedFieldOptions & { onError: (err: unknown) => void }): void {
  let d = docs.get(msg.doc);
  if (msg.join) {
    const where = d ?? known.get(msg.doc);
    if (!where) return;
    if (!readable(where, actor)) {
      send({ t: "text", doc: msg.doc, rev: 0, text: "", writable: false, refused: "You cannot read this field." });
      return;
    }
    if (!d) {
      const w = known.get(msg.doc)!;
      d = {
        id: msg.doc,
        model: w.model,
        key: w.key,
        field: w.field,
        text: "",
        rev: 0,
        saved: "",
        log: [],
        members: new Map(),
        saveAs: actor,
        saveTimer: null,
        cursorTimer: null,
        saveMs: Math.max(50, opts.saveMs ?? 800),
        maxLength: opts.maxLength ?? 100_000,
        onError: opts.onError,
      };
      const now = stored(d);
      if (now === undefined) return send({ t: "text", doc: msg.doc, rev: 0, text: "", writable: false, refused: "This row is gone." });
      d.text = d.saved = now;
      docs.set(d.id, d);
    }
    const label = opts.label?.(actor);
    const m: Member = { id: d.members.get(entry)?.id ?? memberId(), sel: null, send, actor };
    if (typeof label === "string" && label !== "") m.label = label.slice(0, 200);
    d.members.set(entry, m);
    state(d, m);
    cursorsSoon(d);
    return;
  }
  const m = d?.members.get(entry);
  if (!d || !m) return;
  m.actor = actor;
  if (msg.sel) {
    let [a, h] = msg.sel;
    if (msg.rev < d.rev - d.log.length || msg.rev > d.rev) return;
    for (const e of d.log) {
      if (e.rev > msg.rev) {
        a = moveIndex(a, e.edit);
        h = moveIndex(h, e.edit);
      }
    }
    m.sel = [Math.min(a, d.text.length), Math.min(h, d.text.length)];
    cursorsSoon(d);
    return;
  }
  if (!msg.edit) return;
  if (!scoped(d, actor).allows("write", d.key)) return state(d, m, "You may not change this field.");
  if (msg.rev > d.rev || (msg.rev < d.rev && (d.log.length === 0 || d.log[0]!.rev > msg.rev + 1))) return state(d, m);
  let edit = msg.edit;
  for (const e of d.log) if (e.rev > msg.rev) edit = transform(edit, e.edit, false)[0];
  let next: string;
  try {
    next = applyEdit(d.text, edit);
  } catch {
    return state(d, m);
  }
  if (next.length > d.maxLength) return state(d, m, `The text is longer than ${d.maxLength} characters.`);
  take(d, edit, m);
  d.saveAs = actor;
  saveSoon(d);
}

export function sharedLeave(entry: object): void {
  for (const d of [...docs.values()]) {
    if (!d.members.delete(entry)) continue;
    if (d.members.size === 0) {
      save(d);
      drop(d);
    } else {
      cursorsSoon(d);
    }
  }
}

export function sharedChange(change: Change): void {
  for (const d of [...docs.values()]) {
    if (d.model.name !== change.model) continue;
    if (!change.redacted && !sameKey(change.key, d.key)) continue;
    if (change.op === "delete" && !change.redacted) {
      if (stored(d) === undefined) gone(d);
      continue;
    }
    const after = change.redacted ? stored(d) : ((change.after as Record<string, unknown> | undefined)?.[d.field] ?? "");
    if (after === undefined) {
      gone(d);
      continue;
    }
    if (typeof after !== "string" || after === d.saved) continue;
    const theirs = diffText(d.saved, after);
    const ours = diffText(d.saved, d.text);
    const [merged] = transform(theirs, ours, false);
    d.saved = after;
    if (merged.length) take(d, merged, null);
    for (const [entry, m] of d.members) {
      if (!readable(d, m.actor)) {
        m.send({ t: "text", doc: d.id, rev: d.rev, text: "", writable: false, refused: "You cannot read this field." });
        d.members.delete(entry);
      }
    }
    if (d.text !== d.saved) saveSoon(d);
  }
}

export function resetShared(): void {
  for (const d of [...docs.values()]) drop(d);
  known.clear();
}
