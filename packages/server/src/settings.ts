import type { PageContext } from "./context.ts";

interface SettingBase {
  label?: string;
  description?: string;
  editable?: boolean;
}

export type SettingSpec =
  | (SettingBase & { type: "boolean"; default: boolean })
  | (SettingBase & { type: "number"; default: number; min?: number; max?: number; integer?: boolean })
  | (SettingBase & { type: "string"; default: string; options?: readonly string[]; maxLength?: number });

export type SettingsSchema = { readonly [key: string]: SettingSpec };

type Values = Record<string, unknown>;

export interface SettingsOptions {
  schema: SettingsSchema;
  load(ctx: PageContext): Values | undefined | Promise<Values | undefined>;
  save(ctx: PageContext, patch: Values): unknown;
  canEdit?(ctx: PageContext, key: string): boolean | Promise<boolean>;
  groups?: readonly { label: string; description?: string; keys: readonly string[] }[];
}

export interface SettingView {
  key: string;
  label: string;
  description: string | null;
  type: SettingSpec["type"];
  value: boolean | number | string;
  editable: boolean;
  fixed: boolean;
  options: readonly string[] | null;
  min: number | null;
  max: number | null;
  integer: boolean;
  maxLength: number | null;
}

export interface SettingsView {
  sections: { label: string; description: string | null; settings: SettingView[] }[];
  shown: Record<string, boolean | number | string>;
}

export type SaveResult =
  | { ok: true; saved: Values }
  | { ok: false; reason: "not found" | "forbidden"; error: string }
  | { ok: false; reason: "invalid"; key: string | null; error: string };

export interface Settings {
  view(ctx: PageContext): Promise<SettingsView | null>;
  save(ctx: PageContext, input: Readonly<Record<string, unknown>>, shown?: Readonly<Record<string, unknown>> | null): Promise<SaveResult>;
  schema: SettingsSchema;
}

const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const MAX_TEXT = 1000;

