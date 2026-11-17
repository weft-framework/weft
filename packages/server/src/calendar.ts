import type { SqlDatabase } from "@weft-framework/data";
import type { PageContext } from "./context.ts";
import type { Job, JobContext, Jobs } from "./jobs.ts";
import { defineJob } from "./jobs.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(tz, f);
  }
  return f;
}

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz === "" || tz.length > 64) return false;
  try {
    format(tz);
    return true;
  } catch {
    return false;
  }
}

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  date: string;
  time: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function dayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
}

function fromDayNumber(n: number): { year: number; month: number; day: number } {
  const d = new Date(n * DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const weekdayOf = (n: number) => (((n + 3) % 7) + 7) % 7;
const dateOf = (n: number) => {
  const d = fromDayNumber(n);
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
};

export function wallTime(ms: number, tz: string): WallTime {
  const parts: Record<string, number> = {};
  for (const p of format(tz).formatToParts(new Date(ms))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  const { year, month, day, hour, minute } = parts as Record<string, number>;
  return {
    year: year!,
    month: month!,
    day: day!,
    hour: hour!,
    minute: minute!,
    weekday: weekdayOf(dayNumber(year!, month!, day!)),
    date: `${pad(year!, 4)}-${pad(month!)}-${pad(day!)}`,
    time: `${pad(hour!)}:${pad(minute!)}`,
  };
}

function offsetAt(ms: number, tz: string): number {
  const t = Math.floor(ms / 1000) * 1000;
  const parts: Record<string, number> = {};
  for (const p of format(tz).formatToParts(new Date(t))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - t;
}

export function zonedTime(tz: string, date: string, time = "00:00"): number {
  const d = DATE.exec(date);
  const t = TIME.exec(time);
  if (!d || !validDate(date) || !t) throw new RangeError(`not a date and time: ${date} ${time}`);
  const guess = Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!, +t[1]!, +t[2]!);
  const before = offsetAt(guess - DAY / 2, tz);
  const after = offsetAt(guess + DAY / 2, tz);
  const a = guess - before;
  const b = guess - after;
  const matches = (ms: number) => ms + offsetAt(ms, tz) === guess;
  return matches(a) || !matches(b) ? a : b;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-4]):([0-5]\d)$/;

function validDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const v = fromDayNumber(dayNumber(+m[1]!, +m[2]!, +m[3]!));
  return v.year === +m[1]! && v.month === +m[2]! && v.day === +m[3]!;
}

function dayOfDate(s: string): number {
  const m = DATE.exec(s)!;
  return dayNumber(+m[1]!, +m[2]!, +m[3]!);
}

const minutesOf = (time: string) => {
  const t = TIME.exec(time)!;
  return +t[1]! * 60 + +t[2]!;
};

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Recurrence {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  count?: number;
  until?: string;
  byDay?: readonly string[];
  byMonthDay?: readonly number[];
  byMonth?: readonly number[];
  except?: readonly string[];
}

export interface EventTime {
  date: string;
  time: string;
  duration: number;
  timeZone: string;
  repeat?: Recurrence;
}

export interface Occurrence {
  start: number;
  end: number;
  date: string;
}

const BYDAY = /^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/;

export function parseRecurrence(text: string): Recurrence {
  const r: { -readonly [K in keyof Recurrence]: Recurrence[K] } = { freq: "daily" };
  let freq = false;
  for (const part of text.replace(/^RRULE:/i, "").split(";")) {
    if (part === "") continue;
    const [k, v = ""] = part.split("=", 2) as [string, string?];
    const list = () => v.split(",").filter(Boolean);
    const nums = () => list().map((x) => (/^[+-]?\d{1,2}$/.test(x) ? Number(x) : NaN));
    switch (k.toUpperCase()) {
      case "FREQ":
        if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(v.toUpperCase())) throw new RangeError(`unsupported FREQ ${v}`);
        r.freq = v.toLowerCase() as Recurrence["freq"];
        freq = true;
        break;
      case "INTERVAL":
        r.interval = Number(v);
        break;
      case "COUNT":
        r.count = Number(v);
        break;
      case "UNTIL": {
        const m = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(v);
        if (!m) throw new RangeError(`bad UNTIL ${v}`);
        r.until = `${m[1]}-${m[2]}-${m[3]}`;
        break;
      }
      case "BYDAY":
        r.byDay = list().map((x) => x.toUpperCase());
        break;
      case "BYMONTHDAY":
        r.byMonthDay = nums();
        break;
      case "BYMONTH":
        r.byMonth = nums();
        break;
      case "WKST":
        if (v.toUpperCase() !== "MO") throw new RangeError("only WKST=MO");
        break;
      default:
        throw new RangeError(`unsupported rule part ${k}`);
    }
  }
  if (!freq) throw new RangeError("a rule needs FREQ");
  checkRecurrence(r);
  return r;
}

