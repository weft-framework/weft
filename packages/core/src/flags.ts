import { createHash } from "node:crypto";
import { defineModel, transaction, type Model, type PolicyExpr } from "@weft-framework/data";
import { AccessError } from "./errors.ts";

export interface FlagConfig {
  description: string;
  default?: boolean;
}

export interface FlagsConfig<F extends string, K extends string> {
  flags?: Record<F, FlagConfig>;
  kills?: Record<K, string>;
  manage: (user: string) => boolean;
  prefix?: string;
  now?: () => number;
}

export interface FlagRow {
  id: string;
  on: boolean;
  percent: number;
  users: string[];
  tenants: string[];
  reason: string;
  updated: number;
  by: string;
}

export interface FlagModels {
  Flag: Model<FlagRow>;
}

export interface FlagInfo {
  name: string;
  description: string;
  default: boolean;
  overridden: boolean;
  on: boolean;
  percent: number;
  users: string[];
  tenants: string[];
  updated: number | null;
  by: string | null;
}

export interface KillInfo {
  name: string;
  description: string;
  killed: boolean;
  reason: string;
  updated: number | null;
  by: string | null;
}

export interface FlagChange {
  on?: boolean;
  percent?: number;
  users?: readonly string[];
  tenants?: readonly string[];
}

class Switchboard {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
    Object.freeze(this);
  }
}

const READER = new Switchboard("flags:system");
const allowed = (a: unknown): boolean => a instanceof Switchboard;
const where: PolicyExpr = { truthy: { actor: ["id"] } };

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const PREFIX_RE = /^[A-Z][A-Za-z0-9]{0,31}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;
const MAX_LIST = 1000;
const invalid = (msg: string): AccessError => new AccessError("invalid", msg);

function id(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "" || v.length > 200 || CONTROL_RE.test(v)) {
    throw invalid(`${what} is a non-empty string of at most 200 characters`);
  }
  return v;
}

function list(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) throw invalid(`${what} is a list of ids`);
  const out = [...new Set(v.map((x) => id(x, `each of ${what}`)))];
  if (out.length > MAX_LIST) throw invalid(`${what}: at most ${MAX_LIST}`);
  return out.sort();
}

export function bucket(flag: string, subject: string): number {
  const h = createHash("sha256").update(flag).update("\0").update(subject).digest();
  return Math.floor((h.readUInt32BE(0) / 0x1_0000_0000) * 100);
}

export class Flags<F extends string = string, K extends string = string> {
  readonly models: FlagModels;
  readonly #flags: Map<string, { description: string; default: boolean }>;
  readonly #kills: Map<string, string>;
  readonly #manage: (user: string) => boolean;
  readonly #now: () => number;

  constructor(cfg: FlagsConfig<F, K>) {
    if (!cfg || typeof cfg !== "object") throw invalid("defineFlags: a configuration object is required");
    if (typeof cfg.manage !== "function") throw invalid("defineFlags: manage(user) is required");
    this.#flags = new Map();
    for (const [name, f] of Object.entries<FlagConfig>((cfg.flags ?? {}) as Record<string, FlagConfig>)) {
      if (!NAME_RE.test(name)) throw invalid(`flag ${JSON.stringify(name)}: a name like "newEditor"`);
      if (!f || typeof f.description !== "string") throw invalid(`flag ${name}: { description } is required`);
      if (f.default !== undefined && typeof f.default !== "boolean") throw invalid(`flag ${name}: default is a boolean`);
      this.#flags.set(name, { description: f.description, default: f.default ?? false });
    }
    this.#kills = new Map();
    for (const [name, d] of Object.entries<string>((cfg.kills ?? {}) as Record<string, string>)) {
      if (!NAME_RE.test(name)) throw invalid(`kill switch ${JSON.stringify(name)}: a name like "checkout"`);
      if (typeof d !== "string") throw invalid(`kill switch ${name}: its value is a description`);
      this.#kills.set(name, d);
    }
    if (this.#flags.size + this.#kills.size === 0) throw invalid("defineFlags: declare at least one flag or kill switch");
    this.#manage = cfg.manage;
    this.#now = cfg.now ?? Date.now;
    const prefix = cfg.prefix ?? "Flag";
    if (!PREFIX_RE.test(prefix)) throw invalid("prefix is a model name");
    this.models = {
      Flag: defineModel<FlagRow>(prefix, {
        fields: {
          id: "string",
          on: "boolean",
          percent: "number",
          users: "string[]",
          tenants: "string[]",
          reason: "string",
          updated: "number",
          by: "string",
        },
        read: allowed,
        write: allowed,
        readWhere: where,
        writeWhere: where,
      }),
    };
  }

  #flag(name: unknown): string {
    if (typeof name !== "string" || !this.#flags.has(name)) throw invalid(`no flag ${JSON.stringify(name)}`);
    return name;
  }

  #kill(name: unknown): string {
    if (typeof name !== "string" || !this.#kills.has(name)) throw invalid(`no kill switch ${JSON.stringify(name)}`);
    return name;
  }

  #row(key: string): FlagRow | undefined {
    return this.models.Flag.as(READER).get(key);
  }

