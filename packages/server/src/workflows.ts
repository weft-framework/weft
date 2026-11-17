import { type ParamSpec, decodeJson } from "./action.ts";
import { authState } from "./auth.ts";
import type { PageContext } from "./context.ts";
import { defineJob, JobError, type Job, type JobActor, type Jobs } from "./jobs.ts";
import type { SqlDatabase } from "@weft-framework/data";

type Maybe<T> = T | Promise<T>;

export type WorkflowStatus = "running" | "done" | "failed" | "cancelled";

export interface WorkflowRun {
  id: string;
  name: string;
  args: unknown[];
  actor: JobActor | null;
  status: WorkflowStatus;
  history: Record<string, unknown>;
  waiting: { event: string; key: string } | null;
  wakeAt: number | null;
  result: unknown;
  error: string | null;
  key: string | null;
  created: number;
  updated: number;
  holder: string | null;
  holdUntil: number;
}

export interface WorkflowSignal {
  id: string;
  event: string;
  key: string;
  payload: unknown;
  at: number;
}

export interface WorkflowFilter {
  status?: WorkflowStatus;
  name?: string;
  limit?: number;
}

type Patch = Partial<Pick<WorkflowRun, "history" | "waiting" | "wakeAt" | "status" | "result" | "error">>;

export interface WorkflowStore {
  create(run: WorkflowRun): Maybe<boolean>;
  get(id: string): Maybe<WorkflowRun | null | undefined>;
  acquire(id: string, holder: string, until: number, now: number): Maybe<WorkflowRun | null | undefined>;
  save(id: string, holder: string, patch: Patch, now: number): Maybe<boolean>;
  release(id: string, holder: string): Maybe<void>;
  waitingFor(event: string, key: string): Maybe<string[]>;
  addSignal(s: WorkflowSignal): Maybe<void>;
  signals(event: string, key: string, since: number, limit: number): Maybe<WorkflowSignal[]>;
  cancel(id: string, now: number): Maybe<boolean>;
  list(f: WorkflowFilter): Maybe<WorkflowRun[]>;
  sweep(before: number): Maybe<void>;
}

const FINISHED: readonly WorkflowStatus[] = ["done", "failed", "cancelled"];

export class MemoryWorkflowStore implements WorkflowStore {
  readonly #runs = new Map<string, WorkflowRun>();
  readonly #signals: WorkflowSignal[] = [];

