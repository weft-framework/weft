import { defineModel, transaction, type Model, type PolicyExpr } from "@weft/data";
import type { AccessControl, ActingUser } from "./access.ts";
import { AccessError } from "./errors.ts";

export type Interval = "month" | "year";

export interface PlanConfig<F extends string, L extends string, M extends string = never> {
  label: string;
  description?: string;
  features?: readonly F[];
  limits?: { readonly [K in L]?: number };
  prices?: { readonly [I in Interval]?: string };
  trialDays?: number;
  perSeat?: boolean;
  meters?: readonly M[];
}

export interface MeterConfig {
  label: string;
  event: string;
  prices?: { readonly [I in Interval]?: string };
}

export interface PaymentFailure {
  tenant: string;
  invoice: InvoiceInfo;
  attempt: number;
  nextAttempt: number | null;
  graceEnds: number | null;
}

export interface InvoiceInfo {
  id: string;
  number: string | null;
  status: string;
  currency: string;
  total: number;
  amountDue: number;
  amountPaid: number;
  tax: number;
  created: number;
  periodStart: number | null;
  periodEnd: number | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
}

export interface TaxIdInfo {
  id: string;
  type: string;
  value: string;
  verification: string | null;
}

export type SecretValue = string | { reveal(): string };

export interface BillingConfig<N extends string, F extends string, L extends string, M extends string = never> {
  access: AccessControl<any, any, any, any>;
  manage: string;
  stripe: {
    secretKey: SecretValue;
    webhookSecret: SecretValue | readonly SecretValue[];
    apiVersion?: string;
    toleranceSeconds?: number;
  };
  features: { readonly [K in F]: string };
  limits: { readonly [K in L]: string };
  plans: { readonly [K in N]: PlanConfig<F, L, NoInfer<M>> };
  meters?: { readonly [K in M]: MeterConfig };
  invoices?: string;
  dunning?: { graceDays: number };
  onPaymentFailed?: (failure: PaymentFailure) => void | Promise<void>;
  default: NoInfer<N>;
  seats?: { limit?: NoInfer<L> };
  onChange?: (change: { tenant: string; from: PlanState<N>; to: PlanState<N> }) => void | Promise<void>;
  onError?: (err: unknown) => void;
  prefix?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export type SubscriptionStatus =
  | "none"
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export interface PlanState<N extends string = string> {
  plan: N;
  subscribed: N | null;
  status: SubscriptionStatus;
  interval: Interval | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: number | null;
  seats: number | null;
  readOnly: boolean;
  graceEnds: number | null;
}

export interface PlanInfo<N extends string, F extends string, L extends string> {
  name: N;
  label: string;
  description: string;
  features: F[];
  limits: Record<L, number>;
  intervals: Interval[];
  trialDays: number;
  perSeat: boolean;
  meters: string[];
}

export interface BillingAccountRow {
  tenant: string;
  customer: string | null;
  subscription: string | null;
  plan: string | null;
  price: string | null;
  status: string;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: number | null;
  trialUsed: boolean;
  quantity: number | null;
  pastDueSince: number | null;
  lapsed: boolean;
  updated: number;
}

export interface BillingEventRow {
  id: string;
  type: string;
  received: number;
}

export interface UsageRecordRow {
  id: string;
  tenant: string;
  meter: string;
  value: number;
  at: number;
  status: string;
  sent: number | null;
}

export interface BillingModels {
  BillingAccount: Model<BillingAccountRow>;
  BillingEvent: Model<BillingEventRow>;
  UsageRecord: Model<UsageRecordRow>;
}

export class StripeError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;
  constructor(status: number, type: string, code: string | null, message: string) {
    super(message);
    this.name = "StripeError";
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

class Ledger {
  readonly id: string;
  readonly tenant?: string;
  readonly all?: true;
  constructor(of: { tenant: string } | { all: true }) {
    if ("tenant" in of) {
      this.id = `billing:${of.tenant}`;
      this.tenant = of.tenant;
    } else {
      this.id = "billing:system";
      this.all = true;
    }
    Object.freeze(this);
  }
}

const SYSTEM = new Ledger({ all: true });
const allowedAccount = (a: unknown, row: { tenant: string }): boolean =>
  a instanceof Ledger && (a.all === true || (a.tenant !== undefined && row.tenant === a.tenant));
const accountWhere: PolicyExpr = {
  or: [{ cmp: "==", l: { field: ["tenant"] }, r: { actor: ["tenant"] } }, { truthy: { actor: ["all"] } }],
};
const systemOnly = (a: unknown): boolean => a instanceof Ledger && a.all === true;

const STRIPE = "https://api.stripe.com";
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const PRICE_RE = /^price_[A-Za-z0-9]{1,200}$/;
const ID_RE = /^[A-Za-z0-9_]{1,255}$/;
const PREFIX_RE = /^[A-Z][A-Za-z0-9]{0,31}$/;
const MAX_BODY = 1024 * 1024;
const DAY = 86_400_000;
const METER_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const EVENT_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const EMAIL_RE = /^[^\s@<>()[\]",;:\\]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const USAGE_MAX_AGE = 35 * DAY;
const GOOD: readonly string[] = ["active", "trialing", "past_due"];
const DUNNED: readonly string[] = ["past_due", "unpaid"];
const STATUSES: readonly string[] = ["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"];

const invalid = (msg: string): AccessError => new AccessError("invalid", msg);
const reveal = (s: SecretValue): string => (typeof s === "string" ? s : s.reveal());

export function stripeForm(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const add = (key: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => add(`${key}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) add(`${key}[${k}]`, x);
    else out.append(key, String(v));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.toString();
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secrets: readonly string[],
  nowSeconds: number,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (typeof header !== "string" || header.length > 4096) return false;
  let t = NaN;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) sigs.push(v);
  }
  if (!Number.isFinite(t) || sigs.length === 0 || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const data = new TextEncoder().encode(`${t}.${payload}`);
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const want = hex(await crypto.subtle.sign("HMAC", key, data));
    let ok = false;
    for (const s of sigs) ok = sameText(s, want) || ok;
    if (ok) return true;
  }
  return false;
}

interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number | null;
  trial_end?: number | null;
  items?: { data?: SubscriptionItem[] };
}

interface SubscriptionItem {
  id: string;
  quantity?: number;
  price?: { id?: string; recurring?: { interval?: string } | null };
}

type Account = BillingAccountRow;

export class Billing<N extends string = string, F extends string = string, L extends string = string, M extends string = string> {
  readonly models: BillingModels;
  readonly #access: AccessControl<any, any, any, any>;
  readonly #manage: string;
  readonly #view: string;
  readonly #plans: Map<
    N,
    {
      label: string;
      description: string;
      features: Set<F>;
      limits: Record<L, number>;
      prices: Map<Interval, string>;
      trialDays: number;
      perSeat: boolean;
      meters: Set<M>;
    }
  >;
  readonly #meters = new Map<M, { label: string; event: string; prices: Map<Interval, string> }>();
  readonly #metered = new Map<string, M>();
  readonly #grace: number | null;
  readonly #onPaymentFailed?: (failure: PaymentFailure) => void | Promise<void>;
  readonly #seats: { limit: L | null } | null;
  readonly #byPrice = new Map<string, { plan: N; interval: Interval }>();
  readonly #features: Set<string>;
  readonly #limits: string[];
  readonly #default: N;
  readonly #key: SecretValue;
  readonly #hookSecrets: SecretValue[];
  readonly #version: string;
  readonly #tolerance: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #onChange?: BillingConfig<N, F, L>["onChange"];
  readonly #onError: (err: unknown) => void;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(cfg: BillingConfig<N, F, L, M>) {
    if (!cfg || typeof cfg !== "object") throw invalid("defineBilling: a configuration is required");
    if (!cfg.access || typeof (cfg.access as { user?: unknown }).user !== "function") throw invalid("defineBilling: access is a defineAccess(...)");
    if (typeof cfg.manage !== "string" || cfg.manage === "") throw invalid("defineBilling: manage names a permission");
    if (cfg.invoices !== undefined && (typeof cfg.invoices !== "string" || cfg.invoices === "")) throw invalid("defineBilling: invoices names a permission");
    this.#access = cfg.access;
    this.#manage = cfg.manage;
    this.#view = cfg.invoices ?? cfg.manage;
    const s = cfg.stripe;
    if (!s || (typeof s.secretKey !== "string" && typeof (s.secretKey as { reveal?: unknown })?.reveal !== "function")) {
      throw invalid("defineBilling: stripe.secretKey is required");
    }
    const key = reveal(s.secretKey);
    if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(key)) throw invalid("defineBilling: stripe.secretKey is a Stripe secret or restricted key (sk_... or rk_...)");
    this.#key = s.secretKey;
    this.#hookSecrets = (Array.isArray(s.webhookSecret) ? s.webhookSecret : [s.webhookSecret]) as SecretValue[];
    if (this.#hookSecrets.length === 0 || this.#hookSecrets.some((w) => !/^whsec_[A-Za-z0-9+/=]{10,}$/.test(reveal(w)))) {
      throw invalid("defineBilling: stripe.webhookSecret is the endpoint's signing secret (whsec_...)");
    }
    this.#version = s.apiVersion ?? "2024-06-20";
    if (!/^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/.test(this.#version)) throw invalid("defineBilling: apiVersion is like 2024-06-20");
    this.#tolerance = s.toleranceSeconds ?? 300;
    if (!Number.isInteger(this.#tolerance) || this.#tolerance < 1 || this.#tolerance > 3600) throw invalid("toleranceSeconds is 1 to 3600");

    this.#features = new Set(Object.keys(cfg.features ?? {}));
    for (const f of this.#features) if (!NAME_RE.test(f)) throw invalid(`feature ${JSON.stringify(f)}: a lower-case name`);
    this.#limits = Object.keys(cfg.limits ?? {});
    for (const l of this.#limits) if (!NAME_RE.test(l)) throw invalid(`limit ${JSON.stringify(l)}: a lower-case name`);
    if (cfg.meters !== undefined && (typeof cfg.meters !== "object" || cfg.meters === null)) throw invalid("meters is an object");
    for (const [name, m] of Object.entries(cfg.meters ?? {}) as [M, MeterConfig][]) {
      if (!METER_RE.test(name)) throw invalid(`meter ${JSON.stringify(name)}: a name`);
      if (!m || typeof m.label !== "string" || m.label === "") throw invalid(`meter ${name}: a label is required`);
      if (typeof m.event !== "string" || !EVENT_RE.test(m.event)) throw invalid(`meter ${name}: event is the Stripe meter's event name`);
      const prices = new Map<Interval, string>();
      for (const [interval, price] of Object.entries(m.prices ?? {}) as [Interval, string][]) {
        if (interval !== "month" && interval !== "year") throw invalid(`meter ${name}: prices are by "month" or "year"`);
        if (typeof price !== "string" || !PRICE_RE.test(price)) throw invalid(`meter ${name}: ${interval} is a Stripe price id (price_...)`);
        if (this.#metered.has(price)) throw invalid(`meter ${name}: price ${price} is another meter's too`);
        this.#metered.set(price, name);
        prices.set(interval, price);
      }
      this.#meters.set(name, { label: m.label, event: m.event, prices });
    }
    this.#plans = new Map();
    for (const [name, p] of Object.entries(cfg.plans ?? {}) as [N, PlanConfig<F, L, M>][]) {
      if (!NAME_RE.test(name)) throw invalid(`plan ${JSON.stringify(name)}: a lower-case name`);
      if (!p || typeof p.label !== "string" || p.label === "") throw invalid(`plan ${name}: a label is required`);
      const features = new Set<F>();
      for (const f of p.features ?? []) {
        if (!this.#features.has(f)) throw invalid(`plan ${name}: no feature ${JSON.stringify(f)}`);
        features.add(f);
      }
      const limits = {} as Record<L, number>;
      for (const l of this.#limits as L[]) limits[l] = 0;
      for (const [l, v] of Object.entries(p.limits ?? {}) as [L, number][]) {
        if (!this.#limits.includes(l)) throw invalid(`plan ${name}: no limit ${JSON.stringify(l)}`);
        if (typeof v !== "number" || Number.isNaN(v) || v < 0 || (!Number.isInteger(v) && v !== Infinity)) {
          throw invalid(`plan ${name}: limit ${l} is a whole number or Infinity`);
        }
        limits[l] = v;
      }
      const prices = new Map<Interval, string>();
      for (const [interval, price] of Object.entries(p.prices ?? {}) as [Interval, string][]) {
        if (interval !== "month" && interval !== "year") throw invalid(`plan ${name}: prices are by "month" or "year"`);
        if (typeof price !== "string" || !PRICE_RE.test(price)) throw invalid(`plan ${name}: ${interval} is a Stripe price id (price_...)`);
        if (this.#byPrice.has(price) || this.#metered.has(price)) throw invalid(`plan ${name}: price ${price} sells another plan too`);
        this.#byPrice.set(price, { plan: name, interval });
        prices.set(interval, price);
      }
      const trialDays = p.trialDays ?? 0;
      if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 730) throw invalid(`plan ${name}: trialDays is 0 to 730`);
      if (trialDays > 0 && prices.size === 0) throw invalid(`plan ${name}: a trial needs a price`);
      if (p.perSeat !== undefined && typeof p.perSeat !== "boolean") throw invalid(`plan ${name}: perSeat is true or false`);
      const perSeat = p.perSeat === true;
      if (perSeat && prices.size === 0) throw invalid(`plan ${name}: a per-seat plan needs a price`);
      if (perSeat && !cfg.seats) throw invalid(`plan ${name}: perSeat needs \`seats\` in the billing configuration`);
      const meters = new Set<M>();
      for (const m of p.meters ?? []) {
        const meter = this.#meters.get(m);
        if (!meter) throw invalid(`plan ${name}: no meter ${JSON.stringify(m)}`);
        for (const interval of prices.keys()) {
          if (!meter.prices.has(interval)) throw invalid(`plan ${name}: meter ${m} has no ${interval} price`);
        }
        meters.add(m);
      }
      this.#plans.set(name, { label: p.label, description: p.description ?? "", features, limits, prices, trialDays, perSeat, meters });
    }
    if (cfg.dunning !== undefined) {
      const g = cfg.dunning?.graceDays;
      if (typeof g !== "number" || !Number.isInteger(g) || g < 0 || g > 90) throw invalid("dunning.graceDays is 0 to 90");
      this.#grace = g * DAY;
    } else {
      this.#grace = null;
    }
    if (cfg.onPaymentFailed !== undefined && typeof cfg.onPaymentFailed !== "function") throw invalid("onPaymentFailed is a function");
    this.#onPaymentFailed = cfg.onPaymentFailed;
    if (cfg.seats !== undefined) {
      if (!cfg.seats || typeof cfg.seats !== "object") throw invalid("seats is { limit? }");
      const limit = cfg.seats.limit ?? null;
      if (limit !== null && !this.#limits.includes(limit)) throw invalid(`seats.limit: no limit ${JSON.stringify(limit)}`);
      for (const [name, p] of this.#plans) {
        if (limit !== null && !p.perSeat && !Number.isFinite(p.limits[limit])) {
          throw invalid(`plan ${name}: the seats limit ${limit} is a number (seats are a setting)`);
        }
      }
      if (cfg.access.seatSetting === null) throw invalid("seats: defineAccess({ seats }) names no seat setting");
      this.#seats = { limit };
    } else {
      this.#seats = null;
    }
    if (this.#plans.size === 0) throw invalid("defineBilling: at least one plan");
    if (!this.#plans.has(cfg.default)) throw invalid("defineBilling: default names a plan");
    if (this.#plans.get(cfg.default)!.prices.size > 0) throw invalid("defineBilling: the default plan is not sold (no prices)");
    this.#default = cfg.default;
    if (cfg.onChange !== undefined && typeof cfg.onChange !== "function") throw invalid("onChange is a function");
    this.#onChange = cfg.onChange;
    this.#onError = cfg.onError ?? ((e) => console.error("[weft] billing:", e));
    this.#fetch = cfg.fetch ?? fetch;
    this.#now = cfg.now ?? Date.now;
    const prefix = cfg.prefix ?? "Billing";
    if (!PREFIX_RE.test(prefix)) throw invalid("prefix is a model name");
    this.models = {
      BillingAccount: defineModel<BillingAccountRow>(`${prefix}Account`, {
        fields: {
          tenant: "string",
          customer: "string | null",
          subscription: "string | null",
          plan: "string | null",
          price: "string | null",
          status: "string",
          periodEnd: "number | null",
          cancelAtPeriodEnd: "boolean",
          trialEnd: "number | null",
          trialUsed: "boolean",
          quantity: "number | null",
          pastDueSince: "number | null",
          lapsed: "boolean",
          updated: "number",
        },
        attrs: { tenant: { id: true }, customer: { unique: true } },
        read: allowedAccount,
        write: allowedAccount,
        readWhere: accountWhere,
        writeWhere: accountWhere,
      }),
      BillingEvent: defineModel<BillingEventRow>(`${prefix}Event`, {
        fields: { id: "string", type: "string", received: "number" },
        read: systemOnly,
        write: systemOnly,
        readWhere: { truthy: { actor: ["all"] } },
        writeWhere: { truthy: { actor: ["all"] } },
      }),
      UsageRecord: defineModel<UsageRecordRow>(`${prefix}Usage`, {
        fields: { id: "string", tenant: "string", meter: "string", value: "number", at: "number", status: "string", sent: "number | null" },
        read: allowedAccount,
        write: allowedAccount,
        readWhere: accountWhere,
        writeWhere: accountWhere,
      }),
    };
  }

  plans(): PlanInfo<N, F, L>[] {
    return [...this.#plans].map(([name, p]) => ({
      name,
      label: p.label,
      description: p.description,
      features: [...p.features],
      limits: { ...p.limits },
      intervals: [...p.prices.keys()],
      trialDays: p.trialDays,
      perSeat: p.perSeat,
      meters: [...p.meters],
    }));
  }

  plan(tenant: string | { readonly tenant?: string }): PlanState<N> {
    const t = this.#tenantOf(tenant);
    const a = t === null ? undefined : this.models.BillingAccount.as(new Ledger({ tenant: t })).get(t);
    return this.#state(a);
  }

  has(tenant: string | { readonly tenant?: string }, feature: F): boolean {
    if (!this.#features.has(feature)) return false;
    return this.#plans.get(this.plan(tenant).plan)!.features.has(feature);
  }

  limit(tenant: string | { readonly tenant?: string }, name: L): number {
    return this.#plans.get(this.plan(tenant).plan)!.limits[name] ?? 0;
  }

  within(tenant: string | { readonly tenant?: string }, name: L, used: number): boolean {
    return Number.isFinite(used) && used < this.limit(tenant, name);
  }

  #tenantOf(tenant: string | { readonly tenant?: string }): string | null {
    const t = typeof tenant === "string" ? tenant : tenant?.tenant;
    return typeof t === "string" && t !== "" ? t : null;
  }

  readOnly(tenant: string | { readonly tenant?: string }): boolean {
    return this.plan(tenant).readOnly;
  }

  #state(a: Account | undefined, at = this.#now()): PlanState<N> {
    if (!a || a.subscription === null) {
      return {
        plan: this.#default,
        subscribed: null,
        status: "none",
        interval: null,
        periodEnd: null,
        cancelAtPeriodEnd: false,
        trialEnd: null,
        seats: null,
        readOnly: false,
        graceEnds: null,
      };
    }
    const sub = a.plan !== null && this.#plans.has(a.plan as N) ? (a.plan as N) : null;
    const interval = a.price !== null ? (this.#byPrice.get(a.price)?.interval ?? null) : null;
    const graceEnds = this.#grace !== null && a.status === "past_due" ? (a.pastDueSince ?? at) + this.#grace : null;
    const readOnly = this.#grace !== null && (a.status === "unpaid" || (graceEnds !== null && at >= graceEnds));
    return {
      readOnly,
      graceEnds,
      plan: sub !== null && GOOD.includes(a.status) && !readOnly ? sub : this.#default,
      subscribed: sub,
      status: (STATUSES.includes(a.status) ? a.status : "none") as SubscriptionStatus,
      interval,
      periodEnd: a.periodEnd,
      cancelAtPeriodEnd: a.cancelAtPeriodEnd,
      trialEnd: a.trialEnd,
      seats: sub !== null && this.#plans.get(sub)!.perSeat ? a.quantity : null,
    };
  }

  async checkout(
    by: ActingUser,
    o: { tenant: string; plan: N; interval: Interval; successUrl: string; cancelUrl: string; quantity?: number },
  ): Promise<{ url: string; id: string }> {
    const tenant = this.#authorize(by, o?.tenant);
    const price = this.#price(o.plan, o.interval);
    const successUrl = this.#url(o.successUrl, "successUrl");
    const cancelUrl = this.#url(o.cancelUrl, "cancelUrl");
    const perSeat = this.#plans.get(o.plan)!.perSeat;
    if (!perSeat && o.quantity !== undefined && o.quantity !== 1) throw invalid(`the ${o.plan} plan is not sold per seat`);
    return this.#serial(tenant, async () => {
      const quantity = perSeat ? this.#seatCount(tenant, o.quantity) : 1;
      const a = this.#account(tenant);
      if (a && a.subscription !== null && GOOD.includes(a.status)) {
        throw new AccessError("conflict", "the tenant already has a subscription; change its plan instead");
      }
      const customer = await this.#customer(tenant, a);
      const trialDays = this.#plans.get(o.plan)!.trialDays;
      const trial = trialDays > 0 && !(this.#account(tenant)?.trialUsed ?? false);
      const session = (await this.#stripe(
        "POST",
        "/v1/checkout/sessions",
        {
          mode: "subscription",
          customer,
          client_reference_id: tenant,
          line_items: [{ price, quantity }, ...this.#meteredFor(o.plan, o.interval).map((p) => ({ price: p }))],
          success_url: successUrl,
          cancel_url: cancelUrl,
          subscription_data: { metadata: { tenant }, ...(trial ? { trial_period_days: trialDays } : {}) },
          metadata: { tenant },
        },
        null,
      )) as { id?: unknown; url?: unknown };
      if (typeof session.url !== "string" || typeof session.id !== "string") throw new StripeError(502, "api_error", null, "Stripe returned no checkout URL");
      return { url: session.url, id: session.id };
    });
  }

  async portal(by: ActingUser, o: { tenant: string; returnUrl: string }): Promise<{ url: string }> {
    const tenant = this.#authorize(by, o?.tenant);
    const returnUrl = this.#url(o.returnUrl, "returnUrl");
    const a = this.#account(tenant);
    if (!a?.customer) throw new AccessError("not-found", "the tenant has no billing account yet");
    const s = (await this.#stripe("POST", "/v1/billing_portal/sessions", { customer: a.customer, return_url: returnUrl }, null)) as { url?: unknown };
    if (typeof s.url !== "string") throw new StripeError(502, "api_error", null, "Stripe returned no portal URL");
    return { url: s.url };
  }

  async changePlan(by: ActingUser, o: { tenant: string; plan: N; interval: Interval; seats?: number }): Promise<PlanState<N>> {
    const tenant = this.#authorize(by, o?.tenant);
    const price = this.#price(o.plan, o.interval);
    const perSeat = this.#plans.get(o.plan)!.perSeat;
    if (!perSeat && o.seats !== undefined) throw invalid(`the ${o.plan} plan is not sold per seat`);
    return this.#serial(tenant, async () => {
      const a = this.#account(tenant);
      if (!a?.subscription || !GOOD.includes(a.status)) throw new AccessError("not-found", "the tenant has no subscription to change");
      const sub = await this.#subscription(a.subscription);
      const item = this.#planItem(sub);
      if (!item || sub.customer !== a.customer) throw new StripeError(409, "invalid_request_error", null, "the subscription does not match the account");
      const items: Record<string, unknown>[] = [
        { id: item.id, price, quantity: perSeat ? this.#seatCount(tenant, o.seats ?? Math.max(a.quantity ?? 1, this.#access.seatUse(tenant).used)) : 1 },
      ];
      const want = new Set(this.#meteredFor(o.plan, o.interval));
      for (const i of sub.items?.data ?? []) {
        const p = i.price?.id;
        if (i === item || !p || !this.#metered.has(p)) continue;
        if (want.has(p)) want.delete(p);
        else items.push({ id: i.id, deleted: true });
      }
      for (const p of want) items.push({ price: p });
      const next = (await this.#stripe(
        "POST",
        `/v1/subscriptions/${sub.id}`,
        {
          items,
          proration_behavior: "create_prorations",
          cancel_at_period_end: false,
        },
        null,
      )) as StripeSubscription;
      return this.#apply(tenant, next);
    });
  }

  async setSeats(by: ActingUser, o: { tenant: string; seats: number }): Promise<PlanState<N>> {
    const tenant = this.#authorize(by, o?.tenant);
    return this.#serial(tenant, async () => {
      const a = this.#account(tenant);
      if (!a?.subscription || !GOOD.includes(a.status)) throw new AccessError("not-found", "the tenant has no subscription to change");
      if (a.plan === null || !this.#plans.get(a.plan as N)?.perSeat) throw invalid("the tenant's plan is not sold per seat");
      const seats = this.#seatCount(tenant, o.seats);
      const sub = await this.#subscription(a.subscription);
      const item = this.#planItem(sub);
      if (!item || sub.customer !== a.customer) throw new StripeError(409, "invalid_request_error", null, "the subscription does not match the account");
      const next = (await this.#stripe(
        "POST",
        `/v1/subscriptions/${sub.id}`,
        { items: [{ id: item.id, quantity: seats }], proration_behavior: "create_prorations" },
        null,
      )) as StripeSubscription;
      return this.#apply(tenant, next);
    });
  }

  async cancel(by: ActingUser, o: { tenant: string; atPeriodEnd?: boolean }): Promise<PlanState<N>> {
    const tenant = this.#authorize(by, o?.tenant);
    return this.#serial(tenant, async () => {
      const a = this.#account(tenant);
      if (!a?.subscription || a.status === "canceled") throw new AccessError("not-found", "the tenant has no subscription to cancel");
      const next = (o.atPeriodEnd ?? true)
        ? ((await this.#stripe("POST", `/v1/subscriptions/${a.subscription}`, { cancel_at_period_end: true }, null)) as StripeSubscription)
        : ((await this.#stripe("DELETE", `/v1/subscriptions/${a.subscription}`, {}, null)) as StripeSubscription);
      return this.#apply(tenant, next);
    });
  }

  async resume(by: ActingUser, o: { tenant: string }): Promise<PlanState<N>> {
    const tenant = this.#authorize(by, o?.tenant);
    return this.#serial(tenant, async () => {
      const a = this.#account(tenant);
      if (!a?.subscription || !a.cancelAtPeriodEnd || !GOOD.includes(a.status)) throw new AccessError("not-found", "nothing to resume");
      const next = (await this.#stripe("POST", `/v1/subscriptions/${a.subscription}`, { cancel_at_period_end: false }, null)) as StripeSubscription;
      return this.#apply(tenant, next);
    });
  }

  async refresh(tenant: string): Promise<PlanState<N>> {
    return this.#serial(tenant, async () => {
      const a = this.#account(tenant);
      if (!a?.subscription) return this.#state(a);
      return this.#apply(tenant, await this.#subscription(a.subscription));
    });
  }

  async record(tenant: string | { readonly tenant?: string }, meter: M, value = 1, o: { id?: string; at?: number } = {}): Promise<boolean> {
    const t = this.#tenantOf(tenant);
    if (t === null) throw invalid("record: a tenant");
    if (!this.#meters.has(meter)) throw invalid(`record: no meter ${JSON.stringify(meter)}`);
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1e12) throw invalid("record: value is a whole number, 0 to 1e12");
    const now = this.#now();
    const at = o.at ?? now;
    if (typeof at !== "number" || !Number.isFinite(at) || at > now + 5 * 60_000 || at < now - USAGE_MAX_AGE + 3600_000) {
      throw invalid("record: at is within the last 35 days");
    }
    if (o.id !== undefined && (typeof o.id !== "string" || !/^[\x21-\x7e]{1,200}$/.test(o.id))) throw invalid("record: id is 1-200 printable characters");
    const id = await usageId(`${t}\u0000${meter}\u0000${o.id ?? crypto.randomUUID()}`);
    const ledger = this.models.UsageRecord.as(new Ledger({ tenant: t }));
    if (ledger.get(id)) return false;
    try {
      return ledger.create({ id, tenant: t, meter, value, at: Math.floor(at), status: "pending", sent: null }) !== undefined;
    } catch {
      return false;
    }
  }

  usage(tenant: string | { readonly tenant?: string }, meter: M, o: { since?: number; until?: number } = {}): number {
    const t = this.#tenantOf(tenant);
    if (t === null || !this.#meters.has(meter)) return 0;
    const at: { gte?: number; lt?: number } = {};
    if (o.since !== undefined) at.gte = o.since;
    if (o.until !== undefined) at.lt = o.until;
    const rows = this.models.UsageRecord.as(new Ledger({ tenant: t }))
      .query()
      .where({ tenant: t, meter, ...(o.since !== undefined || o.until !== undefined ? { at } : {}) })
      .all();
    return rows.reduce((sum, r) => sum + r.value, 0);
  }

  async reportUsage(o: { limit?: number } = {}): Promise<{ sent: number; waiting: number; expired: number; failed: number }> {
    const limit = o.limit ?? 1000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw invalid("reportUsage: limit is 1 to 10000");
    return this.#serial("\u0000usage", async () => {
      const sys = this.models.UsageRecord.as(SYSTEM);
      const rows = sys.query().where({ status: "pending" }).orderBy("at").limit(limit).all();
      const out = { sent: 0, waiting: 0, expired: 0, failed: 0 };
      for (const r of rows) {
        if (r.at < this.#now() - USAGE_MAX_AGE + 60_000) {
          sys.update((x) => x.id === r.id, { status: "expired" });
          out.expired++;
          this.#onError(new Error(`billing: ${r.value} ${r.meter} of tenant ${r.tenant} was not reported within 35 days and is dropped`));
          continue;
        }
        const customer = this.#account(r.tenant)?.customer;
        const meter = this.#meters.get(r.meter as M);
        if (!customer || !meter) {
          out.waiting++;
          continue;
        }
        try {
          await this.#stripe(
            "POST",
            "/v1/billing/meter_events",
            {
              event_name: meter.event,
              identifier: r.id,
              timestamp: Math.floor(r.at / 1000),
              payload: { stripe_customer_id: customer, value: String(r.value) },
            },
            `weft-usage-${r.id}`,
          );
        } catch (err) {
          out.failed++;
          this.#onError(err);
          if (!(err instanceof StripeError) || err.status === 0 || err.status === 429 || err.status >= 500) break;
          continue;
        }
        sys.update((x) => x.id === r.id, { status: "sent", sent: this.#now() });
        out.sent++;
      }
      return out;
    });
  }

  async invoices(by: ActingUser, o: { tenant: string; limit?: number; startingAfter?: string }): Promise<{ invoices: InvoiceInfo[]; more: boolean }> {
    const tenant = this.#authorize(by, o?.tenant, this.#view);
    const limit = o.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("limit is 1 to 100");
    if (o.startingAfter !== undefined && (typeof o.startingAfter !== "string" || !/^in_[A-Za-z0-9]{1,250}$/.test(o.startingAfter))) {
      throw invalid("startingAfter is an invoice id");
    }
    const customer = this.#account(tenant)?.customer;
    if (!customer) return { invoices: [], more: false };
    const list = (await this.#stripe(
      "GET",
      "/v1/invoices",
      { customer, limit, ...(o.startingAfter !== undefined ? { starting_after: o.startingAfter } : {}) },
      null,
    )) as { data?: unknown; has_more?: unknown };
    const data = Array.isArray(list.data) ? (list.data as Record<string, unknown>[]) : [];
    return { invoices: data.filter((i) => i && i.customer === customer).map((i) => invoiceInfo(i)), more: list.has_more === true };
  }

  async taxIds(by: ActingUser, o: { tenant: string }): Promise<TaxIdInfo[]> {
    const tenant = this.#authorize(by, o?.tenant, this.#view);
    const customer = this.#account(tenant)?.customer;
    if (!customer) return [];
    const list = (await this.#stripe("GET", `/v1/customers/${customer}/tax_ids`, { limit: 100 }, null)) as { data?: unknown };
    return (Array.isArray(list.data) ? (list.data as Record<string, unknown>[]) : []).map(taxIdInfo).filter((x): x is TaxIdInfo => x !== null);
  }

  async addTaxId(by: ActingUser, o: { tenant: string; type: string; value: string }): Promise<TaxIdInfo> {
    const tenant = this.#authorize(by, o?.tenant);
    if (typeof o.type !== "string" || !/^[a-z]{2,4}_[a-z]{2,6}$/.test(o.type)) throw invalid("type is a Stripe tax id type, like eu_vat");
    if (typeof o.value !== "string" || o.value.trim() === "" || o.value.length > 64 || CONTROL_RE.test(o.value)) throw invalid("value is a tax id");
    return this.#serial(tenant, async () => {
      const customer = await this.#customer(tenant, this.#account(tenant));
      const t = taxIdInfo((await this.#stripe("POST", `/v1/customers/${customer}/tax_ids`, { type: o.type, value: o.value.trim() }, null)) as Record<string, unknown>);
      if (!t) throw new StripeError(502, "api_error", null, "Stripe returned no tax id");
      return t;
    });
  }

  async removeTaxId(by: ActingUser, o: { tenant: string; id: string }): Promise<void> {
    const tenant = this.#authorize(by, o?.tenant);
    if (typeof o.id !== "string" || !/^txi_[A-Za-z0-9]{1,250}$/.test(o.id)) throw invalid("id is a tax id id (txi_...)");
    const customer = this.#account(tenant)?.customer;
    if (!customer) throw new AccessError("not-found", "the tenant has no billing account yet");
    await this.#stripe("DELETE", `/v1/customers/${customer}/tax_ids/${o.id}`, {}, null);
  }

  async billingDetails(by: ActingUser, o: { tenant: string }): Promise<{ email: string | null; name: string | null }> {
    const tenant = this.#authorize(by, o?.tenant, this.#view);
    const customer = this.#account(tenant)?.customer;
    if (!customer) return { email: null, name: null };
    return details((await this.#stripe("GET", `/v1/customers/${customer}`, {}, null)) as Record<string, unknown>);
  }

  async setBillingDetails(by: ActingUser, o: { tenant: string; email?: string | null; name?: string | null }): Promise<{ email: string | null; name: string | null }> {
    const tenant = this.#authorize(by, o?.tenant);
    const params: Record<string, string> = {};
    if (o.email !== undefined) {
      if (o.email !== null && (typeof o.email !== "string" || o.email.length > 254 || !EMAIL_RE.test(o.email))) throw invalid("email is an email address");
      params.email = o.email ?? "";
    }
    if (o.name !== undefined) {
      if (o.name !== null && (typeof o.name !== "string" || o.name.trim() === "" || o.name.length > 200 || CONTROL_RE.test(o.name))) throw invalid("name is 1-200 characters");
      params.name = o.name?.trim() ?? "";
    }
    return this.#serial(tenant, async () => {
      const customer = await this.#customer(tenant, this.#account(tenant));
      return details((await this.#stripe("POST", `/v1/customers/${customer}`, params, null)) as Record<string, unknown>);
    });
  }

  async retryPayment(by: ActingUser, o: { tenant: string }): Promise<{ paid: boolean; message: string | null; state: PlanState<N> }> {
    const tenant = this.#authorize(by, o?.tenant);
    return this.#serial(tenant, async () => {
      const a = this.#account(tenant);
      if (!a?.subscription || !a.customer || !["past_due", "unpaid", "incomplete"].includes(a.status)) {
        throw new AccessError("not-found", "nothing to pay");
      }
      const list = (await this.#stripe("GET", "/v1/invoices", { customer: a.customer, subscription: a.subscription, status: "open", limit: 1 }, null)) as {
        data?: unknown;
      };
      const inv = (Array.isArray(list.data) ? (list.data as Record<string, unknown>[]) : []).find((i) => i && i.customer === a.customer);
      if (!inv || typeof inv.id !== "string" || !ID_RE.test(inv.id)) throw new AccessError("not-found", "no open invoice");
      let paid = true;
      let message: string | null = null;
      try {
        await this.#stripe("POST", `/v1/invoices/${inv.id}/pay`, {}, null);
      } catch (err) {
        if (!(err instanceof StripeError) || err.status !== 402) throw err;
        paid = false;
        message = err.message;
      }
      return { paid, message, state: await this.#apply(tenant, await this.#subscription(a.subscription)) };
    });
  }

  async checkGrace(): Promise<number> {
    if (this.#grace === null) return 0;
    const due = this.models.BillingAccount.as(SYSTEM)
      .query()
      .where({ status: "past_due", lapsed: false })
      .all()
      .filter((a) => this.#state(a).readOnly);
    let n = 0;
    for (const { tenant } of due) {
      await this.#serial(tenant, async () => {
        const cur = this.#account(tenant);
        if (!cur || cur.lapsed || !this.#state(cur).readOnly) return;
        const from = this.#state(cur, (cur.pastDueSince ?? this.#now()) + this.#grace! - 1);
        const next = { ...cur, lapsed: true, updated: this.#now() };
        this.models.BillingAccount.as(new Ledger({ tenant })).update((r) => r.tenant === tenant, { lapsed: true, updated: next.updated });
        n++;
        await this.#changed(tenant, from, next);
      });
    }
    return n;
  }

  async webhook(req: Request): Promise<Response> {
    const answer = (status: number, error?: string) =>
      new Response(JSON.stringify(error ? { error } : { received: true }), { status, headers: { "content-type": "application/json" } });
    if (req.method !== "POST") return answer(405, "POST only");
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY) return answer(413, "too large");
    const body = await readText(req, MAX_BODY);
    if (body === null) return answer(413, "too large");
    const ok = await verifyStripeSignature(
      body,
      req.headers.get("stripe-signature"),
      this.#hookSecrets.map(reveal),
      Math.floor(this.#now() / 1000),
      this.#tolerance,
    );
    if (!ok) return answer(400, "bad signature");
    let event: { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } };
    try {
      event = JSON.parse(body);
    } catch {
      return answer(400, "bad JSON");
    }
    if (typeof event.id !== "string" || !ID_RE.test(event.id) || typeof event.type !== "string") return answer(400, "not an event");
    if (this.models.BillingEvent.as(SYSTEM).get(event.id)) return answer(200);
    try {
      await this.#handle(event.type, event.data?.object ?? {});
    } catch (err) {
      this.#onError(err);
      return answer(500, "not handled; Stripe will retry");
    }
    try {
      this.models.BillingEvent.as(SYSTEM).create({ id: event.id, type: event.type.slice(0, 100), received: this.#now() });
    } catch {
    }
    return answer(200);
  }

  prune(olderThanMs = 30 * DAY): number {
    const before = this.#now() - olderThanMs;
    return (
      this.models.BillingEvent.as(SYSTEM).delete((e) => e.received < before) +
      this.models.UsageRecord.as(SYSTEM).delete((u) => u.status !== "pending" && u.at < before)
    );
  }

  async #handle(type: string, obj: Record<string, unknown>): Promise<void> {
    let customer: unknown;
    let subscription: unknown;
    if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
      if (obj.mode !== "subscription") return;
      customer = obj.customer;
      subscription = obj.subscription;
    } else if (type.startsWith("customer.subscription.")) {
      customer = obj.customer;
      subscription = obj.id;
    } else if (type === "invoice.paid" || type === "invoice.payment_failed" || type === "invoice.payment_succeeded") {
      customer = obj.customer;
      subscription = obj.subscription;
    } else {
      return;
    }
    if (typeof customer !== "string" || typeof subscription !== "string" || !ID_RE.test(subscription)) return;
    const a = this.models.BillingAccount.as(SYSTEM).query().where({ customer }).first();
    if (!a) return;
    await this.#serial(a.tenant, async () => {
      const current = this.#account(a.tenant);
      if (current?.subscription && current.subscription !== subscription && GOOD.includes(current.status)) {
        const other = await this.#subscription(subscription);
        if (!GOOD.includes(other.status)) return;
      }
      const state = await this.#apply(a.tenant, await this.#subscription(subscription));
      if (type === "invoice.payment_failed" && this.#onPaymentFailed && typeof obj.id === "string" && ID_RE.test(obj.id)) {
        const inv = (await this.#stripe("GET", `/v1/invoices/${obj.id}`, {}, null)) as Record<string, unknown>;
        if (inv.customer !== customer || inv.status === "paid") return;
        const next = inv.next_payment_attempt;
        try {
          await this.#onPaymentFailed({
            tenant: a.tenant,
            invoice: invoiceInfo(inv),
            attempt: typeof inv.attempt_count === "number" ? inv.attempt_count : 1,
            nextAttempt: typeof next === "number" && Number.isFinite(next) ? next * 1000 : null,
            graceEnds: state.graceEnds,
          });
        } catch (err) {
          this.#onError(err);
        }
      }
    });
  }

  #authorize(by: ActingUser, tenant: unknown, permission = this.#manage): string {
    const user = typeof by === "string" ? by : (by as { id?: unknown } | null)?.id;
    if (typeof user !== "string" || user === "") throw new AccessError("forbidden", "sign in to manage billing");
    if (typeof tenant !== "string" || tenant === "" || !this.#access.memberOf(user, tenant)) {
      throw new AccessError("not-found", "no such tenant");
    }
    if (!this.#access.allows(user, permission, tenant)) throw new AccessError("forbidden", "you may not manage billing for this tenant");
    return tenant;
  }

  #meteredFor(plan: N, interval: Interval): string[] {
    return [...this.#plans.get(plan)!.meters].map((m) => this.#meters.get(m)!.prices.get(interval)!).filter(Boolean);
  }

  #planItem(sub: StripeSubscription): SubscriptionItem | null {
    const items = sub.items?.data ?? [];
    const priced = (i: SubscriptionItem, m: Map<string, unknown>) => typeof i.price?.id === "string" && m.has(i.price.id);
    return items.find((i) => priced(i, this.#byPrice)) ?? items.find((i) => !priced(i, this.#metered)) ?? null;
  }

  async #changed(tenant: string, from: PlanState<N>, next: Account): Promise<PlanState<N>> {
    this.#syncSeats(tenant, next);
    const to = this.#state(next);
    if (this.#onChange && JSON.stringify(from) !== JSON.stringify(to)) {
      try {
        await this.#onChange({ tenant, from, to });
      } catch (err) {
        this.#onError(err);
      }
    }
    return to;
  }

  #price(plan: N, interval: Interval): string {
    const p = this.#plans.get(plan);
    if (!p) throw invalid("no such plan");
    const price = p.prices.get(interval);
    if (!price) throw invalid(`the ${plan} plan is not sold by the ${interval}`);
    return price;
  }

  #url(u: unknown, what: string): string {
    let url: URL;
    try {
      url = new URL(String(u));
    } catch {
      throw invalid(`${what} is an absolute URL`);
    }
    const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if ((url.protocol !== "https:" && !local) || url.username || url.password) throw invalid(`${what} is an https URL`);
    return url.href;
  }

  #account(tenant: string): Account | undefined {
    return this.models.BillingAccount.as(SYSTEM).get(tenant);
  }

  #serial<R>(tenant: string, fn: () => Promise<R>): Promise<R> {
    const prev = this.#locks.get(tenant) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.#locks.set(tenant, tail);
    void tail.then(() => {
      if (this.#locks.get(tenant) === tail) this.#locks.delete(tenant);
    });
    return run;
  }

  #seatCount(tenant: string, want: number | undefined): number {
    const used = this.#access.seatUse(tenant).used;
    const n = want ?? Math.max(1, used);
    if (!Number.isInteger(n) || n < 1 || n > 100_000) throw invalid("seats is 1 to 100000");
    if (n < used) throw new AccessError("limit", `the tenant has ${used} members; remove members before buying fewer seats`);
    return n;
  }

  #syncSeats(tenant: string, a: Account): void {
    if (!this.#seats) return;
    const st = this.#state(a);
    const p = this.#plans.get(st.plan)!;
    const n = p.perSeat ? st.seats : this.#seats.limit !== null ? p.limits[this.#seats.limit] : null;
    if (n === null) return;
    try {
      const use = this.#access.seatUse(tenant);
      if (use.setting !== null && use.limit !== n) this.#access.configureTenant(tenant, { [use.setting]: n });
    } catch (err) {
      this.#onError(err);
    }
  }

  async #customer(tenant: string, a: Account | undefined): Promise<string> {
    if (a?.customer) return a.customer;
    const c = (await this.#stripe("POST", "/v1/customers", { metadata: { tenant } }, `weft-customer-${tenant}`)) as { id?: unknown };
    if (typeof c.id !== "string" || !ID_RE.test(c.id)) throw new StripeError(502, "api_error", null, "Stripe returned no customer id");
    const id = c.id;
    transaction(() => {
      const ledger = this.models.BillingAccount.as(new Ledger({ tenant }));
      if (ledger.get(tenant)) ledger.update((r) => r.tenant === tenant, { customer: id, updated: this.#now() });
      else ledger.create(this.#blank(tenant, id));
    });
    return id;
  }

  #blank(tenant: string, customer: string | null): Account {
    return {
      tenant,
      customer,
      subscription: null,
      plan: null,
      price: null,
      status: "none",
      periodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: null,
      trialUsed: false,
      quantity: null,
      pastDueSince: null,
      lapsed: false,
      updated: this.#now(),
    };
  }

  async #subscription(id: string): Promise<StripeSubscription> {
    if (!ID_RE.test(id)) throw invalid("not a subscription id");
    const s = (await this.#stripe("GET", `/v1/subscriptions/${id}`, {}, null)) as StripeSubscription;
    if (typeof s.id !== "string" || typeof s.customer !== "string" || typeof s.status !== "string") {
      throw new StripeError(502, "api_error", null, "Stripe returned no subscription");
    }
    return s;
  }

  async #apply(tenant: string, sub: StripeSubscription): Promise<PlanState<N>> {
    const before = this.#account(tenant);
    if (!before || before.customer === null || sub.customer !== before.customer) {
      throw new StripeError(409, "invalid_request_error", null, "the subscription belongs to another customer");
    }
    const item = this.#planItem(sub);
    const price = item?.price?.id ?? null;
    const known = price !== null ? this.#byPrice.get(price) : undefined;
    if (price !== null && !known) this.#onError(new Error(`billing: price ${price} of subscription ${sub.id} is not in any plan`));
    const status = STATUSES.includes(sub.status) ? sub.status : "incomplete";
    const toMs = (s: unknown) => (typeof s === "number" && Number.isFinite(s) ? s * 1000 : null);
    const next: Account = {
      ...before,
      subscription: sub.id,
      plan: known?.plan ?? null,
      price,
      status,
      periodEnd: toMs(sub.current_period_end),
      cancelAtPeriodEnd: sub.cancel_at_period_end === true,
      trialEnd: toMs(sub.trial_end),
      trialUsed: before.trialUsed || (sub.trial_end !== null && sub.trial_end !== undefined),
      quantity: quantityOf(item),
      pastDueSince: DUNNED.includes(status) ? (before.pastDueSince ?? this.#now()) : null,
      lapsed: false,
      updated: this.#now(),
    };
    next.lapsed = this.#state(next).readOnly;
    const from = this.#state(before);
    transaction(() => {
      const { tenant: _key, ...patch } = next;
      this.models.BillingAccount.as(new Ledger({ tenant })).update((r) => r.tenant === tenant, patch);
    });
    return this.#changed(tenant, from, next);
  }

  async #stripe(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, unknown>, idempotencyKey: string | null): Promise<unknown> {
    const body = method === "GET" ? null : stripeForm(params);
    if (method === "GET" && Object.keys(params).length > 0) path = `${path}?${stripeForm(params)}`;
    const key = method === "POST" ? (idempotencyKey ?? `weft-${crypto.randomUUID()}`) : null;
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      let res: Response;
      try {
        res = await this.#fetch(`${STRIPE}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${reveal(this.#key)}`,
            "stripe-version": this.#version,
            ...(body !== null ? { "content-type": "application/x-www-form-urlencoded" } : {}),
            ...(key ? { "idempotency-key": key } : {}),
          },
          ...(body !== null ? { body } : {}),
          redirect: "error",
        });
      } catch {
        last = new StripeError(0, "api_connection_error", null, `could not reach Stripe (${method} ${path.split("/").slice(0, 3).join("/")})`);
        continue;
      }
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
      }
      if (res.ok) return json;
      const e = (json.error ?? {}) as { type?: unknown; code?: unknown; message?: unknown };
      last = new StripeError(
        res.status,
        typeof e.type === "string" ? e.type : "api_error",
        typeof e.code === "string" ? e.code : null,
        typeof e.message === "string" ? e.message.slice(0, 500) : `Stripe answered ${res.status}`,
      );
      if (res.status !== 429 && res.status < 500) break;
    }
    throw last;
  }
}

