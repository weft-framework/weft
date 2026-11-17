import type { FieldSpec, Model, ScopedModel, TableColumn, TableView } from "@weft/data";
import { defineTable, type Table } from "@weft/data";
import { defineAction, type Action, type ParamSpec } from "./action.ts";
import type { PageContext } from "./context.ts";

type Row = Record<string, unknown>;
type AnyModel = Model<any, any>;

export interface AdminField {
  label?: string;
  help?: string;
  readonly?: boolean;
  hidden?: boolean;
  widget?: "input" | "textarea";
}

export interface AdminModel<T = any> {
  model: Model<T, any>;
  label?: string;
  list?: readonly (keyof T & string)[];
  search?: readonly (keyof T & string)[];
  filters?: readonly (keyof T & string)[];
  sort?: readonly [keyof T & string, "asc" | "desc"];
  pageSize?: number;
  fields?: { [K in keyof T & string]?: AdminField };
  title?: (row: T) => string;
  create?: boolean;
  edit?: boolean;
  delete?: boolean;
}

export interface AdminOptions {
  allow: (ctx: PageContext) => boolean | Promise<boolean>;
  models: readonly (AnyModel | AdminModel)[];
  actor?: (ctx: PageContext) => unknown;
  name?: string;
}

export interface AdminFieldInfo {
  name: string;
  label: string;
  help: string | null;
  kind: FieldSpec["kind"];
  type: string;
  nullable: boolean;
  required: boolean;
  options: string[] | null;
  readonly: boolean;
  widget: "input" | "textarea";
  isKey: boolean;
  onCreate: boolean;
  onEdit: boolean;
  listed: boolean;
  searchable: boolean;
  filter: TableColumn["filter"] | null;
}

export interface AdminModelInfo {
  name: string;
  label: string;
  key: string;
  fields: AdminFieldInfo[];
  list: string[];
  create: boolean;
  edit: boolean;
  delete: boolean;
}

export interface AdminRow {
  key: unknown;
  title: string;
  row: Row;
  text: Record<string, string>;
  writable: boolean;
}

export type AdminResult =
  | { ok: true; key: unknown; row: Row }
  | { ok: false; reason: "not found" | "disabled" | "forbidden" | "conflict"; error: string }
  | { ok: false; reason: "invalid"; field: string | null; error: string };

export interface Admin {
  overview(ctx: PageContext): Promise<{ name: string; label: string; count: number }[] | null>;
  model(name: string): AdminModelInfo | null;
  list(ctx: PageContext, model: string, query?: URL): Promise<TableView<Row> | null>;
  row(ctx: PageContext, model: string, key: unknown): Promise<AdminRow | null>;
  create(ctx: PageContext, model: string, input: Readonly<Record<string, unknown>>): Promise<AdminResult>;
  update(
    ctx: PageContext,
    model: string,
    key: unknown,
    input: Readonly<Record<string, unknown>>,
    shown?: Readonly<Record<string, unknown>> | null,
  ): Promise<AdminResult>;
  delete(ctx: PageContext, model: string, key: unknown): Promise<AdminResult>;
  actions: Record<string, Action<never[]>>;
}

interface Field {
  spec: FieldSpec;
  name: string;
  label: string;
  help: string;
  readonly: boolean;
  hidden: boolean;
  widget: "input" | "textarea";
  options: string[] | null;
}

interface Entry {
  model: AnyModel;
  label: string;
  fields: Field[];
  byName: Map<string, Field>;
  list: string[];
  table: Table<any>;
  title: (row: Row) => string;
  create: boolean;
  edit: boolean;
  delete: boolean;
  info: AdminModelInfo;
}

const NAME_RE = /^[a-z][A-Za-z0-9]{0,30}$/;
const MAX_TEXT = 100_000;

function literalOptions(type: string): string[] | null {
  const parts = type.split("|").map((p) => p.trim()).filter((p) => p !== "null" && p !== "undefined");
  if (parts.length === 0) return null;
  const out: string[] = [];
  for (const p of parts) {
    const m = /^"([^"\\]*)"$/.exec(p) ?? /^'([^'\\]*)'$/.exec(p);
    if (!m) return null;
    out.push(m[1]!);
  }
  return out;
}

