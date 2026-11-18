import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  defineAggregate,
  defineAttachments,
  defineComments,
  defineHistory,
  defineModel,
  definePublishing,
  defineReport,
  defineTable,
  defineTags,
  defineWorkflow,
  holdFile,
  type Model,
} from "../src/index.ts";
import { pgliteAsPool, usePostgres } from "../src/postgres.ts";

interface Doc {
  id: string;
  owner: string;
  title: string;
  status: "draft" | "review" | "done";
  amount: number;
  created: number;
  published: number | null;
}

type Who = { id: string };
const ann: Who = { id: "ann" };
const bob: Who = { id: "bob" };

test("add-ons work on Postgres and keep their read rules", async () => {
  const pool = pgliteAsPool(new PGlite());
  const Doc = defineModel<Doc>("PgAddonDoc", {
    fields: { id: "string", owner: "string", title: "string", status: '"draft" | "review" | "done"', amount: "number", created: "number", published: "number | null" },
    read: (a: Who, r) => a.id === r.owner,
    write: (a: Who, r) => a.id === r.owner,
  });
  const comments = defineComments(Doc, { name: "PgAddonComment" });
  const tags = defineTags(Doc, { name: "PgAddonTag" });
  const files = defineAttachments(Doc, { name: "PgAddonFile" });
  const flowOf = defineWorkflow(Doc, {
    field: "status",
    initial: "draft",
    transitions: { submit: { from: "draft", to: "review" }, approve: { from: "review", to: "done" } },
    name: "PgAddonStep",
  });
  const history = defineHistory(Doc, { name: "PgAddonVersion" });
  const pub = definePublishing(Doc, { fields: ["title"], publishedField: "published", name: "PgAddonDraft", actor: (id) => ({ id }) });
  await usePostgres(
    pool,
    [Doc, comments.model, tags.model, files.model, flowOf.model, history.model, pub.model] as Model<never>[],
    { onWarning: () => {} },
  );

  const mine = Doc.as(ann);
  await mine.create({ id: "d1", owner: "ann", title: "One", status: "draft", amount: 10, created: Date.UTC(2026, 0, 2), published: null });
  await mine.create({ id: "d2", owner: "ann", title: "Two", status: "draft", amount: 5, created: Date.UTC(2026, 0, 3), published: null });

  // comments
  const c = await comments.add(ann, "d1", "hello");
  assert.ok(c);
  assert.equal(await comments.add(bob, "d1", "sneaky"), undefined);
  assert.deepEqual((await comments.list(ann, "d1")).map((r) => r.body), ["hello"]);
  assert.deepEqual(await comments.list(bob, "d1"), []);
  assert.deepEqual(await comments.model.as(bob).all(), [], "direct reads of add-on rows are refused on Postgres");

  // tags
  assert.equal(await tags.add(ann, "d1", "Urgent"), true);
  assert.equal(await tags.add(bob, "d1", "x"), false);
  assert.deepEqual(await tags.of(ann, "d1"), ["urgent"]);
  assert.deepEqual(await tags.keysWith(ann, "urgent"), ["d1"]);
  assert.deepEqual(await tags.keysWith(bob, "urgent"), []);
  assert.deepEqual(await tags.counts(ann), { urgent: 1 });

  // attachments
  holdFile("blob-1", ann);
  assert.ok(await files.add(ann, "d1", "blob-1", "a.txt"));
  assert.equal((await files.list(ann, "d1")).length, 1);
  assert.deepEqual(await files.list(bob, "d1"), []);

  // workflow
  const moved = await flowOf.move(mine, "d1", "submit");
  assert.equal(moved.ok, true);
  assert.equal((await flowOf.move(Doc.as(bob), "d1", "approve")).ok, false);
  assert.deepEqual(await flowOf.available(mine, "d1"), ["approve"]);
  assert.equal((await flowOf.steps(mine, "d1")).length, 1);
  assert.deepEqual(await flowOf.steps(Doc.as(bob), "d1"), []);
  assert.deepEqual(await flowOf.model.as(bob).all(), []);

  // history
  await mine.update((r) => r.id === "d2", { title: "Two!" });
  const versions = await history.versions(mine, "d2");
  assert.ok(versions && versions.length >= 2);
  assert.equal(await history.versions(Doc.as(bob), "d2"), null);
  const undone = await history.undo(mine, "d2");
  assert.equal(undone.ok, true);
  assert.equal((await mine.get("d2"))!.title, "Two");

  // publishing
  assert.equal(await pub.saveDraft(mine, "d2", { title: "Draft title" }), true);
  assert.equal(await pub.saveDraft(Doc.as(bob), "d2", { title: "no" }), false);
  assert.equal((await pub.preview(mine, "d2"))!.title, "Draft title");
  assert.equal(await pub.draft(Doc.as(bob), "d2"), undefined);
  assert.equal((await mine.get("d2"))!.title, "Two", "drafts do not touch the row");
  assert.equal(await pub.publish(mine, "d2"), true);
  const live = (await mine.get("d2"))!;
  assert.equal(live.title, "Draft title");
  assert.ok(live.published !== null);
  assert.equal(await pub.schedule(mine, "d1", 1), true);
  const due = await pub.publishDue(2);
  assert.equal(due.published, 1);

  // reports, aggregates, tables
  const report = defineReport(Doc, { time: "created", measures: { n: { count: true }, total: { sum: "amount" } } });
  const r = await report.run(mine, { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 5), bucket: "day" });
  assert.deepEqual(r.totals, { n: 2, total: 15 });
  assert.deepEqual((await report.run(Doc.as(bob), { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 5), bucket: "day" })).totals.n, 0);

  const agg = defineAggregate(Doc, { by: (d) => d.owner, of: (a: Who) => a.id, sum: ["amount"] });
  assert.deepEqual(await agg.totals(mine), { count: 2, sums: { amount: 15 } });
  await mine.update((x) => x.id === "d1", { amount: 20 });
  assert.equal(await agg.sum(mine, "amount"), 25);
  assert.equal(await agg.count(Doc.as(bob)), 0);
  agg.stop();

  const table = defineTable(Doc, { columns: { title: { sort: true } }, pageSize: 1 });
  const view = await table.view(mine, new URLSearchParams("sort=title"));
  assert.equal(view.total, 2);
  assert.equal(view.pages, 2);
  assert.equal(view.rows.length, 1);
  assert.equal((await table.view(Doc.as(bob), new URLSearchParams())).total, 0);

  // a deleted row takes its add-on rows with it, in the same transaction
  await mine.delete((x) => x.id === "d1");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM "PgAddonComment"`)).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM "PgAddonStep"`)).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM "PgAddonTag"`)).rows[0].n, 0);
});