function quantityOf(item: SubscriptionItem | null): number | null {
  const q = item?.quantity;
  return typeof q === "number" && Number.isInteger(q) && q >= 0 ? q : null;
}

async function usageId(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `wu_${hex(d).slice(0, 40)}`;
}

function stripeLink(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && (u.hostname === "stripe.com" || u.hostname.endsWith(".stripe.com")) && !u.username ? u.href : null;
  } catch {
    return null;
  }
}

function invoiceInfo(i: Record<string, unknown>): InvoiceInfo {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const ms = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v * 1000 : null);
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    id: String(i.id),
    number: s(i.number),
    status: s(i.status) ?? "draft",
    currency: s(i.currency) ?? "",
    total: n(i.total),
    amountDue: n(i.amount_due),
    amountPaid: n(i.amount_paid),
    tax: n(i.tax),
    created: ms(i.created) ?? 0,
    periodStart: ms(i.period_start),
    periodEnd: ms(i.period_end),
    hostedUrl: stripeLink(i.hosted_invoice_url),
    pdfUrl: stripeLink(i.invoice_pdf),
  };
}

function taxIdInfo(t: Record<string, unknown>): TaxIdInfo | null {
  if (!t || typeof t.id !== "string" || typeof t.type !== "string" || typeof t.value !== "string") return null;
  const v = t.verification as { status?: unknown } | null | undefined;
  return { id: t.id, type: t.type, value: t.value, verification: typeof v?.status === "string" ? v.status : null };
}

function details(c: Record<string, unknown>): { email: string | null; name: string | null } {
  return { email: typeof c.email === "string" && c.email !== "" ? c.email : null, name: typeof c.name === "string" && c.name !== "" ? c.name : null };
}

async function readText(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export function defineBilling<const N extends string, const F extends string, const L extends string, const M extends string = never>(
  cfg: BillingConfig<N, F, L, M>,
): Billing<N, F, L, M> {
  return new Billing<N, F, L, M>(cfg);
}