  create(run: WorkflowRun): boolean {
    if (run.key !== null && [...this.#runs.values()].some((r) => r.key === run.key && r.status === "running")) return false;
    this.#runs.set(run.id, structuredClone(run));
    return true;
  }
  get(id: string): WorkflowRun | null {
    const r = this.#runs.get(id);
    return r ? structuredClone(r) : null;
  }
  acquire(id: string, holder: string, until: number, now: number): WorkflowRun | null {
    const r = this.#runs.get(id);
    if (!r || r.status !== "running" || (r.holder !== null && r.holder !== holder && r.holdUntil >= now)) return null;
    r.holder = holder;
    r.holdUntil = until;
    return structuredClone(r);
  }
  save(id: string, holder: string, patch: Patch, now: number): boolean {
    const r = this.#runs.get(id);
    if (!r || r.holder !== holder || r.status !== "running") return false;
    Object.assign(r, structuredClone(patch), { updated: now });
    if (patch.status && FINISHED.includes(patch.status)) {
      r.key = null;
      r.holder = null;
      r.holdUntil = 0;
      r.waiting = null;
      r.wakeAt = null;
    }
    return true;
  }
  release(id: string, holder: string): void {
    const r = this.#runs.get(id);
    if (r && r.holder === holder) {
      r.holder = null;
      r.holdUntil = 0;
    }
  }
  waitingFor(event: string, key: string): string[] {
    return [...this.#runs.values()].filter((r) => r.status === "running" && r.waiting?.event === event && r.waiting.key === key).map((r) => r.id);
  }
  addSignal(s: WorkflowSignal): void {
    this.#signals.push(structuredClone(s));
  }
  signals(event: string, key: string, since: number, limit: number): WorkflowSignal[] {
    return this.#signals.filter((s) => s.event === event && s.key === key && s.at >= since).slice(0, limit).map((s) => structuredClone(s));
  }
  cancel(id: string, now: number): boolean {
    const r = this.#runs.get(id);
    if (!r || r.status !== "running") return false;
    Object.assign(r, { status: "cancelled", key: null, holder: null, holdUntil: 0, waiting: null, wakeAt: null, updated: now });
    return true;
  }
  list(f: WorkflowFilter): WorkflowRun[] {
    return [...this.#runs.values()]
      .filter((r) => (!f.status || r.status === f.status) && (!f.name || r.name === f.name))
      .sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1))
      .slice(0, Math.min(Math.max(1, f.limit ?? 100), 1000))
      .map((r) => structuredClone(r));
  }
  sweep(before: number): void {
    for (const [id, r] of this.#runs) if (FINISHED.includes(r.status) && r.updated < before) this.#runs.delete(id);
    for (let i = this.#signals.length - 1; i >= 0; i--) if (this.#signals[i]!.at < before) this.#signals.splice(i, 1);
  }
}

export class SqlWorkflowStore implements WorkflowStore {
  readonly #db: SqlDatabase;
  readonly #t: string;
  readonly #s: string;

  constructor(db: SqlDatabase, table = "weft_workflows") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`@weft-framework/server: not a valid table name: ${table}`);
    this.#db = db;
    this.#t = `"${table}"`;
    this.#s = `"${table}_signals"`;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#t} (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, actor TEXT, ` +
        `status TEXT NOT NULL, history TEXT NOT NULL, wait_event TEXT, wait_key TEXT, wake_at INTEGER, result TEXT, error TEXT, ` +
        `run_key TEXT UNIQUE, created INTEGER NOT NULL, updated INTEGER NOT NULL, holder TEXT, hold_until INTEGER NOT NULL)`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_waiting" ON ${this.#t} (wait_event, wait_key)`);
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#s} (id TEXT PRIMARY KEY NOT NULL, event TEXT NOT NULL, sig_key TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL)`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_signals_by" ON ${this.#s} (event, sig_key, at)`);
  }

  static #run(r: Record<string, unknown> | undefined): WorkflowRun | null {
    if (!r) return null;
    const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
    return {
      id: String(r.id),
      name: String(r.name),
      args: JSON.parse(String(r.args)) as unknown[],
      actor: r.actor === null || r.actor === undefined ? null : (JSON.parse(String(r.actor)) as JobActor),
      status: String(r.status) as WorkflowStatus,
      history: JSON.parse(String(r.history)) as Record<string, unknown>,
      waiting: r.wait_event === null || r.wait_event === undefined ? null : { event: String(r.wait_event), key: String(r.wait_key) },
      wakeAt: r.wake_at === null || r.wake_at === undefined ? null : Number(r.wake_at),
      result: r.result === null || r.result === undefined ? null : JSON.parse(String(r.result)),
      error: s(r.error),
      key: s(r.run_key),
      created: Number(r.created),
      updated: Number(r.updated),
      holder: s(r.holder),
      holdUntil: Number(r.hold_until),
    };
  }
  create(run: WorkflowRun): boolean {
    return (
      this.#db
        .prepare(
          `INSERT INTO ${this.#t} (id, name, args, actor, status, history, wait_event, wait_key, wake_at, result, error, run_key, created, updated, holder, hold_until) ` +
            `VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, 0) ON CONFLICT DO NOTHING RETURNING id`,
        )
        .all(run.id, run.name, JSON.stringify(run.args), run.actor ? JSON.stringify(run.actor) : null, run.status, JSON.stringify(run.history), run.key, run.created, run.updated)
        .length === 1
    );
  }
  get(id: string): WorkflowRun | null {
    return SqlWorkflowStore.#run(this.#db.prepare(`SELECT * FROM ${this.#t} WHERE id = ?`).all(id)[0] as Record<string, unknown>);
  }
  acquire(id: string, holder: string, until: number, now: number): WorkflowRun | null {
    return SqlWorkflowStore.#run(
      this.#db
        .prepare(
          `UPDATE ${this.#t} SET holder = ?, hold_until = ? WHERE id = ? AND status = 'running' ` +
            `AND (holder IS NULL OR holder = ? OR hold_until < ?) RETURNING *`,
        )
        .all(holder, until, id, holder, now)[0] as Record<string, unknown> | undefined,
    );
  }
  save(id: string, holder: string, patch: Patch, now: number): boolean {
    const sets: string[] = ["updated = ?"];
    const args: unknown[] = [now];
    if (patch.history !== undefined) (sets.push("history = ?"), args.push(JSON.stringify(patch.history)));
    if (patch.waiting !== undefined) (sets.push("wait_event = ?", "wait_key = ?"), args.push(patch.waiting?.event ?? null, patch.waiting?.key ?? null));
    if (patch.wakeAt !== undefined) (sets.push("wake_at = ?"), args.push(patch.wakeAt));
    if (patch.result !== undefined) (sets.push("result = ?"), args.push(JSON.stringify(patch.result)));
    if (patch.error !== undefined) (sets.push("error = ?"), args.push(patch.error));
    if (patch.status !== undefined) {
      sets.push("status = ?");
      args.push(patch.status);
      if (FINISHED.includes(patch.status)) sets.push("run_key = NULL", "holder = NULL", "hold_until = 0", "wait_event = NULL", "wait_key = NULL", "wake_at = NULL");
    }
    return (
      this.#db.prepare(`UPDATE ${this.#t} SET ${sets.join(", ")} WHERE id = ? AND holder = ? AND status = 'running' RETURNING id`).all(...(args as never[]), id, holder)
        .length === 1
    );
  }
  release(id: string, holder: string): void {
    this.#db.prepare(`UPDATE ${this.#t} SET holder = NULL, hold_until = 0 WHERE id = ? AND holder = ?`).run(id, holder);
  }
  waitingFor(event: string, key: string): string[] {
    return (this.#db.prepare(`SELECT id FROM ${this.#t} WHERE wait_event = ? AND wait_key = ? AND status = 'running'`).all(event, key) as { id: string }[]).map(
      (r) => String(r.id),
    );
  }
  addSignal(s: WorkflowSignal): void {
    this.#db.prepare(`INSERT INTO ${this.#s} (id, event, sig_key, payload, at) VALUES (?, ?, ?, ?, ?)`).run(s.id, s.event, s.key, JSON.stringify(s.payload), s.at);
  }
  signals(event: string, key: string, since: number, limit: number): WorkflowSignal[] {
    const rows = this.#db
      .prepare(`SELECT * FROM ${this.#s} WHERE event = ? AND sig_key = ? AND at >= ? ORDER BY at, id LIMIT ?`)
      .all(event, key, since, limit) as Record<string, unknown>[];
    return rows.map((r) => ({ id: String(r.id), event: String(r.event), key: String(r.sig_key), payload: JSON.parse(String(r.payload)), at: Number(r.at) }));
  }
  cancel(id: string, now: number): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE ${this.#t} SET status = 'cancelled', run_key = NULL, holder = NULL, hold_until = 0, wait_event = NULL, wait_key = NULL, ` +
            `wake_at = NULL, updated = ? WHERE id = ? AND status = 'running' RETURNING id`,
        )
        .all(now, id).length === 1
    );
  }
  list(f: WorkflowFilter): WorkflowRun[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.status) (where.push("status = ?"), args.push(f.status));
    if (f.name) (where.push("name = ?"), args.push(f.name));
    const rows = this.#db
      .prepare(`SELECT * FROM ${this.#t}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created DESC, id DESC LIMIT ?`)
      .all(...(args as never[]), Math.min(Math.max(1, f.limit ?? 100), 1000)) as Record<string, unknown>[];
    return rows.map((r) => SqlWorkflowStore.#run(r)!);
  }
  sweep(before: number): void {
    this.#db.prepare(`DELETE FROM ${this.#t} WHERE status IN ('done', 'failed', 'cancelled') AND updated < ?`).run(before);
    this.#db.prepare(`DELETE FROM ${this.#s} WHERE at < ?`).run(before);
  }
}

