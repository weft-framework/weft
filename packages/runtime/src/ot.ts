export type Step = { i: number; s: string } | { d: number; n: number };
export type Edit = Step[];

export function applyEdit(text: string, edit: Edit): string {
  for (const st of edit) {
    if ("s" in st) {
      if (st.i < 0 || st.i > text.length) throw new RangeError(`insert at ${st.i} outside ${text.length}`);
      text = text.slice(0, st.i) + st.s + text.slice(st.i);
    } else {
      if (st.d < 0 || st.n < 0 || st.d + st.n > text.length) throw new RangeError(`delete ${st.d}+${st.n} outside ${text.length}`);
      text = text.slice(0, st.d) + text.slice(st.d + st.n);
    }
  }
  return text;
}

export function isEdit(x: unknown, max = 64, chars = 16 * 1024): x is Edit {
  if (!Array.isArray(x) || x.length > max) return false;
  let added = 0;
  for (const st of x) {
    if (typeof st !== "object" || st === null) return false;
    const keys = Object.keys(st);
    if (keys.length !== 2) return false;
    const r = st as Record<string, unknown>;
    if (typeof r.s === "string" && Number.isSafeInteger(r.i) && (r.i as number) >= 0) {
      added += r.s.length;
      if (r.s === "" || added > chars) return false;
    } else if (!(Number.isSafeInteger(r.d) && Number.isSafeInteger(r.n) && (r.d as number) >= 0 && (r.n as number) > 0)) {
      return false;
    }
  }
  return true;
}

function step(a: Step, b: Step, aFirst: boolean): Step[] {
  if ("s" in a) {
    if ("s" in b) return [a.i < b.i || (a.i === b.i && aFirst) ? a : { i: a.i + b.s.length, s: a.s }];
    if (a.i <= b.d) return [a];
    if (a.i >= b.d + b.n) return [{ i: a.i - b.n, s: a.s }];
    return [{ i: b.d, s: a.s }];
  }
  if ("s" in b) {
    if (b.i <= a.d) return [{ d: a.d + b.s.length, n: a.n }];
    if (b.i >= a.d + a.n) return [a];
    const before = b.i - a.d;
    return [
      { d: a.d, n: before },
      { d: a.d + b.s.length, n: a.n - before },
    ];
  }
  const a2 = a.d + a.n;
  const b2 = b.d + b.n;
  const overlap = Math.max(0, Math.min(a2, b2) - Math.max(a.d, b.d));
  const n = a.n - overlap;
  if (n === 0) return [];
  const d = a.d >= b2 ? a.d - b.n : a.d >= b.d ? b.d : a.d;
  return [{ d, n }];
}

export function transform(a: Edit, b: Edit, aFirst: boolean): [Edit, Edit] {
  if (a.length === 0 || b.length === 0) return [a, b];
  if (a.length === 1 && b.length === 1) return [step(a[0]!, b[0]!, aFirst), step(b[0]!, a[0]!, !aFirst)];
  if (a.length > 1) {
    const [a0, b1] = transform([a[0]!], b, aFirst);
    const [rest, b2] = transform(a.slice(1), b1, aFirst);
    return [[...a0, ...rest], b2];
  }
  const [a1, b0] = transform(a, [b[0]!], aFirst);
  const [a2, rest] = transform(a1, b.slice(1), aFirst);
  return [a2, [...b0, ...rest]];
}

export function moveIndex(at: number, edit: Edit, after = false): number {
  for (const st of edit) {
    if ("s" in st) {
      if (st.i < at || (st.i === at && !after)) at += st.s.length;
    } else if (at > st.d) {
      at = Math.max(st.d, at - st.n);
    }
  }
  return at;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

export function diffText(from: string, to: string): Edit {
  if (from === to) return [];
  let p = 0;
  const max = Math.min(from.length, to.length);
  while (p < max && from.charCodeAt(p) === to.charCodeAt(p)) p++;
  if (p > 0 && isHigh(from.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && from.charCodeAt(from.length - 1 - s) === to.charCodeAt(to.length - 1 - s)) s++;
  if (s > 0 && isLow(from.charCodeAt(from.length - s))) s--;
  const out: Edit = [];
  const gone = from.length - p - s;
  if (gone > 0) out.push({ d: p, n: gone });
  const added = to.slice(p, to.length - s);
  if (added !== "") out.push({ i: p, s: added });
  return out;
}
