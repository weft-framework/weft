import { compareValues, parseFilter, type Filter, type FilterNode } from "./filter.ts";
import type { Model, ScopedModel } from "./model.ts";

export interface Order {
  field: string;
  desc: boolean;
}

export interface DriverQuery {
  where: FilterNode[];
  order: Order[];
  limit?: number;
  offset: number;
}

export interface QueryPlan {
  where: FilterNode[];
  preds: ((row: unknown) => boolean)[];
  order: Order[];
  limit?: number;
  offset: number;
}

type AnyModel = Model<any, any>;

type Relation =
  | { kind: "one"; name: string; model: AnyModel; on: string }
  | { kind: "many"; name: string; model: AnyModel; by: string; sub: Query<any, any, any, any> | null };

type Simplify<T> = { [P in keyof T]: T[P] } & {};

export type Selected<T, K extends keyof T, X> = Simplify<Pick<T, K> & X>;

const EMPTY: QueryPlan = { where: [], preds: [], order: [], offset: 0 };

const IN_BATCH = 500;

function keyId(v: unknown): unknown {
  if (v instanceof Date) return `d:${v.getTime()}`;
  if (typeof v === "object" && v !== null) return `j:${JSON.stringify(v)}`;
  return v;
}

function distinct(values: unknown[]): unknown[] {
  const seen = new Map<unknown, unknown>();
  for (const v of values) {
    if (v !== null && v !== undefined && !seen.has(keyId(v))) seen.set(keyId(v), v);
  }
  return [...seen.values()];
}

export function sortRows<T>(rows: T[], order: readonly Order[]): T[] {
  if (order.length === 0) return rows;
  return rows.sort((a, b) => {
    for (const o of order) {
      const c = compareValues((a as Record<string, unknown>)[o.field], (b as Record<string, unknown>)[o.field]);
      if (c !== 0) return o.desc ? -c : c;
    }
    return 0;
  });
}

export class Query<T, D extends keyof T = never, K extends keyof T = keyof T, X = {}> {
  private readonly scoped: ScopedModel<T, D>;
  readonly plan: QueryPlan;
  private readonly pick: readonly string[] | null;
  private readonly rels: readonly Relation[];

  constructor(scoped: ScopedModel<T, D>, plan: QueryPlan = EMPTY, pick: readonly string[] | null = null, rels: readonly Relation[] = []) {
    this.scoped = scoped;
    this.plan = plan;
    this.pick = pick;
    this.rels = rels;
  }

  get model(): Model<T, D> {
    return this.scoped.model;
  }

  private next<K2 extends keyof T = K, X2 = X>(
    plan: Partial<QueryPlan>,
    pick: readonly string[] | null = this.pick,
    rels: readonly Relation[] = this.rels,
  ): Query<T, D, K2, X2> {
    return new Query<T, D, K2, X2>(this.scoped, { ...this.plan, ...plan }, pick, rels);
  }

  private field(name: string, what: string): void {
    if (!this.model.fields.some((f) => f.name === name)) {
      throw new Error(`${this.model.name}: no field \`${name}\` to ${what}`);
    }
  }

  where(filter: Filter<T>): Query<T, D, K, X> {
    const fields = new Set(this.model.fields.map((f) => f.name));
    return this.next({ where: [...this.plan.where, ...parseFilter(filter, fields, this.model.name)] });
  }

  filter(pred: (row: T) => boolean): Query<T, D, K, X> {
    return this.next({ preds: [...this.plan.preds, pred as (row: unknown) => boolean] });
  }

  orderBy(field: keyof T & string, dir: "asc" | "desc" = "asc"): Query<T, D, K, X> {
    this.field(field, "order by");
    if (this.model.fields.find((f) => f.name === field)!.kind === "json") {
      throw new Error(`${this.model.name}: cannot order by JSON field \`${field}\``);
    }
    if (dir !== "asc" && dir !== "desc") {
      throw new Error(`${this.model.name}: order is "asc" or "desc"`);
    }
    return this.next({ order: [...this.plan.order, { field, desc: dir === "desc" }] });
  }

