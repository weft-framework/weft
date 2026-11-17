import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel, planMigrations, useDatabase, type Model } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface User {
  handle: string;
  email: string;
  joined: number;
}
interface Post {
  id: string;
  author: string;
  title: string;
}

let n = 0;
function models() {
  const User = defineModel<User, "joined">("User", {
    fields: { handle: "string", email: "string", joined: "number" },
    attrs: { handle: { id: true }, email: { unique: true }, joined: { default: () => 1000 + n++ } },
    read: () => true,
    write: (actor: { admin: boolean }, row) => actor.admin || row.joined >= 1000,
  });
  const Post = defineModel<Post, "id">("Post", {
    fields: { id: "string", author: "string", title: "string" },
    attrs: { id: { default: () => `p${n++}` }, author: { ref: "User" }, title: { index: true } },
    read: () => true,
    write: () => true,
  });
  return { User, Post };
}

for (const backend of ["memory", "sqlite"] as const) {
  const open = () => {
    const m = models();
    if (backend === "sqlite") {
      useDatabase(openSqlite(":memory:"), [m.User, m.Post] as Model<never>[]);
    }
    return m;
  };

  test(`${backend}: @id picks the key and @default fills missing fields`, () => {
    const { User, Post } = open();
    assert.equal(User.key, "handle");
    const u = User.as({ admin: false }).create({ handle: "ada", email: "ada@example.test" });
    assert.ok(u && u.joined >= 1000, "default computed");
    assert.equal(User.as({ admin: false }).get("ada")?.email, "ada@example.test");
    const kept = User.as({ admin: true }).create({ handle: "bob", email: "b@example.test", joined: 7 });
    assert.equal(kept?.joined, 7, "a given value wins over the default");
    assert.equal(User.as({ admin: false }).create({ handle: "eve", email: "e@example.test", joined: 1 }), undefined);
    const p = Post.as({}).create({ author: "ada", title: "Hello" });
    assert.match(p?.id ?? "", /^p\d+$/);
  });

  test(`${backend}: @unique rejects a second row with the same value`, () => {
    const { User } = open();
    const users = User.as({ admin: true });
    users.create({ handle: "ada", email: "same@example.test" });
    assert.throws(() => users.create({ handle: "ada2", email: "same@example.test" }));
    users.create({ handle: "bob", email: "bob@example.test" });
    assert.throws(() => users.update((u) => u.handle === "bob", { email: "same@example.test" }));
    assert.equal(users.update((u) => u.handle === "bob", { email: "bob@example.test" }), 1, "own value is fine");
  });
}

test("sqlite: @ref is a foreign key; @unique/@index/@ref are indexed", () => {
  const db = openSqlite(":memory:");
  const { User, Post } = models();
  const plan = useDatabase(db, [User, Post] as Model<never>[]);
  const sql = plan.steps.map((s) => s.sql).join("\n");
  assert.match(sql, /"author" TEXT NOT NULL REFERENCES "User"\("handle"\)/);
  assert.match(sql, /CREATE UNIQUE INDEX "User_email_key" ON "User" \("email"\)/);
  assert.match(sql, /CREATE INDEX "Post_author_idx" ON "Post" \("author"\)/);
  assert.match(sql, /CREATE INDEX "Post_title_idx" ON "Post" \("title"\)/);
  assert.deepEqual(planMigrations(db, [User, Post] as Model<unknown>[]).steps, [], "indexes are idempotent");

  assert.throws(() => Post.as({}).create({ author: "nobody", title: "x" }), /FOREIGN KEY/);
  User.as({ admin: true }).create({ handle: "ada", email: "a@example.test" });
  Post.as({}).create({ author: "ada", title: "x" });
  assert.throws(() => User.as({ admin: true }).delete((u) => u.handle === "ada"), /FOREIGN KEY/);
});

test("attributes are validated", () => {
  assert.throws(
    () =>
      defineModel("X", {
        fields: { a: "string", b: "string" },
        attrs: { a: { id: true }, b: { id: true } },
      }),
    /more than one @id/,
  );
  assert.throws(() => defineModel("X", { fields: { id: "string" }, attrs: { nope: { unique: true } } }), /unknown field/);
});
