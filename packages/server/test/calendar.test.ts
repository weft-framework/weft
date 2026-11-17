import { test } from "node:test";
import assert from "node:assert/strict";
import { openSqlite } from "@weft/data/sqlite";
import type { PageContext } from "../src/context.ts";
import { createJobs } from "../src/jobs.ts";
import {
  availableSlots,
  defineBookings,
  MemoryBookingStore,
  occurrences,
  parseRecurrence,
  SqlBookingStore,
  wallTime,
  zonedTime,
  type Availability,
  type BookingStore,
} from "../src/calendar.ts";

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const NY = "America/New_York";

test("wall-clock times in a zone, across DST gaps and repeats", () => {
  assert.equal(iso(zonedTime("Europe/Prague", "2026-07-01", "09:00")), "2026-07-01T07:00");
  assert.equal(iso(zonedTime("Europe/Prague", "2026-12-01", "09:00")), "2026-12-01T08:00");
  assert.equal(iso(zonedTime(NY, "2026-03-08", "02:30")), "2026-03-08T07:30");
  assert.equal(wallTime(zonedTime(NY, "2026-03-08", "02:30"), NY).time, "03:30");
  assert.equal(iso(zonedTime(NY, "2026-11-01", "01:30")), "2026-11-01T05:30");
  assert.equal(iso(zonedTime("Asia/Kolkata", "2026-01-01", "00:00")), "2025-12-31T18:30");
  const w = wallTime(Date.UTC(2026, 10, 16, 12), "Asia/Tokyo");
  assert.deepEqual([w.date, w.time, w.weekday], ["2026-11-16", "21:00", 0]);
  assert.throws(() => zonedTime("Europe/Prague", "2026-02-30"), /not a date/);
});

test("recurring events", () => {
  const from = Date.UTC(2026, 0, 1);
  const to = Date.UTC(2027, 0, 1);
  const dates = (repeat: object, date = "2026-03-02", max = 1000) =>
    occurrences({ date, time: "09:00", duration: 60, timeZone: NY, repeat: repeat as never }, from, to, max).map((o) => o.date);

  const weekly = occurrences({ date: "2026-03-02", time: "09:00", duration: 30, timeZone: NY, repeat: parseRecurrence("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5") }, from, to);
  assert.deepEqual(weekly.map((o) => o.date), ["2026-03-02", "2026-03-04", "2026-03-09", "2026-03-11", "2026-03-16"]);
  assert.deepEqual(weekly.map((o) => wallTime(o.start, NY).time), ["09:00", "09:00", "09:00", "09:00", "09:00"]);
  assert.equal(weekly[0]!.end - weekly[0]!.start, 30 * 60_000);
  assert.equal(new Date(weekly[1]!.start).getUTCHours(), 14, "EST");
  assert.equal(new Date(weekly[2]!.start).getUTCHours(), 13, "EDT after the change");

  assert.deepEqual(dates({ freq: "daily", interval: 3, count: 4 }), ["2026-03-02", "2026-03-05", "2026-03-08", "2026-03-11"]);
  assert.deepEqual(dates({ freq: "weekly", interval: 2, count: 3 }), ["2026-03-02", "2026-03-16", "2026-03-30"]);
  assert.deepEqual(dates({ freq: "monthly", byDay: ["2TU"], count: 3 }), ["2026-03-10", "2026-04-14", "2026-05-12"]);
  assert.deepEqual(dates({ freq: "monthly", byDay: ["-1FR"], count: 2 }), ["2026-03-27", "2026-04-24"]);
  assert.deepEqual(dates({ freq: "monthly", count: 3 }, "2026-01-31"), ["2026-01-31", "2026-03-31", "2026-05-31"]);
  assert.deepEqual(dates({ freq: "monthly", byMonthDay: [-1], count: 3 }, "2026-01-31"), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  assert.deepEqual(dates({ freq: "yearly", count: 3 }, "2024-02-29").length, 0, "only leap years, none in 2026");
  assert.deepEqual(dates({ freq: "yearly", byMonth: [6, 12], byMonthDay: [1] }), ["2026-06-01", "2026-12-01"]);
  assert.deepEqual(dates({ freq: "daily", until: "2026-03-05", except: ["2026-03-03"] }), ["2026-03-02", "2026-03-04", "2026-03-05"]);
  assert.deepEqual(dates({ freq: "daily", count: 3, except: ["2026-03-03"] }), ["2026-03-02", "2026-03-04"]);
  const later = occurrences({ date: "2000-01-03", time: "09:00", duration: 60, timeZone: NY, repeat: { freq: "daily" } }, Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 4));
  assert.deepEqual(later.map((o) => o.date), ["2026-06-01", "2026-06-02", "2026-06-03"]);
  assert.equal(dates({ freq: "daily" }, "2026-01-01", 10).length, 10, "max");

  assert.deepEqual(parseRecurrence("RRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1,15;UNTIL=20261231T000000Z"), {
    freq: "monthly",
    interval: 2,
    byMonthDay: [1, 15],
    until: "2026-12-31",
  });
  assert.throws(() => parseRecurrence("FREQ=HOURLY"), /FREQ/);
  assert.throws(() => parseRecurrence("FREQ=WEEKLY;BYDAY=2MO"), /ordinals/);
  assert.throws(() => parseRecurrence("FREQ=DAILY;BYSETPOS=1"), /unsupported/);
  assert.throws(() => parseRecurrence("BYDAY=MO"), /FREQ/);
  assert.throws(() => occurrences({ date: "2026-01-01", time: "09:00", duration: 1, timeZone: "Mars/Base" }, 0, 1), /time zone/);
});