function checkRecurrence(r: Recurrence): void {
  if (!["daily", "weekly", "monthly", "yearly"].includes(r.freq)) throw new RangeError("freq is daily, weekly, monthly or yearly");
  if (r.interval !== undefined && (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 1000)) throw new RangeError("interval is 1 to 1000");
  if (r.count !== undefined && (!Number.isInteger(r.count) || r.count < 1 || r.count > 10_000)) throw new RangeError("count is 1 to 10000");
  if (r.until !== undefined && !validDate(r.until)) throw new RangeError("until is a YYYY-MM-DD date");
  for (const d of r.byDay ?? []) {
    const m = BYDAY.exec(d);
    if (!m) throw new RangeError(`bad weekday ${d}`);
    if (m[1] && (r.freq === "daily" || r.freq === "weekly")) throw new RangeError(`${d}: ordinals only for monthly and yearly`);
  }
  for (const d of r.byMonthDay ?? []) if (!Number.isInteger(d) || d === 0 || d < -31 || d > 31) throw new RangeError(`bad month day ${d}`);
  for (const m of r.byMonth ?? []) if (!Number.isInteger(m) || m < 1 || m > 12) throw new RangeError(`bad month ${m}`);
  for (const d of r.except ?? []) if (!validDate(d)) throw new RangeError(`bad exception date ${d}`);
}

