import { defaultActorId } from "./audit.ts";
import { keyText, keyValue } from "./addons.ts";
import { sameValue } from "./filter.ts";
import { andThen, isThenable, sub, type Out } from "./flow.ts";
import { defineModel, FieldLock, Model, ScopedModel, type Actor } from "./model.ts";
import { atomic } from "./tx.ts";

type Key = string | number;

export interface Transition<A = any, T = any> {
  from: string | readonly string[];
  to: string;
  allow?(actor: A, row: T): boolean;
  note?: "optional" | "required" | "none";
}

export interface WorkflowOptions<T> {
  field: keyof T & string;
  initial: string;
  transitions: Record<string, Transition<any, T>>;
  name?: string;
  actorId?(actor: Actor): string | null;
  maxNote?: number;
  now?(): number;
}

export interface StepRow {
  id: string;
  key: string;
  n: number;
  transition: string;
  from: string;
  to: string;
  by: string | null;
  at: number;
  note: string | null;
}

export type MoveResult<T> =
  | { ok: true; row: T; step: StepRow }
  | { ok: false; reason: "not found" | "no such transition" | "wrong state" | "not allowed" | "note required" | "bad note" | "changed meanwhile" };

class StepWriter {}
const WRITER = new StepWriter();

const NAME_RE = /^[a-z][A-Za-z0-9_]{0,63}$/;

function literals(type: string): string[] | null {
  const t = type.trim();
  if (t === "string") return null;
  const out: string[] = [];
  for (const part of t.split("|")) {
    const m = /^\s*(?:"([^"\\]*)"|'([^'\\]*)')\s*$/.exec(part);
    if (!m) return [];
    out.push(m[1] ?? m[2]!);
  }
  return out;
}

export class Workflow<T> {
  readonly model: Model<StepRow>;
  readonly field: string;
  readonly initial: string;
  readonly states: readonly string[];
  readonly #source: Model<T, any>;
  readonly #lock: FieldLock;
  readonly #t: ReadonlyMap<string, { from: ReadonlySet<string>; to: string; allow?: (a: any, r: T) => boolean; note: "optional" | "required" | "none" }>;
  readonly #id: (a: Actor) => string | null;
  readonly #now: () => number;
  readonly #maxNote: number;

  constructor(source: Model<T, any>, o: WorkflowOptions<T>) {
    if (!(source instanceof Model)) throw new TypeError("defineWorkflow: needs a model");
    const fail = (msg: string): never => {
      throw new Error(`defineWorkflow(${source.name}): ${msg}`);
    };
    if (!o || typeof o !== "object") fail("needs options");
    const spec = source.fields.find((f) => f.name === o.field);
    if (!spec) fail(`no field \`${String(o.field)}\``);
    const allowed = literals(spec!.type);
    if (allowed !== null && allowed.length === 0) fail(`\`${o.field}\` is \`string\` or a union of string literals`);
    if (typeof o.initial !== "string" || o.initial === "") fail("initial is a state name");
    const entries = Object.entries(o.transitions ?? {});
    if (entries.length === 0) fail("no transitions");
    const states = new Set<string>([o.initial]);
    const t = new Map<string, { from: ReadonlySet<string>; to: string; allow?: (a: any, r: T) => boolean; note: "optional" | "required" | "none" }>();
    for (const [name, tr] of entries) {
      if (!NAME_RE.test(name)) fail(`transition \`${name}\`: names are lower-case identifiers`);
      if (!tr || typeof tr !== "object") fail(`transition \`${name}\` is { from, to }`);
      const from = typeof tr.from === "string" ? [tr.from] : Array.isArray(tr.from) ? [...tr.from] : [];
      if (from.length === 0 || from.some((s) => typeof s !== "string" || s === "")) fail(`transition \`${name}\`: from is a state or a list of states`);
      if (typeof tr.to !== "string" || tr.to === "") fail(`transition \`${name}\`: to is a state`);
      if (from.includes(tr.to)) fail(`transition \`${name}\` goes from \`${tr.to}\` to itself`);
      if (tr.allow !== undefined && typeof tr.allow !== "function") fail(`transition \`${name}\`: allow is a function`);
      const note = tr.note ?? "optional";
      if (note !== "optional" && note !== "required" && note !== "none") fail(`transition \`${name}\`: note is "optional", "required" or "none"`);
      for (const s of [...from, tr.to]) states.add(s);
      t.set(name, { from: new Set(from), to: tr.to, ...(tr.allow ? { allow: tr.allow } : {}), note });
    }
    if (allowed !== null) {
      for (const s of states) if (!allowed.includes(s)) fail(`state \`${s}\` is not one of \`${o.field}\`'s values`);
    }
    for (const s of states) if (s !== o.initial && ![...t.values()].some((x) => x.to === s)) fail(`no transition reaches \`${s}\``);
    const maxNote = o.maxNote ?? 2000;
    if (!Number.isInteger(maxNote) || maxNote < 1 || maxNote > 100_000) fail("maxNote is 1 to 100 000");
    const name = o.name ?? `${source.name}Steps`;
    if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(name)) fail("name is a model name");

