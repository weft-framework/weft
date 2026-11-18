import { AsyncLocalStorage } from "node:async_hooks";
import type { SqlDatabase } from "./sql.ts";
import { flow, type Flow, type Out } from "./flow.ts";

export interface TxClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
  release(err?: unknown): void;
}

export interface TxPool {
  connect(): Promise<TxClient>;
}

interface Frame {
  snaps: Map<object, () => void>;
  savepoints: Map<SqlDatabase, string>;
  poolSavepoints: Map<TxPool, string>;
  after: (() => void)[];
}

interface Ctx {
  frames: Frame[];
  begun: SqlDatabase[];
  idle: (() => void)[];
  async: boolean;
  clients: Map<TxPool, TxClient>;
  lock: Promise<unknown>;
}

const als = new AsyncLocalStorage<Ctx>();
const syncRoot: Ctx = { frames: [], begun: [], idle: [], async: false, clients: new Map(), lock: Promise.resolve() };
let seq = 0;

function ctx(): Ctx {
  return als.getStore() ?? syncRoot;
}

function newFrame(): Frame {
  return { snaps: new Map(), savepoints: new Map(), poolSavepoints: new Map(), after: [] };
}

function report(err: unknown): void {
  const g = globalThis as { reportError?(e: unknown): void };
  if (typeof g.reportError === "function") g.reportError(err);
  else console.error("[weft/data]", err);
}

function quietly(f: () => void): void {
  try {
    f();
  } catch (e) {
    report(e);
  }
}

export function whenIdle(fn: () => void): void {
  const c = ctx();
  if (c.frames.length === 0) fn();
  else c.idle.push(fn);
}

function flushIdle(c: Ctx): void {
  const list = c.idle;
  c.idle = [];
  for (const fn of list) quietly(fn);
}

export function inTransaction(): boolean {
  return ctx().frames.length > 0;
}

export function enlist(db: SqlDatabase): void {
  const c = ctx();
  if (c.frames.length === 0) return;
  if (c.async) {
    throw new Error("asyncTransaction: a synchronous database (SQLite) cannot join an async transaction; use transaction()");
  }
  if (!c.begun.includes(db)) {
    db.exec("BEGIN IMMEDIATE");
    c.begun.push(db);
  }
  for (let i = 1; i < c.frames.length; i++) {
    if (!c.frames[i].savepoints.has(db)) {
      const name = `weft_sp_${++seq}`;
      db.exec(`SAVEPOINT ${name}`);
      c.frames[i].savepoints.set(db, name);
    }
  }
}

export function enlistAsync(pool: TxPool): Promise<TxClient> | null {
  const c = ctx();
  if (c.frames.length === 0) return null;
  if (!c.async) {
    throw new Error("transaction: an async database (Postgres) cannot join a synchronous transaction; use await asyncTransaction()");
  }
  const depth = c.frames.length;
  const run = async (): Promise<TxClient> => {
    let client = c.clients.get(pool);
    if (!client) {
      client = await pool.connect();
      try {
        await client.query("BEGIN");
      } catch (err) {
        client.release(err);
        throw err;
      }
      c.clients.set(pool, client);
    }
    for (let i = 1; i < depth; i++) {
      if (!c.frames[i].poolSavepoints.has(pool)) {
        const name = `weft_sp_${++seq}`;
        await client.query(`SAVEPOINT ${name}`);
        c.frames[i].poolSavepoints.set(pool, name);
      }
    }
    return client;
  };
  const next = c.lock.then(run, run);
  c.lock = next.catch(() => undefined);
  return next;
}

export function snapshot(store: object, save: () => () => void): void {
  const frames = ctx().frames;
  const top = frames[frames.length - 1];
  if (top && !top.snaps.has(store)) top.snaps.set(store, save());
}

export function afterCommit(fn: () => void): void {
  const frames = ctx().frames;
  const top = frames[frames.length - 1];
  if (top) top.after.push(fn);
  else fn();
}

function undo(c: Ctx, frame: Frame, root: boolean): void {
  let failure: unknown;
  const attempt = (f: () => void) => {
    try {
      f();
    } catch (e) {
      failure ??= e;
    }
  };
  if (root) {
    for (const db of c.begun.splice(0)) attempt(() => db.exec("ROLLBACK"));
  } else {
    for (const [db, name] of frame.savepoints) {
      attempt(() => db.exec(`ROLLBACK TO ${name}`));
      attempt(() => db.exec(`RELEASE ${name}`));
    }
  }
  for (const restore of frame.snaps.values()) attempt(restore);
  if (failure !== undefined) throw failure;
}

