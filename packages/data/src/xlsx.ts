import { crc32, inflateRawSync } from "node:zlib";

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxError";
  }
}

export interface XlsxOptions {
  sheet?: string | number;
  maxBytes?: number;
  maxUnzipped?: number;
  maxRows?: number;
  maxColumns?: number;
  maxCell?: number;
}

export interface XlsxSheet {
  rows: string[][];
  lines: number[];
  sheet: string;
  sheets: string[];
}

export function xlsxSheets(bytes: Uint8Array, o: Pick<XlsxOptions, "maxBytes" | "maxUnzipped"> = {}): string[] {
  const book = open(bytes, o);
  return workbook(book).sheets.map((s) => s.name);
}

export function readXlsx(bytes: Uint8Array, o: XlsxOptions = {}): XlsxSheet {
  const book = open(bytes, o);
  const wb = workbook(book);
  if (wb.sheets.length === 0) throw new XlsxError("the workbook has no sheets");
  let pick: Sheet | undefined;
  if (o.sheet === undefined) pick = wb.sheets[0];
  else if (typeof o.sheet === "number") pick = Number.isInteger(o.sheet) ? wb.sheets[o.sheet] : undefined;
  else pick = wb.sheets.find((s) => s.name === o.sheet);
  if (!pick) throw new XlsxError(`the workbook has no sheet ${typeof o.sheet === "string" ? `"${o.sheet}"` : o.sheet}`);
  if (!pick.worksheet) throw new XlsxError(`"${pick.name}" is not a sheet of cells`);
  const strings = wb.strings === null ? [] : sharedStrings(book.read(wb.strings), o.maxCell ?? 100_000);
  const dates = wb.styles === null ? new Set<number>() : dateStyles(book.read(wb.styles));
  const { rows, lines } = cells(book.read(pick.part), { strings, dates, date1904: wb.date1904 }, o);
  return { rows, lines, sheet: pick.name, sheets: wb.sheets.map((s) => s.name) };
}

interface Entry {
  method: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
}

interface Archive {
  has(name: string): boolean;
  read(name: string): string;
}

function open(bytes: Uint8Array, o: Pick<XlsxOptions, "maxBytes" | "maxUnzipped">): Archive {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("readXlsx: bytes is a Uint8Array");
  const maxBytes = o.maxBytes ?? 20_000_000;
  if (bytes.length > maxBytes) throw new XlsxError(`the file is over ${maxBytes} bytes`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => v.getUint16(at, true);
  const u32 = (at: number) => v.getUint32(at, true);
  const bad = (why: string): never => {
    throw new XlsxError(`not an .xlsx file (${why})`);
  };
  if (bytes.length < 22) bad("too short");
  if (u32(0) === 0xe011cfd0) bad("this is an .xls or an encrypted workbook: save it as .xlsx");
  if (u32(0) !== 0x04034b50) bad("not a zip archive");

  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) bad("no end of central directory");
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0) bad("a multi-disk archive");
  const count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdAt = u32(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdAt === 0xffffffff) bad("Zip64 is not read");
  if (cdAt + cdSize > eocd) bad("the central directory is out of range");

  const entries = new Map<string, Entry>();
  const dec = new TextDecoder("utf-8", { fatal: false });
  let p = cdAt;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || u32(p) !== 0x02014b50) bad("a damaged central directory");
    const flags = u16(p + 8);
    const nameLen = u16(p + 28);
    const end = p + 46 + nameLen + u16(p + 30) + u16(p + 32);
    if (end > eocd) bad("a damaged central directory");
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const e: Entry = { method: u16(p + 10), crc: u32(p + 16), csize: u32(p + 20), usize: u32(p + 24), offset: u32(p + 42) };
    if (e.csize === 0xffffffff || e.usize === 0xffffffff || e.offset === 0xffffffff) bad("Zip64 is not read");
    if (flags & 1) bad("an encrypted entry");
    const key = partKey(name);
    if (key !== null) {
      if (entries.has(key)) bad(`"${name}" appears twice`);
      entries.set(key, e);
    }
    p = end;
  }

  let budget = o.maxUnzipped ?? 100_000_000;
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  return {
    has: (name) => entries.has(name.toLowerCase()),
    read(name) {
      const e = entries.get(name.toLowerCase());
      if (!e) bad(`no part ${name}`);
      const { method, crc, csize, usize, offset } = e!;
      if (offset + 30 > bytes.length || u32(offset) !== 0x04034b50) bad(`a damaged entry ${name}`);
      const at = offset + 30 + u16(offset + 26) + u16(offset + 28);
      if (at + csize > bytes.length) bad(`a damaged entry ${name}`);
      if (usize > budget) throw new XlsxError(`the workbook unpacks to more than ${o.maxUnzipped ?? 100_000_000} bytes`);
      const raw = bytes.subarray(at, at + csize);
      let out: Uint8Array;
      if (method === 0) out = raw;
      else if (method === 8) {
        try {
          out = inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) });
        } catch {
          bad(`${name} does not unpack to its stated size`);
        }
      } else bad(`compression method ${method}`);
      if (out!.length !== usize) bad(`${name} does not unpack to its stated size`);
      if ((crc32(out!) >>> 0) !== crc) bad(`${name} fails its checksum`);
      budget -= usize;
      try {
        return utf8.decode(out!);
      } catch {
        bad(`${name} is not UTF-8`);
      }
      return "";
    },
  };
}

