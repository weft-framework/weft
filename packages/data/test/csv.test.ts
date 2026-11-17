import { test } from "node:test";
import assert from "node:assert/strict";
import { commitImport, CsvError, defineModel, parseCsv, previewImport, toCsv, useDatabase, type Model } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

test("parseCsv: quotes, doubled quotes, newlines in cells, CRLF, BOM, blank lines", () => {
  const text = '﻿name,note\r\n"Ada, Countess","said ""hi""\nthen left"\r\n\r\nBob,\n';
  assert.deepEqual(parseCsv(text), [["name", "note"], ["Ada, Countess", 'said "hi"\nthen left'], ["Bob", ""]]);
  assert.deepEqual(parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]], "semicolons guessed from the header");
  assert.deepEqual(parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a,b\n1;2", { delimiter: "," }), [["a", "b"], ["1;2"]]);
  assert.deepEqual(parseCsv(""), []);
});

test("parseCsv: malformed input and limits are errors with a line", () => {
  assert.throws(() => parseCsv('a\n"open'), (e: unknown) => e instanceof CsvError && e.line === 2 && /not closed/.test(e.message));
  assert.throws(() => parseCsv('a\n"x"y'), /after a closing quote/);
  assert.throws(() => parseCsv('a\nx"y'), /quote inside/);
  assert.throws(() => parseCsv("a\n1\n2\n3", { maxRows: 2 }), /more than 2 rows/);
  assert.throws(() => parseCsv("a,b,c", { maxColumns: 2 }), /more than 2 columns/);
  assert.throws(() => parseCsv("a\nxxxxx", { maxCell: 3 }), (e: unknown) => e instanceof CsvError && e.line === 2);
  assert.throws(() => parseCsv("abcdef", { maxBytes: 3 }), /over 3 characters/);
});

test("toCsv: quoting, types, and cells a spreadsheet would run", () => {
  const rows = [
    { name: "Ada, Countess", n: -5, ok: true, at: new Date(Date.UTC(2026, 0, 2)), tags: ["a"], note: '=HYPERLINK("x")' },
    { name: "@SUM(A1)", n: 0, ok: false, at: null, tags: null, note: "-1+2" },
  ];
  const csv = toCsv(rows, ["name", "n", "ok", "at", "tags", { field: "note", header: "Note \"quoted\"" }]);
  assert.equal(
    csv,
    'name,n,ok,at,tags,"Note ""quoted"""\r\n' +
      '"Ada, Countess",-5,true,2026-01-02T00:00:00.000Z,"[""a""]","\'=HYPERLINK(""x"")"\r\n' +
      "'@SUM(A1),0,false,,,'-1+2\r\n",
  );
  assert.ok(toCsv([], ["name"], { bom: true }).startsWith("﻿name"));
  assert.throws(() => toCsv(rows, []), /columns/);
  assert.equal(parseCsv(csv)[1]![0], "Ada, Countess");
});

interface Contact {
  id: string;
  org: string;
  owner: string;
  name: string;
  email: string | null;
  age: number | null;
  vip: boolean;
  stage: "lead" | "customer";
  born: Date | null;
  meta: { source: string } | null;
  photo: string | null;
  deletedAt: number | null;
  created: number;
}

function contacts(): Model<Contact, "created" | "deletedAt" | "photo"> {
  return defineModel<Contact, "created" | "deletedAt" | "photo">("Contact", {
    fields: {
      id: "string",
      org: "string",
      owner: "string",
      name: "string",
      email: "string | null",
      age: "number | null",
      vip: "boolean",
      stage: '"lead" | "customer"',
      born: "Date | null",
      meta: "{ source: string } | null",
      photo: "File | null",
      deletedAt: "number | null",
      created: "number",
    },
    attrs: { org: { tenant: true }, deletedAt: { softDelete: true }, created: { default: () => 1 }, photo: { default: () => null } },
    read: () => true,
    write: (a: { id: string }, r) => r.owner === a.id && !r.vip,
  });
}

const ada = { id: "ada", tenant: "acme" };

