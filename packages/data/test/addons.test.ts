import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canSee,
  defineAttachments,
  defineComments,
  defineModel,
  defineTags,
  holdFile,
  onFileRelease,
  useDatabase,
  type Change,
  type Model,
} from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Doc {
  id: string;
  org: string;
  owner: string;
  title: string;
  private: boolean;
  deletedAt: number | null;
}
interface Who {
  id: string;
  tenant?: string;
}

const ada: Who = { id: "ada", tenant: "acme" };
const bob: Who = { id: "bob", tenant: "acme" };
const eve: Who = { id: "eve", tenant: "evil" };

function setup(driver: "memory" | "sqlite") {
  const Doc = defineModel<Doc, "deletedAt">("Doc", {
    fields: { id: "string", org: "string", owner: "string", title: "string", private: "boolean", deletedAt: "number | null" },
    attrs: { org: { tenant: true }, deletedAt: { softDelete: true } },
    read: (a: Who, r) => !r.private || r.owner === a.id,
    write: (a: Who, r) => r.owner === a.id,
  });
  let clock = 0;
  const now = () => (clock += 1);
  const comments = defineComments(Doc, { now, maxLength: 20 });
  const tags = defineTags(Doc, { now });
  const files = defineAttachments(Doc, { now });
  if (driver === "sqlite") useDatabase(openSqlite(":memory:"), [Doc, comments.model, tags.model, files.model] as Model<never>[]);
  Doc.as(ada).create({ id: "d1", org: "acme", owner: "ada", title: "Plan", private: false });
  Doc.as(ada).create({ id: "p1", org: "acme", owner: "ada", title: "Diary", private: true });
  return { Doc, comments, tags, files };
}

for (const driver of ["memory", "sqlite"] as const) {
  test(`${driver}: comments - readers comment, authors edit, readable with the row`, () => {
    const { Doc, comments } = setup(driver);
    const c1 = comments.add(bob, "d1", "Looks good")!;
    assert.equal(c1.author, "bob");
    assert.equal(comments.add(ada, "d1", "Thanks")!.author, "ada");
    assert.equal(comments.add(bob, "p1", "peek"), undefined, "cannot comment on a row he cannot read");
    assert.equal(comments.add(eve, "d1", "hi"), undefined, "nor another tenant's");
    assert.equal(comments.add(bob, "d1", "   "), undefined, "empty");
    assert.equal(comments.add(bob, "d1", "x".repeat(21)), undefined, "too long");
    assert.equal(comments.add(bob, "nope", "x"), undefined, "no such row");
    assert.deepEqual(comments.list(ada, "d1").map((c) => c.body), ["Looks good", "Thanks"]);
    assert.deepEqual(comments.list(eve, "d1"), []);
    assert.equal(comments.model.as(eve).get(c1.id), undefined, "not by id either");

    assert.equal(comments.edit(ada, c1.id, "edited by ada"), false, "only the author edits");
    assert.equal(comments.remove(ada, c1.id), false, "or removes");
    assert.equal(comments.edit(bob, c1.id, "Looks great"), true);
    assert.equal(comments.list(ada, "d1")[0]!.edited !== null, true);
    assert.equal(comments.edit(bob, c1.id, ""), false);
    assert.equal(comments.model.as(bob).create({ id: "f", key: '"d1"', author: "ada", body: "I agree", at: 0, edited: null }), undefined);
    assert.equal(comments.model.as(bob).update((c) => c.id === c1.id, { author: "ada" }), 0);

    Doc.as(ada).update((d) => d.id === "d1", { private: true });
    assert.deepEqual(comments.list(bob, "d1"), []);
    assert.equal(comments.edit(bob, c1.id, "still mine?"), false, "and are no longer his to change");
    Doc.as(ada).update((d) => d.id === "d1", { private: false });
    Doc.as(ada).delete((d) => d.id === "d1");
    assert.deepEqual(comments.list(ada, "d1"), []);
    assert.equal(comments.model.publicUnscoped().length, 2, "kept while in the trash");
    Doc.as(ada).trash().delete(() => true);
    assert.equal(comments.model.publicUnscoped().length, 0);
  });

  test(`${driver}: tags - writers tag, readers see, counts and lookups follow the rules`, () => {
    const { Doc, tags } = setup(driver);
    assert.equal(tags.add(ada, "d1", "  Urgent  Now "), true);
    assert.equal(tags.add(ada, "d1", "urgent now"), true, "already there");
    assert.equal(tags.add(ada, "p1", "urgent now"), true);
    assert.equal(tags.add(bob, "d1", "mine"), false, "tagging needs write access");
    assert.equal(tags.add(bob, "d1", "urgent now"), false, "even an existing tag");
    assert.equal(tags.add(ada, "d1", ""), false);
    assert.equal(tags.add(ada, "d1", "x".repeat(51)), false);
    assert.equal(tags.add(ada, "d1", "a\u0000b"), false);
    assert.deepEqual(tags.of(bob, "d1"), ["urgent now"]);
    assert.deepEqual(tags.of(bob, "p1"), [], "a private row's tags");
    assert.deepEqual(tags.keysWith(bob, "URGENT now"), ["d1"]);
    assert.deepEqual(tags.keysWith(ada, "urgent now").sort(), ["d1", "p1"]);
    assert.deepEqual(tags.counts(bob), { "urgent now": 1 });
    assert.deepEqual(tags.counts(eve), {});
    assert.equal(tags.remove(bob, "d1", "urgent now"), false);
    assert.equal(tags.remove(ada, "d1", "urgent now"), true);
    assert.equal(tags.model.as(ada).create({ id: "forged", key: '"d1"', tag: "x", by: "ada", at: 0 }), undefined, "the id is the key and tag");
    Doc.as(ada).delete((d) => d.id === "p1");
    Doc.as(ada).trash().delete(() => true);
    assert.equal(tags.model.publicUnscoped().length, 0, "gone with the row");
  });

  test(`${driver}: attachments - claimed files only, the uploader removes, files released`, () => {
    const { Doc, files } = setup(driver);
    const released: string[] = [];
    const off = onFileRelease((id) => released.push(id));
    try {
      assert.throws(() => files.add(ada, "d1", "f-unclaimed", "plan.pdf"), /not a file claimed/);
      holdFile("f1", ada);
      const a1 = files.add(ada, "d1", "f1", " plan.pdf ")!;
      assert.equal(a1.name, "plan.pdf");
      holdFile("f2", bob);
      assert.equal(files.add(bob, "d1", "f2", "x.pdf"), undefined, "attaching needs write access by default");
      assert.deepEqual(files.list(bob, "d1").map((f) => f.name), ["plan.pdf"]);
      assert.deepEqual(files.list(eve, "d1"), []);
      assert.equal(files.remove(bob, a1.id), false);
      assert.equal(files.remove(ada, a1.id), true);
      assert.deepEqual(released, ["f1"]);
      holdFile("f4", ada);
      files.add(ada, "d1", "f4", "keep.pdf");
      Doc.as(ada).delete((d) => d.id === "d1");
      Doc.as(ada).trash().delete(() => true);
      assert.deepEqual(released, ["f1", "f4"], "deleting the row releases its files");
    } finally {
      off();
    }
  });
}