    this.field = o.field;
    this.initial = o.initial;
    this.states = Object.freeze([...states]);
    this.#source = source;
    this.#t = t;
    this.#id = o.actorId ?? defaultActorId;
    this.#now = o.now ?? Date.now;
    this.#maxNote = maxNote;
    this.#lock = source.lock(o.field, o.initial, `the ${source.name} workflow`);
    const readable = (a: Actor, text: string): boolean => {
      const k = keyValue(text);
      if (k === undefined || a === WRITER) return false;
      if (source.isAsync) return false;
      try {
        return source.as(a).get(k as never) !== undefined;
      } catch {
        return false;
      }
    };
    this.model = defineModel<StepRow>(name, {
      fields: {
        id: "string",
        key: "string",
        n: "number",
        transition: "string",
        from: "string",
        to: "string",
        by: "string | null",
        at: "number",
        note: "string | null",
      },
      attrs: { key: { index: true } },
      read: (a, r) => a === WRITER || readable(a, r.key),
      write: (a) => a === WRITER,
    });
    source.onWrite((w) => {
      if (w.action !== "delete") return;
      const text = JSON.stringify(w.key);
      const done = this.model.as(WRITER).delete((r) => r.key === text);
      return isThenable(done) ? Promise.resolve(done).then(() => {}) : undefined;
    });
  }

  #handle(scoped: ScopedModel<T, any>): void {
    if (!(scoped instanceof ScopedModel) || scoped.model !== this.#source) {
      throw new TypeError(`workflow: pass ${this.#source.name}.as(actor)`);
    }
  }

  #may(scoped: ScopedModel<T, any>, row: T, transition: string): MoveResult<T> | null {
    const tr = this.#t.get(transition);
    if (!tr) return { ok: false, reason: "no such transition" };
    if (!tr.from.has((row as Record<string, unknown>)[this.field] as string)) return { ok: false, reason: "wrong state" };
    if (!scoped.writable(row)) return { ok: false, reason: "not allowed" };
    if (tr.allow) {
      let ok = false;
      try {
        ok = tr.allow(scoped.actor, row) === true;
      } catch {
        ok = false;
      }
      if (!ok) return { ok: false, reason: "not allowed" };
    }
    const moved = { ...row, [this.field]: tr.to } as T;
    if (!scoped.writable(moved)) return { ok: false, reason: "not allowed" };
    return null;
  }

  move(scoped: ScopedModel<T, any>, key: Key, transition: string, opts: { note?: string } = {}): Out<MoveResult<T>> {
    this.#handle(scoped);
    const k = keyText(key);
    const tr = this.#t.get(transition);
    const early = (r: MoveResult<T>): Out<MoveResult<T>> => (this.#source.isAsync ? Promise.resolve(r) : r) as Out<MoveResult<T>>;
    if (!tr) return early({ ok: false, reason: "no such transition" });
    let note: string | null = null;
    if (opts.note !== undefined && opts.note !== null) {
      if (typeof opts.note !== "string") return early({ ok: false, reason: "bad note" });
      const n = opts.note.trim();
      if (n !== "") {
        if (tr.note === "none" || n.length > this.#maxNote) return early({ ok: false, reason: "bad note" });
        note = n;
      }
    }
    if (tr.note === "required" && note === null) return early({ ok: false, reason: "note required" });
    const self = this;
    return atomic(this.#source.isAsync || this.model.isAsync, function* () {
      const row = yield* sub(scoped.get(key as never));
      if (row === undefined) return { ok: false, reason: "not found" } as MoveResult<T>;
      const refused = self.#may(scoped, row, transition);
      if (refused) return refused;
      const from = (row as Record<string, unknown>)[self.field] as string;
      const keyField = self.#source.key;
      const n = yield* sub(
        scoped.updateLocked(
          self.#lock,
          (r) =>
            sameValue((r as Record<string, unknown>)[keyField], (row as Record<string, unknown>)[keyField]) &&
            (r as Record<string, unknown>)[self.field] === from,
          { [self.field]: tr.to } as Partial<T>,
        ),
      );
      if (n !== 1) return { ok: false, reason: "changed meanwhile" } as MoveResult<T>;
      const count = yield* sub(self.model.as(WRITER).query().where({ key: k }).count());
      const step = (yield* sub(
        self.model.as(WRITER).create({
          id: globalThis.crypto.randomUUID(),
          key: k,
          n: count + 1,
          transition,
          from,
          to: tr.to,
          by: self.#id(scoped.actor),
          at: self.#now(),
          note,
        }),
      ))!;
      const now = (yield* sub(scoped.get(key as never)))!;
      return { ok: true, row: now, step } as MoveResult<T>;
    });
  }

  available(scoped: ScopedModel<T, any>, key: Key): Out<string[]> {
    this.#handle(scoped);
    keyText(key);
    return andThen(scoped.get(key as never), (row) =>
      row === undefined ? [] : [...this.#t.keys()].filter((name) => this.#may(scoped, row, name) === null),
    ) as Out<string[]>;
  }

  steps(scoped: ScopedModel<T, any>, key: Key): Out<StepRow[]> {
    this.#handle(scoped);
    const k = keyText(key);
    return andThen(scoped.get(key as never), (row) =>
      row === undefined ? [] : (this.model.as(WRITER).query().where({ key: k }).orderBy("n").all() as StepRow[] | Promise<StepRow[]>),
    ) as Out<StepRow[]>;
  }
}

export function defineWorkflow<T>(model: Model<T, any>, options: WorkflowOptions<T>): Workflow<T> {
  return new Workflow(model, options);
}