export interface WorkflowContext {
  user: unknown;
  run: { id: string; name: string };
  step<R>(name: string, fn: () => R | Promise<R>): Promise<R>;
  sleep(name: string, ms: number): Promise<void>;
  sleepUntil(name: string, at: number): Promise<void>;
  waitFor<P = unknown>(name: string, event: string, o: { key: string; timeoutMs?: number }): Promise<{ payload: P; at: number } | null>;
}

const WORKFLOW = Symbol.for("weft.workflow");

export interface Workflow<A extends unknown[] = never[]> {
  readonly [WORKFLOW]: true;
  readonly name: string;
  readonly params: readonly ParamSpec[];
  run(wf: WorkflowContext, ...args: A): unknown;
}

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const STEP_RE = /^[\x21-\x7e][\x20-\x7e]{0,199}$/;
const EVENT_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/;
const MAX_PAYLOAD = 64 * 1024;
const MAX_RESULT = 256 * 1024;

export function defineWorkflow<A extends unknown[]>(
  name: string,
  params: readonly ParamSpec[],
  run: (wf: WorkflowContext, ...args: A) => unknown,
): Workflow<A> {
  if (!NAME_RE.test(name)) throw new Error(`defineWorkflow: not a valid name: ${name}`);
  if (typeof run !== "function") throw new Error(`defineWorkflow ${name}: the body is a function`);
  return Object.freeze({ [WORKFLOW]: true as const, name, params: Object.freeze([...params]), run });
}