test("attachments: readers may attach when allowed; a cap per row", () => {
  const Doc = defineModel<{ id: string; owner: string }>("Doc", {
    fields: { id: "string", owner: "string" },
    read: () => true,
    write: (a: Who, r) => r.owner === a.id,
  });
  const files = defineAttachments(Doc, { attach: "read", maxPerRow: 1 });
  Doc.as(ada).create({ id: "d1", owner: "ada" });
  holdFile("g0", ada);
  assert.throws(() => files.add(bob, "d1", "g0", "x.pdf"), /not a file claimed/, "a file claimed by someone else");
  holdFile("g1", bob);
  assert.ok(files.add(bob, "d1", "g1", "from bob"));
  holdFile("g2", bob);
  assert.equal(files.add(bob, "d1", "g2", "second"), undefined, "the cap");
  assert.equal(files.model.as(bob).create({ id: "x", key: '"d1"', file: "g2", name: "n", by: "ada", at: 0 }), undefined, "in his own name only");
});

test("change relevance follows the row", () => {
  const { Doc, comments } = setup("memory");
  const got: Change[] = [];
  const off = comments.model.feed.subscribe((c) => {
    if (c.model === comments.model.name) got.push(c);
  });
  comments.add(ada, "p1", "note to self");
  comments.add(ada, "d1", "public");
  off();
  const M = comments.model as Model<unknown>;
  assert.deepEqual(got.map((c) => canSee(M, bob, c)), [false, true], "bob's page hears only about what he may read");
  assert.deepEqual(got.map((c) => canSee(M, ada, c)), [true, true]);
  void Doc;
});

test("declarations", () => {
  const Doc = defineModel<{ id: string }>("Doc", { fields: { id: "string" }, read: () => true, write: () => true });
  assert.throws(() => defineComments({} as never), /needs a model/);
  assert.throws(() => defineComments(Doc, { maxLength: 0 }), /maxLength/);
  assert.throws(() => defineComments(Doc, { comment: "admin" as never }), /comment is/);
  assert.throws(() => defineTags(Doc, { name: "bad name" }), /name/);
  assert.throws(() => defineAttachments(Doc, { attach: "x" as never }), /attach is/);
  assert.throws(() => defineAttachments(Doc, { maxPerRow: 0 }), /maxPerRow/);
  const c = defineComments(Doc, { comment: "write" });
  assert.equal(c.model.name, "DocComments");
  assert.throws(() => c.add(ada, "" as never, "x"), /row key/);
  assert.throws(() => c.list(ada, { id: 1 } as never), /row key/);
});
