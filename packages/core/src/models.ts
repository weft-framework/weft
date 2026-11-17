import { defineModel, type Model, type PolicyExpr } from "@weft-framework/data";

export class Reader {
  readonly id: string;
  readonly user?: string;
  readonly tenant?: string;
  readonly hash?: string;

  constructor(of: { user: string } | { tenant: string } | { hash: string }) {
    if ("user" in of) {
      this.user = of.user;
      this.id = `access:user:${of.user}`;
    } else if ("tenant" in of) {
      this.tenant = of.tenant;
      this.id = `access:tenant:${of.tenant}`;
    } else {
      this.hash = of.hash;
      this.id = "access:invite";
    }
    Object.freeze(this);
  }
}

export class Writer {
  readonly id: string;
  readonly tenant: string;

  constructor(id: string, tenant: string) {
    this.id = id;
    this.tenant = tenant;
    Object.freeze(this);
  }
}

export interface ScopeRow {
  id: string;
  tenant: string;
  type: string;
  parent: string | null;
  name: string;
  created: number;
}

export interface MemberRow {
  id: string;
  tenant: string;
  scope: string;
  user: string;
  role: string;
  by: string;
  created: number;
}

export interface RoleRow {
  id: string;
  tenant: string;
  name: string;
  description: string;
  scopes: string[];
  permissions: string[];
  created: number;
  updated: number;
}

export interface PermissionRow {
  id: string;
  tenant: string;
  key: string;
  label: string;
  description: string;
  created: number;
}

export interface InviteRow {
  id: string;
  tenant: string;
  scope: string;
  role: string;
  email: string | null;
  hash: string;
  by: string;
  created: number;
  expires: number;
  used: number | null;
  usedBy: string | null;
}

export interface SettingRow {
  id: string;
  tenant: string;
  key: string;
  value: string;
  by: string;
  updated: number;
}

export interface Models {
  Scope: Model<ScopeRow>;
  Member: Model<MemberRow>;
  Role: Model<RoleRow>;
  Permission: Model<PermissionRow>;
  Invite: Model<InviteRow>;
  Setting: Model<SettingRow>;
}

const byUser: PolicyExpr = { cmp: "==", l: { field: ["user"] }, r: { actor: ["user"] } };
const byTenant: PolicyExpr = { cmp: "==", l: { field: ["tenant"] }, r: { actor: ["tenant"] } };

function readable(a: unknown, row: { tenant: string; user?: string; hash?: string }): boolean {
  if (a instanceof Writer) return row.tenant === a.tenant;
  if (!(a instanceof Reader)) return false;
  if (a.tenant !== undefined) return row.tenant === a.tenant;
  if (a.hash !== undefined) return row.hash !== undefined && row.hash === a.hash;
  return a.user !== undefined && row.user !== undefined && row.user === a.user;
}

const writable = (a: unknown, row: { tenant: string }) => a instanceof Writer && row.tenant === a.tenant;

export function createModels(prefix: string): Models {
  const tenantRules = {
    read: (a: unknown, r: { tenant: string }) => readable(a, r),
    write: writable,
    readWhere: byTenant,
    writeWhere: byTenant,
  };
  return {
    Scope: defineModel<ScopeRow>(`${prefix}Scope`, {
      fields: { id: "string", tenant: "string", type: "string", parent: "string | null", name: "string", created: "number" },
      attrs: { tenant: { index: true }, parent: { index: true } },
      ...tenantRules,
    }),
    Member: defineModel<MemberRow>(`${prefix}Member`, {
      fields: {
        id: "string",
        tenant: "string",
        scope: "string",
        user: "string",
        role: "string",
        by: "string",
        created: "number",
      },
      attrs: { tenant: { index: true }, scope: { index: true }, user: { index: true } },
      read: (a: unknown, r: MemberRow) => readable(a, r),
      write: writable,
      readWhere: { or: [byUser, byTenant] },
      writeWhere: byTenant,
    }),
    Role: defineModel<RoleRow>(`${prefix}Role`, {
      fields: {
        id: "string",
        tenant: "string",
        name: "string",
        description: "string",
        scopes: "string[]",
        permissions: "string[]",
        created: "number",
        updated: "number",
      },
      attrs: { tenant: { index: true } },
      ...tenantRules,
    }),
    Permission: defineModel<PermissionRow>(`${prefix}Permission`, {
      fields: { id: "string", tenant: "string", key: "string", label: "string", description: "string", created: "number" },
      attrs: { tenant: { index: true } },
      ...tenantRules,
    }),
    Invite: defineModel<InviteRow>(`${prefix}Invite`, {
      fields: {
        id: "string",
        tenant: "string",
        scope: "string",
        role: "string",
        email: "string | null",
        hash: "string",
        by: "string",
        created: "number",
        expires: "number",
        used: "number | null",
        usedBy: "string | null",
      },
      attrs: { tenant: { index: true }, hash: { unique: true } },
      read: (a: unknown, r: InviteRow) => readable(a, r),
      write: writable,
      readWhere: { or: [byTenant, { cmp: "==", l: { field: ["hash"] }, r: { actor: ["hash"] } }] },
      writeWhere: byTenant,
    }),
    Setting: defineModel<SettingRow>(`${prefix}Setting`, {
      fields: { id: "string", tenant: "string", key: "string", value: "string", by: "string", updated: "number" },
      attrs: { tenant: { index: true } },
      ...tenantRules,
    }),
  };
}
