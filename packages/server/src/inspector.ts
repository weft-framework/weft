import { defineModel, type Model } from "@weft-framework/data";
import { defineAction, type Action } from "./action.ts";
import { viewingAs } from "./auth.ts";
import type { PageContext } from "./context.ts";
import { inspectHubs, sessionKey, type InspectPage, type InspectView } from "./inspect-hub.ts";

type Maybe<T> = T | Promise<T>;

export type InspectorEvent = "consent-grant" | "consent-withdraw" | "list" | "look" | "frame";

export interface InspectorLogEntry {
  id: string;
  event: InspectorEvent;
  user: string | null;
  operator: string | null;
  at: number;
  detail: string | null;
}

export interface InspectorSession {
  id: string;
  user: string;
  until: number;
  pages: InspectPage[];
}

export interface InspectorOptions {
  allow(operator: string): Maybe<boolean>;
  maxMinutes?: number;
  userId?(ctx: PageContext): string | null | undefined;
  name?: string;
  now?(): number;
}

export interface Inspector {
  models: Model<never>[];
  actions: Record<string, Action<never[]>>;
  consent(ctx: PageContext, minutes: number): { id: string; until: number } | null;
  withdraw(ctx: PageContext): boolean;
  mine(ctx: PageContext): { until: number | null; log: InspectorLogEntry[]; maxMinutes: number } | null;
  sessions(ctx: PageContext): Promise<InspectorSession[] | null>;
  look(ctx: PageContext, id: string, page: string): Promise<InspectView | null>;
  frame(ctx: PageContext, id: string, page: string, n: number): Promise<{ n: number; at: number; what: string; html: string } | null>;
}

interface ConsentRow {
  id: string;
  key: string;
  user: string;
  until: number;
  granted: number;
}

interface LogRow {
  id: string;
  event: string;
  user: string | null;
  operator: string | null;
  at: number;
  detail: string | null;
}

const KEEPER = Object.freeze({ id: "\u0000weft-inspector" });
const MAX_ID = 256;