function humanize(name: string): string {
  const s = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function formText(f: Field, v: unknown): string {
  if (v === null || v === undefined) return "";
  switch (f.spec.kind) {
    case "bool":
      return v === true ? "true" : "false";
    case "date":
      return v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : "";
    case "json":
      return JSON.stringify(v, null, 2);
    default:
      return String(v);
  }
}

type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

function parse(f: Field, input: unknown): Parsed {
  const bad = (what: string): Parsed => ({ ok: false, error: `${f.label}: ${what}` });
  let raw: string;
  if (typeof input === "string") raw = input;
  else if (f.spec.kind === "json") raw = JSON.stringify(input ?? null);
  else if (input === null || input === undefined) raw = "";
  else if (f.spec.kind === "date" && !(input instanceof Date)) return bad("is a date");
  else if (typeof input === "object" && !(input instanceof Date)) return bad("is not a value of this field");
  else raw = formText(f, input);
  if (raw.length > MAX_TEXT) return bad("too long");
  const empty = raw.trim() === "";
  if (empty && f.spec.kind !== "text") return f.spec.nullable ? { ok: true, value: null } : bad("is required");
  switch (f.spec.kind) {
    case "text":
      if (f.options) {
        if (raw === "" && f.spec.nullable) return { ok: true, value: null };
        return f.options.includes(raw) ? { ok: true, value: raw } : bad(`is one of ${f.options.join(", ")}`);
      }
      return { ok: true, value: raw === "" && f.spec.nullable ? null : raw };
    case "real": {
      const n = Number(raw.trim());
      return Number.isFinite(n) ? { ok: true, value: n } : bad("is a number");
    }
    case "integer":
      return /^-?\d{1,30}$/.test(raw.trim()) ? { ok: true, value: BigInt(raw.trim()) } : bad("is a whole number");
    case "bool":
      return raw === "true" ? { ok: true, value: true } : raw === "false" ? { ok: true, value: false } : bad("is yes or no");
    case "date": {
      const t = raw.trim();
      const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(t) ? `${t}Z` : t;
      if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(iso)) return bad("is a date like 2026-11-14T09:30Z");
      const [y, mo, da] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
      const day = new Date(Date.UTC(y, mo - 1, da));
      const d = new Date(iso);
      if (Number.isNaN(d.getTime()) || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== da) return bad("is not a date");
      return { ok: true, value: d };
    }
    case "json":
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch {
        return bad("is not valid JSON");
      }
  }
}

function keyValue(f: FieldSpec, input: unknown): unknown {
  if (typeof input === "bigint") return f.kind === "integer" ? input : undefined;
  if (typeof input === "number") return f.kind === "real" && Number.isFinite(input) ? input : f.kind === "integer" && Number.isInteger(input) ? BigInt(input) : undefined;
  if (typeof input !== "string") return undefined;
  if (f.kind === "real") {
    const n = Number(input);
    return input !== "" && Number.isFinite(n) ? n : undefined;
  }
  if (f.kind === "integer") return /^-?\d{1,30}$/.test(input) ? BigInt(input) : undefined;
  return f.kind === "text" ? input : undefined;
}

function filterFor(f: FieldSpec, options: string[] | null): TableColumn["filter"] | undefined {
  if (f.kind === "bool") return "boolean";
  if (f.kind === "real" || f.kind === "integer") return "number";
  if (f.kind === "date") return "date";
  if (f.kind === "text") return options ? { options } : "text";
  return undefined;
}

