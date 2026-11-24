import { timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { defineModel, type Model, type PolicyExpr } from "@weft-framework/data";
import { AccessError } from "./errors.ts";
import { hashToken, newToken } from "./tokens.ts";

export interface ApiKeysConfig<S extends string> {
  prefix: string;
  scopes: readonly S[];
  accept?: readonly string[];
  max?: number;
  maxDays?: number;
  model?: string;
  now?: () => number;
}

export interface ApiKeyRow {
  id: string;
  owner: string;
  tenant: string | null;
  name: string;
  prefix: string;
  hash: string;
  scopes: string[];
  ips: string[];
  expires: number | null;
  lastUsed: number | null;
  lastIp: string | null;
  created: number;
}

export interface ApiKeyInfo<S extends string = string> {
  id: string;
  owner: string;
  tenant: string | null;
  name: string;
  prefix: string;
  scopes: S[];
  ips: string[];
  expires: number | null;
  lastUsed: number | null;
  lastIp: string | null;
  created: number;
}

export interface VerifiedApiKey<S extends string = string> {
  id: string;
  owner: string;
  tenant: string | null;
  scopes: S[];
}

export interface ApiKeyInput<S extends string> {
  name: string;
  scopes: readonly S[];
  expiresDays?: number | null;
  ips?: readonly string[];
  tenant?: string | null;
}

type CleanKey = Omit<ApiKeyRow, "id" | "prefix" | "hash" | "lastUsed" | "lastIp" | "created">;

class Keyring {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
    Object.freeze(this);
  }
}

const SYSTEM = new Keyring("api-keys:system");
const allowed = (a: unknown): boolean => a instanceof Keyring;
const where: PolicyExpr = { truthy: { actor: ["id"] } };
const PREFIX_RE = /^[a-z][a-z0-9]{0,15}_(?:[a-z0-9]{1,15}_)?$/;
const MODEL_RE = /^[A-Z][A-Za-z0-9]{0,31}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;
const DAY = 86_400_000;
const invalid = (msg: string): AccessError => new AccessError("invalid", msg);

export function parseCidr(raw: string): { address: string; prefix: number; type: "ipv4" | "ipv6" } | null {
  if (typeof raw !== "string") return null;
  const [address, bits, extra] = raw.trim().split("/");
  if (!address || extra !== undefined) return null;
  const v = isIP(address);
  if (v === 0) return null;
  const max = v === 4 ? 32 : 128;
  if (bits !== undefined && !/^\d{1,3}$/.test(bits)) return null;
  const prefix = bits === undefined ? max : Number(bits);
  if (prefix > max) return null;
  return { address, prefix, type: v === 4 ? "ipv4" : "ipv6" };
}

export function ipAllowed(ip: string | null, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  if (ip === null) return false;
  const v = isIP(ip);
  if (v === 0) return false;
  const list = new BlockList();
  for (const a of allowed) {
    const c = parseCidr(a);
    if (c) list.addSubnet(c.address, c.prefix, c.type);
  }
  return list.check(ip, v === 4 ? "ipv4" : "ipv6");
}

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== "string" || CONTROL_RE.test(v)) throw invalid(`${what} is text`);
  const t = v.trim();
  if (t === "" || t.length > max) throw invalid(`${what} is 1-${max} characters`);
  return t;
}

export class ApiKeys<S extends string = string> {
  readonly models: { ApiKey: Model<ApiKeyRow> };
  readonly scopes: readonly S[];
  readonly #prefix: string;
  readonly #accept: readonly string[];
  readonly #max: number;
  readonly #maxDays: number;
  readonly #now: () => number;

