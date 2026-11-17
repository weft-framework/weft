import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel, defineTable, onRead, useDatabase, type SqlDatabase } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Order {
  id: number;
  owner: string;
  customer: string;
  status: string;
  total: number;
  paid: boolean;
  placed: Date;
  secret: string;
}

function orders() {
  return defineModel<Order>("Order", {
    fields: {
      id: "number",
      owner: "string",
      customer: "string",
      status: '"open" | "paid" | "void"',
      total: "number",
      paid: "boolean",
      placed: "Date",
      secret: "string",
    },
    read: (actor, row) => actor === row.owner,
    write: (actor, row) => actor === row.owner,
  });
}

const CUSTOMERS = ["Acme", "Příliš s.r.o.", "Bolt", "acme labs", "Zeta"];

function fill(model: ReturnType<typeof orders>) {
  for (let i = 60; i >= 1; i--) {
    const owner = i % 4 === 0 ? "bob" : "ada";
    model.as(owner).create({
      id: i,
      owner,
      customer: CUSTOMERS[i % CUSTOMERS.length]!,
      status: ["open", "paid", "void"][i % 3]!,
      total: (i * 37) % 100,
      paid: i % 2 === 0,
      placed: new Date(Date.UTC(2026, 10, 1 + (i % 20), 12)),
      secret: `s${i}`,
    });
  }
}

function table(model: ReturnType<typeof orders>) {
  return defineTable(model, {
    columns: {
      customer: { sort: true, search: true, filter: "text" },
      status: { filter: { options: ["open", "paid", "void"] } },
      total: { sort: true, filter: "number" },
      paid: { filter: "boolean" },
      placed: { sort: true, filter: "date" },
      owner: { hidden: true },
    },
    sort: ["placed", "desc"],
    pageSize: 10,
    sizes: [10, 25],
  });
}

const u = (q: string) => new URL(`http://app.test/orders${q}`);

