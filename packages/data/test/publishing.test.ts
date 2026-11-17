import { test } from "node:test";
import assert from "node:assert/strict";
import { canSee, definePublishing, defineModel, useDatabase, type Change, type Model } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Page {
  id: string;
  org: string;
  author: string;
  title: string;
  body: string;
  due: Date | null;
  views: bigint;
  kind: "page" | "post";
  publishedAt: number | null;
  deletedAt: number | null;
}
interface Who {
  id: string;
  tenant?: string;
  editor?: boolean;
}

const ada: Who = { id: "ada", tenant: "acme", editor: true };
const bob: Who = { id: "bob", tenant: "acme" };
const eve: Who = { id: "eve", tenant: "evil", editor: true };

function setup(driver: "memory" | "sqlite", users: Record<string, Who> = { ada, bob }) {
  const Page = defineModel<Page, "deletedAt" | "publishedAt" | "views" | "due">("Page", {
    fields: {
      id: "string",
      org: "string",
      author: "string",
      title: "string",
      body: "string",
      due: "Date | null",
      views: "bigint",
      kind: '"page" | "post"',
      publishedAt: "number | null",
      deletedAt: "number | null",
    },
    attrs: {
      org: { tenant: true },
      deletedAt: { softDelete: true },
      views: { default: () => 0n },
      due: { default: () => null },
      publishedAt: { default: () => null },
    },
    read: (a: Who, p) => p.publishedAt !== null || a.editor === true,
    write: (a: Who, p) => a.editor === true && p.title !== "forbidden",
  });
  let clock = 100;
  const pub = definePublishing(Page, {
    fields: ["title", "body", "due", "views", "kind"],
    publishedField: "publishedAt",
    actor: (id) => users[id],
    now: () => (clock += 1),
  });
  if (driver === "sqlite") useDatabase(openSqlite(":memory:"), [Page, pub.model] as Model<never>[]);
  Page.as(ada).create({ id: "p1", org: "acme", author: "ada", title: "Hello", body: "First", kind: "page" });
  return { Page, pub, users };
}

