import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defineModel,
  migrate,
  planMigrations,
  policyToSql,
  useDatabase,
  type Model,
  type PolicyExpr,
  type SqlDatabase,
} from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Doc {
  id: string;
  owner: string;
  title: string;
  shared: boolean;
  meta: { team: string; tags: string[] };
  due?: Date;
}

const OWNER: PolicyExpr = { cmp: "==", l: { actor: ["id"] }, r: { field: ["owner"] } };
const READ: PolicyExpr = {
  or: [
    { cmp: "==", l: { actor: ["role"] }, r: { value: "admin" } },
    OWNER,
    {
      and: [
        { truthy: { field: ["shared"] } },
        { cmp: "==", l: { field: ["meta", "team"] }, r: { actor: ["team"] } },
      ],
    },
  ],
};

type User = { id: string; role?: string; team?: string };

function docs(): Model<Doc> {
  return defineModel<Doc>("Doc", {
    fields: {
      id: "string",
      owner: "string",
      title: "string",
      shared: "boolean",
      meta: "{ team: string; tags: string[] }",
      due: "Date | undefined",
    },
    read: (a, r) => {
      const u = a as User;
      return u.role === "admin" || u.id === r.owner || (r.shared && r.meta.team === u.team);
    },
    write: (a, r) => (a as User).id === r.owner,
    readWhere: READ,
    writeWhere: OWNER,
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

const alice: User = { id: "alice", team: "red" };
const bob: User = { id: "bob", team: "red" };
const carol: User = { id: "carol", team: "blue" };
const admin: User = { id: "root", role: "admin" };

function seed(m: Model<Doc>) {
  const due = new Date("2026-12-24T10:00:00.000Z");
  m.as(alice).create({ id: "a1", owner: "alice", title: "Plan", shared: true, meta: { team: "red", tags: ["x"] }, due });
  m.as(alice).create({ id: "a2", owner: "alice", title: "Diary", shared: false, meta: { team: "red", tags: [] } });
  m.as(bob).create({ id: "b1", owner: "bob", title: "Notes", shared: false, meta: { team: "red", tags: [] } });
  m.as(carol).create({ id: "c1", owner: "carol", title: "Blue", shared: true, meta: { team: "blue", tags: [] } });
}

test("policy translation binds values and never narrows", () => {
  const col = (p: string[]) => (p.length === 1 ? `"${p[0]}"` : null);
  const sql = policyToSql(OWNER, { id: "x' OR 1=1 --" }, col)!;
  assert.equal(sql.sql, `? IS "owner"`);
  assert.deepEqual(sql.params, ["x' OR 1=1 --"]);

  const ex: PolicyExpr = { or: [{ cmp: "==", l: { actor: ["role"] }, r: { value: "admin" } }, OWNER] };
  assert.equal(policyToSql(ex, { id: "a", role: "admin" }, col)!.sql, `(1) OR (? IS "owner")`);
  assert.equal(policyToSql(ex, { id: "a" }, col)!.sql, `(0) OR (? IS "owner")`);

  const partial: PolicyExpr = { and: [OWNER, { truthy: { field: ["a", "b"] } }] };
  assert.equal(policyToSql(partial, { id: "a" }, col)!.sql, `? IS "owner"`);
  assert.equal(policyToSql({ not: partial }, { id: "a" }, col), null);
  assert.equal(policyToSql({ or: [OWNER, { truthy: { field: ["a", "b"] } }] }, { id: "a" }, col), null);

  const proto: PolicyExpr = { cmp: "==", l: { actor: ["__proto__", "x"] }, r: { field: ["owner"] } };
  assert.deepEqual(policyToSql(proto, {}, col)!.params, [null]);
  assert.equal(policyToSql(OWNER, { id: { toString: () => "x" } }, col), null);
  assert.equal(policyToSql({ cmp: "<", l: { field: ["n"] }, r: { value: null } }, {}, col), null);
});

for (const kind of ["memory", "sqlite"] as const) {
  const make = () => {
    const m = docs();
    if (kind === "sqlite") {
      useDatabase(openSqlite(":memory:"), [m as Model<never>]);
    }
    seed(m);
    return m;
  };

  test(`${kind}: reads are scoped by owner, sharing and role`, () => {
    const m = make();
    const ids = (u: User) => m.as(u).all().map((d) => d.id).sort();
    assert.deepEqual(ids(alice), ["a1", "a2"]);
    assert.deepEqual(ids(bob), ["a1", "b1"]);
    assert.deepEqual(ids(carol), ["c1"]);
    assert.deepEqual(ids(admin), ["a1", "a2", "b1", "c1"]);
    assert.deepEqual(ids({ id: "' OR 1=1 --", team: "red' OR '1'='1" }), [], "injection-shaped actor values match nothing");
  });

  test(`${kind}: another actor's row cannot be fetched, changed or deleted (IDOR)`, () => {
    const m = make();
    assert.equal(m.as(bob).get("a2"), undefined);
    assert.equal(m.as(bob).find((d) => d.id === "a2"), undefined);
    assert.equal(m.as(bob).update((d) => d.id === "a1", { title: "pwned" }), 0, "readable but not writable");
    assert.equal(m.as(bob).delete(() => true), 1, "only bob's own row");
    assert.equal(m.as(alice).get("a1")?.title, "Plan");
    assert.equal(m.as(bob).get("b1"), undefined);
  });

  test(`${kind}: updates stay within authority; rows out are copies`, () => {
    const m = make();
    assert.equal(m.as(alice).update((d) => d.id === "a2", { owner: "bob" }), 0, "cannot give a row away");
    assert.equal(m.as(alice).update((d) => d.id === "a2", { title: "Journal" }), 1);
    assert.throws(() => m.as(alice).update(() => true, { id: "zz" }), /cannot be updated/);
    const got = m.as(alice).get("a2")!;
    assert.equal(got.title, "Journal");
    got.title = "mutated";
    assert.equal(m.as(alice).get("a2")!.title, "Journal", "mutating a result changes nothing");
    assert.throws(() => m.as(alice).create({ ...got, title: "dup" }));
  });

  test(`${kind}: values round-trip with their types`, () => {
    const m = make();
    const a1 = m.as(alice).get("a1")!;
    assert.equal(a1.shared, true);
    assert.deepEqual(a1.meta, { team: "red", tags: ["x"] });
    assert.ok(a1.due instanceof Date);
    assert.equal(a1.due.toISOString(), "2026-12-24T10:00:00.000Z");
    const a2 = m.as(alice).get("a2")!;
    assert.equal(a2.shared, false);
    assert.equal("due" in a2, false, "optional field absent, not null");
  });
}

test("sqlite: scoping runs inside the query with bound parameters", () => {
  const raw = openSqlite(":memory:");
  const db = recording(raw);
  const m = docs();
  useDatabase(db, [m as Model<never>]);
  seed(m);
  db.log.length = 0;
  m.as({ id: "bob", team: "red" }).all();
  const select = db.log.find((s) => s.startsWith("SELECT"))!;
  assert.match(select, /WHERE \(\(0\) OR \(\? IS "owner"\) OR \(\(.*json_extract\("meta", '\$\."team"'\) IS \?\)\)\)/);
  assert.ok(!/bob|'red'/.test(select), "no values in SQL text");

  m.as(alice).get("a1");
  assert.ok(db.log.some((s) => /WHERE .* AND "id" = \?/.test(s)));
});

test("sqlite: the schema itself rejects data the model does not allow", () => {
  const db = openSqlite(":memory:");
  const m = docs();
  useDatabase(db, [m as Model<never>]);
  const ins = db.prepare(`INSERT INTO "Doc" (id, owner, title, shared, meta) VALUES (?, ?, ?, ?, ?)`);
  assert.throws(() => ins.run("x", "o", "t", 2, "{}"), /CHECK/);
  assert.throws(() => ins.run("x", "o", "t", 1, "not json"), /CHECK/);
  assert.throws(() => ins.run("x", null, "t", 1, "{}"), /NOT NULL/);
  assert.throws(() => ins.run("x", "o", new Uint8Array([1]), 1, "{}"), /cannot store/i);
});

test("migrations: create, idempotent re-run, added fields, history", () => {
  const db = openSqlite(":memory:");
  const v1 = defineModel<{ id: string; title: string }>("Note", {
    fields: { id: "string", title: "string" },
  });
  const first = migrate(db, [v1 as Model<unknown>]);
  assert.deepEqual(
    first.steps.map((s) => s.sql),
    [`CREATE TABLE "Note" ("id" TEXT PRIMARY KEY NOT NULL, "title" TEXT NOT NULL) STRICT`],
  );
  assert.deepEqual(migrate(db, [v1 as Model<unknown>]).steps, [], "nothing to do twice");

  const v2 = defineModel("Note", {
    fields: { id: "string", title: "number", body: "string", tags: "string[] | null" },
  });
  const plan = planMigrations(db, [v2 as Model<unknown>]);
  assert.deepEqual(plan.steps.map((s) => s.sql), [
    `ALTER TABLE "Note" ADD COLUMN "body" TEXT`,
    `ALTER TABLE "Note" ADD COLUMN "tags" TEXT CHECK (json_valid("tags"))`,
  ]);
  assert.deepEqual(plan.warnings, [
    "Note.title: column is TEXT, model needs REAL (`weft migrate --allow-destructive` converts it)",
    "Note.body: added as nullable; existing rows have no value",
  ]);
  migrate(db, [v2 as Model<unknown>]);
  const history = db.prepare(`SELECT model, sql FROM _weft_migrations ORDER BY id`).all() as { sql: string }[];
  assert.equal(history.length, 3);

  assert.throws(() => migrate(db, [defineModel("x; DROP TABLE y", { fields: { id: "string" } }) as Model<unknown>]), /identifier/);
});

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const hasCargo = (() => {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("a model compiled from .wx is scoped inside SQLite", { skip: !hasCargo }, async () => {
  const dir = join(here, ".weft");
  mkdirSync(dir, { recursive: true });
  const src = join(dir, "Task.wx");
  writeFileSync(
    src,
    "model Task {\n  id: string\n  owner: string\n  done: boolean\n" +
      "  @read(actor.id == owner || actor.admin == true)\n  @write(actor.id == owner)\n}\n",
  );
  const ts = execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "emit", src], { cwd: repo, encoding: "utf8" });
  assert.match(ts, /readWhere: \{ or: \[/);
  const out = join(dir, "Task.ts");
  writeFileSync(out, ts);
  const { Task } = (await import(pathToFileURL(out).href)) as { Task: Model<{ id: string; owner: string; done: boolean }> };

  const db = recording(openSqlite(":memory:"));
  useDatabase(db, [Task as Model<never>]);
  Task.as({ id: "u1" }).create({ id: "t1", owner: "u1", done: false });
  Task.as({ id: "u2" }).create({ id: "t2", owner: "u2", done: true });
  assert.deepEqual(Task.as({ id: "u1" }).all().map((t) => t.id), ["t1"]);
  assert.deepEqual(Task.as({ id: "x", admin: true }).all().map((t) => t.id), ["t1", "t2"]);
  assert.ok(db.log.some((s) => s.includes(`WHERE ((? IS "owner") OR (0))`)), db.log.join("\n"));
  assert.ok(db.log.some((s) => s.includes(`WHERE ((? IS "owner") OR (1))`)), db.log.join("\n"));
});