function mergeIntoParent(c: Ctx, frame: Frame): void {
  const parent = c.frames[c.frames.length - 1];
  for (const [store, restore] of frame.snaps) if (!parent.snaps.has(store)) parent.snaps.set(store, restore);
  parent.after.push(...frame.after);
}

export function atomic<R>(async: boolean, make: () => Flow<R>): Out<R> {
  if (!async) return transaction(() => flow(make()) as R) as Out<R>;
  return asyncTransaction(() => flow(make())) as Out<R>;
}

export function transaction<R>(fn: () => R): R {
  const c = ctx();
  const frame = newFrame();
  c.frames.push(frame);
  const root = c.frames.length === 1;
  let result: R;
  try {
    result = fn();
    if (typeof (result as { then?: unknown } | null)?.then === "function") {
      throw new Error("transaction: the function returned a promise; transactions are synchronous (use asyncTransaction for async databases)");
    }
  } catch (err) {
    try {
      undo(c, frame, root);
    } finally {
      c.frames.pop();
      if (root) flushIdle(c);
    }
    throw err;
  }
  c.frames.pop();
  if (!root) {
    for (const [db, name] of frame.savepoints) db.exec(`RELEASE ${name}`);
    mergeIntoParent(c, frame);
    return result;
  }
  try {
    while (c.begun.length) {
      c.begun[0].exec("COMMIT");
      c.begun.shift();
    }
  } catch (err) {
    try {
      undo(c, frame, true);
    } finally {
      flushIdle(c);
    }
    throw err;
  }
  for (const f of frame.after) f();
  flushIdle(c);
  return result;
}

async function finishClients(c: Ctx, verb: "COMMIT" | "ROLLBACK"): Promise<void> {
  let failure: unknown;
  for (const [pool, client] of [...c.clients]) {
    c.clients.delete(pool);
    try {
      await client.query(failure === undefined ? verb : "ROLLBACK");
      client.release();
    } catch (err) {
      failure ??= err;
      client.release(err);
    }
  }
  if (failure !== undefined) throw failure;
}

export async function asyncTransaction<R>(fn: () => R | Promise<R>): Promise<R> {
  const outer = ctx();
  if (outer.frames.length > 0) {
    if (!outer.async) throw new Error("asyncTransaction: cannot start inside a synchronous transaction");
    return nestedAsync(outer, fn);
  }
  const c: Ctx = { frames: [], begun: [], idle: [], async: true, clients: new Map(), lock: Promise.resolve() };
  return als.run(c, async () => {
    const frame = newFrame();
    c.frames.push(frame);
    const abort = async (err: unknown, rollback: boolean): Promise<never> => {
      if (rollback) {
        try {
          await finishClients(c, "ROLLBACK");
        } catch (e) {
          report(e);
        }
      }
      for (const restore of frame.snaps.values()) quietly(restore);
      c.frames.pop();
      flushIdle(c);
      throw err;
    };
    let result: R;
    try {
      result = await fn();
      await c.lock;
    } catch (err) {
      await c.lock.catch(() => undefined);
      return abort(err, true);
    }
    try {
      await finishClients(c, "COMMIT");
    } catch (err) {
      return abort(err, false);
    }
    c.frames.pop();
    for (const f of frame.after) quietly(f);
    flushIdle(c);
    return result;
  });
}

async function nestedAsync<R>(c: Ctx, fn: () => R | Promise<R>): Promise<R> {
  const frame = newFrame();
  c.frames.push(frame);
  const depth = c.frames.length;
  const pop = () => {
    if (c.frames[depth - 1] !== frame || c.frames.length !== depth) {
      throw new Error("asyncTransaction: nested transactions overlapped; await them one at a time");
    }
    c.frames.pop();
  };
  let result: R;
  try {
    result = await fn();
    await c.lock;
  } catch (err) {
    await c.lock.catch(() => undefined);
    for (const [pool, name] of frame.poolSavepoints) {
      const client = c.clients.get(pool);
      if (!client) continue;
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await client.query(`RELEASE SAVEPOINT ${name}`);
      } catch (e) {
        report(e);
      }
    }
    for (const restore of frame.snaps.values()) quietly(restore);
    pop();
    throw err;
  }
  for (const [pool, name] of frame.poolSavepoints) {
    await c.clients.get(pool)?.query(`RELEASE SAVEPOINT ${name}`);
  }
  pop();
  mergeIntoParent(c, frame);
  return result;
}
