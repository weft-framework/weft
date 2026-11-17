import { Model, ScopedModel } from "./model.ts";
import type { FieldSpec } from "./schema.ts";
import { transaction } from "./tx.ts";

export class CsvError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.name = "CsvError";
    this.line = line;
  }
}

export interface CsvLimits {
  delimiter?: "," | ";" | "\t";
  maxBytes?: number;
  maxRows?: number;
  maxColumns?: number;
  maxCell?: number;
}

export function parseCsv(text: string, o: CsvLimits = {}): string[][] {
  return table(text, o).rows;
}

export interface ImportTable {
  rows: string[][];
  lines: number[];
}

function table(text: string, o: CsvLimits): { rows: string[][]; lines: number[] } {
  if (typeof text !== "string") throw new TypeError("parseCsv: text is a string");
  const maxBytes = o.maxBytes ?? 10_000_000;
  const maxRows = (o.maxRows ?? 100_000) + 1;
  const maxColumns = o.maxColumns ?? 200;
  const maxCell = o.maxCell ?? 100_000;
  if (text.length > maxBytes) throw new CsvError(`the file is over ${maxBytes} characters`, 1);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = o.delimiter ?? guessDelimiter(text);
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let i = 0;
  const endCell = () => {
    if (cell.length > maxCell) throw new CsvError(`a cell is over ${maxCell} characters`, rowLine);
    row.push(cell);
    cell = "";
    if (row.length > maxColumns) throw new CsvError(`more than ${maxColumns} columns`, rowLine);
  };
  const endRow = () => {
    endCell();
    if (!(row.length === 1 && row[0] === "")) {
      rows.push(row);
      lines.push(rowLine);
      if (rows.length > maxRows) throw new CsvError(`more than ${maxRows - 1} rows`, rowLine);
    }
    row = [];
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        const n = text[i];
        if (n !== undefined && n !== d && n !== "\n" && n !== "\r") throw new CsvError("text after a closing quote", line);
        continue;
      }
      if (c === "\n") line++;
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (cell !== "") throw new CsvError("a quote inside an unquoted cell", line);
      quoted = true;
      i++;
    } else if (c === d) {
      endCell();
      i++;
    } else if (c === "\r" || c === "\n") {
      endRow();
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      line++;
      rowLine = line;
    } else {
      cell += c;
      i++;
    }
  }
  if (quoted) throw new CsvError("a quoted cell is not closed", rowLine);
  if (cell !== "" || row.length > 0) endRow();
  return { rows, lines };
}

function guessDelimiter(text: string): "," | ";" | "\t" {
  const nl = text.search(/\r|\n/);
  const head = nl < 0 ? text : text.slice(0, nl);
  const count = (ch: string) => head.split(ch).length - 1;
  const [best] = ([",", ";", "\t"] as const).map((ch) => [ch, count(ch)] as const).sort((a, b) => b[1] - a[1]);
  return best![1] > 0 ? best![0] : ",";
}

export type CsvColumn<T> = (keyof T & string) | { field: keyof T & string; header: string };

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[], o: { delimiter?: "," | ";" | "\t"; bom?: boolean } = {}): string {
  const d = o.delimiter ?? ",";
  if (columns.length === 0) throw new Error("toCsv: name the columns to export");
  const cols = columns.map((c) => (typeof c === "string" ? { field: c, header: c } : c));
  const out = [cols.map((c) => quote(c.header, d)).join(d)];
  for (const r of rows) {
    out.push(cols.map((c) => quote(cellText((r as Record<string, unknown>)[c.field]), d)).join(d));
  }
  return (o.bom ? "﻿" : "") + out.join("\r\n") + "\r\n";
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString();
  if (typeof v === "string") return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) ?? "";
}