function partKey(name: string): string | null {
  const parts: string[] = [];
  for (const s of name.replace(/\\/g, "/").split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(s);
  }
  if (parts.length === 0 || name.endsWith("/")) return null;
  return parts.join("/").toLowerCase();
}

function resolve(from: string, target: string): string | null {
  const t = target.split("#")[0]!.split("?")[0]!;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null;
  const base = t.startsWith("/") ? "" : from.slice(0, from.lastIndexOf("/") + 1);
  return partKey(base + t);
}

type Tok =
  | { k: "open"; name: string; attrs: Record<string, string>; empty: boolean }
  | { k: "close"; name: string }
  | { k: "text"; text: string };

const NAME = /[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?/y;
const ATTR = /\s*([A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;

function* xml(src: string): Generator<Tok> {
  let i = 0;
  const fail = (why: string): never => {
    throw new XlsxError(`malformed XML: ${why}`);
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      if (src.slice(i).trim() !== "") yield { k: "text", text: entities(src.slice(i)) };
      return;
    }
    if (lt > i) yield { k: "text", text: entities(src.slice(i, lt)) };
    if (src.startsWith("<?", lt)) {
      const e = src.indexOf("?>", lt);
      if (e < 0) fail("an open processing instruction");
      i = e + 2;
    } else if (src.startsWith("<!--", lt)) {
      const e = src.indexOf("-->", lt);
      if (e < 0) fail("an open comment");
      i = e + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const e = src.indexOf("]]>", lt);
      if (e < 0) fail("an open CDATA section");
      yield { k: "text", text: src.slice(lt + 9, e) };
      i = e + 3;
    } else if (src[lt + 1] === "!") {
      throw new XlsxError("the workbook has a DOCTYPE or entity declaration, which is not read");
    } else if (src[lt + 1] === "/") {
      NAME.lastIndex = lt + 2;
      const m = NAME.exec(src);
      if (!m) fail("a closing tag without a name");
      const gt = src.indexOf(">", NAME.lastIndex);
      if (gt < 0 || src.slice(NAME.lastIndex, gt).trim() !== "") fail("an unclosed tag");
      yield { k: "close", name: local(m![0]) };
      i = gt + 1;
    } else {
      NAME.lastIndex = lt + 1;
      const m = NAME.exec(src);
      if (!m) fail("a tag without a name");
      let j = NAME.lastIndex;
      const attrs: Record<string, string> = Object.create(null);
      for (;;) {
        ATTR.lastIndex = j;
        const a = ATTR.exec(src);
        if (!a) break;
        attrs[a[1]!] = entities(a[2] ?? a[3] ?? "");
        j = ATTR.lastIndex;
      }
      while (j < src.length && /\s/.test(src[j]!)) j++;
      let empty = false;
      if (src[j] === "/") {
        empty = true;
        j++;
      }
      if (src[j] !== ">") fail(`an unclosed <${m![0]}>`);
      yield { k: "open", name: local(m![0]), attrs, empty };
      i = j + 1;
    }
  }
}

const local = (name: string) => name.slice(name.indexOf(":") + 1);

const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function entities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&([^;&\s]{0,10});?/g, (all, name: string) => {
    if (!all.endsWith(";")) throw new XlsxError("malformed XML: a bare &");
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!/^#(x[0-9a-f]+|\d+)$/i.test(name) || !(code >= 1 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) {
        throw new XlsxError(`malformed XML: &${name};`);
      }
      return String.fromCodePoint(code);
    }
    const v = PREDEFINED[name];
    if (v === undefined) throw new XlsxError(`malformed XML: unknown entity &${name};`);
    return v;
  });
}

const unescapeX = (s: string) => (s.includes("_x") ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : s);

function attr(attrs: Record<string, string>, name: string): string | undefined {
  if (attrs[name] !== undefined) return attrs[name];
  for (const k in attrs) if (local(k) === name && k.includes(":")) return attrs[k];
  return undefined;
}

interface Sheet {
  name: string;
  part: string;
  worksheet: boolean;
}

interface Book {
  sheets: Sheet[];
  strings: string | null;
  styles: string | null;
  date1904: boolean;
}

const RELTYPE = (type: string) => type.slice(type.lastIndexOf("/") + 1);

