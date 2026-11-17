import { defineModel, transaction, type Model, type PolicyExpr } from "@weft-framework/data";
import type { AccessControl, ActingUser } from "./access.ts";
import { AccessError, isAccessError } from "./errors.ts";
import { hashToken, isToken, newToken } from "./tokens.ts";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const CONFIG_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
const TYPE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";

const MAX_TEXT = 256;
const MAX_OPS = 100;
const MAX_MEMBERS = 1000;
const PREFIX_RE = /^[A-Z][A-Za-z0-9]{0,31}$/;

export interface ScimPerson {
  userName: string;
  externalId: string | null;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
  email: string | null;
  active: boolean;
}

export interface ScimConfig<R extends string> {
  access: AccessControl<string, R, string, never> | AccessControl<string, R, string, any>;
  base: string;
  defaultRole: R | `custom:${string}`;
  groups?: Record<string, R | `custom:${string}`>;
  users: {
    create(person: ScimPerson, tenant: string): string | Promise<string>;
    update?(id: string, person: ScimPerson, tenant: string): void | Promise<void>;
    deactivate?(id: string, tenant: string): void | Promise<void>;
  };
  manage?: string;
  prefix?: string;
  maxResults?: number;
  rateLimit?: number;
  now?(): number;
}

export interface ScimUserRow {
  id: string;
  tenant: string;
  user: string;
  userName: string;
  userKey: string;
  externalId: string | null;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
  email: string | null;
  active: boolean;
  created: number;
  updated: number;
}

export interface ScimTokenRow {
  id: string;
  tenant: string;
  by: string;
  name: string;
  created: number;
  lastUsed: number | null;
}

export interface ScimTokenInfo {
  id: string;
  name: string;
  by: string;
  created: number;
  lastUsed: number | null;
}

class Provisioner {
  readonly id: string;
  readonly tenant?: string;
  readonly all?: true;
  constructor(of: { tenant: string } | { all: true }) {
    if ("tenant" in of) {
      this.id = `scim:${of.tenant}`;
      this.tenant = of.tenant;
    } else {
      this.id = "scim:system";
      this.all = true;
    }
    Object.freeze(this);
  }
}

const SYSTEM = new Provisioner({ all: true });
const inTenant = (a: unknown, row: { tenant: string }): boolean =>
  a instanceof Provisioner && (a.all === true || a.tenant === row.tenant);
const tenantWhere: PolicyExpr = {
  or: [{ cmp: "==", l: { field: ["tenant"] }, r: { actor: ["tenant"] } }, { truthy: { actor: ["all"] } }],
};

class ScimError extends Error {
  readonly status: number;
  readonly scimType: string | undefined;
  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
}

const bad = (detail: string, scimType = "invalidValue") => new ScimError(400, detail, scimType);
const notFound = () => new ScimError(404, "Resource not found");

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/scim+json", "cache-control": "no-store", ...headers },
  });
}

function text(v: unknown, what: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw bad(`${what} is a string`);
  const t = v.trim();
  if (t.length > MAX_TEXT) throw bad(`${what} is at most ${MAX_TEXT} characters`);
  return t === "" ? null : t;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && /^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
  throw bad(`${what} is a boolean`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function emailOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > 20) throw bad("emails is a list");
  const list = v.filter(isObject);
  const pick = list.find((e) => e.primary === true || e.primary === "true") ?? list[0];
  return pick ? text(pick.value, "emails.value") : null;
}

function personOf(body: unknown): ScimPerson {
  if (!isObject(body)) throw bad("the body is a User resource", "invalidSyntax");
  const userName = text(body.userName, "userName");
  if (userName === null) throw bad("userName is required");
  const name = isObject(body.name) ? body.name : {};
  return {
    userName,
    externalId: text(body.externalId, "externalId"),
    givenName: text(name.givenName, "name.givenName"),
    familyName: text(name.familyName, "name.familyName"),
    displayName: text(body.displayName, "displayName"),
    email: emailOf(body.emails),
    active: body.active === undefined ? true : bool(body.active, "active"),
  };
}

