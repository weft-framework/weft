import { defineModel, type Model } from "@weft-framework/data";
import { defineAction, type Action } from "./action.ts";
import { allowWhileViewing, stopViewingAs, viewAs, viewingAs, type Viewing } from "./auth.ts";
import type { PageContext } from "./context.ts";

type Maybe<T> = T | Promise<T>;

export interface SupportMatch {
  id: string;
  label: string;
  detail?: string;
}

export type SupportEvent = "lookup" | "open" | "view-start" | "view-stop" | "consent-grant" | "consent-revoke";

export interface SupportLogEntry {
  id: string;
  event: SupportEvent;
  user: string | null;
  operator: string | null;
  at: number;
  detail: string | null;
}

export interface SupportCustomerView<C> {
  id: string;
  customer: C;
  consent: number | null;
  viewable: boolean;
  log: SupportLogEntry[];
}

export type StartViewResult =
  | { ok: true; until: number }
  | { ok: false; reason: "not found" | "no consent" | "bad reason" | "bad minutes" | "bad tenant" | "refused" };

export interface SupportOptions<C extends object> {
  allow(operator: string): Maybe<boolean>;
  lookup(query: string, ctx: PageContext): Maybe<readonly SupportMatch[]>;
  describe(id: string, ctx: PageContext): Maybe<(C & { tenants?: readonly string[] }) | null>;
  userId?(ctx: PageContext): string | null;
  consent?: boolean;
  maxConsentMinutes?: number;
  maxViewMinutes?: number;
  maxResults?: number;
  name?: string;
  now?(): number;
}

interface ConsentRow {
  id: string;
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

export interface Support<C extends object> {
  models: readonly Model<never>[];
  viewAs(operator: string, user: string): Promise<boolean>;
  operator(ctx: PageContext): Promise<string | null>;
  search(ctx: PageContext, query: string): Promise<{ query: string; results: SupportMatch[]; more: boolean } | null>;
  customer(ctx: PageContext, id: string): Promise<SupportCustomerView<C> | null>;
  startView(ctx: PageContext, o: { user: string; minutes: number; reason: string; tenant?: string }): Promise<StartViewResult | null>;
  stopView(ctx: PageContext): Promise<boolean>;
  viewing(ctx: PageContext): Viewing | null;
  myAccess(ctx: PageContext): { user: string; consent: number | null; log: SupportLogEntry[]; maxMinutes: number } | null;
  grant(ctx: PageContext, minutes: number): number | null;
  revoke(ctx: PageContext): boolean;
  consentUntil(user: string): number | null;
  log(o?: { user?: string; operator?: string; limit?: number }): SupportLogEntry[];
  actions: Record<string, Action<never[]>>;
}

const MAX_ID = 200;
const MAX_QUERY = 200;
const MAX_REASON = 500;
const LOG_LIMIT = 1000;

const KEEPER = Object.freeze({ id: "\u0000weft-support" });

export function defineSupport<C extends object = Record<string, unknown>>(opts: SupportOptions<C>): Support<C> {
  const fail = (msg: string): never => {
    throw new Error(`defineSupport: ${msg}`);
  };
  if (!opts || typeof opts.allow !== "function") fail("`allow(operator)` decides who is an operator");
  if (typeof opts.lookup !== "function" || typeof opts.describe !== "function") fail("`lookup(query)` and `describe(id)` are required");
  for (const k of ["userId", "now"] as const) {
    if (opts[k] !== undefined && typeof opts[k] !== "function") fail(`${k} is a function`);
  }
  const prefix = opts.name ?? "support";
  if (!/^[a-z][A-Za-z0-9]{0,40}$/.test(prefix)) fail("name is an identifier");
  const whole = (v: unknown, dflt: number, max: number, what: string): number => {
    const n = v === undefined ? dflt : v;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max) fail(`${what} is a whole number from 1 to ${max}`);
    return n as number;
  };
  const maxConsent = whole(opts.maxConsentMinutes, 7 * 1440, 90 * 1440, "maxConsentMinutes");
  const maxView = whole(opts.maxViewMinutes, 30, 24 * 60, "maxViewMinutes");
  const maxResults = whole(opts.maxResults, 50, 500, "maxResults");
  const needConsent = opts.consent !== false;
  const now = opts.now ?? Date.now;
  const Name = prefix.charAt(0).toUpperCase() + prefix.slice(1);

