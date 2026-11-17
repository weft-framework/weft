import { randomBytes } from "node:crypto";
import { defineModel, type Grant, type Model, type PolicyExpr } from "@weft/data";
import type { PageContext } from "./context.ts";
import { seal, unseal } from "./seal.ts";

export interface GrantRow {
  id: string;
  model: string;
  key: string;
  numeric: boolean;
  rights: "read" | "write";
  by: string;
  label: string;
  created: number;
  expires: number;
  revoked: number;
  revokedBy: string;
}

export interface GrantInfo {
  id: string;
  model: string;
  key: string | number;
  rights: "read" | "write";
  by: string;
  label: string;
  created: number;
  expires: number;
  live: boolean;
  revoked: number | null;
  revokedBy: string | null;
}

export interface GrantsConfig {
  manage?: (user: string, grant: GrantInfo) => boolean;
  maxTtlMs?: number;
  perUser?: number;
  name?: string;
  now?: () => number;
}

export interface IssueOptions {
  ttlMs?: number;
  session?: boolean;
  label?: string;
}

export type GrantErrorCode = "invalid" | "forbidden" | "limit";

export class GrantError extends Error {
  readonly code: GrantErrorCode;
  constructor(code: GrantErrorCode, message: string) {
    super(message);
    this.name = "GrantError";
    this.code = code;
  }
}

const ANY = "*";

class Holder {
  readonly id: string;
  readonly grant: string;
  constructor(id: string, grant: string) {
    this.id = id;
    this.grant = grant;
    Object.freeze(this);
  }
}

const readable = (a: unknown, r: GrantRow): boolean => a instanceof Holder && (a.grant === ANY || a.grant === r.id);
const writable = (a: unknown): boolean => a instanceof Holder && a.grant === ANY;
const readWhere: PolicyExpr = {
  or: [
    { cmp: "==", l: { actor: ["grant"] }, r: { value: ANY } },
    { cmp: "==", l: { field: ["id"] }, r: { actor: ["grant"] } },
  ],
};
const writeWhere: PolicyExpr = { cmp: "==", l: { actor: ["grant"] }, r: { value: ANY } };

const PURPOSE = "weft.grant.kept";
const DAY = 24 * 60 * 60 * 1000;
const GRANT_ID = /^[A-Za-z0-9_-]{22}$/;
const PREFIX_RE = /^[A-Z][A-Za-z0-9]{0,31}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;
const SYSTEM = new Holder("grants:system", ANY);

function userId(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "" || v.length > 200 || CONTROL_RE.test(v)) {
    throw new GrantError("invalid", `${what} is a non-empty id of at most 200 characters`);
  }
  return v;
}

function info(r: GrantRow, now: number): GrantInfo {
  return {
    id: r.id,
    model: r.model,
    key: r.numeric ? Number(r.key) : r.key,
    rights: r.rights,
    by: r.by,
    label: r.label,
    created: r.created,
    expires: r.expires,
    live: r.revoked === 0 && r.expires > now,
    revoked: r.revoked === 0 ? null : r.revoked,
    revokedBy: r.revoked === 0 ? null : r.revokedBy,
  };
}

export class Grants {
  readonly models: { Grant: Model<GrantRow> };
  readonly #manage: ((user: string, grant: GrantInfo) => boolean) | null;
  readonly #maxTtl: number;
  readonly #perUser: number;
  readonly #now: () => number;

  constructor(cfg: GrantsConfig = {}) {
    if (cfg === null || typeof cfg !== "object") throw new GrantError("invalid", "defineGrants: a configuration object");
    if (cfg.manage !== undefined && typeof cfg.manage !== "function") throw new GrantError("invalid", "manage is a function (user, grant)");
    const maxTtl = cfg.maxTtlMs ?? 90 * DAY;
    if (!Number.isFinite(maxTtl) || maxTtl <= 0) throw new GrantError("invalid", "maxTtlMs is a positive number of milliseconds");
    const perUser = cfg.perUser ?? 1000;
    if (!Number.isInteger(perUser) || perUser < 1) throw new GrantError("invalid", "perUser is a whole number of at least 1");
    const name = cfg.name ?? "Grant";
    if (!PREFIX_RE.test(name)) throw new GrantError("invalid", "name is a model name");
    this.#manage = cfg.manage ?? null;
    this.#maxTtl = maxTtl;
    this.#perUser = perUser;
    this.#now = cfg.now ?? Date.now;
    this.models = {
      Grant: defineModel<GrantRow>(name, {
        fields: {
          id: "string",
          model: "string",
          key: "string",
          numeric: "boolean",
          rights: "string",
          by: "string",
          label: "string",
          created: "number",
          expires: "number",
          revoked: "number",
          revokedBy: "string",
        },
        read: readable,
        write: writable,
        readWhere,
        writeWhere,
      }),
    };
  }

  #may(user: string, row: GrantRow): boolean {
    if (row.by === user) return true;
    if (this.#manage === null) return false;
    try {
      return this.#manage(user, info(row, this.#now())) === true;
    } catch {
      return false;
    }
  }

