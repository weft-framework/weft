import { auditing, auditingReads, record, setVia, type AuditAction } from "./audit.ts";
import { changes, noteRead, noteReadDone, timingReads, UNSCOPED, type ChangeFeed, type ChangeOp } from "./changes.ts";
import { matches, sameValue, type FilterNode } from "./filter.ts";
import { actorValue, type PolicyExpr } from "./policy.ts";
import { Query, sortRows, type DriverQuery, type QueryPlan } from "./query.ts";
import { afterCommit, snapshot } from "./tx.ts";
import { holdsFile, releaseFiles, takeFile } from "./files.ts";
import { tagRow } from "./can.ts";
import { consentRule, watchConsent } from "./consent.ts";
import { fieldSpecs, type FieldAttrs, type FieldSpec } from "./schema.ts";
import { isThenable, out, wait, type Flow, type Maybe, type Out } from "./flow.ts";

export interface Register {}

export type Actor = Register extends { actor: infer A } ? A : any;

export type Policy<T> = (actor: Actor, row: T) => boolean;

export interface ModelConfig<T> {
  fields: Record<string, string>;
  key?: string;
  attrs?: Record<string, FieldAttrs>;
  read?: Policy<T>;
  write?: Policy<T>;
  readWhere?: PolicyExpr;
  writeWhere?: PolicyExpr;
  residency?: string | ((row: T) => string | null | undefined);
  /**
   * Keep an in-memory replica when the model is on an async database (Postgres), so
   * `Model.as(actor).local` reads stay synchronous. For small, hot models read by policies
   * (access data). `usePostgres` sets it up.
   */
  replica?: boolean;
}

export interface Grant {
  model: string;
  key: string | number;
  rights: "read" | "write";
  expires?: number;
}

export interface Scope {
  where: PolicyExpr;
  actor: Actor;
}

export interface Driver<T> {
  select(scopes: Scope[], key?: unknown): T[];
  insert(row: T): void;
  update(key: unknown, row: T): void;
  delete(key: unknown): void;
  query?(scopes: Scope[], q: DriverQuery): T[];
}

/** A driver whose I/O is asynchronous (Postgres). See docs/design/async-data.md. */
export interface AsyncDriver<T> {
  readonly async: true;
  select(scopes: Scope[], key?: unknown): Promise<T[]>;
  insert(row: T): Promise<void>;
  update(key: unknown, row: T): Promise<void>;
  delete(key: unknown): Promise<void>;
  query?(scopes: Scope[], q: DriverQuery): Promise<T[]>;
  /** Optional synchronous read path over an in-process replica (`Model.as(a).local`). */
  readonly local?: Driver<T>;
}

export type AnyDriver<T> = Driver<T> | AsyncDriver<T>;

/** The operations every driver offers, with maybe-async results (used inside flows). */
interface FlowDriver<T> {
  select(scopes: Scope[], key?: unknown): Maybe<T[]>;
  insert(row: T): Maybe<void>;
  update(key: unknown, row: T): Maybe<void>;
  delete(key: unknown): Maybe<void>;
  query?(scopes: Scope[], q: DriverQuery): Maybe<T[]>;
}

export function isAsyncDriver<T>(d: AnyDriver<T>): d is AsyncDriver<T> {
  return (d as { async?: unknown }).async === true;
}

export function tenantOf(actor: unknown): string | number | undefined {
  const t = actorValue(actor, ["tenant"]);
  return (typeof t === "string" && t !== "") || (typeof t === "number" && Number.isFinite(t)) ? t : undefined;
}

function passes<T>(rule: Policy<T>, actor: Actor, row: T): boolean {
  try {
    return rule(actor, row) === true;
  } catch {
    return false;
  }
}

function copy<T>(row: T): T {
  return structuredClone(row);
}

export class MemoryDriver<T> implements Driver<T> {
  private readonly rows = new Map<unknown, T>();
  private readonly key: string;
  private readonly unique: string[];

  constructor(key = "id", unique: string[] = []) {
    this.key = key;
    this.unique = unique;
  }

  private touch(): void {
    snapshot(this, () => {
      const saved = new Map(this.rows);
      return () => {
        this.rows.clear();
        for (const [k, v] of saved) this.rows.set(k, v);
      };
    });
  }

  private checkUnique(row: T, self: unknown): void {
    const r = row as Record<string, unknown>;
    for (const f of this.unique) {
      const v = r[f];
      if (v === null || v === undefined) continue;
      for (const [k, other] of this.rows) {
        if (k !== self && sameValue((other as Record<string, unknown>)[f], v)) {
          throw new Error(`duplicate value for unique field ${f}`);
        }
      }
    }
  }

  select(_scopes: Scope[], key?: unknown): T[] {
    if (key !== undefined) {
      const row = this.rows.get(key);
      return row === undefined ? [] : [copy(row)];
    }
    return [...this.rows.values()].map(copy);
  }

  insert(row: T): void {
    const k = (row as Record<string, unknown>)[this.key];
    if (this.rows.has(k)) {
      throw new Error(`duplicate key ${String(k)}`);
    }
    this.checkUnique(row, undefined);
    this.touch();
    this.rows.set(k, copy(row));
  }

