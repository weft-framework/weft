import type { Filter } from "./filter.ts";
import type { Model, ScopedModel } from "./model.ts";
import { Query } from "./query.ts";

export type ColumnFilter = "text" | "number" | "date" | "boolean" | { options: readonly string[] };

export interface TableColumn {
  sort?: boolean;
  search?: boolean;
  filter?: ColumnFilter;
  hidden?: boolean;
  always?: boolean;
}

export interface TableSpec<T> {
  columns: { [K in keyof T & string]?: TableColumn };
  sort?: readonly [keyof T & string, "asc" | "desc"];
  pageSize?: number;
  sizes?: readonly number[];
  prefix?: string;
  fields?: readonly (keyof T & string)[];
  maxText?: number;
}

export type FilterValue = string[] | string | boolean | { min?: string; max?: string };

export interface TableChange {
  page?: number;
  size?: number;
  sort?: string | null;
  dir?: "asc" | "desc";
  q?: string | null;
  cols?: readonly string[] | null;
  filter?: Record<string, FilterValue | null>;
}

export interface TableView<R> {
  rows: R[];
  total: number;
  page: number;
  pages: number;
  size: number;
  sort: string;
  dir: "asc" | "desc";
  q: string;
  filters: Record<string, FilterValue>;
  columns: string[];
  link(change: TableChange): string;
  sortLink(column: string): string;
  ariaSort(column: string): "ascending" | "descending" | "none";
}

const PREFIX_RE = /^(?:[a-z][a-z0-9_-]*\.)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const DAY_MS = 86_400_000;

function fold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function searchable(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (v instanceof Date) return v.toISOString();
  return null;
}

function parseDate(s: string, end: boolean): Date | null {
  if (!DATE_RE.test(s)) return null;
  const dateOnly = s.length === 10;
  const d = new Date(dateOnly ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) return null;
  return end && dateOnly ? new Date(d.getTime() + DAY_MS) : d;
}

export class Table<T> {
  readonly model: Model<T, any>;
  readonly #spec: Required<Pick<TableSpec<T>, "pageSize" | "prefix" | "maxText">> & TableSpec<T>;
  readonly #columns: [string, TableColumn][];
  readonly #sizes: number[];

  constructor(model: Model<T, any>, spec: TableSpec<T>) {
    const fail = (msg: string): never => {
      throw new Error(`table of ${model.name}: ${msg}`);
    };
    const fields = new Map(model.fields.map((f) => [f.name, f]));
    const columns = Object.entries(spec.columns ?? {}).filter(([, c]) => c !== undefined) as [string, TableColumn][];
    if (columns.length === 0) fail("declare at least one column");
    for (const [name, c] of columns) {
      const f = fields.get(name) ?? fail(`no field \`${name}\``);
      if (c.sort && f.kind === "json") fail(`cannot sort by JSON field \`${name}\``);
      if (c.hidden && c.always) fail(`\`${name}\` cannot be hidden and always shown`);
      const filter = c.filter;
      if (filter === undefined) continue;
      const want =
        filter === "number"
          ? ["real", "integer"]
          : filter === "date"
            ? ["date"]
            : filter === "boolean"
              ? ["bool"]
              : filter === "text"
                ? ["text"]
                : typeof filter === "object" && filter !== null && Array.isArray(filter.options)
                  ? ["text"]
                  : fail(`\`${name}\`: filter is "text", "number", "date", "boolean" or { options }`);
      if (!want.includes(f.kind)) fail(`\`${name}\`: a ${typeof filter === "string" ? filter : "options"} filter needs a ${want.join(" or ")} field`);
      if (typeof filter === "object") {
        const opts = filter.options;
        if (opts.length === 0 || opts.some((o) => typeof o !== "string" || o === "") || new Set(opts).size !== opts.length) {
          fail(`\`${name}\`: options are distinct, non-empty strings`);
        }
      }
    }
    if (spec.sort) {
      const [by, dir] = spec.sort;
      if (!fields.has(by) || fields.get(by)!.kind === "json") fail(`cannot sort by \`${String(by)}\``);
      if (dir !== "asc" && dir !== "desc") fail(`sort direction is "asc" or "desc"`);
    }
    for (const f of spec.fields ?? []) if (!fields.has(f)) fail(`no field \`${f}\``);
    const pageSize = spec.pageSize ?? 25;
    const sizes = [...(spec.sizes ?? [pageSize])];
    for (const n of [pageSize, ...sizes]) {
      if (!Number.isSafeInteger(n) || n < 1 || n > 1000) fail("page sizes are 1 to 1000");
    }
    if (!sizes.includes(pageSize)) fail("sizes must include pageSize");
    const prefix = spec.prefix ?? "";
    if (!PREFIX_RE.test(prefix)) fail('prefix is a lower-case name ending in "." (like "orders.")');
    const maxText = spec.maxText ?? 200;
    if (!Number.isSafeInteger(maxText) || maxText < 1) fail("maxText is a positive integer");
    this.model = model;
    this.#spec = { ...spec, pageSize, prefix, maxText };
    this.#columns = columns;
    this.#sizes = sizes;
  }