function rels(book: Archive, part: string): Map<string, { type: string; part: string | null }> {
  const dir = part.slice(0, part.lastIndexOf("/") + 1);
  const file = `${dir}_rels/${part.slice(dir.length)}.rels`;
  const out = new Map<string, { type: string; part: string | null }>();
  if (!book.has(file)) return out;
  for (const t of xml(book.read(file))) {
    if (t.k === "open" && t.name === "Relationship" && t.attrs.Id && t.attrs.Target !== undefined && t.attrs.TargetMode !== "External") {
      out.set(t.attrs.Id, { type: RELTYPE(t.attrs.Type ?? ""), part: resolve(part, t.attrs.Target) });
    }
  }
  return out;
}

function workbook(book: Archive): Book {
  const root = [...rels(book, "").values()].find((r) => r.type === "officeDocument");
  const part = root?.part ?? "xl/workbook.xml";
  if (!book.has(part)) throw new XlsxError("not an .xlsx file (no workbook)");
  const wbRels = rels(book, part);
  const sheets: Sheet[] = [];
  let date1904 = false;
  for (const t of xml(book.read(part))) {
    if (t.k !== "open") continue;
    if (t.name === "workbookPr") date1904 = t.attrs.date1904 === "1" || t.attrs.date1904 === "true";
    if (t.name === "sheet") {
      const r = wbRels.get(attr(t.attrs, "id") ?? "");
      if (!r || !r.part || !book.has(r.part)) throw new XlsxError(`the sheet "${t.attrs.name ?? ""}" has no part`);
      sheets.push({ name: t.attrs.name ?? "", part: r.part, worksheet: r.type === "worksheet" });
    }
  }
  const find = (type: string) => {
    const r = [...wbRels.values()].find((x) => x.type === type);
    return r?.part && book.has(r.part) ? r.part : null;
  };
  return { sheets, strings: find("sharedStrings"), styles: find("styles"), date1904 };
}

function sharedStrings(src: string, maxCell: number): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  let inT = false;
  let skip = 0;
  for (const t of xml(src)) {
    if (t.k === "open") {
      if (t.name === "si") {
        cur = [];
        if (t.empty) out.push("");
      } else if (t.name === "rPh" || t.name === "phoneticPr") skip += t.empty ? 0 : 1;
      else if (t.name === "t" && cur && skip === 0) inT = !t.empty;
    } else if (t.k === "close") {
      if (t.name === "si" && cur) {
        const s = unescapeX(cur.join(""));
        if (s.length > maxCell) throw new XlsxError(`a text cell is longer than ${maxCell} characters`);
        out.push(s);
        cur = null;
      } else if (t.name === "rPh" || t.name === "phoneticPr") skip = Math.max(0, skip - 1);
      else if (t.name === "t") inT = false;
    } else if (inT && cur) cur.push(t.text);
  }
  return out;
}

const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyles(src: string): Set<number> {
  const custom = new Map<number, string>();
  const xfs: number[] = [];
  let inXfs = false;
  for (const t of xml(src)) {
    if (t.k === "open" && t.name === "numFmt") custom.set(Number(t.attrs.numFmtId), t.attrs.formatCode ?? "");
    else if (t.k === "open" && t.name === "cellXfs") inXfs = !t.empty;
    else if (t.k === "close" && t.name === "cellXfs") inXfs = false;
    else if (t.k === "open" && t.name === "xf" && inXfs) xfs.push(Number(t.attrs.numFmtId ?? 0));
  }
  const out = new Set<number>();
  xfs.forEach((id, i) => {
    const code = custom.get(id);
    if (code !== undefined ? isDateFormat(code) : BUILTIN_DATES.has(id)) out.add(i);
  });
  return out;
}

function isDateFormat(code: string): boolean {
  const first = code.split(";")[0]!;
  if (/\[(h+|m+|s+)\]/i.test(first)) return false;
  const bare = first.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "").replace(/_.|\*./g, "");
  return /[dmyhs]/i.test(bare) && !/[0#?]/.test(bare.replace(/[.:]0+/g, ""));
}

interface CellContext {
  strings: string[];
  dates: Set<number>;
  date1904: boolean;
}

