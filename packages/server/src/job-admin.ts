import { defineAction, type Action } from "./action.ts";
import type { PageContext } from "./context.ts";
import type { JobRecord, Jobs, JobStatus } from "./jobs.ts";

export interface JobAdminOptions {
  jobs: Jobs;
  allow(ctx: PageContext): boolean | Promise<boolean>;
  showArgs?: boolean | ((job: JobRecord) => boolean);
  name?: string;
}

export interface JobView {
  id: string;
  name: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: number;
  created: number;
  updated: number;
  progress: number | null;
  error: string | null;
  key: string | null;
  queuedBy: { user: string; tenant: string | null } | null;
  args: unknown[] | null;
  canRetry: boolean;
  canCancel: boolean;
}

export type JobActionResult = { ok: true; job: JobView } | { ok: false; reason: "not found" | "wrong state" };

export interface JobAdmin {
  overview(
    ctx: PageContext,
    filter?: { status?: string | null; name?: string | null; limit?: number },
  ): Promise<{ counts: Record<JobStatus, number>; jobs: JobView[]; names: string[]; status: JobStatus | null; name: string | null } | null>;
  job(ctx: PageContext, id: string): Promise<JobView | null>;
  retry(ctx: PageContext, id: string): Promise<JobActionResult>;
  cancel(ctx: PageContext, id: string): Promise<JobActionResult>;
  actions: Record<string, Action<never[]>>;
}

export const JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "dead", "done", "cancelled"];
const ID_RE = /^[0-9a-f]{32}$/;
const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,100}$/;
const MAX_LIST = 500;

export function defineJobAdmin(opts: JobAdminOptions): JobAdmin {
  if (!opts || typeof opts.allow !== "function") throw new Error("defineJobAdmin: `allow(ctx)` decides who may use it");
  if (!opts.jobs || typeof opts.jobs.list !== "function") throw new Error("defineJobAdmin: `jobs` is a createJobs(...)");
  const prefix = opts.name ?? "jobs";
  if (!/^[a-z][A-Za-z0-9]{0,40}$/.test(prefix)) throw new Error("defineJobAdmin: name is an identifier");
  const jobs = opts.jobs;
  const showArgs = (r: JobRecord) => (typeof opts.showArgs === "function" ? opts.showArgs(r) === true : opts.showArgs === true);

  async function gate(ctx: PageContext): Promise<boolean> {
    try {
      return (await opts.allow(ctx)) === true;
    } catch {
      return false;
    }
  }

  const view = (r: JobRecord): JobView => {
    let args: unknown[] | null = null;
    try {
      args = showArgs(r) ? structuredClone(r.args) : null;
    } catch {
      args = null;
    }
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      attempts: r.attempts,
      maxAttempts: r.maxAttempts,
      runAt: r.runAt,
      created: r.created,
      updated: r.updated,
      progress: r.progress,
      error: r.error,
      key: r.key,
      queuedBy: r.actor ? { user: r.actor.user, tenant: r.actor.tenant ?? null } : null,
      args,
      canRetry: r.status === "dead" || r.status === "cancelled",
      canCancel: r.status === "queued" || r.status === "dead",
    };
  };

  const find = async (ctx: PageContext, id: unknown): Promise<JobRecord | null> => {
    if (!(await gate(ctx)) || typeof id !== "string" || !ID_RE.test(id)) return null;
    return (await jobs.get(id)) ?? null;
  };

  const act = async (ctx: PageContext, id: string, op: "retry" | "cancel"): Promise<JobActionResult> => {
    const r = await find(ctx, id);
    if (!r) return { ok: false, reason: "not found" };
    if (!(await jobs[op](r.id))) return { ok: false, reason: "wrong state" };
    return { ok: true, job: view((await jobs.get(r.id))!) };
  };

  const admin: JobAdmin = {
    async overview(ctx, filter = {}) {
      if (!(await gate(ctx))) return null;
      const status = (JOB_STATUSES as readonly unknown[]).includes(filter.status) ? (filter.status as JobStatus) : null;
      const name = typeof filter.name === "string" && NAME_RE.test(filter.name) ? filter.name : null;
      const limit = filter.limit === undefined ? 200 : filter.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) throw new RangeError(`jobAdmin.overview: limit is from 1 to ${MAX_LIST}`);
      const rows = await jobs.list({ ...(status ? { status } : {}), ...(name ? { name } : {}), limit });
      return { counts: await jobs.counts(), jobs: rows.map(view), names: jobs.names(), status, name };
    },
    async job(ctx, id) {
      const r = await find(ctx, id);
      return r ? view(r) : null;
    },
    retry: (ctx, id) => act(ctx, id, "retry"),
    cancel: (ctx, id) => act(ctx, id, "cancel"),
    actions: {},
  };
  const idParam = [{ name: "id", type: "string" as const }];
  admin.actions = {
    [`${prefix}Retry`]: defineAction(`${prefix}Retry`, idParam, (ctx, id: string) => admin.retry(ctx, id)) as Action<never[]>,
    [`${prefix}Cancel`]: defineAction(`${prefix}Cancel`, idParam, (ctx, id: string) => admin.cancel(ctx, id)) as Action<never[]>,
  };
  return admin;
}
