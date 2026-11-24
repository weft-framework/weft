import { renderAwaiting } from "./component.ts";
import { cell, effect, untrack } from "./signal.ts";

export interface AsyncDerived<T> {
  readonly value: T | undefined;
  readonly pending: boolean;
  readonly error: unknown;
  refresh(): void;
}

export interface ResourceHost {
  run<R>(fn: () => R): R;
  dispose(): void;
}

export type ResourceHostFactory = (rerun: () => void) => ResourceHost;

let hostFactory: ResourceHostFactory | null = null;

export function withResourceHost<T>(factory: ResourceHostFactory | null, fn: () => T): T {
  const prev = hostFactory;
  hostFactory = factory;
  try {
    return fn();
  } finally {
    hostFactory = prev;
  }
}

interface State<T> {
  value: T | undefined;
  pending: boolean;
  error: unknown;
  settled: boolean;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function";
}

export function asyncDerived<T>(compute: () => PromiseLike<T> | T): AsyncDerived<T> {
  const state = cell<State<T>>({ value: undefined, pending: true, error: undefined, settled: false });
  const tick = cell(0);
  let version = 0;
  let queued = false;
  const settle = (mine: number, ok: boolean, v: unknown) => {
    if (mine !== version) return;
    const was = untrack(() => state.value);
    state.value = ok
      ? { value: v as T, pending: false, error: undefined, settled: true }
      : { value: was.value, pending: false, error: v, settled: true };
  };
  const rerun = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      tick.value = untrack(() => tick.value) + 1;
    });
  };
  const host = hostFactory ? hostFactory(rerun) : null;
  effect(() => {
    void tick.value;
    const mine = ++version;
    let out: PromiseLike<T> | T;
    try {
      out = host ? host.run(compute) : compute();
    } catch (err) {
      untrack(() => settle(mine, false, err));
      return;
    }
    if (!isThenable(out)) {
      untrack(() => settle(mine, true, out));
      return;
    }
    untrack(() => {
      const was = state.value;
      if (!was.pending) state.value = { ...was, pending: true };
    });
    out.then(
      (v) => settle(mine, true, v),
      (e) => settle(mine, false, e),
    );
  });
  const read = (): State<T> => {
    const s = state.value;
    if (!s.settled) renderAwaiting();
    return s;
  };
  return {
    get value() {
      return read().value;
    },
    get pending() {
      return read().pending;
    },
    get error() {
      return read().error;
    },
    refresh: rerun,
  };
}
