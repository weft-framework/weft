import { defaultActorId } from "./audit.ts";
import { defineModel, Model, type Actor } from "./model.ts";

type Key = string | number;

export function keyText(key: unknown): string {
  if (!((typeof key === "string" && key !== "") || (typeof key === "number" && Number.isFinite(key)))) {
    throw new TypeError("a row key is a non-empty string or a finite number");
  }
  return JSON.stringify(key);
}

export function keyValue(text: string): Key | undefined {
  try {
    const k = JSON.parse(text) as unknown;
    return typeof k === "string" || typeof k === "number" ? k : undefined;
  } catch {
    return undefined;
  }
}

function parentRow(parent: Model<any, any>, actor: Actor, text: string): unknown {
  const k = keyValue(text);
  if (k === undefined || actor === ACCESS) return undefined;
  try {
    return parent.as(actor).get(k);
  } catch {
    return undefined;
  }
}

function mayRead(parent: Model<any, any>, actor: Actor, text: string): boolean {
  return parentRow(parent, actor, text) !== undefined;
}

function mayWrite(parent: Model<any, any>, actor: Actor, text: string): boolean {
  const row = parentRow(parent, actor, text);
  return row !== undefined && parent.as(actor).writable(row);
}

class AddonAccess {}
const ACCESS = new AddonAccess();

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

interface Common {
  name?: string;
  actorId?(actor: Actor): string | null;
  now?(): number;
}

function forgetWith<R extends { key: string }>(parent: Model<any, any>, addon: Model<R, any>): void {
  parent.onWrite((w) => {
    if (w.action !== "delete") return;
    const text = JSON.stringify(w.key);
    addon.as(ACCESS).delete((r) => r.key === text);
  });
}

function checkName(name: string): string {
  if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(name)) throw new Error("add-ons: name is a model name");
  return name;
}

function needModel(parent: unknown, what: string): asserts parent is Model<any, any> {
  if (!(parent instanceof Model)) throw new TypeError(`${what}: needs a model`);
}

export interface CommentRow {
  id: string;
  key: string;
  author: string;
  body: string;
  at: number;
  edited: number | null;
}

export interface CommentsOptions extends Common {
  comment?: "read" | "write";
  maxLength?: number;
}

export class Comments {
  readonly model: Model<CommentRow>;
  readonly #id: (a: Actor) => string | null;
  readonly #now: () => number;