  async issue<T>(
    ctx: PageContext,
    actor: unknown,
    model: Model<T>,
    key: string | number,
    rights: "read" | "write",
    opts: IssueOptions = {},
  ): Promise<{ id: string; token: string; expires: number }> {
    const by = userId((actor as { id?: unknown } | null)?.id, "the actor's id");
    if (rights !== "read" && rights !== "write") throw new GrantError("invalid", `rights are "read" or "write"`);
    if (typeof key !== "string" && !(typeof key === "number" && Number.isFinite(key))) {
      throw new GrantError("invalid", "the key is a string or a finite number");
    }
    if (typeof key === "string" && (key === "" || key.length > 200)) throw new GrantError("invalid", "the key is 1-200 characters");
    const ttl = opts.ttlMs ?? DAY;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > this.#maxTtl) {
      throw new GrantError("invalid", `ttlMs is a positive number of milliseconds, at most ${this.#maxTtl}`);
    }
    if (opts.label !== undefined && typeof opts.label !== "string") throw new GrantError("invalid", "label is a string");
    const label = (opts.label ?? "").trim();
    if (label.length > 200 || CONTROL_RE.test(label)) throw new GrantError("invalid", "a label is one line of at most 200 characters");

    const scoped = model.as(actor as never);
    const row = scoped.get(key);
    if (row === undefined || (rights === "write" && !scoped.writable(row))) {
      throw new GrantError("forbidden", `the actor may not ${rights} that ${model.name}, so cannot grant it`);
    }
    const now = this.#now();
    const live = this.models.Grant.as(SYSTEM).where((g) => g.by === by && g.revoked === 0 && g.expires > now).length;
    if (live >= this.#perUser) throw new GrantError("limit", `at most ${this.#perUser} live grants per person; revoke some first`);

    const id = randomBytes(16).toString("base64url");
    const expires = now + ttl;
    const token = await seal(ctx, { g: id, m: model.name, k: key, r: rights }, { purpose: PURPOSE, ttlMs: ttl, session: opts.session });
    this.models.Grant.as(new Holder(by, ANY)).create({
      id,
      model: model.name,
      key: String(key),
      numeric: typeof key === "number",
      rights,
      by,
      label,
      created: now,
      expires,
      revoked: 0,
      revokedBy: "",
    });
    return { id, token, expires };
  }

  async accept(ctx: PageContext, token: string | null | undefined, opts: { session?: boolean } = {}): Promise<Grant | null> {
    const v = (await unseal(ctx, token, { purpose: PURPOSE, session: opts.session })) as
      | { g?: unknown; m?: unknown; k?: unknown; r?: unknown }
      | undefined;
    if (typeof v !== "object" || v === null || typeof v.g !== "string" || !GRANT_ID.test(v.g)) return null;
    const row = this.models.Grant.as(new Holder(`grant:${v.g}`, v.g)).get(v.g);
    if (!row || row.revoked !== 0 || !(row.expires > this.#now())) return null;
    const key = row.numeric ? Number(row.key) : row.key;
    if (row.model !== v.m || key !== v.k || row.rights !== v.r) return null;
    return { model: row.model, key, rights: row.rights, expires: row.expires };
  }

  list(user: string, filter: { model?: string; key?: string | number; all?: boolean } = {}): GrantInfo[] {
    const who = userId(user, "the user");
    const now = this.#now();
    const key = filter.key === undefined ? undefined : String(filter.key);
    return this.models.Grant.as(new Holder(who, ANY))
      .where((g) => (filter.model === undefined || g.model === filter.model) && (key === undefined || g.key === key))
      .filter((g) => (filter.all === true || (g.revoked === 0 && g.expires > now)) && this.#may(who, g))
      .sort((a, b) => b.created - a.created || (a.id < b.id ? -1 : 1))
      .map((g) => info(g, now));
  }

  revoke(user: string, id: string): boolean {
    const who = userId(user, "the user");
    if (typeof id !== "string" || !GRANT_ID.test(id)) return false;
    const as = this.models.Grant.as(new Holder(who, ANY));
    const row = as.get(id);
    const now = this.#now();
    if (!row || row.revoked !== 0 || !(row.expires > now) || !this.#may(who, row)) return false;
    return as.update((g) => g.id === id && g.revoked === 0, { revoked: now, revokedBy: who }) === 1;
  }

  revokeAll(user: string, model: string, key: string | number): number {
    return this.list(user, { model, key }).filter((g) => this.revoke(user, g.id)).length;
  }

  purge(keepMs: number = 30 * DAY): number {
    if (!Number.isFinite(keepMs) || keepMs < 0) throw new GrantError("invalid", "keepMs is a number of milliseconds");
    const before = this.#now() - keepMs;
    return this.models.Grant.as(SYSTEM).delete((g) => (g.revoked !== 0 && g.revoked < before) || g.expires < before);
  }
}

export function defineGrants(cfg: GrantsConfig = {}): Grants {
  return new Grants(cfg);
}
