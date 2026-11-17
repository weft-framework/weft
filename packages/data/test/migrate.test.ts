import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel, migrate, planMigrations, useDatabase, type Model } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

const asList = (...ms: unknown[]) => ms as Model<unknown>[];

function seed() {
  const db = openSqlite(":memory:");
  const Author = defineModel("Author", { fields: { id: "string", name: "string" }, read: () => true, write: () => true });
  const Post = defineModel("Post", {
    fields: { id: "string", author: "string", title: "string", score: "string", draft: "boolean | null" },
    attrs: { author: { ref: "Author" }, title: { unique: true } },
    read: () => true,
    write: () => true,
  });
  useDatabase(db, [Author, Post] as Model<never>[]);
  Author.as({}).create({ id: "a1", name: "Ann" });
  Post.as({}).create({ id: "p1", author: "a1", title: "Hello", score: "4.5", draft: null });
  Post.as({}).create({ id: "p2", author: "a1", title: "World", score: "2", draft: true });
  return { db, Author };
}

const rows = (db: ReturnType<typeof openSqlite>, sql: string) => db.prepare(sql).all().map((r) => ({ ...(r as object) }));

test("@renamed renames the column in place, with its index", () => {
  const { db, Author } = seed();
  const Post = defineModel("Post", {
    fields: { id: "string", author: "string", heading: "string", score: "string", draft: "boolean | null" },
    attrs: { author: { ref: "Author" }, heading: { unique: true, renamed: "title" } },
  });
  const plan = migrate(db, asList(Author, Post));
  assert.deepEqual(plan.steps.map((s) => s.sql), [
    `ALTER TABLE "Post" RENAME COLUMN "title" TO "heading"`,
    `DROP INDEX "Post_title_key"`,
    `CREATE UNIQUE INDEX "Post_heading_key" ON "Post" ("heading")`,
  ]);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(rows(db, `SELECT id, heading FROM "Post" ORDER BY id`), [
    { id: "p1", heading: "Hello" },
    { id: "p2", heading: "World" },
  ]);
  assert.deepEqual(migrate(db, asList(Author, Post)).steps, [], "a second run has nothing to do");
  assert.throws(() => db.exec(`INSERT INTO "Post" VALUES ('p3', 'a1', 'Hello', '1', NULL)`), /UNIQUE/);
});

test("drops and conversions wait for --allow-destructive, then rebuild", () => {
  const { db, Author } = seed();
  const Post = defineModel("Post", {
    fields: { id: "string", author: "string", title: "string", score: "number" },
    attrs: { author: { ref: "Author" }, title: { unique: true } },
  });
  const safe = planMigrations(db, asList(Author, Post));
  assert.deepEqual(safe.steps, []);
  assert.deepEqual(safe.warnings, [
    "Post.score: column is TEXT, model needs REAL (`weft migrate --allow-destructive` converts it)",
    "Post.draft: column is no longer declared; left in place (`weft migrate --allow-destructive` drops it)",
  ]);
  const plan = migrate(db, asList(Author, Post), { destructive: true });
  assert.deepEqual(plan.rebuilt, ["Post"]);
  assert.deepEqual(plan.steps.map((s) => s.sql), [
    `CREATE TABLE "_weft_rebuild_Post" ("id" TEXT PRIMARY KEY NOT NULL, "author" TEXT NOT NULL REFERENCES "Author"("id"), "title" TEXT NOT NULL, "score" REAL NOT NULL) STRICT`,
    `INSERT INTO "_weft_rebuild_Post" ("id", "author", "title", "score") SELECT "id", "author", "title", CAST("score" AS REAL) FROM "Post" ORDER BY rowid`,
    `DROP TABLE "Post"`,
    `ALTER TABLE "_weft_rebuild_Post" RENAME TO "Post"`,
    `CREATE INDEX "Post_author_idx" ON "Post" ("author")`,
    `CREATE UNIQUE INDEX "Post_title_key" ON "Post" ("title")`,
  ]);
  assert.deepEqual(rows(db, `SELECT id, score FROM "Post" ORDER BY id`), [
    { id: "p1", score: 4.5 },
    { id: "p2", score: 2 },
  ]);
  assert.equal(Number((db.prepare("PRAGMA foreign_keys").all()[0] as { foreign_keys: number }).foreign_keys), 1);
  assert.throws(() => db.exec(`INSERT INTO "Post" VALUES ('p3', 'nobody', 'x', 1)`), /FOREIGN KEY/);
  assert.throws(() => db.exec(`DELETE FROM "Author"`), /FOREIGN KEY/);
  assert.deepEqual(migrate(db, asList(Author, Post), { destructive: true }).steps, []);
});

test("nullability follows the model; tightening waits for the NULLs to go", () => {
  const { db, Author } = seed();
  const strict = defineModel("Post", {
    fields: { id: "string", author: "string", title: "string", score: "string", draft: "boolean" },
    attrs: { author: { ref: "Author" }, title: { unique: true } },
  });
  const blocked = planMigrations(db, asList(Author, strict));
  assert.deepEqual(blocked.steps, []);
  assert.deepEqual(blocked.warnings, ["Post.draft: has NULLs, so it stays nullable"]);
  db.exec(`UPDATE "Post" SET draft = 0 WHERE draft IS NULL`);
  assert.deepEqual(migrate(db, asList(Author, strict)).rebuilt, ["Post"]);
  assert.throws(() => db.exec(`UPDATE "Post" SET draft = NULL`), /NOT NULL/);
  const loose = defineModel("Post", {
    fields: { id: "string", author: "string", title: "string | null", score: "string" },
    attrs: { author: { ref: "Author" }, title: { unique: true } },
  });
  const plan = migrate(db, asList(Author, loose));
  assert.deepEqual(plan.rebuilt, ["Post"]);
  db.exec(`UPDATE "Post" SET title = NULL WHERE id = 'p1'`);
  assert.deepEqual(rows(db, `SELECT id, title, draft FROM "Post" ORDER BY id`), [
    { id: "p1", title: null, draft: 0 },
    { id: "p2", title: "World", draft: 1 },
  ]);
});

test("a rebuild that would break references rolls back", () => {
  const { db } = seed();
  const Author = defineModel("Author", { fields: { id: "string", name: "string", age: "number | null" } });
  const Post = defineModel("Post", {
    fields: { id: "string", author: "string", title: "string", score: "string" },
    attrs: { author: { ref: "Author" }, title: { unique: true } },
  });
  db.exec(`PRAGMA foreign_keys = OFF`);
  db.exec(`UPDATE "Post" SET author = 'gone' WHERE id = 'p2'`);
  db.exec(`PRAGMA foreign_keys = ON`);
  assert.throws(() => migrate(db, asList(Author, Post), { destructive: true }), /break foreign keys/);
  assert.deepEqual(rows(db, `SELECT name FROM pragma_table_info('Post') ORDER BY cid`).map((r) => (r as { name: string }).name), [
    "id",
    "author",
    "title",
    "score",
    "draft",
  ]);
  assert.equal(rows(db, `SELECT 1 FROM pragma_table_info('Author') WHERE name = 'age'`).length, 0, "nothing applied");
});
