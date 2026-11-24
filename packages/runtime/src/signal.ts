export interface Signal<T> {
  value: T;
}

export interface Derived<T> {
  readonly value: T;
}

type Computation = () => void;

let activeComputation: Computation | null = null;

let collected: Signal<unknown>[] | null = null;

export function collectSignals<T>(fn: () => T): { value: T; signals: Signal<unknown>[] } {
  const prev = collected;
  const mine: Signal<unknown>[] = [];
  collected = mine;
  try {
    return { value: fn(), signals: mine };
  } finally {
    collected = prev;
  }
}

export function signal<T>(initial: T): Signal<T> {
  const s = cell(initial);
  collected?.push(s as Signal<unknown>);
  return s;
}

export function cell<T>(initial: T): Signal<T> {
  let current = initial;
  const subscribers = new Set<Computation>();

  return {
    get value(): T {
      if (activeComputation) {
        subscribers.add(activeComputation);
      }
      return current;
    },
    set value(next: T) {
      if (Object.is(next, current)) {
        return;
      }
      current = next;
      for (const run of [...subscribers]) {
        if (disposed.has(run)) {
          subscribers.delete(run);
        } else {
          run();
        }
      }
    },
  };
}

const disposed = new WeakSet<Computation>();

export function effect(fn: () => void): () => void {
  const run: Computation = () => {
    if (disposed.has(run)) {
      return;
    }
    const previous = activeComputation;
    activeComputation = run;
    try {
      fn();
    } finally {
      activeComputation = previous;
    }
  };
  run();
  return () => {
    disposed.add(run);
  };
}

export function untrack<T>(fn: () => T): T {
  const previous = activeComputation;
  activeComputation = null;
  try {
    return fn();
  } finally {
    activeComputation = previous;
  }
}

export function derived<T>(compute: () => T): Derived<T> {
  const store = cell<T>(undefined as unknown as T);
  effect(() => {
    store.value = compute();
  });
  return {
    get value(): T {
      return store.value;
    },
  };
}
