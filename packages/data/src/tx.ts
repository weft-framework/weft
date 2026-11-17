import type { SqlDatabase } from "./sql.ts";

interface Frame {
  snaps: Map<object, () => void>;
  savepoints: Map<SqlDatabase, string>;
  after: (() => void)[];
}

const frames: Frame[] = [];
const begun: SqlDatabase[] = [];
let idle: (() => void)[] = [];
let seq = 0;

export function whenIdle(fn: () => void): void {
  if (frames.length === 0) fn();
  else idle.push(fn);
}

function flushIdle(): void {
  const list = idle;
  idle = [];
  for (const fn of list) {
    try {
      fn();
    } catch (err) {
      const g = globalThis as { reportError?(e: unknown): void };
      if (typeof g.reportError === "function") g.reportError(err);
      else console.error("[weft/data]", err);
    }
  }
}

export function inTransaction(): boolean {
  return frames.length > 0;
}

export function enlist(db: SqlDatabase): void {
  if (frames.length === 0) return;
  if (!begun.includes(db)) {
    db.exec("BEGIN IMMEDIATE");
    begun.push(db);
  }
  for (let i = 1; i < frames.length; i++) {
    if (!frames[i].savepoints.has(db)) {
      const name = `weft_sp_${++seq}`;
      db.exec(`SAVEPOINT ${name}`);
      frames[i].savepoints.set(db, name);
    }
  }
}

export function snapshot(store: object, save: () => () => void): void {
  const top = frames[frames.length - 1];
  if (top && !top.snaps.has(store)) top.snaps.set(store, save());
}

export function afterCommit(fn: () => void): void {
  const top = frames[frames.length - 1];
  if (top) top.after.push(fn);
  else fn();
}

function undo(frame: Frame, root: boolean): void {
  let failure: unknown;
  const attempt = (f: () => void) => {
    try {
      f();
    } catch (e) {
      failure ??= e;
    }
  };
  if (root) {
    for (const db of begun.splice(0)) attempt(() => db.exec("ROLLBACK"));
  } else {
    for (const [db, name] of frame.savepoints) {
      attempt(() => db.exec(`ROLLBACK TO ${name}`));
      attempt(() => db.exec(`RELEASE ${name}`));
    }
  }
  for (const restore of frame.snaps.values()) attempt(restore);
  if (failure !== undefined) throw failure;
}

export function transaction<R>(fn: () => R): R {
  const frame: Frame = { snaps: new Map(), savepoints: new Map(), after: [] };
  frames.push(frame);
  const root = frames.length === 1;
  let result: R;
  try {
    result = fn();
    if (typeof (result as { then?: unknown } | null)?.then === "function") {
      throw new Error("transaction: the function returned a promise; transactions are synchronous");
    }
  } catch (err) {
    try {
      undo(frame, root);
    } finally {
      frames.pop();
      if (root) flushIdle();
    }
    throw err;
  }
  frames.pop();
  if (!root) {
    const parent = frames[frames.length - 1];
    for (const [db, name] of frame.savepoints) db.exec(`RELEASE ${name}`);
    for (const [store, restore] of frame.snaps) if (!parent.snaps.has(store)) parent.snaps.set(store, restore);
    parent.after.push(...frame.after);
    return result;
  }
  try {
    while (begun.length) {
      begun[0].exec("COMMIT");
      begun.shift();
    }
  } catch (err) {
    try {
      undo(frame, true);
    } finally {
      flushIdle();
    }
    throw err;
  }
  for (const f of frame.after) f();
  flushIdle();
  return result;
}