  update(key: unknown, row: T): void {
    if (this.rows.has(key)) {
      this.checkUnique(row, key);
      this.touch();
      this.rows.set(key, copy(row));
    }
  }

  delete(key: unknown): void {
    this.touch();
    this.rows.delete(key);
  }
}

export type Creatable<T, D extends keyof T = never> = Omit<T, D> & Partial<Pick<T, D>>;

export class ScopedModel<T, D extends keyof T = never> {
  readonly model: Model<T, D>;
  readonly actor: Actor;
  private readonly grants: readonly Grant[];
  readonly trashed: boolean;

  private readonly pinned: Driver<T> | null;
  /** Stored rows seen by this handle on an async driver, so `allows()` (and `can`) stay synchronous. */
  private readonly seen = new Map<unknown, T>();

  constructor(model: Model<T, D>, actor: Actor, grants: readonly Grant[] = [], trashed = false, pinned: Driver<T> | null = null) {
    this.model = model;
    this.actor = actor;
    this.grants = grants;
    this.trashed = trashed;
    this.pinned = pinned;
  }

  /** The driver this handle reads and writes through. */
  get driver(): FlowDriver<T> {
    return this.pinned ?? this.model.driver;
  }

  /** True when terminals of this handle return Promises. */
  get isAsync(): boolean {
    return this.pinned === null && this.model.isAsync;
  }

  /**
   * Synchronous reads over the model's sync driver or its in-process replica (`AsyncDriver.local`).
   * Same rules as every other read; used by code that must not await (row policies, access checks).
   */
  get local(): ScopedModel<T, D> {
    return new ScopedModel<T, D>(this.model, this.actor, this.grants, this.trashed, this.model.syncDriver());
  }

  using(...grants: Grant[]): ScopedModel<T, D> {
    for (const g of grants) {
      if (g.rights !== "read" && g.rights !== "write") throw new Error(`grant rights are "read" or "write"`);
    }
    return new ScopedModel<T, D>(this.model, this.actor, [...this.grants, ...grants], this.trashed, this.pinned);
  }

  trash(): ScopedModel<T, D> {
    if (this.model.trashField === null) throw new Error(`${this.model.name}: no @softDelete field, so no trash`);
    return new ScopedModel<T, D>(this.model, this.actor, this.grants, true, this.pinned);
  }

  private remember(rows: T[]): T[] {
    if (this.isAsync) for (const r of rows) this.seen.set(this.keyOf(r), r);
    return rows;
  }

  private inView(row: T): boolean {
    const f = this.model.trashField;
    if (f === null) return true;
    const v = (row as Record<string, unknown>)[f];
    return this.trashed ? v !== null && v !== undefined : v === null || v === undefined;
  }

  private granted(write: boolean): (string | number)[] {
    const now = Date.now();
    return this.grants
      .filter((g) => g.model === this.model.name && (!write || g.rights === "write") && (g.expires === undefined || g.expires > now))
      .map((g) => g.key);
  }

  private grantCovers(row: T, write: boolean): boolean {
    if (this.grants.length === 0) return false;
    const k = this.keyOf(row);
    return this.granted(write).some((g) => g === k);
  }

  view(row: T): T {
    const rules = this.model.fieldReads;
    if (rules.length === 0) return row;
    let out: Record<string, unknown> | null = null;
    for (const [f, rule] of rules) {
      if (passes(rule, this.actor, row)) continue;
      out ??= { ...(row as Record<string, unknown>) };
      out[f] = null;
    }
    return (out ?? row) as T;
  }

  private plansOnHidden(plan: QueryPlan): boolean {
    if (this.model.fieldReads.length === 0) return false;
    const hidden = new Set(this.model.fieldReads.map(([f]) => f));
    const mentions = (nodes: FilterNode[]): boolean =>
      nodes.some((n) => ("field" in n ? hidden.has(n.field) : "or" in n ? n.or.some(mentions) : mentions(n.not)));
    return plan.order.some((o) => hidden.has(o.field)) || mentions(plan.where);
  }

  private canRead(row: T): boolean {
    if (!this.inView(row)) return false;
    const read = this.model.config.read;
    return (read ? this.model.inTenant(this.actor, row) && passes(read, this.actor, row) : false) || this.grantCovers(row, false);
  }

  writable(row: T): boolean {
    return this.canWrite(row);
  }

  allows(verb: "read" | "write", key: unknown): boolean {
    const sync = this.pinned ?? this.model.syncDriverOrNull();
    const stored = sync
      ? sync.select([], key).find((r) => sameValue(this.keyOf(r), key))
      : [...this.seen.entries()].find(([k]) => sameValue(k, key))?.[1];
    if (stored === undefined || !this.canRead(stored)) return false;
    return verb === "read" || this.canWrite(stored);
  }

  handOut<R>(row: R, key: unknown): R {
    return tagRow(row, this, key);
  }