  limit(n: number): Query<T, D, K, X> {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${this.model.name}: limit is a non-negative integer`);
    return this.next({ limit: n });
  }

  offset(n: number): Query<T, D, K, X> {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${this.model.name}: offset is a non-negative integer`);
    return this.next({ offset: n });
  }

  select<P extends K>(...fields: P[]): Query<T, D, P, X> {
    if (fields.length === 0) throw new Error(`${this.model.name}: select at least one field`);
    for (const f of fields) this.field(String(f), "select");
    return this.next<P, X>({}, fields.map(String));
  }

  private relName(name: string): void {
    if (this.model.fields.some((f) => f.name === name) || this.rels.some((r) => r.name === name)) {
      throw new Error(`${this.model.name}: relation name \`${name}\` is already taken`);
    }
  }

  with<N extends string, U>(name: N, model: Model<U, any>, on: keyof T & string): Query<T, D, K, X & { [P in N]: U | null }> {
    this.relName(name);
    this.field(on, "relate on");
    return this.next<K, X & { [P in N]: U | null }>({}, this.pick, [...this.rels, { kind: "one", name, model, on }]);
  }

  withMany<N extends string, U, KU extends keyof U = keyof U, XU = {}>(
    name: N,
    model: Model<U, any>,
    by: keyof U & string,
    shape?: (q: Query<U, any>) => Query<U, any, KU, XU>,
  ): Query<T, D, K, X & { [P in N]: Selected<U, KU, XU>[] }> {
    this.relName(name);
    if (!model.fields.some((f) => f.name === by)) {
      throw new Error(`${model.name}: no field \`${by}\` to relate by`);
    }
    const sub = shape ? (shape(model.as(this.scoped.actor).query()) as Query<any, any, any, any>) : null;
    return this.next<K, X & { [P in N]: Selected<U, KU, XU>[] }>({}, this.pick, [...this.rels, { kind: "many", name, model, by, sub }]);
  }

  rows(write = false, plan: QueryPlan = this.plan): T[] {
    return this.scoped.selectPlan(plan, write);
  }

  decorate(rows: T[]): Selected<T, K, X>[] {
    const extra = rows.map(() => ({}) as Record<string, unknown>);
    for (const rel of this.rels) {
      if (rel.kind === "one") {
        this.attachOne(rel, rows, extra);
      } else {
        this.attachMany(rel, rows, extra);
      }
    }
    return rows.map((row, i) => {
      const r = row as Record<string, unknown>;
      const out: Record<string, unknown> = this.scoped.handOut({}, this.scoped.keyOf(row));
      if (this.pick) {
        for (const f of this.pick) if (Object.hasOwn(r, f)) out[f] = r[f];
      } else {
        Object.assign(out, r);
      }
      return Object.assign(out, extra[i]) as Selected<T, K, X>;
    });
  }

  private attachOne(rel: Extract<Relation, { kind: "one" }>, rows: T[], extra: Record<string, unknown>[]): void {
    const keys = distinct(rows.map((r) => (r as Record<string, unknown>)[rel.on]));
    const handle = rel.model.as(this.scoped.actor);
    const found = new Map<unknown, unknown>();
    for (let i = 0; i < keys.length; i += IN_BATCH) {
      const batch = keys.slice(i, i + IN_BATCH);
      for (const target of handle.query().where({ [rel.model.key]: { in: batch } }).rows()) {
        found.set(keyId((target as Record<string, unknown>)[rel.model.key]), target);
      }
    }
    rows.forEach((r, i) => {
      const v = (r as Record<string, unknown>)[rel.on];
      const t = v === null || v === undefined ? undefined : found.get(keyId(v));
      extra[i][rel.name] = t === undefined ? null : handle.handOut(structuredClone(t), v);
    });
  }

  private attachMany(rel: Extract<Relation, { kind: "many" }>, rows: T[], extra: Record<string, unknown>[]): void {
    const own = this.model.key;
    const keys = distinct(rows.map((r) => (r as Record<string, unknown>)[own]));
    const sub = rel.sub ?? rel.model.as(this.scoped.actor).query();
    const groups = new Map<unknown, unknown[]>();
    for (let i = 0; i < keys.length; i += IN_BATCH) {
      const batch = keys.slice(i, i + IN_BATCH);
      const plan: QueryPlan = {
        ...sub.plan,
        where: [...sub.plan.where, { field: rel.by, op: "in", value: batch }],
        limit: undefined,
        offset: 0,
      };
      for (const child of sub.rows(false, plan)) {
        const id = keyId((child as Record<string, unknown>)[rel.by]);
        let g = groups.get(id);
        if (!g) groups.set(id, (g = []));
        g.push(child);
      }
    }
    const { offset, limit } = sub.plan;
    const lists = rows.map((r) => {
      const all = groups.get(keyId((r as Record<string, unknown>)[own])) ?? [];
      return all.slice(offset, limit === undefined ? undefined : offset + limit);
    });
    const flat = sub.decorate(lists.flat() as never[]) as unknown[];
    let at = 0;
    rows.forEach((_r, i) => {
      const n = lists[i].length;
      extra[i][rel.name] = flat.slice(at, at + n).map((c) => structuredClone(c));
      at += n;
    });
  }

  all(): Selected<T, K, X>[] {
    return this.decorate(this.rows());
  }

  first(): Selected<T, K, X> | undefined {
    const n = this.plan.limit === undefined ? 1 : Math.min(1, this.plan.limit);
    return this.decorate(this.rows(false, { ...this.plan, limit: n }))[0];
  }

  count(): number {
    return this.rows().length;
  }

  exists(): boolean {
    return this.first() !== undefined;
  }

  update(patch: Partial<T>): number {
    return this.scoped.updateRows(this.scoped.forWrite("update", (w) => this.rows(w)), patch);
  }

  delete(): number {
    return this.scoped.deleteRows(this.scoped.forWrite("delete", (w) => this.rows(w)));
  }
}
