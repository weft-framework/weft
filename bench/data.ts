import { parseArgs } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { asyncTransaction, defineModel, transaction, useDatabase, type Model } from "../packages/data/src/index.ts";
import { openSqlite } from "../packages/data/src/sqlite.ts";
import { openPostgres, pgliteAsPool, usePostgres, type PgPool } from "../packages/data/src/postgres.ts";

const { values } = parseArgs({
  options: {
    rows: { type: "string", default: "2000" },
    reads: { type: "string", default: "500" },
    pg: { type: "string" },
    json: { type: "boolean", default: false },
  },
});
const ROWS = Number(values.rows);
const READS = Number(values.reads);

interface Item {
  id: string;
  owner: string;
  n: number;
  title: string;
}
type Who = { id: string };

let seq = 0;
function model() {
  return defineModel<Item>(`BenchItem${++seq}`, {
    fields: { id: "string", owner: "string", n: "number", title: "string" },
    attrs: { owner: { index: true } },
    read: (a: Who, r) => a.id === "root" || r.owner === a.id,
    write: (a: Who, r) => a.id === "root" || r.owner === a.id,
    readWhere: { or: [{ cmp: "==", l: { actor: ["id"] }, r: { value: "root" } }, { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } }] },
    writeWhere: { or: [{ cmp: "==", l: { actor: ["id"] }, r: { value: "root" } }, { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } }] },
  });
}

type Result = { driver: string; op: string; n: number; ms: number; perSec: number };
const results: Result[] = [];

async function time(driver: string, op: string, n: number, fn: () => unknown | Promise<unknown>) {
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  results.push({ driver, op, n, ms: Math.round(ms * 10) / 10, perSec: Math.round((n / ms) * 1000) });
}

async function suite(driver: string, m: Model<Item>, async: boolean) {
  const root = m.as({ id: "root" });
  const owners = ["ann", "bob", "cy", "dee"];
  const item = (i: number): Item => ({ id: `i${i}`, owner: owners[i % owners.length]!, n: i, title: `item ${i}` });
  const each = (n: number, f: (i: number) => unknown): unknown => {
    if (!async) {
      for (let i = 0; i < n; i++) f(i);
      return;
    }
    return (async () => {
      for (let i = 0; i < n; i++) await f(i);
    })();
  };
  await time(driver, "insert (one tx)", ROWS, () =>
    async ? asyncTransaction(() => each(ROWS, (i) => root.create(item(i))) as Promise<unknown>) : transaction(() => each(ROWS, (i) => root.create(item(i)))),
  );
  const ann = m.as({ id: "ann" });
  await time(driver, "get by key", READS, () => each(READS, (i) => ann.get(`i${(i * 4) % ROWS}`)));
  await time(driver, "policy-scoped page (20)", READS, () =>
    each(READS, (i) => ann.query().where({ n: { gte: i % ROWS } }).orderBy("n").limit(20).all()),
  );
  await time(driver, "count", READS, () => each(READS, (i) => ann.query().where({ n: { lt: i % ROWS } }).count()));
  await time(driver, "update one", READS, () =>
    each(READS, (i) => {
      const k = `i${(i * 4) % ROWS}`;
      return ann.update((r) => r.id === k, { title: `t${i}` });
    }),
  );
}

{
  const m = model();
  useDatabase(openSqlite(":memory:"), [m] as Model<never>[]);
  await suite("sqlite", m, false);
}
{
  const m = model();
  await usePostgres(pgliteAsPool(new PGlite()), [m] as Model<never>[], { onWarning: () => {} });
  await suite("pglite", m, true);
}
if (values.pg) {
  const pool = (await openPostgres(values.pg)) as PgPool & { end(): Promise<void> };
  try {
    const m = model();
    await usePostgres(pool, [m] as Model<never>[], { onWarning: () => {} });
    await suite("postgres", m, true);
    await pool.query(`DROP TABLE IF EXISTS "${m.name}"`);
  } finally {
    await pool.end();
  }
}

if (values.json) console.log(JSON.stringify(results, null, 2));
else console.table(results);