  constructor(parent: Model<any, any>, o: CommentsOptions = {}) {
    needModel(parent, "defineComments");
    const max = o.maxLength ?? 10_000;
    if (!Number.isInteger(max) || max < 1 || max > 1_000_000) throw new Error("defineComments: maxLength is 1 to 1 000 000");
    if (o.comment !== undefined && o.comment !== "read" && o.comment !== "write") throw new Error('defineComments: comment is "read" or "write"');
    const id = (this.#id = o.actorId ?? defaultActorId);
    this.#now = o.now ?? Date.now;
    const right = o.comment === "write" ? mayWrite : mayRead;
    this.model = defineModel<CommentRow>(checkName(o.name ?? `${parent.name}Comments`), {
      fields: { id: "string", key: "string", author: "string", body: "string", at: "number", edited: "number | null" },
      attrs: { key: { index: true } },
      read: (a, r) => a === ACCESS || mayRead(parent, a, r.key),
      write: (a, r) =>
        a === ACCESS ||
        (typeof r.body === "string" && r.body.trim() !== "" && r.body.length <= max && id(a) === r.author && right(parent, a, r.key)),
    });
    forgetWith(parent, this.model);
  }

  add(actor: Actor, key: Key, body: string): CommentRow | undefined {
    const author = this.#id(actor);
    if (author === null || typeof body !== "string") return undefined;
    return this.model.as(actor).create({ id: uuid(), key: keyText(key), author, body, at: this.#now(), edited: null });
  }

  list(actor: Actor, key: Key): CommentRow[] {
    return this.model.as(actor).query().where({ key: keyText(key) }).orderBy("at").orderBy("id").all() as CommentRow[];
  }

  edit(actor: Actor, id: string, body: string): boolean {
    if (typeof body !== "string") return false;
    return this.model.as(actor).update((r) => r.id === id, { body, edited: this.#now() }) === 1;
  }

  remove(actor: Actor, id: string): boolean {
    return this.model.as(actor).delete((r) => r.id === id) === 1;
  }
}

export function defineComments(model: Model<any, any>, options: CommentsOptions = {}): Comments {
  return new Comments(model, options);
}

export interface TagRow {
  id: string;
  key: string;
  tag: string;
  by: string | null;
  at: number;
}

export interface TagsOptions extends Common {
  normalize?(tag: string): string | null;
}

function defaultTag(tag: string): string | null {
  const t = tag.trim().replace(/\s+/g, " ").toLowerCase();
  return t.length >= 1 && t.length <= 50 && !/[\u0000-\u001f\u007f]/.test(t) ? t : null;
}

export class Tags {
  readonly model: Model<TagRow>;
  readonly #id: (a: Actor) => string | null;
  readonly #now: () => number;
  readonly #norm: (t: string) => string | null;
  readonly #parent: Model<any, any>;

  constructor(parent: Model<any, any>, o: TagsOptions = {}) {
    needModel(parent, "defineTags");
    this.#parent = parent;
    this.#id = o.actorId ?? defaultActorId;
    this.#now = o.now ?? Date.now;
    this.#norm = o.normalize ?? defaultTag;
    this.model = defineModel<TagRow>(checkName(o.name ?? `${parent.name}Tags`), {
      fields: { id: "string", key: "string", tag: "string", by: "string | null", at: "number" },
      attrs: { key: { index: true }, tag: { index: true } },
      read: (a, r) => a === ACCESS || mayRead(parent, a, r.key),
      write: (a, r) => a === ACCESS || (r.id === JSON.stringify([r.key, r.tag]) && mayWrite(parent, a, r.key)),
    });
    forgetWith(parent, this.model);
  }

  #tag(tag: unknown): string | null {
    if (typeof tag !== "string") return null;
    const t = this.#norm(tag);
    return typeof t === "string" && t !== "" ? t : null;
  }

  add(actor: Actor, key: Key, tag: string): boolean {
    const t = this.#tag(tag);
    if (t === null) return false;
    const k = keyText(key);
    const id = JSON.stringify([k, t]);
    const scoped = this.model.as(actor);
    if (scoped.get(id) !== undefined) return mayWrite(this.#parent, actor, k);
    try {
      return scoped.create({ id, key: k, tag: t, by: this.#id(actor), at: this.#now() }) !== undefined;
    } catch {
      return false;
    }
  }

  remove(actor: Actor, key: Key, tag: string): boolean {
    const t = this.#tag(tag);
    if (t === null) return false;
    const id = JSON.stringify([keyText(key), t]);
    return this.model.as(actor).delete((r) => r.id === id) === 1;
  }

  of(actor: Actor, key: Key): string[] {
    return (this.model.as(actor).query().where({ key: keyText(key) }).all() as TagRow[]).map((r) => r.tag).sort();
  }

  keysWith(actor: Actor, tag: string): Key[] {
    const t = this.#tag(tag);
    if (t === null) return [];
    return (this.model.as(actor).query().where({ tag: t }).all() as TagRow[]).map((r) => keyValue(r.key)!).filter((k) => k !== undefined);
  }

  counts(actor: Actor): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.model.as(actor).all()) out[r.tag] = (out[r.tag] ?? 0) + 1;
    return out;
  }
}

export function defineTags(model: Model<any, any>, options: TagsOptions = {}): Tags {
  return new Tags(model, options);
}

export interface AttachmentRow {
  id: string;
  key: string;
  file: string;
  name: string;
  by: string;
  at: number;
}

export interface AttachmentsOptions extends Common {
  attach?: "read" | "write";
  maxPerRow?: number;
}

export class Attachments {
  readonly model: Model<AttachmentRow>;
  readonly #id: (a: Actor) => string | null;
  readonly #now: () => number;
  readonly #max: number;

  constructor(parent: Model<any, any>, o: AttachmentsOptions = {}) {
    needModel(parent, "defineAttachments");
    if (o.attach !== undefined && o.attach !== "read" && o.attach !== "write") throw new Error('defineAttachments: attach is "read" or "write"');
    const max = o.maxPerRow ?? 100;
    if (!Number.isInteger(max) || max < 1 || max > 10_000) throw new Error("defineAttachments: maxPerRow is 1 to 10 000");
    this.#max = max;
    const id = (this.#id = o.actorId ?? defaultActorId);
    this.#now = o.now ?? Date.now;
    const right = o.attach === "read" ? mayRead : mayWrite;
    this.model = defineModel<AttachmentRow>(checkName(o.name ?? `${parent.name}Attachments`), {
      fields: { id: "string", key: "string", file: "File", name: "string", by: "string", at: "number" },
      attrs: { key: { index: true } },
      read: (a, r) => a === ACCESS || mayRead(parent, a, r.key),
      write: (a, r) =>
        a === ACCESS ||
        (typeof r.name === "string" && r.name.trim() !== "" && r.name.length <= 255 && id(a) === r.by && right(parent, a, r.key)),
    });
    forgetWith(parent, this.model);
  }

  add(actor: Actor, key: Key, file: string, name: string): AttachmentRow | undefined {
    const by = this.#id(actor);
    if (by === null || typeof name !== "string") return undefined;
    const k = keyText(key);
    if (this.model.as(actor).query().where({ key: k }).count() >= this.#max) return undefined;
    return this.model.as(actor).create({ id: uuid(), key: k, file, name: name.trim(), by, at: this.#now() });
  }

  list(actor: Actor, key: Key): AttachmentRow[] {
    return this.model.as(actor).query().where({ key: keyText(key) }).orderBy("at").orderBy("id").all() as AttachmentRow[];
  }

  remove(actor: Actor, id: string): boolean {
    return this.model.as(actor).delete((r) => r.id === id) === 1;
  }
}

export function defineAttachments(model: Model<any, any>, options: AttachmentsOptions = {}): Attachments {
  return new Attachments(model, options);
}
