import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { asyncTransaction, ChangeFeed, defineModel, type Change, type Model } from "../src/index.ts";
import { migratePg, pgliteAsPool, planPgMigrations, usePostgres, type PgPool } from "../src/postgres.ts";

interface Task {
  id: string;
  ws: string;
  title: string;
  done: boolean;
  points: bigint;
  score: number;
  due: Date | null;
  meta: { tags: string[] } | null;
  deleted: number | null;
}

type Me = { id: string; ws: string };

function tasks(name = "Task") {
  return defineModel<Task>(name, {
    fields: {
      id: "string",
      ws: "string",
      title: "string",
      done: "boolean",
      points: "bigint",
      score: "number",
      due: "Date | null",
      meta: "{ tags: string[] } | null",
      deleted: "number | null",
    },
    attrs: { ws: { index: true }, deleted: { softDelete: true } },
    readWhere: { cmp: "==", l: { field: ["ws"] }, r: { actor: ["ws"] } },
    read: (a, t) => (a as Me).ws === t.ws,
    write: (a, t) => (a as Me).ws === t.ws && t.title !== "",
  });
}

async function setup(name?: string) {
  const pool = pgliteAsPool(new PGlite());
  const Tasks = tasks(name);
  const plan = await usePostgres(pool, [Tasks] as Model<never>[], { onWarning: () => {} });
  return { pool, Tasks, plan };
}

const row = (id: string, ws: string, extra: Partial<Task> = {}) => ({
  id,
  ws,
  title: `t${id}`,
  done: false,
  points: 1n,
  score: 0.5,
  due: null,
  meta: null,
  ...extra,
});

test("postgres: creates the table and round-trips every field type", async () => {
  const { Tasks, plan } = await setup();
  assert.ok(plan.steps.some((s) => s.sql.startsWith(`CREATE TABLE "Task"`)));
  assert.equal(Tasks.isAsync, true);
  const me = Tasks.as({ id: "u", ws: "a" });
  const due = new Date("2026-01-02T03:04:05.000Z");
  await me.create(row("1", "a", { done: true, points: 9007199254740993n, score: 1.25, due, meta: { tags: ["x"] } }));
  const got = await me.get("1");
  assert.equal(got?.done, true);
  assert.equal(got?.points, 9007199254740993n);
  assert.equal(got?.score, 1.25);
  assert.equal(got?.due?.toISOString(), due.toISOString());
  assert.deepEqual(got?.meta, { tags: ["x"] });
  assert.equal(got?.deleted, null);
});

test("postgres: policies are enforced (pushed into SQL and re-checked)", async () => {
  const { Tasks } = await setup();
  const a = Tasks.as({ id: "u", ws: "a" });
  const b = Tasks.as({ id: "v", ws: "b" });
  await a.create(row("1", "a"));
  await b.create(row("2", "b"));
  assert.equal(await a.create(row("3", "b")), undefined, "cannot write into another workspace");
  assert.deepEqual((await a.all()).map((t) => t.id), ["1"]);
  assert.deepEqual((await b.all()).map((t) => t.id), ["2"]);
  assert.equal(await b.get("1"), undefined);
  assert.equal(await b.update((t) => t.id === "1", { title: "x" }), 0);
  assert.equal(await a.update((t) => t.id === "1", { title: "" }), 0, "write rule checked on the patched row");
  assert.equal(await a.update((t) => t.id === "1", { title: "renamed" }), 1);
  assert.equal((await a.get("1"))?.title, "renamed");
});

test("postgres: query filters, order, limit/offset, count, delete", async () => {
  const { Tasks } = await setup();
  const a = Tasks.as({ id: "u", ws: "a" });
  const data: [string, string, number, boolean][] = [
    ["1", "banana", 3, false],
    ["2", "apple", 1, true],
    ["3", "Cherry", 2, false],
    ["4", "date", 5, true],
  ];
  for (const [id, title, score, done] of data) {
    await a.create(row(id, "a", { title, score, done }));
  }
  await Tasks.as({ id: "v", ws: "b" }).create(row("9", "b", { title: "apple" }));
  assert.deepEqual(
    (await a.query().orderBy("title").all()).map((t) => t.title),
    ["Cherry", "apple", "banana", "date"],
    "binary collation like SQLite",
  );
  assert.deepEqual((await a.query().where({ done: true }).orderBy("score", "desc").all()).map((t) => t.id), ["4", "2"]);
  assert.deepEqual((await a.query().where({ title: { contains: "an" } }).all()).map((t) => t.id), ["1"]);
  assert.deepEqual((await a.query().where({ title: { startsWith: "d" } }).all()).map((t) => t.id), ["4"]);
  assert.deepEqual((await a.query().where({ score: { gte: 2, lt: 5 } }).orderBy("score").all()).map((t) => t.id), ["3", "1"]);
  assert.deepEqual((await a.query().where({ id: { in: ["2", "4", "9"] } }).orderBy("id").all()).map((t) => t.id), ["2", "4"]);
  assert.deepEqual((await a.query().orderBy("score").limit(2).offset(1).all()).map((t) => t.id), ["3", "1"]);
  assert.equal(await a.query().where({ title: "apple" }).count(), 1);
  assert.equal(await a.query().where({ title: "nope" }).exists(), false);
  assert.equal(await a.query().where({ done: false }).delete(), 2);
  assert.deepEqual((await a.all()).map((t) => t.id), ["2", "4"]);
  assert.equal((await a.trash().all()).length, 2, "soft delete keeps the rows in the trash");
});