const clinic: Availability = {
  timeZone: "Europe/Prague",
  duration: 30,
  bufferAfter: 10,
  minNotice: 60,
  maxDaysAhead: 30,
  hours: { mon: [["09:00", "10:30"]], tue: [["13:00", "14:00"]] },
  dates: { "2026-11-24": [] },
};

test("open slots: hours, exceptions, notice, buffers, capacity", () => {
  const now = Date.UTC(2026, 10, 16, 7, 30);
  const week = { from: Date.UTC(2026, 10, 16), to: Date.UTC(2026, 10, 25), now };
  const times = (s: { start: number }[]) => s.map((x) => `${wallTime(x.start, "Europe/Prague").date} ${wallTime(x.start, "Europe/Prague").time}`);
  assert.deepEqual(times(availableSlots(clinic, week)), [
    "2026-11-16 09:30",
    "2026-11-16 10:00",
    "2026-11-17 13:00",
    "2026-11-17 13:30",
    "2026-11-23 09:00",
    "2026-11-23 09:30",
    "2026-11-23 10:00",
  ]);
  const busy = [{ start: Date.UTC(2026, 10, 23, 8, 30), end: Date.UTC(2026, 10, 23, 9, 10) }];
  assert.deepEqual(times(availableSlots(clinic, { ...week, busy })).filter((t) => t.startsWith("2026-11-23")), []);
  assert.deepEqual(
    times(availableSlots({ ...clinic, capacity: 2 }, { ...week, busy })).filter((t) => t.startsWith("2026-11-23")),
    ["2026-11-23 09:00", "2026-11-23 09:30", "2026-11-23 10:00"],
    "two at a time",
  );
  assert.equal(availableSlots({ ...clinic, step: 15 }, week).length, 11, "3 + 3 + 5 starts every 15 minutes");
  assert.deepEqual(availableSlots(clinic, { ...week, from: Date.UTC(2027, 0, 1), to: Date.UTC(2027, 0, 9) }), [], "beyond maxDaysAhead");
  const ny: Availability = { timeZone: NY, duration: 60, hours: { sun: [["01:00", "04:00"]] } };
  const dst = availableSlots(ny, { from: Date.UTC(2026, 2, 8), to: Date.UTC(2026, 2, 9), now: Date.UTC(2026, 2, 1) });
  assert.deepEqual(dst.map((s) => wallTime(s.start, NY).time), ["01:00", "03:00"], "02:00 does not exist that night");
  assert.throws(() => availableSlots({ ...clinic, hours: { mon: [["10:00", "09:00"]] } }, week), /pair/);
  assert.throws(() => availableSlots({ ...clinic, hours: { monday: [] } as never }, week), /weekday/);
});

function ctx(user: string | null): PageContext {
  const url = new URL("http://app.test/book");
  return { request: new Request(url), url, params: {}, query: url.searchParams, session: "s", user: user ? { id: user } : null };
}

