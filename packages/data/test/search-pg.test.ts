import { test, after } from "node:test";
import assert from "node:assert/strict";
import { defineModel, defineSearch, transaction, useDatabase, type PgQueryable } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

const URL_ = process.env.WEFT_TEST_PG;
const skip = URL_ ? false : "set WEFT_TEST_PG to run against Postgres";
let pool: (PgQueryable & { end(): Promise<void> }) | null = null;
after(() => pool?.end());

interface Doc {
  id: string;
  owner: string;
  title: string;
  body: string;
}

test("candidates from Postgres; the read rules decide, ranking among readable rows", { skip }, async () => {
  const pg = (await import("pg")).default;
  pool = new pg.Pool({ connectionString: URL_, max: 4 }) as never;
  const table = `weft_search_t${process.pid}`;
  after(() => pool!.query(`DROP TABLE IF EXISTS "${table}"`));

  for (const store of ["memory", "sqlite"] as const) {
    await pool!.query(`DROP TABLE IF EXISTS "${table}"`);
    const Doc = defineModel<Doc>(`PgDoc${store}`, {
      fields: { id: "string", owner: "string", title: "string", body: "string" },
      read: (a, r) => a === r.owner,
      write: (a, r) => a === r.owner,
    });
    if (store === "sqlite") useDatabase(openSqlite(":memory:"), [Doc as never]);
    Doc.as("ada").create({ id: "d1", owner: "ada", title: "Quarterly report", body: "Revenue grew" });
    Doc.as("bob").create({ id: "d2", owner: "bob", title: "Report report report", body: "Bob's merger report" });
    const s = defineSearch(Doc, { fields: { title: 3, body: 1 } });
    await s.usePg(pool!, { table });

    const r = await s.searchAsync(Doc.as("ada"), "REPORT");
    assert.deepEqual(r.hits.map((h) => h.row.id), ["d1"], `${store}: bob's row is not a result`);
    assert.equal(r.total, 1);
    assert.deepEqual((await s.searchAsync(Doc.as("bob"), "merg")).hits.map((h) => h.row.id), ["d2"], "the last word as a prefix");

    Doc.as("ada").create({ id: "d3", owner: "ada", title: "Příliš žluťoučký kůň", body: "" });
    Doc.as("ada").update((d) => d.id === "d1", { title: "Annual summary" });
    await s.flush();
    assert.deepEqual((await s.searchAsync(Doc.as("ada"), "zlutoucky")).hits.map((h) => h.row.id), ["d3"]);
    assert.deepEqual((await s.searchAsync(Doc.as("ada"), "report")).hits.map((h) => h.row.id), [], "the old words are gone");
    assert.deepEqual((await s.searchAsync(Doc.as("ada"), "annual")).hits.map((h) => h.row.id), ["d1"]);

    assert.throws(() =>
      transaction(() => {
        Doc.as("ada").create({ id: "d4", owner: "ada", title: "Ghost", body: "" });
        throw new Error("no");
      }),
    );
    Doc.as("ada").delete((d) => d.id === "d3");
    await s.flush();
    const left = await pool!.query(`SELECT k FROM "${table}" ORDER BY k`);
    assert.deepEqual(left.rows.map((x) => x.k), ["d1", "d2"]);

    for (const q of ["report | merger", "!report", "'report' & 'x':*", "report <-> merger", "a:*B", "\\'; DROP TABLE x; --"]) {
      await s.searchAsync(Doc.as("bob"), q);
    }
    assert.deepEqual((await s.searchAsync(Doc.as("bob"), "report | xyz")).hits, [], "| is not OR: every word is required");

    await pool!.query(`DELETE FROM "${table}"`);
    await s.reindex();
    assert.deepEqual((await s.searchAsync(Doc.as("bob"), "report")).hits.map((h) => h.row.id), ["d2"]);
    assert.deepEqual((await s.searchAsync(Doc.as("bob"), "bob report")).hits, s.search(Doc.as("bob"), "bob report").hits);
    s.stopPg();
  }
});
