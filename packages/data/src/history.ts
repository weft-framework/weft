import { defaultActorId } from "./audit.ts";
import { defineModel, Model, ScopedModel, type Actor, type WriteEvent } from "./model.ts";

export interface HistoryRow {
  id: string;
  key: string;
  version: number;
  at: number;
  actor: string | null;
  action: string;
  data: string;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface Version<T> {
  version: number;
  at: number;
  actor: string | null;
  action: "create" | "update" | "trash" | "restore";
  row: Partial<T>;
  changes: FieldChange[];
}

export type UndoResult =
  | { ok: true; action: Version<unknown>["action"]; version: number }
  | { ok: false; reason: "not-found" | "nothing" | "not-yours" | "too-old" | "changed" | "not-kept" | "refused" };

export interface HistoryOptions<T> {
  omit?: readonly (keyof T & string)[];
  keep?: number;
  actorId?(actor: Actor): string | null;
  name?: string;
  onError?(err: unknown): void;
  now?(): number;
}

class HistoryAccess {
  readonly weftHistory = true;
}
const ACCESS = new HistoryAccess();

export class History<T> {
  readonly source: Model<T, never>;
  readonly model: Model<HistoryRow>;
  readonly #omit: Set<string>;
  readonly #keep: number;
  readonly #actorId: (a: Actor) => string | null;
  readonly #onError: (err: unknown) => void;
  readonly #now: () => number;
  readonly #off: () => void;