  constructor(cfg: ApiKeysConfig<S>) {
    if (!cfg || typeof cfg !== "object") throw invalid("defineApiKeys: a configuration object is required");
    if (typeof cfg.prefix !== "string" || !PREFIX_RE.test(cfg.prefix)) {
      throw invalid("defineApiKeys: prefix is lowercase and ends with _, like \"acme_\" or \"acme_live_\"");
    }
    const accept = [...(cfg.accept ?? [])];
    for (const p of accept) {
      if (typeof p !== "string" || !/^[A-Za-z][A-Za-z0-9_]{1,15}$/.test(p)) throw invalid(`defineApiKeys: accepted prefix ${JSON.stringify(p)} is 2-16 letters, digits or _`);
    }
    if (!Array.isArray(cfg.scopes) || cfg.scopes.length === 0) throw invalid("defineApiKeys: declare at least one scope");
    for (const s of cfg.scopes) {
      if (typeof s !== "string" || !/^[a-z][a-z0-9_-]*(?:[.:][a-z0-9_*-]+)*$/.test(s) || s.length > 64) {
        throw invalid(`defineApiKeys: scope ${JSON.stringify(s)} is lowercase words joined by . or :`);
      }
    }
    if (new Set(cfg.scopes).size !== cfg.scopes.length) throw invalid("defineApiKeys: scopes are distinct");
    const max = cfg.max ?? 50;
    if (!Number.isInteger(max) || max < 1 || max > 10_000) throw invalid("defineApiKeys: max is 1 to 10000 keys per owner");
    const maxDays = cfg.maxDays ?? 3650;
    if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 36_500) throw invalid("defineApiKeys: maxDays is 1 to 36500");
    const model = cfg.model ?? "ApiKey";
    if (!MODEL_RE.test(model)) throw invalid("defineApiKeys: model is a model name");
    this.scopes = Object.freeze([...cfg.scopes]);
    this.#prefix = cfg.prefix;
    this.#accept = Object.freeze([cfg.prefix, ...accept]);
    this.#max = max;
    this.#maxDays = maxDays;
    this.#now = cfg.now ?? Date.now;
    this.models = {
      ApiKey: defineModel<ApiKeyRow>(model, {
        fields: {
          id: "string",
          owner: "string",
          tenant: "string | null",
          name: "string",
          prefix: "string",
          hash: "string",
          scopes: "string[]",
          ips: "string[]",
          expires: "number | null",
          lastUsed: "number | null",
          lastIp: "string | null",
          created: "number",
        },
        attrs: { owner: { index: true }, hash: { unique: true } },
        read: allowed,
        write: allowed,
        readWhere: where,
        writeWhere: where,
      }),
    };
  }

  #keys() {
    return this.models.ApiKey.as(SYSTEM);
  }

  #info(r: ApiKeyRow): ApiKeyInfo<S> {
    return {
      id: r.id,
      owner: r.owner,
      tenant: r.tenant,
      name: r.name,
      prefix: r.prefix,
      scopes: [...r.scopes] as S[],
      ips: [...r.ips],
      expires: r.expires,
      lastUsed: r.lastUsed,
      lastIp: r.lastIp,
      created: r.created,
    };
  }

  #clean(owner: unknown, input: ApiKeyInput<S>): CleanKey {
    if (!input || typeof input !== "object") throw invalid("an API key needs { name, scopes }");
    const who = text(owner, "owner", 200);
    const name = text(input.name, "name", 60);
    if (!Array.isArray(input.scopes)) throw invalid("scopes is a list");
    const scopes = [...new Set(input.scopes)];
    for (const s of scopes) if (!this.scopes.includes(s)) throw invalid(`no scope ${JSON.stringify(String(s).slice(0, 64))}`);
    if (scopes.length === 0) throw invalid("pick at least one scope");
    const ips: string[] = [];
    for (const raw of input.ips ?? []) {
      if (typeof raw !== "string" || raw.trim() === "") continue;
      if (!parseCidr(raw)) throw invalid(`${JSON.stringify(raw.slice(0, 64))} is not an IP address or CIDR range`);
      if (!ips.includes(raw.trim())) ips.push(raw.trim());
    }
    if (ips.length > 50) throw invalid("at most 50 IP ranges");
    const days = input.expiresDays ?? null;
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > this.#maxDays)) throw invalid(`expiry is 1 to ${this.#maxDays} days`);
    const tenant = input.tenant === undefined || input.tenant === null ? null : text(input.tenant, "tenant", 200);
    return { owner: who, tenant, name, scopes: scopes.sort(), ips, expires: days === null ? null : this.#now() + days * DAY };
  }

  async #store(c: CleanKey, secret: string, shown: string): Promise<ApiKeyInfo<S>> {
    const mine = await this.#keys().query().where({ owner: c.owner }).all();
    if (mine.length >= this.#max) throw new AccessError("limit", `at most ${this.#max} API keys`);
    const hash = await hashToken(secret);
    if (await this.#keys().query().where({ hash }).first()) throw new AccessError("conflict", "that key is already stored");
    const row: ApiKeyRow = { id: crypto.randomUUID(), ...c, prefix: shown, hash, lastUsed: null, lastIp: null, created: this.#now() };
    await this.#keys().create(row);
    return this.#info(row);
  }

  async create(owner: string, input: ApiKeyInput<S>): Promise<{ key: ApiKeyInfo<S>; secret: string }> {
    const c = this.#clean(owner, input);
    const secret = this.#prefix + newToken();
    const key = await this.#store(c, secret, secret.slice(0, this.#prefix.length + 6));
    return { key, secret };
  }

  async importKey(owner: string, secret: string, input: ApiKeyInput<S>): Promise<ApiKeyInfo<S>> {
    const c = this.#clean(owner, input);
    if (typeof secret !== "string" || secret.length < 24 || secret.length > 200 || /\s/.test(secret)) {
      throw invalid("an imported key is 24-200 characters without spaces");
    }
    const prefix = this.#accept.find((p) => secret.startsWith(p));
    if (prefix === undefined) throw invalid(`an imported key starts with ${this.#accept.join(", ")}`);
    return this.#store(c, secret, secret.slice(0, prefix.length + 6));
  }

  async list(owner: string): Promise<ApiKeyInfo<S>[]> {
    const who = text(owner, "owner", 200);
    const rows = await this.#keys().query().where({ owner: who }).all();
    return rows.map((r) => this.#info(r)).sort((a, b) => b.created - a.created);
  }

  async all(o: { tenant?: string | null } = {}): Promise<ApiKeyInfo<S>[]> {
    const rows = o.tenant === undefined ? await this.#keys().all() : await this.#keys().where((r) => r.tenant === o.tenant);
    return rows.map((r) => this.#info(r)).sort((a, b) => b.created - a.created);
  }

  async revoke(owner: string | null, id: string): Promise<boolean> {
    if (typeof id !== "string" || id === "") return false;
    const who = owner === null ? null : text(owner, "owner", 200);
    const n = await this.#keys().delete((r) => r.id === id && (who === null || r.owner === who));
    return Number(n) > 0;
  }

  async revokeOwner(owner: string): Promise<number> {
    const who = text(owner, "owner", 200);
    return Number(await this.#keys().delete((r) => r.owner === who));
  }

  async verify(secret: string, ip: string | null = null): Promise<VerifiedApiKey<S> | null> {
    if (typeof secret !== "string" || secret.length > 200 || !this.#accept.some((p) => secret.startsWith(p))) return null;
    const hash = await hashToken(secret);
    const row = await this.#keys().query().where({ hash }).first();
    if (!row || !timingSafeEqual(Buffer.from(row.hash, "hex"), Buffer.from(hash, "hex"))) return null;
    const now = this.#now();
    if (row.expires !== null && row.expires <= now) return null;
    if (!ipAllowed(ip, row.ips)) return null;
    if (row.lastUsed === null || now - row.lastUsed > 60_000 || row.lastIp !== ip) {
      await this.#keys().update((r) => r.id === row.id, { lastUsed: now, lastIp: ip });
    }
    const scopes = row.scopes.filter((s) => this.scopes.includes(s as S)) as S[];
    return { id: row.id, owner: row.owner, tenant: row.tenant, scopes };
  }

  bearer(request: Request): string | null {
    const h = request.headers.get("authorization");
    const m = h ? /^Bearer\s+(\S{1,200})$/i.exec(h.trim()) : null;
    return m ? m[1]! : null;
  }
}

export function defineApiKeys<const S extends string>(cfg: ApiKeysConfig<S>): ApiKeys<S> {
  return new ApiKeys<S>(cfg);
}
