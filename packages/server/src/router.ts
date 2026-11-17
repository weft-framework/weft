export type Params = Record<string, string | string[]>;

type Segment =
  | { kind: "static"; value: string }
  | { kind: "param"; name: string }
  | { kind: "rest"; name: string; optional: boolean };

export interface CompiledRoute<T> {
  pattern: string;
  value: T;
  segments: Segment[];
}

const PARAM = /^\[([A-Za-z_$][\w$]*)\]$/;
const REST = /^\[\.\.\.([A-Za-z_$][\w$]*)\]$/;
const OPT_REST = /^\[\[\.\.\.([A-Za-z_$][\w$]*)\]\]$/;

export function parsePattern(pattern: string): Segment[] {
  if (!pattern.startsWith("/")) {
    throw new Error(`route pattern must start with "/": ${pattern}`);
  }
  const parts = pattern === "/" ? [] : pattern.slice(1).replace(/\/$/, "").split("/");
  const names = new Set<string>();
  const segments: Segment[] = parts.map((part, i) => {
    let m: RegExpExecArray | null;
    let seg: Segment;
    if ((m = OPT_REST.exec(part))) {
      seg = { kind: "rest", name: m[1], optional: true };
    } else if ((m = REST.exec(part))) {
      seg = { kind: "rest", name: m[1], optional: false };
    } else if ((m = PARAM.exec(part))) {
      seg = { kind: "param", name: m[1] };
    } else if (part === "" || part.includes("[") || part.includes("]")) {
      throw new Error(`invalid route segment "${part}" in ${pattern}`);
    } else {
      return { kind: "static", value: part };
    }
    if (names.has(seg.name)) {
      throw new Error(`duplicate route parameter "${seg.name}" in ${pattern}`);
    }
    names.add(seg.name);
    if (seg.kind === "rest" && i !== parts.length - 1) {
      throw new Error(`catch-all must be the last segment: ${pattern}`);
    }
    return seg;
  });
  return segments;
}

function rank(segments: Segment[]): number[] {
  return segments.map((s) =>
    s.kind === "static" ? 0 : s.kind === "param" ? 1 : s.optional ? 3 : 2,
  );
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) {
      return x - y;
    }
  }
  return 0;
}

function shape(segments: Segment[]): string {
  return segments
    .map((s) => (s.kind === "static" ? `s:${s.value}` : s.kind === "param" ? "p" : s.optional ? "o" : "r"))
    .join("/");
}

export class Router<T> {
  readonly routes: CompiledRoute<T>[];

  constructor(table: Record<string, T> | [string, T][]) {
    const entries = Array.isArray(table) ? table : Object.entries(table);
    const seen = new Map<string, string>();
    this.routes = entries.map(([pattern, value]) => {
      const segments = parsePattern(pattern);
      const key = shape(segments);
      const other = seen.get(key);
      if (other !== undefined) {
        throw new Error(`route conflict: ${other} and ${pattern} match the same paths`);
      }
      seen.set(key, pattern);
      return { pattern, value, segments };
    });
    this.routes.sort((a, b) => compareRank(rank(a.segments), rank(b.segments)));
  }

  match(path: string): { route: CompiledRoute<T>; params: Params } | null {
    const parts = splitPath(path);
    if (!parts) {
      return null;
    }
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (params) {
        return { route, params };
      }
    }
    return null;
  }
}

export function splitPath(path: string): string[] | null {
  if (!path.startsWith("/")) {
    return null;
  }
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === "/") {
    return [];
  }
  const out: string[] = [];
  for (const raw of trimmed.slice(1).split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === "" || seg === "." || seg === ".." || seg.includes("\0")) {
      return null;
    }
    out.push(seg);
  }
  return out;
}

function matchSegments(segments: Segment[], parts: string[]): Params | null {
  const params: Params = Object.create(null);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === "rest") {
      const rest = parts.slice(i);
      if (rest.length === 0 && !seg.optional) {
        return null;
      }
      params[seg.name] = rest;
      return params;
    }
    const part = parts[i];
    if (part === undefined) {
      return null;
    }
    if (seg.kind === "static") {
      if (seg.value !== part) {
        return null;
      }
    } else {
      params[seg.name] = part;
    }
  }
  return parts.length === segments.length ? params : null;
}

export function patternForFile(rel: string): string {
  const noExt = rel.replace(/\\/g, "/").replace(/\.(wx|ts)$/, "");
  const parts = noExt.split("/");
  if (parts[parts.length - 1] === "index") {
    parts.pop();
  }
  return "/" + parts.join("/");
}