  const Consent = defineModel<ConsentRow>(`${Name}Consent`, {
    fields: { id: "string", until: "number", granted: "number" },
    read: (a) => a === KEEPER,
    write: (a) => a === KEEPER,
  });
  const Log = defineModel<LogRow>(`${Name}Log`, {
    fields: { id: "string", event: "string", user: "string | null", operator: "string | null", at: "number", detail: "string | null" },
    attrs: { user: { index: true }, operator: { index: true } },
    read: (a) => a === KEEPER,
    write: (a) => a === KEEPER,
  });

  let lastAt = 0;
  let seq = 0;
  const record = (event: SupportEvent, user: string | null, operator: string | null, detail: string | null = null): void => {
    const t = now();
    seq = t === lastAt ? seq + 1 : 0;
    lastAt = t;
    const id = `${t.toString(36).padStart(10, "0")}${seq.toString(36).padStart(4, "0")}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    Log.as(KEEPER).create({ id, event, user, operator, at: t, detail });
  };

  const userIdOf = (ctx: PageContext): string | null => {
    try {
      const id = opts.userId ? opts.userId(ctx) : (ctx.user as { id?: unknown } | null)?.id;
      return typeof id === "string" && id !== "" ? id : null;
    } catch {
      return null;
    }
  };

  const isOperator = async (id: string | null): Promise<boolean> => {
    if (id === null) return false;
    try {
      return (await opts.allow(id)) === true;
    } catch {
      return false;
    }
  };

  const operator = async (ctx: PageContext): Promise<string | null> => {
    if (viewingAs(ctx)) return null;
    const id = userIdOf(ctx);
    return (await isOperator(id)) ? id : null;
  };

  const consentUntil = (user: string): number | null => {
    const row = Consent.as(KEEPER).get(user);
    return row && row.until > now() ? row.until : null;
  };

  const log = (o: { user?: string; operator?: string; limit?: number } = {}): SupportLogEntry[] => {
    const limit = o.limit === undefined ? 100 : o.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > LOG_LIMIT) throw new RangeError(`support.log: limit is from 1 to ${LOG_LIMIT}`);
    let q = Log.as(KEEPER).query();
    if (o.user !== undefined) q = q.where({ user: o.user });
    if (o.operator !== undefined) q = q.where({ operator: o.operator });
    return q
      .orderBy("id", "desc")
      .limit(limit)
      .all()
      .map((r) => ({ id: r.id, event: r.event as SupportEvent, user: r.user, operator: r.operator, at: r.at, detail: r.detail }));
  };

  const describe = async (id: unknown, ctx: PageContext) => {
    if (typeof id !== "string" || id === "" || id.length > MAX_ID) return null;
    const c = await opts.describe(id, ctx);
    return c && typeof c === "object" ? c : null;
  };

  const customerOf = (ctx: PageContext): string | null => (viewingAs(ctx) ? null : userIdOf(ctx));

  const support: Support<C> = {
    models: [Consent as unknown as Model<never>, Log as unknown as Model<never>],

    async viewAs(op, user) {
      if (op === user || !(await isOperator(op))) return false;
      return !needConsent || consentUntil(user) !== null;
    },

    operator,

    async search(ctx, query) {
      const op = await operator(ctx);
      if (op === null) return null;
      const q = typeof query === "string" ? query.trim().slice(0, MAX_QUERY) : "";
      if (q === "") return { query: q, results: [], more: false };
      const found = await opts.lookup(q, ctx);
      const results = (Array.isArray(found) ? found : [])
        .filter((m) => m && typeof m.id === "string" && m.id !== "" && m.id.length <= MAX_ID && typeof m.label === "string")
        .slice(0, maxResults + 1);
      record("lookup", null, op, q);
      return { query: q, results: results.slice(0, maxResults), more: results.length > maxResults };
    },

    async customer(ctx, id) {
      const op = await operator(ctx);
      if (op === null) return null;
      const c = await describe(id, ctx);
      if (!c) return null;
      record("open", id, op);
      const consent = consentUntil(id);
      return { id, customer: c as C, consent, viewable: !needConsent || consent !== null, log: log({ user: id, limit: 50 }) };
    },

    async startView(ctx, o) {
      const op = await operator(ctx);
      if (op === null) return null;
      const c = await describe(o?.user, ctx);
      if (!c) return { ok: false, reason: "not found" };
      const why = typeof o.reason === "string" ? o.reason.trim() : "";
      if (why === "" || why.length > MAX_REASON) return { ok: false, reason: "bad reason" };
      if (!Number.isInteger(o.minutes) || o.minutes < 1 || o.minutes > maxView) return { ok: false, reason: "bad minutes" };
      const tenants = Array.isArray(c.tenants) ? c.tenants : null;
      let tenant: string | undefined;
      if (tenants && tenants.length > 0) {
        tenant = o.tenant === undefined || o.tenant === "" ? tenants[0] : o.tenant;
        if (!tenants.includes(tenant!)) return { ok: false, reason: "bad tenant" };
      } else if (o.tenant !== undefined && o.tenant !== "") {
        return { ok: false, reason: "bad tenant" };
      }
      const consent = consentUntil(o.user);
      if (needConsent && consent === null) return { ok: false, reason: "no consent" };
      let until = now() + o.minutes * 60_000;
      if (needConsent && consent !== null) until = Math.min(until, consent);
      if (!(await viewAs(ctx, o.user, { until, ...(tenant !== undefined ? { tenant } : {}) }))) return { ok: false, reason: "refused" };
      record("view-start", o.user, op, why);
      return { ok: true, until };
    },

    async stopView(ctx) {
      const v = viewingAs(ctx);
      if (!v) return false;
      await stopViewingAs(ctx);
      record("view-stop", v.user, v.operator);
      return true;
    },

    viewing: viewingAs,

    myAccess(ctx) {
      const v = viewingAs(ctx);
      const me = v ? v.user : userIdOf(ctx);
      if (me === null) return null;
      return { user: me, consent: consentUntil(me), log: log({ user: me }).filter((e) => e.event !== "lookup"), maxMinutes: maxConsent };
    },

    grant(ctx, minutes) {
      const me = customerOf(ctx);
      if (me === null) return null;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > maxConsent) {
        throw new RangeError(`support.grant: minutes is a whole number from 1 to ${maxConsent}`);
      }
      const t = now();
      const until = t + minutes * 60_000;
      const c = Consent.as(KEEPER);
      if (c.get(me)) c.update((r) => r.id === me, { until, granted: t });
      else c.create({ id: me, until, granted: t });
      record("consent-grant", me, null, String(minutes));
      return until;
    },

    revoke(ctx) {
      const me = customerOf(ctx);
      if (me === null) return false;
      const had = consentUntil(me) !== null;
      Consent.as(KEEPER).delete((r) => r.id === me);
      if (had) record("consent-revoke", me, null);
      return had;
    },

    consentUntil,
    log,
    actions: {},
  };

  const minutes = (raw: string): number => (/^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN);
  support.actions = {
    [`${prefix}StartView`]: defineAction(
      `${prefix}StartView`,
      [
        { name: "user", type: "string" },
        { name: "minutes", type: "string" },
        { name: "reason", type: "string" },
        { name: "tenant", type: "string", optional: true },
      ],
      (ctx, user: string, m: string, reason: string, tenant?: string) =>
        support.startView(ctx, { user, minutes: minutes(m), reason, ...(tenant !== undefined ? { tenant } : {}) }),
    ) as Action<never[]>,
    [`${prefix}StopView`]: allowWhileViewing(defineAction(`${prefix}StopView`, [], (ctx) => support.stopView(ctx))) as Action<never[]>,
    [`${prefix}Grant`]: defineAction(`${prefix}Grant`, [{ name: "minutes", type: "string" }], (ctx, m: string) => {
      const n = minutes(m);
      return Number.isInteger(n) && n >= 1 && n <= maxConsent ? support.grant(ctx, n) : null;
    }) as Action<never[]>,
    [`${prefix}Revoke`]: defineAction(`${prefix}Revoke`, [], (ctx) => support.revoke(ctx)) as Action<never[]>,
  };
  return support;
}
