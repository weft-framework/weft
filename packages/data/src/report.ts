import { ScopedModel, type Model } from "./model.ts";
import { toCsv } from "./csv.ts";

export type Bucket = "day" | "week" | "month";

export type Measure = { count: true } | { sum: string } | { avg: string } | { min: string } | { max: string };

export interface ReportOptions<T> {
  time: keyof T & string;
  measures: Record<string, Measure>;
  split?: keyof T & string;
  maxRows?: number;
}

export interface RunOptions {
  from: number | Date;
  to: number | Date;
  bucket: Bucket;
  timeZone?: string;
  compare?: "previous" | "year";
  where?: Record<string, unknown>;
}

export interface ReportBucket {
  label: string;
  values: Record<string, number | null>;
  previous?: Record<string, number | null>;
}

export interface ReportResult {
  bucket: Bucket;
  timeZone: string;
  from: number;
  to: number;
  columns: string[];
  buckets: ReportBucket[];
  totals: Record<string, number | null>;
  previousTotals?: Record<string, number | null>;
  change?: Record<string, number | null>;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_BUCKETS = 1000;
const MAX_SPLITS = 50;

type Day = { y: number; m: number; d: number };

function dayNumber(t: Day): number {
  return Math.floor(Date.UTC(t.y, t.m - 1, t.d) / 86_400_000);
}

function fromDayNumber(n: number): Day {
  const d = new Date(n * 86_400_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function zoneDay(fmt: Intl.DateTimeFormat, ms: number): Day {
  const parts = fmt.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function labelOf(bucket: Bucket, day: Day): string {
  if (bucket === "month") return `${pad(day.y, 4)}-${pad(day.m)}`;
  let n = dayNumber(day);
  if (bucket === "week") n -= (new Date(n * 86_400_000).getUTCDay() + 6) % 7;
  const t = fromDayNumber(n);
  return `${pad(t.y, 4)}-${pad(t.m)}-${pad(t.d)}`;
}

function labels(bucket: Bucket, first: Day, last: Day): string[] {
  const out: string[] = [];
  if (bucket === "month") {
    let y = first.y;
    let m = first.m;
    while (y < last.y || (y === last.y && m <= last.m)) {
      out.push(`${pad(y, 4)}-${pad(m)}`);
      if (out.length > MAX_BUCKETS) break;
      m += 1;
      if (m === 13) {
        m = 1;
        y += 1;
      }
    }
    return out;
  }
  const step = bucket === "week" ? 7 : 1;
  let n = dayNumber(first);
  if (bucket === "week") n -= (new Date(n * 86_400_000).getUTCDay() + 6) % 7;
  for (; n <= dayNumber(last); n += step) {
    const t = fromDayNumber(n);
    out.push(`${pad(t.y, 4)}-${pad(t.m)}-${pad(t.d)}`);
    if (out.length > MAX_BUCKETS) break;
  }
  return out;
}

function msOf(v: unknown, what: string): number {
  const n = v instanceof Date ? v.getTime() : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new TypeError(`report: ${what} is a time (ms or Date)`);
  return n;
}

class Acc {
  n = 0;
  sum = 0;
  min = Infinity;
  max = -Infinity;
  add(v: number): void {
    this.n += 1;
    this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }
  value(m: Measure): number | null {
    if ("count" in m) return this.n;
    if (this.n === 0) return "sum" in m ? 0 : null;
    if ("sum" in m) return this.sum;
    if ("avg" in m) return this.sum / this.n;
    if ("min" in m) return this.min;
    return this.max;
  }
}

type Collected = { byLabel: Map<string, Map<string, Acc[]>>; splits: Set<string> };

export class Report<T> {
  readonly model: Model<T, any>;
  readonly time: string;
  readonly split: string | null;
  readonly #measures: [string, Measure, string | null][];
  readonly #timeKind: "number" | "date";
  readonly #maxRows: number;

  constructor(model: Model<T, any>, o: ReportOptions<T>) {
    const fail = (msg: string): never => {
      throw new Error(`defineReport(${model?.name ?? "?"}): ${msg}`);
    };
    if (!model || typeof model.as !== "function" || !Array.isArray(model.fields)) fail("needs a model");
    if (!o || typeof o !== "object") fail("needs options");
    const spec = (name: string) => model.fields.find((f) => f.name === name);
    const time = spec(o.time);
    if (!time) fail(`no field \`${String(o.time)}\``);
    const kind = time!.kind === "date" ? "date" : time!.kind === "real" ? "number" : fail(`\`${o.time}\` is a number of ms or a Date`);
    const measures: [string, Measure, string | null][] = [];
    for (const [name, m] of Object.entries(o.measures ?? {})) {
      if (!NAME_RE.test(name)) fail(`measure \`${name}\`: names are identifiers`);
      if (!m || typeof m !== "object") fail(`measure \`${name}\` is { count: true } or { sum | avg | min | max: field }`);
      const keys = Object.keys(m);
      if (keys.length !== 1) fail(`measure \`${name}\` names one function`);
      const fn = keys[0]!;
      if (fn === "count") {
        if ((m as { count: unknown }).count !== true) fail(`measure \`${name}\`: count is true`);
        measures.push([name, m, null]);
        continue;
      }
      if (!["sum", "avg", "min", "max"].includes(fn)) fail(`measure \`${name}\`: ${fn} is not count, sum, avg, min or max`);
      const field = (m as Record<string, unknown>)[fn];
      const f = typeof field === "string" ? spec(field) : undefined;
      if (!f) fail(`measure \`${name}\`: no field \`${String(field)}\``);
      if (f!.kind !== "real" && f!.kind !== "integer") fail(`measure \`${name}\`: \`${field}\` is not a number`);
      measures.push([name, m, field as string]);
    }
    if (measures.length === 0) fail("no measures");
    if (o.split !== undefined) {
      const s = spec(o.split);
      if (!s) fail(`no field \`${String(o.split)}\` to split by`);
      if (s!.kind !== "text" && s!.kind !== "bool") fail(`split \`${o.split}\` is a text or boolean field`);
      if (o.split === o.time) fail("split is not the time field");
    }
    const max = o.maxRows ?? 100_000;
    if (!Number.isInteger(max) || max < 1 || max > 10_000_000) fail("maxRows is 1 to 10 000 000");
    this.model = model;
    this.time = o.time;
    this.split = o.split ?? null;
    this.#measures = measures;
    this.#timeKind = kind;
    this.#maxRows = max;
  }

  #collect(
    scoped: ScopedModel<T, any>,
    from: number,
    to: number,
    o: RunOptions,
    fmt: Intl.DateTimeFormat,
  ): Collected {
    const bound = (ms: number) => (this.#timeKind === "date" ? new Date(ms) : ms);
    const range = { [this.time]: { gte: bound(from), lt: bound(to) } };
    let q = scoped.query().where(range as never);
    if (o.where) q = q.where(o.where as never);
    const rows = q.limit(this.#maxRows + 1).all() as Record<string, unknown>[];
    if (rows.length > this.#maxRows) throw new Error(`report: more than ${this.#maxRows} rows in range; narrow it or raise maxRows`);
    const byLabel = new Map<string, Map<string, Acc[]>>();
    const splits = new Set<string>();
    for (const r of rows) {
      const t = r[this.time];
      const ms = t instanceof Date ? t.getTime() : (t as number);
      if (typeof ms !== "number" || !Number.isFinite(ms)) continue;
      const label = labelOf(o.bucket, zoneDay(fmt, ms));
      const sv = this.split === null ? "" : r[this.split] === null || r[this.split] === undefined ? "(none)" : String(r[this.split]);
      if (this.split !== null && !splits.has(sv)) {
        if (splits.size >= MAX_SPLITS) throw new Error(`report: more than ${MAX_SPLITS} values of \`${this.split}\``);
        splits.add(sv);
      }
      let group = byLabel.get(label);
      if (!group) byLabel.set(label, (group = new Map()));
      let accs = group.get(sv);
      if (!accs) group.set(sv, (accs = this.#measures.map(() => new Acc())));
      this.#measures.forEach(([, , field], i) => {
        if (field === null) accs![i]!.add(1);
        else {
          const v = Number(r[field]);
          if (r[field] !== null && r[field] !== undefined && Number.isFinite(v)) accs![i]!.add(v);
        }
      });
    }
    return { byLabel, splits };
  }

  run(scoped: ScopedModel<T, any>, o: RunOptions): ReportResult {
    if (!(scoped instanceof ScopedModel) || scoped.model !== this.model) throw new TypeError(`report: pass ${this.model.name}.as(actor)`);
    if (!o || !["day", "week", "month"].includes(o.bucket)) throw new TypeError('report: bucket is "day", "week" or "month"');
    if (o.compare !== undefined && o.compare !== "previous" && o.compare !== "year") throw new TypeError('report: compare is "previous" or "year"');
    const from = msOf(o.from, "from");
    const to = msOf(o.to, "to");
    if (to <= from) throw new RangeError("report: `to` is after `from`");
    const timeZone = o.timeZone ?? "UTC";
    let fmt: Intl.DateTimeFormat;
    try {
      fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" });
    } catch {
      throw new RangeError(`report: unknown time zone ${JSON.stringify(timeZone).slice(0, 80)}`);
    }
    const names = labels(o.bucket, zoneDay(fmt, from), zoneDay(fmt, to - 1));
    if (names.length > MAX_BUCKETS) throw new RangeError(`report: more than ${MAX_BUCKETS} buckets; use a longer bucket or a shorter range`);

    const now = this.#collect(scoped, from, to, o, fmt);
    let before: Collected | null = null;
    let prevNames: string[] = [];
    let pFrom = 0;
    let pTo = 0;
    if (o.compare) {
      if (o.compare === "previous") {
        pFrom = from - (to - from);
        pTo = from;
      } else {
        const back = (ms: number) => {
          const d = new Date(ms);
          d.setUTCFullYear(d.getUTCFullYear() - 1);
          return d.getTime();
        };
        pFrom = back(from);
        pTo = back(to);
      }
      prevNames = labels(o.bucket, zoneDay(fmt, pFrom), zoneDay(fmt, pTo - 1));
      before = this.#collect(scoped, pFrom, pTo, o, fmt);
    }

    const splits = [...new Set([...now.splits, ...(before?.splits ?? [])])].sort();
    const columns: string[] = [];
    const cols: [string, number, string][] = [];
    this.#measures.forEach(([name], i) => {
      if (this.split === null) {
        columns.push(name);
        cols.push([name, i, ""]);
      } else {
        for (const s of splits) {
          columns.push(`${name}:${s}`);
          cols.push([`${name}:${s}`, i, s]);
        }
      }
    });
    const valuesOf = (group: Map<string, Acc[]> | undefined): Record<string, number | null> => {
      const out: Record<string, number | null> = {};
      for (const [col, i, s] of cols) out[col] = (group?.get(s)?.[i] ?? new Acc()).value(this.#measures[i]![1]);
      return out;
    };
    const totalsOf = (c: { byLabel: Map<string, Map<string, Acc[]>> }): Record<string, number | null> => {
      const merged = new Map<string, Acc[]>();
      for (const group of c.byLabel.values()) {
        for (const [s, accs] of group) {
          let into = merged.get(s);
          if (!into) merged.set(s, (into = this.#measures.map(() => new Acc())));
          accs.forEach((a, i) => {
            const t = into![i]!;
            t.n += a.n;
            t.sum += a.sum;
            t.min = Math.min(t.min, a.min);
            t.max = Math.max(t.max, a.max);
          });
        }
      }
      return valuesOf(merged);
    };

    const buckets: ReportBucket[] = names.map((label, i) => ({
      label,
      values: valuesOf(now.byLabel.get(label)),
      ...(before ? { previous: valuesOf(prevNames[i] === undefined ? undefined : before.byLabel.get(prevNames[i]!)) } : {}),
    }));
    const totals = totalsOf(now);
    const out: ReportResult = { bucket: o.bucket, timeZone, from, to, columns, buckets, totals };
    if (before) {
      const previousTotals = totalsOf(before);
      const change: Record<string, number | null> = {};
      for (const c of columns) {
        const p = previousTotals[c];
        const t = totals[c];
        change[c] = p === null || p === undefined || p === 0 || t === null || t === undefined ? null : (t - p) / Math.abs(p);
      }
      out.previousTotals = previousTotals;
      out.change = change;
    }
    return out;
  }
}

export function defineReport<T>(model: Model<T, any>, options: ReportOptions<T>): Report<T> {
  return new Report(model, options);
}

export function reportRows(r: ReportResult, columns: readonly string[] = r.columns, o: { previous?: boolean } = {}): Record<string, string | number>[] {
  for (const c of columns) if (!r.columns.includes(c)) throw new Error(`reportRows: no column \`${c}\``);
  return r.buckets.map((b) => {
    const row: Record<string, string | number> = { label: b.label };
    for (const c of columns) {
      row[c] = b.values[c] ?? 0;
      if (o.previous && b.previous) row[`${c} (previous)`] = b.previous[c] ?? 0;
    }
    return row;
  });
}

export function reportCsv(r: ReportResult, o: { bom?: boolean } = {}): string {
  const prev = r.buckets.some((b) => b.previous);
  const head = ["label", ...r.columns, ...(prev ? r.columns.map((c) => `${c} (previous)`) : [])];
  const rows: Record<string, unknown>[] = r.buckets.map((b) => {
    const row: Record<string, unknown> = { label: b.label };
    for (const c of r.columns) row[c] = b.values[c];
    if (prev) for (const c of r.columns) row[`${c} (previous)`] = b.previous?.[c] ?? null;
    return row;
  });
  const total: Record<string, unknown> = { label: "Total" };
  for (const c of r.columns) total[c] = r.totals[c];
  if (prev) for (const c of r.columns) total[`${c} (previous)`] = r.previousTotals?.[c] ?? null;
  rows.push(total);
  return toCsv(rows, head, o);
}

export type RangePreset = "today" | "last7" | "last30" | "last90" | "thisMonth" | "lastMonth" | "thisYear" | "lastYear";

export const RANGE_PRESETS: readonly RangePreset[] = Object.freeze([
  "today", "last7", "last30", "last90", "thisMonth", "lastMonth", "thisYear", "lastYear",
] as RangePreset[]);

export interface RangeOptions {
  timeZone?: string;
  default?: RangePreset;
  maxDays?: number;
  now?: number;
}

export interface ReportRange {
  range: RangePreset | "custom";
  start: string;
  end: string;
  from: number;
  to: number;
  bucket: Bucket;
  timeZone: string;
  compare?: "previous" | "year";
}

type Query = URLSearchParams | URL | Readonly<Record<string, string | null | undefined>>;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDay(s: string | null | undefined): number | null {
  const m = typeof s === "string" ? DAY_RE.exec(s) : null;
  if (!m) return null;
  const t = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (t.y < 1970 || t.y > 9999 || t.m < 1 || t.m > 12 || t.d < 1) return null;
  const n = dayNumber(t);
  const back = fromDayNumber(n);
  return back.m === t.m && back.d === t.d ? n : null;
}

function dayLabel(n: number): string {
  const t = fromDayNumber(n);
  return `${pad(t.y, 4)}-${pad(t.m)}-${pad(t.d)}`;
}

function zoneMidnight(fmt: Intl.DateTimeFormat, n: number): number {
  const wall = n * 86_400_000;
  const offset = (ms: number) => {
    const p = fmt.formatToParts(new Date(ms));
    const get = (k: string) => Number(p.find((x) => x.type === k)!.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) - ms;
  };
  const ms = wall - offset(wall - offset(wall));
  return dayNumber(zoneDay(fmt, ms)) === n ? ms : ms + 3_600_000;
}

function monthStart(y: number, m: number): number {
  return dayNumber({ y, m, d: 1 });
}

export function reportRange(query: Query, o: RangeOptions = {}): ReportRange {
  const timeZone = o.timeZone ?? "UTC";
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
  } catch {
    throw new RangeError(`reportRange: unknown time zone ${JSON.stringify(timeZone).slice(0, 80)}`);
  }
  const fallback = o.default ?? "last30";
  if (!RANGE_PRESETS.includes(fallback)) throw new Error(`reportRange: default is one of ${RANGE_PRESETS.join(", ")}`);
  const maxDays = o.maxDays ?? 1096;
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 3660) throw new Error("reportRange: maxDays is 1 to 3660");
  const get = (k: string): string | null => {
    if (query instanceof URL) return query.searchParams.get(k);
    if (query instanceof URLSearchParams) return query.get(k);
    const v = (query as Record<string, unknown>)[k];
    return typeof v === "string" ? v : null;
  };
  const today = dayNumber(zoneDay(fmt, o.now ?? Date.now()));
  const t = fromDayNumber(today);
  const preset = (p: RangePreset): [number, number] => {
    switch (p) {
      case "today":
        return [today, today];
      case "last7":
        return [today - 6, today];
      case "last30":
        return [today - 29, today];
      case "last90":
        return [today - 89, today];
      case "thisMonth":
        return [monthStart(t.y, t.m), (t.m === 12 ? monthStart(t.y + 1, 1) : monthStart(t.y, t.m + 1)) - 1];
      case "lastMonth":
        return [t.m === 1 ? monthStart(t.y - 1, 12) : monthStart(t.y, t.m - 1), monthStart(t.y, t.m) - 1];
      case "thisYear":
        return [monthStart(t.y, 1), monthStart(t.y + 1, 1) - 1];
      case "lastYear":
        return [monthStart(t.y - 1, 1), monthStart(t.y, 1) - 1];
    }
  };
  const asked = get("range");
  let range: RangePreset | "custom" = fallback;
  let [first, last] = preset(fallback);
  if (asked === "custom") {
    const a = parseDay(get("from"));
    const b = parseDay(get("to"));
    if (a !== null && b !== null && a <= b && b - a + 1 <= maxDays) {
      range = "custom";
      [first, last] = [a, b];
    }
  } else if (asked !== null && (RANGE_PRESETS as readonly string[]).includes(asked)) {
    range = asked as RangePreset;
    [first, last] = preset(range);
  }
  const days = last - first + 1;
  const auto: Bucket = days <= 62 ? "day" : days <= 366 ? "week" : "month";
  const b = get("bucket");
  const fits = (k: Bucket) => labels(k, fromDayNumber(first), fromDayNumber(last)).length <= MAX_BUCKETS;
  const bucket: Bucket = (b === "day" || b === "week" || b === "month") && fits(b) ? b : auto;
  const out: ReportRange = {
    range,
    start: dayLabel(first),
    end: dayLabel(last),
    from: zoneMidnight(fmt, first),
    to: zoneMidnight(fmt, last + 1),
    bucket,
    timeZone,
  };
  const c = get("compare");
  if (c === "previous" || c === "year") out.compare = c;
  return out;
}

export function rangeQuery(r: ReportRange, change: Partial<Pick<ReportRange, "bucket" | "compare">> = {}): string {
  const q = new URLSearchParams({ range: r.range });
  if (r.range === "custom") {
    q.set("from", r.start);
    q.set("to", r.end);
  }
  q.set("bucket", change.bucket ?? r.bucket);
  const compare = "compare" in change ? change.compare : r.compare;
  if (compare) q.set("compare", compare);
  return q.toString();
}

export function shiftRange(r: ReportRange, n: number): ReportRange {
  if (!Number.isInteger(n)) throw new Error("shiftRange: n is a whole number");
  const first = parseDay(r.start);
  const last = parseDay(r.end);
  if (first === null || last === null) throw new Error("shiftRange: not a range from reportRange");
  const s = fromDayNumber(first);
  const e = fromDayNumber(last + 1);
  const months = (e.y - s.y) * 12 + (e.m - s.m);
  let a: number;
  let b: number;
  if (s.d === 1 && e.d === 1 && months > 0) {
    const shift = (y: number, m: number, k: number) => {
      const i = y * 12 + (m - 1) + k;
      return monthStart(Math.floor(i / 12), (i % 12) + 1);
    };
    a = shift(s.y, s.m, n * months);
    b = shift(e.y, e.m, n * months) - 1;
  } else {
    const len = last - first + 1;
    a = first + n * len;
    b = last + n * len;
  }
  const q: Record<string, string> = { range: "custom", from: dayLabel(a), to: dayLabel(b), bucket: r.bucket };
  if (r.compare) q.compare = r.compare;
  return reportRange(q, { timeZone: r.timeZone, maxDays: 3660 });
}