  private canWrite(row: T): boolean {
    if (typeof this.actor === "object" && this.actor !== null && readOnly.has(this.actor)) return false;
    const write = this.model.config.write;
    return (write ? this.model.inTenant(this.actor, row) && passes(write, this.actor, row) : false) || this.grantCovers(row, true);
  }

  private scopes(write: boolean): Scope[] {
    const c = this.model.config;
    const out: Scope[] = [];
    const widen = (where: PolicyExpr, keys: (string | number)[]): PolicyExpr =>
      keys.length === 0
        ? where
        : { or: [where, ...keys.map((k): PolicyExpr => ({ cmp: "==", l: { field: [this.model.key] }, r: { value: k } }))] };
    const field = this.model.tenant;
    const inTenant = (where: PolicyExpr | undefined): PolicyExpr | undefined => {
      if (field === null) return where;
      const t: PolicyExpr = { cmp: "==", l: { field: [field] }, r: { actor: ["tenant"] } };
      return where ? { and: [t, where] } : t;
    };
    const read = inTenant(c.readWhere);
    if (read) {
      out.push({ where: widen(read, this.granted(false)), actor: this.actor });
    }
    const wrote = write ? inTenant(c.writeWhere) : undefined;
    if (wrote) {
      out.push({ where: widen(wrote, this.granted(true)), actor: this.actor });
    }
    const bin = this.model.trashField;
    if (bin !== null) {
      out.push({ where: { cmp: this.trashed ? "!=" : "==", l: { field: [bin] }, r: { value: null } }, actor: this.actor });
    }
    return out;
  }

  private audit(action: AuditAction, outcome: "allowed" | "denied", keys: unknown[], reason?: string): void {
    record({ model: this.model.name, actor: this.actor, action, outcome, keys, ...(reason ? { reason } : {}) });
  }

  private audited(action: AuditAction, key: unknown): void {
    if (auditing()) afterCommit(() => this.audit(action, "allowed", [key]));
  }

  private ruleMissing(write: boolean): boolean {
    const c = this.model.config;
    if (c.read && (!write || c.write)) return false;
    if (this.granted(write).length > 0) return false;
    if (auditing()) this.audit(write && c.read ? "update" : "read", "denied", [], write && c.read ? "no write rule" : "no read rule");
    return true;
  }

  private readsLogged(rows: T[], started: number | null): T[] {
    if (started !== null) noteReadDone({ model: this.model.name, rows: rows.length, ms: performance.now() - started, scoped: true });
    if (rows.length && auditingReads()) this.audit("read", "allowed", rows.map((r) => this.keyOf(r)));
    return rows;
  }

  private *loadG(write: boolean, key?: unknown): Flow<T[]> {
    if (this.ruleMissing(write)) {
      return [];
    }
    noteRead(this.model as Model<unknown>, this.actor, key);
    const started = timingReads() ? performance.now() : null;
    const stored = yield* wait(this.driver.select(this.scopes(write), key));
    return this.readsLogged(
      this.remember(stored.filter((r) => this.canRead(r) && (!write || this.canWrite(r)))),
      started,
    );
  }

  keyOf(row: T): unknown {
    return (row as Record<string, unknown>)[this.model.key];
  }

  private addedFiles(next: T, prev: T | undefined): string[] {
    const ids: string[] = [];
    for (const f of this.model.fileFields) {
      const v = (next as Record<string, unknown>)[f];
      if (v === null || v === undefined) continue;
      if (prev !== undefined && (prev as Record<string, unknown>)[f] === v) continue;
      if (!holdsFile(v, this.actor) || ids.includes(v as string)) {
        throw new Error(`${this.model.name}.${f}: not a file claimed for this write (uploads.claim)`);
      }
      ids.push(v as string);
    }
    return ids;
  }

  private droppedFiles(prev: T, next: T | undefined): string[] {
    const ids: string[] = [];
    for (const f of this.model.fileFields) {
      const v = (prev as Record<string, unknown>)[f];
      if (typeof v !== "string" || v === "") continue;
      if (next !== undefined && (next as Record<string, unknown>)[f] === v) continue;
      ids.push(v);
    }
    return ids;
  }

  /** Rows a write may touch; with auditing on, refused rows are recorded. */
  *forWriteG(action: "update" | "delete", load: (write: boolean) => Flow<T[]>): Flow<T[]> {
    if (!auditing()) return yield* load(true);
    const readable = yield* load(false);
    const ok: T[] = [];
    const refused: unknown[] = [];
    for (const r of readable) {
      if (this.canWrite(r)) ok.push(r);
      else refused.push(this.keyOf(r));
    }
    if (refused.length) this.audit(action, "denied", refused, this.model.config.write ? "write rule" : "no write rule");
    return ok;
  }

