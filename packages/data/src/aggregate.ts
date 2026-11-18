import { noteRead } from "./changes.ts";
import type { Change } from "./changes.ts";
import { andThen, out, sub, wait, type Flow, type Out } from "./flow.ts";
import { Model, ScopedModel, type Actor } from "./model.ts";

export interface AggregateOptions<T> {
  by(row: T): string | number | null;
  of(actor: Actor): string | number | null;
  where?(row: T): boolean;
  sum?: readonly (keyof T & string)[];
  groups?: number;
  verify?: boolean;
}

export interface Totals {
  count: number;
  sums: Record<string, number>;
}

export class AggregateError extends Error {}

export class Aggregate<T> {
  readonly model: Model<T, any>;
  readonly #o: AggregateOptions<T>;
  readonly #sum: string[];
  readonly #max: number;
  readonly #verify: boolean;
  readonly #groups = new Map<string, Totals>();
  readonly #off: () => void;
  readonly #offGap: () => void;

  constructor(model: Model<T, any>, o: AggregateOptions<T>) {
    if (!(model instanceof Model)) throw new TypeError("defineAggregate: needs a model");
    if (typeof o?.by !== "function" || typeof o.of !== "function") {
      throw new TypeError("defineAggregate: `by(row)` and `of(actor)` name the group (see aggregate.ts)");
    }
    const numbers = new Set(model.fields.filter((f) => f.kind === "real").map((f) => f.name));
    for (const f of o.sum ?? []) {
      if (!numbers.has(f)) throw new Error(`defineAggregate: ${model.name}.${f} is not a number field`);
      if (model.fieldReads.some(([x]) => x === f)) {
        throw new Error(`defineAggregate: ${model.name}.${f} has its own read rule; a total of it would show the hidden values`);
      }
    }
    const max = o.groups ?? 10_000;
    if (!Number.isInteger(max) || max < 1 || max > 1_000_000) throw new Error("defineAggregate: groups is 1 to 1 000 000");
    this.model = model;
    this.#o = o;
    this.#sum = [...new Set(o.sum ?? [])];
    this.#max = max;
    this.#verify = o.verify ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV !== "production";
    const feed = model.feed;
    this.#off = feed.subscribe((c) => {
      if (c.model === model.name) this.#apply(c as Change<T>);
    });
    this.#offGap = feed.onGap(() => {
      this.#seq += 1;
      this.#groups.clear();
    });
  }

  stop(): void {
    this.#off();
    this.#offGap();
    this.#groups.clear();
  }

  count(scoped: ScopedModel<T, any>): Out<number> {
    return andThen(this.totals(scoped) as Totals | Promise<Totals>, (t) => t.count) as Out<number>;
  }

  sum(scoped: ScopedModel<T, any>, field: keyof T & string): Out<number> {
    if (!this.#sum.includes(field)) throw new AggregateError(`${this.model.name}: \`${field}\` is not in this aggregate's sum`);
    return andThen(this.totals(scoped) as Totals | Promise<Totals>, (t) => t.sums[field]!) as Out<number>;
  }

  totals(scoped: ScopedModel<T, any>): Out<Totals> {
    if (!(scoped instanceof ScopedModel) || scoped.model !== this.model || scoped.trashed) {
      throw new TypeError(`aggregate of ${this.model.name}: pass ${this.model.name}.as(actor)`);
    }
    noteRead(this.model as Model<unknown>, scoped.actor);
    return out(this.#totalsG(scoped));
  }

  *#totalsG(scoped: ScopedModel<T, any>): Flow<Totals> {
    const g = this.#o.of(scoped.actor);
    const found = g === null || g === undefined ? this.#empty() : yield* this.#group(String(g));
    const copy = { count: found.count, sums: { ...found.sums } };
    if (this.#verify) yield* this.#check(scoped, copy);
    return copy;
  }

  #empty(): Totals {
    return { count: 0, sums: Object.fromEntries(this.#sum.map((f) => [f, 0])) };
  }

  #counts(row: T): boolean {
    return this.#o.where ? this.#o.where(row) === true : true;
  }

  #groupOf(row: T): string | null {
    const g = this.#o.by(row);
    return g === null || g === undefined ? null : String(g);
  }

  #live(row: T): boolean {
    const f = this.model.trashField;
    if (f === null) return true;
    const v = (row as Record<string, unknown>)[f];
    return v === null || v === undefined;
  }

  *#group(g: string): Flow<Totals> {
    let t = this.#groups.get(g);
    if (t) {
      this.#groups.delete(g);
      this.#groups.set(g, t);
      return t;
    }
    t = this.#empty();
    const seen = this.#seq;
    const rows = yield* wait(this.model.driver.select([]));
    for (const row of rows) {
      if (this.#live(row) && this.#groupOf(row) === g && this.#counts(row)) this.#add(t, row, 1);
    }
    // On an async driver changes may land while the rows load; such a snapshot is used once, not kept.
    if (this.#seq !== seen) return t;
    if (this.#groups.size >= this.#max) this.#groups.delete(this.#groups.keys().next().value as string);
    this.#groups.set(g, t);
    return t;
  }

  #add(t: Totals, row: T, sign: 1 | -1): void {
    t.count += sign;
    for (const f of this.#sum) {
      const v = (row as Record<string, unknown>)[f];
      if (typeof v === "number" && Number.isFinite(v)) t.sums[f] = t.sums[f]! + sign * v;
    }
  }

  #seq = 0;

  #apply(c: Change<T>): void {
    this.#seq += 1;
    if (this.#groups.size === 0) return;
    const side = (row: T | undefined) => (row !== undefined && this.#live(row) && this.#counts(row) ? this.#groupOf(row) : null);
    if ((c.op !== "create" && c.before === undefined) || (c.op !== "delete" && c.after === undefined)) {
      this.#groups.clear();
      return;
    }
    const was = side(c.before);
    const now = side(c.after);
    if (was !== null) {
      const t = this.#groups.get(was);
      if (t) this.#add(t, c.before!, -1);
    }
    if (now !== null) {
      const t = this.#groups.get(now);
      if (t) this.#add(t, c.after!, 1);
    }
  }

  *#check(scoped: ScopedModel<T, any>, got: Totals): Flow<void> {
    const want = this.#empty();
    const g = this.#o.of(scoped.actor);
    for (const row of yield* sub(scoped.all())) {
      if (!this.#counts(row)) continue;
      if (g === null || g === undefined || this.#groupOf(row) !== String(g)) {
        throw new AggregateError(
          `${this.model.name} aggregate: the actor may read a row outside the group of(actor) names; by/of do not match the read rule`,
        );
      }
      this.#add(want, row, 1);
    }
    const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    if (want.count !== got.count || this.#sum.some((f) => !near(want.sums[f]!, got.sums[f]!))) {
      throw new AggregateError(
        `${this.model.name} aggregate: ${got.count} counted in the group, ${want.count} readable; ` +
          "the actor may not read every row of the group of(actor) names, or a write bypassed the change feed",
      );
    }
  }
}

export function defineAggregate<T>(model: Model<T, any>, options: AggregateOptions<T>): Aggregate<T> {
  return new Aggregate<T>(model, options);
}