export function settingProblem(spec: SettingSpec, value: unknown): string | null {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "is yes or no";
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "is a number";
      if (spec.integer && !Number.isInteger(value)) return "is a whole number";
      if (spec.min !== undefined && value < spec.min) return `is at least ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `is at most ${spec.max}`;
      return null;
    case "string":
      if (typeof value !== "string") return "is text";
      if (spec.options && !spec.options.includes(value)) return `is one of ${spec.options.join(", ")}`;
      return value.length <= (spec.maxLength ?? MAX_TEXT) ? null : `is at most ${spec.maxLength ?? MAX_TEXT} characters`;
  }
}

function humanize(key: string): string {
  const s = key.replace(/[._]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function numberToken(t: string): boolean {
  let i = 0;
  if (t[i] === "-") i++;
  let digits = false;
  while (i < t.length && t.charCodeAt(i) >= 48 && t.charCodeAt(i) <= 57) {
    i++;
    digits = true;
  }
  if (t[i] === ".") {
    i++;
    while (i < t.length && t.charCodeAt(i) >= 48 && t.charCodeAt(i) <= 57) {
      i++;
      digits = true;
    }
  }
  if (!digits) return false;
  if (t[i] === "e" || t[i] === "E") {
    i++;
    if (t[i] === "+" || t[i] === "-") i++;
    const exp = i;
    while (i < t.length && t.charCodeAt(i) >= 48 && t.charCodeAt(i) <= 57) i++;
    if (i === exp) return false;
  }
  return i === t.length;
}

function parse(spec: SettingSpec, raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (spec.type === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  if (spec.type === "number") {
    const t = raw.trim();
    return t === "" || !numberToken(t) ? Number.NaN : Number(t);
  }
  return raw;
}

export function defineSettings(opts: SettingsOptions): Settings {
  const fail = (msg: string): never => {
    throw new Error(`defineSettings: ${msg}`);
  };
  if (!opts || typeof opts.load !== "function" || typeof opts.save !== "function") fail("`load(ctx)` and `save(ctx, patch)` are required");
  if (opts.canEdit !== undefined && typeof opts.canEdit !== "function") fail("canEdit is a function");

  const specs = new Map<string, SettingSpec>();
  for (const [key, spec] of Object.entries(opts.schema ?? {})) {
    if (!KEY_RE.test(key) || key.length > 100) fail(`setting \`${key}\`: keys are lower case, dot-separated`);
    if (!spec || !["boolean", "number", "string"].includes(spec.type)) fail(`setting \`${key}\`: type is boolean, number or string`);
    if (spec.type === "string" && spec.options !== undefined && (!Array.isArray(spec.options) || spec.options.length === 0)) {
      fail(`setting \`${key}\`: options lists the allowed values`);
    }
    if (spec.type === "number" && spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) fail(`setting \`${key}\`: min is above max`);
    const p = settingProblem(spec, spec.default);
    if (p !== null) fail(`setting \`${key}\`: the default ${p}`);
    specs.set(key, spec);
  }
  if (specs.size === 0) fail("the schema has no settings");

  const sections: { label: string; description: string | null; keys: string[] }[] = [];
  const placed = new Set<string>();
  for (const g of opts.groups ?? []) {
    if (!g || typeof g.label !== "string" || g.label === "") fail("each group has a label");
    for (const k of g.keys) {
      if (!specs.has(k)) fail(`group \`${g.label}\`: no setting \`${k}\``);
      if (placed.has(k)) fail(`setting \`${k}\` is in two groups`);
      placed.add(k);
    }
    sections.push({ label: g.label, description: g.description ?? null, keys: [...g.keys] });
  }
  const rest = [...specs.keys()].filter((k) => !placed.has(k));
  if (rest.length) sections.push({ label: "", description: null, keys: rest });

  async function editableKeys(ctx: PageContext): Promise<Set<string>> {
    const out = new Set<string>();
    for (const [k, spec] of specs) {
      if (spec.editable !== true) continue;
      let ok = true;
      if (opts.canEdit) {
        try {
          ok = (await opts.canEdit(ctx, k)) === true;
        } catch {
          ok = false;
        }
      }
      if (ok) out.add(k);
    }
    return out;
  }

  async function current(ctx: PageContext): Promise<Values | undefined> {
    const v = await opts.load(ctx);
    if (v === undefined || v === null) return undefined;
    const out: Values = {};
    for (const [k, spec] of specs) out[k] = Object.hasOwn(v, k) && settingProblem(spec, v[k]) === null ? v[k] : spec.default;
    return out;
  }

  return {
    schema: Object.freeze(Object.fromEntries(specs)),

    async view(ctx) {
      const values = await current(ctx);
      if (values === undefined) return null;
      const can = await editableKeys(ctx);
      const shown: Record<string, boolean | number | string> = {};
      for (const k of can) shown[k] = values[k] as boolean | number | string;
      return {
        shown,
        sections: sections.map((s) => ({
          label: s.label,
          description: s.description,
          settings: s.keys.map((key): SettingView => {
            const spec = specs.get(key)!;
            return {
              key,
              label: spec.label ?? humanize(key),
              description: spec.description ?? null,
              type: spec.type,
              value: values[key] as boolean | number | string,
              editable: can.has(key),
              fixed: spec.editable !== true,
              options: spec.type === "string" ? (spec.options ?? null) : null,
              min: spec.type === "number" ? (spec.min ?? null) : null,
              max: spec.type === "number" ? (spec.max ?? null) : null,
              integer: spec.type === "number" && spec.integer === true,
              maxLength: spec.type === "string" ? (spec.maxLength ?? MAX_TEXT) : null,
            };
          }),
        })),
      };
    },

    async save(ctx, input, shown = null) {
      const now = await current(ctx);
      if (now === undefined) return { ok: false, reason: "not found", error: "Not found" };
      if (!input || typeof input !== "object") return { ok: false, reason: "invalid", key: null, error: "No settings given" };
      const editable = await editableKeys(ctx);
      const patch: Values = {};
      for (const key of editable) {
        if (!Object.hasOwn(input, key)) continue;
        const spec = specs.get(key)!;
        const v = parse(spec, input[key]);
        const p = settingProblem(spec, v);
        if (p !== null) return { ok: false, reason: "invalid", key, error: `${spec.label ?? humanize(key)}: ${p}` };
        const before = shown && Object.hasOwn(shown, key) ? parse(spec, shown[key]) : now[key];
        if (v !== before && v !== now[key]) patch[key] = v;
      }
      if (Object.keys(patch).length > 0) {
        try {
          await opts.save(ctx, patch);
        } catch (err) {
          const code = (err as { code?: unknown } | null)?.code;
          if (code === "invalid") return { ok: false, reason: "invalid", key: null, error: (err as Error).message };
          if (code === "forbidden" || code === "not-found") return { ok: false, reason: "forbidden", error: "You may not change these settings" };
          throw err;
        }
      }
      return { ok: true, saved: patch };
    },
  };
}
