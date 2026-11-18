import type { Register } from "./model.ts";

/** A value now, or later. */
export type Maybe<R> = R | Promise<R>;

/** Terminal result type: `Promise<R>` for apps that declare `Register { async: true }`. */
export type Out<R> = Register extends { async: true } ? Promise<R> : R;

export type Flow<R> = Generator<unknown, R, unknown>;

export function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function";
}

export function* wait<V>(v: Maybe<V>): Generator<unknown, V, unknown> {
  return (yield v) as V;
}

export function flow<R>(gen: Flow<R>): Maybe<R> {
  let step = gen.next();
  for (;;) {
    if (step.done) return step.value;
    const v = step.value;
    if (isThenable(v)) return finish(gen, v);
    step = gen.next(v);
  }
}

async function finish<R>(gen: Flow<R>, first: PromiseLike<unknown>): Promise<R> {
  let pending: unknown = first;
  for (;;) {
    let value: unknown;
    let failed = false;
    try {
      value = await pending;
    } catch (err) {
      failed = true;
      value = err;
    }
    const step = failed ? gen.throw(value) : gen.next(value);
    if (step.done) return step.value;
    pending = step.value;
  }
}

export function out<R>(gen: Flow<R>): Out<R> {
  return flow(gen) as Out<R>;
}

export function andThen<V, R>(v: Maybe<V>, f: (value: V) => Maybe<R>): Maybe<R> {
  return isThenable(v) ? (v as Promise<V>).then(f) : f(v as V);
}

export function* sub<R>(v: Out<R> | Maybe<R>): Generator<unknown, R, unknown> {
  return (yield v) as R;
}