function check(model: ReturnType<typeof orders>) {
  const t = table(model);
  const ada = model.as("ada");
  const mine = ada.all();
  assert.equal(mine.length, 45);

  let v = t.view(ada, u(""));
  assert.equal(v.total, 45);
  assert.equal(v.pages, 5);
  assert.equal(v.page, 1);
  assert.equal(v.rows.length, 10);
  assert.ok(v.rows.every((r) => r.owner === undefined || r.owner === "ada"));
  assert.deepEqual(v.columns, ["customer", "status", "total", "paid", "placed"]);
  assert.equal(v.rows[0]!.secret, undefined, "fields outside the columns are not loaded");
  const byPlaced = [...mine].sort((a, b) => b.placed.getTime() - a.placed.getTime() || a.id - b.id);
  assert.deepEqual(v.rows.map((r) => r.id), byPlaced.slice(0, 10).map((r) => r.id));
  const seen: number[] = [];
  for (let p = 1; p <= v.pages; p++) seen.push(...t.view(ada, u(`?page=${p}`)).rows.map((r) => r.id!));
  assert.deepEqual(seen, byPlaced.map((r) => r.id));

  v = t.view(ada, u("?sort=total&dir=desc&size=25&page=2"));
  assert.deepEqual([v.sort, v.dir, v.size, v.page, v.pages], ["total", "desc", 25, 2, 2]);
  const byTotal = [...mine].sort((a, b) => b.total - a.total || a.id - b.id);
  assert.deepEqual(v.rows.map((r) => r.id), byTotal.slice(25, 50).map((r) => r.id));
  assert.equal(v.ariaSort("total"), "descending");
  assert.equal(v.ariaSort("customer"), "none");

  v = t.view(ada, u("?q=ACME"));
  assert.equal(v.total, mine.filter((r) => /acme/i.test(r.customer)).length);
  assert.ok(v.total > 0);
  v = t.view(ada, u("?q=prilis"));
  assert.equal(v.total, mine.filter((r) => r.customer.startsWith("Příliš")).length);
  assert.equal(t.view(ada, u("?q=s1")).total, 0, "the secret is not searched");
  assert.equal(t.view(ada, u("?q=bob")).total, 0, "nor the hidden owner (not a search column)");

  v = t.view(ada, u("?f.status=open&f.status=void"));
  assert.deepEqual(v.filters, { status: ["open", "void"] });
  assert.equal(v.total, mine.filter((r) => r.status !== "paid").length);
  v = t.view(ada, u("?f.total.min=20&f.total.max=40"));
  assert.equal(v.total, mine.filter((r) => r.total >= 20 && r.total <= 40).length);
  v = t.view(ada, u("?f.paid=true"));
  assert.equal(v.total, mine.filter((r) => r.paid).length);
  v = t.view(ada, u("?f.placed.min=2026-11-05&f.placed.max=2026-11-06"));
  assert.equal(v.total, mine.filter((r) => r.placed >= new Date("2026-11-05") && r.placed < new Date("2026-11-07")).length, "a date maximum includes the day");
  assert.ok(v.total > 0);
  v = t.view(ada, u("?f.customer=BOLT"));
  assert.equal(v.total, mine.filter((r) => r.customer === "Bolt").length);

  const plain = t.view(ada, u("")).rows.map((r) => r.id);
  for (const q of [
    "?sort=secret",
    "?sort=owner",
    "?sort=__proto__",
    "?f.secret=s1",
    "?f.secret.min=a",
    "?f.status=nope",
    "?f.total.min=abc&f.total.max=1e999",
    "?f.placed.min=yesterday",
    "?f.paid=yes",
    "?size=1000",
    "?size=-1",
    "?page=0",
    "?page=abc",
    "?page=1.5",
    "?cols=secret",
  ]) {
    const x = t.view(ada, u(q));
    assert.equal(x.total, 45, q);
    if (!q.startsWith("?cols")) assert.deepEqual(x.rows.map((r) => r.id), plain, q);
    assert.equal(x.rows[0]!.secret, undefined, q);
  }
  assert.equal(t.view(ada, u("?page=999")).page, 5, "past the end: the last page");
  assert.equal(t.view(ada, u(`?q=${"a".repeat(5000)}`)).q.length, 200);
  assert.equal(t.view(ada, u("?f.status=open&f.status=open&f.status=open&f.status=paid&f.status=void&f.status=x")).filters.status!.length, 3);

  v = t.view(ada, u("?cols=owner,total"));
  assert.deepEqual(v.columns, ["total", "owner"]);
  assert.equal(v.rows[0]!.owner, "ada");
  assert.equal(v.rows[0]!.customer, undefined);
  assert.equal(v.rows[0]!.id !== undefined, true, "the key is always loaded");

  v = t.view(ada, u("?tab=2&sort=total&page=2&f.status=open"));
  assert.equal(v.link({}), "?tab=2&sort=total&dir=asc&f.status=open&page=2");
  assert.equal(v.link({ page: 4 }), "?tab=2&sort=total&dir=asc&f.status=open&page=4");
  assert.equal(v.sortLink("total"), "?tab=2&sort=total&dir=desc&f.status=open");
  assert.equal(v.sortLink("customer"), "?tab=2&sort=customer&dir=asc&f.status=open");
  assert.equal(v.link({ filter: { status: null, total: { min: "5" } } }), "?tab=2&sort=total&dir=asc&f.total.min=5");
  assert.equal(v.link({ q: "x y", sort: null }), "?tab=2&q=x+y&f.status=open");
  assert.equal(v.link({ cols: ["total"] }), "?tab=2&sort=total&dir=asc&cols=total&f.status=open&page=2");
  assert.equal(v.link({ size: 25 }), "?tab=2&sort=total&dir=asc&size=25&f.status=open");
  const again = t.view(ada, u(v.link({ size: 25, filter: { paid: false } })));
  assert.deepEqual([again.size, again.sort, again.filters], [25, "total", { status: ["open"], paid: false }]);

  assert.equal(t.view(ada.query().where({ status: "open" }), u("")).total, mine.filter((r) => r.status === "open").length);
  assert.equal(t.view(model.as("bob"), u("")).total, 15);
  assert.equal(t.view(model.as("mallory"), u("")).total, 0);
  assert.equal(t.view(model.as("mallory"), u("")).pages, 1);
}

