import type { SqlDatabase } from "@weft/data";
import type { PageContext } from "./context.ts";

interface FieldBase {
  label?: string;
  description?: string;
  required?: boolean;
}

export type WizardField =
  | (FieldBase & { type: "text" | "textarea" | "email" | "url" | "tel"; maxLength?: number; minLength?: number; pattern?: RegExp; placeholder?: string })
  | (FieldBase & { type: "number"; min?: number; max?: number; integer?: boolean })
  | (FieldBase & { type: "boolean" })
  | (FieldBase & { type: "choice"; options: readonly string[] })
  | (FieldBase & { type: "date"; min?: string; max?: string });

export type WizardValue = string | number | boolean;
export type WizardValues = Record<string, WizardValue>;
export type WizardErrors = Record<string, string>;

export interface WizardStep {
  id: string;
  label?: string;
  fields: Record<string, WizardField>;
  check?(values: WizardValues, all: WizardValues, ctx: PageContext): WizardErrors | void | Promise<WizardErrors | void>;
  when?(all: WizardValues): boolean;
}

export interface Draft {
  step: string;
  values: WizardValues;
  done: string[];
  updated: number;
}

export interface DraftStore {
  get(wizard: string, owner: string): Draft | null | Promise<Draft | null>;
  put(wizard: string, owner: string, draft: Draft): void | Promise<void>;
  take(wizard: string, owner: string): Draft | null | Promise<Draft | null>;
  sweep(before: number): number | Promise<number>;
}

export interface WizardOptions<R> {
  name: string;
  steps: readonly WizardStep[];
  store: DraftStore;
  complete(ctx: PageContext, values: WizardValues): R | Promise<R>;
  anonymous?: boolean;
  ttlDays?: number;
  now?(): number;
}

export interface WizardFieldView {
  name: string;
  label: string;
  description: string | null;
  type: WizardField["type"];
  required: boolean;
  value: WizardValue | null;
  options: readonly string[] | null;
  min: number | string | null;
  max: number | string | null;
  maxLength: number | null;
}

export interface WizardView {
  step: string;
  label: string;
  index: number;
  total: number;
  steps: { id: string; label: string; done: boolean; current: boolean; reachable: boolean }[];
  fields: WizardFieldView[];
  back: string | null;
  last: boolean;
  saved: number | null;
}

export type WizardSave =
  | { ok: true;  step: string | null }
  | { ok: false; reason: "invalid"; errors: WizardErrors }
  | { ok: false; reason: "not-found" | "unreachable" };

export type WizardFinish<R> =
  | { ok: true; result: R }
  | { ok: false; reason: "invalid"; step: string; errors: WizardErrors }
  | { ok: false; reason: "not-found" | "incomplete" };

