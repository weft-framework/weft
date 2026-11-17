import { AccessError } from "./errors.ts";

export const BUILTIN_PERMISSIONS = {
  "access.members.read": "See the members of a scope and their roles",
  "access.members.manage": "Give and take roles, and invite people",
  "access.roles.manage": "Create, change and delete custom roles",
  "access.permissions.manage": "Create and delete custom permissions",
  "access.scopes.manage": "Create, rename and delete scopes inside this one",
  "access.tenant.manage": "Rename or delete the whole tenant",
  "access.settings.manage": "Change the tenant's editable settings",
} as const;

export type BuiltinPermission = keyof typeof BUILTIN_PERMISSIONS;

export type CustomPermission = `custom.${string}`;

export interface ScopeTypeConfig<S extends string = string> {
  parent?: S | readonly S[];
  label?: string;
}

export interface RoleConfig<P extends string = string, R extends string = string, S extends string = string> {
  scope: S | readonly S[];
  permissions?: readonly (P | BuiltinPermission | "*")[];
  includes?: readonly R[];
  label?: string;
  description?: string;
}

export interface PermissionInfo {
  label: string;
  description?: string;
}

export interface CustomConfig {
  roles?: boolean | { max?: number };
  permissions?: boolean | { max?: number };
}

interface SettingBase {
  label?: string;
  description?: string;
  editable?: boolean;
}

export type SettingConfig =
  | (SettingBase & { type: "boolean"; default: boolean })
  | (SettingBase & { type: "number"; default: number; min?: number; max?: number; integer?: boolean })
  | (SettingBase & { type: "string"; default: string; options?: readonly string[]; maxLength?: number });

export type SettingsConfig = { readonly [key: string]: SettingConfig };

export type SettingValue<C> = C extends { type: "boolean" }
  ? boolean
  : C extends { type: "number" }
    ? number
    : C extends { options: readonly (infer O extends string)[] }
      ? O
      : string;

export type SettingValues<T> = { -readonly [K in keyof T]: SettingValue<T[K]> };

type NumberKey<T> = { [K in keyof T]: T[K] extends { type: "number" } ? K : never }[keyof T] & string;

export interface AccessConfig<P extends string, R extends string, S extends string, T extends SettingsConfig = {}> {
  scopes: { readonly [K in S]: ScopeTypeConfig<NoInfer<S>> };
  permissions: { readonly [K in P]: string | PermissionInfo };
  roles: { readonly [K in R]: RoleConfig<NoInfer<P>, NoInfer<R>, NoInfer<S>> };
  owner: NoInfer<R>;
  custom?: CustomConfig;
  settings?: T;
  seats?: NoInfer<NumberKey<T>>;
  invites?: {
    ttlMs?: number;
    max?: number;
  };
  prefix?: string;
  canCreateTenant?(userId: string): boolean;
  now?(): number;
}

export interface Resolved {
  scopes: Map<string, { parents: Set<string>; root: boolean; label: string }>;
  permissions: Map<string, PermissionInfo>;
  roles: Map<string, { scopes: Set<string>; permissions: Set<string>; all: boolean; label: string; description?: string }>;
  owner: string;
  customRoles: number;
  customPermissions: number;
  settings: Map<string, SettingConfig>;
  seats: string | null;
  inviteTtlMs: number;
  inviteMax: number;
  prefix: string;
  canCreateTenant: (userId: string) => boolean;
  now: () => number;
}

const PERMISSION = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;
const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;
const DAY = 24 * 60 * 60 * 1000;

export const MAX_NAME = 100;
export const MAX_LABEL = 200;

export function isPermissionName(name: string): boolean {
  return name.length <= 64 && PERMISSION.test(name);
}

function invalid(msg: string): never {
  throw new AccessError("invalid", `defineAccess: ${msg}`);
}

function list<T extends string>(v: T | readonly T[] | undefined): T[] {
  return v === undefined ? [] : typeof v === "string" ? [v] : [...v];
}

