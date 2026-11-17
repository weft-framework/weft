import { inTransaction, noteRead, transaction, type ChangeFeed, type Model } from "@weft/data";
import {
  BUILTIN_PERMISSIONS,
  isPermissionName,
  MAX_LABEL,
  MAX_NAME,
  resolve,
  settingProblem,
  type AccessConfig,
  type BuiltinPermission,
  type CustomPermission,
  type Resolved,
  type SettingConfig,
  type SettingsConfig,
  type SettingValues,
} from "./config.ts";
import { AccessError } from "./errors.ts";
import {
  createModels,
  Reader,
  Writer,
  type InviteRow,
  type MemberRow,
  type Models,
  type PermissionRow,
  type RoleRow,
  type ScopeRow,
  type SettingRow,
} from "./models.ts";
import { hashToken, isToken, newToken } from "./tokens.ts";

export type Permission<P extends string> = P | BuiltinPermission | CustomPermission;

export type RoleName<R extends string> = R | `custom:${string}`;

const APP = "access:app";

export type ActingUser = string | { readonly id: string };

export interface ScopeInfo {
  id: string;
  tenant: string;
  type: string;
  parent: string | null;
  name: string;
  created: number;
}

export interface MemberInfo {
  user: string;
  role: string;
  label: string;
  scope: string;
  inherited: boolean;
  by: string;
  created: number;
}

export interface RoleInfo {
  role: string;
  label: string;
  description: string;
  scopes: string[];
  permissions: string[];
  custom: boolean;
}

export interface CustomRoleInfo extends RoleInfo {
  role: `custom:${string}`;
  custom: true;
}

export interface PermissionDescription {
  name: string;
  label: string;
  description?: string;
  custom: boolean;
  builtin: boolean;
}

export interface InviteInfo {
  id: string;
  tenant: string;
  scope: string;
  role: string;
  email: string | null;
  by: string;
  created: number;
  expires: number;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROOT_ID = new RegExp(`^${UUID}$`);
const CHILD_ID = new RegExp(`^(${UUID})/${UUID}$`);
const CUSTOM_ROLE = "custom:";
const MAX_DEPTH = 32;
const MAX_ROLE_PERMISSIONS = 500;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

function userIdOf(by: ActingUser): string {
  const id = typeof by === "string" ? by : (by as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id === "" || id.length > 256) {
    throw new AccessError("invalid", "a user id is a non-empty string of at most 256 characters");
  }
  return id;
}

function tenantOfId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  if (ROOT_ID.test(id)) return id;
  const m = CHILD_ID.exec(id);
  return m ? m[1] : null;
}

function text(value: unknown, what: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new AccessError("invalid", `${what} must be a string`);
  const v = value.trim();
  if ((!allowEmpty && v === "") || v.length > max) {
    throw new AccessError("invalid", `${what} must be ${allowEmpty ? "at most" : "1 to"} ${max} characters`);
  }
  return v;
}

function options<T extends object>(o: T | undefined | null, what: string): T {
  if (typeof o !== "object" || o === null) throw new AccessError("invalid", `${what}: expected an options object`);
  return o;
}

function forbidden(what: string): never {
  throw new AccessError("forbidden", `not allowed: ${what}`);
}

function memberKey(scope: string, user: string, role: string): string {
  return JSON.stringify([scope, user, role]);
}

function scopeInfo(s: ScopeRow): ScopeInfo {
  return { id: s.id, tenant: s.tenant, type: s.type, parent: s.parent, name: s.name, created: s.created };
}

function inviteInfo(i: InviteRow): InviteInfo {
  return {
    id: i.id,
    tenant: i.tenant,
    scope: i.scope,
    role: i.role,
    email: i.email,
    by: i.by,
    created: i.created,
    expires: i.expires,
  };
}

export class Principal<P extends string = string, V = Record<string, unknown>> {
  readonly id: string;
  readonly #bound: string | undefined;
  readonly #access: AccessControl<P, string, string>;

  constructor(access: AccessControl<P, string, string>, id: string, tenant?: string) {
    this.#access = access;
    this.id = id;
    this.#bound = tenant;
    Object.freeze(this);
  }

  get tenant(): string | undefined {
    const t = this.#bound;
    return t !== undefined && this.#access.memberOf(this.id, t) ? t : undefined;
  }

  can(permission: Permission<P>, scope?: string): boolean {
    const target = this.#target(scope);
    return target !== null && this.#access.allows(this.id, permission, target);
  }

  permissions(scope?: string): string[] {
    const target = this.#target(scope);
    return target === null ? [] : [...this.#access.effective(this.id, target)].sort();
  }

  #target(scope: string | undefined): string | null {
    const target = scope ?? this.#bound;
    if (target === undefined) return null;
    if (this.#bound !== undefined && tenantOfId(target) !== this.#bound) return null;
    return target;
  }

  in(tenant: string): Principal<P, V> | null {
    if (tenantOfId(tenant) !== tenant) return null;
    return this.#access.memberOf(this.id, tenant) ? new Principal<P, V>(this.#access, this.id, tenant) : null;
  }

  setting<K extends keyof V & string>(key: K): V[K] | undefined {
    const t = this.tenant;
    return t === undefined ? undefined : (this.#access.settingValue(t, key) as V[K] | undefined);
  }

  tenants(): ScopeInfo[] {
    return this.#access.tenantsOf(this.id);
  }
}

export class AccessControl<P extends string, R extends string, S extends string, T extends SettingsConfig = {}> {
  readonly models: Models;
  readonly #cfg: Resolved;

  #gen = 0;
  #cachedGen = -1;
  #trees = new Map<string, Map<string, ScopeRow>>();
  #members = new Map<string, MemberRow[]>();
  #roles = new Map<string, Map<string, RoleRow>>();
  #perms = new Map<string, Map<string, PermissionRow>>();
  #settings = new Map<string, Map<string, SettingRow>>();
  #feeds = new Map<string, { feed: ChangeFeed; stop: () => void }>();

  constructor(config: AccessConfig<P, R, S, T>) {
    this.#cfg = resolve(config as unknown as AccessConfig<string, string, string, SettingsConfig>);
    this.models = createModels(this.#cfg.prefix);
    const report = (tenant?: string) => explainText(this.explain(tenant));
    for (const m of Object.values(this.models)) Object.defineProperty(m, EXPLAIN, { value: report });
  }

  user(id: string): Principal<P, SettingValues<T>> {
    return new Principal<P, SettingValues<T>>(this as unknown as AccessControl<P, string, string>, userIdOf(id));
  }

  #fresh(): void {
    for (const m of Object.values(this.models) as Model<unknown>[]) {
      const known = this.#feeds.get(m.name);
      if (known?.feed === m.feed) continue;
      known?.stop();
      const stopChange = m.feed.subscribe((c) => {
        if (c.model === m.name) this.#gen += 1;
      });
      const stopGap = m.feed.onGap(() => {
        this.#gen += 1;
      });
      this.#feeds.set(m.name, {
        feed: m.feed,
        stop: () => {
          stopChange();
          stopGap();
        },
      });
      this.#gen += 1;
    }
    if (this.#cachedGen !== this.#gen) {
      this.#trees.clear();
      this.#members.clear();
      this.#roles.clear();
      this.#perms.clear();
      this.#settings.clear();
      this.#cachedGen = this.#gen;
    }
  }

