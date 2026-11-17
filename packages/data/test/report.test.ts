import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel, defineReport, reportCsv, reportRows, useDatabase, type Model } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Order {
  id: string;
  org: string;
  owner: string;
  plan: "free" | "pro" | null;
  amount: number | null;
  created: number;
}

const ada = { id: "ada", tenant: "acme" };
const bob = { id: "bob", tenant: "acme" };
const T = (iso: string) => Date.parse(iso);

function setup(driver: "memory" | "sqlite") {
  const Order = defineModel<Order>("Order", {
    fields: { id: "string", org: "string", owner: "string", plan: '"free" | "pro" | null', amount: "number | null", created: "number" },
    attrs: { org: { tenant: true }, created: { index: true } },
    read: (a: { id: string }, o) => a.id === "ada" || o.owner === a.id,
    write: () => true,
  });
  if (driver === "sqlite") useDatabase(openSqlite(":memory:"), [Order as Model<never>]);
  const add = (id: string, created: string, o: Partial<Order> = {}) =>
    Order.as(ada).create({ id, org: "acme", owner: "ada", plan: "pro", amount: 10, created: T(created), ...o });
  add("o1", "2026-10-05T10:00:00Z", { amount: 20 });
  add("o2", "2026-10-31T23:30:00Z", { amount: 5, plan: "free" });
  add("n1", "2026-11-02T08:00:00Z", { amount: 30 });
  add("n2", "2026-11-02T09:00:00Z", { amount: null, plan: "free" });
  add("n3", "2026-11-11T12:00:00Z", { amount: 40, owner: "bob", plan: null });
  add("d1", "2026-12-01T00:00:00Z", { amount: 7 });
  add("o3", "2026-10-02T00:00:00Z", { amount: null });
  add("n4", "2026-11-30T23:59:00Z", { amount: 1 });
  add("y1", "2025-11-03T12:00:00Z", { amount: 100 });
  Order.as({ id: "eve", tenant: "evil" }).create({ id: "x1", org: "evil", owner: "eve", plan: "pro", amount: 999, created: T("2026-11-02T08:00:00Z") });
  const report = defineReport(Order, { time: "created", measures: { orders: { count: true }, revenue: { sum: "amount" }, avg: { avg: "amount" }, top: { max: "amount" } } });
  return { Order, report };
}

for (const driver of ["memory", "sqlite"] as const) {
  test(`${driver}: monthly totals in a time zone, compared with the month before`, () => {
    const { Order, report } = setup(driver);
    const r = report.run(Order.as(ada), { from: T("2026-11-01T00:00:00Z"), to: T("2026-12-01T00:00:00Z"), bucket: "month", compare: "previous" });
    assert.deepEqual(r.columns, ["orders", "revenue", "avg", "top"]);
    assert.deepEqual(r.buckets.map((b) => b.label), ["2026-11"]);
    assert.deepEqual(r.totals, { orders: 4, revenue: 71, avg: 71 / 3, top: 40 }, "eve's tenant is not counted; a null amount counts as an order only");
    assert.deepEqual(r.previousTotals, { orders: 3, revenue: 25, avg: 12.5, top: 20 }, "the 30 days before");
    assert.equal(r.change!.orders, 1 / 3);
    assert.equal(r.change!.revenue, (71 - 25) / 25);

    const p = report.run(Order.as(ada), { from: T("2026-10-31T23:00:00Z"), to: T("2026-11-30T23:00:00Z"), bucket: "month", timeZone: "Europe/Prague" });
    assert.deepEqual(p.buckets.map((b) => [b.label, b.values.orders]), [["2026-11", 4]]);
    assert.equal(p.totals.revenue, 5 + 30 + 40);
  });

  test(`${driver}: days and Monday weeks, empty buckets, the read rule`, () => {
    const { Order, report } = setup(driver);
    const days = report.run(Order.as(ada), { from: T("2026-11-01T00:00:00Z"), to: T("2026-11-04T00:00:00Z"), bucket: "day" });
    assert.deepEqual(days.buckets.map((b) => [b.label, b.values.orders, b.values.revenue, b.values.avg]), [
      ["2026-11-01", 0, 0, null],
      ["2026-11-02", 2, 30, 30],
      ["2026-11-03", 0, 0, null],
    ]);
    const weeks = report.run(Order.as(ada), { from: T("2026-11-01T00:00:00Z"), to: T("2026-12-01T00:00:00Z"), bucket: "week" });
    assert.deepEqual(weeks.buckets.map((b) => [b.label, b.values.orders]), [
      ["2026-10-26", 0],
      ["2026-11-02", 2],
      ["2026-11-09", 1],
      ["2026-11-16", 0],
      ["2026-11-23", 0],
      ["2026-11-30", 1],
    ]);
    const mine = report.run(Order.as(bob), { from: T("2026-11-01T00:00:00Z"), to: T("2026-12-01T00:00:00Z"), bucket: "month" });
    assert.deepEqual(mine.totals, { orders: 1, revenue: 40, avg: 40, top: 40 }, "bob counts only what he may read");
    const free = report.run(Order.as(ada), { from: T("2026-11-01T00:00:00Z"), to: T("2026-12-01T00:00:00Z"), bucket: "month", where: { plan: "free" } });
    assert.equal(free.totals.orders, 1);
  });

  test(`${driver}: split into series, year-over-year`, () => {
    const { Order } = setup(driver);
    const byPlan = defineReport(Order, { time: "created", measures: { orders: { count: true }, revenue: { sum: "amount" } }, split: "plan" });
    const r = byPlan.run(Order.as(ada), { from: T("2026-11-01T00:00:00Z"), to: T("2026-12-01T00:00:00Z"), bucket: "month", compare: "year" });
    assert.deepEqual(r.columns, ["orders:(none)", "orders:free", "orders:pro", "revenue:(none)", "revenue:free", "revenue:pro"]);
    assert.deepEqual(r.totals, { "orders:(none)": 1, "orders:free": 1, "orders:pro": 2, "revenue:(none)": 40, "revenue:free": 0, "revenue:pro": 31 });
    assert.deepEqual(r.previousTotals, { "orders:(none)": 0, "orders:free": 0, "orders:pro": 1, "revenue:(none)": 0, "revenue:free": 0, "revenue:pro": 100 });
    assert.equal(r.change!["revenue:pro"], -0.69);
    assert.equal(r.change!["orders:free"], null, "nothing to compare with");
    assert.deepEqual(r.buckets[0]!.previous!["orders:pro"], 1);
  });
}

