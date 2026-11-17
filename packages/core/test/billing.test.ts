import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { canSee, onRead, useDatabase, type Model } from "@weft-framework/data";
import { openSqlite } from "@weft-framework/data/sqlite";
import { defineAccess, isAccessError, type AccessErrorCode } from "../src/index.ts";
import { defineBilling, StripeError, stripeForm, verifyStripeSignature, type PaymentFailure } from "../src/billing.ts";

const KEY = "sk_test_51abcdefghijklmnop";
const HOOK = "whsec_abcdefghijklmnopqrstuv";
const OLD_HOOK = "whsec_previoussecret0000000";

interface Sub {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: number;
  trial_end: number | null;
  items: { data: { id: string; quantity?: number; price: { id: string; recurring: { interval: string } } }[] };
}

interface Invoice {
  id: string;
  customer: string;
  subscription: string;
  status: string;
  total: number;
  amount_due: number;
  attempt_count: number;
  next_payment_attempt: number | null;
  hosted_invoice_url: string;
  created: number;
}

function fakeStripe(clock: () => number) {
  const customers = new Map<string, { id: string; metadata: Record<string, string> }>();
  const byIdem = new Map<string, unknown>();
  const sessions = new Map<string, { id: string; customer: string; price: string; quantity: number; trialDays: number; tenant: string; metered: string[] }>();
  const meterEvents = new Map<string, { event: string; customer: string; value: number; timestamp: number }>();
  const invoices = new Map<string, Invoice>();
  const taxIds = new Map<string, { id: string; customer: string; type: string; value: string }>();
  let decline = false;
  let leaky = false;
  const subs = new Map<string, Sub>();
  const calls: { method: string; path: string; headers: Record<string, string>; form: URLSearchParams }[] = [];
  let n = 0;
  let failNext = 0;
  const interval = (price: string) => (price.endsWith("Year") ? "year" : "month");
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.stripe.com");
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const method = init.method ?? "GET";
    const form = new URLSearchParams(typeof init.body === "string" ? init.body : "");
    calls.push({ method, path: url.pathname, headers, form });
    if (failNext > 0) {
      failNext--;
      return json(500, { error: { type: "api_error", message: "try again" } });
    }
    if (headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { type: "invalid_request_error", message: "bad key" } });
    assert.equal(headers["stripe-version"], "2024-06-20");
    const idem = headers["idempotency-key"];
    if (method === "POST") assert.ok(idem, "every POST has an idempotency key");
    if (idem && byIdem.has(idem)) return json(200, byIdem.get(idem));
    const done = (body: unknown) => {
      if (idem) byIdem.set(idem, body);
      return json(200, body);
    };
    if (method === "POST" && url.pathname === "/v1/customers") {
      const c = { id: `cus_${++n}`, metadata: { tenant: form.get("metadata[tenant]") ?? "" } };
      customers.set(c.id, c);
      return done(c);
    }
    if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
      assert.equal(form.get("mode"), "subscription");
      const s = {
        id: `cs_${++n}`,
        customer: form.get("customer")!,
        price: form.get("line_items[0][price]")!,
        quantity: Number(form.get("line_items[0][quantity]")),
        trialDays: Number(form.get("subscription_data[trial_period_days]") ?? 0),
        tenant: form.get("client_reference_id")!,
        metered: [1, 2, 3].map((i) => form.get(`line_items[${i}][price]`)).filter((p): p is string => p !== null),
      };
      for (const i of [1, 2, 3]) assert.equal(form.get(`line_items[${i}][quantity]`), null, "metered prices have no quantity");
      sessions.set(s.id, s);
      return done({ id: s.id, url: `https://checkout.stripe.com/c/pay/${s.id}` });
    }
    if (method === "POST" && url.pathname === "/v1/billing_portal/sessions") {
      return done({ id: `bps_${++n}`, url: `https://billing.stripe.com/p/session/${form.get("customer")}` });
    }
    const m = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(url.pathname);
    if (m) {
      const s = subs.get(m[1]!);
      if (!s) return json(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such subscription" } });
      if (method === "POST") {
        for (let i = 0; form.has(`items[${i}][id]`) || form.has(`items[${i}][price]`); i++) {
          const id = form.get(`items[${i}][id]`);
          const price = form.get(`items[${i}][price]`);
          const item = id ? s.items.data.find((x) => x.id === id) : undefined;
          if (id && !item) return json(400, { error: { type: "invalid_request_error", message: "no such item" } });
          if (item && form.get(`items[${i}][deleted]`) === "true") {
            s.items.data = s.items.data.filter((x) => x !== item);
            continue;
          }
          const target = item ?? { id: `si_${++n}`, price: { id: price!, recurring: { interval: interval(price!) } } };
          if (!item) s.items.data.push(target);
          if (price) target.price = { id: price, recurring: { interval: interval(price) } };
          if (form.has(`items[${i}][quantity]`)) target.quantity = Number(form.get(`items[${i}][quantity]`));
        }
        if (form.has("cancel_at_period_end")) s.cancel_at_period_end = form.get("cancel_at_period_end") === "true";
      } else if (method === "DELETE") {
        s.status = "canceled";
      }
      return done(structuredClone(s));
    }
    const q = url.searchParams;
    if (method === "POST" && url.pathname === "/v1/billing/meter_events") {
      const identifier = form.get("identifier")!;
      assert.match(identifier, /^wu_[0-9a-f]{40}$/);
      assert.ok(customers.has(form.get("payload[stripe_customer_id]")!), "a real customer");
      if (!meterEvents.has(identifier)) {
        meterEvents.set(identifier, {
          event: form.get("event_name")!,
          customer: form.get("payload[stripe_customer_id]")!,
          value: Number(form.get("payload[value]")),
          timestamp: Number(form.get("timestamp")),
        });
      }
      return done({ object: "billing.meter_event", identifier });
    }
    if (method === "GET" && url.pathname === "/v1/invoices") {
      const data = [...invoices.values()]
        .filter((i) => (leaky || i.customer === q.get("customer")) && (!q.get("status") || i.status === q.get("status")) && (!q.get("subscription") || i.subscription === q.get("subscription")))
        .sort((a, b) => b.created - a.created);
      const start = q.get("starting_after") ? data.findIndex((i) => i.id === q.get("starting_after")) + 1 : 0;
      const limit = Number(q.get("limit") ?? 10);
      return json(200, { data: data.slice(start, start + limit), has_more: data.length > start + limit });
    }
    const inv = /^\/v1\/invoices\/(in_\w+)(\/pay)?$/.exec(url.pathname);
    if (inv) {
      const i = invoices.get(inv[1]!);
      if (!i) return json(404, { error: { type: "invalid_request_error", message: "No such invoice" } });
      if (inv[2]) {
        if (decline) return json(402, { error: { type: "card_error", code: "card_declined", message: "Your card was declined." } });
        i.status = "paid";
        subs.get(i.subscription)!.status = "active";
      }
      return done(structuredClone(i));
    }
    const tax = /^\/v1\/customers\/(cus_\w+)\/tax_ids(?:\/(txi_\w+))?$/.exec(url.pathname);
    if (tax) {
      const customer = tax[1]!;
      if (method === "GET") return json(200, { data: [...taxIds.values()].filter((t) => t.customer === customer) });
      if (method === "POST") {
        if (!/^[A-Z]{2}\d{8,12}$/.test(form.get("value")!)) return json(400, { error: { type: "invalid_request_error", code: "tax_id_invalid", message: "Invalid value" } });
        const t = { id: `txi_${++n}`, customer, type: form.get("type")!, value: form.get("value")!, verification: { status: "pending" } };
        taxIds.set(t.id, t);
        return done(t);
      }
      const t = taxIds.get(tax[2] ?? "");
      if (!t || t.customer !== customer) return json(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such tax id" } });
      taxIds.delete(t.id);
      return json(200, { id: t.id, deleted: true });
    }
    const cust = /^\/v1\/customers\/(cus_\w+)$/.exec(url.pathname);
    if (cust) {
      const c = customers.get(cust[1]!) as { id: string; email?: string; name?: string } | undefined;
      if (!c) return json(404, { error: { type: "invalid_request_error", message: "No such customer" } });
      if (method === "POST") {
        if (form.has("email")) c.email = form.get("email")!;
        if (form.has("name")) c.name = form.get("name")!;
      }
      return done(structuredClone(c));
    }
    return json(404, { error: { type: "invalid_request_error", message: `no route ${method} ${url.pathname}` } });
  }) as typeof globalThis.fetch;

  const failInvoice = (subId: string, attempt = 1): Invoice => {
    const s = subs.get(subId)!;
    s.status = "past_due";
    const i: Invoice = {
      id: `in_${++n}`,
      customer: s.customer,
      subscription: s.id,
      status: "open",
      total: 2900,
      amount_due: 2900,
      attempt_count: attempt,
      next_payment_attempt: Math.floor(clock() / 1000) + 3 * 86400,
      hosted_invoice_url: `https://invoice.stripe.com/i/acct_1/${n}`,
      created: Math.floor(clock() / 1000) + n,
    };
    invoices.set(i.id, i);
    return i;
  };

  const complete = (sessionId: string): Sub => {
    const cs = sessions.get(sessionId)!;
    const now = Math.floor(clock() / 1000);
    const sub: Sub = {
      id: `sub_${++n}`,
      customer: cs.customer,
      status: cs.trialDays > 0 ? "trialing" : "active",
      cancel_at_period_end: false,
      current_period_end: now + 30 * 86400,
      trial_end: cs.trialDays > 0 ? now + cs.trialDays * 86400 : null,
      items: {
        data: [
          { id: `si_${++n}`, quantity: cs.quantity, price: { id: cs.price, recurring: { interval: interval(cs.price) } } },
          ...cs.metered.map((p) => ({ id: `si_${++n}`, price: { id: p, recurring: { interval: interval(p) } } })),
        ],
      },
    };
    subs.set(sub.id, sub);
    return sub;
  };
  return {
    fetch, customers, sessions, subs, calls, complete, meterEvents, invoices, taxIds, failInvoice,
    failNext: (k: number) => (failNext = k),
    decline: (v: boolean) => (decline = v),
    leak: (v: boolean) => (leaky = v),
  };
}