test("previewImport: mapping by name or map, per-type parsing, errors by line", () => {
  const m = contacts();
  const text =
    "ID,Owner,Full name,E-mail,Age,VIP,Stage,Born,Meta,Org,Photo,Ignored\n" +
    'c1,ada,Ada,ada@x.io,36,no,lead,1815-12-10,"{""source"":""web""}",evil,f1,zzz\n' +
    "c2,ada,Bob,,abc,maybe,prospect,10/12/1815,{bad,,,\n" +
    '"c3",ada,"Multi\nline",,,yes,customer,,,,,\n';
  const p = previewImport(m, text, { map: { "Full name": "name", "E-mail": "email", Ignored: null } });
  assert.deepEqual(p.mapping, {
    ID: "id",
    Owner: "owner",
    "Full name": "name",
    "E-mail": "email",
    Age: "age",
    VIP: "vip",
    Stage: "stage",
    Born: "born",
    Meta: "meta",
    Org: null,
    Photo: null,
    Ignored: null,
  }, "tenant and file columns are never imported");
  assert.deepEqual(p.missing, []);
  assert.equal(p.valid, 2);
  assert.equal(p.invalid, 1);
  const [r1, r2, r3] = p.rows;
  assert.deepEqual(r1!.row, { id: "c1", owner: "ada", name: "Ada", email: "ada@x.io", age: 36, vip: false, stage: "lead", born: new Date("1815-12-10"), meta: { source: "web" } });
  assert.equal(r1!.line, 2);
  assert.deepEqual(r2!.errors.map((e) => `${e.field}: ${e.message}`), [
    "age: is not a number",
    "vip: is not yes or no",
    "stage: is one of lead, customer",
    "born: is not a date (YYYY-MM-DD)",
    "meta: is not valid JSON",
  ]);
  assert.equal(r2!.row.email, null, "a row with errors keeps what parsed");
  assert.equal(r3!.line, 4);
  assert.equal(r3!.row.name, "Multi\nline");
  assert.equal(r3!.row.email, null, "empty nullable cells are null");
  assert.equal("created" in r3!.row, false, "empty cells for fields with defaults are left out");
});

test("previewImport: missing columns, duplicate columns, bad maps", () => {
  const m = contacts();
  assert.deepEqual(previewImport(m, "id,name\nx,y").missing, ["owner", "vip", "stage"]);
  assert.throws(() => previewImport(m, "id,id\n1,2"), /appears twice/);
  assert.throws(() => previewImport(m, "a,b\n1,2", { map: { a: "id", b: "id" } }), /two columns map to `id`/);
  assert.throws(() => previewImport(m, "a\n1", { map: { a: "org" } }), /not a field Contact imports/);
  assert.throws(() => previewImport(m, "a\n1", { map: { a: "deletedAt" } }), /not a field/);
  assert.throws(() => previewImport(m, ""), /empty/);
  const p = previewImport(m, "id,owner,name,vip,stage\nx,ada,y,no,lead,extra");
  assert.match(p.rows[0]!.errors[0]!.message, /6 cells for 5 columns/);
});

for (const driver of ["memory", "sqlite"] as const) {
  const make = () => {
    const m = contacts();
    if (driver === "sqlite") useDatabase(openSqlite(":memory:"), [m as Model<never>]);
    return m;
  };
  const head = "id,owner,name,vip,stage\n";

  test(`${driver}: commitImport writes through the rule, all or nothing`, () => {
    const m = make();
    const ok = previewImport(m, head + "c1,ada,Ada,no,lead\nc2,ada,Bea,no,customer\n");
    assert.deepEqual(commitImport(m.as(ada), ok), { created: 2, refused: [] });
    assert.deepEqual(m.as(ada).all().map((c) => [c.id, c.org, c.created]), [["c1", "acme", 1], ["c2", "acme", 1]], "the importer's tenant, defaults filled");

    const mixed = previewImport(m, head + "c3,ada,Cy,no,lead\nc4,bob,Dee,no,lead\nc5,ada,Eve,yes,lead\nc1,ada,Dup,no,lead\n");
    const r = commitImport(m.as(ada), mixed);
    assert.equal(r.created, 0);
    assert.deepEqual(r.refused, [
      { line: 3, reason: "not allowed" },
      { line: 4, reason: "not allowed" },
      { line: 5, reason: "already exists" },
    ]);
    assert.equal(m.as(ada).all().length, 2, "nothing from the failed import");
    const partial = commitImport(m.as(ada), mixed, { all: false });
    assert.equal(partial.created, 1);
    assert.equal(m.as(ada).get("c3")!.name, "Cy");
  });
}

test("commitImport: errors first, the right model, and no smuggled fields", () => {
  const m = contacts();
  const bad = previewImport(m, "id,owner,name,vip,stage\nc1,ada,A,no,lead\nc2,ada,B,maybe,lead\n");
  assert.throws(() => commitImport(m.as(ada), bad), /1 rows have errors/);
  assert.equal(commitImport(m.as(ada), bad, { skipInvalid: true }).created, 1);
  assert.throws(() => commitImport(m.as(ada), previewImport(m, "id,name\nx,y")), /no column for owner, vip, stage/);
  const other = defineModel<{ id: string }>("Other", { fields: { id: "string" }, read: () => true, write: () => true });
  assert.throws(() => commitImport(other.as(ada) as never, bad), /pass Contact.as/);
  const forged = previewImport(m, "id,owner,name,vip,stage\nc9,ada,A,no,lead\n");
  (forged.rows[0]!.row as Record<string, unknown>).org = "evil";
  assert.throws(() => commitImport(m.as(ada), forged), /sets `org`/);
  (forged.rows[0]!.row as Record<string, unknown>).org = undefined;
  delete (forged.rows[0]!.row as Record<string, unknown>).org;
  (forged.rows[0]!.row as Record<string, unknown>).deletedAt = 5;
  assert.throws(() => commitImport(m.as(ada), forged), /sets `deletedAt`/);
  assert.equal(m.as(ada).get("c9"), undefined);
});