  /** Readable (or writable) rows matching a query plan; policies are pushed into the driver. */
  *selectPlanG(plan: QueryPlan, write: boolean): Flow<T[]> {
    if (this.ruleMissing(write)) {
      return [];
    }
    noteRead(this.model as Model<unknown>, this.actor);
    const started = timingReads() ? performance.now() : null;
    const seen = (r: T) => this.view(r);
    const ok = (r: T) => {
      if (!this.canRead(r) || (write && !this.canWrite(r))) return false;
      const v = seen(r);
      return matches(plan.where, v) && plan.preds.every((p) => p(v));
    };
    const give = (rows: T[]) => (write ? rows : rows.map(seen));
    const end = plan.limit === undefined ? Infinity : plan.offset + plan.limit;
    if (end === 0) {
      return [];
    }
    const driver = this.driver;
    const scopes = this.scopes(write);
    if (!driver.query || this.plansOnHidden(plan)) {
      const rows = this.remember((yield* wait(driver.select(scopes))).filter(ok));
      if (this.model.fieldReads.length === 0) {
        return this.readsLogged(sortRows(rows, plan.order).slice(plan.offset, end), started);
      }
      const views = new Map(rows.map((r) => [seen(r), r] as const));
      const sorted = sortRows([...views.keys()], plan.order).slice(plan.offset, end);
      return this.readsLogged(write ? sorted.map((v) => views.get(v)!) : sorted, started);
    }
    const out: T[] = [];
    let raw = 0;
    let chunk = end === Infinity ? undefined : Math.max(end, 32);
    for (;;) {
      const batch = yield* wait(driver.query(scopes, { where: plan.where, order: plan.order, limit: chunk, offset: raw }));
      for (const r of batch) {
        if (ok(r) && out.push(r) >= end) break;
      }
      if (chunk === undefined || batch.length < chunk || out.length >= end) break;
      raw += batch.length;
      chunk = Math.min(chunk * 2, 4096);
    }
    return this.readsLogged(give(this.remember(out).slice(plan.offset, end)), started);
  }

  /** Synchronous `selectPlanG` (sync drivers and `.local` only). */
  selectPlan(plan: QueryPlan, write: boolean): Out<T[]> {
    return out(this.selectPlanG(plan, write));
  }

  query(): Query<T, D> {
    return new Query<T, D>(this);
  }

  *allG(): Flow<T[]> {
    return (yield* this.loadG(false)).map((r) => this.handOut(this.view(r), this.keyOf(r)));
  }

  all(): Out<T[]> {
    return out(this.allG());
  }

  *getG(key: unknown): Flow<T | undefined> {
    const stored = (yield* this.loadG(false, key))[0];
    const row = stored === undefined ? undefined : this.handOut(this.view(stored), this.keyOf(stored));
    const reachable = this.model.config.read !== undefined || this.granted(false).length > 0;
    if (row === undefined && auditing() && reachable) {
      const any = yield* wait(this.driver.select([], key));
      if (any.some((r) => this.inView(r))) this.audit("read", "denied", [key], "read rule");
    }
    return row;
  }

  get(key: unknown): Out<T | undefined> {
    return out(this.getG(key));
  }

  find(pred: (row: T) => boolean): Out<T | undefined> {
    const self = this;
    return out(
      (function* () {
        return (yield* self.allG()).find(pred);
      })(),
    );
  }

  where(pred: (row: T) => boolean): Out<T[]> {
    const self = this;
    return out(
      (function* () {
        return (yield* self.allG()).filter(pred);
      })(),
    );
  }

  *createG(input: Creatable<T, D>): Flow<T | undefined> {
    const bin = this.model.trashField;
    if (bin !== null && (this.trashed || ((input as Record<string, unknown>)[bin] ?? null) !== null)) {
      throw new Error(`${this.model.name}: rows are created live; \`${bin}\` is set by delete()`);
    }
    for (const [f, lock] of this.model.locks) {
      const v = (input as Record<string, unknown>)[f];
      if (v !== undefined && !sameValue(v, lock.initial)) {
        throw new Error(`${this.model.name}: rows start with \`${f}\` = ${JSON.stringify(lock.initial)}; it is changed by ${lock.owner}`);
      }
    }
    const row = this.model.withDefaults(input);
    if (bin !== null) (row as Record<string, unknown>)[bin] = null;
    for (const [f, lock] of this.model.locks) (row as Record<string, unknown>)[f] = copy(lock.initial);
    const field = this.model.tenant;
    if (field !== null && (row as Record<string, unknown>)[field] === undefined) {
      const t = tenantOf(this.actor);
      if (t !== undefined) (row as Record<string, unknown>)[field] = t;
    }
    const k = this.keyOf(row);
    if (!this.canWrite(row)) {
      if (auditing()) this.audit("create", "denied", k === undefined ? [] : [k], this.model.config.write ? "write rule" : "no write rule");
      return undefined;
    }
    if (k === undefined || k === null) {
      throw new Error(`${this.model.name}: rows need a \`${this.model.key}\``);
    }
    const files = this.addedFiles(row, undefined);
    yield* wait(this.driver.insert(row));
    for (const id of files) takeFile(id);
    this.remember([row]);
    this.model.publish("create", k, undefined, row);
    yield* wait(this.model.wrote("create", this.actor, k, undefined, row));
    this.audited("create", k);
    return this.handOut(this.view(copy(row)), k);
  }