  get columns(): string[] {
    return this.#columns.map(([n]) => n);
  }

  column(name: string): Readonly<TableColumn> | undefined {
    return this.#columns.find(([n]) => n === name)?.[1];
  }

  view(source: ScopedModel<T, any> | Query<T, any, any, any>, url: URL | URLSearchParams): TableView<Partial<T>> {
    const base = source instanceof Query ? source : source.query();
    if ((base.model as unknown) !== this.model) {
      throw new Error(`table of ${this.model.name}: the query is for another model`);
    }
    const params = url instanceof URL ? url.searchParams : url;
    const p = this.#spec.prefix;
    const get = (k: string) => params.get(p + k);
    const text = (v: string | null) => (v ?? "").trim().slice(0, this.#spec.maxText);
    const columns = new Map(this.#columns);
    const fieldKind = new Map(this.model.fields.map((f) => [f.name, f.kind]));

    let sort = text(get("sort"));
    if (!columns.get(sort)?.sort) sort = "";
    const dir: "asc" | "desc" = sort ? (get("dir") === "desc" ? "desc" : "asc") : (this.#spec.sort?.[1] ?? "asc");
    const by = sort || (this.#spec.sort?.[0] as string | undefined) || "";

    const where: Filter<T>[] = [];
    const preds: ((row: T) => boolean)[] = [];
    const filters: Record<string, FilterValue> = {};
    for (const [name, c] of this.#columns) {
      const f = c.filter;
      if (f === undefined) continue;
      const key = `f.${name}`;
      if (typeof f === "object") {
        const picked = [...new Set(params.getAll(p + key))].filter((v) => f.options.includes(v)).slice(0, f.options.length);
        if (picked.length > 0) {
          filters[name] = picked;
          where.push({ [name]: { in: picked } } as Filter<T>);
        }
      } else if (f === "text") {
        const v = text(get(key));
        if (v !== "") {
          filters[name] = v;
          const needle = fold(v);
          preds.push((row) => {
            const s = searchable((row as Record<string, unknown>)[name]);
            return s !== null && fold(s).includes(needle);
          });
        }
      } else if (f === "boolean") {
        const v = get(key);
        if (v === "true" || v === "false") {
          filters[name] = v === "true";
          where.push({ [name]: v === "true" } as Filter<T>);
        }
      } else {
        const range: { min?: string; max?: string } = {};
        const ops: Record<string, unknown> = {};
        for (const end of ["min", "max"] as const) {
          const raw = text(get(`${key}.${end}`));
          if (raw === "") continue;
          let value: unknown = null;
          if (f === "date") {
            value = parseDate(raw, end === "max");
          } else if (fieldKind.get(name) === "integer") {
            value = /^-?\d{1,30}$/.test(raw) ? BigInt(raw) : null;
          } else {
            const n = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) ? Number(raw) : NaN;
            value = Number.isFinite(n) ? n : null;
          }
          if (value === null) continue;
          range[end] = raw;
          ops[end === "min" ? "gte" : f === "date" && raw.length === 10 ? "lt" : "lte"] = value;
        }
        if (range.min !== undefined || range.max !== undefined) {
          filters[name] = range;
          where.push({ [name]: ops } as Filter<T>);
        }
      }
    }

    const q = text(get("q"));
    const searchCols = this.#columns.filter(([, c]) => c.search).map(([n]) => n);
    if (q !== "" && searchCols.length > 0) {
      const needle = fold(q);
      preds.push((row) =>
        searchCols.some((n) => {
          const s = searchable((row as Record<string, unknown>)[n]);
          return s !== null && fold(s).includes(needle);
        }),
      );
    }

    const asked = get("cols");
    const askedSet = asked === null ? null : new Set(asked.split(",").map((s) => s.trim()));
    const shown = this.#columns
      .filter(([n, c]) => c.always || (askedSet ? askedSet.has(n) : !c.hidden))
      .map(([n]) => n);

    let query = base as Query<T, any, any, any>;
    for (const w of where) query = query.where(w);
    for (const pred of preds) query = query.filter(pred);
    if (by) query = query.orderBy(by as keyof T & string, dir);
    if (by !== this.model.key) query = query.orderBy(this.model.key as keyof T & string, "asc");
    const pick = [...new Set([this.model.key, ...shown, ...((this.#spec.fields ?? []) as readonly string[])])];
    query = query.select(...(pick as (keyof T)[]));

    const requested = Number(get("size"));
    const size = this.#sizes.includes(requested) ? requested : this.#spec.pageSize;
    const matching = query.rows();
    const total = matching.length;
    const pages = Math.max(1, Math.ceil(total / size));
    const askedPage = Number(get("page"));
    const page = Number.isSafeInteger(askedPage) && askedPage >= 1 ? Math.min(askedPage, pages) : 1;
    const rows = query.decorate(matching.slice((page - 1) * size, page * size)) as Partial<T>[];

    const state = { page, size, sort, dir, q, filters, shown };
    const link = (change: TableChange) => this.#link(params, state, change);
    return {
      rows,
      total,
      page,
      pages,
      size,
      sort,
      dir,
      q,
      filters,
      columns: shown,
      link,
      sortLink: (column) => link({ sort: column, dir: sort === column && dir === "asc" ? "desc" : "asc" }),
      ariaSort: (column) => (sort !== column ? "none" : dir === "asc" ? "ascending" : "descending"),
    };
  }

  #link(
    params: URLSearchParams,
    state: { page: number; size: number; sort: string; dir: "asc" | "desc"; q: string; filters: Record<string, FilterValue>; shown: string[] },
    change: TableChange,
  ): string {
    const p = this.#spec.prefix;
    const next = new URLSearchParams();
    for (const [k, v] of params) {
      if (!k.startsWith(p) || !this.#own(k.slice(p.length))) next.append(k, v);
    }
    const set = (k: string, v: string | null) => {
      if (v !== null && v !== "") next.set(p + k, v);
    };
    const sort = change.sort === undefined ? state.sort : (change.sort ?? "");
    set("sort", sort || null);
    if (sort) set("dir", change.dir ?? (change.sort === undefined ? state.dir : "asc"));
    set("q", change.q === undefined ? state.q : change.q);
    const size = change.size ?? state.size;
    set("size", size === this.#spec.pageSize ? null : String(size));
    const cols = change.cols === undefined ? null : change.cols;
    if (change.cols === undefined) {
      if (params.has(p + "cols")) set("cols", state.shown.join(","));
    } else if (cols !== null) {
      next.set(p + "cols", cols.join(","));
    }
    const filters = { ...state.filters };
    for (const [name, v] of Object.entries(change.filter ?? {})) {
      if (v === null) delete filters[name];
      else filters[name] = v;
    }
    for (const [name, v] of Object.entries(filters)) {
      const key = `f.${name}`;
      if (Array.isArray(v)) for (const o of v) next.append(p + key, o);
      else if (typeof v === "string" || typeof v === "boolean") set(key, String(v));
      else {
        set(`${key}.min`, v.min ?? null);
        set(`${key}.max`, v.max ?? null);
      }
    }
    const keepPage = change.page === undefined && Object.keys(change).every((k) => k === "cols");
    const page = change.page ?? (keepPage ? state.page : 1);
    set("page", page > 1 ? String(page) : null);
    const s = next.toString();
    return s ? `?${s}` : "?";
  }

  #own(k: string): boolean {
    return ["page", "size", "sort", "dir", "q", "cols"].includes(k) || k.startsWith("f.");
  }
}

export function defineTable<T>(model: Model<T, any>, spec: TableSpec<T>): Table<T> {
  return new Table<T>(model, spec);
}