function cells(src: string, cx: CellContext, o: XlsxOptions): { rows: string[][]; lines: number[] } {
  const maxRows = o.maxRows ?? 100_000;
  const maxColumns = o.maxColumns ?? 200;
  const maxCell = o.maxCell ?? 100_000;
  const rows: string[][] = [];
  const lines: number[] = [];
  let rowNo = 0;
  let row: string[] = [];
  let col = 0;
  let cell: { col: number; type: string; style: number; ref: string } | null = null;
  let value: string[] | null = null;
  let inV = false;
  let inline: string[] | null = null;
  let inT = false;
  let skip = 0;
  let inData = false;

  const flush = () => {
    while (row.length > 0 && row[row.length - 1] === "") row.pop();
    if (row.length === 0) return;
    if (rows.length > maxRows) throw new XlsxError(`row ${rowNo}: the sheet has more than ${maxRows} rows`);
    rows.push(row);
    lines.push(rowNo);
  };

  for (const t of xml(src)) {
    if (t.k === "open") {
      switch (t.name) {
        case "sheetData":
          inData = !t.empty;
          break;
        case "row": {
          if (!inData) break;
          const r = t.attrs.r === undefined ? rowNo + 1 : Number(t.attrs.r);
          if (!Number.isInteger(r) || r <= rowNo || r > 1_048_576) throw new XlsxError(`row ${t.attrs.r}: out of order`);
          rowNo = r;
          row = [];
          col = 0;
          if (t.empty) flush();
          break;
        }
        case "c": {
          if (!inData) break;
          const ref = t.attrs.r;
          const c = ref === undefined ? col : column(ref, rowNo);
          col = c + 1;
          cell = { col: c, type: t.attrs.t ?? "n", style: Number(t.attrs.s ?? 0), ref: ref ?? `row ${rowNo}` };
          value = null;
          inline = null;
          if (t.empty) cell = null;
          break;
        }
        case "v":
          if (cell && !t.empty) {
            value = [];
            inV = true;
          }
          break;
        case "is":
          if (cell && !t.empty) inline = [];
          break;
        case "rPh":
        case "phoneticPr":
          if (!t.empty) skip++;
          break;
        case "t":
          if (inline && skip === 0) inT = !t.empty;
          break;
      }
    } else if (t.k === "close") {
      switch (t.name) {
        case "sheetData":
          inData = false;
          break;
        case "row":
          if (inData) flush();
          break;
        case "v":
          inV = false;
          break;
        case "t":
          inT = false;
          break;
        case "rPh":
        case "phoneticPr":
          skip = Math.max(0, skip - 1);
          break;
        case "c": {
          if (!cell) break;
          const v = cellText(cell, value === null ? null : value.join(""), inline, cx);
          if (v !== "") {
            if (cell.col >= maxColumns) throw new XlsxError(`${cell.ref}: the sheet has more than ${maxColumns} columns`);
            if (v.length > maxCell) throw new XlsxError(`${cell.ref}: the cell is longer than ${maxCell} characters`);
            while (row.length < cell.col) row.push("");
            row[cell.col] = v;
          }
          cell = null;
          value = null;
          inline = null;
          break;
        }
      }
    } else if (cell) {
      if (inV && value) value.push(t.text);
      else if (inline && inT) inline.push(t.text);
    }
  }
  return { rows, lines };
}

function column(ref: string, rowNo: number): number {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref);
  if (!m || Number(m[2]) !== rowNo) throw new XlsxError(`row ${rowNo}: a cell named "${ref}"`);
  let c = 0;
  for (const ch of m[1]!.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  if (c > 16_384) throw new XlsxError(`row ${rowNo}: a cell named "${ref}"`);
  return c - 1;
}

function cellText(cell: { type: string; style: number; ref: string }, v: string | null, inline: string[] | null, cx: CellContext): string {
  switch (cell.type) {
    case "s": {
      if (v === null) return "";
      const i = Number(v);
      const s = Number.isInteger(i) ? cx.strings[i] : undefined;
      if (s === undefined) throw new XlsxError(`${cell.ref}: no shared string ${v.trim()}`);
      return s;
    }
    case "inlineStr":
      return inline === null ? unescapeX(v ?? "") : unescapeX(inline.join(""));
    case "str":
      return unescapeX(v ?? "");
    case "b":
      return v === null ? "" : v.trim() === "1" || v.trim() === "true" ? "true" : "false";
    case "e":
      return (v ?? "").trim();
    case "d":
      return (v ?? "").trim();
    default: {
      if (v === null || v.trim() === "") return "";
      const n = Number(v);
      if (!Number.isFinite(n)) throw new XlsxError(`${cell.ref}: "${v}" is not a number`);
      return cx.dates.has(cell.style) ? serialDate(n, cx.date1904) : String(Number(n.toPrecision(15)));
    }
  }
}

const DAY = 86_400_000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

function serialDate(n: number, date1904: boolean): string {
  if (n < 0 || n > 2_958_465) return String(Number(n.toPrecision(15)));
  let ms = Math.round(n * 86_400) * 1000;
  if (!date1904 && n < 61) {
    if (n >= 60 && n < 61) return "1900-02-29";
    ms += DAY;
  }
  const d = new Date((date1904 ? EPOCH_1904 : EPOCH_1900) + ms);
  const iso = d.toISOString();
  if (n < 1) return iso.slice(11, 19);
  return ms % DAY === 0 ? iso.slice(0, 10) : iso.slice(0, 19);
}