export function defineInspector(opts: InspectorOptions): Inspector {
  const fail = (msg: string): never => {
    throw new Error(`defineInspector: ${msg}`);
  };
  if (!opts || typeof opts.allow !== "function") fail("`allow(operator)` decides who may inspect");
  for (const k of ["userId", "now"] as const) {
    if (opts[k] !== undefined && typeof opts[k] !== "function") fail(`${k} is a function`);
  }
  const prefix = opts.name ?? "inspector";
  if (!/^[a-z][A-Za-z0-9]{0,40}$/.test(prefix)) fail("name is an identifier");
  const maxMinutes = opts.maxMinutes ?? 60;
  if (!Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 1440) fail("maxMinutes is a whole number from 1 to 1440");
  const now = opts.now ?? Date.now;
  const Name = prefix.charAt(0).toUpperCase() + prefix.slice(1);

  const Consent = defineModel<ConsentRow>(`${Name}Consent`, {
    fields: { id: "string", key: "string", user: "string", until: "number", granted: "number" },
    attrs: { key: { index: true } },
    read: (a) => a === KEEPER,
    write: (a) => a === KEEPER,
  });
  const Log = defineModel<LogRow>(`${Name}Log`, {
    fields: { id: "string", event: "string", user: "string | null", operator: "string | null", at: "number", detail: "string | null" },
    attrs: { user: { index: true } },
    read: (a) => a === KEEPER,
    write: (a) => a === KEEPER,
  });

  let lastAt = 0;
  let seq = 0;
  const record = (event: InspectorEvent, user: string | null, operator: string | null, detail: string | null = null): void => {
    const t = now();
    seq = t === lastAt ? seq + 1 : 0;
    lastAt = t;
    const id = `${t.toString(36).padStart(10, "0")}${seq.toString(36).padStart(4, "0")}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    Log.as(KEEPER).create({ id, event, user, operator, at: t, detail });
  };

  const userIdOf = (ctx: PageContext): string | null => {
    if (viewingAs(ctx)) return null;
    try {
      const id = opts.userId ? opts.userId(ctx) : (ctx.user as { id?: unknown } | null)?.id;
      return typeof id === "string" && id !== "" && id.length <= MAX_ID ? id : null;
    } catch {
      return null;
    }
  };

  const operator = async (ctx: PageContext): Promise<string | null> => {
    const id = userIdOf(ctx);
    if (id === null) return null;
    try {
      return (await opts.allow(id)) === true ? id : null;
    } catch {
      return null;
    }
  };

  const watch = (key: string, until: number): void => {
    for (const hub of inspectHubs()) hub.watch(key, until);
  };

  const valid = (id: unknown): ConsentRow | null => {
    if (typeof id !== "string" || id === "" || id.length > MAX_ID) return null;
    const row = Consent.as(KEEPER).get(id);
    if (!row) return null;
    if (row.until <= now()) {
      Consent.as(KEEPER).delete((r) => r.id === row.id);
      watch(row.key, 0);
      return null;
    }
    watch(row.key, row.until);
    return row;
  };

  const inspector: Inspector = {
    models: [Consent as unknown as Model<never>, Log as unknown as Model<never>],
    actions: {},

    consent(ctx, minutes) {
      const me = userIdOf(ctx);
      if (me === null || typeof ctx.session !== "string" || ctx.session === "") return null;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > maxMinutes) {
        throw new RangeError(`inspector.consent: minutes is a whole number from 1 to ${maxMinutes}`);
      }
      const key = sessionKey(ctx.session);
      const t = now();
      const until = t + minutes * 60_000;
      const c = Consent.as(KEEPER);
      const had = c.query().where({ key }).all()[0];
      if (had && had.user !== me) c.delete((r) => r.id === had.id);
      let id: string;
      if (had && had.user === me) {
        id = had.id;
        c.update((r) => r.id === id, { until, granted: t });
      } else {
        id = crypto.randomUUID();
        c.create({ id, key, user: me, until, granted: t });
      }
      watch(key, until);
      record("consent-grant", me, null, String(minutes));
      return { id, until };
    },

    withdraw(ctx) {
      const me = userIdOf(ctx);
      if (me === null || typeof ctx.session !== "string") return false;
      const key = sessionKey(ctx.session);
      const n = Consent.as(KEEPER).delete((r) => r.key === key);
      watch(key, 0);
      if (n > 0) record("consent-withdraw", me, null);
      return n > 0;
    },

    mine(ctx) {
      const me = userIdOf(ctx);
      if (me === null || typeof ctx.session !== "string") return null;
      const row = Consent.as(KEEPER).query().where({ key: sessionKey(ctx.session) }).all()[0];
      const until = row && row.user === me && row.until > now() ? row.until : null;
      const log = Log.as(KEEPER)
        .query()
        .where({ user: me })
        .orderBy("id", "desc")
        .limit(100)
        .all()
        .map((r) => ({ id: r.id, event: r.event as InspectorEvent, user: r.user, operator: r.operator, at: r.at, detail: r.detail }));
      return { until, log, maxMinutes };
    },

    async sessions(ctx) {
      const op = await operator(ctx);
      if (op === null) return null;
      const out: InspectorSession[] = [];
      for (const row of Consent.as(KEEPER).all()) {
        if (!valid(row.id)) continue;
        out.push({ id: row.id, user: row.user, until: row.until, pages: inspectHubs().flatMap((h) => h.pages(row.key)) });
      }
      record("list", null, op, String(out.length));
      return out;
    },

    async look(ctx, id, page) {
      const op = await operator(ctx);
      const row = op === null ? null : valid(id);
      if (op === null || !row || typeof page !== "string") return null;
      for (const hub of inspectHubs()) {
        const view = hub.view(row.key, page);
        if (view) {
          record("look", row.user, op, view.path);
          return view;
        }
      }
      return null;
    },

    async frame(ctx, id, page, n) {
      const op = await operator(ctx);
      const row = op === null ? null : valid(id);
      if (op === null || !row || typeof page !== "string" || !Number.isInteger(n) || n < 0) return null;
      for (const hub of inspectHubs()) {
        const f = hub.frame(row.key, page, n);
        if (f) {
          record("frame", row.user, op, `${hub.pages(row.key).find((p) => p.page === page)?.path ?? ""} #${n}`);
          return f;
        }
      }
      return null;
    },
  };

  const minutes = (raw: string): number => (/^\d{1,5}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN);
  inspector.actions = {
    [`${prefix}Consent`]: defineAction(`${prefix}Consent`, [{ name: "minutes", type: "string" }], (ctx, m: string) => {
      const n = minutes(m);
      return Number.isInteger(n) && n >= 1 && n <= maxMinutes ? inspector.consent(ctx, n) : null;
    }) as Action<never[]>,
    [`${prefix}Withdraw`]: defineAction(`${prefix}Withdraw`, [], (ctx) => inspector.withdraw(ctx)) as Action<never[]>,
  };
  return inspector;
}
