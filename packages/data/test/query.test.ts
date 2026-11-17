import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel, useDatabase, type Model, type PolicyExpr } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface User {
  id: string;
  name: string;
}
interface Doc {
  id: string;
  owner: string;
  title: string;
  n: number;
  done: boolean;
  at: Date;
  note: string | null;
  meta: { tag: string };
}
interface Comment {
  id: string;
  doc: string;
  text: string;
  author: string;
}

type Actor = { id: string };
const OWN: PolicyExpr = { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } };

function models(sql: boolean) {
  const Users = defineModel<User>("User", {
    fields: { id: "string", name: "string" },
    read: (_a, u) => u.id !== "hidden",
    write: () => true,
  });
  const Docs = defineModel<Doc>("Doc", {
    fields: {
      id: "string",
      owner: "string",
      title: "string",
      n: "number",
      done: "boolean",
      at: "Date",
      note: "string | null",
      meta: "{ tag: string }",
    },
    attrs: { owner: { ref: "User" } },
    read: (a: Actor, d) => d.owner === a.id,
    write: (a: Actor, d) => d.owner === a.id && d.n < 100,
    readWhere: OWN,
    writeWhere: OWN,
  });
  const Comments = defineModel<Comment>("Comment", {
    fields: { id: "string", doc: "string", text: "string", author: "string" },
    attrs: { doc: { ref: "Doc" }, author: { ref: "User" } },
    read: (_a, c) => !c.text.includes("secret"),
    write: () => true,
  });
  if (sql) {
    useDatabase(openSqlite(":memory:"), [Users, Docs, Comments] as Model<never>[]);
  }
  const anyone = { id: "root" };
  for (const id of ["ann", "bob", "hidden"]) Users.as(anyone).create({ id, name: id.toUpperCase() });
  const day = (d: number) => new Date(Date.UTC(2026, 0, d));
  const rows: [string, string, string, number, boolean, number, string | null, string][] = [
    ["d1", "ann", "alpha", 3, false, 5, null, "x"],
    ["d2", "ann", "beta", 1, true, 2, "n", "y"],
    ["d3", "bob", "gamma", 2, false, 9, null, "x"],
    ["d4", "ann", "Älpha", 5, false, 1, "m", "x"],
    ["d5", "ann", "delta", 2, true, 7, null, "y"],
    ["d6", "bob", "eps", 4, true, 3, "k", "x"],
    ["d7", "ann", "😀 emoji", 6, false, 4, null, "x"],
    ["d8", "ann", " private", 0, false, 6, null, "y"],
  ];
  for (const [id, owner, title, n, done, d, note, tag] of rows) {
    Docs.as({ id: owner }).create({ id, owner, title, n, done, at: day(d), note, meta: { tag } });
  }
  const cs: [string, string, string, string][] = [
    ["c1", "d1", "first", "bob"],
    ["c2", "d1", "second", "hidden"],
    ["c3", "d1", "a secret", "ann"],
    ["c4", "d2", "on beta", "ann"],
    ["c5", "d3", "bob's own", "bob"],
    ["c6", "d1", "third", "ann"],
  ];
  for (const [id, doc, text, author] of cs) Comments.as(anyone).create({ id, doc, text, author });
  return { Users, Docs, Comments, ann: Docs.as({ id: "ann" }) };
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

for (const sql of [false, true]) {
  const name = sql ? "sqlite" : "memory";

  test(`${name}: where, orderBy, limit and offset stay inside the read rule`, () => {
    const { ann } = models(sql);
    assert.deepEqual(ids(ann.query().all()), ["d1", "d2", "d4", "d5", "d7", "d8"]);
    assert.deepEqual(ids(ann.query().where({ done: false }).orderBy("n", "desc").all()), ["d7", "d4", "d1", "d8"]);
    assert.deepEqual(ids(ann.query().where({ n: 2 }).all()), ["d5"]);
    assert.deepEqual(ids(ann.query().where({ n: { gte: 1, lt: 4 } }).orderBy("n").all()), ["d2", "d5", "d1"]);
    assert.deepEqual(ids(ann.query().where({ id: { in: ["d3", "d6", "d2"] } }).all()), ["d2"]);
    assert.deepEqual(ids(ann.query().where({ note: null }).all()), ["d1", "d5", "d7", "d8"]);
    assert.deepEqual(ids(ann.query().where({ note: { ne: null } }).all()), ["d2", "d4"]);
    assert.deepEqual(ids(ann.query().where({ note: { in: [null, "m"] } }).all()), ["d1", "d4", "d5", "d7", "d8"]);
    assert.deepEqual(ids(ann.query().where({ $not: { note: { lt: "n" } } }).all()), ["d1", "d2", "d5", "d7", "d8"]);
    assert.deepEqual(ids(ann.query().where({ $or: [{ n: 1 }, { title: { startsWith: "de" } }] }).all()), ["d2", "d5"]);
    assert.deepEqual(ids(ann.query().where({ title: { contains: "lph" } }).all()), ["d1", "d4"]);
    assert.deepEqual(ids(ann.query().where({ at: { gt: new Date(Date.UTC(2026, 0, 4)) } }).orderBy("at").all()), [
      "d1",
      "d8",
      "d5",
    ]);
    assert.deepEqual(ids(ann.query().where({ meta: { eq: { tag: "y" } } }).all()), ["d2", "d5", "d8"]);
    const byN = ann.query().orderBy("n");
    assert.deepEqual(ids(byN.limit(2).all()), ["d8", "d2"]);
    assert.deepEqual(ids(byN.offset(2).limit(2).all()), ["d5", "d1"]);
    assert.deepEqual(ids(byN.offset(5).all()), ["d7"]);
    assert.equal(byN.limit(0).all().length, 0);
    assert.equal(ann.query().where({ done: true }).count(), 2);
    assert.equal(ann.query().where({ owner: "bob" }).exists(), false);
    assert.equal(ann.query().orderBy("at", "desc").first()?.id, "d5");
  });

  test(`${name}: text orders by code point, ties keep insertion order`, () => {
    const { ann } = models(sql);
    assert.deepEqual(
      ann.query().orderBy("title").all().map((d) => d.title),
      ["alpha", "beta", "delta", "Älpha", " private", "😀 emoji"],
    );
    assert.deepEqual(ids(ann.query().orderBy("done").orderBy("n", "desc").all()), ["d7", "d4", "d1", "d8", "d5", "d2"]);
    assert.deepEqual(ids(ann.query().where({ title: { gt: "" } }).all()), ["d7", "d8"]);
  });

  test(`${name}: select and relations go through each model's own rules`, () => {
    const { ann, Users, Comments } = models(sql);
    const rows = ann
      .query()
      .where({ id: { in: ["d1", "d2"] } })
      .select("id", "title")
      .with("by", Users, "owner")
      .withMany("comments", Comments, "doc", (q) =>
        q.orderBy("id", "desc").limit(2).select("id", "author").with("who", Users, "author"),
      )
      .all();
    assert.deepEqual(rows, [
      {
        id: "d1",
        title: "alpha",
        by: { id: "ann", name: "ANN" },
        comments: [
          { id: "c6", author: "ann", who: { id: "ann", name: "ANN" } },
          { id: "c2", author: "hidden", who: null },
        ],
      },
      { id: "d2", title: "beta", by: { id: "ann", name: "ANN" }, comments: [{ id: "c4", author: "ann", who: { id: "ann", name: "ANN" } }] },
    ]);
    assert.notEqual(rows[0].by, rows[1].by);
    const back = Comments.as({ id: "ann" }).query().where({ id: "c5" }).with("doc_", ann.model, "doc").first();
    assert.equal(back?.doc_, null);
  });

  test(`${name}: update and delete through a query respect the write rule`, () => {
    const { ann, Docs } = models(sql);
    assert.equal(ann.query().where({ done: false }).update({ note: "seen" }), 4, "bob's d3 is unreachable");
    assert.equal(ann.get("d1")?.note, "seen");
    assert.equal(ann.query().update({ n: 500 }), 0);
    assert.equal(Docs.as({ id: "bob" }).get("d3")?.note, null);
    assert.throws(() => ann.query().update({ id: "x" } as never), /cannot be updated/);
    assert.equal(ann.query().where({ id: { ne: "d2" } }).orderBy("n").limit(2).delete(), 2);
    assert.deepEqual(ids(ann.query().orderBy("n").all()), ["d2", "d1", "d4", "d7"]);
    assert.equal(ann.query().where({ owner: "bob" }).delete(), 0);
    assert.equal(Docs.as({ id: "bob" }).all().length, 2);
  });
}

test("filters are checked against the model", () => {
  const { ann } = models(false);
  assert.throws(() => ann.query().where({ titel: "x" } as never), /no field `titel`/);
  assert.throws(() => ann.query().where({ id: undefined }), /undefined/);
  assert.throws(() => ann.query().where({ n: { between: 1 } } as never), /unknown filter operator/);
  assert.throws(() => ann.query().where({ title: { contains: 1 } } as never), /takes a string/);
  assert.throws(() => ann.query().orderBy("meta"), /JSON field/);
  assert.throws(() => ann.query().limit(-1), /non-negative/);
  assert.throws(() => ann.query().with("title", ann.model, "owner"), /already taken/);
});

test("the SQL driver filters and pages in the database", () => {
  const db = openSqlite(":memory:");
  const seen: string[] = [];
  const traced = {
    exec: (s: string) => db.exec(s),
    prepare: (s: string) => {
      seen.push(s);
      return db.prepare(s);
    },
  };
  const Docs = defineModel<{ id: string; owner: string; n: number }>("Doc", {
    fields: { id: "string", owner: "string", n: "number" },
    read: (a: Actor, d) => d.owner === a.id,
    write: (a: Actor, d) => d.owner === a.id,
    readWhere: OWN,
  });
  useDatabase(traced, [Docs] as Model<never>[]);
  for (let i = 0; i < 100; i++) Docs.as({ id: i % 2 ? "a" : "b" }).create({ id: `r${i}`, owner: i % 2 ? "a" : "b", n: i });
  seen.length = 0;
  const page = Docs.as({ id: "a" }).query().where({ n: { gte: 50 } }).orderBy("n", "desc").limit(5).all();
  assert.deepEqual(page.map((r) => r.n), [99, 97, 95, 93, 91]);
  const q = seen.find((s) => s.startsWith("SELECT"))!;
  assert.match(q, /WHERE \("owner" IS \?\) AND \(\("n" IS NOT NULL AND "n" >= \?\)\)/);
  assert.match(q, /ORDER BY "n" DESC, rowid LIMIT \? OFFSET \?$/);
  const sneaky = defineModel<{ id: string; owner: string; n: number }>("Sneaky", {
    fields: { id: "string", owner: "string", n: "number" },
    read: (_a, d) => d.n % 3 === 0,
    write: () => true,
  });
  useDatabase(traced, [sneaky] as Model<never>[]);
  for (let i = 0; i < 100; i++) sneaky.as({}).create({ id: `s${i}`, owner: "x", n: i });
  assert.deepEqual(
    sneaky.as({}).query().orderBy("n").offset(10).limit(3).all().map((r) => r.n),
    [30, 33, 36],
  );
  assert.equal(sneaky.as({}).query().count(), 34);
});
