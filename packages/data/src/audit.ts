import type { Actor } from "./model.ts";
import type { SqlValue } from "./policy.ts";
import type { SqlDatabase, SqlStatement } from "./sql.ts";
import { whenIdle } from "./tx.ts";

export type AuditAction = "read" | "create" | "update" | "delete" | "trash" | "restore";

export interface AuditEvent {
  at: Date;
  model: string;
  actor: Actor;
  action: AuditAction;
  outcome: "allowed" | "denied";
  keys: unknown[];
  count: number;
  reason?: string;
  via?: string;
}

export type AuditSink = (event: AuditEvent) => void;

export const MAX_KEYS = 100;

const sinks = new Map<AuditSink, { reads: boolean }>();
const vias = new WeakMap<object, string>();

export function setVia(actor: object, by: string): void {
  vias.set(actor, by);
}

export function viaOf(actor: Actor): string | undefined {
  return typeof actor === "object" && actor !== null ? vias.get(actor) : undefined;
}

export function audit(sink: AuditSink, opts: { reads?: boolean } = {}): () => void {
  sinks.set(sink, { reads: opts.reads === true });
  return () => {
    sinks.delete(sink);
  };
}

export function auditing(): boolean {
  return sinks.size > 0;
}

export function auditingReads(): boolean {
  for (const o of sinks.values()) if (o.reads) return true;
  return false;
}

function report(err: unknown): void {
  const g = globalThis as { reportError?(e: unknown): void };
  if (typeof g.reportError === "function") g.reportError(err);
  else console.error("[weft/data] audit sink failed:", err);
}

export function record(e: Omit<AuditEvent, "at" | "count" | "keys"> & { keys: unknown[] }): void {
  if (sinks.size === 0) return;
  const via = viaOf(e.actor);
  const event: AuditEvent = { at: new Date(), ...e, keys: e.keys.slice(0, MAX_KEYS), count: e.keys.length };
  if (via !== undefined) event.via = via;
  for (const [sink, o] of sinks) {
    if (event.action === "read" && event.outcome === "allowed" && !o.reads) continue;
    try {
      sink(event);
    } catch (err) {
      report(err);
    }
  }
}

export function defaultActorId(actor: Actor): string | null {
  if (typeof actor === "string" || typeof actor === "number" || typeof actor === "bigint") return String(actor);
  if (typeof actor === "object" && actor !== null && "id" in actor) {
    const id = (actor as { id: unknown }).id;
    if (typeof id === "string" || typeof id === "number" || typeof id === "bigint") return String(id);
  }
  return null;
}

export interface SqlAuditLogOptions {
  table?: string;
  actorId?(actor: Actor): string | null;
}

export class SqlAuditLog {
  private readonly insert: SqlStatement;
  private readonly actorId: (actor: Actor) => string | null;
  readonly table: string;