  #by(by: unknown): Switchboard {
    const user = id(by, "the acting user");
    let ok = false;
    try {
      ok = this.#manage(user) === true;
    } catch {
      ok = false;
    }
    if (!ok) throw new AccessError("forbidden", "only people `manage` admits may change flags and kill switches");
    return new Switchboard(user);
  }

  enabled(name: F, who: { user?: string | null; tenant?: string | null } = {}): boolean {
    const flag = this.#flag(name);
    const row = this.#row(`flag:${flag}`);
    if (!row) return this.#flags.get(flag)!.default;
    if (row.on) return true;
    const user = typeof who.user === "string" && who.user !== "" ? who.user : null;
    const tenant = typeof who.tenant === "string" && who.tenant !== "" ? who.tenant : null;
    if (user !== null && row.users.includes(user)) return true;
    if (tenant !== null && row.tenants.includes(tenant)) return true;
    const subject = user ?? tenant;
    return subject !== null && row.percent > 0 && bucket(flag, subject) < row.percent;
  }

  killed(name: K): boolean {
    return this.#row(`kill:${this.#kill(name)}`)?.on === true;
  }

  reason(name: K): string {
    const row = this.#row(`kill:${this.#kill(name)}`);
    return row?.on ? row.reason : "";
  }

  guard(name: K): void {
    if (this.killed(name)) {
      throw new AccessError("forbidden", `${name} is switched off${this.reason(name) ? `: ${this.reason(name)}` : ""}`);
    }
  }

  list(by: string): FlagInfo[] {
    this.#by(by);
    return [...this.#flags].map(([name, f]) => {
      const row = this.#row(`flag:${name}`);
      return {
        name,
        description: f.description,
        default: f.default,
        overridden: row !== undefined,
        on: row ? row.on : f.default,
        percent: row?.percent ?? 0,
        users: row ? [...row.users] : [],
        tenants: row ? [...row.tenants] : [],
        updated: row?.updated ?? null,
        by: row?.by ?? null,
      };
    });
  }

  kills(by: string): KillInfo[] {
    this.#by(by);
    return [...this.#kills].map(([name, description]) => {
      const row = this.#row(`kill:${name}`);
      return {
        name,
        description,
        killed: row?.on === true,
        reason: row?.on ? row.reason : "",
        updated: row?.updated ?? null,
        by: row?.by ?? null,
      };
    });
  }

  set(by: string, name: F, change: FlagChange): FlagInfo {
    const actor = this.#by(by);
    const flag = this.#flag(name);
    if (!change || typeof change !== "object") throw invalid("a change is { on?, percent?, users?, tenants? }");
    const patch: Partial<FlagRow> = {};
    if (change.on !== undefined) {
      if (typeof change.on !== "boolean") throw invalid("on is a boolean");
      patch.on = change.on;
    }
    if (change.percent !== undefined) {
      if (!Number.isInteger(change.percent) || change.percent < 0 || change.percent > 100) throw invalid("percent is a whole number 0-100");
      patch.percent = change.percent;
    }
    if (change.users !== undefined) patch.users = list(change.users, "users");
    if (change.tenants !== undefined) patch.tenants = list(change.tenants, "tenants");
    this.#write(actor, `flag:${flag}`, patch);
    return this.list(by).find((f) => f.name === flag)!;
  }

  reset(by: string, name: F): void {
    const actor = this.#by(by);
    const key = `flag:${this.#flag(name)}`;
    this.models.Flag.as(actor).delete((r) => r.id === key);
  }

  kill(by: string, name: K, reason = ""): void {
    const actor = this.#by(by);
    const kill = this.#kill(name);
    if (typeof reason !== "string" || reason.length > 200 || CONTROL_RE.test(reason)) {
      throw invalid("a reason is one line of at most 200 characters");
    }
    this.#write(actor, `kill:${kill}`, { on: true, reason: reason.trim() });
  }

  restore(by: string, name: K): void {
    const actor = this.#by(by);
    const key = `kill:${this.#kill(name)}`;
    this.models.Flag.as(actor).delete((r) => r.id === key);
  }

  #write(actor: Switchboard, key: string, patch: Partial<FlagRow>): void {
    const as = this.models.Flag.as(actor);
    const stamp = { updated: this.#now(), by: actor.id };
    transaction(() => {
      if (as.get(key)) as.update((r) => r.id === key, { ...patch, ...stamp });
      else as.create({ id: key, on: false, percent: 0, users: [], tenants: [], reason: "", ...patch, ...stamp });
    });
  }
}

export function defineFlags<const F extends string = never, const K extends string = never>(cfg: FlagsConfig<F, K>): Flags<F, K> {
  return new Flags<F, K>(cfg);
}
