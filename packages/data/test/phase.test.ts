import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentPhase, defineModel, inBuildPhase, isBuildPhase } from "../src/index.ts";
import { openPostgres, usePostgres } from "../src/postgres.ts";

test("during a build the database is never opened, and queries say why", async () => {
  assert.equal(currentPhase(), "run");
  const M = defineModel<{ id: string }>(`PhaseItem${Date.now()}`, { fields: { id: "string" }, read: () => true, write: () => true });
  const dir = mkdtempSync(join(tmpdir(), "weft-phase-"));
  try {
    const target = join(dir, "missing", "nested", "db");
    await inBuildPhase(async () => {
      assert.equal(isBuildPhase(), true);
      const pool = await openPostgres(`pglite:${target}`);
      assert.deepEqual(await usePostgres(pool, [M as never]), { steps: [], warnings: [], rebuilt: [] });
      await assert.rejects(pool.query("select 1"), /not opened during `weft build`/);
      await pool.end();
    });
    assert.equal(existsSync(target), false, "nothing is created on disk during a build");
    assert.equal(isBuildPhase(), false, "the phase is restored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pglite directory is created with its parents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-pglite-"));
  try {
    const pool = await openPostgres(`pglite:${join(dir, "a", "b", "db")}`);
    const res = await pool.query("select 1 as one");
    assert.equal((res.rows[0] as { one: number }).one, 1);
    await pool.end();
    assert.equal(existsSync(join(dir, "a", "b", "db")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