export const MAX_SETTING_TEXT = 1000;

export function settingProblem(spec: SettingConfig, value: unknown): string | null {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (spec.integer && !Number.isInteger(value)) return "must be a whole number";
      if (spec.min !== undefined && value < spec.min) return `must be at least ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `must be at most ${spec.max}`;
      return null;
    case "string":
      if (typeof value !== "string") return "must be text";
      if (spec.options !== undefined) return spec.options.includes(value) ? null : `must be one of ${spec.options.join(", ")}`;
      return value.length <= (spec.maxLength ?? MAX_SETTING_TEXT) ? null : "is too long";
  }
}

function limit(v: boolean | { max?: number } | undefined, dflt: number): number {
  if (v === undefined || v === false) return 0;
  const max = v === true ? dflt : (v.max ?? dflt);
  if (!Number.isInteger(max) || max < 0) invalid("custom limits are whole numbers");
  return max;
}

export function resolve(config: AccessConfig<string, string, string, SettingsConfig>): Resolved {
  if (typeof config !== "object" || config === null) invalid("expected a configuration object");

  const scopes: Resolved["scopes"] = new Map();
  for (const [name, s] of Object.entries(config.scopes ?? {})) {
    if (!IDENT.test(name)) invalid(`scope type \`${name}\` is not an identifier`);
    const parents = list(s.parent);
    scopes.set(name, { parents: new Set(parents), root: parents.length === 0, label: s.label ?? name });
  }
  if (![...scopes.values()].some((s) => s.root)) invalid("no root scope type (one without `parent`)");
  for (const [name, s] of scopes) {
    for (const p of s.parents) if (!scopes.has(p)) invalid(`scope type \`${name}\`: unknown parent \`${p}\``);
  }
  for (const name of scopes.keys()) {
    const seen = new Set<string>();
    const walk = (t: string): boolean => {
      const s = scopes.get(t)!;
      if (s.root) return true;
      if (seen.has(t)) return false;
      seen.add(t);
      return [...s.parents].some(walk);
    };
    if (!walk(name)) invalid(`scope type \`${name}\` never reaches a root (a parent cycle)`);
  }

  const permissions: Resolved["permissions"] = new Map();
  for (const [name, info] of Object.entries(BUILTIN_PERMISSIONS)) permissions.set(name, { label: info });
  for (const [name, info] of Object.entries(config.permissions ?? {})) {
    if (!isPermissionName(name)) invalid(`permission \`${name}\` is not a valid name (lowercase, dot-separated)`);
    if (name.startsWith("access.") || name.startsWith("custom.")) {
      invalid(`permission \`${name}\`: the \`access.\` and \`custom.\` prefixes are reserved`);
    }
    const i = typeof info === "string" ? { label: info } : info;
    if (typeof i?.label !== "string") invalid(`permission \`${name}\` needs a label`);
    permissions.set(name, { label: i.label, ...(i.description ? { description: i.description } : {}) });
  }

  const raw = Object.entries(config.roles ?? {});
  if (raw.length === 0) invalid("no roles");
  const byName = new Map(raw);
  const roles: Resolved["roles"] = new Map();
  const expand = (name: string, stack: string[]): { permissions: Set<string>; all: boolean } => {
    const r = byName.get(name);
    if (!r) invalid(`role \`${stack.at(-1)}\` includes unknown role \`${name}\``);
    if (stack.includes(name)) invalid(`roles include each other: ${[...stack, name].join(" -> ")}`);
    const out = { permissions: new Set<string>(), all: false };
    for (const p of r.permissions ?? []) {
      if (p === "*") out.all = true;
      else if (!permissions.has(p)) invalid(`role \`${name}\`: unknown permission \`${p}\``);
      else out.permissions.add(p);
    }
    for (const inc of r.includes ?? []) {
      const sub = expand(inc, [...stack, name]);
      out.all ||= sub.all;
      for (const p of sub.permissions) out.permissions.add(p);
    }
    return out;
  };
  for (const [name, r] of raw) {
    if (!IDENT.test(name)) invalid(`role \`${name}\` is not an identifier`);
    const on = list(r.scope);
    if (on.length === 0) invalid(`role \`${name}\` names no scope type`);
    for (const t of on) if (!scopes.has(t)) invalid(`role \`${name}\`: unknown scope type \`${t}\``);
    const e = expand(name, []);
    roles.set(name, {
      scopes: new Set(on),
      permissions: e.permissions,
      all: e.all,
      label: r.label ?? name,
      ...(r.description ? { description: r.description } : {}),
    });
  }

  const owner = roles.get(config.owner);
  if (!owner) invalid(`owner role \`${config.owner}\` is not a declared role`);
  if (![...owner.scopes].some((t) => scopes.get(t)!.root)) invalid(`owner role \`${config.owner}\` is not given on a root scope`);
  for (const p of Object.keys(BUILTIN_PERMISSIONS)) {
    if (!owner.all && !owner.permissions.has(p)) invalid(`owner role \`${config.owner}\` lacks \`${p}\` (use "*")`);
  }

  const settings: Resolved["settings"] = new Map();
  for (const [key, spec] of Object.entries(config.settings ?? {})) {
    const at = `setting \`${key}\``;
    if (!isPermissionName(key)) invalid(`${at} is not a valid key (lowercase, dot-separated)`);
    if (typeof spec !== "object" || spec === null || !["boolean", "number", "string"].includes(spec.type)) {
      invalid(`${at}: type is "boolean", "number" or "string"`);
    }
    if (spec.type === "number") {
      for (const b of [spec.min, spec.max]) if (b !== undefined && !Number.isFinite(b)) invalid(`${at}: min and max are numbers`);
      if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) invalid(`${at}: min is above max`);
    }
    if (spec.type === "string") {
      const opts = spec.options;
      if (opts !== undefined) {
        if (!Array.isArray(opts) || opts.length === 0 || opts.some((o) => typeof o !== "string") || new Set(opts).size !== opts.length) {
          invalid(`${at}: options are distinct strings`);
        }
      }
      const max = spec.maxLength;
      if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > MAX_SETTING_TEXT)) {
        invalid(`${at}: maxLength is between 1 and ${MAX_SETTING_TEXT}`);
      }
    }
    const problem = settingProblem(spec, spec.default);
    if (problem !== null) invalid(`${at}: the default ${problem}`);
    const copy = spec.type === "string" && spec.options ? { ...spec, options: Object.freeze([...spec.options]) } : { ...spec };
    settings.set(key, Object.freeze(copy));
  }
  const seats = config.seats ?? null;
  if (seats !== null) {
    const spec = settings.get(seats);
    if (spec?.type !== "number" || !spec.integer || spec.min === undefined || spec.min < 1) {
      invalid(`seats: \`${seats}\` must be a whole-number setting with a min of at least 1`);
    }
  }

  const ttl = config.invites?.ttlMs ?? 7 * DAY;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 90 * DAY) invalid("invites.ttlMs must be between 1 ms and 90 days");
  const inviteMax = config.invites?.max ?? 1000;
  if (!Number.isInteger(inviteMax) || inviteMax < 0) invalid("invites.max is a whole number");

  const prefix = config.prefix ?? "Access";
  if (!IDENT.test(prefix)) invalid(`prefix \`${prefix}\` is not an identifier`);

  return {
    scopes,
    permissions,
    roles,
    owner: config.owner,
    customRoles: limit(config.custom?.roles, 100),
    customPermissions: limit(config.custom?.permissions, 200),
    settings,
    seats,
    inviteTtlMs: ttl,
    inviteMax,
    prefix,
    canCreateTenant: config.canCreateTenant ?? (() => true),
    now: config.now ?? Date.now,
  };
}