for (const driver of ["memory", "sqlite"] as const) {
  test(`${driver}: new rows wait for their first publish`, () => {
    const { Page, pub } = setup(driver);
    assert.equal(Page.as(ada).get("p1")!.publishedAt, null);
    assert.equal(Page.as(bob).get("p1"), undefined, "readers do not see it yet");
    assert.throws(() => Page.as(ada).update((p) => p.id === "p1", { publishedAt: 1 }), /changed by Page publishing/);
    assert.throws(() => Page.as(ada).create({ id: "p2", org: "acme", author: "ada", title: "x", body: "", kind: "page", publishedAt: 5 }), /rows start with `publishedAt`/);
    assert.equal(pub.publish(Page.as(bob), "p1"), false, "bob cannot");
    assert.equal(pub.publish(Page.as(eve), "p1"), false, "nor another tenant");
    assert.equal(pub.publish(Page.as(ada), "p1"), true);
    const live = Page.as(bob).get("p1")!;
    assert.equal(live.publishedAt, 101);
    assert.equal(pub.publish(Page.as(ada), "p1"), false, "nothing more to publish");
  });

  test(`${driver}: drafts are for writers, typed, and become the row when published`, () => {
    const { Page, pub } = setup(driver);
    pub.publish(Page.as(ada), "p1");
    assert.equal(pub.saveDraft(Page.as(bob), "p1", { title: "Hacked" }), false);
    assert.equal(pub.saveDraft(Page.as(eve), "p1", { title: "Hacked" }), false);
    assert.throws(() => pub.saveDraft(Page.as(ada), "p1", { author: "bob" } as never), /not one of the drafted fields/);
    assert.throws(() => pub.saveDraft(Page.as(ada), "p1", { publishedAt: 1 } as never), /not one of the drafted fields/);
    assert.throws(() => pub.saveDraft(Page.as(ada), "p1", { title: 5 } as never), /`title` does not fit `string`/);
    assert.throws(() => pub.saveDraft(Page.as(ada), "p1", { title: null } as never), /does not fit/);
    assert.throws(() => pub.saveDraft(Page.as(ada), "p1", { kind: "essay" } as never), /`kind` does not fit/);
    assert.throws(() => pub.saveDraft(Page.as(ada), "p1", { views: 3 } as never), /`views` does not fit `bigint`/);
    assert.throws(() => pub.saveDraft(Page.as(ada), "p1", { due: new Date("nope") }), /`due` does not fit/);
    assert.equal(pub.saveDraft(Page.as(ada), "p1", { title: "Hello again", due: new Date("2026-12-24T00:00:00Z") }), true);
    assert.equal(pub.saveDraft(Page.as(ada), "p1", { views: 7n, kind: "post", due: null }), true, "merged");

    assert.equal(Page.as(bob).get("p1")!.title, "Hello", "readers see the published row");
    assert.equal(pub.draft(Page.as(bob), "p1"), undefined);
    assert.equal(pub.preview(Page.as(bob), "p1"), undefined);
    assert.equal(pub.model.as(bob).all().length, 0, "nor through the model");
    assert.equal(pub.model.as(ada).all().length, 1);
    const d = pub.draft(Page.as(ada), "p1")!;
    assert.deepEqual(d.values, { title: "Hello again", due: null, views: 7n, kind: "post" });
    assert.equal(d.by, "ada");
    const pv = pub.preview(Page.as(ada), "p1")!;
    assert.equal(pv.title, "Hello again");
    assert.equal(pv.body, "First");
    assert.equal(pub.model.as(ada).create({ id: '"p1"', data: {}, by: "ada", at: 0, publishAt: null, scheduledBy: null }), undefined, "only this module writes drafts");

    assert.equal(pub.publish(Page.as(ada), "p1"), true);
    const row = Page.as(bob).get("p1")!;
    assert.deepEqual([row.title, row.views, row.kind, row.publishedAt], ["Hello again", 7n, "post", 101], "first publish time kept");
    assert.equal(pub.draft(Page.as(ada), "p1"), undefined, "the draft is gone");

    pub.saveDraft(Page.as(ada), "p1", { title: "forbidden" });
    assert.equal(pub.publish(Page.as(ada), "p1"), false);
    assert.equal(Page.as(ada).get("p1")!.title, "Hello again");
    assert.equal(pub.draft(Page.as(ada), "p1")!.values.title, "forbidden");
    assert.equal(pub.discard(Page.as(bob), "p1"), false);
    assert.equal(pub.discard(Page.as(ada), "p1"), true);
    assert.equal(pub.draft(Page.as(ada), "p1"), undefined);
    assert.equal(pub.discard(Page.as(ada), "p1"), false);

    pub.saveDraft(Page.as(ada), "p1", { body: "x" });
    Page.as(ada).delete((p) => p.id === "p1");
    assert.equal(pub.draft(Page.as(ada), "p1"), undefined, "hidden with the row in the trash");
    assert.equal(pub.model.publicUnscoped().length, 1);
    Page.as(ada).trash().delete(() => true);
    assert.equal(pub.model.publicUnscoped().length, 0);
  });

  test(`${driver}: schedules publish as their user, with that user's rights then`, () => {
    const users: Record<string, Who> = { ada: { ...ada }, cy: { id: "cy", tenant: "acme", editor: true } };
    const { Page, pub } = setup(driver, users);
    Page.as(ada).create({ id: "p2", org: "acme", author: "ada", title: "Two", body: "", kind: "page" });
    Page.as(ada).create({ id: "p3", org: "acme", author: "ada", title: "Three", body: "", kind: "page" });
    assert.equal(pub.schedule(Page.as(bob), "p1", 500), false);
    assert.equal(pub.schedule(Page.as(ada), "p1", 500), true, "a first publish, nothing drafted");
    pub.saveDraft(Page.as(users.cy!), "p2", { title: "Two, edited" });
    assert.equal(pub.schedule(Page.as(users.cy!), "p2", 400), true);
    pub.saveDraft(Page.as(ada), "p3", { title: "Three, edited" });
    assert.equal(pub.schedule(Page.as(ada), "p3", 450), true);
    assert.equal(pub.draft(Page.as(ada), "p3")!.publishAt, 450);

    pub.saveDraft(Page.as(ada), "p3", { body: "changed after scheduling" });
    assert.equal(pub.draft(Page.as(ada), "p3")!.publishAt, null);
    assert.equal(pub.unschedule(Page.as(ada), "p3"), false, "nothing to cancel");

    assert.deepEqual(pub.publishDue(399), { published: 0, dropped: [] }, "not yet");
    users.cy = { id: "cy", tenant: "acme" };
    assert.deepEqual(pub.publishDue(600), { published: 1, dropped: [{ key: "p2", reason: "not allowed" }] });
    assert.notEqual(Page.as(bob).get("p1"), undefined, "p1 went live as ada");
    assert.equal(Page.as(bob).get("p2"), undefined, "p2 did not");
    assert.equal(pub.draft(Page.as(ada), "p2")!.values.title, "Two, edited", "its draft is kept, unscheduled");
    assert.equal(pub.draft(Page.as(ada), "p2")!.publishAt, null);
    assert.deepEqual(pub.publishDue(700), { published: 0, dropped: [] }, "dropped schedules do not come back");

    pub.schedule(Page.as(ada), "p3", 800);
    delete users.ada;
    assert.deepEqual(pub.publishDue(900), { published: 0, dropped: [{ key: "p3", reason: "no such user" }] });
  });
}