test("chart rows and CSV", () => {
  const { Order, report } = setup("memory");
  const r = report.run(Order.as(ada), { from: T("2026-11-01T00:00:00Z"), to: T("2026-11-03T00:00:00Z"), bucket: "day", compare: "previous" });
  assert.deepEqual(reportRows(r, ["orders", "avg"], { previous: true }), [
    { label: "2026-11-01", orders: 0, "orders (previous)": 0, avg: 0, "avg (previous)": 0 },
    { label: "2026-11-02", orders: 2, "orders (previous)": 1, avg: 30, "avg (previous)": 5 },
  ]);
  assert.throws(() => reportRows(r, ["nope"]), /no column `nope`/);
  const csv = reportCsv(r);
  assert.equal(
    csv,
    "label,orders,revenue,avg,top,orders (previous),revenue (previous),avg (previous),top (previous)\r\n" +
      "2026-11-01,0,0,,,0,0,,\r\n" +
      "2026-11-02,2,30,30,30,1,5,5,5\r\n" +
      "Total,2,30,30,30,1,5,5,5\r\n",
  );
});

test("limits and arguments", () => {
  const { Order, report } = setup("memory");
  const small = defineReport(Order, { time: "created", measures: { n: { count: true } }, maxRows: 2 });
  assert.throws(() => small.run(Order.as(ada), { from: 0, to: T("2030-01-01T00:00:00Z"), bucket: "month" }), /more than 2 rows/);
  assert.throws(() => report.run(Order.as(ada), { from: 0, to: T("2026-01-01T00:00:00Z"), bucket: "day" }), /more than 1000 buckets/);
  assert.throws(() => report.run(Order.as(ada), { from: 5, to: 5, bucket: "day" }), /after `from`/);
  assert.throws(() => report.run(Order.as(ada), { from: 0, to: 5, bucket: "hour" as never }), /bucket is/);
  assert.throws(() => report.run(Order.as(ada), { from: 0, to: 5, bucket: "day", compare: "week" as never }), /compare is/);
  assert.throws(() => report.run(Order.as(ada), { from: 0, to: 5, bucket: "day", timeZone: "Mars/Olympus" }), /unknown time zone/);
  assert.throws(() => report.run(Order.as(ada), { from: "x" as never, to: 5, bucket: "day" }), /from is a time/);
  assert.throws(() => report.run(Order.as(ada), { from: 0, to: 5, bucket: "day", where: { nope: 1 } as never }), /nope/);
  const Other = defineModel<{ id: string }>("Other", { fields: { id: "string" }, read: () => true, write: () => true });
  assert.throws(() => report.run(Other.as(ada) as never, { from: 0, to: 5, bucket: "day" }), /pass Order.as/);
  const low = defineReport(Order, { time: "created", measures: { low: { min: "amount" } }, split: "plan" });
  const lr = low.run(Order.as(ada), { from: T("2026-11-01T00:00:00Z"), to: T("2026-12-01T00:00:00Z"), bucket: "week" });
  assert.deepEqual(lr.totals, { "low:(none)": 40, "low:free": null, "low:pro": 1 }, "min across weeks; none for no amounts");
  const Ev = defineModel<{ id: string; at: Date }>("Ev", { fields: { id: "string", at: "Date" }, read: () => true, write: () => true });
  Ev.as(ada).create({ id: "e", at: new Date("2026-11-02T00:00:00Z") });
  const er = defineReport(Ev, { time: "at", measures: { n: { count: true } } }).run(Ev.as(ada), { from: new Date("2026-11-01"), to: new Date("2026-11-03"), bucket: "day" });
  assert.deepEqual(er.buckets.map((b) => b.values.n), [0, 1]);
});

test("declarations", () => {
  const { Order } = setup("memory");
  const bad = (o: object, msg: RegExp) => assert.throws(() => defineReport(Order, o as never), msg);
  bad({ time: "nope", measures: { n: { count: true } } }, /no field `nope`/);
  bad({ time: "owner", measures: { n: { count: true } } }, /number of ms or a Date/);
  bad({ time: "created", measures: {} }, /no measures/);
  bad({ time: "created", measures: { "bad name": { count: true } } }, /identifiers/);
  bad({ time: "created", measures: { n: { count: true, sum: "amount" } } }, /one function/);
  bad({ time: "created", measures: { n: { count: 1 } } }, /count is true/);
  bad({ time: "created", measures: { n: { median: "amount" } } }, /median is not/);
  bad({ time: "created", measures: { n: { sum: "owner" } } }, /not a number/);
  bad({ time: "created", measures: { n: { sum: "nope" } } }, /no field `nope`/);
  bad({ time: "created", measures: { n: { count: true } }, split: "amount" }, /text or boolean/);
  bad({ time: "created", measures: { n: { count: true } }, maxRows: 0 }, /maxRows/);
  assert.throws(() => defineReport({} as never, { time: "x", measures: {} } as never), /needs a model/);
});