function setup(driver: "memory" | "sqlite" = "memory") {
  let clock = Date.UTC(2026, 10, 14, 9);
  const stripe = fakeStripe(() => clock);
  const access = defineAccess({
    scopes: { org: {}, project: { parent: "org" } },
    permissions: { "billing.manage": "Manage billing", "project.read": "See projects" },
    roles: {
      owner: { scope: "org", permissions: ["*"] },
      admin: { scope: "org", permissions: ["billing.manage", "project.read"] },
      member: { scope: "org", permissions: ["project.read"] },
    },
    owner: "owner",
  });
  const errors: unknown[] = [];
  const changes: { tenant: string; from: string; to: string }[] = [];
  const billing = defineBilling({
    access,
    manage: "billing.manage",
    stripe: { secretKey: { reveal: () => KEY }, webhookSecret: [HOOK, OLD_HOOK] },
    features: { exports: "CSV export", sso: "Single sign-on" },
    limits: { projects: "Projects", seats: "Seats" },
    plans: {
      free: { label: "Free", limits: { projects: 3, seats: 2 } },
      pro: {
        label: "Pro",
        features: ["exports"],
        limits: { projects: 50, seats: 20 },
        prices: { month: "price_ProMonth", year: "price_ProYear" },
        trialDays: 14,
      },
      enterprise: {
        label: "Enterprise",
        features: ["exports", "sso"],
        limits: { projects: Infinity, seats: 500 },
        prices: { month: "price_EntMonth" },
      },
    },
    default: "free",
    onChange: (c) => void changes.push({ tenant: c.tenant, from: `${c.from.plan}/${c.from.status}`, to: `${c.to.plan}/${c.to.status}` }),
    onError: (e) => errors.push(e),
    fetch: stripe.fetch,
    now: () => clock,
  });
  if (driver === "sqlite") {
    const db = openSqlite(":memory:");
    useDatabase(db, [...Object.values(access.models), ...Object.values(billing.models)] as Model<never>[]);
  }
  const acme = access.createTenant("alice", { name: "Acme" }).id;
  const globex = access.createTenant("gina", { name: "Globex" }).id;
  access.assign("alice", { user: "adam", role: "admin", scope: acme });
  access.assign("alice", { user: "mia", role: "member", scope: acme });
  let evt = 0;
  const deliver = async (type: string, object: unknown, o: { secret?: string; at?: number; id?: string; body?: string } = {}) => {
    const body = o.body ?? JSON.stringify({ id: o.id ?? `evt_${++evt}`, type, data: { object } });
    const t = Math.floor((o.at ?? clock) / 1000);
    const sig = createHmac("sha256", o.secret ?? HOOK).update(`${t}.${body}`).digest("hex");
    return billing.webhook(
      new Request("https://app.example/api/stripe", { method: "POST", body, headers: { "stripe-signature": `t=${t},v1=${sig}` } }),
    );
  };
  const urls = { successUrl: "https://app.example/billing?done=1", cancelUrl: "https://app.example/billing" };
  return { billing, access, stripe, acme, globex, errors, changes, deliver, urls, tick: (ms: number) => (clock += ms) };
}

