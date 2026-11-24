import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel, defineSearch, migrate, searchWords, transaction, useDatabase } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Doc {
  id: string;
  owner: string;
  title: string;
  body: string;
  secret: string;
}

function docs() {
  return defineModel<Doc>("Doc", {
    fields: { id: "string", owner: "string", title: "string", body: "string", secret: "string" },
    read: (actor, row) => actor === row.owner || actor === "admin",
    write: (actor, row) => actor === row.owner,
  });
}

const DATA: [string, string, string, string][] = [
  ["d1", "ada", "Quarterly report", "Revenue grew in the third quarter. Report attached."],
  ["d2", "ada", "Příliš žluťoučký kůň", "Úpěl ďábelské ódy"],
  ["d3", "ada", "Lunch menu", "Soup, report on the salad bar"],
  ["d4", "bob", "Report report report report", "Bob's private report about the merger"],
  ["d5", "ada", "Report", "A very long body that mentions nothing much at all except padding words to make it long long long"],
  ["d6", "ada", "Merger notes", "Draft"],
];

function fill(m: ReturnType<typeof docs>) {
  for (const [id, owner, title, body] of DATA) m.as(owner).create({ id, owner, title, body, secret: `secret-${id} merger` });
}

const search = (m: ReturnType<typeof docs>) => defineSearch(m, { fields: { title: 3, body: 1 } });