test("change relevance for drafts follows the row's write rule", () => {
  const { Page, pub } = setup("memory");
  const got: Change[] = [];
  const off = pub.model.feed.subscribe((c) => {
    if (c.model === pub.model.name) got.push(c);
  });
  pub.saveDraft(Page.as(ada), "p1", { title: "Draft" });
  off();
  const M = pub.model as Model<unknown>;
  assert.deepEqual(got.map((c) => canSee(M, ada, c)), [true]);
  assert.deepEqual(got.map((c) => canSee(M, bob, c)), [false], "a reader's page hears nothing of drafts");
});

test("without publishedField or actor", () => {
  const Doc = defineModel<{ id: string; text: string }>("Doc", { fields: { id: "string", text: "string" }, read: () => true, write: () => true });
  const pub = definePublishing(Doc, { fields: ["text"] });
  Doc.as(ada).create({ id: "d", text: "a" });
  assert.equal(pub.publish(Doc.as(ada), "d"), false, "nothing drafted");
  assert.equal(pub.schedule === undefined, false);
  assert.throws(() => pub.schedule(Doc.as(ada), "d", 1), /needs the `actor` option/);
  assert.deepEqual(pub.publishDue(), { published: 0, dropped: [] });
  pub.saveDraft(Doc.as(ada), "d", { text: "b" });
  assert.equal(pub.publish(Doc.as(ada), "d"), true);
  assert.equal(Doc.as(ada).get("d")!.text, "b");
  const Doc2 = defineModel<{ id: string; text: string }>("Doc", { fields: { id: "string", text: "string" }, read: () => true, write: () => true });
  const withActor = definePublishing(Doc2, { fields: ["text"], actor: () => ada });
  Doc2.as(ada).create({ id: "d", text: "a" });
  assert.equal(withActor.schedule(Doc2.as(ada), "d", 5), false, "no draft and no first publish: nothing to schedule");
  assert.equal(withActor.model.publicUnscoped().length, 0);
});

test("declarations", () => {
  const mk = () =>
    defineModel<{ id: string; org: string; text: string; at: number | null; n: number }>("Doc", {
      fields: { id: "string", org: "string", text: "string", at: "number | null", n: "number" },
      attrs: { org: { tenant: true } },
      read: () => true,
      write: () => true,
    });
  assert.throws(() => definePublishing({} as never, { fields: ["text"] }), /needs a model/);
  assert.throws(() => definePublishing(mk(), { fields: [] }), /fields lists/);
  assert.throws(() => definePublishing(mk(), { fields: ["nope" as never] }), /no field `nope`/);
  assert.throws(() => definePublishing(mk(), { fields: ["id"] }), /is not drafted/);
  assert.throws(() => definePublishing(mk(), { fields: ["org"] }), /is not drafted/);
  assert.throws(() => definePublishing(mk(), { fields: ["text", "text"] }), /listed twice/);
  assert.throws(() => definePublishing(mk(), { fields: ["text", "at"], publishedField: "at" }), /is not drafted/);
  assert.throws(() => definePublishing(mk(), { fields: ["text"], publishedField: "n" }), /`number \| null`/);
  assert.throws(() => definePublishing(mk(), { fields: ["text"], actor: 5 as never }), /actor is a function/);
  assert.throws(() => definePublishing(mk(), { fields: ["text"], name: "x" }), /model name/);
  const M = mk();
  assert.throws(() => definePublishing(M, { fields: ["text"], publishedField: "n" }));
  assert.deepEqual(M.lockedFields, [], "a failed declaration locks nothing");
  const p = definePublishing(M, { fields: ["text"], publishedField: "at" });
  assert.equal(p.model.name, "DocDrafts");
  assert.throws(() => definePublishing(M, { fields: ["at"] }), /is not drafted/, "a locked field");
  assert.throws(() => p.publish(mk().as(ada) as never, "x"), /pass Doc.as/);
  assert.throws(() => p.saveDraft(M.as(ada), "x", null as never), /patch is an object/);
});