  create(input: Creatable<T, D>): Out<T | undefined> {
    return out(this.createG(input));
  }

  private matching(pred: (row: T) => boolean): (write: boolean) => Flow<T[]> {
    const self = this;
    return function* (w: boolean) {
      return (yield* self.loadG(w)).filter((r) => pred(self.view(r)));
    };
  }

  update(pred: (row: T) => boolean, patch: Partial<T>): Out<number> {
    const self = this;
    return out(
      (function* () {
        return yield* self.updateRowsG(yield* self.forWriteG("update", self.matching(pred)), patch);
      })(),
    );
  }

  updateLocked(lock: FieldLock, pred: (row: T) => boolean, patch: Partial<T>): Out<number> {
    if (!(lock instanceof FieldLock) || this.model.locks.get(lock.field) !== lock) {
      throw new Error(`${this.model.name}: not a lock on this model`);
    }
    const self = this;
    return out(
      (function* () {
        return yield* self.updateRowsG(yield* self.forWriteG("update", self.matching(pred)), patch, lock);
      })(),
    );
  }

  *updateRowsG(rows: T[], patch: Partial<T>, lock?: FieldLock): Flow<number> {
    if (Object.hasOwn(patch, this.model.key)) {
      throw new Error(`${this.model.name}: \`${this.model.key}\` cannot be updated`);
    }
    for (const [f, held] of this.model.locks) {
      if (Object.hasOwn(patch, f) && held !== lock) {
        throw new Error(`${this.model.name}: \`${f}\` is changed by ${held.owner}, not by update()`);
      }
    }
    const bin = this.model.trashField;
    if (bin !== null && Object.hasOwn(patch, bin)) {
      throw new Error(`${this.model.name}: \`${bin}\` is set by delete() and cleared by restore()`);
    }
    if (this.trashed) throw new Error(`${this.model.name}: a trashed row is restored before it is changed`);
    for (const f of this.model.fileFields) {
      const v = (patch as Record<string, unknown>)[f];
      if (v !== null && v !== undefined && rows.filter((r) => (r as Record<string, unknown>)[f] !== v).length > 1) {
        throw new Error(`${this.model.name}.${f}: a file is stored in one row; this update matches several`);
      }
    }
    let changed = 0;
    for (const row of rows) {
      const next = { ...row, ...patch };
      if (!this.canWrite(next)) {
        if (auditing()) this.audit("update", "denied", [this.keyOf(row)], "write rule (as patched)");
        continue;
      }
      const files = this.addedFiles(next, row);
      yield* wait(this.driver.update(this.keyOf(row), next));
      for (const id of files) takeFile(id);
      releaseFiles(this.droppedFiles(row, next));
      this.remember([next]);
      this.model.publish("update", this.keyOf(row), row, next);
      yield* wait(this.model.wrote("update", this.actor, this.keyOf(row), row, next));
      this.audited("update", this.keyOf(row));
      changed += 1;
    }
    return changed;
  }

  updateRows(rows: T[], patch: Partial<T>, lock?: FieldLock): Out<number> {
    return out(this.updateRowsG(rows, patch, lock));
  }

  delete(pred: (row: T) => boolean): Out<number> {
    const self = this;
    return out(
      (function* () {
        return yield* self.deleteRowsG(yield* self.forWriteG("delete", self.matching(pred)));
      })(),
    );
  }

  restore(pred: (row: T) => boolean): Out<number> {
    const bin = this.model.trashField;
    if (bin === null || !this.trashed) throw new Error(`${this.model.name}: restore() is on the trash: Model.as(actor).trash()`);
    const self = this;
    return out(
      (function* () {
        return yield* self.moveRowsG(yield* self.forWriteG("update", self.matching(pred)), bin, null, "restore");
      })(),
    );
  }

  private *moveRowsG(rows: T[], bin: string, value: number | null, action: "trash" | "restore"): Flow<number> {
    let changed = 0;
    for (const row of rows) {
      const next = { ...row, [bin]: value };
      if (!this.canWrite(next)) {
        if (auditing()) this.audit(action, "denied", [this.keyOf(row)], "write rule (as changed)");
        continue;
      }
      yield* wait(this.driver.update(this.keyOf(row), next));
      this.seen.delete(this.keyOf(row));
      this.model.publish("update", this.keyOf(row), row, next);
      yield* wait(this.model.wrote(action, this.actor, this.keyOf(row), row, next));
      this.audited(action, this.keyOf(row));
      changed += 1;
    }
    return changed;
  }

  *deleteRowsG(rows: T[]): Flow<number> {
    const bin = this.model.trashField;
    if (bin !== null && !this.trashed) return yield* this.moveRowsG(rows, bin, Date.now(), "trash");
    for (const row of rows) {
      yield* wait(this.driver.delete(this.keyOf(row)));
      this.seen.delete(this.keyOf(row));
      releaseFiles(this.droppedFiles(row, undefined));
      this.model.publish("delete", this.keyOf(row), row, undefined);
      yield* wait(this.model.wrote("delete", this.actor, this.keyOf(row), row, undefined));
      this.audited("delete", this.keyOf(row));
    }
    return rows.length;
  }