export interface Wizard<R> {
  readonly name: string;
  view(ctx: PageContext): Promise<WizardView | null>;
  save(ctx: PageContext, step: string, input: unknown, o?: { go?: "next" | "stay" | "back" }): Promise<WizardSave>;
  finish(ctx: PageContext): Promise<WizardFinish<R>>;
  discard(ctx: PageContext): Promise<void>;
  values(ctx: PageContext): Promise<WizardValues | null>;
  sweep(): Promise<number>;
}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const EMAIL = /^[^\s@"<>()\[\],;:\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const TEL = /^\+?[0-9 ().-]{3,32}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86_400_000;

function validDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

function checkField(step: string, name: string, f: WizardField): void {
  const where = `defineWizard: ${step}.${name}`;
  if (!FIELD.test(name) || name === "__proto__") throw new Error(`${where}: bad field name`);
  switch (f.type) {
    case "text":
    case "textarea":
    case "email":
    case "url":
    case "tel":
      for (const k of ["minLength", "maxLength"] as const) {
        const v = f[k];
        if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new Error(`${where}: ${k} is a whole number`);
      }
      if (f.pattern !== undefined && (!(f.pattern instanceof RegExp) || f.pattern.global || f.pattern.sticky)) {
        throw new Error(`${where}: pattern is a RegExp without g or y`);
      }
      return;
    case "number":
      for (const k of ["min", "max"] as const) {
        if (f[k] !== undefined && !Number.isFinite(f[k])) throw new Error(`${where}: ${k} is a number`);
      }
      return;
    case "choice":
      if (!Array.isArray(f.options) || f.options.length === 0 || f.options.some((o) => typeof o !== "string")) {
        throw new Error(`${where}: options are strings`);
      }
      return;
    case "date":
      for (const k of ["min", "max"] as const) {
        if (f[k] !== undefined && !validDate(f[k]!)) throw new Error(`${where}: ${k} is a YYYY-MM-DD date`);
      }
      return;
    case "boolean":
      return;
    default:
      throw new Error(`${where}: unknown type ${(f as { type: unknown }).type}`);
  }
}

function parse(f: WizardField, raw: unknown): { value?: WizardValue; error?: string } {
  if (f.type === "boolean") {
    const on = raw === true || raw === "on" || raw === "true" || raw === "1";
    if (f.required && !on) return { error: "Required." };
    return { value: on };
  }
  if (raw === undefined || raw === null || raw === "") return f.required ? { error: "Required." } : {};
  if (f.type === "number") {
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return { error: "Enter a number." };
    if (f.integer && !Number.isInteger(n)) return { error: "Enter a whole number." };
    if (f.min !== undefined && n < f.min) return { error: `At least ${f.min}.` };
    if (f.max !== undefined && n > f.max) return { error: `At most ${f.max}.` };
    return { value: n };
  }
  if (typeof raw !== "string") return { error: "Not a valid answer." };
  const s = f.type === "textarea" ? raw.replace(/\r\n?/g, "\n") : raw.trim();
  if (s === "") return f.required ? { error: "Required." } : {};
  switch (f.type) {
    case "choice":
      return f.options.includes(s) ? { value: s } : { error: "Choose one of the options." };
    case "date":
      if (!validDate(s)) return { error: "Enter a date." };
      if (f.min !== undefined && s < f.min) return { error: `On or after ${f.min}.` };
      if (f.max !== undefined && s > f.max) return { error: `On or before ${f.max}.` };
      return { value: s };
    default: {
      if ((f.type === "textarea" ? /[\u0000-\u0008\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(s)) {
        return { error: "Not a valid answer." };
      }
      const max = f.maxLength ?? (f.type === "textarea" ? 10_000 : 1_000);
      const length = [...s].length;
      if (length > max) return { error: `At most ${max} characters.` };
      if (f.minLength !== undefined && length < f.minLength) return { error: `At least ${f.minLength} characters.` };
      if (f.type === "email" && (s.length > 254 || !EMAIL.test(s))) return { error: "Enter an email address." };
      if (f.type === "tel" && !TEL.test(s)) return { error: "Enter a phone number." };
      if (f.type === "url") {
        let u: URL | null = null;
        try {
          u = new URL(s);
        } catch {
        }
        if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return { error: "Enter a web address." };
      }
      if (f.pattern && !f.pattern.test(s)) return { error: "Not in the expected format." };
      return { value: s };
    }
  }
}

function field(input: unknown, name: string): unknown {
  if (input instanceof URLSearchParams || (typeof FormData !== "undefined" && input instanceof FormData)) {
    const v = input.get(name);
    return v === null ? undefined : typeof v === "string" ? v : undefined;
  }
  if (input && typeof input === "object" && Object.hasOwn(input, name)) return (input as Record<string, unknown>)[name];
  return undefined;
}

export function defineWizard<R>(o: WizardOptions<R>): Wizard<R> {
  if (!NAME.test(o.name)) throw new Error("defineWizard: name is 1-64 of A-Z a-z 0-9 . _ -");
  if (!Array.isArray(o.steps) || o.steps.length === 0) throw new Error("defineWizard: at least one step");
  if (typeof o.complete !== "function") throw new Error("defineWizard: complete is a function");
  const ttlDays = o.ttlDays ?? 30;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) throw new Error("defineWizard: ttlDays is more than 0");
  const now = o.now ?? Date.now;
  const steps: readonly WizardStep[] = o.steps.map((s) => ({ ...s, fields: { ...s.fields } }));
  const ids = new Set<string>();
  const owners = new Map<string, string>();
  for (const s of steps) {
    if (!NAME.test(s.id)) throw new Error(`defineWizard: bad step id ${String(s.id)}`);
    if (ids.has(s.id)) throw new Error(`defineWizard: step ${s.id} twice`);
    ids.add(s.id);
    for (const [name, f] of Object.entries(s.fields)) {
      checkField(s.id, name, f);
      const other = owners.get(name);
      if (other) throw new Error(`defineWizard: field ${name} is in steps ${other} and ${s.id}`);
      owners.set(name, s.id);
    }
  }

  const ownerOf = (ctx: PageContext): string | null => {
    const user = ctx.user as { id?: unknown } | null;
    if (user && (typeof user.id === "string" || typeof user.id === "number")) return `user:${user.id}`;
    return o.anonymous && typeof ctx.session === "string" && ctx.session !== "" ? `session:${ctx.session}` : null;
  };

  const fresh = (): Draft => ({ step: steps[0]!.id, values: {}, done: [], updated: 0 });

  const load = async (owner: string): Promise<Draft> => {
    const d = await o.store.get(o.name, owner);
    if (!d || now() - d.updated > ttlDays * DAY) return fresh();
    const values: WizardValues = {};
    for (const [k, v] of Object.entries(d.values ?? {})) {
      if (owners.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) values[k] = v;
    }
    return { step: ids.has(d.step) ? d.step : steps[0]!.id, values, done: (d.done ?? []).filter((s) => ids.has(s)), updated: d.updated };
  };

  const applying = (all: WizardValues) => steps.filter((s) => !s.when || s.when(all));

  const reachable = (d: Draft, list: typeof steps, step: string) => {
    for (const s of list) {
      if (s.id === step) return true;
      if (!d.done.includes(s.id)) return false;
    }
    return false;
  };

  const errorsOf = async (ctx: PageContext, s: (typeof steps)[number], input: unknown, all: WizardValues) => {
    const values: WizardValues = {};
    const errors: WizardErrors = {};
    for (const [name, f] of Object.entries(s.fields)) {
      const r = parse(f, field(input, name));
      if (r.error) errors[name] = r.error;
      else if (r.value !== undefined) values[name] = r.value;
    }
    if (Object.keys(errors).length === 0 && s.check) {
      const more = await s.check(values, { ...all, ...values }, ctx);
      for (const [k, v] of Object.entries(more ?? {})) {
        if (typeof v === "string" && v !== "") errors[Object.hasOwn(s.fields, k) ? k : ""] = v;
      }
    }
    return { values, errors };
  };

  const withStep = (all: WizardValues, s: (typeof steps)[number], values: WizardValues) => {
    const next: WizardValues = {};
    for (const [k, v] of Object.entries(all)) if (!Object.hasOwn(s.fields, k)) next[k] = v;
    return Object.assign(next, values);
  };

  return {
    name: o.name,

    async view(ctx) {
      const owner = ownerOf(ctx);
      if (!owner) return null;
      const d = await load(owner);
      const list = applying(d.values);
      const asked = ctx.url?.searchParams.get("step");
      let current = list.find((s) => s.id === (asked && reachable(d, list, asked) ? asked : d.step));
      if (!current || !reachable(d, list, current.id)) current = list.find((s) => !d.done.includes(s.id)) ?? list.at(-1)!;
      const index = list.indexOf(current);
      return {
        step: current.id,
        label: current.label ?? current.id,
        index,
        total: list.length,
        steps: list.map((s) => ({
          id: s.id,
          label: s.label ?? s.id,
          done: d.done.includes(s.id),
          current: s === current,
          reachable: reachable(d, list, s.id),
        })),
        fields: Object.entries(current.fields).map(([name, f]) => ({
          name,
          label: f.label ?? name,
          description: f.description ?? null,
          type: f.type,
          required: f.required === true,
          value: Object.hasOwn(d.values, name) ? d.values[name]! : null,
          options: f.type === "choice" ? f.options : null,
          min: f.type === "number" || f.type === "date" ? (f.min ?? null) : null,
          max: f.type === "number" || f.type === "date" ? (f.max ?? null) : null,
          maxLength: "maxLength" in f ? (f.maxLength ?? null) : null,
        })),
        back: index > 0 ? list[index - 1]!.id : null,
        last: index === list.length - 1,
        saved: d.updated || null,
      };
    },

    async save(ctx, step, input, opts = {}) {
      const owner = ownerOf(ctx);
      if (!owner) return { ok: false, reason: "not-found" };
      const go = opts.go ?? "next";
      const d = await load(owner);
      let list = applying(d.values);
      const s = list.find((x) => x.id === step);
      if (!s || !reachable(d, list, step)) return { ok: false, reason: "unreachable" };
      if (go === "back") {
        const kept: WizardValues = {};
        for (const [name, f] of Object.entries(s.fields)) {
          const r = parse({ ...f, required: false } as WizardField, field(input, name));
          if (!r.error && r.value !== undefined) kept[name] = r.value;
        }
        const values = withStep(d.values, s, { ...Object.fromEntries(Object.entries(d.values).filter(([k]) => Object.hasOwn(s.fields, k))), ...kept });
        list = applying(values);
        const at = list.indexOf(list.find((x) => x.id === step) ?? list[0]!);
        const prev = list[Math.max(0, at - 1)]!.id;
        await o.store.put(o.name, owner, { step: prev, values, done: d.done, updated: now() });
        return { ok: true, step: prev };
      }
      const { values, errors } = await errorsOf(ctx, s, input, d.values);
      if (Object.keys(errors).length) return { ok: false, reason: "invalid", errors };
      const all = withStep(d.values, s, values);
      list = applying(all);
      const done = [...new Set([...d.done, step])];
      const at = list.findIndex((x) => x.id === step);
      const next = go === "stay" ? step : (list.slice(at + 1).find((x) => !done.includes(x.id)) ?? list.find((x) => !done.includes(x.id)))?.id ?? null;
      await o.store.put(o.name, owner, { step: next ?? step, values: all, done, updated: now() });
      return { ok: true, step: go === "stay" ? step : next };
    },

    async finish(ctx) {
      const owner = ownerOf(ctx);
      if (!owner) return { ok: false, reason: "not-found" };
      const d = await load(owner);
      if (!d.updated) return { ok: false, reason: "incomplete" };
      const list = applying(d.values);
      const values: WizardValues = {};
      for (const s of list) {
        if (!d.done.includes(s.id)) return { ok: false, reason: "incomplete" };
        const { values: v, errors } = await errorsOf(ctx, s, d.values, d.values);
        if (Object.keys(errors).length) return { ok: false, reason: "invalid", step: s.id, errors };
        Object.assign(values, v);
      }
      const claimed = await o.store.take(o.name, owner);
      if (!claimed || claimed.updated !== d.updated) {
        if (claimed) await o.store.put(o.name, owner, claimed);
        return { ok: false, reason: "incomplete" };
      }
      try {
        return { ok: true, result: await o.complete(ctx, values) };
      } catch (err) {
        await o.store.put(o.name, owner, claimed);
        throw err;
      }
    },

    async discard(ctx) {
      const owner = ownerOf(ctx);
      if (owner) await o.store.take(o.name, owner);
    },

    async values(ctx) {
      const owner = ownerOf(ctx);
      if (!owner) return null;
      const d = await load(owner);
      const out: WizardValues = {};
      for (const s of applying(d.values)) {
        for (const k of Object.keys(s.fields)) if (Object.hasOwn(d.values, k)) out[k] = d.values[k]!;
      }
      return out;
    },

    async sweep() {
      return await o.store.sweep(now() - ttlDays * DAY);
    },
  };
}

export class MemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<string, Draft>();

  get(wizard: string, owner: string): Draft | null {
    const d = this.drafts.get(`${wizard}\n${owner}`);
    return d ? structuredClone(d) : null;
  }

  put(wizard: string, owner: string, draft: Draft): void {
    this.drafts.set(`${wizard}\n${owner}`, structuredClone(draft));
  }

  take(wizard: string, owner: string): Draft | null {
    const key = `${wizard}\n${owner}`;
    const d = this.drafts.get(key) ?? null;
    this.drafts.delete(key);
    return d;
  }

  sweep(before: number): number {
    let n = 0;
    for (const [k, d] of this.drafts) {
      if (d.updated < before) {
        this.drafts.delete(k);
        n++;
      }
    }
    return n;
  }
}

export class SqlDraftStore implements DraftStore {
  private readonly db: SqlDatabase;
  private readonly table: string;

  constructor(db: SqlDatabase, table = "weft_drafts") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`SqlDraftStore: bad table name ${table}`);
    this.db = db;
    this.table = table;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (wizard TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL, ` +
        `updated INTEGER NOT NULL, PRIMARY KEY (wizard, owner))`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_updated ON ${table} (updated)`);
  }

  private decode(r: unknown): Draft | null {
    if (!r || typeof r !== "object") return null;
    try {
      const d = JSON.parse(String((r as { data: unknown }).data)) as Draft;
      return { step: String(d.step), values: d.values ?? {}, done: Array.isArray(d.done) ? d.done.map(String) : [], updated: Number((r as { updated: unknown }).updated) };
    } catch {
      return null;
    }
  }

  get(wizard: string, owner: string): Draft | null {
    return this.decode(this.db.prepare(`SELECT data, updated FROM ${this.table} WHERE wizard = ? AND owner = ?`).all(wizard, owner)[0]);
  }

  put(wizard: string, owner: string, draft: Draft): void {
    const data = JSON.stringify({ step: draft.step, values: draft.values, done: draft.done });
    this.db
      .prepare(
        `INSERT INTO ${this.table} (wizard, owner, data, updated) VALUES (?, ?, ?, ?) ` +
          `ON CONFLICT (wizard, owner) DO UPDATE SET data = excluded.data, updated = excluded.updated`,
      )
      .run(wizard, owner, data, draft.updated);
  }

  take(wizard: string, owner: string): Draft | null {
    return this.decode(this.db.prepare(`DELETE FROM ${this.table} WHERE wizard = ? AND owner = ? RETURNING data, updated`).all(wizard, owner)[0]);
  }

  sweep(before: number): number {
    return Number((this.db.prepare(`DELETE FROM ${this.table} WHERE updated < ?`).run(before) as { changes?: unknown }).changes ?? 0);
  }
}
