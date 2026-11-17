import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definePgBackups, dirBackups, pgEnvironment } from "../src/backup.ts";
import { Secret } from "../src/secret.ts";

const here = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.WEFT_TEST_PG;
const BIN = process.env.WEFT_PG_BIN;
const tool = (name: string) => (BIN ? join(BIN, name) : name);

test("the connection goes in PG* variables; inherited ones are dropped", () => {
  const env = pgEnvironment("postgres://ada:p%40ss@db.example:6543/app?sslmode=require", {
    PATH: "/bin",
    PGHOST: "elsewhere",
    PGSERVICE: "evil",
    PGPASSFILE: "/x",
  });
  assert.deepEqual(env, {
    PATH: "/bin",
    PGHOST: "db.example",
    PGPORT: "6543",
    PGDATABASE: "app",
    PGUSER: "ada",
    PGPASSWORD: "p@ss",
    PGSSLMODE: "require",
  });
  assert.equal(pgEnvironment("postgresql://[::1]/app", {}).PGHOST, "::1");
  assert.throws(() => pgEnvironment("mysql://x/app", {}), /postgres/);
  assert.throws(() => pgEnvironment("postgres://x/", {}), /database/);
  assert.throws(() => pgEnvironment("postgres://x/app?host=/tmp", {}), /unsupported url parameter/);
  const target = dirBackups(join(here, ".weft", "pg-none"));
  assert.throws(() => definePgBackups({ url: "postgres://x/app", target, keep: 0 }), /keep/);
  assert.throws(() => definePgBackups({ url: "postgres://x/app", target, prefix: "../x" }), /prefix/);
  definePgBackups({ url: new Secret("DATABASE_URL", "postgres://x/app"), target });
});

test("a missing pg_dump is reported as such", async () => {
  const dir = join(here, ".weft", "pg-missing");
  const b = definePgBackups({ url: "postgres://127.0.0.1:1/app", target: dirBackups(dir), pgDump: join(dir, "no-such-pg_dump") });
  await assert.rejects(b.run(), /was not found/);
});

test("dump, prune, restore against Postgres", { skip: URL_ ? false : "set WEFT_TEST_PG to run against Postgres" }, async () => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL_, max: 2 });
  const table = `weft_backup_t${process.pid}`;
  const dir = join(here, ".weft", "pg-backup");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let clock = Date.UTC(2026, 10, 14, 2);
  const titles = async () => (await pool.query(`SELECT title FROM "${table}" ORDER BY id`)).rows.map((r) => r.title);
  try {
    await pool.query(`DROP TABLE IF EXISTS "${table}"`);
    await pool.query(`CREATE TABLE "${table}" (id int PRIMARY KEY, title text)`);
    await pool.query(`INSERT INTO "${table}" VALUES (1, 'first')`);
    const b = definePgBackups({
      url: URL_!,
      target: dirBackups(dir),
      keep: 2,
      pgDump: tool("pg_dump"),
      pgRestore: tool("pg_restore"),
      tmpDir: join(dir, "tmp"),
      now: () => clock,
    });
    const one = await b.run();
    assert.match(one.name, /^backup-20261114T020000000Z\.pgdump$/);
    assert.ok(one.size > 0);
    await pool.query(`INSERT INTO "${table}" VALUES (2, 'second')`);
    clock += 60_000;
    await b.run();
    clock += 60_000;
    await b.run();
    assert.deepEqual(
      (await b.list()).map((f) => f.name),
      ["backup-20261114T020200000Z.pgdump", "backup-20261114T020100000Z.pgdump"],
      "pruned to keep",
    );

    await pool.query(`DELETE FROM "${table}"`);
    await pool.query(`INSERT INTO "${table}" VALUES (3, 'after')`);
    clock += 60_000;
    const r = await b.restore("backup-20261114T020100000Z.pgdump");
    assert.deepEqual(await titles(), ["first", "second"]);
    assert.equal(r.previous, "backup-20261114T020300000Z.pgdump", "a safety dump of what was there");
    await b.restore(r.previous!);
    assert.deepEqual(await titles(), ["after"], "the safety dump restores the replaced data");

    await assert.rejects(b.restore("backup-20261114T020100000Z.sqlite"), /not a backup name/);
    await assert.rejects(b.restore("../backup-20261114T020100000Z.pgdump"), /not a backup name/);
    await assert.rejects(b.restore("backup-20990101T000000000Z.pgdump"), /no backup/);
    writeFileSync(join(dir, "backup-20261114T030000000Z.pgdump"), "not an archive");
    await assert.rejects(b.restore("backup-20261114T030000000Z.pgdump"), /pg_restore failed|failed its check/);
    assert.deepEqual(await titles(), ["after"], "a bad archive changes nothing");
  } finally {
    await pool.query(`DROP TABLE IF EXISTS "${table}"`);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  }
});