  deleteRows(rows: T[]): Out<number> {
    return out(this.deleteRowsG(rows));
  }
}

export interface WriteEvent<T> {
  action: "create" | "update" | "delete" | "trash" | "restore";
  actor: Actor;
  key: unknown;
  before?: T;
  after?: T;
}

const readOnly = new WeakSet<object>();

export function readOnlyActor<A extends object>(actor: A, o: { via?: string } = {}): A {
  if (actor === null || typeof actor !== "object") throw new TypeError("readOnlyActor: the actor is an object");
  const p = new Proxy(actor, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
  });
  readOnly.add(p);
  if (typeof o.via === "string" && o.via !== "") setVia(p, o.via);
  return p;
}

export function isReadOnlyActor(actor: unknown): boolean {
  return typeof actor === "object" && actor !== null && readOnly.has(actor);
}

export class FieldLock {
  readonly model: string;
  readonly field: string;
  readonly owner: string;
  readonly initial: unknown;

  constructor(model: string, field: string, owner: string, initial: unknown) {
    this.model = model;
    this.field = field;
    this.owner = owner;
    this.initial = initial;
    Object.freeze(this);
  }
}

export class Model<T, D extends keyof T = never> {
  readonly name: string;
  readonly config: ModelConfig<T>;
  readonly key: string;
  readonly fields: FieldSpec[];
  readonly fileFields: string[];
  readonly tenant: string | null;
  readonly trashField: string | null;
  readonly retention: { field: string; ms: number } | null;
  readonly fieldReads: ReadonlyArray<readonly [string, Policy<T>]>;
  readonly residency: string | ((row: T) => string | null | undefined) | null;
  private store: AnyDriver<T>;
  private changeFeed: ChangeFeed = changes;
  private readonly writeHooks = new Set<(w: WriteEvent<T>) => void | Promise<void>>();
  readonly locks = new Map<string, FieldLock>();