export function isWorkflow(v: unknown): v is Workflow<unknown[]> {
  return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[WORKFLOW] === true;
}

export interface WorkflowsOptions {
  workflows: readonly Workflow<never[]>[] | readonly Workflow<unknown[]>[];
  store?: WorkflowStore;
  attempts?: number;
  timeoutMs?: number;
  keepMs?: number;
  jobName?: string;
  onError?(err: unknown, run: WorkflowRun | null): void;
  now?(): number;
}

export interface StartOptions {
  key?: string;
  as?: JobActor | null;
}

class Suspend {
  readonly suspend = true;
}

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function asJson(v: unknown, max: number, what: string): unknown {
  const text = JSON.stringify(v === undefined ? null : v);
  if (text === undefined) throw new JobError(`${what} is not JSON`, { retry: false });
  if (text.length > max) throw new JobError(`${what} is larger than ${max} bytes`, { retry: false });
  return JSON.parse(text);
}

export class Workflows {
  readonly job: Job<[string]>;
  readonly #defs = new Map<string, Workflow<unknown[]>>();
  readonly #store: WorkflowStore;
  readonly #attempts: number;
  readonly #timeout: number;
  readonly #keep: number;
  readonly #onError: (err: unknown, run: WorkflowRun | null) => void;
  readonly #now: () => number;
  #jobs: Jobs | null = null;
  #swept = 0;

  constructor(o: WorkflowsOptions) {
    for (const w of o.workflows ?? []) {
      if (!isWorkflow(w)) throw new Error("createWorkflows: `workflows` holds defineWorkflow(...) results");
      if (this.#defs.has(w.name)) throw new Error(`createWorkflows: two workflows are called ${w.name}`);
      this.#defs.set(w.name, w as Workflow<unknown[]>);
    }
    if (this.#defs.size === 0) throw new Error("createWorkflows: at least one workflow");
    this.#store = o.store ?? new MemoryWorkflowStore();
    const range = (what: string, v: number, lo: number, hi: number) => {
      if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`createWorkflows: ${what} is ${lo} to ${hi}`);
      return v;
    };
    this.#attempts = range("attempts", o.attempts ?? 5, 1, 100);
    this.#timeout = range("timeoutMs", o.timeoutMs ?? 10 * 60_000, 1000, 24 * 3600_000);
    this.#keep = range("keepMs", o.keepMs ?? 30 * 86_400_000, 60_000, 365 * 86_400_000);
    this.#onError = o.onError ?? ((err, run) => console.error(`[weft] workflow ${run?.name ?? ""}:`, err));
    this.#now = o.now ?? Date.now;
    this.job = defineJob<[string]>(o.jobName ?? "weftWorkflow", [{ name: "run", type: "string" }], (ctx, id) => this.#execute(ctx, id), {
      attempts: this.#attempts,
      timeoutMs: this.#timeout,
    });
  }

  use(jobs: Jobs): this {
    this.#jobs = jobs;
    return this;
  }

  #queue(): Jobs {
    if (!this.#jobs) throw new Error("workflows: call use(jobs) first");
    return this.#jobs;
  }