test("a table in memory", () => {
  const m = orders();
  fill(m);
  check(m);
});

test("a table in SQLite: the same results, sorted, filtered and projected in SQL", () => {
  const db = openSqlite(":memory:");
  const sql: string[] = [];
  const spy: SqlDatabase = {
    exec: (s) => db.exec(s),
    prepare: (s) => {
      sql.push(s);
      return db.prepare(s);
    },
  } as SqlDatabase;
  const m = orders();
  useDatabase(spy, [m as never]);
  fill(m);
  check(m);
  sql.length = 0;
  table(m).view(m.as("ada"), u("?sort=total&f.status=open&f.paid=true&f.total.min=10"));
  const select = sql.filter((s) => /^SELECT/i.test(s)).join("\n");
  assert.match(select, /ORDER BY/i);
  assert.match(select, /"status" IN/i);
  assert.match(select, /"total" >=/i);
  assert.match(select, /"owner"/, "the read rule is in the query too");
});

test("a view's reads are watched for live pages", () => {
  const m = orders();
  fill(m);
  const reads: unknown[] = [];
  const stop = onRead((model, actor) => reads.push([model.name, actor]));
  try {
    table(m).view(m.as("ada"), u("?q=acme"));
  } finally {
    stop();
  }
  assert.deepEqual(reads[0], ["Order", "ada"]);
});

test("table declarations are checked", () => {
  const m = orders();
  assert.throws(() => defineTable(m, { columns: {} }), /at least one column/);
  assert.throws(() => defineTable(m, { columns: { nope: {} } as never }), /no field `nope`/);
  assert.throws(() => defineTable(m, { columns: { total: { filter: "date" } } }), /needs a date field/);
  assert.throws(() => defineTable(m, { columns: { customer: { filter: "number" } } }), /needs a real or integer field/);
  assert.throws(() => defineTable(m, { columns: { paid: { filter: "text" } } }), /needs a text field/);
  assert.throws(() => defineTable(m, { columns: { status: { filter: { options: [] } } } }), /options/);
  assert.throws(() => defineTable(m, { columns: { status: { filter: { options: ["a", "a"] } } } }), /options/);
  assert.throws(() => defineTable(m, { columns: { status: { filter: "x" as never } } }), /filter is/);
  assert.throws(() => defineTable(m, { columns: { total: { hidden: true, always: true } } }), /hidden and always/);
  assert.throws(() => defineTable(m, { columns: { total: {} }, sort: ["nope" as never, "asc"] }), /sort by/);
  assert.throws(() => defineTable(m, { columns: { total: {} }, pageSize: 0 }), /page sizes/);
  assert.throws(() => defineTable(m, { columns: { total: {} }, pageSize: 10, sizes: [25] }), /include pageSize/);
  assert.throws(() => defineTable(m, { columns: { total: {} }, prefix: "Orders" }), /prefix/);
  assert.throws(() => defineTable(m, { columns: { total: {} }, fields: ["nope" as never] }), /no field/);
  const other = orders();
  assert.throws(() => defineTable(m, { columns: { total: {} } }).view(other.as("ada"), u("")), /another model/);
});

test("two tables on one page keep their own parameters", () => {
  const m = orders();
  fill(m);
  const a = defineTable(m, { columns: { total: { sort: true } }, prefix: "a.", pageSize: 5 });
  const b = defineTable(m, { columns: { total: { sort: true } }, prefix: "b.", pageSize: 5 });
  const url = u("?a.page=2&b.sort=total&b.dir=desc");
  const va = a.view(m.as("ada"), url);
  const vb = b.view(m.as("ada"), url);
  assert.deepEqual([va.page, va.sort], [2, ""]);
  assert.deepEqual([vb.page, vb.sort, vb.dir], [1, "total", "desc"]);
  assert.equal(va.link({ page: 3 }), "?b.sort=total&b.dir=desc&a.page=3");
  assert.equal(vb.sortLink("total"), "?a.page=2&b.sort=total&b.dir=asc");
});
