import { test } from "node:test";
import assert from "node:assert/strict";
import { canSee, defineModel, useDatabase, type Model, type SqlDatabase } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Task {
  id: string;
  org: string;
  owner: string;
  title: string;
}

interface Who {
  id: string;
  tenant?: string;
}

function tasks(): Model<Task> {
  return defineModel<Task>("Task", {
    fields: { id: "string", org: "string", owner: "string", title: "string" },
    attrs: { org: { tenant: true, index: true } },
    read: () => true,
    write: (a: Who, r) => r.owner === a.id,
    writeWhere: { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } },
  });
}

function recording(db: SqlDatabase): SqlDatabase & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      log.push(sql);
      return db.prepare(sql);
    },
  };
}

const alice: Who = { id: "alice", tenant: "acme" };
const bob: Who = { id: "bob", tenant: "acme" };
const eve: Who = { id: "eve", tenant: "evil" };
const nobody: Who = { id: "nobody" };

function seed(m: Model<Task>): void {
  assert.ok(m.as(alice).create({ id: "t1", org: "acme", owner: "alice", title: "Plan" }));
  assert.ok(m.as(eve).create({ id: "t2", org: "evil", owner: "eve", title: "Theirs" }));
}

for (const driver of ["memory", "sqlite"] as const) {
  const make = () => {
    const m = tasks();
    let db: (SqlDatabase & { log: string[] }) | null = null;
    if (driver === "sqlite") {
      db = recording(openSqlite(":memory:"));
      useDatabase(db, [m as Model<never>]);
    }
    seed(m);
    return { m, db };
  };

  test(`${driver}: reads stay inside the actor's tenant`, () => {
    const { m } = make();
    assert.deepEqual(m.as(bob).all().map((t) => t.id), ["t1"]);
    assert.deepEqual(m.as(eve).all().map((t) => t.id), ["t2"]);
    assert.equal(m.as(eve).get("t1"), undefined, "another tenant's row by key");
    assert.deepEqual(m.as(nobody).all(), [], "no tenant, no rows");
    assert.deepEqual(m.as({ id: "x", tenant: "" }).all(), [], "an empty tenant is no tenant");
    assert.deepEqual(m.as({ id: "x", tenant: { toString: () => "acme" } }).all(), [], "only strings and numbers");
  });

  test(`${driver}: writes cannot cross tenants`, () => {
    const { m } = make();
    assert.equal(m.as(eve).create({ id: "t3", org: "acme", owner: "eve", title: "Planted" }), undefined);
    assert.equal(m.as(eve).update((t) => t.id === "t1", { title: "x" }), 0);
    assert.equal(m.as(alice).update((t) => t.id === "t1", { org: "evil" }), 0, "a row cannot move to another tenant");
    assert.equal(m.as(alice).delete((t) => t.id === "t2"), 0);
    assert.equal(m.as(alice).update((t) => t.id === "t1", { title: "Plan v2" }), 1);
    assert.equal(m.publicUnscoped().find((t) => t.id === "t1")?.org, "acme");
  });

  test(`${driver}: a created row without a tenant takes the actor's`, () => {
    const { m } = make();
    const row = m.as(bob).create({ id: "t4", owner: "bob", title: "Mine" } as Task);
    assert.equal(row?.org, "acme");
    assert.equal(m.as(nobody).create({ id: "t5", owner: "nobody", title: "?" } as Task), undefined);
  });

  test(`${driver}: grants still open one row across tenants`, () => {
    const { m } = make();
    assert.equal(m.as(eve).using({ model: "Task", key: "t1", rights: "read" }).get("t1")?.title, "Plan");
    assert.equal(m.as(eve).using({ model: "Task", key: "t1", rights: "read" }).all().length, 2);
  });
}

test("sqlite: the tenant condition is part of the query", () => {
  const m = tasks();
  const db = recording(openSqlite(":memory:"));
  useDatabase(db, [m as Model<never>]);
  seed(m);
  db.log.length = 0;
  m.as(bob).all();
  const select = db.log.find((s) => s.startsWith("SELECT"));
  assert.ok(select && /"org"/.test(select), select);
});

test("change notifications reach only the row's tenant", () => {
  const m = tasks() as unknown as Model<unknown>;
  const change = { model: "Task", op: "create" as const, key: "t1", after: { id: "t1", org: "acme", owner: "alice", title: "Plan" } };
  assert.equal(canSee(m, bob, change), true);
  assert.equal(canSee(m, eve, change), false);
  assert.equal(canSee(m, nobody, change), false);
  const moved = { ...change, op: "update" as const, before: change.after, after: { ...change.after, org: "other" } };
  assert.equal(canSee(m, bob, moved), true, "the row left the tenant: its readers must see it go");
});

test("a model declares at most one tenant field, and it must exist", () => {
  assert.throws(
    () =>
      defineModel("X", {
        fields: { id: "string", a: "string", b: "string" },
        attrs: { a: { tenant: true }, b: { tenant: true } },
      }),
    /more than one @tenant/,
  );
  assert.throws(() => defineModel("Y", { fields: { id: "string" }, attrs: { nope: { tenant: true } } }), /unknown field `nope`/);
});
