import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPostgres } from "../src/postgres.ts";

test("openPostgres shares one pool per database setting and closes it with the last handle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-pg-shared-"));
  try {
    const url = `pglite:${dir}`;
    const a = await openPostgres(url);
    const b = await openPostgres(url);
    await a.query("create table t (n int)");
    await b.query("insert into t values (1)");
    assert.deepEqual((await a.query("select n from t")).rows, [{ n: 1 }]);
    await a.end();
    await a.end();
    assert.deepEqual((await b.query("select count(*)::int as c from t")).rows, [{ c: 1 }]);
    await b.end();
    const c = await openPostgres(url);
    assert.deepEqual((await c.query("select n from t")).rows, [{ n: 1 }]);
    await c.end();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in-memory pglite databases are never shared", async () => {
  const a = await openPostgres("pglite:memory");
  const b = await openPostgres("pglite:memory");
  await a.query("create table only_in_a (n int)");
  await assert.rejects(b.query("select * from only_in_a"));
  await a.end();
  await b.end();
});
