import { defaultActorId, entry, filters, keyValue, type AuditEntry, type AuditQuery, type AuditSink, type RawEntry, type SqlAuditLogOptions } from "./audit.ts";
import type { Actor } from "./model.ts";
import { numbered, type PgPool } from "./postgres.ts";

export interface PgAuditLogOptions extends SqlAuditLogOptions {
  onError?(err: unknown): void;
}

export class PgAuditLog {
  readonly table: string;
  readonly #pool: PgPool;
  readonly #t: string;
  readonly #actorId: (actor: Actor) => string | null;
  readonly #onError: (err: unknown) => void;
  #ready: Promise<void> | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(pool: PgPool, opts: PgAuditLogOptions = {}) {
    const table = opts.table ?? "weft_audit";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`not a valid table name: ${JSON.stringify(table)}`);
    this.table = table;
    this.#t = `"${table}"`;
    this.#pool = pool;
    this.#actorId = opts.actorId ?? defaultActorId;
    this.#onError = opts.onError ?? ((e) => console.error("[weft/data] audit write failed:", e));
  }

  #setup(): Promise<void> {
    if (!this.#ready) {
      const t = this.#t;
      const name = this.table;
      this.#ready = (async () => {
        await this.#pool.query(
          `CREATE TABLE IF NOT EXISTS ${t} (id bigserial PRIMARY KEY, at text NOT NULL, model text NOT NULL, ` +
            `actor text, action text NOT NULL, outcome text NOT NULL, keys text NOT NULL, count integer NOT NULL, reason text, via text)`,
        );
        await this.#pool.query(`CREATE INDEX IF NOT EXISTS "${name}_at_idx" ON ${t} (at)`);
        await this.#pool.query(`CREATE INDEX IF NOT EXISTS "${name}_model_idx" ON ${t} (model, at)`);
        await this.#pool.query(`CREATE INDEX IF NOT EXISTS "${name}_actor_idx" ON ${t} (actor, at)`);
      })();
      this.#ready.catch(() => (this.#ready = null));
    }
    return this.#ready;
  }

  async #q(sql: string, params: unknown[]): Promise<RawEntry[]> {
    await this.#setup();
    return (await this.#pool.query(numbered(sql), params)).rows as RawEntry[];
  }

  readonly sink: AuditSink = (e) => {
    const row = [
      e.at.toISOString(),
      e.model,
      this.#actorId(e.actor),
      e.action,
      e.outcome,
      JSON.stringify(e.keys, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      e.count,
      e.reason ?? null,
      e.via ?? null,
    ];
    this.#queue = this.#queue
      .then(() => this.#q(`INSERT INTO ${this.#t} (at, model, actor, action, outcome, keys, count, reason, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, row))
      .then(
        () => {},
        (err) => this.#onError(err),
      );
  };

  /** Resolves once every event handed to the sink so far is written. */
  flush(): Promise<void> {
    return this.#queue;
  }

  async seen(model: string, key: unknown, opts: AuditQuery = {}): Promise<AuditEntry[]> {
    if (typeof model !== "string" || model === "") throw new Error("seen: a model name");
    const k = keyValue(key);
    const { where, params, limit } = filters(opts);
    const rows = await this.#q(
      `SELECT id, at, model, actor, action, outcome, keys, count, reason, via FROM ${this.#t} ` +
        `WHERE model = ?${where} AND ((keys::jsonb) @> ?::jsonb ` +
        `OR (action = 'read' AND outcome = 'allowed' AND count > jsonb_array_length(keys::jsonb))) ` +
        `ORDER BY at DESC, id DESC LIMIT ?`,
      [model, ...params, JSON.stringify([k]), limit],
    );
    return rows.map((r) => entry(r, k));
  }

  async byActor(actor: string, opts: AuditQuery & { model?: string } = {}): Promise<AuditEntry[]> {
    if (typeof actor !== "string" || actor === "") throw new Error("byActor: an actor id");
    const { where, params, limit } = filters(opts);
    const byModel = opts.model === undefined ? "" : " AND model = ?";
    const rows = await this.#q(
      `SELECT id, at, model, actor, action, outcome, keys, count, reason, via FROM ${this.#t} ` +
        `WHERE actor = ?${byModel}${where} ORDER BY at DESC, id DESC LIMIT ?`,
      [actor, ...(opts.model === undefined ? [] : [opts.model]), ...params, limit],
    );
    return rows.map((r) => entry(r, null));
  }
}