  constructor(name: string, config: ModelConfig<T>, driver?: AnyDriver<T>) {
    this.name = name;
    this.config = config;
    const ids = Object.entries(config.attrs ?? {}).filter(([, a]) => a.id === true);
    if (ids.length > 1) {
      throw new Error(`model ${name}: more than one @id field`);
    }
    this.key = config.key ?? ids[0]?.[0] ?? "id";
    this.fields = fieldSpecs(config.fields, config.attrs);
    this.fileFields = this.fields.filter((f) => f.file).map((f) => f.name);
    if (!this.fields.some((f) => f.name === this.key)) {
      throw new Error(`model ${name}: no key field \`${this.key}\``);
    }
    const tenants = Object.entries(config.attrs ?? {}).filter(([, a]) => a.tenant === true);
    if (tenants.length > 1) {
      throw new Error(`model ${name}: more than one @tenant field`);
    }
    this.tenant = tenants[0]?.[0] ?? null;
    const bins = this.fields.filter((f) => config.attrs?.[f.name]?.softDelete === true);
    if (bins.length > 1) {
      throw new Error(`model ${name}: more than one @softDelete field`);
    }
    const bin = bins[0];
    if (bin && (bin.type.replace(/\s/g, "") !== "number|null" || bin.name === this.key || bin.name === this.tenant)) {
      throw new Error(`model ${name}: the @softDelete field \`${bin.name}\` is \`number | null\` (when it was trashed)`);
    }
    this.trashField = bin?.name ?? null;
    const kept = this.fields.filter((f) => config.attrs?.[f.name]?.retain !== undefined);
    if (kept.length > 1) {
      throw new Error(`model ${name}: more than one @retain field`);
    }
    const k = kept[0];
    if (k) {
      const ms = config.attrs![k.name]!.retain;
      if (!["number", "number|null"].includes(k.type.replace(/\s/g, "")) || k.name === this.key) {
        throw new Error(`model ${name}: the @retain field \`${k.name}\` is a time in ms (\`number\` or \`number | null\`)`);
      }
      if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 60_000) {
        throw new Error(`model ${name}: @retain on \`${k.name}\` is at least a minute`);
      }
    }
    this.retention = k ? { field: k.name, ms: config.attrs![k.name]!.retain! } : null;
    const res = config.residency;
    if (res !== undefined && typeof res !== "function" && !(typeof res === "string" && REGION.test(res))) {
      throw new Error(`model ${name}: residency is a region name (\`eu\`, \`us-east\`) or a function of the row`);
    }
    this.residency = res ?? null;
    const reads: [string, Policy<T>][] = [];
    for (const [f, a] of Object.entries(config.attrs ?? {})) {
      if (a.read === undefined && a.consent === undefined) continue;
      if (a.read !== undefined && typeof a.read !== "function") throw new Error(`model ${name}: the read rule of \`${f}\` is a function`);
      if (f === this.key || f === this.tenant || f === this.trashField) {
        throw new Error(`model ${name}: \`${f}\` is the key, tenant or trash field; it cannot have its own read rule`);
      }
      let rule = a.read as Policy<T> | undefined;
      if (a.consent !== undefined) {
        const subject = typeof a.consent === "object" && a.consent !== null ? a.consent.subject : undefined;
        if (subject !== undefined && !Object.hasOwn(config.fields, subject)) {
          throw new Error(`model ${name}: the consent subject of \`${f}\` is \`${String(subject)}\`, which is not a field`);
        }
        if (subject === f) throw new Error(`model ${name}: \`${f}\` cannot be its own consent subject`);
        const agreed = consentRule(name, f, a.consent) as Policy<T>;
        const own = rule;
        rule = own ? (actor, row) => agreed(actor, row) && own(actor, row) : agreed;
        watchConsent(typeof a.consent === "string" ? a.consent : a.consent.purpose, this);
      }
      reads.push([f, rule!]);
    }
    this.fieldReads = Object.freeze(reads);
    this.store =
      driver ??
      new MemoryDriver<T>(
        this.key,
        this.fields.filter((f) => f.unique).map((f) => f.name),
      );
  }

  inTenant(actor: Actor, row: T): boolean {
    if (this.tenant === null) return true;
    const t = tenantOf(actor);
    return t !== undefined && (row as Record<string, unknown>)[this.tenant] === t;
  }

  withDefaults(row: Creatable<T, D>): T {
    const out = { ...(row as Record<string, unknown>) };
    for (const f of this.fields) {
      if (f.default && out[f.name] === undefined) {
        out[f.name] = f.default();
      }
    }
    return out as T;
  }

  get driver(): FlowDriver<T> {
    return this.store;
  }

  /** The attached driver as given to `use` (sync `Driver` or `AsyncDriver`). */
  get attached(): AnyDriver<T> {
    return this.store;
  }

  /** True when the attached driver is asynchronous: terminals then return Promises. */
  get isAsync(): boolean {
    return isAsyncDriver(this.store);
  }

  /** The synchronous driver (or the async driver's replica), or null when there is none. */
  syncDriverOrNull(): Driver<T> | null {
    const d = this.store;
    return isAsyncDriver(d) ? (d.local ?? null) : d;
  }

  /** The synchronous driver (or the async driver's replica); throws when the model has none. */
  syncDriver(): Driver<T> {
    const d = this.syncDriverOrNull();
    if (d === null) {
      throw new Error(`${this.name}: uses an async driver without a local replica; await its terminals instead of reading synchronously`);
    }
    return d;
  }

  use(driver: AnyDriver<T>): this {
    this.store = driver;
    return this;
  }

  get feed(): ChangeFeed {
    return this.changeFeed;
  }

  publishTo(feed: ChangeFeed): this {
    this.changeFeed = feed;
    return this;
  }

  lock(field: keyof T & string, initial: unknown, owner: string): FieldLock {
    const spec = this.fields.find((f) => f.name === field);
    if (!spec) throw new Error(`${this.name}: no field \`${String(field)}\` to lock`);
    if (field === this.key || field === this.tenant || field === this.trashField || spec.file) {
      throw new Error(`${this.name}: \`${field}\` (the key, tenant, trash or a file field) cannot be locked`);
    }
    if (this.locks.has(field)) throw new Error(`${this.name}: \`${field}\` is already changed by ${this.locks.get(field)!.owner}`);
    if (initial === undefined) throw new Error(`${this.name}: a locked field needs an initial value`);
    if (typeof owner !== "string" || owner === "") throw new Error(`${this.name}: lock(): name the owner`);
    const lock = new FieldLock(this.name, field, owner, copy(initial));
    this.locks.set(field, lock);
    return lock;
  }

  get lockedFields(): string[] {
    return [...this.locks.keys()];
  }

  /**
   * Run `fn` after each write through `Model.as(actor)`. On async databases a hook may return a
   * Promise; the write waits for it (so a cascade joins the same transaction).
   */
  onWrite(fn: (w: WriteEvent<T>) => void | Promise<void>): () => void {
    this.writeHooks.add(fn);
    return () => {
      this.writeHooks.delete(fn);
    };
  }

  wrote(action: WriteEvent<T>["action"], actor: Actor, key: unknown, before: T | undefined, after: T | undefined): Maybe<void> {
    let pending: Promise<void>[] | null = null;
    for (const fn of this.writeHooks) {
      const r = fn({
        action,
        actor,
        key,
        ...(before === undefined ? {} : { before: copy(before) }),
        ...(after === undefined ? {} : { after: copy(after) }),
      });
      if (isThenable(r)) (pending ??= []).push(r as Promise<void>);
    }
    return pending ? Promise.all(pending).then(() => {}) : undefined;
  }

  regionsOf(before: T | undefined, after: T | undefined): string[] {
    const r = this.residency;
    if (r === null) return [];
    if (typeof r === "string") return [r];
    const out = new Set<string>();
    for (const row of [before, after]) {
      if (row === undefined) continue;
      let v: unknown;
      try {
        v = r(row);
      } catch {
        v = "?";
      }
      if (v === null || v === undefined) continue;
      out.add(typeof v === "string" && REGION.test(v) ? v : "?");
    }
    return [...out].sort();
  }

  publish(op: ChangeOp, key: unknown, before: T | undefined, after: T | undefined): void {
    if (this.changeFeed.size === 0) {
      return;
    }
    const regions = this.regionsOf(before, after);
    const change = {
      model: this.name,
      op,
      key,
      ...(regions.length > 0 ? { regions } : {}),
      ...(before === undefined ? {} : { before: copy(before) }),
      ...(after === undefined ? {} : { after: copy(after) }),
    };
    const feed = this.changeFeed;
    afterCommit(() => feed.publish(change));
  }

  publishAll(): void {
    if (this.changeFeed.size === 0) return;
    const feed = this.changeFeed;
    const change = { model: this.name, op: "update" as const, key: undefined, redacted: true as const };
    afterCommit(() => feed.publish(change));
  }

  as(actor: Actor): ScopedModel<T, D> {
    return new ScopedModel<T, D>(this, actor);
  }

  purgeTrash(before: number): Out<number> {
    const bin = this.trashField;
    if (bin === null) throw new Error(`${this.name}: no @softDelete field, so no trash`);
    if (typeof before !== "number" || !Number.isFinite(before)) throw new TypeError(`${this.name}.purgeTrash: \`before\` is a time in ms`);
    return this.purgeWhere(bin, before, "trash purged");
  }

  purgeExpired(now: number = Date.now()): Out<number> {
    const r = this.retention;
    if (r === null) throw new Error(`${this.name}: no @retain field`);
    if (typeof now !== "number" || !Number.isFinite(now)) throw new TypeError(`${this.name}.purgeExpired: \`now\` is a time in ms`);
    return this.purgeWhere(r.field, now - r.ms, "retention");
  }

  private purgeWhere(field: string, before: number, reason: string): Out<number> {
    const self = this;
    return out(
      (function* () {
        const all = yield* wait(self.driver.select([]));
        const old = all.filter((r) => {
          const v = (r as Record<string, unknown>)[field];
          return typeof v === "number" && v < before;
        });
        return yield* self.removeRowsG(old, reason);
      })(),
    );
  }

  removeUnscoped(keys: readonly unknown[], reason: string): Out<number> {
    const self = this;
    return out(
      (function* () {
        const rows: T[] = [];
        for (const k of keys) rows.push(...(yield* wait(self.driver.select([], k))));
        return yield* self.removeRowsG(rows, reason);
      })(),
    );
  }

  unlinkUnscoped(keys: readonly unknown[], field: string, reason: string): Out<number> {
    const spec = this.fields.find((f) => f.name === field);
    if (!spec || !spec.nullable || field === this.key || field === this.tenant) {
      throw new Error(`${this.name}: \`${field}\` is not a nullable field that can be cleared`);
    }
    return out(this.unlinkG(keys, field, reason));
  }

  private *unlinkG(keys: readonly unknown[], field: string, reason: string): Flow<number> {
    const changed: unknown[] = [];
    for (const k of keys) {
      for (const before of yield* wait(this.driver.select([], k))) {
        if ((before as Record<string, unknown>)[field] === null) continue;
        const after = { ...before, [field]: null } as T;
        yield* wait(this.driver.update(k, after));
        this.publish("update", k, before, after);
        yield* wait(this.wrote("update", null, k, before, after));
        changed.push(k);
      }
    }
    if (changed.length && auditing()) {
      afterCommit(() => record({ model: this.name, actor: null, action: "update", outcome: "allowed", keys: changed, reason }));
    }
    return changed.length;
  }

  private *removeRowsG(old: T[], reason: string): Flow<number> {
    const files = this.fileFields;
    for (const row of old) {
      const key = (row as Record<string, unknown>)[this.key];
      yield* wait(this.driver.delete(key));
      releaseFiles(files.map((f) => (row as Record<string, unknown>)[f]).filter((v): v is string => typeof v === "string" && v !== ""));
      this.publish("delete", key, row, undefined);
      this.wrote("delete", null, key, row, undefined);
    }
    if (old.length && auditing()) {
      const keys = old.map((r) => (r as Record<string, unknown>)[this.key]);
      afterCommit(() => record({ model: this.name, actor: null, action: "delete", outcome: "allowed", keys, reason }));
    }
    return old.length;
  }

  publicUnscoped(): Out<T[]> {
    noteRead(this as Model<unknown>, UNSCOPED);
    const started = timingReads() ? performance.now() : null;
    const self = this;
    return out(
      (function* () {
        const rows = yield* wait(self.driver.select([]));
        if (started !== null) noteReadDone({ model: self.name, rows: rows.length, ms: performance.now() - started, scoped: false });
        return rows;
      })(),
    );
  }
}

export const REGION = /^[a-z][a-z0-9-]{0,31}$/;

export function defineModel<T, D extends keyof T = never>(
  name: string,
  config: ModelConfig<T>,
  driver?: AnyDriver<T>,
): Model<T, D> {
  return new Model<T, D>(name, config, driver);
}