export function defineAdmin(opts: AdminOptions): Admin {
  if (!opts || typeof opts.allow !== "function") throw new Error("defineAdmin: `allow(ctx)` is required");
  const prefix = opts.name ?? "admin";
  if (!NAME_RE.test(prefix)) throw new Error("defineAdmin: name is a lower-case identifier");
  const actorOf = opts.actor ?? ((ctx: PageContext) => ctx.user);

  const entries = new Map<string, Entry>();
  for (const item of opts.models ?? []) {
    const cfg: AdminModel = typeof (item as AnyModel).as === "function" ? { model: item as AnyModel } : (item as AdminModel);
    const model = cfg.model;
    if (!model || typeof model.as !== "function") throw new Error("defineAdmin: models are defineModel(...) results");
    if (entries.has(model.name)) throw new Error(`defineAdmin: ${model.name} is listed twice`);
    const fail = (msg: string): never => {
      throw new Error(`defineAdmin: ${model.name}: ${msg}`);
    };
    const specs = new Map(model.fields.map((f) => [f.name, f]));
    for (const name of Object.keys(cfg.fields ?? {})) if (!specs.has(name)) fail(`no field \`${name}\``);
    const fields: Field[] = model.fields.map((spec) => {
      const c: AdminField = (cfg.fields as Record<string, AdminField> | undefined)?.[spec.name] ?? {};
      if (c.widget !== undefined && c.widget !== "input" && c.widget !== "textarea") fail(`${spec.name}: widget is "input" or "textarea"`);
      return {
        spec,
        name: spec.name,
        label: c.label ?? humanize(spec.name),
        help: c.help ?? "",
        readonly: c.readonly === true || spec.file || model.lockedFields.includes(spec.name),
        hidden: c.hidden === true,
        widget: c.widget ?? (spec.kind === "json" ? "textarea" : "input"),
        options: spec.kind === "text" ? literalOptions(spec.type) : null,
      };
    });
    if (fields.find((f) => f.name === model.key)?.hidden) fail("the key cannot be hidden");
    if (cfg.create !== false) {
      for (const f of fields) {
        const unset = (f.hidden || f.readonly) && f.name !== model.key && !model.lockedFields.includes(f.name) && !f.spec.default && !f.spec.nullable && !f.spec.optional;
        if (unset && f.spec.kind !== "text") fail(`${f.name} is not set by the admin and has no default; give it one, or create: false`);
      }
    }
    const byName = new Map(fields.map((f) => [f.name, f]));
    const visible = fields.filter((f) => !f.hidden);
    const list = [...(cfg.list ?? [model.key, ...visible.filter((f) => f.name !== model.key && f.spec.kind !== "json").slice(0, 5).map((f) => f.name)])];
    for (const n of list) if (!byName.get(n) || byName.get(n)!.hidden) fail(`list: no visible field \`${n}\``);
    const search = new Set(cfg.search ?? list.filter((n) => byName.get(n)!.spec.kind === "text" && !byName.get(n)!.spec.file));
    for (const n of search) if (!list.includes(n) || byName.get(n)!.spec.kind !== "text") fail(`search: \`${n}\` is a listed text field`);
    const filters = new Set(cfg.filters ?? []);
    for (const n of filters) if (!list.includes(n)) fail(`filters: \`${n}\` is not listed`);
    const columns: Record<string, TableColumn> = {};
    for (const n of list) {
      const f = byName.get(n)!;
      const filter = filters.has(n) ? (filterFor(f.spec, f.options) ?? fail(`filters: \`${n}\` cannot be filtered`)) : undefined;
      columns[n] = { sort: f.spec.kind !== "json", ...(search.has(n) ? { search: true } : {}), ...(filter ? { filter } : {}) };
    }
    const firstText = list.find((n) => n !== model.key && byName.get(n)!.spec.kind === "text");
    const table = defineTable(model, {
      columns: columns as never,
      sort: (cfg.sort ?? [model.key, "asc"]) as never,
      pageSize: cfg.pageSize ?? 25,
      ...(firstText ? { fields: [firstText] as never } : {}),
    });
    const title =
      cfg.title ??
      ((row: Row) => {
        const t = firstText ? row[firstText] : undefined;
        return typeof t === "string" && t.trim() !== "" ? t : String(row[model.key]);
      });
    const onCreate = (f: Field) => !f.hidden && !f.readonly && !(f.name === model.key && f.spec.default);
    const onEdit = (f: Field) => !f.hidden && !f.readonly && f.name !== model.key;
    const info: AdminModelInfo = {
      name: model.name,
      label: cfg.label ?? model.name,
      key: model.key,
      list,
      create: cfg.create !== false,
      edit: cfg.edit !== false,
      delete: cfg.delete !== false,
      fields: visible.map((f) => ({
        name: f.name,
        label: f.label,
        help: f.help || null,
        kind: f.spec.kind,
        type: f.spec.type,
        nullable: f.spec.nullable,
        required: !f.spec.default && !f.spec.nullable && !f.spec.optional && f.spec.kind !== "text",
        options: f.options,
        readonly: f.readonly,
        widget: f.widget,
        isKey: f.name === model.key,
        onCreate: onCreate(f),
        onEdit: onEdit(f),
        listed: list.includes(f.name),
        searchable: search.has(f.name),
        filter: columns[f.name]?.filter ?? null,
      })),
    };
    entries.set(model.name, {
      model,
      label: info.label,
      fields,
      byName,
      list,
      table,
      title: title as (row: Row) => string,
      create: info.create,
      edit: info.edit,
      delete: info.delete,
      info: deepFreeze(info),
    });
  }
  if (entries.size === 0) throw new Error("defineAdmin: list at least one model");

  async function gate(ctx: PageContext): Promise<boolean> {
    try {
      return (await opts.allow(ctx)) === true;
    } catch {
      return false;
    }
  }

  async function admitted(ctx: PageContext, name: unknown): Promise<Entry | null> {
    if (typeof name !== "string" || !(await gate(ctx))) return null;
    return entries.get(name) ?? null;
  }

  const scoped = (ctx: PageContext, e: Entry): ScopedModel<Row, any> => e.model.as(actorOf(ctx) as never) as ScopedModel<Row, any>;

  function find(ctx: PageContext, e: Entry, rawKey: unknown): { key: unknown; row: Row } | null {
    const key = keyValue(e.byName.get(e.model.key)!.spec, rawKey);
    if (key === undefined) return null;
    const row = scoped(ctx, e).get(key);
    return row ? { key, row } : null;
  }

  const visibleRow = (e: Entry, row: Row): Row => Object.fromEntries(e.fields.filter((f) => !f.hidden).map((f) => [f.name, row[f.name]]));

  function values(fields: Field[], input: Readonly<Record<string, unknown>>, before: Row | null, shown: Readonly<Record<string, unknown>> | null): { values: Row } | { refused: AdminResult } {
    const out: Row = {};
    for (const f of fields) {
      if (!Object.hasOwn(input, f.name)) continue;
      const v = parse(f, input[f.name]);
      if (!v.ok) return { refused: { ok: false, reason: "invalid", field: f.name, error: v.error } };
      if (before) {
        const now = formText(f, before[f.name]);
        const was = shown && Object.hasOwn(shown, f.name) ? (typeof shown[f.name] === "string" ? (shown[f.name] as string) : formText(f, shown[f.name])) : now;
        const next = formText(f, v.value);
        if (next === was || next === now) continue;
      }
      out[f.name] = v.value;
    }
    return { values: out };
  }

  function friendly(err: unknown, e: Entry): AdminResult {
    const msg = err instanceof Error ? err.message : "";
    const m = /unique field (\w+)|UNIQUE constraint failed: \S+?\.(\w+)/.exec(msg);
    if (m) {
      const f = e.byName.get(m[1] ?? m[2] ?? "");
      return { ok: false, reason: "conflict", error: `${f ? f.label : "A value"} is already used by another row` };
    }
    if (/duplicate key|PRIMARY KEY|already exists/i.test(msg)) return { ok: false, reason: "conflict", error: "A row with this key exists already" };
    throw err;
  }

  const NOT_FOUND: AdminResult = { ok: false, reason: "not found", error: "Not found" };

  const admin: Admin = {
    async overview(ctx) {
      if (!(await gate(ctx))) return null;
      return [...entries.values()].map((e) => ({ name: e.model.name, label: e.label, count: scoped(ctx, e).query().count() }));
    },

    model: (name) => entries.get(name)?.info ?? null,

    async list(ctx, model, query) {
      const e = await admitted(ctx, model);
      if (!e) return null;
      return e.table.view(scoped(ctx, e) as never, query ?? ctx.url) as TableView<Row>;
    },

    async row(ctx, model, key) {
      const e = await admitted(ctx, model);
      if (!e) return null;
      const found = find(ctx, e, key);
      if (!found) return null;
      const text = Object.fromEntries(e.fields.filter((f) => !f.hidden).map((f) => [f.name, formText(f, found.row[f.name])]));
      return { key: found.key, title: e.title(found.row), row: visibleRow(e, found.row), text, writable: scoped(ctx, e).writable(found.row) };
    },

    async create(ctx, model, input) {
      const e = await admitted(ctx, model);
      if (!e) return NOT_FOUND;
      if (!e.create) return { ok: false, reason: "disabled", error: "Rows of this model are not created here" };
      const fields = e.fields.filter((f) => !f.hidden && !f.readonly && !(f.name === e.model.key && f.spec.default));
      const parsed = values(fields, input ?? {}, null, null);
      if ("refused" in parsed) return parsed.refused;
      const row = parsed.values;
      for (const f of e.fields) {
        if (row[f.name] !== undefined || f.spec.default || f.spec.nullable || f.spec.optional) continue;
        if (f.spec.kind === "text") row[f.name] = "";
        else return { ok: false, reason: "invalid", field: f.name, error: `${f.label} is required` };
      }
      let made: Row | undefined;
      try {
        made = scoped(ctx, e).create(row as never) as Row | undefined;
      } catch (err) {
        return friendly(err, e);
      }
      if (!made) return { ok: false, reason: "forbidden", error: "You may not create this row" };
      return { ok: true, key: made[e.model.key], row: visibleRow(e, made) };
    },

    async update(ctx, model, key, input, shown = null) {
      const e = await admitted(ctx, model);
      if (!e) return NOT_FOUND;
      if (!e.edit) return { ok: false, reason: "disabled", error: "Rows of this model are not edited here" };
      const found = find(ctx, e, key);
      if (!found) return NOT_FOUND;
      const fields = e.fields.filter((f) => !f.hidden && !f.readonly && f.name !== e.model.key);
      const parsed = values(fields, input ?? {}, found.row, shown);
      if ("refused" in parsed) return parsed.refused;
      const patch = parsed.values;
      if (Object.keys(patch).length > 0) {
        const k = e.model.key;
        let n = 0;
        try {
          n = scoped(ctx, e).update((r) => r[k] === found.key, patch);
        } catch (err) {
          return friendly(err, e);
        }
        if (n === 0) return { ok: false, reason: "forbidden", error: "You may not make this change" };
      }
      return { ok: true, key: found.key, row: visibleRow(e, scoped(ctx, e).get(found.key) ?? found.row) };
    },

    async delete(ctx, model, key) {
      const e = await admitted(ctx, model);
      if (!e) return NOT_FOUND;
      if (!e.delete) return { ok: false, reason: "disabled", error: "Rows of this model are not deleted here" };
      const found = find(ctx, e, key);
      if (!found) return NOT_FOUND;
      const k = e.model.key;
      if (scoped(ctx, e).delete((r) => r[k] === found.key) === 0) return { ok: false, reason: "forbidden", error: "You may not delete this row" };
      return { ok: true, key: found.key, row: visibleRow(e, found.row) };
    },

    actions: {},
  };

  const names = [...new Set([...entries.values()].flatMap((e) => e.fields.filter((f) => !f.hidden).map((f) => f.name)))].filter(
    (n) => n !== "model" && n !== "key" && n !== "shown",
  );
  const fieldParams: ParamSpec[] = names.map((name) => ({ name, type: "string", optional: true }));
  const inputOf = (args: unknown[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    names.forEach((n, i) => {
      if (typeof args[i] === "string") out[n] = args[i];
    });
    return out;
  };
  const head: ParamSpec[] = [{ name: "model", type: "string" }];
  const keyed: ParamSpec[] = [...head, { name: "key", type: "string" }];
  admin.actions = {
    [`${prefix}Create`]: defineAction(`${prefix}Create`, [...head, ...fieldParams], (ctx, model: string, ...args: unknown[]) =>
      admin.create(ctx, model, inputOf(args)),
    ) as Action<never[]>,
    [`${prefix}Update`]: defineAction(
      `${prefix}Update`,
      [...keyed, ...fieldParams, { name: "shown", type: "string", optional: true }],
      (ctx, model: string, key: string, ...args: unknown[]) => {
        let shown: Record<string, unknown> | null = null;
        const sent = args[names.length];
        if (typeof sent === "string" && sent.length <= MAX_TEXT) {
          try {
            const s = JSON.parse(sent) as unknown;
            if (s && typeof s === "object" && !Array.isArray(s)) shown = s as Record<string, unknown>;
          } catch {
          }
        }
        return admin.update(ctx, model, key, inputOf(args), shown);
      },
    ) as Action<never[]>,
    [`${prefix}Delete`]: defineAction(`${prefix}Delete`, keyed, (ctx, model: string, key: string) => admin.delete(ctx, model, key)) as Action<never[]>,
  };
  return admin;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}