function monthDays(y: number, m: number, r: Recurrence, firstDay: number): number[] {
  const start = dayNumber(y, m, 1);
  const length = dayNumber(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - start;
  const out = new Set<number>();
  for (const md of r.byMonthDay ?? []) {
    const d = md > 0 ? md : length + 1 + md;
    if (d >= 1 && d <= length) out.add(start + d - 1);
  }
  for (const spec of r.byDay ?? []) {
    const [, ord, wd] = BYDAY.exec(spec)!;
    const want = WEEKDAYS.indexOf(wd as Weekday);
    const all: number[] = [];
    for (let i = 0; i < length; i++) if (weekdayOf(start + i) === want) all.push(start + i);
    if (!ord) all.forEach((x) => out.add(x));
    else {
      const n = Number(ord);
      const pick = n > 0 ? all[n - 1] : all[all.length + n];
      if (pick !== undefined) out.add(pick);
    }
  }
  if (!r.byMonthDay?.length && !r.byDay?.length) {
    const d = fromDayNumber(firstDay).day;
    if (d <= length) out.add(start + d - 1);
  }
  return [...out].sort((a, b) => a - b);
}

export function occurrences(e: EventTime, from: number, to: number, max = 1000): Occurrence[] {
  if (!isTimeZone(e.timeZone)) throw new RangeError(`unknown time zone ${String(e.timeZone)}`);
  if (!validDate(e.date) || !TIME.exec(e.time) || e.time === "24:00") throw new RangeError("date is YYYY-MM-DD and time HH:MM");
  if (!Number.isInteger(e.duration) || e.duration < 0 || e.duration > 366 * 24 * 60) throw new RangeError("duration is whole minutes");
  const out: Occurrence[] = [];
  const at = (day: number): Occurrence => {
    const date = dateOf(day);
    const start = zonedTime(e.timeZone, date, e.time);
    return { start, end: start + e.duration * MINUTE, date };
  };
  const first = dayOfDate(e.date);
  const r = e.repeat;
  if (!r) {
    const o = at(first);
    return o.start >= from && o.start < to && max > 0 ? [o] : [];
  }
  checkRecurrence(r);
  const interval = r.interval ?? 1;
  const until = r.until ? dayOfDate(r.until) : Infinity;
  const except = new Set(r.except ?? []);
  const fromDay = Math.floor(from / DAY) - 2;
  const toDay = Math.floor(to / DAY) + 2;
  let seen = 0;
  const take = (day: number): boolean => {
    if (day < first) return true;
    if (day > until || day > toDay) return false;
    seen++;
    if (r.count !== undefined && seen > r.count) return false;
    if (day >= fromDay && !except.has(dateOf(day))) {
      const o = at(day);
      if (o.start >= from && o.start < to) out.push(o);
    }
    return out.length < max;
  };
  const f = fromDayNumber(first);
  for (let period = 0; period < 200_000; period++) {
    let days: number[];
    if (r.freq === "daily") {
      const day = first + period * interval;
      if (r.count === undefined && day < fromDay - interval) {
        period = Math.max(period, Math.floor((fromDay - first) / interval) - 1);
        continue;
      }
      const wd = WEEKDAYS[weekdayOf(day)]!;
      const { month, day: md } = fromDayNumber(day);
      const ok =
        (!r.byDay?.length || r.byDay.includes(wd)) &&
        (!r.byMonth?.length || r.byMonth.includes(month)) &&
        (!r.byMonthDay?.length || r.byMonthDay.some((x) => x === md));
      days = ok ? [day] : [];
      if (day > until || day > toDay) break;
    } else if (r.freq === "weekly") {
      const monday = first - weekdayOf(first) + period * 7 * interval;
      if (monday > until || monday > toDay) break;
      if (r.count === undefined && monday + 7 < fromDay) continue;
      const picks = r.byDay?.length ? r.byDay.map((d) => WEEKDAYS.indexOf(d as Weekday)) : [weekdayOf(first)];
      days = [...new Set(picks)].sort((a, b) => a - b).map((i) => monday + i);
    } else if (r.freq === "monthly") {
      const index = f.year * 12 + (f.month - 1) + period * interval;
      const y = Math.floor(index / 12);
      const m = (index % 12) + 1;
      if (dayNumber(y, m, 1) > until || dayNumber(y, m, 1) > toDay) break;
      if (r.count === undefined && dayNumber(y, m, 1) + 31 < fromDay) continue;
      days = r.byMonth?.length && !r.byMonth.includes(m) ? [] : monthDays(y, m, r, first);
    } else {
      const y = f.year + period * interval;
      if (dayNumber(y, 1, 1) > until || dayNumber(y, 1, 1) > toDay) break;
      if (r.count === undefined && dayNumber(y, 12, 31) < fromDay) continue;
      days = [];
      for (const m of r.byMonth?.length ? [...r.byMonth].sort((a, b) => a - b) : [f.month]) {
        const picks = monthDays(y, m, r.byDay?.length || r.byMonthDay?.length ? r : { ...r, byMonthDay: [f.day] }, first);
        days.push(...picks);
      }
    }
    for (const day of days) if (!take(day)) return out;
  }
  return out;
}

type Ranges = readonly (readonly [string, string])[];
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export interface Availability {
  timeZone: string;
  hours: Partial<Record<(typeof DAY_KEYS)[number], Ranges>>;
  dates?: Readonly<Record<string, Ranges>>;
  duration: number;
  step?: number;
  bufferBefore?: number;
  bufferAfter?: number;
  minNotice?: number;
  maxDaysAhead?: number;
  capacity?: number;
}

export interface Slot {
  start: number;
  end: number;
}

export interface Busy {
  start: number;
  end: number;
}

function checkRanges(r: unknown, where: string): Ranges {
  if (!Array.isArray(r)) throw new RangeError(`${where}: hours are [from, to] pairs`);
  for (const p of r) {
    if (!Array.isArray(p) || p.length !== 2 || !TIME.test(p[0]) || !TIME.test(p[1]) || minutesOf(p[0]) >= minutesOf(p[1])) {
      throw new RangeError(`${where}: ${JSON.stringify(p)} is not a [from, to] pair of HH:MM`);
    }
  }
  return r as Ranges;
}

export function checkAvailability(a: Availability): Required<Omit<Availability, "dates">> & Pick<Availability, "dates"> {
  if (!isTimeZone(a.timeZone)) throw new RangeError(`unknown time zone ${String(a.timeZone)}`);
  for (const k of Object.keys(a.hours ?? {})) {
    if (!DAY_KEYS.includes(k as never)) throw new RangeError(`hours: ${k} is not a weekday (mon..sun)`);
    checkRanges(a.hours[k as (typeof DAY_KEYS)[number]], `hours.${k}`);
  }
  for (const [d, r] of Object.entries(a.dates ?? {})) {
    if (!validDate(d)) throw new RangeError(`dates: ${d} is not YYYY-MM-DD`);
    checkRanges(r, `dates.${d}`);
  }
  const whole = (v: number | undefined, dflt: number, lo: number, hi: number, what: string) => {
    const x = v ?? dflt;
    if (!Number.isInteger(x) || x < lo || x > hi) throw new RangeError(`${what} is ${lo} to ${hi}`);
    return x;
  };
  const duration = whole(a.duration, 0, 1, 24 * 60, "duration");
  return {
    timeZone: a.timeZone,
    hours: a.hours ?? {},
    dates: a.dates,
    duration,
    step: whole(a.step, duration, 1, 24 * 60, "step"),
    bufferBefore: whole(a.bufferBefore, 0, 0, 24 * 60, "bufferBefore"),
    bufferAfter: whole(a.bufferAfter, 0, 0, 24 * 60, "bufferAfter"),
    minNotice: whole(a.minNotice, 0, 0, 366 * 24 * 60, "minNotice"),
    maxDaysAhead: whole(a.maxDaysAhead, 90, 1, 3660, "maxDaysAhead"),
    capacity: whole(a.capacity, 1, 1, 10_000, "capacity"),
  };
}

export function availableSlots(a: Availability, o: { from: number; to: number; now: number; busy?: readonly Busy[]; max?: number }): Slot[] {
  const c = checkAvailability(a);
  const max = o.max ?? 2000;
  const earliest = o.now + c.minNotice * MINUTE;
  const latest = o.now + c.maxDaysAhead * DAY;
  const from = Math.max(o.from, earliest);
  const to = Math.min(o.to, latest);
  const out: Slot[] = [];
  if (from >= to) return out;
  const busy = [...(o.busy ?? [])].sort((x, y) => x.start - y.start);
  const firstDay = dayOfDate(wallTime(from, c.timeZone).date);
  const lastDay = dayOfDate(wallTime(to, c.timeZone).date);
  for (let day = firstDay; day <= lastDay && out.length < max; day++) {
    const date = dateOf(day);
    const ranges = c.dates && Object.hasOwn(c.dates, date) ? c.dates[date]! : (c.hours[DAY_KEYS[weekdayOf(day)]!] ?? []);
    for (const [a1, b1] of ranges) {
      for (let m = minutesOf(a1); m + c.duration <= minutesOf(b1); m += c.step) {
        const wall = (mins: number) =>
          mins >= 24 * 60 ? zonedTime(c.timeZone, dateOf(day + 1), `${pad(Math.floor((mins - 1440) / 60))}:${pad(mins % 60)}`) : zonedTime(c.timeZone, date, `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`);
        const start = wall(m);
        const end = start + c.duration * MINUTE;
        if (start < from || start >= to) continue;
        if (out.length && out.at(-1)!.start >= start) continue;
        const blockStart = start - c.bufferBefore * MINUTE;
        const blockEnd = end + c.bufferAfter * MINUTE;
        let overlapping = 0;
        for (const b of busy) {
          if (b.start >= blockEnd) break;
          if (b.end > blockStart) overlapping++;
        }
        if (overlapping >= c.capacity) continue;
        out.push({ start, end });
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

export interface Booking {
  id: string;
  resource: string;
  owner: string;
  start: number;
  end: number;
  blockStart: number;
  blockEnd: number;
  status: "active" | "cancelled";
  note: string;
  created: number;
  reminders: string[];
}

export interface BookingStore {
  insert(b: Booking, capacity: number): boolean | Promise<boolean>;
  get(id: string): Booking | null | Promise<Booking | null>;
  move(id: string, to: Pick<Booking, "start" | "end" | "blockStart" | "blockEnd">, capacity: number): boolean | Promise<boolean>;
  update(id: string, patch: Partial<Pick<Booking, "status" | "reminders">>): void | Promise<void>;
  overlapping(resource: string, from: number, to: number): Booking[] | Promise<Booking[]>;
  byOwner(owner: string, from: number, to: number): Booking[] | Promise<Booking[]>;
}

export interface BookingsOptions {
  name: string;
  store: BookingStore;
  resource(id: string, ctx: PageContext | null): Availability | null | Promise<Availability | null>;
  allow?(ctx: PageContext, resource: string): boolean | Promise<boolean>;
  manage?(ctx: PageContext, resource: string): boolean | Promise<boolean>;
  changeUntil?: number;
  reminders?: { before: readonly number[]; send(job: JobContext, booking: Booking, minutesBefore: number): unknown };
  now?(): number;
}

export type BookResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: "not-found" | "forbidden" | "unavailable" | "too-late" | "invalid" };

export interface Bookings {
  readonly name: string;
  readonly job: Job<[string, number]>;
  use(jobs: Jobs): this;
  slots(ctx: PageContext | null, resource: string, range: { from: number; to: number }): Promise<Slot[]>;
  book(ctx: PageContext, resource: string, start: number, o?: { note?: string }): Promise<BookResult>;
  cancel(ctx: PageContext, id: string): Promise<BookResult>;
  reschedule(ctx: PageContext, id: string, start: number): Promise<BookResult>;
  mine(ctx: PageContext, range: { from: number; to: number }): Promise<Booking[]>;
  forResource(ctx: PageContext, resource: string, range: { from: number; to: number }): Promise<Booking[] | null>;
  get(ctx: PageContext, id: string): Promise<Booking | null>;
}

const userId = (ctx: PageContext | null): string | null => {
  const u = ctx?.user as { id?: unknown } | null | undefined;
  return u && (typeof u.id === "string" || typeof u.id === "number") ? String(u.id) : null;
};

export function defineBookings(o: BookingsOptions): Bookings {
  if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(o.name)) throw new Error("defineBookings: name is letters and digits");
  for (const m of o.reminders?.before ?? []) {
    if (!Number.isInteger(m) || m < 1 || m > 60 * 24 * 60) throw new Error("defineBookings: reminders are 1 minute to 60 days before");
  }
  const now = o.now ?? Date.now;
  const changeUntil = o.changeUntil ?? 0;
  let jobs: Jobs | null = null;
  const store = o.store;

  const job = defineJob<[string, number]>(
    `${o.name}Reminder`,
    [
      { name: "id", type: "string" },
      { name: "minutes", type: "number" },
    ],
    async (jctx, id, minutes) => {
      const b = await store.get(id);
      if (!b || b.status !== "active" || b.start - minutes * MINUTE > now() + MINUTE) return;
      if (userId({ user: jctx.user } as PageContext) !== b.owner) return;
      await o.reminders?.send(jctx, b, minutes);
    },
    { attempts: 3 },
  );

  const remind = async (ctx: PageContext, b: Booking): Promise<string[]> => {
    if (!o.reminders || !jobs) return [];
    const ids: string[] = [];
    for (const m of o.reminders.before) {
      const at = b.start - m * MINUTE;
      if (at <= now()) continue;
      const id = await jobs.enqueue(ctx, job as Job<never>, { id: b.id, minutes: m }, { runAt: at, as: { user: b.owner } });
      if (id) ids.push(id);
    }
    return ids;
  };
  const unremind = async (b: Booking) => {
    for (const id of b.reminders) await jobs?.cancel(id).catch(() => false);
  };

  const scheduleOf = async (ctx: PageContext | null, resource: string) => {
    if (typeof resource !== "string" || resource === "" || resource.length > 200) return null;
    const a = await o.resource(resource, ctx);
    return a ? checkAvailability(a) : null;
  };

  const isSlot = (a: Availability, start: number) =>
    availableSlots(a, { from: start, to: start + 1, now: now() }).some((s) => s.start === start);

  const mayManage = async (ctx: PageContext, resource: string) => (o.manage ? await o.manage(ctx, resource) : false);

  const visible = async (ctx: PageContext, id: string) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
    const b = await store.get(id);
    if (!b) return null;
    const me = userId(ctx);
    if (me !== null && b.owner === me) return { b, staff: false };
    return (await mayManage(ctx, b.resource)) ? { b, staff: true } : null;
  };

  const self: Bookings = {
    name: o.name,
    job,
    use(j) {
      jobs = j;
      return this;
    },

    async slots(ctx, resource, range) {
      const a = await scheduleOf(ctx, resource);
      if (!a || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return [];
      const to = Math.min(range.to, range.from + 62 * DAY);
      const busy = await store.overlapping(resource, range.from - DAY, to + DAY);
      return availableSlots(a, { from: range.from, to, now: now(), busy: busy.map((b) => ({ start: b.blockStart, end: b.blockEnd })) });
    },

    async book(ctx, resource, start, opts = {}) {
      const me = userId(ctx);
      if (me === null) return { ok: false, reason: "forbidden" };
      const a = await scheduleOf(ctx, resource);
      if (!a) return { ok: false, reason: "not-found" };
      if (o.allow && !(await o.allow(ctx, resource))) return { ok: false, reason: "forbidden" };
      const note = opts.note ?? "";
      if (typeof note !== "string" || note.length > 2000) return { ok: false, reason: "invalid" };
      if (!Number.isInteger(start) || !isSlot(a, start)) return { ok: false, reason: "unavailable" };
      const c = checkAvailability(a);
      const end = start + c.duration * MINUTE;
      const b: Booking = {
        id: `${o.name.toLowerCase()}_${crypto.randomUUID().replace(/-/g, "")}`,
        resource,
        owner: me,
        start,
        end,
        blockStart: start - c.bufferBefore * MINUTE,
        blockEnd: end + c.bufferAfter * MINUTE,
        status: "active",
        note,
        created: now(),
        reminders: [],
      };
      if (!(await store.insert(b, c.capacity))) return { ok: false, reason: "unavailable" };
      const reminders = await remind(ctx, b);
      if (reminders.length) {
        b.reminders = reminders;
        await store.update(b.id, { reminders });
      }
      return { ok: true, booking: b };
    },

    async cancel(ctx, id) {
      const v = await visible(ctx, id);
      if (!v) return { ok: false, reason: "not-found" };
      const { b, staff } = v;
      if (b.status !== "active") return { ok: true, booking: b };
      if (!staff && b.start - changeUntil * MINUTE <= now()) return { ok: false, reason: "too-late" };
      await store.update(b.id, { status: "cancelled", reminders: [] });
      await unremind(b);
      return { ok: true, booking: { ...b, status: "cancelled", reminders: [] } };
    },

    async reschedule(ctx, id, start) {
      const v = await visible(ctx, id);
      if (!v) return { ok: false, reason: "not-found" };
      const { b, staff } = v;
      if (b.status !== "active") return { ok: false, reason: "not-found" };
      if (!staff && b.start - changeUntil * MINUTE <= now()) return { ok: false, reason: "too-late" };
      const a = await scheduleOf(ctx, b.resource);
      if (!a) return { ok: false, reason: "not-found" };
      if (!Number.isInteger(start) || !isSlot(a, start)) return { ok: false, reason: "unavailable" };
      const c = checkAvailability(a);
      const end = start + c.duration * MINUTE;
      const to = { start, end, blockStart: start - c.bufferBefore * MINUTE, blockEnd: end + c.bufferAfter * MINUTE };
      if (!(await store.move(b.id, to, c.capacity))) return { ok: false, reason: "unavailable" };
      await unremind(b);
      const moved: Booking = { ...b, ...to, reminders: [] };
      moved.reminders = await remind(ctx, moved);
      await store.update(b.id, { reminders: moved.reminders });
      return { ok: true, booking: moved };
    },

    async mine(ctx, range) {
      const me = userId(ctx);
      return me === null ? [] : await store.byOwner(me, range.from, range.to);
    },

    async forResource(ctx, resource, range) {
      if (!(await mayManage(ctx, resource))) return null;
      return await store.overlapping(resource, range.from, range.to);
    },

    async get(ctx, id) {
      return (await visible(ctx, id))?.b ?? null;
    },
  };
  return self;
}

export class MemoryBookingStore implements BookingStore {
  private readonly rows = new Map<string, Booking>();

  private count(resource: string, blockStart: number, blockEnd: number, except?: string): number {
    let n = 0;
    for (const b of this.rows.values()) {
      if (b.resource === resource && b.status === "active" && b.id !== except && b.blockStart < blockEnd && b.blockEnd > blockStart) n++;
    }
    return n;
  }

  insert(b: Booking, capacity: number): boolean {
    if (this.count(b.resource, b.blockStart, b.blockEnd) >= capacity) return false;
    this.rows.set(b.id, structuredClone(b));
    return true;
  }

  get(id: string): Booking | null {
    const b = this.rows.get(id);
    return b ? structuredClone(b) : null;
  }

  move(id: string, to: Pick<Booking, "start" | "end" | "blockStart" | "blockEnd">, capacity: number): boolean {
    const b = this.rows.get(id);
    if (!b || b.status !== "active" || this.count(b.resource, to.blockStart, to.blockEnd, id) >= capacity) return false;
    Object.assign(b, to);
    return true;
  }

  update(id: string, patch: Partial<Pick<Booking, "status" | "reminders">>): void {
    const b = this.rows.get(id);
    if (b) Object.assign(b, structuredClone(patch));
  }

  overlapping(resource: string, from: number, to: number): Booking[] {
    return [...this.rows.values()]
      .filter((b) => b.resource === resource && b.status === "active" && b.blockStart < to && b.blockEnd > from)
      .sort((x, y) => x.start - y.start)
      .map((b) => structuredClone(b));
  }

  byOwner(owner: string, from: number, to: number): Booking[] {
    return [...this.rows.values()]
      .filter((b) => b.owner === owner && b.end > from && b.start < to)
      .sort((x, y) => x.start - y.start)
      .map((b) => structuredClone(b));
  }
}

export class SqlBookingStore implements BookingStore {
  private readonly db: SqlDatabase;
  private readonly t: string;

  constructor(db: SqlDatabase, table = "weft_bookings") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`SqlBookingStore: bad table name ${table}`);
    this.db = db;
    this.t = table;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, resource TEXT NOT NULL, owner TEXT NOT NULL, ` +
        `start INTEGER NOT NULL, "end" INTEGER NOT NULL, block_start INTEGER NOT NULL, block_end INTEGER NOT NULL, ` +
        `status TEXT NOT NULL, note TEXT NOT NULL, created INTEGER NOT NULL, reminders TEXT NOT NULL)`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_resource ON ${table} (resource, status, block_start)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_owner ON ${table} (owner, start)`);
  }

  private row(r: unknown): Booking {
    const o = r as Record<string, unknown>;
    return {
      id: String(o.id),
      resource: String(o.resource),
      owner: String(o.owner),
      start: Number(o.start),
      end: Number(o.end),
      blockStart: Number(o.block_start),
      blockEnd: Number(o.block_end),
      status: o.status === "active" ? "active" : "cancelled",
      note: String(o.note),
      created: Number(o.created),
      reminders: (() => {
        try {
          const v = JSON.parse(String(o.reminders));
          return Array.isArray(v) ? v.map(String) : [];
        } catch {
          return [];
        }
      })(),
    };
  }

  private busyCount(except: string) {
    return (
      `(SELECT COUNT(*) FROM ${this.t} WHERE resource = ? AND status = 'active' AND id <> '${except}' ` +
      `AND block_start < ? AND block_end > ?)`
    );
  }

  insert(b: Booking, capacity: number): boolean {
    const rows = this.db
      .prepare(
        `INSERT INTO ${this.t} (id, resource, owner, start, "end", block_start, block_end, status, note, created, reminders) ` +
          `SELECT ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ? WHERE ${this.busyCount("")} < ? RETURNING id`,
      )
      .all(b.id, b.resource, b.owner, b.start, b.end, b.blockStart, b.blockEnd, b.note, b.created, JSON.stringify(b.reminders), b.resource, b.blockEnd, b.blockStart, capacity);
    return rows.length > 0;
  }

  get(id: string): Booking | null {
    const r = this.db.prepare(`SELECT * FROM ${this.t} WHERE id = ?`).all(id)[0];
    return r ? this.row(r) : null;
  }

  move(id: string, to: Pick<Booking, "start" | "end" | "blockStart" | "blockEnd">, capacity: number): boolean {
    const rows = this.db
      .prepare(
        `UPDATE ${this.t} SET start = ?, "end" = ?, block_start = ?, block_end = ? WHERE id = ? AND status = 'active' ` +
          `AND (SELECT COUNT(*) FROM ${this.t} AS o WHERE o.resource = ${this.t}.resource AND o.status = 'active' AND o.id <> ? ` +
          `AND o.block_start < ? AND o.block_end > ?) < ? RETURNING id`,
      )
      .all(to.start, to.end, to.blockStart, to.blockEnd, id, id, to.blockEnd, to.blockStart, capacity);
    return rows.length > 0;
  }

  update(id: string, patch: Partial<Pick<Booking, "status" | "reminders">>): void {
    if (patch.status !== undefined) this.db.prepare(`UPDATE ${this.t} SET status = ? WHERE id = ?`).run(patch.status, id);
    if (patch.reminders !== undefined) this.db.prepare(`UPDATE ${this.t} SET reminders = ? WHERE id = ?`).run(JSON.stringify(patch.reminders), id);
  }

  overlapping(resource: string, from: number, to: number): Booking[] {
    return this.db
      .prepare(`SELECT * FROM ${this.t} WHERE resource = ? AND status = 'active' AND block_start < ? AND block_end > ? ORDER BY start`)
      .all(resource, to, from)
      .map((r) => this.row(r));
  }

  byOwner(owner: string, from: number, to: number): Booking[] {
    return this.db
      .prepare(`SELECT * FROM ${this.t} WHERE owner = ? AND "end" > ? AND start < ? ORDER BY start`)
      .all(owner, from, to)
      .map((r) => this.row(r));
  }
}

export { DAY_KEYS as WEEKDAY_KEYS };
