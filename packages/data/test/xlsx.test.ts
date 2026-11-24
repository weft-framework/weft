import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import { commitImport, defineModel, previewImport } from "../src/index.ts";
import { readXlsx, xlsxSheets, XlsxError } from "../src/xlsx.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test("a sheet reads as rows of text, row numbers as Excel shows them", () => {
  const s = readXlsx(fixture("contacts.xlsx"));
  assert.equal(s.sheet, "Contacts");
  assert.deepEqual(s.sheets, ["Contacts", "Second"]);
  assert.deepEqual(s.rows, [
    ["Name", "E-mail", "Age", "Joined", "Active", "Score"],
    ["Ada Lovelace", "ada@example.com", "36", "2024-03-15", "true", "0.1"],
    ["Grace & <Hopper>", "grace@example.com", "45", "2023-03-15T12:00:00", "false", "#DIV/0!"],
    ["Ada Lovelace", '=HYPERLINK("x")', "", "xy", "", "1234567.25", "Žluťoučký kůň"],
  ]);
  assert.deepEqual(s.lines, [1, 2, 3, 5], "the blank row 4 is skipped");
  assert.deepEqual(readXlsx(fixture("contacts.xlsx"), { sheet: "Second" }).rows, [["only"], ["here"]]);
  assert.deepEqual(readXlsx(fixture("contacts.xlsx"), { sheet: 1 }).rows, [["only"], ["here"]]);
  assert.throws(() => readXlsx(fixture("contacts.xlsx"), { sheet: "Nope" }), /no sheet "Nope"/);
  assert.throws(() => readXlsx(fixture("contacts.xlsx"), { sheet: 2 }), /no sheet 2/);
  assert.deepEqual(xlsxSheets(fixture("contacts.xlsx")), ["Contacts", "Second"]);
});

test("the 1904 date system", () => {
  const rows = readXlsx(fixture("contacts-1904.xlsx")).rows;
  assert.equal(rows[1]![3], "2028-03-16");
  assert.equal(rows[2]![3], "2027-03-16T12:00:00");
});

test("Excel's own empty workbook reads as no rows", () => {
  const s = readXlsx(fixture("empty-excel.xlsx"));
  assert.deepEqual([s.rows, s.lines, s.sheets.length], [[], [], 1]);
});

test("an import from a sheet: types checked per cell, the write rule decides each row", () => {
  interface Person {
    id: string;
    name: string;
    email: string;
    age: number | null;
    joined: Date | null;
    active: boolean;
  }
  const People = defineModel<Person>("XlsxPerson", {
    fields: { id: "string", name: "string", email: "string", age: "number | null", joined: "Date | null", active: "boolean" },
    read: () => true,
    write: (_u, row) => !row.name.startsWith("Grace"),
  });
  const s = readXlsx(fixture("contacts.xlsx"));
  s.rows[0]!.push("Note", "Id");
  s.rows.slice(1).forEach((r, i) => (r[7] = `p${i}`));
  s.rows[3]![3] = "";
  s.rows[3]![4] = "true";
  const preview = previewImport(People, s, { map: { "E-mail": "email", Score: null, Note: null } });
  assert.deepEqual(preview.missing, []);
  assert.deepEqual(
    preview.rows.map((r) => [r.line, r.errors.map((e) => e.field)]),
    [[2, []], [3, []], [5, []]],
  );
  assert.equal((preview.rows[0]!.row.joined as Date).toISOString(), "2024-03-15T00:00:00.000Z");
  assert.equal(preview.rows[0]!.row.age, 36);
  assert.equal(preview.rows[2]!.row.email, '=HYPERLINK("x")', "text, never evaluated");
  const r = commitImport(People.as({ id: "u" }), preview, { all: false });
  assert.equal(r.created, 2);
  assert.equal(r.refused.length, 1, "Grace's row is refused by the write rule");
  assert.throws(() => previewImport(People, { rows: [["a"]], lines: [] }), /same length/);
  assert.throws(() => previewImport(People, { rows: [["a", "b"]], lines: [1] }, { maxColumns: 1 }), /more than 1 columns/);
});

interface Part {
  name: string;
  data: string | Uint8Array;
  store?: boolean;
  crc?: number;
  usize?: number;
}