function parseFilter(f: string | null, attrs: readonly string[]): { attr: string; value: string } | null {
  if (f === null || f.trim() === "") return null;
  if (f.length > 512) throw bad("the filter is too long", "invalidFilter");
  const m = /^\s*([A-Za-z][A-Za-z0-9.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(f);
  const attr = m ? attrs.find((a) => a.toLowerCase() === m[1]!.toLowerCase()) : undefined;
  if (!m || !attr) throw bad(`supported filters: ${attrs.map((a) => `${a} eq "..."`).join(", ")}`, "invalidFilter");
  return { attr, value: m[2]!.replace(/\\(.)/g, "$1") };
}

function page(url: URL, max: number): { start: number; count: number } {
  const n = (k: string, dflt: number) => {
    const v = url.searchParams.get(k);
    if (v === null) return dflt;
    const x = Number(v);
    if (!Number.isInteger(x)) throw bad(`${k} is a whole number`);
    return x;
  };
  return { start: Math.max(1, n("startIndex", 1)), count: Math.min(max, Math.max(0, n("count", max))) };
}

export class Scim<R extends string> {
  readonly models: { ScimUser: Model<ScimUserRow>; ScimToken: Model<ScimTokenRow> };
  readonly #access: ScimConfig<R>["access"];
  readonly #base: string;
  readonly #defaultRole: string;
  readonly #groups: Map<string, string>;
  readonly #users: ScimConfig<R>["users"];
  readonly #manage: string;
  readonly #max: number;
  readonly #rate: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, { window: number; n: number }>();

  constructor(cfg: ScimConfig<R>) {
    if (!cfg || typeof cfg !== "object") throw new Error("defineScim: pass a configuration");
    if (!cfg.access) throw new Error("defineScim: access is the app's access control");
    if (typeof cfg.base !== "string" || !/^\/[A-Za-z0-9/_.-]*[^/]$/.test(cfg.base)) {
      throw new Error("defineScim: base is the mount path, like /api/scim/v2");
    }
    if (typeof cfg.users?.create !== "function") throw new Error("defineScim: users.create makes the account for a person");
    if (typeof cfg.defaultRole !== "string" || cfg.defaultRole === "") throw new Error("defineScim: defaultRole names a role");
    this.#access = cfg.access;
    this.#base = cfg.base;
    this.#defaultRole = cfg.defaultRole;
    this.#groups = new Map(Object.entries(cfg.groups ?? {}));
    for (const [name, role] of this.#groups) {
      if (name.trim() === "" || name.length > MAX_TEXT || typeof role !== "string" || role === "") {
        throw new Error("defineScim: groups maps group names to role names");
      }
    }
    if (new Set(this.#groups.values()).size !== this.#groups.size) throw new Error("defineScim: two groups name the same role");
    this.#users = cfg.users;
    this.#manage = cfg.manage ?? "access.members.manage";
    this.#max = cfg.maxResults ?? 100;
    this.#rate = cfg.rateLimit ?? 600;
    for (const [k, v, lo, hi] of [["maxResults", this.#max, 1, 1000], ["rateLimit", this.#rate, 1, 100_000]] as const) {
      if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`defineScim: ${k} is a whole number from ${lo} to ${hi}`);
    }
    this.#now = cfg.now ?? Date.now;
    const prefix = cfg.prefix ?? "Scim";
    if (!PREFIX_RE.test(prefix)) throw new Error("defineScim: prefix is a model name");
    this.models = {
      ScimUser: defineModel<ScimUserRow>(`${prefix}User`, {
        fields: {
          id: "string", tenant: "string", user: "string", userName: "string", userKey: "string",
          externalId: "string | null", givenName: "string | null", familyName: "string | null",
          displayName: "string | null", email: "string | null", active: "boolean", created: "number", updated: "number",
        },
        attrs: { tenant: { index: true } },
        read: inTenant,
        write: inTenant,
        readWhere: tenantWhere,
        writeWhere: tenantWhere,
      }),
      ScimToken: defineModel<ScimTokenRow>(`${prefix}Token`, {
        fields: { id: "string", tenant: "string", by: "string", name: "string", created: "number", lastUsed: "number | null" },
        attrs: { tenant: { index: true } },
        read: inTenant,
        write: inTenant,
        readWhere: tenantWhere,
        writeWhere: tenantWhere,
      }),
    };
  }

  #requireManage(by: ActingUser, tenant: string): string {
    const user = typeof by === "string" ? by : by?.id;
    if (typeof user !== "string" || typeof tenant !== "string" || !this.#access.memberOf(user, tenant)) {
      throw new AccessError("forbidden", "you may not manage provisioning for this tenant");
    }
    if (!this.#access.allows(user, this.#manage, tenant)) {
      throw new AccessError("forbidden", "you may not manage provisioning for this tenant");
    }
    return user;
  }

  async createToken(by: ActingUser, tenant: string, o: { name: string }): Promise<{ id: string; token: string }> {
    const user = this.#requireManage(by, tenant);
    const name = typeof o?.name === "string" ? o.name.trim() : "";
    if (name === "" || name.length > 100) throw new AccessError("invalid", "name the token (at most 100 characters)");
    const token = newToken();
    const id = await hashToken(token);
    const p = new Provisioner({ tenant });
    if (this.models.ScimToken.as(p).all().length >= 20) throw new AccessError("limit", "a tenant has at most 20 tokens");
    this.models.ScimToken.as(p).create({ id, tenant, by: user, name, created: this.#now(), lastUsed: null });
    return { id: id.slice(0, 12), token };
  }

  tokens(by: ActingUser, tenant: string): ScimTokenInfo[] {
    this.#requireManage(by, tenant);
    return this.models.ScimToken.as(new Provisioner({ tenant }))
      .all()
      .sort((a, b) => a.created - b.created)
      .map((t) => ({ id: t.id.slice(0, 12), name: t.name, by: t.by, created: t.created, lastUsed: t.lastUsed }));
  }

  revokeToken(by: ActingUser, tenant: string, id: string): void {
    this.#requireManage(by, tenant);
    if (typeof id !== "string" || !/^[0-9a-f]{12}$/.test(id)) throw new AccessError("not-found", "no such token");
    const removed = this.models.ScimToken.as(new Provisioner({ tenant })).delete((t) => t.id.startsWith(id));
    if (removed === 0) throw new AccessError("not-found", "no such token");
  }

  people(by: ActingUser, tenant: string): ScimUserRow[] {
    this.#requireManage(by, tenant);
    return this.models.ScimUser.as(new Provisioner({ tenant })).all().sort((a, b) => a.created - b.created);
  }

  async handle(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (url.pathname !== this.#base && !url.pathname.startsWith(this.#base + "/")) throw notFound();
      const parts = url.pathname.slice(this.#base.length).split("/").filter((p) => p !== "").map((p) => decodeURIComponent(p));
      const auth = await this.#authenticate(req);
      if (!auth) {
        return json(401, { schemas: [ERROR_SCHEMA], status: "401", detail: "A valid bearer token is required" }, { "www-authenticate": 'Bearer realm="scim"' });
      }
      if (!this.#allowRate(auth.id)) return json(429, { schemas: [ERROR_SCHEMA], status: "429", detail: "Too many requests" });
      const method = req.method.toUpperCase();
      const body = method === "POST" || method === "PUT" || method === "PATCH" ? await this.#body(req) : undefined;
      const [kind, id, extra] = parts;
      if (extra !== undefined) throw notFound();
      const ctx = { tenant: auth.tenant, by: auth.by, url };
      if (kind === "ServiceProviderConfig" && id === undefined && method === "GET") return json(200, this.#config());
      if (kind === "ResourceTypes" && id === undefined && method === "GET") return json(200, this.#resourceTypes());
      if (kind === "Schemas" && id === undefined && method === "GET") return json(200, this.#list([], 1, 0));
      if (kind === "Users") {
        if (id === undefined && method === "GET") return json(200, this.#listUsers(ctx));
        if (id === undefined && method === "POST") return json(201, await this.#createUser(ctx, body));
        if (id !== undefined && method === "GET") return json(200, this.#userResource(this.#link(ctx.tenant, id), ctx.by));
        if (id !== undefined && method === "PUT") return json(200, await this.#replaceUser(ctx, id, personOf(body)));
        if (id !== undefined && method === "PATCH") return json(200, await this.#patchUser(ctx, id, body));
        if (id !== undefined && method === "DELETE") {
          await this.#deleteUser(ctx, id);
          return json(204, null);
        }
      }
      if (kind === "Groups") {
        if (id === undefined && method === "GET") return json(200, this.#listGroups(ctx));
        if (id === undefined && method === "POST") return json(201, this.#createGroup(ctx, body));
        if (id !== undefined && method === "GET") return json(200, this.#groupResource(ctx.tenant, this.#group(id), ctx.by));
        if (id !== undefined && method === "PATCH") return json(200, this.#patchGroup(ctx, id, body));
        if (id !== undefined && method === "PUT") return json(200, this.#putGroup(ctx, id, body));
        if (id !== undefined && method === "DELETE") throw new ScimError(403, "Groups are the application's roles and cannot be deleted");
      }
      if (["ServiceProviderConfig", "ResourceTypes", "Schemas", "Users", "Groups"].includes(kind ?? "")) {
        return json(405, { schemas: [ERROR_SCHEMA], status: "405", detail: "Method not allowed" });
      }
      throw notFound();
    } catch (err) {
      if (err instanceof ScimError) {
        return json(err.status, { schemas: [ERROR_SCHEMA], status: String(err.status), detail: err.message, ...(err.scimType ? { scimType: err.scimType } : {}) });
      }
      if (isAccessError(err)) {
        const status = err.code === "forbidden" || err.code === "limit" ? 403 : err.code === "not-found" ? 404 : err.code === "last-owner" ? 409 : 400;
        return json(status, { schemas: [ERROR_SCHEMA], status: String(status), detail: err.message });
      }
      if (err instanceof URIError) return json(400, { schemas: [ERROR_SCHEMA], status: "400", detail: "Malformed path" });
      throw err;
    }
  }

  async #authenticate(req: Request): Promise<{ id: string; tenant: string; by: string } | null> {
    const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.get("authorization") ?? "");
    if (!m || !isToken(m[1])) return null;
    const id = await hashToken(m[1]);
    const row = this.models.ScimToken.as(SYSTEM).get(id);
    if (!row) return null;
    if (!this.#access.memberOf(row.by, row.tenant) || !this.#access.allows(row.by, this.#manage, row.tenant)) return null;
    const now = this.#now();
    if (row.lastUsed === null || now - row.lastUsed > 60_000) {
      this.models.ScimToken.as(new Provisioner({ tenant: row.tenant })).update((t) => t.id === id, { lastUsed: now });
    }
    return { id, tenant: row.tenant, by: row.by };
  }

  #allowRate(id: string): boolean {
    const window = Math.floor(this.#now() / 60_000);
    const h = this.#hits.get(id);
    if (!h || h.window !== window) {
      if (this.#hits.size > 10_000) this.#hits.clear();
      this.#hits.set(id, { window, n: 1 });
      return true;
    }
    return ++h.n <= this.#rate;
  }

  async #body(req: Request): Promise<unknown> {
    const raw = await req.text();
    if (raw.length > 1024 * 1024) throw new ScimError(413, "Request too large");
    try {
      return JSON.parse(raw);
    } catch {
      throw bad("the body is JSON", "invalidSyntax");
    }
  }

  #config(): object {
    return {
      schemas: [CONFIG_SCHEMA],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: this.#max },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "A token from the tenant's settings", primary: true }],
    };
  }

  #resourceTypes(): object {
    const t = (id: string, schema: string) => ({
      schemas: [TYPE_SCHEMA], id, name: id, endpoint: `/${id}s`, schema, meta: { resourceType: "ResourceType", location: `${this.#base}/ResourceTypes/${id}` },
    });
    const list = [t("User", USER_SCHEMA), t("Group", GROUP_SCHEMA)];
    return this.#list(list, 1, list.length);
  }

  #list(items: unknown[], start: number, total: number): object {
    return { schemas: [LIST_SCHEMA], totalResults: total, startIndex: start, itemsPerPage: items.length, Resources: items };
  }

  #key(tenant: string, user: string): string {
    return `${tenant}/${user}`;
  }

  #link(tenant: string, user: string): ScimUserRow {
    const row = this.models.ScimUser.as(new Provisioner({ tenant })).get(this.#key(tenant, user));
    if (!row) throw notFound();
    return row;
  }

  #userResource(r: ScimUserRow, by: string): object {
    const groups = this.#rolesOf(r.tenant, r.user, by)
      .map((role) => [...this.#groups].find(([, g]) => g === role)?.[0])
      .filter((g): g is string => g !== undefined)
      .sort()
      .map((g) => ({ value: this.#groupId(g), display: g }));
    const formatted = [r.givenName, r.familyName].filter(Boolean).join(" ");
    return {
      schemas: [USER_SCHEMA],
      id: r.user,
      ...(r.externalId !== null ? { externalId: r.externalId } : {}),
      userName: r.userName,
      name: { ...(r.givenName ? { givenName: r.givenName } : {}), ...(r.familyName ? { familyName: r.familyName } : {}), ...(formatted ? { formatted } : {}) },
      ...(r.displayName !== null ? { displayName: r.displayName } : {}),
      ...(r.email !== null ? { emails: [{ value: r.email, primary: true }] } : {}),
      active: r.active,
      groups,
      meta: {
        resourceType: "User",
        created: new Date(r.created).toISOString(),
        lastModified: new Date(r.updated).toISOString(),
        location: `${this.#base}/Users/${encodeURIComponent(r.user)}`,
      },
    };
  }

  #listUsers(ctx: { tenant: string; by: string; url: URL }): object {
    const f = parseFilter(ctx.url.searchParams.get("filter"), ["userName", "externalId", "emails.value", "id"]);
    let rows = this.models.ScimUser.as(new Provisioner({ tenant: ctx.tenant })).all();
    if (f) {
      const v = f.value;
      rows = rows.filter((r) =>
        f.attr === "userName" ? r.userKey === v.toLowerCase()
        : f.attr === "externalId" ? r.externalId === v
        : f.attr === "emails.value" ? (r.email ?? "").toLowerCase() === v.toLowerCase()
        : r.user === v,
      );
    }
    rows.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
    const { start, count } = page(ctx.url, this.#max);
    return this.#list(rows.slice(start - 1, start - 1 + count).map((r) => this.#userResource(r, ctx.by)), start, rows.length);
  }

  #taken(tenant: string, userName: string, except: string | null): boolean {
    const key = userName.toLowerCase();
    return this.models.ScimUser.as(new Provisioner({ tenant })).all().some((r) => r.userKey === key && r.user !== except);
  }

  async #createUser(ctx: { tenant: string; by: string }, body: unknown): Promise<object> {
    const person = personOf(body);
    if (this.#taken(ctx.tenant, person.userName, null)) throw new ScimError(409, "userName is already provisioned", "uniqueness");
    const user = await this.#users.create(person, ctx.tenant);
    if (typeof user !== "string" || user === "" || user.length > MAX_TEXT) throw new Error("defineScim: users.create returns the account id");
    const p = new Provisioner({ tenant: ctx.tenant });
    const now = this.#now();
    const row: ScimUserRow = {
      id: this.#key(ctx.tenant, user), tenant: ctx.tenant, user, ...this.#fields(person), active: person.active, created: now, updated: now,
    };
    transaction(() => {
      if (this.models.ScimUser.as(p).get(row.id)) throw new ScimError(409, "this account is already provisioned", "uniqueness");
      if (this.#taken(ctx.tenant, person.userName, null)) throw new ScimError(409, "userName is already provisioned", "uniqueness");
      this.models.ScimUser.as(p).create(row);
      if (person.active) this.#access.assign(ctx.by, { user, role: this.#defaultRole as R, scope: ctx.tenant });
    });
    return this.#userResource(row, ctx.by);
  }

  #fields(p: ScimPerson): Pick<ScimUserRow, "userName" | "userKey" | "externalId" | "givenName" | "familyName" | "displayName" | "email"> {
    return {
      userName: p.userName, userKey: p.userName.toLowerCase(), externalId: p.externalId, givenName: p.givenName,
      familyName: p.familyName, displayName: p.displayName, email: p.email,
    };
  }

  #personOf(r: ScimUserRow): ScimPerson {
    return {
      userName: r.userName, externalId: r.externalId, givenName: r.givenName, familyName: r.familyName,
      displayName: r.displayName, email: r.email, active: r.active,
    };
  }

  async #apply(ctx: { tenant: string; by: string }, before: ScimUserRow, next: ScimPerson): Promise<object> {
    if (next.userName.toLowerCase() !== before.userKey && this.#taken(ctx.tenant, next.userName, before.user)) {
      throw new ScimError(409, "userName is already provisioned", "uniqueness");
    }
    const p = new Provisioner({ tenant: ctx.tenant });
    const patch = { ...this.#fields(next), active: next.active, updated: this.#now() };
    transaction(() => {
      if (before.active && !next.active) this.#removeRoles(ctx, before.user);
      if (!before.active && next.active) this.#access.assign(ctx.by, { user: before.user, role: this.#defaultRole as R, scope: ctx.tenant });
      this.models.ScimUser.as(p).update((r) => r.id === before.id, patch);
    });
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((k) => k !== "updated" && k !== "active" && patch[k] !== before[k]);
    if (changed && this.#users.update) await this.#users.update(before.user, next, ctx.tenant);
    if (before.active && !next.active && this.#users.deactivate) await this.#users.deactivate(before.user, ctx.tenant);
    return this.#userResource({ ...before, ...patch }, ctx.by);
  }

  #removeRoles(ctx: { tenant: string; by: string }, user: string): void {
    try {
      this.#access.removeFromTenant(ctx.by, { user, tenant: ctx.tenant });
    } catch (err) {
      if (!isAccessError(err, "not-found")) throw err;
    }
  }

  async #replaceUser(ctx: { tenant: string; by: string }, id: string, person: ScimPerson): Promise<object> {
    return this.#apply(ctx, this.#link(ctx.tenant, id), person);
  }

  async #patchUser(ctx: { tenant: string; by: string }, id: string, body: unknown): Promise<object> {
    const before = this.#link(ctx.tenant, id);
    const next = this.#personOf(before);
    for (const op of this.#ops(body)) {
      if (op.path === null) {
        if (op.op === "remove" || !isObject(op.value)) throw bad("a patch without a path carries an object", "invalidSyntax");
        for (const [k, v] of Object.entries(op.value)) this.#setUser(next, k, v);
      } else if (op.op === "remove") {
        this.#setUser(next, op.path, null);
      } else {
        this.#setUser(next, op.path, op.value);
      }
    }
    return this.#apply(ctx, before, next);
  }

  #setUser(p: ScimPerson, path: string, v: unknown): void {
    const key = path.replace(/^urn:ietf:params:scim:schemas:core:2\.0:User:/i, "").toLowerCase();
    if (key === "active") p.active = bool(v, "active");
    else if (key === "username") {
      const u = text(v, "userName");
      if (u === null) throw bad("userName is required");
      p.userName = u;
    } else if (key === "externalid") p.externalId = text(v, "externalId");
    else if (key === "displayname") p.displayName = text(v, "displayName");
    else if (key === "name.givenname") p.givenName = text(v, "name.givenName");
    else if (key === "name.familyname") p.familyName = text(v, "name.familyName");
    else if (key === "name") {
      const n = isObject(v) ? v : {};
      p.givenName = text(n.givenName, "name.givenName");
      p.familyName = text(n.familyName, "name.familyName");
    } else if (key === "emails") p.email = emailOf(v);
    else if (/^emails\[.*\]\.value$/.test(key)) p.email = text(v, "emails.value");
  }

  async #deleteUser(ctx: { tenant: string; by: string }, id: string): Promise<void> {
    const before = this.#link(ctx.tenant, id);
    transaction(() => {
      this.#removeRoles(ctx, before.user);
      this.models.ScimUser.as(new Provisioner({ tenant: ctx.tenant })).delete((r) => r.id === before.id);
    });
    if (before.active && this.#users.deactivate) await this.#users.deactivate(before.user, ctx.tenant);
  }

  #ops(body: unknown): { op: "add" | "replace" | "remove"; path: string | null; value: unknown }[] {
    if (!isObject(body) || !Array.isArray(body.Operations)) throw bad("a PatchOp has Operations", "invalidSyntax");
    if (Array.isArray(body.schemas) && !body.schemas.includes(PATCH_SCHEMA)) throw bad("not a PatchOp", "invalidSyntax");
    if (body.Operations.length > MAX_OPS) throw bad(`at most ${MAX_OPS} operations`, "tooMany");
    return body.Operations.map((o) => {
      if (!isObject(o) || typeof o.op !== "string") throw bad("each operation has an op", "invalidSyntax");
      const op = o.op.toLowerCase();
      if (op !== "add" && op !== "replace" && op !== "remove") throw bad(`unknown op ${o.op.slice(0, 20)}`, "invalidSyntax");
      const path = o.path === undefined || o.path === null || o.path === "" ? null : text(o.path, "path");
      return { op, path, value: o.value };
    });
  }

  #groupId(name: string): string {
    return this.#groups.get(name)!;
  }

  #group(id: string): string {
    const name = [...this.#groups].find(([, role]) => role === id)?.[0];
    if (name === undefined) throw notFound();
    return name;
  }

  #rolesOf(tenant: string, user: string, by: string): string[] {
    return this.#access.members(by, tenant).filter((m) => m.user === user).map((m) => m.role);
  }

  #groupResource(tenant: string, name: string, by: string, withMembers = true): object {
    const role = this.#groups.get(name)!;
    const provisioned = new Map(this.models.ScimUser.as(new Provisioner({ tenant })).all().map((r) => [r.user, r]));
    const members = withMembers
      ? this.#memberIds(tenant, role, by)
          .filter((u) => provisioned.has(u))
          .map((u) => ({ value: u, display: provisioned.get(u)!.displayName ?? provisioned.get(u)!.userName }))
      : undefined;
    return {
      schemas: [GROUP_SCHEMA],
      id: role,
      displayName: name,
      ...(members ? { members } : {}),
      meta: { resourceType: "Group", location: `${this.#base}/Groups/${encodeURIComponent(role)}` },
    };
  }

  #memberIds(tenant: string, role: string, by: string): string[] {
    return this.#access.members(by, tenant).filter((m) => m.role === role).map((m) => m.user);
  }

  #listGroups(ctx: { tenant: string; by: string; url: URL }): object {
    const f = parseFilter(ctx.url.searchParams.get("filter"), ["displayName", "id"]);
    let names = [...this.#groups.keys()];
    if (f) names = names.filter((n) => (f.attr === "displayName" ? n.toLowerCase() === f.value.toLowerCase() : this.#groups.get(n) === f.value));
    const { start, count } = page(ctx.url, this.#max);
    const brief = /(^|,)\s*members\s*(,|$)/i.test(ctx.url.searchParams.get("excludedAttributes") ?? "");
    return this.#list(names.slice(start - 1, start - 1 + count).map((n) => this.#groupResource(ctx.tenant, n, ctx.by, !brief)), start, names.length);
  }

  #createGroup(ctx: { tenant: string; by: string }, body: unknown): object {
    if (!isObject(body)) throw bad("the body is a Group resource", "invalidSyntax");
    const name = text(body.displayName, "displayName");
    const known = name === null ? undefined : [...this.#groups.keys()].find((n) => n.toLowerCase() === name.toLowerCase());
    if (known === undefined) throw bad("no role is mapped to this group");
    if (body.members !== undefined) this.#setMembers(ctx, this.#groups.get(known)!, this.#memberList(body.members), "add");
    return this.#groupResource(ctx.tenant, known, ctx.by);
  }

  #memberList(v: unknown): string[] {
    if (v === undefined || v === null) return [];
    const list = Array.isArray(v) ? v : [v];
    if (list.length > MAX_MEMBERS) throw bad(`at most ${MAX_MEMBERS} members per operation`, "tooMany");
    return list.map((m) => {
      const id = isObject(m) ? text(m.value, "members.value") : null;
      if (id === null) throw bad("members are { value: id }");
      return id;
    });
  }

  #setMembers(ctx: { tenant: string; by: string }, role: string, ids: string[], how: "add" | "remove" | "replace"): void {
    for (const id of ids) {
      const link = this.#link(ctx.tenant, id);
      if (how !== "remove" && !link.active) throw bad("an inactive user cannot join a group");
    }
    transaction(() => {
      const current = new Set(this.#memberIds(ctx.tenant, role, ctx.by));
      const provisioned = new Set(this.models.ScimUser.as(new Provisioner({ tenant: ctx.tenant })).all().map((r) => r.user));
      const want = new Set(ids);
      if (how !== "remove") {
        for (const id of want) if (!current.has(id)) this.#access.assign(ctx.by, { user: id, role: role as R, scope: ctx.tenant });
      }
      const drop = how === "remove" ? [...want].filter((id) => current.has(id)) : how === "replace" ? [...current].filter((id) => !want.has(id) && provisioned.has(id)) : [];
      for (const id of drop) {
        if (role !== this.#defaultRole) this.#access.revoke(ctx.by, { user: id, role, scope: ctx.tenant });
      }
    });
  }

  #patchGroup(ctx: { tenant: string; by: string; url: URL }, id: string, body: unknown): object {
    const name = this.#group(id);
    for (const op of this.#ops(body)) {
      const path = op.path?.toLowerCase() ?? null;
      const filtered = op.path ? /^members\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]$/i.exec(op.path) : null;
      if (filtered) {
        if (op.op !== "remove") throw bad("only remove takes a member filter", "invalidPath");
        this.#setMembers(ctx, id, [filtered[1]!.replace(/\\(.)/g, "$1")], "remove");
      } else if (path === "members") {
        this.#setMembers(ctx, id, this.#memberList(op.value), op.op);
      } else if (path === null && isObject(op.value)) {
        if (op.value.members !== undefined) this.#setMembers(ctx, id, this.#memberList(op.value.members), op.op === "remove" ? "remove" : op.op);
        if (op.value.displayName !== undefined && text(op.value.displayName, "displayName")?.toLowerCase() !== name.toLowerCase()) {
          throw new ScimError(403, "Group names are the application's");
        }
      } else if (path === "displayname") {
        if (text(op.value, "displayName")?.toLowerCase() !== name.toLowerCase()) throw new ScimError(403, "Group names are the application's");
      } else {
        throw bad(`unsupported path ${String(op.path).slice(0, 40)}`, "invalidPath");
      }
    }
    return this.#groupResource(ctx.tenant, name, ctx.by);
  }

  #putGroup(ctx: { tenant: string; by: string }, id: string, body: unknown): object {
    const name = this.#group(id);
    if (!isObject(body)) throw bad("the body is a Group resource", "invalidSyntax");
    if (body.displayName !== undefined && text(body.displayName, "displayName")?.toLowerCase() !== name.toLowerCase()) {
      throw new ScimError(403, "Group names are the application's");
    }
    this.#setMembers(ctx, id, this.#memberList(body.members), "replace");
    return this.#groupResource(ctx.tenant, name, ctx.by);
  }
}

export function defineScim<R extends string>(cfg: ScimConfig<R>): Scim<R> {
  return new Scim(cfg);
}
