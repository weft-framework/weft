import { test } from "node:test";
import assert from "node:assert/strict";
import { RANGE_PRESETS, rangeQuery, reportRange, shiftRange } from "../src/index.ts";

const NOW = Date.parse("2026-11-14T23:30:00Z");
const q = (s: string) => new URLSearchParams(s);

test("presets follow the calendar of the time zone", () => {
  const utc = reportRange(q(""), { now: NOW });
  assert.deepEqual([utc.range, utc.start, utc.end, utc.bucket, utc.timeZone], ["last30", "2026-10-16", "2026-11-14", "day", "UTC"]);
  assert.equal(utc.from, Date.parse("2026-10-16T00:00:00Z"));
  assert.equal(utc.to, Date.parse("2026-11-15T00:00:00Z"));
  assert.equal(utc.compare, undefined);

  const prague = reportRange(q("range=today"), { now: NOW, timeZone: "Europe/Prague" });
  assert.deepEqual([prague.start, prague.end], ["2026-11-15", "2026-11-15"]);
  assert.equal(prague.from, Date.parse("2026-11-14T23:00:00Z"), "midnight in Prague (UTC+1)");
  assert.equal(prague.to, Date.parse("2026-11-15T23:00:00Z"));

  const expect: Record<string, [string, string, string]> = {
    today: ["2026-11-14", "2026-11-14", "day"],
    last7: ["2026-11-08", "2026-11-14", "day"],
    last30: ["2026-10-16", "2026-11-14", "day"],
    last90: ["2026-08-17", "2026-11-14", "week"],
    thisMonth: ["2026-11-01", "2026-11-30", "day"],
    lastMonth: ["2026-10-01", "2026-10-31", "day"],
    thisYear: ["2026-01-01", "2026-12-31", "week"],
    lastYear: ["2025-01-01", "2025-12-31", "week"],
  };
  for (const p of RANGE_PRESETS) {
    const r = reportRange(q(`range=${p}`), { now: NOW });
    assert.deepEqual([r.start, r.end, r.bucket], expect[p], p);
  }
  const jan = reportRange(q("range=lastMonth"), { now: Date.parse("2027-01-10T12:00:00Z") });
  assert.deepEqual([jan.start, jan.end], ["2026-12-01", "2026-12-31"], "across a year");
});

test("days across a clock change keep local midnight", () => {
  const r = reportRange(q("range=custom&from=2026-10-24&to=2026-10-25"), { now: NOW, timeZone: "Europe/Prague" });
  assert.equal(r.from, Date.parse("2026-10-23T22:00:00Z"));
  assert.equal(r.to, Date.parse("2026-10-25T23:00:00Z"));
  const ny = reportRange(q("range=custom&from=2026-03-08&to=2026-03-08"), { now: NOW, timeZone: "America/New_York" });
  assert.equal(ny.from, Date.parse("2026-03-08T05:00:00Z"));
  assert.equal(ny.to, Date.parse("2026-03-09T04:00:00Z"));
  const cl = reportRange(q("range=custom&from=2026-09-06&to=2026-09-06"), { now: NOW, timeZone: "America/Santiago" });
  assert.equal(cl.from, Date.parse("2026-09-06T04:00:00Z"));
  assert.equal(cl.to, Date.parse("2026-09-07T03:00:00Z"));
});

test("custom ranges, buckets and comparisons; anything bad falls back", () => {
  const r = reportRange(q("range=custom&from=2026-01-01&to=2026-06-30&bucket=month&compare=year"), { now: NOW });
  assert.deepEqual([r.range, r.start, r.end, r.bucket, r.compare], ["custom", "2026-01-01", "2026-06-30", "month", "year"]);
  assert.equal(reportRange({ range: "custom", from: "2026-01-01", to: "2026-01-01" }, { now: NOW }).range, "custom", "a plain object");
  assert.equal(reportRange(new URL("https://a.example/?range=last7"), { now: NOW }).range, "last7", "a URL");

  for (const bad of [
    "range=custom&from=2026-02-30&to=2026-03-01",
    "range=custom&from=2026-03-02&to=2026-03-01",
    "range=custom&from=2026-3-1&to=2026-03-02",
    "range=custom&from=1969-12-31&to=1970-01-02",
    "range=custom&from=2020-01-01&to=2026-01-01",
    "range=custom&from=2026-01-01",
    "range=forever",
    "range=constructor",
    "range=__proto__",
  ]) {
    const x = reportRange(q(bad), { now: NOW });
    assert.deepEqual([x.range, x.start], ["last30", "2026-10-16"], bad);
  }
  assert.equal(reportRange(q("range=bogus"), { now: NOW, default: "thisMonth" }).range, "thisMonth");
  assert.equal(reportRange(q("range=last7&bucket=hour"), { now: NOW }).bucket, "day");
  assert.equal(reportRange(q("range=last7&compare=forever"), { now: NOW }).compare, undefined);
  assert.equal(reportRange(q("range=custom&from=2020-01-01&to=2022-12-31&bucket=day"), { now: NOW }).bucket, "month", "too many buckets");
  assert.equal(reportRange(q("range=custom&from=2020-01-01&to=2022-12-31&bucket=week"), { now: NOW }).bucket, "week");
  assert.equal(reportRange(q("range=custom&from=2020-01-01&to=2022-12-31"), { now: NOW, maxDays: 365 }).range, "last30");

  assert.throws(() => reportRange(q(""), { timeZone: "Mars/Olympus" }), /time zone/);
  assert.throws(() => reportRange(q(""), { default: "custom" as never }), /default/);
  assert.throws(() => reportRange(q(""), { maxDays: 0 }), /maxDays/);
});

test("links back, and shifting by whole periods", () => {
  const r = reportRange(q("range=lastMonth&compare=previous"), { now: NOW });
  assert.equal(rangeQuery(r), "range=lastMonth&bucket=day&compare=previous");
  assert.equal(rangeQuery(r, { bucket: "week", compare: undefined }), "range=lastMonth&bucket=week");
  const c = reportRange(q("range=custom&from=2026-11-01&to=2026-11-07"), { now: NOW });
  assert.equal(rangeQuery(c), "range=custom&from=2026-11-01&to=2026-11-07&bucket=day");
  assert.deepEqual(reportRange(q(rangeQuery(c)), { now: NOW }), c, "round trip");

  const before = shiftRange(r, -1);
  assert.deepEqual([before.range, before.start, before.end, before.compare], ["custom", "2026-09-01", "2026-09-30", "previous"]);
  assert.deepEqual([shiftRange(r, 1).start, shiftRange(r, 1).end], ["2026-11-01", "2026-11-30"]);
  const feb = shiftRange(reportRange(q("range=custom&from=2026-03-01&to=2026-03-31"), { now: NOW }), -1);
  assert.deepEqual([feb.start, feb.end], ["2026-02-01", "2026-02-28"], "whole months stay whole");
  const year = shiftRange(reportRange(q("range=lastYear"), { now: NOW }), -2);
  assert.deepEqual([year.start, year.end], ["2023-01-01", "2023-12-31"]);
  const week = shiftRange(c, -1);
  assert.deepEqual([week.start, week.end], ["2026-10-25", "2026-10-31"]);
  const z = shiftRange(reportRange(q("range=today"), { now: NOW, timeZone: "Europe/Prague" }), -1);
  assert.deepEqual([z.start, z.timeZone, z.from], ["2026-11-14", "Europe/Prague", Date.parse("2026-11-13T23:00:00Z")]);
  assert.throws(() => shiftRange(r, 0.5), /whole/);
});