function zip(parts: Part[], o: { zip64?: boolean } = {}): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let at = 0;
  for (const p of parts) {
    const raw = typeof p.data === "string" ? Buffer.from(p.data) : Buffer.from(p.data);
    const body = p.store ? raw : deflateRawSync(raw);
    const name = Buffer.from(p.name);
    const crc = p.crc ?? crc32(raw);
    const usize = p.usize ?? raw.length;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(p.store ? 0 : 8, 8);
    h.writeUInt32LE(crc >>> 0, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(usize, 22);
    h.writeUInt16LE(name.length, 26);
    local.push(h, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(p.store ? 0 : 8, 10);
    c.writeUInt32LE(crc >>> 0, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(usize, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(at, 42);
    central.push(c, name);
    at += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(o.zip64 ? 0xffff : parts.length, 8);
  e.writeUInt16LE(o.zip64 ? 0xffff : parts.length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(at, 16);
  return new Uint8Array(Buffer.concat([...local, cd, e]));
}

const WB =
  '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
const WB_RELS = '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
const book = (sheet: string, extra: Part[] = []) =>
  zip([
    { name: "xl/workbook.xml", data: WB },
    { name: "xl/_rels/workbook.xml.rels", data: WB_RELS },
    { name: "xl/worksheets/sheet1.xml", data: `<worksheet><sheetData>${sheet}</sheetData></worksheet>` },
    ...extra,
  ]);
const row = (r: number, cells: string) => `<row r="${r}">${cells}</row>`;
const inl = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;

test("a minimal workbook without the package rels, and _xHHHH_ escapes", () => {
  const s = readXlsx(book(row(1, inl("A1", "a_x000D_b") + '<c r="C1"><v>1e21</v></c>') + row(3, '<c t="b"><v>1</v></c>')));
  assert.deepEqual(s.rows, [["a\rb", "", "1e+21"], ["true"]]);
  assert.deepEqual(s.lines, [1, 3]);
});

test("not a workbook: legacy files, other archives, damaged and Zip64 archives", () => {
  const ole = new Uint8Array(512);
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.throws(() => readXlsx(ole), /\.xls or an encrypted workbook/);
  assert.throws(() => readXlsx(new TextEncoder().encode("name,email\nAda,a@x\n".repeat(3))), /not a zip archive/);
  assert.throws(() => readXlsx(zip([{ name: "a.txt", data: "hi" }])), /no workbook/);
  const ok = book(row(1, inl("A1", "x")));
  assert.throws(() => readXlsx(ok.subarray(0, ok.length - 5)), /no end of central directory/);
  assert.throws(() => readXlsx(zip([{ name: "xl/workbook.xml", data: WB }], { zip64: true })), /Zip64/);
  assert.throws(() => readXlsx(new Uint8Array(3) as never), XlsxError);
  assert.throws(() => readXlsx("PK" as never), TypeError);
});

test("checksums, sizes and the unpacked budget: a zip bomb is refused before it fills memory", () => {
  const sheet = (n: number) => `<worksheet><sheetData>${row(1, inl("A1", "x".repeat(n)))}</sheetData></worksheet>`;
  const parts = (s: Part): Part[] => [{ name: "xl/workbook.xml", data: WB }, { name: "xl/_rels/workbook.xml.rels", data: WB_RELS }, s];
  assert.throws(() => readXlsx(zip(parts({ name: "xl/worksheets/sheet1.xml", data: sheet(10), crc: 1 }))), /checksum/);
  const bomb = sheet(50_000_000);
  assert.throws(() => readXlsx(zip(parts({ name: "xl/worksheets/sheet1.xml", data: bomb, usize: 100 }))), /stated size/);
  assert.throws(() => readXlsx(zip(parts({ name: "xl/worksheets/sheet1.xml", data: bomb }))), /cell is longer than 100000/);
  assert.throws(() => readXlsx(zip(parts({ name: "xl/worksheets/sheet1.xml", data: bomb })), { maxUnzipped: 1_000_000 }), /unpacks to more than 1000000/);
  assert.throws(() => readXlsx(book(row(1, inl("A1", "x"))), { maxBytes: 100 }), /over 100 bytes/);
});

test("XML: no DOCTYPE, no entities beyond the five, nothing fetched or expanded", () => {
  const lol = '<!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><worksheet><sheetData>' + row(1, inl("A1", "&b;")) + "</sheetData></worksheet>";
  const xxe = '<!DOCTYPE x [<!ENTITY f SYSTEM "file:///etc/passwd">]><worksheet/>';
  for (const evil of [lol, xxe]) {
    assert.throws(
      () => readXlsx(zip([{ name: "xl/workbook.xml", data: WB }, { name: "xl/_rels/workbook.xml.rels", data: WB_RELS }, { name: "xl/worksheets/sheet1.xml", data: evil }])),
      /DOCTYPE/,
    );
  }
  assert.throws(() => readXlsx(book(row(1, inl("A1", "&nbsp;")))), /unknown entity/);
  assert.throws(() => readXlsx(book(row(1, inl("A1", "a & b")))), /bare &/);
  assert.throws(() => readXlsx(book(row(1, inl("A1", "&#0;")))), /malformed/);
  assert.deepEqual(readXlsx(book(row(1, inl("A1", "&#x17D;&#382;&lt;")))).rows, [["Žž<"]]);
});

test("parts are opened only inside the archive, by the names the workbook gives", () => {
  const rels = (target: string) => `<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="${target}"/></Relationships>`;
  const sheet = { name: "xl/worksheets/sheet1.xml", data: `<worksheet><sheetData>${row(1, inl("A1", "in"))}</sheetData></worksheet>` };
  const with_ = (target: string) => zip([{ name: "xl/workbook.xml", data: WB }, { name: "xl/_rels/workbook.xml.rels", data: rels(target) }, sheet]);
  assert.deepEqual(readXlsx(with_("../xl/./worksheets/sheet1.xml")).rows, [["in"]]);
  assert.deepEqual(readXlsx(with_("/XL/Worksheets/Sheet1.xml")).rows, [["in"]], "part names ignore case");
  assert.throws(() => readXlsx(with_("../../../etc/passwd")), /has no part/);
  assert.throws(() => readXlsx(with_("file:///etc/passwd")), /has no part/);
  assert.throws(() => readXlsx(zip([{ name: "a", data: "1" }, { name: "./a", data: "2" }])), /appears twice/);
});

test("limits on rows, columns and cells name the cell", () => {
  const many = Array.from({ length: 5 }, (_, i) => row(i + 1, inl(`A${i + 1}`, "x"))).join("");
  assert.throws(() => readXlsx(book(many), { maxRows: 3 }), /row 5: the sheet has more than 3 rows/);
  assert.deepEqual(readXlsx(book(many), { maxRows: 4 }).rows.length, 5, "the header and 4 rows");
  assert.throws(() => readXlsx(book(row(1, inl("D1", "x"))), { maxColumns: 3 }), /D1: the sheet has more than 3 columns/);
  assert.deepEqual(readXlsx(book(row(1, inl("A1", "x") + '<c r="XFD1" s="1"/>')), { maxColumns: 3 }).rows, [["x"]], "empty styled cells far out are fine");
  assert.throws(() => readXlsx(book(row(1, inl("B1", "xxxx"))), { maxCell: 3 }), /B1: the cell is longer than 3/);
  assert.throws(() => readXlsx(book(row(2, inl("A2", "x")) + row(1, inl("A1", "x")))), /out of order/);
  assert.throws(() => readXlsx(book(row(1, inl("A2", "x")))), /a cell named "A2"/);
  assert.throws(() => readXlsx(book(row(1, '<c r="A1" t="s"><v>0</v></c>'))), /A1: no shared string 0/);
});

test("writeXlsx round-trips through readXlsx: text, numbers, escaping, blanks, sheet name", async () => {
  const { writeXlsx, readXlsx, xlsxSheets } = await import("../src/xlsx.ts");
  const bytes = writeXlsx(
    [["number", "total", "note"], ["INV-1", 1250, "a & <b> \"q\""], ["INV-2", -3.5, null], ["=SUM(A1)", 0, "ctl\u0001x"]],
    { sheet: "inv/2026:Q1" },
  );
  assert.deepEqual(xlsxSheets(bytes), ["inv 2026 Q1"]);
  const sheet = readXlsx(bytes);
  assert.deepEqual(sheet.rows[0], ["number", "total", "note"]);
  assert.deepEqual(sheet.rows[1], ["INV-1", "1250", "a & <b> \"q\""]);
  assert.equal(sheet.rows[2]![1], "-3.5");
  assert.equal(sheet.rows[3]![0], "=SUM(A1)", "text stays text, never a formula");
  assert.equal(sheet.rows[3]![2], "ctlx");
});

test("writeXlsx keeps the old string form and can skip the header style", async () => {
  const { writeXlsx, xlsxSheets } = await import("../src/xlsx.ts");
  assert.deepEqual(xlsxSheets(writeXlsx([["a"]], "export")), ["export"]);
  const plain = Buffer.from(writeXlsx([["a"], ["b"]], { header: false }));
  assert.ok(plain.length > 0);
  assert.deepEqual(xlsxSheets(writeXlsx([])), ["Sheet1"]);
  assert.throws(() => writeXlsx("x" as never), /rows is an array/);
});