async function fails(fn: () => Promise<unknown>, code: AccessErrorCode, msg?: RegExp): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(isAccessError(e), `expected an AccessError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (msg) assert.match(e.message, msg);
    return true;
  });
}

for (const driver of ["memory", "sqlite"] as const) {
  test(`checkout, webhook, entitlement, change and cancel (${driver})`, async () => {
    const { billing, stripe, acme, globex, errors, changes, deliver, urls, tick } = setup(driver);
    assert.equal(billing.plan(acme).plan, "free");
    assert.equal(billing.has(acme, "exports"), false);
    assert.equal(billing.limit(acme, "projects"), 3);
    assert.ok(billing.within(acme, "projects", 2));
    assert.ok(!billing.within(acme, "projects", 3));

    await fails(() => billing.checkout("mia", { tenant: acme, plan: "pro", interval: "month", ...urls }), "forbidden");
    await fails(() => billing.checkout("gina", { tenant: acme, plan: "pro", interval: "month", ...urls }), "not-found");
    await fails(() => billing.checkout("", { tenant: acme, plan: "pro", interval: "month", ...urls }), "forbidden");
    await fails(() => billing.checkout("adam", { tenant: "nope", plan: "pro", interval: "month", ...urls }), "not-found");
    await fails(() => billing.checkout("adam", { tenant: acme, plan: "free", interval: "month", ...urls }), "invalid", /not sold/);
    await fails(() => billing.checkout("adam", { tenant: acme, plan: "enterprise", interval: "year", ...urls }), "invalid");
    await fails(() => billing.checkout("adam", { tenant: acme, plan: "x" as never, interval: "month", ...urls }), "invalid");
    await fails(() => billing.checkout("adam", { tenant: acme, plan: "pro", interval: "month", ...urls, successUrl: "javascript:alert(1)" }), "invalid");
    await fails(() => billing.checkout("adam", { tenant: acme, plan: "pro", interval: "month", ...urls, cancelUrl: "http://evil.example/" }), "invalid");
    assert.equal(stripe.calls.length, 0, "nothing reached Stripe");

    const [a, b] = await Promise.all([
      billing.checkout("adam", { tenant: acme, plan: "pro", interval: "month", ...urls }),
      billing.checkout({ id: "alice" }, { tenant: acme, plan: "pro", interval: "year", ...urls }),
    ]);
    assert.match(a.url, /^https:\/\/checkout\.stripe\.com\//);
    assert.notEqual(a.id, b.id);
    assert.equal(stripe.customers.size, 1);
    const session = stripe.sessions.get(a.id)!;
    assert.equal(session.tenant, acme);
    assert.equal(session.trialDays, 14);
    assert.equal(session.price, "price_ProMonth");
    assert.equal(billing.plan(acme).plan, "free");

    const sub = stripe.complete(a.id);
    const forged = { ...sub, status: "active", items: { data: [{ id: "si_x", price: { id: "price_EntMonth" } }] } };
    let res = await deliver("customer.subscription.created", forged, { id: "evt_created" });
    assert.equal(res.status, 200);
    let st = billing.plan(acme);
    assert.equal(st.plan, "pro", "Stripe's state, not the payload's");
    assert.equal(st.status, "trialing");
    assert.equal(st.interval, "month");
    assert.equal(st.trialEnd, sub.trial_end! * 1000);
    assert.equal(st.periodEnd, sub.current_period_end * 1000);
    assert.ok(billing.has(acme, "exports"));
    assert.ok(!billing.has(acme, "sso"));
    assert.ok(!billing.has(acme, "nope" as never));
    assert.equal(billing.limit(acme, "seats"), 20);
    assert.equal(billing.plan(globex).plan, "free", "another tenant is untouched");
    assert.equal(billing.plan({ tenant: acme }).plan, "pro", "a principal acting in a tenant");
    assert.equal(billing.plan({}).plan, "free");
    assert.deepEqual(changes, [{ tenant: acme, from: "free/none", to: "pro/trialing" }]);

    const before = stripe.calls.length;
    res = await deliver("customer.subscription.created", forged, { id: "evt_created" });
    assert.equal(res.status, 200);
    assert.equal(stripe.calls.length, before, "a duplicate is not handled again");

    await fails(() => billing.checkout("adam", { tenant: acme, plan: "enterprise", interval: "month", ...urls }), "conflict");

    stripe.subs.get(sub.id)!.status = "past_due";
    await deliver("invoice.payment_failed", { customer: sub.customer, subscription: sub.id });
    assert.equal(billing.plan(acme).plan, "pro");
    assert.equal(billing.plan(acme).status, "past_due");
    stripe.subs.get(sub.id)!.status = "unpaid";
    await deliver("customer.subscription.updated", { id: sub.id, customer: sub.customer });
    st = billing.plan(acme);
    assert.equal(st.plan, "free");
    assert.equal(st.subscribed, "pro");
    assert.equal(st.status, "unpaid");
    assert.ok(!billing.has(acme, "exports"));
    stripe.subs.get(sub.id)!.status = "active";
    await deliver("invoice.paid", { customer: sub.customer, subscription: sub.id });
    assert.equal(billing.plan(acme).plan, "pro");

    await fails(() => billing.changePlan("mia", { tenant: acme, plan: "enterprise", interval: "month" }), "forbidden");
    st = await billing.changePlan("adam", { tenant: acme, plan: "enterprise", interval: "month" });
    assert.equal(st.plan, "enterprise");
    assert.equal(billing.limit(acme, "projects"), Infinity);
    assert.ok(billing.within(acme, "projects", 1e9));
    assert.ok(!billing.within(acme, "projects", NaN));
    const change = stripe.calls.at(-1)!;
    assert.equal(change.form.get("items[0][price]"), "price_EntMonth");
    assert.equal(change.form.get("proration_behavior"), "create_prorations");

    await fails(() => billing.cancel("mia", { tenant: acme }), "forbidden");
    st = await billing.cancel("adam", { tenant: acme });
    assert.equal(st.cancelAtPeriodEnd, true);
    assert.equal(st.plan, "enterprise", "until the period ends");
    st = await billing.resume("adam", { tenant: acme });
    assert.equal(st.cancelAtPeriodEnd, false);
    await fails(() => billing.resume("adam", { tenant: acme }), "not-found");
    st = await billing.cancel("adam", { tenant: acme, atPeriodEnd: false });
    assert.equal(st.status, "canceled");
    assert.equal(st.plan, "free");
    await fails(() => billing.cancel("adam", { tenant: acme }), "not-found");
    await fails(() => billing.changePlan("adam", { tenant: acme, plan: "pro", interval: "month" }), "not-found");

    const again = await billing.checkout("adam", { tenant: acme, plan: "pro", interval: "year", ...urls });
    assert.equal(stripe.sessions.get(again.id)!.trialDays, 0, "the trial is given once");
    assert.equal(stripe.customers.size, 1);
    const sub2 = stripe.complete(again.id);
    await deliver("checkout.session.completed", { mode: "subscription", customer: sub2.customer, subscription: sub2.id });
    assert.equal(billing.plan(acme).plan, "pro");
    assert.equal(billing.plan(acme).interval, "year");
    await deliver("customer.subscription.deleted", { id: sub.id, customer: sub.customer });
    assert.equal(billing.plan(acme).plan, "pro");
    assert.ok(!("subscription" in billing.plan(acme)), "the state has no Stripe ids");

    await fails(() => billing.portal("mia", { tenant: acme, returnUrl: "https://app.example/" }), "forbidden");
    await fails(() => billing.portal("gina", { tenant: globex, returnUrl: "https://app.example/" }), "not-found", /no billing account/);
    const p = await billing.portal("adam", { tenant: acme, returnUrl: "https://app.example/" });
    assert.match(p.url, /^https:\/\/billing\.stripe\.com\//);
    tick(1000);
    assert.equal(errors.length, 0, String(errors[0]));
  });
}

test("seats: per-seat plans buy one seat per member at least, and the seat setting follows the plan", async () => {
  let clock = Date.UTC(2026, 10, 14, 9);
  const stripe = fakeStripe(() => clock);
  const access = defineAccess({
    scopes: { org: {} },
    permissions: { "billing.manage": "Manage billing" },
    roles: {
      owner: { scope: "org", permissions: ["*"] },
      member: { scope: "org", permissions: [] },
    },
    owner: "owner",
    settings: { seats: { type: "number", default: 5, min: 1, max: 100_000, integer: true } },
    seats: "seats",
  });
  const errors: unknown[] = [];
  const billing = defineBilling({
    access,
    manage: "billing.manage",
    stripe: { secretKey: KEY, webhookSecret: HOOK },
    features: {},
    limits: { seats: "Seats" },
    plans: {
      free: { label: "Free", limits: { seats: 2 } },
      pro: { label: "Pro", limits: { seats: 10 }, prices: { month: "price_ProMonth" } },
      team: { label: "Team", perSeat: true, prices: { month: "price_TeamMonth" } },
    },
    default: "free",
    seats: { limit: "seats" },
    onError: (e) => errors.push(e),
    fetch: stripe.fetch,
    now: () => clock,
  });
  const org = access.createTenant("alice", { name: "Acme" }).id;
  access.assign("alice", { user: "mia", role: "member", scope: org });
  access.assign("alice", { user: "max", role: "member", scope: org });
  const seats = () => access.seatUse(org);
  assert.deepEqual(seats(), { used: 3, setting: "seats", limit: 5 });
  const urls = { successUrl: "https://app.example/b", cancelUrl: "https://app.example/b" };
  const deliver = (object: unknown) => {
    const body = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, type: "customer.subscription.updated", data: { object } });
    const t = Math.floor(clock / 1000);
    const sig = createHmac("sha256", HOOK).update(`${t}.${body}`).digest("hex");
    return billing.webhook(new Request("https://app.example/s", { method: "POST", body, headers: { "stripe-signature": `t=${t},v1=${sig}` } }));
  };
  const addMember = (user: string) => access.assign("alice", { user, role: "member", scope: org });

  await fails(() => billing.checkout("alice", { tenant: org, plan: "team", interval: "month", ...urls, quantity: 2 }), "limit", /3 members/);
  await fails(() => billing.checkout("alice", { tenant: org, plan: "pro", interval: "month", ...urls, quantity: 3 }), "invalid", /not sold per seat/);
  await fails(() => billing.checkout("alice", { tenant: org, plan: "team", interval: "month", ...urls, quantity: 1.5 }), "invalid");
  const { id } = await billing.checkout("alice", { tenant: org, plan: "team", interval: "month", ...urls });
  assert.equal(stripe.sessions.get(id)!.quantity, 3, "one per member by default");
  const sub = stripe.complete(id);
  await deliver({ id: sub.id, customer: sub.customer });
  let st = billing.plan(org);
  assert.equal(st.plan, "team");
  assert.equal(st.seats, 3);
  assert.equal(seats().limit, 3, "the seat setting is the seats bought");
  assert.throws(() => addMember("noa"), (e: unknown) => isAccessError(e, "limit"));

  await fails(() => billing.setSeats("mia", { tenant: org, seats: 6 }), "forbidden");
  await fails(() => billing.setSeats("alice", { tenant: org, seats: 2 }), "limit");
  st = await billing.setSeats("alice", { tenant: org, seats: 6 });
  assert.equal(st.seats, 6);
  assert.equal(stripe.subs.get(sub.id)!.items.data[0]!.quantity, 6);
  assert.equal(stripe.calls.at(-1)!.form.get("proration_behavior"), "create_prorations");
  assert.equal(seats().limit, 6);
  addMember("noa");

  st = await billing.changePlan("alice", { tenant: org, plan: "pro", interval: "month" });
  assert.equal(st.seats, null);
  assert.equal(stripe.subs.get(sub.id)!.items.data[0]!.quantity, 1);
  assert.equal(seats().limit, 10);
  await fails(() => billing.setSeats("alice", { tenant: org, seats: 12 }), "invalid", /not sold per seat/);
  await fails(() => billing.changePlan("alice", { tenant: org, plan: "pro", interval: "month", seats: 3 }), "invalid");
  st = await billing.changePlan("alice", { tenant: org, plan: "team", interval: "month" });
  assert.equal(st.seats, 4);
  assert.equal(seats().limit, 4);

  stripe.subs.get(sub.id)!.status = "unpaid";
  await deliver({ id: sub.id, customer: sub.customer });
  assert.equal(billing.plan(org).plan, "free");
  assert.deepEqual(seats(), { used: 4, setting: "seats", limit: 2 });
  assert.throws(() => addMember("ola"), (e: unknown) => isAccessError(e, "limit"));
  await fails(() => billing.setSeats("alice", { tenant: org, seats: 8 }), "not-found");
  assert.equal(errors.length, 0, String(errors[0]));
  clock += 1;
});

test("seat declarations", () => {
  const access = defineAccess({
    scopes: { org: {} },
    permissions: {},
    roles: { owner: { scope: "org", permissions: ["*"] } },
    owner: "owner",
  });
  const base = {
    access,
    manage: "billing.manage",
    stripe: { secretKey: KEY, webhookSecret: HOOK },
    features: {},
    limits: { seats: "Seats" },
    default: "free",
  };
  const bad = (patch: object, msg: RegExp) =>
    assert.throws(() => defineBilling({ ...base, ...patch } as never), (e: unknown) => isAccessError(e, "invalid") && msg.test(e.message));
  bad({ plans: { free: { label: "Free" }, team: { label: "T", perSeat: true, prices: { month: "price_T" } } } }, /perSeat needs/);
  bad({ plans: { free: { label: "Free" } }, seats: {} }, /names no seat setting/);
  bad({ plans: { free: { label: "Free", perSeat: true } }, seats: {} }, /needs a price/);
  bad({ plans: { free: { label: "Free", perSeat: "yes" } } }, /true or false/);
});

test("webhook signatures, bodies and events from elsewhere", async () => {
  const { billing, stripe, acme, deliver, urls, tick, errors } = setup();
  const { id } = await billing.checkout("adam", { tenant: acme, plan: "enterprise", interval: "month", ...urls });
  const sub = stripe.complete(id);
  const obj = { id: sub.id, customer: sub.customer };
  assert.equal((await deliver("customer.subscription.created", obj, { secret: "whsec_wrongwrongwrong" })).status, 400);
  assert.equal((await deliver("customer.subscription.created", obj, { at: Date.now() - 1e12 })).status, 400);
  const now = Date.UTC(2026, 10, 14, 9);
  assert.equal((await deliver("customer.subscription.created", obj, { at: now - 301_000 })).status, 400);
  assert.equal((await deliver("customer.subscription.created", obj, { at: now + 301_000 })).status, 400);
  const body = JSON.stringify({ id: "evt_t", type: "customer.subscription.created", data: { object: obj } });
  const t = Math.floor(now / 1000);
  const sig = createHmac("sha256", HOOK).update(`${t}.${body}`).digest("hex");
  const send = (b: string, header: string | null, method = "POST") =>
    billing.webhook(
      new Request("https://app.example/api/stripe", {
        method,
        ...(method === "POST" ? { body: b } : {}),
        headers: header === null ? {} : { "stripe-signature": header },
      }),
    );
  assert.equal((await send(body + " ", `t=${t},v1=${sig}`)).status, 400, "tampered");
  assert.equal((await send(body, null)).status, 400, "unsigned");
  assert.equal((await send(body, `t=${t}`)).status, 400);
  assert.equal((await send(body, `t=${t},v0=${sig}`)).status, 400, "only v1 counts");
  assert.equal((await send(body, `t=${t},v1=${sig.toUpperCase()}`)).status, 400);
  assert.equal((await send(body, "", "GET")).status, 405);
  assert.equal(billing.plan(acme).plan, "free", "nothing applied so far");
  assert.equal((await send(body, `t=${t},v1=${"0".repeat(64)},v1=${sig}`)).status, 200);
  assert.equal(billing.plan(acme).plan, "enterprise");
  assert.equal((await deliver("customer.subscription.updated", obj, { secret: OLD_HOOK })).status, 200);
  const big = "x".repeat(1024 * 1024 + 1);
  assert.equal((await deliver("x", null, { body: big })).status, 413);
  assert.equal((await deliver("x", null, { body: "{not json" })).status, 400);
  assert.equal((await deliver("x", null, { body: JSON.stringify({ id: "evt with space", type: "x" }) })).status, 400);
  assert.equal((await deliver("customer.subscription.updated", { id: "sub_999", customer: "cus_other" })).status, 200);
  assert.equal((await deliver("charge.refunded", { id: "ch_1" })).status, 200);
  assert.equal((await deliver("checkout.session.completed", { mode: "payment", customer: sub.customer })).status, 200);
  assert.equal(errors.length, 0);

  stripe.subs.get(sub.id)!.status = "canceled";
  stripe.failNext(3);
  assert.equal((await deliver("customer.subscription.deleted", obj, { id: "evt_retry" })).status, 500);
  assert.ok(errors.at(-1) instanceof StripeError);
  assert.equal(billing.plan(acme).plan, "enterprise");
  assert.equal((await deliver("customer.subscription.deleted", obj, { id: "evt_retry" })).status, 200);
  assert.equal(billing.plan(acme).plan, "free");
  for (const e of errors) assert.ok(!String((e as Error).message).includes(KEY));

  assert.equal(billing.prune(0), 0, "none older than now");
  tick(31 * 86_400_000);
  assert.ok(billing.prune() > 0);
});

test("a subscription is applied only to its own customer's tenant", async () => {
  const { billing, stripe, acme, globex, deliver, urls, access } = setup();
  access.assign("gina", { user: "adam", role: "owner", scope: globex });
  const a = await billing.checkout("adam", { tenant: acme, plan: "pro", interval: "month", ...urls });
  await billing.checkout("adam", { tenant: globex, plan: "pro", interval: "month", ...urls });
  assert.equal(stripe.customers.size, 2);
  const sub = stripe.complete(a.id);
  const globexCustomer = [...stripe.customers.values()].find((c) => c.metadata.tenant === globex)!.id;
  const res = await deliver("customer.subscription.created", { id: sub.id, customer: globexCustomer });
  assert.equal(res.status, 500);
  assert.equal(billing.plan(globex).plan, "free");
  assert.equal(billing.plan(acme).plan, "free");
  await deliver("customer.subscription.created", { id: sub.id, customer: sub.customer });
  assert.equal(billing.plan(acme).plan, "pro");
  assert.equal(billing.plan(globex).plan, "free");
});

test("an unknown price falls back to the default plan and is reported", async () => {
  const { billing, stripe, acme, deliver, urls, errors } = setup();
  const { id } = await billing.checkout("adam", { tenant: acme, plan: "pro", interval: "month", ...urls });
  const sub = stripe.complete(id);
  sub.status = "active";
  sub.items.data[0]!.price.id = "price_SomethingElse";
  await deliver("customer.subscription.created", { id: sub.id, customer: sub.customer });
  const st = billing.plan(acme);
  assert.equal(st.plan, "free");
  assert.equal(st.subscribed, null);
  assert.equal(st.status, "active");
  assert.match(String(errors[0]), /price_SomethingElse.*not in any plan/);
});

test("a page that read the plan sees the upgrade as a change", async () => {
  const { billing, stripe, acme, globex, deliver, urls } = setup();
  const seen: [Model<unknown>, unknown][] = [];
  const stop = onRead((model, actor) => seen.push([model, actor]));
  assert.equal(billing.has(acme, "exports"), false);
  const globexRead = (() => {
    const at = seen.length;
    billing.plan(globex);
    return seen[at]!;
  })();
  stop();
  const read = seen.find(([m]) => m === (billing.models.BillingAccount as Model<unknown>))!;
  assert.ok(read, "the plan read is noted");
  const relevant: boolean[] = [];
  const other: boolean[] = [];
  const unsub = billing.models.BillingAccount.feed.subscribe((c) => {
    if (c.model !== billing.models.BillingAccount.name) return;
    relevant.push(canSee(read[0], read[1] as never, c));
    other.push(canSee(globexRead[0], globexRead[1] as never, c));
  });
  const { id } = await billing.checkout("adam", { tenant: acme, plan: "pro", interval: "month", ...urls });
  const sub = stripe.complete(id);
  await deliver("customer.subscription.created", { id: sub.id, customer: sub.customer });
  unsub();
  assert.ok(relevant.length > 0 && relevant.every(Boolean), "Acme's reader re-renders");
  assert.ok(other.every((x) => !x), "Globex's reader does not");
});

for (const driver of ["memory", "sqlite"] as const) test(`the models are closed to application code (${driver})`, () => {
  const { billing, acme } = setup(driver);
  for (const actor of ["alice", { id: "alice" }, { all: true }, { tenant: acme }, { id: "billing:system", all: true }]) {
    assert.equal(billing.models.BillingAccount.as(actor as never).query().count(), 0);
    assert.equal(
      billing.models.BillingAccount.as(actor as never).create({
        tenant: acme,
        customer: "cus_x",
        subscription: "sub_x",
        plan: "enterprise",
        price: "price_EntMonth",
        status: "active",
        periodEnd: null,
        cancelAtPeriodEnd: false,
        trialEnd: null,
        trialUsed: false,
        quantity: null,
        pastDueSince: null,
        lapsed: false,
        updated: 0,
      }),
      undefined,
    );
    assert.equal(billing.models.BillingEvent.as(actor as never).create({ id: "evt_x", type: "x", received: 0 }), undefined);
    assert.equal(billing.models.BillingEvent.as(actor as never).query().count(), 0);
  }
  assert.equal(billing.plan(acme).plan, "free");
});

test("Stripe calls: retries, errors and the form encoding", async () => {
  const { billing, stripe, acme, urls, access: shared } = setup();
  stripe.failNext(1);
  await billing.checkout("adam", { tenant: acme, plan: "pro", interval: "month", ...urls });
  const posts = stripe.calls.filter((c) => c.path === "/v1/customers");
  assert.equal(posts.length, 2, "retried once");
  assert.equal(posts[0]!.headers["idempotency-key"], posts[1]!.headers["idempotency-key"], "with the same key");
  assert.equal(stripe.customers.size, 1);
  const twin = defineBilling({
    access: shared,
    manage: "billing.manage",
    stripe: { secretKey: KEY, webhookSecret: HOOK },
    features: {},
    limits: {},
    plans: { free: { label: "Free" }, pro: { label: "Pro", prices: { month: "price_ProMonth" } } },
    default: "free",
    fetch: stripe.fetch,
    prefix: "Twin",
  });
  await twin.checkout("adam", { tenant: acme, plan: "pro", interval: "month", ...urls });
  assert.equal(stripe.customers.size, 1, "one customer for the tenant");
  assert.equal(
    stripeForm({ a: 1, b: { c: [1, { d: "x y" }], e: null }, f: true }),
    "a=1&b%5Bc%5D%5B0%5D=1&b%5Bc%5D%5B1%5D%5Bd%5D=x+y&f=true",
  );
  const { access } = setup();
  const other = access.createTenant("olga", { name: "Other" }).id;
  const bad = defineBilling({
    access,
    manage: "billing.manage",
    stripe: { secretKey: "sk_test_wrongkey000000", webhookSecret: HOOK },
    features: {},
    limits: {},
    plans: { free: { label: "Free" }, pro: { label: "Pro", prices: { month: "price_P" } } },
    default: "free",
    fetch: stripe.fetch,
    prefix: "Wrong",
  });
  const n = stripe.calls.length;
  await assert.rejects(
    () => bad.checkout("olga", { tenant: other, plan: "pro", interval: "month", ...urls }),
    (e: unknown) => e instanceof StripeError && e.status === 401 && !e.message.includes("wrongkey"),
  );
  assert.equal(stripe.calls.length, n + 1, "not retried");
});

test("verifyStripeSignature", async () => {
  const t = 1_800_000_000;
  const sig = createHmac("sha256", HOOK).update(`${t}.hello`).digest("hex");
  assert.ok(await verifyStripeSignature("hello", `t=${t},v1=${sig}`, [HOOK], t));
  assert.ok(await verifyStripeSignature("hello", ` t=${t} , v1=${sig} `, [OLD_HOOK, HOOK], t + 300));
  assert.ok(!(await verifyStripeSignature("hello", `t=${t},v1=${sig}`, [HOOK], t + 301)));
  assert.ok(!(await verifyStripeSignature("hello!", `t=${t},v1=${sig}`, [HOOK], t)));
  assert.ok(!(await verifyStripeSignature("hello", `t=${t},v1=${sig}`, [], t)));
  assert.ok(!(await verifyStripeSignature("hello", `t=${t + 1},v1=${sig}`, [HOOK], t)));
  assert.ok(!(await verifyStripeSignature("hello", `t=x,v1=${sig}`, [HOOK], t)));
  assert.ok(!(await verifyStripeSignature("hello", null, [HOOK], t)));
  assert.ok(!(await verifyStripeSignature("hello", `t=${t},v1=${sig}${",x".repeat(3000)}`, [HOOK], t)));
});

test("billing declarations are checked at startup", () => {
  const { access } = setup();
  const base = {
    access,
    manage: "billing.manage",
    stripe: { secretKey: KEY, webhookSecret: HOOK },
    features: { exports: "Exports" },
    limits: { seats: "Seats" },
    plans: { free: { label: "Free" }, pro: { label: "Pro", features: ["exports"], prices: { month: "price_P" } } },
    default: "free",
  };
  const bad = (patch: object, msg: RegExp) =>
    assert.throws(() => defineBilling({ ...base, ...patch } as never), (e: unknown) => isAccessError(e, "invalid") && msg.test(e.message));
  bad({ access: {} }, /access/);
  bad({ manage: "" }, /manage/);
  bad({ stripe: { secretKey: "pk_test_publishable0000", webhookSecret: HOOK } }, /secret or restricted key/);
  bad({ stripe: { secretKey: KEY, webhookSecret: "nope" } }, /whsec_/);
  bad({ stripe: { secretKey: KEY, webhookSecret: [] } }, /whsec_/);
  bad({ stripe: { secretKey: KEY, webhookSecret: HOOK, apiVersion: "latest" } }, /apiVersion/);
  bad({ stripe: { secretKey: KEY, webhookSecret: HOOK, toleranceSeconds: 0 } }, /toleranceSeconds/);
  bad({ features: { "Bad Name": "x" } }, /feature/);
  bad({ plans: {} }, /at least one plan/);
  bad({ plans: { free: { label: "" } } }, /label/);
  bad({ plans: { free: { label: "Free", features: ["sso"] } } }, /no feature "sso"/);
  bad({ plans: { free: { label: "Free", limits: { nope: 1 } } } }, /no limit/);
  bad({ plans: { free: { label: "Free", limits: { seats: -1 } } } }, /whole number/);
  bad({ plans: { free: { label: "Free", limits: { seats: 1.5 } } } }, /whole number/);
  bad({ plans: { free: { label: "Free" }, pro: { label: "Pro", prices: { week: "price_P" } } } }, /month/);
  bad({ plans: { free: { label: "Free" }, pro: { label: "Pro", prices: { month: "prod_P" } } } }, /price id/);
  bad({ plans: { free: { label: "Free" }, a: { label: "A", prices: { month: "price_P" } }, b: { label: "B", prices: { year: "price_P" } } } }, /another plan/);
  bad({ plans: { free: { label: "Free" }, pro: { label: "Pro", trialDays: 7 } } }, /trial needs a price/);
  bad({ default: "gold" }, /default names a plan/);
  bad({ default: "pro" }, /not sold/);
  bad({ prefix: "bad prefix" }, /prefix/);
  const ok = defineBilling(base as never);
  assert.deepEqual(
    ok.plans().map((p) => [p.name, p.intervals, p.features, p.limits]),
    [
      ["free", [], [], { seats: 0 }],
      ["pro", ["month"], ["exports"], { seats: 0 }],
    ],
  );
});

function meteredSetup(driver: "memory" | "sqlite" = "memory") {
  let clock = Date.UTC(2026, 10, 14, 9);
  const stripe = fakeStripe(() => clock);
  const access = defineAccess({
    scopes: { org: {} },
    permissions: { "billing.manage": "Manage billing", "billing.view": "See invoices" },
    roles: {
      owner: { scope: "org", permissions: ["*"] },
      accountant: { scope: "org", permissions: ["billing.view"] },
      member: { scope: "org", permissions: [] },
    },
    owner: "owner",
  });
  const errors: unknown[] = [];
  const failures: PaymentFailure[] = [];
  const changes: string[] = [];
  const billing = defineBilling({
    access,
    manage: "billing.manage",
    invoices: "billing.view",
    stripe: { secretKey: KEY, webhookSecret: HOOK },
    features: { exports: "Exports" },
    limits: {},
    meters: {
      apiCalls: { label: "API calls", event: "api_calls", prices: { month: "price_ApiMonth", year: "price_ApiYear" } },
      storage: { label: "Storage GB", event: "storage_gb", prices: { month: "price_StoreMonth" } },
    },
    plans: {
      free: { label: "Free" },
      pro: { label: "Pro", features: ["exports"], prices: { month: "price_ProMonth" }, meters: ["apiCalls", "storage"] },
      scale: { label: "Scale", features: ["exports"], prices: { month: "price_ScaleMonth", year: "price_ScaleYear" }, meters: ["apiCalls"] },
    },
    default: "free",
    dunning: { graceDays: 7 },
    onPaymentFailed: (f) => void failures.push(f),
    onChange: (c) => void changes.push(`${c.from.plan}${c.from.readOnly ? "(ro)" : ""}>${c.to.plan}${c.to.readOnly ? "(ro)" : ""}`),
    onError: (e) => errors.push(e),
    fetch: stripe.fetch,
    now: () => clock,
  });
  if (driver === "sqlite") {
    useDatabase(openSqlite(":memory:"), [...Object.values(access.models), ...Object.values(billing.models)] as Model<never>[]);
  }
  const org = access.createTenant("alice", { name: "Acme" }).id;
  access.assign("alice", { user: "ann", role: "accountant", scope: org });
  access.assign("alice", { user: "mia", role: "member", scope: org });
  const deliver = (type: string, object: unknown) => {
    const body = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, type, data: { object } });
    const t = Math.floor(clock / 1000);
    const sig = createHmac("sha256", HOOK).update(`${t}.${body}`).digest("hex");
    return billing.webhook(new Request("https://app.example/s", { method: "POST", body, headers: { "stripe-signature": `t=${t},v1=${sig}` } }));
  };
  const subscribe = async (plan: "pro" | "scale" = "pro") => {
    const { id } = await billing.checkout("alice", { tenant: org, plan, interval: "month", successUrl: "https://app.example/b", cancelUrl: "https://app.example/b" });
    const sub = stripe.complete(id);
    sub.status = "active";
    await deliver("customer.subscription.created", { id: sub.id, customer: sub.customer });
    return sub;
  };
  return { billing, access, stripe, org, errors, failures, changes, deliver, subscribe, tick: (ms: number) => (clock += ms), now: () => clock };
}

for (const driver of ["memory", "sqlite"] as const) {
  test(`usage: recorded once per id, reported once per event, summed for pages (${driver})`, async () => {
    const { billing, stripe, org, errors, subscribe, deliver, tick, now } = meteredSetup(driver);
    assert.equal(await billing.record(org, "apiCalls", 5, { id: "req-1" }), true);
    assert.equal(await billing.record(org, "apiCalls", 5, { id: "req-1" }), false, "the same id counts once");
    assert.equal(await billing.record({ tenant: org }, "apiCalls"), true);
    assert.deepEqual(await billing.reportUsage(), { sent: 0, waiting: 2, expired: 0, failed: 0 });
    assert.equal(stripe.meterEvents.size, 0);

    const sub = await subscribe("pro");
    assert.deepEqual(
      sub.items.data.map((i) => i.price.id),
      ["price_ProMonth", "price_ApiMonth", "price_StoreMonth"],
      "the plan's metered prices are on the subscription",
    );
    sub.items.data.reverse();
    sub.items.data.unshift({ id: "si_addon", quantity: 1, price: { id: "price_Addon", recurring: { interval: "month" } } });
    await deliver("customer.subscription.updated", { id: sub.id, customer: sub.customer });
    assert.equal(billing.plan(org).plan, "pro", "the plan item is found among metered ones, in any order");
    await billing.record(org, "storage", 12, { id: "day-1" });
    stripe.failNext(3);
    let r = await billing.reportUsage();
    assert.equal(r.sent, 0);
    assert.equal(r.failed, 1);
    assert.ok(errors.pop() instanceof StripeError);
    r = await billing.reportUsage();
    assert.deepEqual(r, { sent: 3, waiting: 0, expired: 0, failed: 0 });
    assert.equal(stripe.meterEvents.size, 3);
    const events = [...stripe.meterEvents.values()];
    assert.deepEqual(events.map((e) => [e.event, e.value]).sort(), [["api_calls", 1], ["api_calls", 5], ["storage_gb", 12]]);
    assert.ok(events.every((e) => e.customer === sub.customer));
    assert.deepEqual(await billing.reportUsage(), { sent: 0, waiting: 0, expired: 0, failed: 0 }, "nothing sent twice");
    const posts = stripe.calls.filter((c) => c.path === "/v1/billing/meter_events");
    assert.ok(posts.every((c) => c.headers["idempotency-key"] === `weft-usage-${c.form.get("identifier")}`));

    tick(1000);
    const mid = now();
    await billing.record(org, "apiCalls", 7);
    assert.equal(billing.usage(org, "apiCalls"), 13);
    assert.equal(billing.usage(org, "apiCalls", { since: mid }), 7);
    assert.equal(billing.usage(org, "apiCalls", { until: mid }), 6);
    assert.equal(billing.usage(org, "storage"), 12);
    assert.equal(billing.usage("other", "apiCalls"), 0);
    assert.equal(billing.usage(org, "nope" as never), 0);
    assert.equal(await billing.record("other-org", "apiCalls", 1, { id: "req-1" }), true);

    tick(36 * 86_400_000);
    r = await billing.reportUsage();
    assert.equal(r.expired, 2);
    assert.match(String(errors.at(-1)), /not reported within 35 days/);
    await billing.record(org, "apiCalls", 4, { at: now() - 1000 });
    assert.ok(billing.prune(0) > 0, "sent and dropped usage is pruned");
    assert.equal(billing.usage(org, "apiCalls"), 4, "pending usage is kept");
    assert.equal(errors.length, 2, "one report per dropped event");
  });
}

test("usage arguments and the models are checked", async () => {
  const { billing, org, now } = meteredSetup();
  await fails(() => billing.record("", "apiCalls"), "invalid", /tenant/);
  await fails(() => billing.record(org, "nope" as never), "invalid", /no meter/);
  await fails(() => billing.record(org, "apiCalls", -1), "invalid", /whole number/);
  await fails(() => billing.record(org, "apiCalls", 1.5), "invalid", /whole number/);
  await fails(() => billing.record(org, "apiCalls", 1, { at: now() + 3600_000 }), "invalid", /35 days/);
  await fails(() => billing.record(org, "apiCalls", 1, { at: now() - 35 * 86_400_000 }), "invalid", /35 days/);
  await fails(() => billing.record(org, "apiCalls", 1, { id: "has space" }), "invalid", /printable/);
  await fails(() => billing.reportUsage({ limit: 0 }), "invalid");
  await billing.record(org, "apiCalls", 3);
  for (const actor of ["alice", { tenant: org }, { all: true }]) {
    const m = billing.models.UsageRecord.as(actor as never);
    assert.equal(m.query().count(), 0, "closed to application code");
    assert.equal(m.create({ id: "x", tenant: org, meter: "apiCalls", value: 1e9, at: now(), status: "pending", sent: null }), undefined);
  }
  assert.equal(billing.usage(org, "apiCalls"), 3);
});

test("changing plans keeps, drops and adds metered prices", async () => {
  const s = meteredSetup();
  const sub = await s.subscribe("pro");
  await s.billing.changePlan("alice", { tenant: s.org, plan: "scale", interval: "month" });
  assert.deepEqual(s.stripe.subs.get(sub.id)!.items.data.map((i) => i.price.id), ["price_ScaleMonth", "price_ApiMonth"], "storage dropped, api kept");
  const apiItem = sub.items.data[1]!.id;
  assert.equal(s.stripe.subs.get(sub.id)!.items.data[1]!.id, apiItem, "the kept item is the same item");
  await s.billing.changePlan("alice", { tenant: s.org, plan: "scale", interval: "year" });
  assert.deepEqual(s.stripe.subs.get(sub.id)!.items.data.map((i) => i.price.id), ["price_ScaleYear", "price_ApiYear"]);
  await s.billing.changePlan("alice", { tenant: s.org, plan: "pro", interval: "month" });
  assert.deepEqual(s.stripe.subs.get(sub.id)!.items.data.map((i) => i.price.id), ["price_ProMonth", "price_ApiMonth", "price_StoreMonth"]);
  assert.equal(s.billing.plan(s.org).plan, "pro");
  assert.deepEqual(s.billing.plans().find((p) => p.name === "pro")!.meters, ["apiCalls", "storage"]);
});

test("invoices, tax ids and billing details: the tenant's customer only, by permission", async () => {
  const { billing, stripe, org, access, subscribe, errors } = meteredSetup();
  assert.deepEqual(await billing.invoices("ann", { tenant: org }), { invoices: [], more: false });
  assert.deepEqual(await billing.taxIds("ann", { tenant: org }), []);
  assert.deepEqual(await billing.billingDetails("ann", { tenant: org }), { email: null, name: null });
  const sub = await subscribe();
  const first = stripe.failInvoice(sub.id);
  stripe.invoices.get(first.id)!.status = "paid";
  stripe.subs.get(sub.id)!.status = "active";
  const second = stripe.failInvoice(sub.id);
  stripe.subs.get(sub.id)!.status = "active";
  const other = access.createTenant("olga", { name: "Other" }).id;
  await billing.checkout("olga", { tenant: other, plan: "pro", interval: "month", successUrl: "https://app.example/b", cancelUrl: "https://app.example/b" });
  const otherSub = stripe.complete([...stripe.sessions.values()].at(-1)!.id);
  stripe.failInvoice(otherSub.id);
  stripe.invoices.get(second.id)!.hosted_invoice_url = "https://evil.example/pay";

  await fails(() => billing.invoices("mia", { tenant: org }), "forbidden");
  await fails(() => billing.invoices("olga", { tenant: org }), "not-found");
  await fails(() => billing.invoices("ann", { tenant: org, limit: 0 }), "invalid");
  await fails(() => billing.invoices("ann", { tenant: org, startingAfter: "../x" }), "invalid");
  let page = await billing.invoices("ann", { tenant: org, limit: 1 });
  assert.equal(page.invoices.length, 1);
  assert.equal(page.more, true);
  assert.equal(page.invoices[0]!.id, second.id, "newest first");
  assert.equal(page.invoices[0]!.hostedUrl, null, "only stripe.com links");
  assert.equal(page.invoices[0]!.total, 2900);
  stripe.leak(true);
  assert.ok((await billing.invoices("ann", { tenant: org, limit: 100 })).invoices.every((i) => i.id === first.id || i.id === second.id), "another customer's invoice is dropped");
  stripe.leak(false);
  page = await billing.invoices("ann", { tenant: org, startingAfter: second.id });
  assert.deepEqual(page.invoices.map((i) => [i.id, i.status]), [[first.id, "paid"]]);
  assert.match(page.invoices[0]!.hostedUrl!, /^https:\/\/invoice\.stripe\.com\//);
  assert.equal(page.more, false);

  await fails(() => billing.addTaxId("ann", { tenant: org, type: "eu_vat", value: "CZ12345678" }), "forbidden");
  await fails(() => billing.addTaxId("alice", { tenant: org, type: "EU VAT", value: "CZ12345678" }), "invalid");
  await fails(() => billing.addTaxId("alice", { tenant: org, type: "eu_vat", value: "a\nb" }), "invalid");
  await assert.rejects(() => billing.addTaxId("alice", { tenant: org, type: "eu_vat", value: "nope" }), (e: unknown) => e instanceof StripeError && e.status === 400);
  const t = await billing.addTaxId("alice", { tenant: org, type: "eu_vat", value: " CZ12345678 " });
  assert.deepEqual([t.type, t.value, t.verification], ["eu_vat", "CZ12345678", "pending"]);
  assert.deepEqual((await billing.taxIds("ann", { tenant: org })).map((x) => x.id), [t.id]);
  access.assign("olga", { user: "alice", role: "owner", scope: other });
  await assert.rejects(() => billing.removeTaxId("alice", { tenant: other, id: t.id }), (e: unknown) => e instanceof StripeError && e.status === 404);
  await fails(() => billing.removeTaxId("alice", { tenant: org, id: "cus_1" }), "invalid");
  await billing.removeTaxId("alice", { tenant: org, id: t.id });
  assert.equal(stripe.taxIds.size, 0);

  await fails(() => billing.setBillingDetails("ann", { tenant: org, email: "a@b.example" }), "forbidden");
  await fails(() => billing.setBillingDetails("alice", { tenant: org, email: "a@b.example\r\nBcc: x@y.example" }), "invalid");
  await fails(() => billing.setBillingDetails("alice", { tenant: org, email: "not an email" }), "invalid");
  await fails(() => billing.setBillingDetails("alice", { tenant: org, name: "" }), "invalid");
  let d = await billing.setBillingDetails("alice", { tenant: org, email: "billing@acme.example", name: " Acme s.r.o. " });
  assert.deepEqual(d, { email: "billing@acme.example", name: "Acme s.r.o." });
  assert.deepEqual(await billing.billingDetails("ann", { tenant: org }), d);
  d = await billing.setBillingDetails("alice", { tenant: org, name: null });
  assert.deepEqual(d, { email: "billing@acme.example", name: null });
  assert.equal(errors.length, 0, String(errors[0]));
});

for (const driver of ["memory", "sqlite"] as const) {
  test(`dunning: grace period, read-only when unpaid, the failure hook and paying again (${driver})`, async () => {
    const { billing, stripe, org, failures, changes, deliver, subscribe, tick, errors } = meteredSetup(driver);
    const sub = await subscribe();
    assert.equal(billing.readOnly(org), false);
    changes.length = 0;

    const inv = stripe.failInvoice(sub.id);
    await deliver("invoice.payment_failed", { id: inv.id, customer: sub.customer, subscription: sub.id, attempt_count: 99, amount_due: 1 });
    let st = billing.plan(org);
    assert.equal(st.status, "past_due");
    assert.equal(st.plan, "pro");
    assert.equal(st.readOnly, false);
    const graceEnds = st.graceEnds!;
    assert.ok(graceEnds > 0);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.attempt, 1, "from Stripe's invoice, not the payload");
    assert.equal(failures[0]!.invoice.amountDue, 2900);
    assert.equal(failures[0]!.graceEnds, graceEnds);
    assert.ok(failures[0]!.nextAttempt! > 0);
    tick(86_400_000);
    const inv2 = stripe.failInvoice(sub.id, 2);
    await deliver("invoice.payment_failed", { id: inv2.id, customer: sub.customer, subscription: sub.id });
    assert.equal(billing.plan(org).graceEnds, graceEnds);
    stripe.invoices.set("in_foreign", { ...inv2, id: "in_foreign", customer: "cus_foreign" });
    await deliver("invoice.payment_failed", { id: "in_foreign", customer: sub.customer, subscription: sub.id });
    assert.equal(failures.length, 2);

    assert.equal(await billing.checkGrace(), 0, "not yet");
    const seen = changes.length;
    tick(6 * 86_400_000);
    st = billing.plan(org);
    assert.equal(st.plan, "free");
    assert.equal(st.readOnly, true);
    assert.ok(!billing.has(org, "exports"));
    assert.equal(await billing.checkGrace(), 1);
    assert.equal(await billing.checkGrace(), 0, "once");
    assert.deepEqual(changes.slice(seen), ["pro>free(ro)"]);

    await fails(() => billing.retryPayment("ann", { tenant: org }), "forbidden");
    stripe.decline(true);
    let paid = await billing.retryPayment("alice", { tenant: org });
    assert.equal(paid.paid, false);
    assert.match(paid.message!, /declined/);
    assert.equal(paid.state.readOnly, true);
    stripe.decline(false);
    paid = await billing.retryPayment("alice", { tenant: org });
    assert.equal(paid.paid, true);
    assert.equal(paid.state.plan, "pro");
    assert.equal(paid.state.readOnly, false);
    assert.equal(paid.state.graceEnds, null);
    await fails(() => billing.retryPayment("alice", { tenant: org }), "not-found", /nothing to pay/);

    tick(86_400_000);
    stripe.failInvoice(sub.id);
    await deliver("customer.subscription.updated", { id: sub.id, customer: sub.customer });
    assert.ok(billing.plan(org).graceEnds! > graceEnds + 7 * 86_400_000);
    stripe.subs.get(sub.id)!.status = "unpaid";
    await deliver("customer.subscription.updated", { id: sub.id, customer: sub.customer });
    assert.equal(billing.readOnly(org), true);
    assert.equal(errors.length, 0, String(errors[0]));
  });
}

test("without dunning, past due keeps the plan and nothing is read-only", async () => {
  const { billing, stripe, acme, deliver, urls } = setup();
  const { id } = await billing.checkout("adam", { tenant: acme, plan: "enterprise", interval: "month", ...urls });
  const sub = stripe.complete(id);
  stripe.failInvoice(sub.id);
  await deliver("customer.subscription.updated", { id: sub.id, customer: sub.customer });
  const st = billing.plan(acme);
  assert.deepEqual([st.plan, st.status, st.readOnly, st.graceEnds], ["enterprise", "past_due", false, null]);
  stripe.subs.get(sub.id)!.status = "unpaid";
  await deliver("customer.subscription.updated", { id: sub.id, customer: sub.customer });
  assert.equal(billing.readOnly(acme), false);
  assert.equal(await billing.checkGrace(), 0);
});

test("meter and dunning declarations", () => {
  const { access } = setup();
  const base = {
    access,
    manage: "billing.manage",
    stripe: { secretKey: KEY, webhookSecret: HOOK },
    features: {},
    limits: {},
    meters: { calls: { label: "Calls", event: "calls", prices: { month: "price_CallsM" } } },
    plans: { free: { label: "Free" }, pro: { label: "Pro", prices: { month: "price_P" }, meters: ["calls"] } },
    default: "free",
  };
  const bad = (patch: object, msg: RegExp) =>
    assert.throws(() => defineBilling({ ...base, ...patch } as never), (e: unknown) => isAccessError(e, "invalid") && msg.test(e.message));
  assert.ok(defineBilling(base as never));
  bad({ meters: { "bad name": { label: "x", event: "x" } } }, /meter/);
  bad({ meters: { calls: { label: "", event: "x" } } }, /label/);
  bad({ meters: { calls: { label: "C", event: "has space" } } }, /event name/);
  bad({ meters: { calls: { label: "C", event: "c", prices: { month: "prod_x" } } } }, /price id/);
  bad({ meters: { a: { label: "A", event: "a", prices: { month: "price_X" } }, b: { label: "B", event: "b", prices: { month: "price_X" } } } }, /another meter/);
  bad({ meters: { calls: { label: "C", event: "c", prices: { month: "price_P" } } } }, /another plan/);
  bad({ plans: { free: { label: "Free" }, pro: { label: "Pro", prices: { month: "price_P" }, meters: ["nope"] } } }, /no meter/);
  bad({ plans: { free: { label: "Free" }, pro: { label: "Pro", prices: { month: "price_P", year: "price_PY" }, meters: ["calls"] } } }, /no year price/);
  bad({ dunning: { graceDays: -1 } }, /graceDays/);
  bad({ dunning: { graceDays: 1.5 } }, /graceDays/);
  bad({ invoices: "" }, /invoices/);
  bad({ onPaymentFailed: "x" }, /onPaymentFailed/);
});