  #read<T, V>(model: Model<T>, reader: Reader, cache: Map<string, V>, key: string, build: (rows: T[]) => V): V {
    if (inTransaction()) return build(model.as(reader).all());
    this.#fresh();
    const hit = cache.get(key);
    if (hit !== undefined) {
      noteRead(model as Model<unknown>, reader);
      return hit;
    }
    const value = build(model.as(reader).all());
    cache.set(key, value);
    return value;
  }

  #tree(tenant: string): Map<string, ScopeRow> {
    return this.#read(this.models.Scope, new Reader({ tenant }), this.#trees, tenant, (rows) => new Map(rows.map((r) => [r.id, r])));
  }

  #membersOf(user: string): MemberRow[] {
    return this.#read(this.models.Member, new Reader({ user }), this.#members, user, (rows) => rows);
  }

  #customRoles(tenant: string): Map<string, RoleRow> {
    if (this.#cfg.customRoles === 0) return new Map();
    return this.#read(this.models.Role, new Reader({ tenant }), this.#roles, tenant, (rows) => new Map(rows.map((r) => [r.id, r])));
  }

  #customPerms(tenant: string): Map<string, PermissionRow> {
    if (this.#cfg.customPermissions === 0) return new Map();
    return this.#read(this.models.Permission, new Reader({ tenant }), this.#perms, tenant, (rows) => new Map(rows.map((r) => [r.key, r])));
  }

  #storedSettings(tenant: string): Map<string, SettingRow> {
    if (this.#cfg.settings.size === 0) return new Map();
    return this.#read(this.models.Setting, new Reader({ tenant }), this.#settings, tenant, (rows) => new Map(rows.map((r) => [r.key, r])));
  }

  #values(tenant: string): Record<string, unknown> {
    const stored = this.#storedSettings(tenant);
    const out: Record<string, unknown> = {};
    for (const [key, spec] of this.#cfg.settings) {
      out[key] = spec.default;
      const row = stored.get(key);
      if (!row) continue;
      let value: unknown;
      try {
        value = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (settingProblem(spec, value) === null) out[key] = value;
    }
    return out;
  }

  settingValue(tenant: string, key: string): unknown {
    return this.#cfg.settings.has(key) ? this.#values(tenant)[key] : undefined;
  }

  #chain(scope: string): ScopeRow[] {
    const tenant = tenantOfId(scope);
    if (tenant === null) return [];
    const tree = this.#tree(tenant);
    const out: ScopeRow[] = [];
    let at: string | null = scope;
    while (at !== null) {
      const row = tree.get(at);
      if (!row || out.length > MAX_DEPTH || out.some((r) => r.id === at)) return [];
      out.push(row);
      at = row.parent;
    }
    return out[out.length - 1].id === tenant ? out : [];
  }

  #scope(id: string): ScopeRow {
    const row = this.#chain(id)[0];
    if (!row) throw new AccessError("not-found", "no such scope");
    return row;
  }

  #exists(tenant: string, permission: string): boolean {
    if (permission.startsWith("custom.")) return this.#customPerms(tenant).has(permission);
    return this.#cfg.permissions.has(permission);
  }

  #rolePermissions(role: string, tenant: string, type: string): Set<string> {
    if (role.startsWith(CUSTOM_ROLE)) {
      const row = this.#customRoles(tenant).get(role.slice(CUSTOM_ROLE.length));
      if (!row || !row.scopes.includes(type)) return new Set();
      return new Set(row.permissions.filter((p) => this.#exists(tenant, p)));
    }
    const r = this.#cfg.roles.get(role);
    if (!r || !r.scopes.has(type)) return new Set();
    if (!r.all) return r.permissions;
    return new Set([...this.#cfg.permissions.keys(), ...this.#customPerms(tenant).keys()]);
  }

  effective(user: string, scope: string): Set<string> {
    const chain = this.#chain(scope);
    const out = new Set<string>();
    if (chain.length === 0) return out;
    const tenant = chain[0].tenant;
    const on = new Map(chain.map((s) => [s.id, s]));
    for (const m of this.#membersOf(user)) {
      const held = m.tenant === tenant ? on.get(m.scope) : undefined;
      if (!held) continue;
      for (const p of this.#rolePermissions(m.role, tenant, held.type)) out.add(p);
    }
    return out;
  }

  allows(user: string, permission: string, scope: string): boolean {
    if (typeof permission !== "string" || !isPermissionName(permission)) return false;
    return this.effective(user, scope).has(permission);
  }

  memberOf(user: string, tenant: string): boolean {
    return this.#membersOf(user).some((m) => m.tenant === tenant) && this.#chain(tenant).length === 1;
  }

  get seatSetting(): string | null {
    return this.#cfg.seats;
  }

  seatUse(tenant: string): { used: number; setting: string | null; limit: number | null } {
    if (tenantOfId(tenant) !== tenant || this.#chain(tenant).length !== 1) throw new AccessError("not-found", "no such tenant");
    const used = new Set(this.models.Member.as(new Writer(APP, tenant)).all().map((m) => m.user)).size;
    const key = this.#cfg.seats;
    return { used, setting: key, limit: key === null ? null : (this.#values(tenant)[key] as number) };
  }

  tenantsOf(user: string): ScopeInfo[] {
    const ids = [...new Set(this.#membersOf(user).map((m) => m.tenant))];
    return ids
      .map((t) => this.#chain(t)[0])
      .filter((s): s is ScopeRow => s !== undefined)
      .map(scopeInfo)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  #require(by: string, permission: BuiltinPermission, scope: string, what: string): ScopeRow {
    const row = this.#chain(scope)[0];
    if (!row) {
      const tenant = tenantOfId(scope);
      if (tenant !== null && this.memberOf(by, tenant)) throw new AccessError("not-found", "no such scope");
      forbidden(what);
    }
    if (!this.effective(by, row.id).has(permission)) forbidden(what);
    return row;
  }

  #noEscalation(by: string, role: string, on: ScopeRow, what: string): void {
    const mine = this.effective(by, on.id);
    for (const p of this.#rolePermissions(role, on.tenant, on.type)) {
      if (!mine.has(p)) forbidden(`${what} (it includes \`${p}\`, which you do not hold here)`);
    }
  }

  #role(role: unknown, on: ScopeRow): string {
    if (typeof role !== "string") throw new AccessError("invalid", "role must be a string");
    if (role.startsWith(CUSTOM_ROLE)) {
      const id = role.slice(CUSTOM_ROLE.length);
      const row = tenantOfId(id) === on.tenant ? this.#customRoles(on.tenant).get(id) : undefined;
      if (!row) throw new AccessError("not-found", "no such role");
      if (!row.scopes.includes(on.type)) throw new AccessError("invalid", `role \`${row.name}\` cannot be given on a ${on.type}`);
      return role;
    }
    const r = this.#cfg.roles.get(role);
    if (!r) throw new AccessError("not-found", "no such role");
    if (!r.scopes.has(on.type)) throw new AccessError("invalid", `role \`${role}\` cannot be given on a ${on.type}`);
    return role;
  }

  #changed(): void {
    this.#gen += 1;
  }

  createTenant(owner: ActingUser, opts: { name: string; type?: S }): ScopeInfo {
    const user = userIdOf(owner);
    options(opts, "createTenant");
    if (!this.#cfg.canCreateTenant(user)) forbidden("create a tenant");
    const roots = [...this.#cfg.scopes].filter(([t, s]) => s.root && this.#cfg.roles.get(this.#cfg.owner)!.scopes.has(t)).map(([t]) => t);
    const type: string = opts.type ?? roots[0];
    if (!roots.includes(type)) throw new AccessError("invalid", `\`${String(type)}\` is not a root scope type the owner role can hold`);
    const name = text(opts.name, "name", MAX_NAME);
    const id = crypto.randomUUID();
    const now = this.#cfg.now();
    const row: ScopeRow = { id, tenant: id, type, parent: null, name, created: now };
    const w = new Writer(user, id);
    transaction(() => {
      this.models.Scope.as(w).create(row);
      this.models.Member.as(w).create({
        id: memberKey(id, user, this.#cfg.owner),
        tenant: id,
        scope: id,
        user,
        role: this.#cfg.owner,
        by: user,
        created: now,
      });
    });
    this.#changed();
    return scopeInfo(row);
  }

  createScope(by: ActingUser, opts: { type: S; parent: string; name: string }): ScopeInfo {
    const user = userIdOf(by);
    options(opts, "createScope");
    const parent = this.#require(user, "access.scopes.manage", opts.parent, "create scopes here");
    const t = this.#cfg.scopes.get(opts.type);
    if (!t || t.root) throw new AccessError("invalid", `\`${String(opts.type)}\` is not a child scope type`);
    if (!t.parents.has(parent.type)) throw new AccessError("invalid", `a ${opts.type} cannot be inside a ${parent.type}`);
    if (this.#chain(parent.id).length >= MAX_DEPTH) throw new AccessError("invalid", "scopes are nested too deeply");
    const row: ScopeRow = {
      id: `${parent.tenant}/${crypto.randomUUID()}`,
      tenant: parent.tenant,
      type: opts.type,
      parent: parent.id,
      name: text(opts.name, "name", MAX_NAME),
      created: this.#cfg.now(),
    };
    this.models.Scope.as(new Writer(user, parent.tenant)).create(row);
    this.#changed();
    return scopeInfo(row);
  }

  renameScope(by: ActingUser, scope: string, name: string): ScopeInfo {
    const user = userIdOf(by);
    const row = this.#managed(user, scope, "rename");
    const next = text(name, "name", MAX_NAME);
    this.models.Scope.as(new Writer(user, row.tenant)).update((s) => s.id === row.id, { name: next });
    this.#changed();
    return scopeInfo({ ...row, name: next });
  }

  #managed(user: string, scope: string, verb: string): ScopeRow {
    const row = this.#chain(scope)[0];
    if (row?.parent === null) return this.#require(user, "access.tenant.manage", scope, `${verb} the tenant`);
    if (!row) return this.#require(user, "access.scopes.manage", scope, `${verb} this scope`);
    this.#require(user, "access.scopes.manage", row.parent, `${verb} this scope`);
    return row;
  }

  deleteScope(by: ActingUser, scope: string): void {
    const user = userIdOf(by);
    const row = this.#managed(user, scope, "delete");
    const root = row.parent === null;
    const w = new Writer(user, row.tenant);
    transaction(() => {
      const scopes = this.models.Scope.as(w).all();
      const doomed = new Set<string>([row.id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const s of scopes) {
          if (s.parent !== null && doomed.has(s.parent) && !doomed.has(s.id)) {
            doomed.add(s.id);
            grew = true;
          }
        }
      }
      this.models.Member.as(w).delete((m) => doomed.has(m.scope));
      this.models.Invite.as(w).delete((i) => doomed.has(i.scope));
      if (root) {
        this.models.Role.as(w).delete(() => true);
        this.models.Permission.as(w).delete(() => true);
        this.models.Setting.as(w).delete(() => true);
      }
      this.models.Scope.as(w).delete((s) => doomed.has(s.id));
    });
    this.#changed();
  }

  scope(by: ActingUser, scope: string): ScopeInfo | null {
    const user = userIdOf(by);
    const row = this.#chain(scope)[0];
    if (!row) return null;
    return this.#visible(user, row.tenant).has(row.id) ? scopeInfo(row) : null;
  }

  scopes(by: ActingUser, tenant: string): ScopeInfo[] {
    const user = userIdOf(by);
    if (tenantOfId(tenant) !== tenant) return [];
    const visible = this.#visible(user, tenant);
    return [...this.#tree(tenant).values()]
      .filter((s) => visible.has(s.id))
      .map(scopeInfo)
      .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  }

  #visible(user: string, tenant: string): Set<string> {
    const held = new Set(this.#membersOf(user).filter((m) => m.tenant === tenant).map((m) => m.scope));
    const out = new Set<string>();
    if (held.size === 0) return out;
    for (const s of this.#tree(tenant).values()) {
      const chain = this.#chain(s.id);
      if (chain.some((c) => held.has(c.id))) out.add(s.id);
      if (held.has(s.id)) for (const c of chain) out.add(c.id);
    }
    return out;
  }

  assign(by: ActingUser, opts: { user: string; role: RoleName<R>; scope: string }): MemberInfo {
    const actor = userIdOf(by);
    options(opts, "assign");
    const target = userIdOf(opts.user);
    const on = this.#require(actor, "access.members.manage", opts.scope, "manage members here");
    const role = this.#role(opts.role, on);
    this.#noEscalation(actor, role, on, "give this role");
    return this.#give(actor, actor, target, role, on);
  }

  #give(writer: string, by: string, user: string, role: string, on: ScopeRow): MemberInfo {
    const key = memberKey(on.id, user, role);
    const w = new Writer(writer, on.tenant);
    const row = transaction(() => {
      const existing = this.models.Member.as(w).get(key);
      if (existing) return existing;
      this.#seatFor(w, user);
      const fresh: MemberRow = { id: key, tenant: on.tenant, scope: on.id, user, role, by, created: this.#cfg.now() };
      this.models.Member.as(w).create(fresh);
      return fresh;
    });
    this.#changed();
    return this.#memberInfo(row, false);
  }

  #seatFor(w: Writer, user: string | null): void {
    const key = this.#cfg.seats;
    if (key === null) return;
    const members = this.models.Member.as(w).all();
    if (user !== null && members.some((m) => m.user === user)) return;
    const taken = new Set(members.map((m) => m.user)).size;
    if (taken >= (this.#values(w.tenant)[key] as number)) throw new AccessError("limit", "the tenant has no free seat");
  }

  #memberInfo(m: MemberRow, inherited: boolean): MemberInfo {
    const label = m.role.startsWith(CUSTOM_ROLE)
      ? (this.#customRoles(m.tenant).get(m.role.slice(CUSTOM_ROLE.length))?.name ?? m.role)
      : (this.#cfg.roles.get(m.role)?.label ?? m.role);
    return { user: m.user, role: m.role, label, scope: m.scope, inherited, by: m.by, created: m.created };
  }

  revoke(by: ActingUser, opts: { user: string; role: string; scope: string }): void {
    const actor = userIdOf(by);
    options(opts, "revoke");
    const target = userIdOf(opts.user);
    const on =
      actor === target
        ? this.#scope(opts.scope)
        : this.#require(actor, "access.members.manage", opts.scope, "manage members here");
    const key = memberKey(on.id, target, String(opts.role));
    const w = new Writer(actor, on.tenant);
    transaction(() => {
      const row = this.models.Member.as(w).get(key);
      if (!row) throw new AccessError("not-found", "no such member");
      if (actor !== target) this.#noEscalation(actor, row.role, on, "take this role away");
      if (row.role === this.#cfg.owner && on.parent === null && this.#owners(w).filter((m) => m.user !== target).length === 0) {
        throw new AccessError("last-owner", "a tenant needs at least one owner");
      }
      this.models.Member.as(w).delete((m) => m.id === key);
    });
    this.#changed();
  }

  #owners(w: Writer): MemberRow[] {
    return this.models.Member.as(w).where((m) => m.scope === w.tenant && m.role === this.#cfg.owner);
  }

  removeFromTenant(by: ActingUser, opts: { user: string; tenant: string }): void {
    const actor = userIdOf(by);
    options(opts, "removeFromTenant");
    const target = userIdOf(opts.user);
    const root =
      actor === target
        ? this.#scope(opts.tenant)
        : this.#require(actor, "access.members.manage", opts.tenant, "manage members here");
    if (root.parent !== null) throw new AccessError("invalid", "not a tenant");
    const w = new Writer(actor, root.tenant);
    transaction(() => {
      const held = this.models.Member.as(w).where((m) => m.user === target);
      if (held.length === 0) throw new AccessError("not-found", "no such member");
      if (actor !== target) {
        for (const m of held) this.#noEscalation(actor, m.role, this.#scope(m.scope), "remove this member");
      }
      if (held.some((m) => m.scope === root.id && m.role === this.#cfg.owner)) {
        if (this.#owners(w).filter((m) => m.user !== target).length === 0) {
          throw new AccessError("last-owner", "a tenant needs at least one owner");
        }
      }
      this.models.Member.as(w).delete((m) => m.user === target);
    });
    this.#changed();
  }

  members(by: ActingUser, scope: string, opts: { inherited?: boolean } = {}): MemberInfo[] {
    const actor = userIdOf(by);
    const on = this.#require(actor, "access.members.read", scope, "see members here");
    const ids = new Set(opts.inherited ? this.#chain(on.id).map((s) => s.id) : [on.id]);
    return this.models.Member.as(new Reader({ tenant: on.tenant }))
      .where((m) => ids.has(m.scope))
      .map((m) => this.#memberInfo(m, m.scope !== on.id))
      .sort((a, b) => a.created - b.created || a.user.localeCompare(b.user) || a.role.localeCompare(b.role));
  }

  permissionList(by: ActingUser, tenant: string): PermissionDescription[] {
    const actor = userIdOf(by);
    if (!this.memberOf(actor, tenant)) forbidden("see this tenant");
    const out: PermissionDescription[] = [];
    for (const [name, info] of this.#cfg.permissions) {
      out.push({ name, ...info, custom: false, builtin: Object.hasOwn(BUILTIN_PERMISSIONS, name) });
    }
    for (const p of this.#customPerms(tenant).values()) {
      out.push({ name: p.key, label: p.label, ...(p.description ? { description: p.description } : {}), custom: true, builtin: false });
    }
    return out;
  }

  roleList(by: ActingUser, tenant: string): RoleInfo[] {
    const actor = userIdOf(by);
    if (!this.memberOf(actor, tenant)) forbidden("see this tenant");
    const out: RoleInfo[] = [];
    for (const [role, r] of this.#cfg.roles) {
      out.push({
        role,
        label: r.label,
        description: r.description ?? "",
        scopes: [...r.scopes],
        permissions: r.all ? ["*"] : [...r.permissions].sort(),
        custom: false,
      });
    }
    for (const row of this.#customRoles(tenant).values()) out.push(this.#roleInfo(row));
    return out;
  }

  #roleInfo(row: RoleRow): CustomRoleInfo {
    return {
      role: `custom:${row.id}`,
      label: row.name,
      description: row.description,
      scopes: [...row.scopes],
      permissions: row.permissions.filter((p) => this.#exists(row.tenant, p)).sort(),
      custom: true,
    };
  }

  #tenantRoot(by: string, tenant: string, permission: BuiltinPermission, what: string): ScopeRow {
    const root = this.#require(by, permission, tenant, what);
    if (root.parent !== null) throw new AccessError("invalid", `${what}: not a tenant`);
    return root;
  }

  definePermission(by: ActingUser, opts: { tenant: string; name: string; label: string; description?: string }): PermissionDescription {
    const actor = userIdOf(by);
    options(opts, "definePermission");
    if (this.#cfg.customPermissions === 0) throw new AccessError("invalid", "custom permissions are not enabled");
    const root = this.#tenantRoot(actor, opts.tenant, "access.permissions.manage", "manage permissions");
    const key = `custom.${String(opts.name)}`;
    if (!isPermissionName(key)) throw new AccessError("invalid", "a permission name is lowercase letters, digits, `-`, `_` and dots");
    const label = text(opts.label, "label", MAX_LABEL);
    const description = text(opts.description ?? "", "description", MAX_LABEL, true);
    const w = new Writer(actor, root.tenant);
    transaction(() => {
      const existing = this.models.Permission.as(w).all();
      if (existing.some((p) => p.key === key)) throw new AccessError("conflict", `\`${key}\` already exists`);
      if (existing.length >= this.#cfg.customPermissions) throw new AccessError("limit", "too many custom permissions");
      this.models.Permission.as(w).create({
        id: JSON.stringify([root.tenant, key]),
        tenant: root.tenant,
        key,
        label,
        description,
        created: this.#cfg.now(),
      });
    });
    this.#changed();
    return { name: key, label, ...(description ? { description } : {}), custom: true, builtin: false };
  }

  deletePermission(by: ActingUser, opts: { tenant: string; name: string }): void {
    const actor = userIdOf(by);
    options(opts, "deletePermission");
    const root = this.#tenantRoot(actor, opts.tenant, "access.permissions.manage", "manage permissions");
    const name = String(opts.name);
    const key = name.startsWith("custom.") ? name : `custom.${name}`;
    if (!this.#customPerms(root.tenant).has(key)) throw new AccessError("not-found", "no such permission");
    if (!this.effective(actor, root.id).has(key)) forbidden(`delete \`${key}\`, which you do not hold`);
    const w = new Writer(actor, root.tenant);
    transaction(() => {
      for (const role of this.models.Role.as(w).where((r) => r.permissions.includes(key))) {
        this.models.Role.as(w).update((r) => r.id === role.id, {
          permissions: role.permissions.filter((p) => p !== key),
          updated: this.#cfg.now(),
        });
      }
      this.models.Permission.as(w).delete((p) => p.key === key);
    });
    this.#changed();
  }

  #roleShape(root: ScopeRow, actor: string, scopes: readonly unknown[], permissions: readonly unknown[]): { scopes: string[]; permissions: string[] } {
    if (!Array.isArray(scopes) || !Array.isArray(permissions)) throw new AccessError("invalid", "scopes and permissions are lists");
    const s = [...new Set(scopes)];
    if (s.length === 0) throw new AccessError("invalid", "a role names the scope types it can be given on");
    for (const t of s) {
      if (typeof t !== "string" || !this.#cfg.scopes.has(t)) throw new AccessError("invalid", `unknown scope type \`${String(t)}\``);
    }
    const p = [...new Set(permissions)];
    if (p.length > MAX_ROLE_PERMISSIONS) throw new AccessError("invalid", "too many permissions in one role");
    const mine = this.effective(actor, root.id);
    for (const x of p) {
      if (typeof x !== "string" || !this.#exists(root.tenant, x)) throw new AccessError("invalid", `unknown permission \`${String(x)}\``);
      if (!mine.has(x)) forbidden(`a role with \`${x}\`, which you do not hold`);
    }
    return { scopes: s as string[], permissions: (p as string[]).sort() };
  }

  createRole(
    by: ActingUser,
    opts: { tenant: string; name: string; description?: string; scopes: readonly S[]; permissions: readonly Permission<P>[] },
  ): CustomRoleInfo {
    const actor = userIdOf(by);
    options(opts, "createRole");
    if (this.#cfg.customRoles === 0) throw new AccessError("invalid", "custom roles are not enabled");
    const root = this.#tenantRoot(actor, opts.tenant, "access.roles.manage", "manage roles");
    const shape = this.#roleShape(root, actor, opts.scopes, opts.permissions);
    const name = text(opts.name, "name", MAX_NAME);
    const description = text(opts.description ?? "", "description", MAX_LABEL, true);
    const now = this.#cfg.now();
    const row: RoleRow = { id: `${root.tenant}/${crypto.randomUUID()}`, tenant: root.tenant, name, description, ...shape, created: now, updated: now };
    const w = new Writer(actor, root.tenant);
    transaction(() => {
      const roles = this.models.Role.as(w).all();
      if (roles.length >= this.#cfg.customRoles) throw new AccessError("limit", "too many custom roles");
      this.#uniqueName(roles, name, null);
      this.models.Role.as(w).create(row);
    });
    this.#changed();
    return this.#roleInfo(row);
  }

  #uniqueName(roles: RoleRow[], name: string, self: string | null): void {
    const lower = name.toLowerCase();
    if (this.#cfg.roles.has(name) || roles.some((r) => r.id !== self && r.name.toLowerCase() === lower)) {
      throw new AccessError("conflict", `a role named \`${name}\` already exists`);
    }
  }

  updateRole(
    by: ActingUser,
    role: string,
    opts: { name?: string; description?: string; scopes?: readonly S[]; permissions?: readonly Permission<P>[] },
  ): CustomRoleInfo {
    const actor = userIdOf(by);
    options(opts, "updateRole");
    const { row, root } = this.#customRole(actor, role, "change");
    const shape = this.#roleShape(root, actor, opts.scopes ?? row.scopes, opts.permissions ?? this.#roleInfo(row).permissions);
    const name = opts.name === undefined ? row.name : text(opts.name, "name", MAX_NAME);
    const description = opts.description === undefined ? row.description : text(opts.description, "description", MAX_LABEL, true);
    const next: RoleRow = { ...row, name, description, ...shape, updated: this.#cfg.now() };
    const w = new Writer(actor, root.tenant);
    transaction(() => {
      this.#uniqueName(this.models.Role.as(w).all(), name, row.id);
      this.models.Role.as(w).update((r) => r.id === row.id, {
        name,
        description,
        scopes: shape.scopes,
        permissions: shape.permissions,
        updated: next.updated,
      });
    });
    this.#changed();
    return this.#roleInfo(next);
  }

  deleteRole(by: ActingUser, role: string): void {
    const actor = userIdOf(by);
    const { row, root } = this.#customRole(actor, role, "delete");
    const name = CUSTOM_ROLE + row.id;
    const w = new Writer(actor, root.tenant);
    transaction(() => {
      this.models.Member.as(w).delete((m) => m.role === name);
      this.models.Invite.as(w).delete((i) => i.role === name);
      this.models.Role.as(w).delete((r) => r.id === row.id);
    });
    this.#changed();
  }

  #customRole(actor: string, role: string, verb: string): { row: RoleRow; root: ScopeRow } {
    if (typeof role !== "string" || !role.startsWith(CUSTOM_ROLE)) throw new AccessError("invalid", "not a custom role");
    const id = role.slice(CUSTOM_ROLE.length);
    const tenant = tenantOfId(id);
    if (tenant === null || id === tenant) throw new AccessError("not-found", "no such role");
    const root = this.#tenantRoot(actor, tenant, "access.roles.manage", "manage roles");
    const row = this.#customRoles(tenant).get(id);
    if (!row) throw new AccessError("not-found", "no such role");
    const mine = this.effective(actor, root.id);
    for (const p of row.permissions) {
      if (this.#exists(root.tenant, p) && !mine.has(p)) forbidden(`${verb} a role with \`${p}\`, which you do not hold`);
    }
    return { row, root };
  }

  settings(by: ActingUser, tenant: string): SettingValues<T> {
    const actor = userIdOf(by);
    if (tenantOfId(tenant) !== tenant || !this.memberOf(actor, tenant)) forbidden("see this tenant");
    return this.#values(tenant) as SettingValues<T>;
  }

  updateSettings(by: ActingUser, tenant: string, patch: Partial<SettingValues<T>>): SettingValues<T> {
    const actor = userIdOf(by);
    const root = this.#tenantRoot(actor, tenant, "access.settings.manage", "change settings");
    this.#writeSettings(new Writer(actor, root.tenant), this.#settingPatch(patch, true));
    return this.#values(root.tenant) as SettingValues<T>;
  }

  configureTenant(tenant: string, patch: Partial<SettingValues<T>>): SettingValues<T> {
    if (tenantOfId(tenant) !== tenant || this.#chain(tenant).length !== 1) throw new AccessError("not-found", "no such tenant");
    this.#writeSettings(new Writer(APP, tenant), this.#settingPatch(patch, false));
    return this.#values(tenant) as SettingValues<T>;
  }

  settingsForm<C>(o: { user(ctx: C): ActingUser | null | undefined; tenant(ctx: C): string | null | undefined }): {
    schema: Record<string, SettingConfig>;
    load(ctx: C): Record<string, unknown> | undefined;
    save(ctx: C, patch: Record<string, unknown>): unknown;
    canEdit(ctx: C, key: string): boolean;
  } {
    if (!o || typeof o.user !== "function" || typeof o.tenant !== "function") {
      throw new AccessError("invalid", "settingsForm: user(ctx) and tenant(ctx) read the request");
    }
    const who = (ctx: C): { user: string; tenant: string } | null => {
      const u = o.user(ctx);
      const t = o.tenant(ctx);
      if (u === null || u === undefined || typeof t !== "string" || t === "") return null;
      return { user: userIdOf(u), tenant: t };
    };
    return {
      schema: Object.fromEntries(this.#cfg.settings),
      load: (ctx) => {
        const w = who(ctx);
        if (w === null) return undefined;
        try {
          return this.settings(w.user, w.tenant) as Record<string, unknown>;
        } catch (e) {
          if (e instanceof AccessError) return undefined;
          throw e;
        }
      },
      save: (ctx, patch) => {
        const w = who(ctx);
        if (w === null) throw new AccessError("forbidden", "not signed in to a tenant");
        return this.updateSettings(w.user, w.tenant, patch as Partial<SettingValues<T>>);
      },
      canEdit: (ctx) => {
        const w = who(ctx);
        return w !== null && this.user(w.user).can("access.settings.manage", w.tenant);
      },
    };
  }

  #settingPatch(patch: unknown, editableOnly: boolean): [string, unknown][] {
    const p = options(patch as object, "settings");
    const out: [string, unknown][] = [];
    for (const [key, value] of Object.entries(p)) {
      const spec = this.#cfg.settings.get(key);
      if (!spec) throw new AccessError("invalid", `no setting \`${key.slice(0, 64)}\``);
      if (editableOnly && !spec.editable) forbidden(`change \`${key}\``);
      const problem = settingProblem(spec, value);
      if (problem !== null) throw new AccessError("invalid", `setting \`${key}\` ${problem}`);
      out.push([key, value]);
    }
    return out;
  }

  #writeSettings(w: Writer, changes: [string, unknown][]): void {
    if (changes.length === 0) return;
    const now = this.#cfg.now();
    const Setting = this.models.Setting.as(w);
    transaction(() => {
      for (const [key, value] of changes) {
        const id = JSON.stringify([w.tenant, key]);
        const encoded = JSON.stringify(value);
        if (Setting.get(id)) Setting.update((r) => r.id === id, { value: encoded, by: w.id, updated: now });
        else Setting.create({ id, tenant: w.tenant, key, value: encoded, by: w.id, updated: now });
      }
    });
    this.#changed();
  }

  async createInvite(
    by: ActingUser,
    opts: { scope: string; role: RoleName<R>; email?: string; ttlMs?: number },
  ): Promise<{ token: string; invite: InviteInfo }> {
    const actor = userIdOf(by);
    options(opts, "createInvite");
    let email: string | null = null;
    if (opts.email !== undefined) {
      email = text(opts.email, "email", 320).toLowerCase();
      if (!EMAIL.test(email)) throw new AccessError("invalid", "not an email address");
    }
    const ttl = opts.ttlMs ?? this.#cfg.inviteTtlMs;
    if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0 || ttl > this.#cfg.inviteTtlMs) {
      throw new AccessError("invalid", `an invite lasts at most ${this.#cfg.inviteTtlMs} ms`);
    }
    const token = newToken();
    const hash = await hashToken(token);
    const on = this.#require(actor, "access.members.manage", opts.scope, "invite people here");
    const role = this.#role(opts.role, on);
    this.#noEscalation(actor, role, on, "invite to this role");
    const now = this.#cfg.now();
    const row: InviteRow = {
      id: `${on.tenant}/${crypto.randomUUID()}`,
      tenant: on.tenant,
      scope: on.id,
      role,
      email,
      hash,
      by: actor,
      created: now,
      expires: now + ttl,
      used: null,
      usedBy: null,
    };
    const w = new Writer(actor, on.tenant);
    transaction(() => {
      this.models.Invite.as(w).delete((i) => i.expires <= now);
      const pending = this.models.Invite.as(w).where((i) => i.used === null).length;
      if (pending >= this.#cfg.inviteMax) throw new AccessError("limit", "too many pending invites");
      this.#seatFor(w, null);
      this.models.Invite.as(w).create(row);
    });
    this.#changed();
    return { token, invite: inviteInfo(row) };
  }

  async inspectInvite(token: string): Promise<{ tenant: string; scope: string; role: string; email: string | null; expires: number } | null> {
    const row = await this.#invite(token);
    if (!row || row.used !== null || row.expires <= this.#cfg.now()) return null;
    const chain = this.#chain(row.scope);
    if (chain.length === 0) return null;
    return {
      tenant: chain[chain.length - 1].name,
      scope: chain[0].name,
      role: this.#memberInfo({ ...row, user: "", created: 0 }, false).label,
      email: row.email,
      expires: row.expires,
    };
  }

  async #invite(token: string): Promise<InviteRow | undefined> {
    if (!isToken(token)) return undefined;
    const hash = await hashToken(token);
    return this.models.Invite.as(new Reader({ hash })).all()[0];
  }

  async acceptInvite(token: string, user: ActingUser, opts: { email?: string } = {}): Promise<MemberInfo> {
    const target = userIdOf(user);
    if (!isToken(token)) throw new AccessError("not-found", "no such invite");
    const hash = await hashToken(token);
    let result: MemberInfo | undefined;
    transaction(() => {
      const row = this.models.Invite.as(new Reader({ hash })).all()[0];
      if (!row || row.used !== null) throw new AccessError("not-found", "no such invite");
      const now = this.#cfg.now();
      if (row.expires <= now) throw new AccessError("expired", "the invite expired");
      if (row.email !== null && (typeof opts.email !== "string" || opts.email.trim().toLowerCase() !== row.email)) {
        throw new AccessError("forbidden", "the invite is for another email address");
      }
      const on = this.#chain(row.scope)[0];
      if (!on) throw new AccessError("not-found", "no such invite");
      try {
        this.#require(row.by, "access.members.manage", on.id, "invite people here");
        this.#role(row.role, on);
        this.#noEscalation(row.by, row.role, on, "invite to this role");
      } catch (e) {
        if (e instanceof AccessError) throw new AccessError("forbidden", "the invite is no longer valid");
        throw e;
      }
      const w = new Writer(target, on.tenant);
      const marked = this.models.Invite.as(w).update((i) => i.id === row.id && i.used === null, { used: now, usedBy: target });
      if (marked !== 1) throw new AccessError("not-found", "no such invite");
      result = this.#give(target, row.by, target, row.role, on);
    });
    this.#changed();
    return result!;
  }

  invites(by: ActingUser, scope: string): InviteInfo[] {
    const actor = userIdOf(by);
    const on = this.#require(actor, "access.members.manage", scope, "see invites here");
    const now = this.#cfg.now();
    return this.models.Invite.as(new Reader({ tenant: on.tenant }))
      .where((i) => i.scope === on.id && i.used === null && i.expires > now)
      .map(inviteInfo)
      .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  }

  revokeInvite(by: ActingUser, id: string): void {
    const actor = userIdOf(by);
    const tenant = tenantOfId(id);
    if (tenant === null || tenant === id) throw new AccessError("not-found", "no such invite");
    const row = this.models.Invite.as(new Reader({ tenant })).get(id);
    if (!row || row.used !== null) {
      if (this.memberOf(actor, tenant)) throw new AccessError("not-found", "no such invite");
      forbidden("withdraw this invite");
    }
    if (row.by !== actor) this.#require(actor, "access.members.manage", row.scope, "withdraw this invite");
    this.models.Invite.as(new Writer(actor, tenant)).delete((i) => i.id === id);
    this.#changed();
  }

  explain(tenant?: string): AccessReport {
    if (tenant !== undefined && (tenantOfId(tenant) !== tenant || this.#chain(tenant).length !== 1)) {
      throw new AccessError("not-found", "no such tenant");
    }
    const customs = tenant === undefined ? new Map<string, PermissionRow>() : this.#customPerms(tenant);
    const permissions: ExplainedPermission[] = [...this.#cfg.permissions].map(([name, info]) => ({
      name,
      label: info.label,
      ...(info.description ? { description: info.description } : {}),
      builtin: Object.hasOwn(BUILTIN_PERMISSIONS, name),
      custom: false,
    }));
    for (const p of customs.values()) {
      permissions.push({ name: p.key, label: p.label, ...(p.description ? { description: p.description } : {}), builtin: false, custom: true });
    }
    const all = new Set(permissions.map((p) => p.name));

    const below = new Map<string, Set<string>>();
    for (const t of this.#cfg.scopes.keys()) {
      const out = new Set<string>([t]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const [u, s] of this.#cfg.scopes) {
          if (!out.has(u) && [...s.parents].some((p) => out.has(p))) {
            out.add(u);
            grew = true;
          }
        }
      }
      below.set(t, out);
    }

    const roles: ExplainedRole[] = [];
    for (const [role, r] of this.#cfg.roles) {
      roles.push({
        role,
        label: r.label,
        description: r.description ?? "",
        scopes: [...r.scopes],
        permissions: r.all ? [...all].sort() : [...r.permissions].sort(),
        all: r.all,
        custom: false,
        canGive: [],
      });
    }
    if (tenant !== undefined) {
      for (const row of this.#customRoles(tenant).values()) {
        const info = this.#roleInfo(row);
        roles.push({ role: info.role, label: info.label, description: info.description, scopes: info.scopes, permissions: info.permissions, all: false, custom: true, canGive: [] });
      }
    }
    for (const a of roles) {
      if (!a.permissions.includes("access.members.manage")) continue;
      const mine = new Set(a.permissions);
      const reach = new Set(a.scopes.flatMap((t) => [...below.get(t)!]));
      for (const b of roles) {
        if (b.scopes.some((t) => reach.has(t)) && b.permissions.every((p) => mine.has(p))) a.canGive.push(b.role);
      }
    }
    const scopes = [...this.#cfg.scopes].map(([type, s]) => ({ type, label: s.label, parents: [...s.parents] }));
    const values = tenant !== undefined ? this.#values(tenant) : null;
    const settings: ExplainedSetting[] = [...this.#cfg.settings].map(([key, spec]) => ({
      key,
      type: spec.type,
      label: spec.label ?? key,
      default: spec.default,
      editable: spec.editable === true,
      seats: key === this.#cfg.seats,
      ...(values ? { value: values[key] } : {}),
    }));
    return {
      ...(tenant !== undefined ? { tenant, name: this.#chain(tenant)[0].name } : {}),
      owner: this.#cfg.owner,
      scopes,
      permissions,
      roles,
      settings,
    };
  }
}

export const EXPLAIN = Symbol.for("weft.access.explain");

export interface ExplainedPermission {
  name: string;
  label: string;
  description?: string;
  builtin: boolean;
  custom: boolean;
}

export interface ExplainedRole {
  role: string;
  label: string;
  description: string;
  scopes: string[];
  permissions: string[];
  all: boolean;
  custom: boolean;
  canGive: string[];
}

export interface ExplainedSetting {
  key: string;
  type: "boolean" | "number" | "string";
  label: string;
  default: unknown;
  editable: boolean;
  seats: boolean;
  value?: unknown;
}

export interface AccessReport {
  tenant?: string;
  name?: string;
  owner: string;
  scopes: { type: string; label: string; parents: string[] }[];
  permissions: ExplainedPermission[];
  roles: ExplainedRole[];
  settings: ExplainedSetting[];
}

export function explainText(report: AccessReport): string {
  const lines: string[] = [];
  lines.push(report.tenant ? `Access for tenant ${report.name} (${report.tenant})` : "Access");
  lines.push("");
  lines.push("Scopes:");
  for (const s of report.scopes) lines.push(`  ${s.type}${s.parents.length ? ` (inside ${s.parents.join(", ")})` : " (a tenant)"}`);
  lines.push("");
  lines.push("Permissions:");
  const width = Math.max(...report.permissions.map((p) => p.name.length));
  for (const p of report.permissions) {
    lines.push(`  ${p.name.padEnd(width)}  ${p.label}${p.custom ? " [custom]" : ""}`);
  }
  for (const r of report.roles) {
    lines.push("");
    const tags = [r.custom ? "custom" : "", r.role === report.owner ? "owner" : "", r.all ? "everything" : ""].filter(Boolean);
    lines.push(`Role ${r.custom ? r.label : r.role}${tags.length ? ` [${tags.join(", ")}]` : ""}, on ${r.scopes.join(", ")}`);
    if (r.description) lines.push(`  ${r.description}`);
    lines.push(`  can: ${r.permissions.length ? r.permissions.join(", ") : "(nothing)"}`);
    if (r.canGive.length) {
      const names = r.canGive.map((g) => report.roles.find((x) => x.role === g)!).map((x) => (x.custom ? x.label : x.role));
      lines.push(`  gives: ${names.join(", ")}`);
    }
  }
  if (report.settings.length) {
    lines.push("");
    lines.push("Settings:");
    const w = Math.max(...report.settings.map((s) => s.key.length));
    for (const s of report.settings) {
      const tags = [s.editable ? "editable" : "set by the app", s.seats ? "seats" : ""].filter(Boolean);
      const now = "value" in s ? `, now ${JSON.stringify(s.value)}` : "";
      lines.push(`  ${s.key.padEnd(w)}  ${s.type}, default ${JSON.stringify(s.default)}${now} [${tags.join(", ")}]`);
    }
  }
  return lines.join("\n") + "\n";
}
