// Differential test: the same seeded rows, filters, orderings, paging and policies through the
// memory driver, SQLite and Postgres (PGlite) must give identical answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { defineModel, useDatabase, type Filter, type Model } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";
import { pgliteAsPool, usePostgres } from "../src/postgres.ts";

interface Row {
  id: string;
  owner: string;
  n: number | null;
  s: string | null;
  b: boolean;
}
type Who = { id: string; admin?: boolean };

function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

const WORDS = ["", "a", "A", "apple", "Apple", "b", "banana", "Zebra", "zebra", "é", "e", "naïve", "x y", "100", "9", "%", "_", "a%b", "O'Neil"];
const OWNERS = ["ann", "bob", "cy"];

function model(name: string) {
  return defineModel<Row>(name, {
    fields: { id: "string", owner: "string", n: "number | null", s: "string | null", b: "boolean" },
    read: (a: Who, r) => a.admin === true || r.owner === a.id || (r.n !== null && r.n > 50),
    write: (a: Who, r) => a.admin === true || r.owner === a.id,
    readWhere: {
      or: [
        { truthy: { actor: ["admin"] } },
        { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } },
        { and: [{ cmp: "!=", l: { field: ["n"] }, r: { value: null } }, { cmp: ">", l: { field: ["n"] }, r: { value: 50 } }] },
      ],
    },
  });
}

function randomFilter(r: () => number): Filter<Row> {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const leaf = (): Filter<Row> => {
    switch (Math.floor(r() * 9)) {
      case 0:
        return { owner: pick(OWNERS) };
      case 1:
        return { n: r() < 0.2 ? null : { gte: Math.floor(r() * 100) } };
      case 2:
        return { n: { lt: Math.floor(r() * 100) } };
      case 3:
        return { s: { contains: pick(WORDS.filter((w) => w !== "")) } };
      case 4:
        return { s: { startsWith: pick(WORDS.filter((w) => w !== "")) } };
      case 5:
        return { s: { in: [pick(WORDS), pick(WORDS)] } };
      case 6:
        return { b: r() < 0.5 };
      case 7:
        return { s: r() < 0.3 ? null : { ne: pick(WORDS) } };
      default:
        return { n: { in: [Math.floor(r() * 100), Math.floor(r() * 100), Math.round(r() * 1000) / 10] } };
    }
  };
  const k = r();
  if (k < 0.5) return leaf();
  if (k < 0.7) return { ...leaf(), ...leaf() };
  if (k < 0.9) return { $or: [leaf(), leaf()] };
  return { $not: leaf() };
}

test("memory, SQLite and Postgres agree on filters, order, paging and policies", async () => {
  const r = rng(20261118);
  const rows: Row[] = [];
  for (let i = 0; i < 240; i++) {
    rows.push({
      id: `r${String(i).padStart(3, "0")}`,
      owner: OWNERS[Math.floor(r() * OWNERS.length)]!,
      n: r() < 0.15 ? null : r() < 0.5 ? Math.floor(r() * 100) : Math.round(r() * 1000) / 10,
      s: r() < 0.15 ? null : WORDS[Math.floor(r() * WORDS.length)]!,
      b: r() < 0.5,
    });
  }
  const mem = model("ParityMem");
  const lite = model("ParityLite");
  const pg = model("ParityPg");
  useDatabase(openSqlite(":memory:"), [lite] as Model<never>[]);
  await usePostgres(pgliteAsPool(new PGlite()), [pg] as Model<never>[], { onWarning: () => {} });
  const admin: Who = { id: "root", admin: true };
  for (const row of rows) {
    mem.as(admin).create(row);
    lite.as(admin).create(row);
  }
  for (const row of rows) await pg.as(admin).create(row);

  const actors: Who[] = [admin, { id: "ann" }, { id: "bob" }, { id: "nobody" }];
  const fields = ["id", "owner", "n", "s", "b"] as const;
  let nonEmpty = 0;
  for (let i = 0; i < 160; i++) {
    const who = actors[Math.floor(r() * actors.length)]!;
    const where = randomFilter(r);
    const by = fields[Math.floor(r() * fields.length)]!;
    const dir = r() < 0.5 ? "asc" : "desc";
    const limit = 1 + Math.floor(r() * 30);
    const offset = Math.floor(r() * 20);
    const run = (m: Model<Row>) => m.as(who).query().where(where).orderBy(by, dir).orderBy("id").limit(limit).offset(offset).all();
    const count = (m: Model<Row>) => m.as(who).query().where(where).count();
    const label = JSON.stringify({ who, where, by, dir, limit, offset });
    const want = run(mem as Model<Row>) as Row[];
    if (want.length > 0) nonEmpty++;
    assert.deepEqual(run(lite as Model<Row>), want, `sqlite ${label}`);
    assert.deepEqual(await run(pg as Model<Row>), want, `postgres ${label}`);
    const n = count(mem as Model<Row>) as number;
    assert.equal(count(lite as Model<Row>), n, `sqlite count ${label}`);
    assert.equal(await count(pg as Model<Row>), n, `postgres count ${label}`);
  }

  assert.ok(nonEmpty > 60, `only ${nonEmpty} of 160 queries returned rows`);

  // writes through policies agree too
  const bob: Who = { id: "bob" };
  const patch = { b: true, s: "patched" };
  const pred = (x: Row) => x.n !== null && x.n < 30;
  const u1 = mem.as(bob).update(pred, patch) as number;
  assert.equal(lite.as(bob).update(pred, patch), u1);
  assert.equal(await pg.as(bob).update(pred, patch), u1);
  const d1 = mem.as(bob).delete((x) => x.s === "patched" && x.b) as number;
  assert.equal(lite.as(bob).delete((x) => x.s === "patched" && x.b), d1);
  assert.equal(await pg.as(bob).delete((x) => x.s === "patched" && x.b), d1);
  const all = (m: Model<Row>) => m.as(admin).query().orderBy("id").all();
  assert.deepEqual(all(lite as Model<Row>), all(mem as Model<Row>));
  assert.deepEqual(await all(pg as Model<Row>), all(mem as Model<Row>));
});