async function bookingSuite(store: BookingStore) {
  let clock = Date.UTC(2026, 10, 16, 7, 30);
  const sent: string[] = [];
  const bookings = defineBookings({
    name: "consult",
    store,
    resource: (id) => (id === "dr" ? clinic : null),
    manage: (c, id) => id === "dr" && (c.user as { id: string } | null)?.id === "dr",
    changeUntil: 120,
    reminders: { before: [24 * 60, 60], send: (job, b, m) => void sent.push(`${(job.user as { id: string }).id} ${b.id} ${m}`) },
    now: () => clock,
  });
  const jobs = createJobs({ jobs: [bookings.job], now: () => clock });
  bookings.use(jobs);
  const ada = ctx("ada");
  const bo = ctx("bo");

  const slots = await bookings.slots(ada, "dr", { from: Date.UTC(2026, 10, 23), to: Date.UTC(2026, 10, 24) });
  assert.equal(slots.length, 3);
  const first = slots[0]!.start;
  const r = await bookings.book(ada, "dr", first, { note: "knee" });
  assert.ok(r.ok);
  const id = r.booking.id;
  assert.equal(r.booking.reminders.length, 2);

  assert.deepEqual(await bookings.book(bo, "dr", first), { ok: false, reason: "unavailable" });
  assert.deepEqual(await bookings.book(bo, "dr", first + 60_000), { ok: false, reason: "unavailable" }, "not an offered start");
  assert.deepEqual(await bookings.book(bo, "dr", Date.UTC(2026, 10, 23, 13)), { ok: false, reason: "unavailable" }, "outside the hours");
  assert.deepEqual(await bookings.book(ctx(null), "dr", first), { ok: false, reason: "forbidden" });
  assert.deepEqual(await bookings.book(bo, "nobody", first), { ok: false, reason: "not-found" });
  const left = await bookings.slots(bo, "dr", { from: Date.UTC(2026, 10, 23), to: Date.UTC(2026, 10, 24) });
  assert.equal(left.length, 1, "09:30 falls in 09:00-09:40 (buffer); 10:00 stays");
  assert.doesNotMatch(JSON.stringify(left), /ada|knee/, "slots show times only");

  const last = left[0]!.start;
  const race = await Promise.all([bookings.book(bo, "dr", last), bookings.book(ctx("cy"), "dr", last)]);
  assert.deepEqual(race.map((x) => x.ok).sort(), [false, true]);

  assert.equal(await bookings.get(bo, id), null);
  assert.deepEqual(await bookings.cancel(bo, id), { ok: false, reason: "not-found" });
  assert.equal((await bookings.get(ctx("dr"), id))!.note, "knee");
  assert.equal((await bookings.forResource(ctx("dr"), "dr", { from: 0, to: Infinity }))!.length, 2);
  assert.equal(await bookings.forResource(bo, "dr", { from: 0, to: Infinity }), null);
  assert.deepEqual((await bookings.mine(ada, { from: 0, to: Infinity })).map((b) => b.id), [id]);

  clock = first - 24 * 3600_000 + 1000;
  await jobs.drain();
  assert.deepEqual(sent.filter((x) => x.startsWith("ada ")), [`ada ${id} 1440`]);

  const tue = (await bookings.slots(ada, "dr", { from: Date.UTC(2026, 10, 17), to: Date.UTC(2026, 10, 18) }))[0];
  assert.equal(tue, undefined, "Tuesday the 17th is in the past now");
  const free = (await bookings.slots(ada, "dr", { from: Date.UTC(2026, 10, 30), to: Date.UTC(2026, 11, 1) }))[0]!;
  const moved = await bookings.reschedule(ada, id, free.start);
  assert.ok(moved.ok);
  assert.equal(moved.booking.start, free.start);
  clock = first - 3600_000 + 1000;
  await jobs.drain();
  assert.deepEqual(sent.filter((x) => x.startsWith("ada ")), [`ada ${id} 1440`], "the old reminder was cancelled");
  const held = (await bookings.forResource(ctx("dr"), "dr", { from: 0, to: Infinity }))!;
  assert.ok(held.every((b) => b.start !== first) && held.some((b) => b.start === free.start), "the old time is free");

  clock = free.start - 3600_000;
  assert.deepEqual(await bookings.cancel(ada, id), { ok: false, reason: "too-late" });
  const before = (await jobs.counts()).cancelled;
  const c = await bookings.cancel(ctx("dr"), id);
  assert.ok(c.ok && c.booking.status === "cancelled");
  assert.equal((await jobs.counts()).cancelled, before + 2, "both queued reminders are cancelled");
  await jobs.drain();
  assert.deepEqual(sent.filter((x) => x.startsWith("ada ")), [`ada ${id} 1440`], "no reminder for a cancelled booking");
  assert.deepEqual(await bookings.reschedule(ada, id, free.start), { ok: false, reason: "not-found" });
}

test("bookings in memory", async () => {
  await bookingSuite(new MemoryBookingStore());
});

test("bookings in SQLite", async () => {
  const db = openSqlite(":memory:");
  await bookingSuite(new SqlBookingStore(db));
  const store = new SqlBookingStore(db, "raw");
  const b = { id: "a", resource: "r", owner: "u", start: 10, end: 20, blockStart: 10, blockEnd: 25, status: "active" as const, note: "", created: 0, reminders: [] };
  assert.equal(store.insert(b, 1), true);
  assert.equal(store.insert({ ...b, id: "b", start: 24, end: 30, blockStart: 24, blockEnd: 30 }, 1), false);
  assert.equal(store.insert({ ...b, id: "c", start: 25, end: 30, blockStart: 25, blockEnd: 30 }, 1), true, "touching is fine");
  assert.equal(store.move("c", { start: 15, end: 20, blockStart: 15, blockEnd: 20 }, 1), false);
  assert.equal(store.move("c", { start: 26, end: 31, blockStart: 26, blockEnd: 31 }, 1), true, "itself not counted");
});