function quote(s: string, d: string): string {
  return s.includes('"') || s.includes(d) || s.includes("\n") || s.includes("\r") ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ImportError {
  field?: string;
  message: string;
}

export interface ImportRow<T> {
  line: number;
  row: Partial<T>;
  errors: ImportError[];
}

export interface ImportPreview<T> {
  model: string;
  headers: string[];
  mapping: Record<string, string | null>;
  missing: string[];
  rows: ImportRow<T>[];
  valid: number;
  invalid: number;
}

export interface ImportOptions extends CsvLimits {
  map?: Record<string, string | null>;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function importable(model: Model<any, any>): FieldSpec[] {
  const no = new Set<string>(model.fileFields);
  if (model.tenant !== null) no.add(model.tenant);
  if (model.trashField !== null) no.add(model.trashField);
  for (const f of model.lockedFields) no.add(f);
  return model.fields.filter((f) => !no.has(f.name));
}

export function previewImport<T>(model: Model<T, any>, text: string | ImportTable, o: ImportOptions = {}): ImportPreview<T> {
  if (!(model instanceof Model)) throw new TypeError("previewImport: needs a model");
  const fields = importable(model);
  const byName = new Map(fields.map((f) => [f.name, f]));
  const { rows: cellsOf, lines } = typeof text === "string" ? table(text, o) : rowsOf(text, o);
  if (cellsOf.length === 0) throw new CsvError("the file is empty", 1);
  const first = lines[0]!;
  const headers = cellsOf[0]!.map((h) => h.trim());
  const mapping: Record<string, string | null> = {};
  const used = new Set<string>();
  for (const h of headers) {
    if (h === "") continue;
    if (Object.hasOwn(mapping, h)) throw new CsvError(`the column "${h}" appears twice`, first);
    let field: string | null;
    if (o.map && Object.hasOwn(o.map, h)) {
      field = o.map[h] ?? null;
      if (field !== null && !byName.has(field)) {
        throw new Error(`previewImport: "${h}" maps to \`${field}\`, which is not a field ${model.name} imports`);
      }
    } else {
      field = fields.find((f) => squash(f.name) === squash(h))?.name ?? null;
    }
    if (field !== null && used.has(field)) throw new Error(`previewImport: two columns map to \`${field}\``);
    if (field !== null) used.add(field);
    mapping[h] = field;
  }
  const missing = fields.filter((f) => !used.has(f.name) && !f.nullable && !f.default).map((f) => f.name);
  const rows: ImportRow<T>[] = [];
  let valid = 0;
  for (let r = 1; r < cellsOf.length; r++) {
    const cells = cellsOf[r]!;
    const row: Record<string, unknown> = {};
    const errors: ImportError[] = [];
    if (cells.length > headers.length && cells.slice(headers.length).some((c) => c.trim() !== "")) {
      errors.push({ message: `${cells.length} cells for ${headers.length} columns` });
    }
    headers.forEach((h, c) => {
      const field = h === "" ? null : mapping[h];
      if (!field) return;
      const spec = byName.get(field)!;
      const res = parseCell(spec, cells[c] ?? "");
      if ("error" in res) errors.push({ field, message: res.error });
      else if (res.value !== undefined) row[field] = res.value;
    });
    if (errors.length === 0) valid++;
    rows.push({ line: lines[r]!, row: row as Partial<T>, errors });
  }
  return { model: model.name, headers, mapping, missing, rows, valid, invalid: rows.length - valid };
}

function rowsOf(t: ImportTable, o: CsvLimits): ImportTable {
  if (!t || !Array.isArray(t.rows) || !Array.isArray(t.lines) || t.rows.length !== t.lines.length) {
    throw new TypeError("previewImport: a table is { rows, lines } of the same length");
  }
  const maxRows = o.maxRows ?? 100_000;
  const maxColumns = o.maxColumns ?? 200;
  const maxCell = o.maxCell ?? 100_000;
  if (t.rows.length > maxRows + 1) throw new CsvError(`more than ${maxRows} rows`, t.lines[maxRows + 1]!);
  t.rows.forEach((r, i) => {
    const line = t.lines[i]!;
    if (!Number.isInteger(line) || !Array.isArray(r) || !r.every((c) => typeof c === "string")) {
      throw new TypeError("previewImport: table rows are arrays of strings, lines whole numbers");
    }
    if (r.length > maxColumns) throw new CsvError(`more than ${maxColumns} columns`, line);
    if (r.some((c) => c.length > maxCell)) throw new CsvError(`a cell is longer than ${maxCell} characters`, line);
  });
  return t;
}

function parseCell(f: FieldSpec, raw: string): { value: unknown } | { error: string } {
  const s = f.kind === "text" ? raw : raw.trim();
  if (s === "") {
    if (f.default) return { value: undefined };
    if (f.nullable) return { value: null };
    if (f.kind === "text" && !literals(f.type)) return { value: "" };
    return { error: "is required" };
  }
  switch (f.kind) {
    case "text": {
      const allowed = literals(f.type);
      if (allowed && !allowed.includes(s)) return { error: `is one of ${allowed.join(", ")}` };
      return { value: s };
    }
    case "real":
      return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) && Number.isFinite(Number(s)) ? { value: Number(s) } : { error: "is not a number" };
    case "integer":
      return /^[-+]?\d+$/.test(s) ? { value: BigInt(s) } : { error: "is not a whole number" };
    case "bool": {
      const b = s.toLowerCase();
      if (["true", "yes", "1", "y"].includes(b)) return { value: true };
      if (["false", "no", "0", "n"].includes(b)) return { value: false };
      return { error: "is not yes or no" };
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return { error: "is not a date (YYYY-MM-DD)" };
      const d = new Date(s.replace(" ", "T"));
      return Number.isNaN(d.getTime()) ? { error: "is not a date" } : { value: d };
    }
    default:
      try {
        return { value: JSON.parse(s) as unknown };
      } catch {
        return { error: "is not valid JSON" };
      }
  }
}

function literals(type: string): string[] | null {
  const t = type.replace(/\s*\|\s*(null|undefined)\b/g, "").trim();
  const parts = t.split("|").map((p) => p.trim());
  if (!parts.every((p) => /^(["'])[^"']*\1$/.test(p))) return null;
  return parts.map((p) => p.slice(1, -1));
}

export interface ImportResult {
  created: number;
  refused: { line: number; reason: string }[];
}

export function commitImport<T>(scoped: ScopedModel<T, any>, preview: ImportPreview<T>, o: { all?: boolean; skipInvalid?: boolean } = {}): ImportResult {
  if (!(scoped instanceof ScopedModel) || scoped.model.name !== preview?.model) {
    throw new TypeError(`commitImport: pass ${preview?.model ?? "the model"}.as(user) and its preview`);
  }
  if (preview.missing.length) throw new Error(`commitImport: no column for ${preview.missing.join(", ")}`);
  const bad = preview.rows.filter((r) => r.errors.length > 0);
  if (bad.length && !o.skipInvalid) throw new Error(`commitImport: ${bad.length} rows have errors; fix them or pass skipInvalid`);
  const allowed = new Set(importable(scoped.model).map((f) => f.name));
  const all = o.all !== false;
  const refused: ImportResult["refused"] = [];
  let created = 0;
  const ROLLBACK = Symbol("rollback");
  try {
    transaction(() => {
      for (const r of preview.rows) {
        if (r.errors.length) continue;
        const row: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r.row as Record<string, unknown>)) {
          if (!allowed.has(k)) throw new Error(`commitImport: line ${r.line} sets \`${k}\`, which is not imported`);
          row[k] = v;
        }
        let reason: string | null = null;
        try {
          if (scoped.create(row as never) === undefined) reason = "not allowed";
        } catch (err) {
          reason = err instanceof Error && /duplicate|UNIQUE constraint/.test(err.message) ? "already exists" : err instanceof Error ? err.message : "failed";
        }
        if (reason === null) created++;
        else refused.push({ line: r.line, reason });
      }
      if (all && refused.length) throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
    return { created: 0, refused };
  }
  return { created, refused };
}
