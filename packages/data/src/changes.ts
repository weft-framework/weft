import type { Actor, Model } from "./model.ts";

export type ChangeOp = "create" | "update" | "delete";

export interface Change<T = unknown> {
  model: string;
  op: ChangeOp;
  key: unknown;
  before?: T;
  after?: T;
  regions?: string[];
  redacted?: true;
}

export type ChangeListener = (change: Change) => void;

function report(err: unknown): void {
  const g = globalThis as { reportError?(e: unknown): void };
  if (typeof g.reportError === "function") {
    g.reportError(err);
  } else {
    console.error("[weft/data]", err);
  }
}

export class ChangeFeed {
  private readonly listeners = new Set<ChangeListener>();

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(change: Change): void {
    for (const l of [...this.listeners]) {
      try {
        l(change);
      } catch (err) {
        report(err);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }

  private readonly gapListeners = new Set<() => void>();

  onGap(listener: () => void): () => void {
    this.gapListeners.add(listener);
    return () => {
      this.gapListeners.delete(listener);
    };
  }

  gap(): void {
    for (const l of [...this.gapListeners]) {
      try {
        l();
      } catch (err) {
        report(err);
      }
    }
  }
}

export const changes = new ChangeFeed();

export const UNSCOPED: unique symbol = Symbol("weft.unscoped");

export type ReadObserver = (model: Model<unknown>, actor: Actor | typeof UNSCOPED, key?: unknown) => void;

const observers = new Set<ReadObserver>();

export function onRead(observer: ReadObserver): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

export function noteRead(model: Model<unknown>, actor: Actor | typeof UNSCOPED, key?: unknown): void {
  for (const o of observers) {
    try {
      if (key === undefined) o(model, actor);
      else o(model, actor, key);
    } catch (err) {
      report(err);
    }
  }
}

export interface ReadDone {
  model: string;
  rows: number;
  ms: number;
  scoped: boolean;
}

const doneObservers = new Set<(r: ReadDone) => void>();

export function onReadDone(observer: (r: ReadDone) => void): () => void {
  doneObservers.add(observer);
  return () => {
    doneObservers.delete(observer);
  };
}

export function timingReads(): boolean {
  return doneObservers.size > 0;
}

export function noteReadDone(r: ReadDone): void {
  for (const o of doneObservers) {
    try {
      o(r);
    } catch (err) {
      report(err);
    }
  }
}

export function canSee(model: Model<unknown>, actor: Actor | typeof UNSCOPED, change: Change): boolean {
  if (actor === UNSCOPED || change.redacted === true) {
    return true;
  }
  const read = model.config.read;
  if (!read) {
    return false;
  }
  const sees = (row: unknown) => {
    if (row === undefined) {
      return false;
    }
    try {
      return model.inTenant(actor, row) && read(actor, row) === true;
    } catch {
      return false;
    }
  };
  return sees(change.before) || sees(change.after);
}