  constructor(db: SqlDatabase, opts: SqlAuditLogOptions = {}) {
    const table = opts.table ?? "weft_audit";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`not a valid table name: ${JSON.stringify(table)}`);
    this.table = table;
    this.actorId = opts.actorId ?? defaultActorId;
    db.exec(
      `CREATE TABLE IF NOT EXISTS "${table}" (id INTEGER PRIMARY KEY, at TEXT NOT NULL, model TEXT NOT NULL, ` +
        `actor TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL, keys TEXT NOT NULL, count INTEGER NOT NULL, ` +
        `reason TEXT, via TEXT) STRICT`,
    );
    const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "via")) db.exec(`ALTER TABLE "${table}" ADD COLUMN via TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_at_idx" ON "${table}" (at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_model_idx" ON "${table}" (model, at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS "${table}_actor_idx" ON "${table}" (actor, at)`);
    this.db = db;
    this.insert = db.prepare(
      `INSERT INTO "${table}" (at, model, actor, action, outcome, keys, count, reason, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  readonly sink: AuditSink = (e) => {
    const row = [
      e.at.toISOString(),
      e.model,
      this.actorId(e.actor),
      e.action,
      e.outcome,
      JSON.stringify(e.keys, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      e.count,
      e.reason ?? null,
      e.via ?? null,
    ] as const;
    whenIdle(() => this.insert.run(...row));
  };

  seen(model: string, key: unknown, opts: AuditQuery = {}): AuditEntry[] {
    if (typeof model !== "string" || model === "") throw new Error("seen: a model name");
    const k = keyValue(key);
    const { where, params, limit } = filters(opts);
    const rows = this.db
      .prepare(
        `SELECT id, at, model, actor, action, outcome, keys, count, reason, via FROM "${this.table}" ` +
          `WHERE model = ?${where} AND (EXISTS (SELECT 1 FROM json_each(keys) WHERE json_each.value = ?) ` +
          `OR (action = 'read' AND outcome = 'allowed' AND count > json_array_length(keys))) ` +
          `ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(model, ...params, k, limit);
    return rows.map((r) => entry(r as RawEntry, k));
  }

  byActor(actor: string, opts: AuditQuery & { model?: string } = {}): AuditEntry[] {
    if (typeof actor !== "string" || actor === "") throw new Error("byActor: an actor id");
    const { where, params, limit } = filters(opts);
    const byModel = opts.model === undefined ? "" : " AND model = ?";
    const rows = this.db
      .prepare(
        `SELECT id, at, model, actor, action, outcome, keys, count, reason, via FROM "${this.table}" ` +
          `WHERE actor = ?${byModel}${where} ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(actor, ...(opts.model === undefined ? [] : [opts.model]), ...params, limit);
    return rows.map((r) => entry(r as RawEntry, null));
  }

  private readonly db: SqlDatabase;
}

export interface AuditQuery {
  since?: Date;
  until?: Date;
  actions?: readonly AuditAction[];
  outcome?: "allowed" | "denied";
  limit?: number;
}

export interface AuditEntry {
  id: number;
  at: Date;
  model: string;
  actor: string | null;
  action: AuditAction;
  outcome: "allowed" | "denied";
  keys: unknown[];
  count: number;
  reason: string | null;
  via: string | null;
  certain: boolean;
}

interface RawEntry {
  id: number | bigint;
  at: string;
  model: string;
  actor: string | null;
  action: string;
  outcome: string;
  keys: string;
  count: number | bigint;
  reason: string | null;
  via: string | null;
}

const ACTIONS = new Set<string>(["read", "create", "update", "delete", "trash", "restore"]);

function filters(opts: AuditQuery): { where: string; params: SqlValue[]; limit: number } {
  let where = "";
  const params: SqlValue[] = [];
  const time = (d: unknown, what: string): string => {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new Error(`${what} is a Date`);
    return d.toISOString();
  };
  if (opts.since !== undefined) {
    where += " AND at >= ?";
    params.push(time(opts.since, "since"));
  }
  if (opts.until !== undefined) {
    where += " AND at < ?";
    params.push(time(opts.until, "until"));
  }
  if (opts.actions !== undefined) {
    const list = [...new Set(opts.actions)];
    if (list.length === 0 || list.some((a) => !ACTIONS.has(a))) throw new Error("actions are audit actions");
    where += ` AND action IN (${list.map(() => "?").join(", ")})`;
    params.push(...list);
  }
  if (opts.outcome !== undefined) {
    if (opts.outcome !== "allowed" && opts.outcome !== "denied") throw new Error("outcome is allowed or denied");
    where += " AND outcome = ?";
    params.push(opts.outcome);
  }
  const limit = opts.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("limit is 1-10000");
  return { where, params, limit };
}

function entry(r: RawEntry, key: SqlValue | null): AuditEntry {
  const keys = JSON.parse(r.keys) as unknown[];
  return {
    id: Number(r.id),
    at: new Date(r.at),
    model: r.model,
    actor: r.actor,
    action: r.action as AuditAction,
    outcome: r.outcome as "allowed" | "denied",
    keys,
    count: Number(r.count),
    reason: r.reason,
    via: r.via ?? null,
    certain: key === null || keys.some((k) => k === key),
  };
}

function keyValue(key: unknown): SqlValue {
  if (typeof key === "string") return key;
  if (typeof key === "bigint") return key.toString();
  if (typeof key === "number" && Number.isFinite(key)) return key;
  throw new Error("a key is a string or a number");
}
