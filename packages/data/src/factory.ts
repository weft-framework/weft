import type { Creatable, Model } from "./model.ts";

export interface Factory<T, D extends keyof T = never> {
  readonly model: Model<T, D>;
  build(overrides?: Partial<T>): Creatable<T, D>;
  buildMany(count: number, overrides?: Partial<T>): Creatable<T, D>[];
  create(actor: unknown, overrides?: Partial<T>): T;
  createMany(actor: unknown, count: number, overrides?: Partial<T>): T[];
  reset(): void;
}

const MAX_MANY = 100_000;

export function defineFactory<T, D extends keyof T = never>(
  model: Model<T, D>,
  build: (n: number, overrides: Partial<T>) => Creatable<T, D>,
): Factory<T, D> {
  if (!model || typeof model.as !== "function") throw new Error("defineFactory: needs a model");
  if (typeof build !== "function") throw new Error(`defineFactory(${model.name}): needs a builder (n, overrides) => fields`);
  let n = 0;
  const count = (k: number) => {
    if (!Number.isInteger(k) || k < 0 || k > MAX_MANY) throw new RangeError(`${model.name} factory: count is 0 to ${MAX_MANY}`);
    return k;
  };
  const one = (overrides: Partial<T> = {}): Creatable<T, D> => {
    if (!overrides || typeof overrides !== "object") throw new TypeError(`${model.name} factory: overrides are an object`);
    const built = build(++n, overrides);
    if (!built || typeof built !== "object") throw new TypeError(`${model.name} factory: the builder returns the row's fields`);
    return { ...built, ...overrides } as Creatable<T, D>;
  };
  const store = (actor: unknown, overrides?: Partial<T>): T => {
    const row = model.as(actor as never).create(one(overrides));
    if (row === undefined) throw new Error(`${model.name} factory: the write rule refused the row for this actor`);
    return row;
  };
  return Object.freeze({
    model,
    build: one,
    buildMany: (k: number, overrides?: Partial<T>) => Array.from({ length: count(k) }, () => one(overrides)),
    create: store,
    createMany: (actor: unknown, k: number, overrides?: Partial<T>) => Array.from({ length: count(k) }, () => store(actor, overrides)),
    reset: () => void (n = 0),
  });
}
