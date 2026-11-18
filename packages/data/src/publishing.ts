import { defaultActorId } from "./audit.ts";
import { keyText, keyValue } from "./addons.ts";
import { isThenable, out, sub, type Flow, type Out } from "./flow.ts";
import { defineModel, FieldLock, Model, ScopedModel, type Actor } from "./model.ts";
import type { FieldSpec } from "./schema.ts";
import { atomic } from "./tx.ts";

type Key = string | number;

export interface PublishingOptions<T> {
  fields: readonly (keyof T & string)[];
  publishedField?: keyof T & string;
  actor?(id: string): Actor | undefined;
  name?: string;
  actorId?(actor: Actor): string | null;
  now?(): number;
}

export interface DraftRow {
  id: string;
  data: Record<string, unknown>;
  by: string | null;
  at: number;
  publishAt: number | null;
  scheduledBy: string | null;
}

export interface PublishDueResult {
  published: number;
  dropped: { key: Key; reason: "no such user" | "not allowed" }[];
}

class DraftWriter {}
const WRITER = new DraftWriter();

function fits(f: FieldSpec, v: unknown): boolean {
  if (v === null || v === undefined) return f.nullable;
  switch (f.kind) {
    case "text": {
      if (typeof v !== "string") return false;
      const lits = f.type.replace(/\s*\|\s*(null|undefined)\b/g, "").split("|").map((s) => s.trim());
      return lits.every((l) => /^(["']).*\1$/.test(l)) ? lits.some((l) => l.slice(1, -1) === v) : true;
    }
    case "real":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "bigint";
    case "bool":
      return typeof v === "boolean";
    case "date":
      return v instanceof Date && !Number.isNaN(v.getTime());
    case "json":
      try {
        return JSON.stringify(v) !== undefined;
      } catch {
        return false;
      }
  }
}

function encode(f: FieldSpec, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (f.kind === "date") return (v as Date).toISOString();
  if (f.kind === "integer") return (v as bigint).toString();
  return JSON.parse(JSON.stringify(v)) as unknown;
}

function decode(f: FieldSpec, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (f.kind === "date") return new Date(v as string);
  if (f.kind === "integer") return BigInt(v as string);
  return v;
}

export class Publishing<T> {
  readonly model: Model<DraftRow>;
  readonly fields: readonly string[];
  readonly #source: Model<T, any>;
  readonly #specs: ReadonlyMap<string, FieldSpec>;
  readonly #lock: FieldLock | null;
  readonly #actor: ((id: string) => Actor | undefined) | null;
  readonly #id: (a: Actor) => string | null;
  readonly #now: () => number;

  constructor(source: Model<T, any>, o: PublishingOptions<T>) {
    if (!(source instanceof Model)) throw new TypeError("definePublishing: needs a model");
    const fail = (msg: string): never => {
      throw new Error(`definePublishing(${source.name}): ${msg}`);
    };
    if (!o || typeof o !== "object") fail("needs options");
    if (!Array.isArray(o.fields) || o.fields.length === 0) fail("fields lists what a draft may change");
    const fixed = new Set<string>([source.key, ...source.fileFields, ...source.lockedFields]);
    if (source.tenant !== null) fixed.add(source.tenant);
    if (source.trashField !== null) fixed.add(source.trashField);
    if (o.publishedField !== undefined) fixed.add(o.publishedField);
    const specs = new Map<string, FieldSpec>();
    for (const name of o.fields) {
      const spec = source.fields.find((f) => f.name === name);
      if (!spec) fail(`no field \`${String(name)}\``);
      if (fixed.has(name)) fail(`\`${name}\` (the key, tenant, trash, a file or a locked field) is not drafted`);
      if (specs.has(name)) fail(`\`${name}\` is listed twice`);
      specs.set(name, spec!);
    }
    if (o.publishedField !== undefined) {
      const spec = source.fields.find((f) => f.name === o.publishedField);
      if (!spec) fail(`no field \`${String(o.publishedField)}\``);
      if (spec!.type.replace(/\s/g, "") !== "number|null") fail(`publishedField \`${o.publishedField}\` is \`number | null\``);
    }
    if (o.actor !== undefined && typeof o.actor !== "function") fail("actor is a function from a user id");
    const name = o.name ?? `${source.name}Drafts`;
    if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(name)) fail("name is a model name");

    this.fields = Object.freeze([...specs.keys()]);
    this.#source = source;
    this.#specs = specs;
    this.#actor = o.actor ?? null;
    this.#id = o.actorId ?? defaultActorId;
    this.#now = o.now ?? Date.now;
    const editable = (a: Actor, text: string): boolean => {
      const k = keyValue(text);
      if (k === undefined || a === WRITER) return false;
      // A policy cannot wait on Postgres: direct reads of the drafts model are refused there;
      // the methods below check the source row first and read as the drafts writer.
      if (source.isAsync) return false;
      try {
        const scoped = source.as(a);
        const row = scoped.get(k as never);
        return row !== undefined && scoped.writable(row);
      } catch {
        return false;
      }
    };
    this.model = defineModel<DraftRow>(name, {
      fields: {
        id: "string",
        data: "Record<string, unknown>",
        by: "string | null",
        at: "number",
        publishAt: "number | null",
        scheduledBy: "string | null",
      },
      attrs: { publishAt: { index: true } },
      read: (a, r) => a === WRITER || editable(a, r.id),
      write: (a) => a === WRITER,
    });
    this.#lock = o.publishedField === undefined ? null : source.lock(o.publishedField, null, `${source.name} publishing`);
    source.onWrite((w) => {
      if (w.action !== "delete") return;
      const text = JSON.stringify(w.key);
      const done = this.model.as(WRITER).delete((r) => r.id === text);
      return isThenable(done) ? Promise.resolve(done).then(() => {}) : undefined;
    });
  }

  get #async(): boolean {
    return this.#source.isAsync || this.model.isAsync;
  }

  #handle(scoped: ScopedModel<T, any>): void {
    if (!(scoped instanceof ScopedModel) || scoped.model !== this.#source) {
      throw new TypeError(`publishing: pass ${this.#source.name}.as(actor)`);
    }
  }

  *#editable(scoped: ScopedModel<T, any>, key: Key): Flow<T | undefined> {
    this.#handle(scoped);
    keyText(key);
    const row = yield* sub(scoped.get(key as never));
    return row !== undefined && scoped.writable(row) ? row : undefined;
  }

  *#stored(key: Key): Flow<DraftRow | undefined> {
    return yield* sub(this.model.as(WRITER).get(keyText(key)));
  }

  #values(d: DraftRow): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const [f, v] of Object.entries(d.data)) {
      const spec = this.#specs.get(f);
      if (spec) out[f] = decode(spec, v);
    }
    return out as Partial<T>;
  }

  saveDraft(scoped: ScopedModel<T, any>, key: Key, patch: Partial<T>): Out<boolean> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("publishing: a draft patch is an object");
    const add: Record<string, unknown> = {};
    for (const [f, v] of Object.entries(patch)) {
      const spec = this.#specs.get(f);
      if (!spec) throw new Error(`publishing: \`${f}\` is not one of the drafted fields (${this.fields.join(", ")})`);
      if (!fits(spec, v)) throw new Error(`publishing: \`${f}\` does not fit \`${spec.type}\``);
      add[f] = encode(spec, v);
    }
    const self = this;
    return atomic(this.#async, function* () {
      if ((yield* self.#editable(scoped, key)) === undefined) return false;
      const by = self.#id(scoped.actor);
      const old = yield* self.#stored(key);
      const w = self.model.as(WRITER);
      if (old) {
        yield* sub(w.update((r) => r.id === old.id, { data: { ...old.data, ...add }, by, at: self.#now(), publishAt: null, scheduledBy: null }));
      } else {
        yield* sub(w.create({ id: keyText(key), data: add, by, at: self.#now(), publishAt: null, scheduledBy: null }));
      }
      return true;
    });
  }

  draft(scoped: ScopedModel<T, any>, key: Key): Out<{ values: Partial<T>; by: string | null; at: number; publishAt: number | null } | undefined> {
    const self = this;
    return out(
      (function* () {
        if ((yield* self.#editable(scoped, key)) === undefined) return undefined;
        const d = yield* self.#stored(key);
        return d ? { values: self.#values(d), by: d.by, at: d.at, publishAt: d.publishAt } : undefined;
      })(),
    );
  }

  preview(scoped: ScopedModel<T, any>, key: Key): Out<T | undefined> {
    const self = this;
    return out(
      (function* () {
        const row = yield* self.#editable(scoped, key);
        if (row === undefined) return undefined;
        const d = yield* self.#stored(key);
        return d ? { ...row, ...self.#values(d) } : row;
      })(),
    );
  }

  discard(scoped: ScopedModel<T, any>, key: Key): Out<boolean> {
    const self = this;
    return atomic(this.#async, function* () {
      if ((yield* self.#editable(scoped, key)) === undefined) return false;
      return (yield* sub(self.model.as(WRITER).delete((r) => r.id === keyText(key)))) === 1;
    });
  }

  publish(scoped: ScopedModel<T, any>, key: Key): Out<boolean> {
    return atomic(this.#async, () => this.#publishG(scoped, key));
  }

  *#publishG(scoped: ScopedModel<T, any>, key: Key): Flow<boolean> {
    const row = yield* this.#editable(scoped, key);
    if (row === undefined) return false;
    const d = yield* this.#stored(key);
    const patch: Record<string, unknown> = d ? { ...this.#values(d) } : {};
    const pf = this.#lock?.field;
    const first = pf !== undefined && (row as Record<string, unknown>)[pf] === null;
    if (first) patch[pf!] = this.#now();
    if (Object.keys(patch).length === 0) return false;
    const k = this.#source.key;
    const pred = (r: T) => (r as Record<string, unknown>)[k] === (row as Record<string, unknown>)[k];
    const n = yield* sub(first ? scoped.updateLocked(this.#lock!, pred, patch as Partial<T>) : scoped.update(pred, patch as Partial<T>));
    if (n !== 1) return false;
    if (d) yield* sub(this.model.as(WRITER).delete((r) => r.id === d.id));
    return true;
  }

  schedule(scoped: ScopedModel<T, any>, key: Key, at: number): Out<boolean> {
    if (this.#actor === null) throw new Error("publishing: scheduling needs the `actor` option");
    if (!Number.isFinite(at)) throw new TypeError("publishing: schedule at a time in ms");
    const self = this;
    return atomic(this.#async, function* () {
      if ((yield* self.#editable(scoped, key)) === undefined) return false;
      const by = self.#id(scoped.actor);
      if (by === null) return false;
      const w = self.model.as(WRITER);
      const d = yield* self.#stored(key);
      if (d) return (yield* sub(w.update((r) => r.id === d.id, { publishAt: at, scheduledBy: by }))) === 1;
      if (self.#lock === null) return false;
      yield* sub(w.create({ id: keyText(key), data: {}, by, at: self.#now(), publishAt: at, scheduledBy: by }));
      return true;
    });
  }

  unschedule(scoped: ScopedModel<T, any>, key: Key): Out<boolean> {
    const self = this;
    return atomic(this.#async, function* () {
      if ((yield* self.#editable(scoped, key)) === undefined) return false;
      return (yield* sub(self.model.as(WRITER).update((r) => r.id === keyText(key) && r.publishAt !== null, { publishAt: null, scheduledBy: null }))) === 1;
    });
  }

  publishDue(now: number = this.#now()): Out<PublishDueResult> {
    return out(this.#publishDueG(now));
  }

  *#publishDueG(now: number): Flow<PublishDueResult> {
    const result: PublishDueResult = { published: 0, dropped: [] };
    if (this.#actor === null) return result;
    const due = ((yield* sub(this.model.as(WRITER).all())) as DraftRow[])
      .filter((d) => d.publishAt !== null && d.publishAt <= now)
      .sort((a, b) => a.publishAt! - b.publishAt! || (a.id < b.id ? -1 : 1));
    for (const d of due) {
      const key = keyValue(d.id);
      if (key === undefined) continue;
      const drop = function* (self: Publishing<T>, reason: PublishDueResult["dropped"][number]["reason"]): Flow<void> {
        yield* sub(self.model.as(WRITER).update((r) => r.id === d.id, { publishAt: null, scheduledBy: null }));
        result.dropped.push({ key, reason });
      };
      let actor: Actor | undefined;
      try {
        actor = d.scheduledBy === null ? undefined : this.#actor(d.scheduledBy);
      } catch {
        actor = undefined;
      }
      if (actor === undefined || actor === null) {
        yield* drop(this, "no such user");
        continue;
      }
      if (yield* sub(this.publish(this.#source.as(actor), key))) result.published += 1;
      else yield* drop(this, "not allowed");
    }
    return result;
  }
}

export function definePublishing<T>(model: Model<T, any>, options: PublishingOptions<T>): Publishing<T> {
  return new Publishing(model, options);
}