  async start<A extends unknown[]>(ctx: PageContext | null, workflow: Workflow<A>, args: Record<string, unknown> = {}, o: StartOptions = {}): Promise<string | false> {
    const def = this.#defs.get(workflow?.name);
    if (!def || def !== (workflow as unknown)) throw new Error(`workflows: ${workflow?.name ?? "that"} is not one of these workflows`);
    const d = decodeJson(def.params, args);
    if (!d.ok) throw new TypeError(`workflow ${def.name}: ${d.error}`);
    if (o.key !== undefined && (typeof o.key !== "string" || o.key === "" || o.key.length > 256)) throw new TypeError("workflows: `key` is 1-256 characters");
    let actor: JobActor | null = null;
    if (o.as !== undefined) {
      if (o.as !== null && (typeof o.as.user !== "string" || o.as.user === "")) throw new TypeError("workflows: `as` needs a user id");
      actor = o.as === null ? null : { user: o.as.user, ...(o.as.tenant !== undefined ? { tenant: o.as.tenant } : {}) };
    } else if (ctx) {
      const s = await authState(ctx);
      if (s && !s.pending) actor = { user: s.user, ...(s.tenant !== undefined ? { tenant: s.tenant } : {}) };
    }
    const now = this.#now();
    const run: WorkflowRun = {
      id: randomId(),
      name: def.name,
      args: JSON.parse(JSON.stringify(d.args.map((a) => (a === undefined ? null : a)))) as unknown[],
      actor,
      status: "running",
      history: {},
      waiting: null,
      wakeAt: null,
      result: null,
      error: null,
      key: o.key ?? null,
      created: now,
      updated: now,
      holder: null,
      holdUntil: 0,
    };
    this.#queue();
    if (!(await this.#store.create(run))) return false;
    await this.#wake(run, now);
    return run.id;
  }

  async signal(event: string, key: string, payload: unknown = null): Promise<number> {
    if (typeof event !== "string" || !EVENT_RE.test(event)) throw new TypeError("workflows: not a valid event name");
    if (typeof key !== "string" || key === "" || key.length > 256) throw new TypeError("workflows: `key` is 1-256 characters");
    const text = JSON.stringify(payload ?? null);
    if (text === undefined || text.length > MAX_PAYLOAD) throw new TypeError(`workflows: the payload is JSON of at most ${MAX_PAYLOAD} bytes`);
    const now = this.#now();
    await this.#store.addSignal({ id: `${now.toString(36).padStart(10, "0")}-${randomId()}`, event, key, payload: JSON.parse(text), at: now });
    const ids = await this.#store.waitingFor(event, key);
    for (const id of ids) {
      const run = await this.#store.get(id);
      if (run) await this.#wake(run, now);
    }
    return ids.length;
  }

  get(id: string): Promise<WorkflowRun | null> {
    return Promise.resolve(this.#store.get(id)).then((r) => r ?? null);
  }
  list(f: WorkflowFilter = {}): Promise<WorkflowRun[]> {
    return Promise.resolve(this.#store.list(f));
  }
  cancel(id: string): Promise<boolean> {
    return Promise.resolve(this.#store.cancel(id, this.#now()));
  }

  async #wake(run: WorkflowRun, at: number, timed = false): Promise<void> {
    const key = timed ? { key: `weft-wf:${run.id}:${at}` } : {};
    await this.#queue().enqueue(null, this.job, { run: run.id }, { runAt: at, as: run.actor, ...key });
  }

  async #execute(ctx: { user: unknown; job: { id: string; attempt: number; maxAttempts: number } }, id: string): Promise<void> {
    const now = this.#now();
    if (now - this.#swept > 3600_000) {
      this.#swept = now;
      await this.#store.sweep(now - this.#keep);
    }
    const holder = ctx.job.id;
    const run = await this.#store.acquire(id, holder, now + this.#timeout + 60_000, now);
    if (!run) {
      const other = await this.#store.get(id);
      if (other && other.status === "running" && other.holder !== null) await this.#wake(other, other.holdUntil + 1, true);
      return;
    }
    const def = this.#defs.get(run.name);
    if (!def) {
      await this.#store.release(id, holder);
      throw new JobError(`no workflow ${run.name} in this version of the app`);
    }
    const history: Record<string, unknown> = { ...run.history };
    const used = new Set<string>();
    let suspended: { wakeAt: number | null; waiting: { event: string; key: string } | null } | null = null;
    const SUSPEND = new Suspend();
    const LOST = new Suspend();
    const save = async (patch: Patch) => {
      if (!(await this.#store.save(id, holder, patch, this.#now()))) throw LOST;
    };
    const claim = (name: string) => {
      if (typeof name !== "string" || !STEP_RE.test(name)) throw new JobError(`not a valid step name: ${String(name).slice(0, 50)}`, { retry: false });
      if (used.has(name)) throw new JobError(`step ${name} is used twice in one run`, { retry: false });
      used.add(name);
      if (suspended) throw SUSPEND;
    };
    const taken = () =>
      new Set(
        Object.values(history)
          .map((h) => (h as { got?: { id?: string } | null }).got?.id)
          .filter((x): x is string => typeof x === "string"),
      );
    const suspend = (wakeAt: number | null, waiting: { event: string; key: string } | null): never => {
      suspended = { wakeAt, waiting };
      throw SUSPEND;
    };
    const sleepUntil = async (name: string, at: number): Promise<void> => {
      claim(name);
      if (typeof at !== "number" || !Number.isFinite(at)) throw new JobError(`sleep ${name}: not a time`, { retry: false });
      let h = history[name] as { wake?: number } | undefined;
      if (!h) {
        h = { wake: at };
        history[name] = h;
        await save({ history });
      }
      if (this.#now() >= h.wake!) return;
      suspend(h.wake!, null);
    };
    const wf: WorkflowContext = {
      user: ctx.user,
      run: { id, name: run.name },
      step: async <R>(name: string, fn: () => R | Promise<R>): Promise<R> => {
        claim(name);
        const h = history[name] as { v: unknown } | undefined;
        if (h && "v" in h) return h.v as R;
        const v = asJson(await fn(), MAX_RESULT, `step ${name}'s result`);
        history[name] = { v };
        await save({ history });
        return v as R;
      },
      sleep: (name, ms) => {
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) throw new JobError(`sleep ${name}: ms is a positive number`, { retry: false });
        return sleepUntil(name, this.#now() + ms);
      },
      sleepUntil,
      waitFor: async <P>(name: string, event: string, o: { key: string; timeoutMs?: number }) => {
        claim(name);
        if (!EVENT_RE.test(event) || typeof o?.key !== "string" || o.key === "" || o.key.length > 256) {
          throw new JobError(`waitFor ${name}: an event name and a key`, { retry: false });
        }
        let h = history[name] as { deadline: number | null; got?: { id: string; payload: unknown; at: number } | null } | undefined;
        if (h && h.got !== undefined) return h.got === null ? null : { payload: h.got.payload as P, at: h.got.at };
        if (!h) {
          const t = o.timeoutMs;
          if (t !== undefined && (typeof t !== "number" || !Number.isFinite(t) || t < 0)) throw new JobError(`waitFor ${name}: timeoutMs`, { retry: false });
          h = { deadline: t === undefined ? null : this.#now() + t };
          history[name] = h;
        }
        const seen = taken();
        const sig = (await this.#store.signals(event, o.key, run.created, 1000)).find((s) => !seen.has(s.id));
        if (sig) {
          h.got = { id: sig.id, payload: sig.payload, at: sig.at };
          await save({ history, waiting: null });
          return { payload: sig.payload as P, at: sig.at };
        }
        if (h.deadline !== null && this.#now() >= h.deadline) {
          h.got = null;
          await save({ history, waiting: null });
          return null;
        }
        return suspend(h.deadline, { event, key: o.key });
      },
    };
    const args = def.params.map((p, i) => (run.args[i] === null && p.optional ? undefined : run.args[i]));
    let result: unknown;
    try {
      result = await def.run(wf, ...args);
    } catch (err) {
      if (err === LOST) return;
      if (err === SUSPEND || suspended) {
        await this.#pause(run, holder, history, suspended!);
        return;
      }
      const final = ctx.job.attempt >= ctx.job.maxAttempts || (err instanceof JobError && !err.retry);
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000) || "failed";
      try {
        if (final) await this.#store.save(id, holder, { history, status: "failed", error: message }, this.#now());
        else await this.#store.release(id, holder);
      } catch (e) {
        this.#onError(e, run);
      }
      this.#onError(err, run);
      throw err;
    }
    if (suspended) {
      await this.#pause(run, holder, history, suspended);
      return;
    }
    try {
      await save({ history, status: "done", result: asJson(result, MAX_RESULT, "the result") });
    } catch (err) {
      if (err === LOST) return;
      await this.#store.save(id, holder, { history, status: "failed", error: err instanceof Error ? err.message : String(err) }, this.#now());
      throw err;
    }
  }

  async #pause(
    run: WorkflowRun,
    holder: string,
    history: Record<string, unknown>,
    s: { wakeAt: number | null; waiting: { event: string; key: string } | null },
  ): Promise<void> {
    if (!(await this.#store.save(run.id, holder, { history, waiting: s.waiting, wakeAt: s.wakeAt }, this.#now()))) return;
    await this.#store.release(run.id, holder);
    if (s.wakeAt !== null) await this.#wake(run, s.wakeAt, true);
    if (s.waiting) {
      const seen = new Set(
        Object.values(history)
          .map((h) => (h as { got?: { id?: string } | null }).got?.id)
          .filter((x): x is string => typeof x === "string"),
      );
      const late = (await this.#store.signals(s.waiting.event, s.waiting.key, run.created, 1000)).some((x) => !seen.has(x.id));
      if (late) await this.#wake(run, this.#now());
    }
  }
}

export function createWorkflows(o: WorkflowsOptions): Workflows {
  return new Workflows(o);
}