test("postgres: asyncTransaction commits or rolls back, and publishes only after commit", async () => {
  const { Tasks } = await setup();
  const feed = new ChangeFeed();
  const seen: Change[] = [];
  feed.subscribe((c) => seen.push(c));
  Tasks.publishTo(feed);
  const a = Tasks.as({ id: "u", ws: "a" });
  await assert.rejects(
    asyncTransaction(async () => {
      await a.create(row("1", "a"));
      assert.equal(seen.length, 0, "nothing published inside the transaction");
      throw new Error("abort");
    }),
    /abort/,
  );
  assert.equal(await a.get("1"), undefined, "rolled back");
  assert.equal(seen.length, 0);
  await asyncTransaction(async () => {
    await a.create(row("2", "a"));
    await asyncTransaction(async () => a.create(row("3", "a")));
    await asyncTransaction(async () => {
      await a.create(row("4", "a"));
      throw new Error("inner");
    }).catch(() => undefined);
  });
  assert.deepEqual((await a.all()).map((t) => t.id), ["2", "3"]);
  assert.equal(seen.length, 2);
});

test("postgres migrations: idempotent, add/rename columns, destructive type change", async () => {
  const pool: PgPool = pgliteAsPool(new PGlite());
  const V1 = defineModel<{ id: string; name: string; old: string | null }>("Item", {
    fields: { id: "string", name: "string", old: "string | null" },
    attrs: { name: { unique: true } },
  });
  await migratePg(pool, [V1] as Model<unknown>[]);
  const again = await migratePg(pool, [V1] as Model<unknown>[]);
  assert.deepEqual(again.steps, [], "second run is a no-op");
  await pool.query(`INSERT INTO "Item" (id, name, old) VALUES ('a', 'x', 'kept')`);

  const V2 = defineModel<{ id: string; name: string; label: string | null; qty: number | null }>("Item", {
    fields: { id: "string", name: "string", label: "string | null", qty: "number | null" },
    attrs: { label: { renamed: "old" }, name: { unique: true } },
  });
  const plan = await migratePg(pool, [V2] as Model<unknown>[]);
  assert.ok(plan.steps.some((s) => s.sql.includes(`RENAME COLUMN "old" TO "label"`)));
  assert.ok(plan.steps.some((s) => s.sql.includes(`ADD COLUMN "qty" double precision`)));
  const r = (await pool.query(`SELECT label FROM "Item"`)).rows[0] as { label: string };
  assert.equal(r.label, "kept");

  const V3 = defineModel<{ id: string; name: string; label: string | null; qty: bigint | null }>("Item", {
    fields: { id: "string", name: "string", label: "string | null", qty: "bigint | null" },
    attrs: { name: { unique: true } },
  });
  const client = await pool.connect();
  const safe = await planPgMigrations(client, [V3] as Model<unknown>[]);
  client.release();
  assert.ok(safe.warnings.some((w) => w.includes("qty") && w.includes("allow-destructive")));
  const forced = await migratePg(pool, [V3] as Model<unknown>[], { destructive: true });
  assert.ok(forced.steps.some((s) => s.sql.includes(`ALTER COLUMN "qty" TYPE bigint`)));
  const hist = (await pool.query(`SELECT count(*)::int AS n FROM _weft_migrations`)).rows[0] as { n: number };
  assert.ok(hist.n >= 5);
});

test("postgres migrations: foreign keys are added after all tables exist", async () => {
  const pool = pgliteAsPool(new PGlite());
  const Child = defineModel<{ id: string; parent: string }>("Child", {
    fields: { id: "string", parent: "string" },
    attrs: { parent: { ref: "Parent" } },
  });
  const Parent = defineModel<{ id: string }>("Parent", { fields: { id: "string" } });
  const plan = await migratePg(pool, [Child, Parent] as Model<unknown>[]);
  assert.ok(plan.steps.at(-1)!.sql.includes("FOREIGN KEY"));
  await assert.rejects(pool.query(`INSERT INTO "Child" (id, parent) VALUES ('c', 'missing')`), /foreign key/);
});