function check(m: ReturnType<typeof docs>, s: ReturnType<typeof search>) {
  const ada = m.as("ada");
  let r = s.search(ada, "report");
  assert.deepEqual(r.terms, ["report"]);
  assert.deepEqual(r.hits.map((h) => h.row.id), ["d1", "d5", "d3"]);
  assert.equal(r.total, 3, "Bob's document is not counted");
  assert.ok(r.hits[0]!.score > r.hits[2]!.score);
  assert.deepEqual(s.search(ada, "merger").hits.map((h) => h.row.id), ["d6"]);
  assert.deepEqual(s.search(m.as("bob"), "merger").hits.map((h) => h.row.id), ["d4"]);
  assert.equal(s.search(m.as("mallory"), "report").total, 0);
  assert.equal(s.search(ada, "secret").total, 0);
  assert.equal(s.search(ada, "ada").total, 0);
  assert.deepEqual(s.search(ada, "PRILIS zlutoucky").hits.map((h) => h.row.id), ["d2"]);
  assert.deepEqual(s.search(ada, "ďábelské").hits.map((h) => h.row.id), ["d2"]);
  assert.deepEqual(s.search(ada, "report quart").hits.map((h) => h.row.id), ["d1"]);
  assert.deepEqual(s.search(ada, "quarterl").hits.map((h) => h.row.id), ["d1"]);
  assert.equal(s.search(ada, "quart report salad").total, 0);
  assert.ok(s.search(m.as("admin"), "report").hits.some((h) => h.row.id === "d4"));
  const scores = () => s.search(ada, "report").hits.map((h) => [h.row.id, h.score]);
  const before = scores();
  const d4 = m.as("bob").get("d4")!;
  assert.equal(m.as("bob").delete((d) => d.id === "d4"), 1);
  assert.deepEqual(scores(), before);
  m.as("bob").create(d4);
  r = s.search(ada, "report", { limit: 2, offset: 1 });
  assert.deepEqual(r.hits.map((h) => h.row.id), ["d5", "d3"]);
  assert.equal(r.total, 3);
  assert.deepEqual(s.search(ada.query().where({ title: "Lunch menu" }), "report").hits.map((h) => h.row.id), ["d3"]);

  for (const q of [
    'secret:merger',
    'title:report OR secret:merger',
    '"report',
    "report NOT quarterly",
    "NEAR(report merger)",
    "report*",
    "^report",
    "(report",
    "{secret}: merger",
    "' OR 1=1 --",
    "\u0000report",
  ]) {
    const x = s.search(ada, q);
    for (const h of x.hits) assert.equal(h.row.owner, "ada", q);
    assert.ok(!x.hits.some((h) => h.row.id === "d4"), q);
  }
  assert.equal(s.search(ada, "!!! ???").total, 0);
  assert.equal(s.search(ada, "").total, 0);
  assert.equal(s.terms("a ".repeat(100)).length, 1, "repeats dropped");
  assert.equal(s.terms(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ")).length, 12, "at most maxTerms");
  assert.equal(s.terms("x".repeat(500))[0]!.length, 64);
}

test("search in memory", () => {
  const m = docs();
  fill(m);
  check(m, search(m));
});

test("search in SQLite through FTS5, kept current by writes", () => {
  const db = openSqlite(":memory:");
  const m = docs();
  useDatabase(db, [m as never]);
  fill(m);
  const s = search(m).use(db);
  check(m, s);
  const ada = m.as("ada");
  ada.update((d) => d.id === "d6", { body: "Zebra crossing" });
  assert.deepEqual(s.search(ada, "zebra").hits.map((h) => h.row.id), ["d6"]);
  assert.equal(s.search(ada, "draft").total, 0);
  ada.delete((d) => d.id === "d6");
  assert.equal(s.search(ada, "zebra").total, 0);
  assert.throws(() =>
    transaction(() => {
      ada.create({ id: "d7", owner: "ada", title: "Yak shaving", body: "", secret: "" });
      assert.equal(s.search(ada, "yak").total, 1);
      throw new Error("undo");
    }),
  );
  assert.equal(s.search(ada, "yak").total, 0);
  const n = (sql: string) => (db.prepare(sql).all() as { n: number }[])[0]!.n;
  assert.equal(n(`SELECT count(*) AS n FROM "Doc__search" WHERE "Doc__search" MATCH '"report"'`), 4);
  search(m).use(db);
  const titles = defineSearch(m, { fields: { title: 1 } }).use(db);
  assert.equal(titles.search(ada, "revenue").total, 0, "body no longer indexed");
  assert.equal(titles.search(ada, "quarterly").total, 1);
  const m2 = defineModel<Omit<Doc, "secret"> & { secret: string | null }>("Doc", {
    fields: { id: "string", owner: "string", title: "string", body: "string", secret: "string | null" },
    read: (actor, row) => actor === row.owner,
    write: (actor, row) => actor === row.owner,
  });
  const triggers = () => n(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'Doc__search_%'`);
  assert.equal(triggers(), 3);
  migrate(db, [m2 as never]);
  assert.equal(triggers(), 0, "the rebuild dropped them");
  useDatabase(db, [m2 as never]);
  const s2 = defineSearch(m2, { fields: { title: 3, body: 1 } }).use(db);
  assert.equal(triggers(), 3);
  assert.deepEqual(s2.search(m2.as("ada"), "report").hits.map((h) => h.row.id), ["d1", "d5", "d3"]);
  m2.as("ada").create({ id: "d8", owner: "ada", title: "Xylophone", body: "", secret: null });
  assert.equal(s2.search(m2.as("ada"), "xylophone").total, 1);
});

test("search declarations and words", () => {
  const m = docs();
  assert.throws(() => defineSearch(m, { fields: {} }), /at least one field/);
  assert.throws(() => defineSearch(m, { fields: { nope: 1 } as never }), /no field/);
  assert.throws(() => defineSearch(m, { fields: { title: 0 } }), /weight/);
  assert.throws(() => defineSearch(m, { fields: { title: 1 }, maxTerms: 0 }), /maxTerms/);
  const n = defineModel<{ id: string; n: number }>("N", { fields: { id: "string", n: "number" } });
  assert.throws(() => defineSearch(n, { fields: { n: 1 } }), /not a text field/);
  assert.throws(() => defineSearch(m, { fields: { title: 1 } }).use(openSqlite(":memory:")), /useDatabase/);
  assert.throws(() => defineSearch(m, { fields: { title: 1 } }).search(docs().as("ada"), "x"), /another model/);
  assert.deepEqual(searchWords("Příliš, žluťoučký-kůň 42!"), ["prilis", "zlutoucky", "kun", "42"]);

  const p = docs();
  p.as("ada").create({ id: "a", owner: "ada", title: "", body: "kiwi " + "pad ".repeat(30), secret: "" });
  p.as("ada").create({ id: "z", owner: "ada", title: "", body: "kiwi pad", secret: "" });
  assert.deepEqual(defineSearch(p, { fields: { body: 1 } }).search(p.as("ada"), "kiwi").hits.map((h) => h.row.id), ["z", "a"]);

  const s = defineSearch(m, { fields: { title: 1 } });
  assert.deepEqual(s.highlight("Quarterly report, Report!", "report"), [
    { text: "Quarterly ", match: false },
    { text: "report", match: true },
    { text: ", ", match: false },
    { text: "Report", match: true },
    { text: "!", match: false },
  ]);
  assert.deepEqual(s.highlight("Příliš kůň", "prilis"), [
    { text: "Příliš", match: true },
    { text: " kůň", match: false },
  ]);
  assert.deepEqual(s.highlight("<b>x</b>", ""), [{ text: "<b>x</b>", match: false }]);
  assert.deepEqual(s.highlight(null, "x"), []);
});

test("match: any finds rows with some of the terms, ranks rows with more terms first, in memory and SQLite", () => {
  const mem = docs();
  fill(mem);
  const db = openSqlite(":memory:");
  const sql = docs();
  useDatabase(db, [sql as never]);
  fill(sql);
  for (const [m, s] of [[mem, search(mem)], [sql, search(sql).use(db)]] as const) {
    const ada = m.as("ada");
    assert.equal(s.search(ada, "salad merger").total, 0, "all terms by default");
    const any = s.search(ada, "salad merger", { match: "any" });
    assert.deepEqual(any.hits.map((h) => h.row.id).sort(), ["d3", "d6"]);
    assert.equal(any.total, 2, "Bob's merger report stays unreadable");
    const both = s.search(ada, "lunch salad merger", { match: "any" });
    assert.equal(both.hits[0]!.row.id, "d3", "two matching terms outrank one");
    assert.deepEqual(s.search(ada, "salad", { match: "all" }).hits.map((h) => h.row.id), ["d3"]);
    assert.throws(() => s.search(ada, "x", { match: "some" as never }), /match is "all" or "any"/);
  }
});