  constructor(source: Model<T, never>, o: HistoryOptions<T> = {}) {
    if (!(source instanceof Model)) throw new TypeError("defineHistory: needs a model");
    const keep = o.keep ?? 100;
    if (!Number.isInteger(keep) || keep < 1 || keep > 10_000) throw new Error("defineHistory: keep is 1 to 10 000");
    const fields = new Set(source.fields.map((f) => f.name));
    for (const f of o.omit ?? []) {
      if (!fields.has(f)) throw new Error(`defineHistory: ${source.name} has no field \`${f}\``);
      if (f === source.key) throw new Error("defineHistory: the key cannot be omitted");
    }
    const name = o.name ?? `${source.name}History`;
    if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(name)) throw new Error("defineHistory: name is a model name");
    this.source = source;
    this.#omit = new Set([...(o.omit ?? []), ...source.fieldReads.map(([f]) => f)]);
    this.#keep = keep;
    this.#actorId = o.actorId ?? defaultActorId;
    this.#onError = o.onError ?? ((err) => console.error("weft history:", err));
    this.#now = o.now ?? Date.now;
    const only = (a: unknown) => a === ACCESS;
    this.model = defineModel<HistoryRow>(name, {
      fields: { id: "string", key: "string", version: "number", at: "number", actor: "string | null", action: "string", data: "string" },
      attrs: { key: { index: true }, at: { index: true } },
      read: only,
      write: only,
      readWhere: { truthy: { actor: ["weftHistory"] } },
      writeWhere: { truthy: { actor: ["weftHistory"] } },
    });
    this.#off = source.onWrite((w) => {
      try {
        this.#record(w);
      } catch (err) {
        this.#onError(err);
      }
    });
  }

  stop(): void {
    this.#off();
  }

  #record(w: WriteEvent<T>): void {
    const key = JSON.stringify(w.key);
    const store = this.model.as(ACCESS);
    if (w.action === "delete") {
      store.delete((r) => r.key === key);
      return;
    }
    const last = store.query().where({ key }).orderBy("version", "desc").first();
    const version = (last?.version ?? 0) + 1;
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(w.after as Record<string, unknown>)) {
      if (!this.#omit.has(k)) row[k] = v;
    }
    store.create({
      id: `${key}#${version}`,
      key,
      version,
      at: this.#now(),
      actor: w.actor === null ? null : this.#actorId(w.actor),
      action: w.action,
      data: JSON.stringify(row),
    });
    if (version > this.#keep) {
      const drop = version - this.#keep;
      store.delete((r) => r.key === key && r.version <= drop);
    }
  }

  #check(scoped: ScopedModel<T, any>): void {
    if (!(scoped instanceof ScopedModel) || scoped.model !== (this.source as unknown)) {
      throw new TypeError(`history of ${this.source.name}: pass ${this.source.name}.as(actor)`);
    }
  }

  #readable(scoped: ScopedModel<T, any>, key: unknown): boolean {
    this.#check(scoped);
    if (scoped.get(key) !== undefined) return true;
    if (this.source.trashField === null) return false;
    return scoped.trash().get(key) !== undefined;
  }

  #rows(key: unknown): HistoryRow[] {
    return this.model.as(ACCESS).query().where({ key: JSON.stringify(key) }).orderBy("version", "asc").all() as HistoryRow[];
  }

  versions(scoped: ScopedModel<T, any>, key: unknown, o: { limit?: number } = {}): Version<T>[] | null {
    if (!this.#readable(scoped, key)) return null;
    const rows = this.#rows(key);
    const out: Version<T>[] = [];
    let prev: Record<string, unknown> = {};
    for (const r of rows) {
      const row = JSON.parse(r.data) as Record<string, unknown>;
      out.push({
        version: r.version,
        at: r.at,
        actor: r.actor,
        action: r.action as Version<T>["action"],
        row: row as Partial<T>,
        changes: changes(prev, row),
      });
      prev = row;
    }
    out.reverse();
    return out.slice(0, clampLimit(o.limit, 100));
  }

  recent(scoped: ScopedModel<T, any>, o: { limit?: number; before?: number; scan?: number } = {}): (Version<T> & { key: unknown })[] {
    this.#check(scoped);
    const limit = clampLimit(o.limit, 50);
    const scan = clampLimit(o.scan, 2000);
    const store = this.model.as(ACCESS);
    const seen = new Map<string, boolean>();
    const out: (Version<T> & { key: unknown })[] = [];
    let offset = 0;
    while (out.length < limit && offset < scan) {
      let q = store.query().orderBy("at", "desc").orderBy("version", "desc");
      if (o.before !== undefined) q = q.where({ at: { lt: o.before } } as never);
      const page = q.offset(offset).limit(Math.min(200, scan - offset)).all() as HistoryRow[];
      if (page.length === 0) break;
      offset += page.length;
      for (const r of page) {
        let ok = seen.get(r.key);
        const key = JSON.parse(r.key) as unknown;
        if (ok === undefined) seen.set(r.key, (ok = this.#readable(scoped, key)));
        if (!ok) continue;
        const row = JSON.parse(r.data) as Record<string, unknown>;
        const prior = r.version > 1 ? store.get(`${r.key}#${r.version - 1}`) : undefined;
        out.push({
          key,
          version: r.version,
          at: r.at,
          actor: r.actor,
          action: r.action as Version<T>["action"],
          row: row as Partial<T>,
          changes: changes(prior ? (JSON.parse(prior.data) as Record<string, unknown>) : {}, row),
        });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  diff(scoped: ScopedModel<T, any>, key: unknown, from: number, to: number): FieldChange[] | null {
    if (!this.#readable(scoped, key)) return null;
    const rows = this.#rows(key);
    const a = rows.find((r) => r.version === from);
    const b = rows.find((r) => r.version === to);
    if (!a || !b) return null;
    return changes(JSON.parse(a.data) as Record<string, unknown>, JSON.parse(b.data) as Record<string, unknown>);
  }

  restore(scoped: ScopedModel<T, any>, key: unknown, version: number): boolean {
    if (!this.#readable(scoped, key) || scoped.trashed) return false;
    const target = this.#rows(key).find((r) => r.version === version);
    if (!target) return false;
    return this.#putBack(scoped, key, JSON.parse(target.data) as Record<string, unknown>);
  }

  undo(scoped: ScopedModel<T, any>, key: unknown, o: { within?: number } = {}): UndoResult {
    this.#check(scoped);
    if (scoped.trashed) throw new TypeError(`undo on ${this.source.name}: pass the live handle, ${this.source.name}.as(actor)`);
    if (!this.#readable(scoped, key)) return { ok: false, reason: "not-found" };
    const me = this.#actorId(scoped.actor);
    const rows = this.#rows(key);
    const last = rows[rows.length - 1];
    if (last === undefined) return { ok: false, reason: "nothing" };
    if (me === null || last.actor !== me) return { ok: false, reason: "not-yours" };
    if (o.within !== undefined && this.#now() - last.at > o.within) return { ok: false, reason: "too-old" };
    const current = (scoped.get(key) ?? (this.source.trashField === null ? undefined : scoped.trash().get(key))) as
      | Record<string, unknown>
      | undefined;
    const wrote = JSON.parse(last.data) as Record<string, unknown>;
    if (current === undefined || Object.keys(wrote).some((f) => !same(current[f], wrote[f]))) {
      return { ok: false, reason: "changed" };
    }
    const k = this.source.key;
    const mine = (r: T) => (r as Record<string, unknown>)[k] === key;
    let done: boolean;
    switch (last.action) {
      case "create":
      case "restore":
        done = scoped.delete(mine) === 1;
        break;
      case "trash":
        done = scoped.trash().restore(mine) === 1;
        break;
      default: {
        const before = rows[rows.length - 2];
        if (before === undefined || before.version !== last.version - 1) return { ok: false, reason: "not-kept" };
        done = this.#putBack(scoped, key, JSON.parse(before.data) as Record<string, unknown>);
      }
    }
    return done ? { ok: true, action: last.action as Version<T>["action"], version: last.version } : { ok: false, reason: "refused" };
  }

  undoable(scoped: ScopedModel<T, any>, o: { limit?: number; within?: number; scan?: number } = {}): (Version<T> & { key: unknown })[] {
    this.#check(scoped);
    const me = this.#actorId(scoped.actor);
    if (me === null) return [];
    const limit = clampLimit(o.limit, 20);
    const since = o.within === undefined ? undefined : this.#now() - o.within;
    const store = this.model.as(ACCESS);
    const out: (Version<T> & { key: unknown })[] = [];
    const done = new Set<string>();
    for (const v of this.recent(scoped, { limit: 10_000, scan: o.scan })) {
      if (since !== undefined && v.at < since) break;
      const id = JSON.stringify(v.key);
      if (done.has(id)) continue;
      done.add(id);
      if (v.actor !== me || store.get(`${id}#${v.version + 1}`) !== undefined) continue;
      out.push(v);
      if (out.length >= limit) break;
    }
    return out;
  }

  #putBack(scoped: ScopedModel<T, any>, key: unknown, old: Record<string, unknown>): boolean {
    const current = scoped.get(key) as Record<string, unknown> | undefined;
    if (!current) return false;
    const fixed = new Set<string>([this.source.key, ...this.source.fileFields, ...this.#omit]);
    if (this.source.tenant !== null) fixed.add(this.source.tenant);
    if (this.source.trashField !== null) fixed.add(this.source.trashField);
    for (const f of this.source.lockedFields) fixed.add(f);
    const known = new Set(this.source.fields.map((f) => f.name));
    const patch: Record<string, unknown> = {};
    for (const [f, v] of Object.entries(old)) {
      if (known.has(f) && !fixed.has(f) && !same(current[f], v)) patch[f] = v;
    }
    if (Object.keys(patch).length === 0) return true;
    const k = this.source.key;
    return scoped.update((r) => (r as Record<string, unknown>)[k] === key, patch as Partial<T>) === 1;
  }
}

function clampLimit(n: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(Math.trunc(n ?? fallback) || 1, 10_000));
}

export interface ActivityItem {
  model: string;
  key: unknown;
  at: number;
  actor: string | null;
  action: Version<unknown>["action"];
  text: string;
}

export interface ActivitySource<T> {
  history: History<T>;
  scoped: ScopedModel<T, any>;
  describe(v: Version<T>): string | null;
}

export function activity(sources: readonly ActivitySource<any>[], o: { limit?: number; before?: number; scan?: number } = {}): ActivityItem[] {
  const limit = clampLimit(o.limit, 50);
  const all: ActivityItem[] = [];
  for (const s of sources) {
    if (!(s.history instanceof History) || typeof s.describe !== "function") throw new TypeError("activity: sources are { history, scoped, describe }");
    for (const v of s.history.recent(s.scoped, { ...o, limit: limit * 2 })) {
      const text = s.describe(v);
      if (typeof text !== "string" || text === "") continue;
      all.push({ model: s.history.source.name, key: v.key, at: v.at, actor: v.actor, action: v.action, text });
    }
  }
  return all.sort((a, b) => b.at - a.at).slice(0, limit);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function changes(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!same(before[f], after[f])) out.push({ field: f, before: before[f] ?? null, after: after[f] ?? null });
  }
  return out;
}

export function defineHistory<T>(model: Model<T, any>, options: HistoryOptions<T> = {}): History<T> {
  return new History<T>(model as Model<T, never>, options);
}
