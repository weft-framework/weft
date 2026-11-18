import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { defineModel, enlistAsync, type Model } from "../src/index.ts";
import { applyPgPolicies, pgliteAsPool, pgPolicies, policyToRls, usePostgres, withActor } from "../src/postgres.ts";

type Who = { id: string; admin?: boolean };

test("RLS from readWhere/writeWhere limits raw SQL run as the restricted role", async () => {
  const pool = pgliteAsPool(new PGlite());
  const Doc = defineModel<{ id: string; owner: string; open: boolean }>("RlsDoc", {
    fields: { id: "string", owner: "string", open: "boolean" },
    read: (a: Who, r) => a.admin === true || r.open || a.id === r.owner,
    write: (a: Who, r) => a.id === r.owner,
    readWhere: { or: [{ truthy: { actor: ["admin"] } }, { truthy: { field: ["open"] } }, { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } }] },
    writeWhere: { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } },
  });
  const Plain = defineModel<{ id: string }>("RlsPlain", { fields: { id: "string" }, read: () => true, write: () => true });
  await usePostgres(pool, [Doc, Plain] as Model<never>[], { onWarning: () => {} });
  await Doc.as({ id: "ann" }).create({ id: "a1", owner: "ann", open: false });
  await Doc.as({ id: "bob" }).create({ id: "b1", owner: "bob", open: false });
  await Doc.as({ id: "bob" }).create({ id: "b2", owner: "bob", open: true });

  const plan = await applyPgPolicies(pool, [Doc, Plain]);
  assert.deepEqual(plan.skipped, [{ model: "RlsPlain", reason: "no readWhere" }]);
  assert.equal(pgPolicies([Doc]).sql.filter((s) => s.startsWith("CREATE POLICY")).length, 4);

  const raw = async (sql: string, values?: unknown[]) => (await enlistAsync(pool)!).query(sql, values);
  const ids = async (who: Who, grants?: Record<string, { read?: string[] }>) =>
    withActor(pool, who, async () => ((await raw(`SELECT id FROM "RlsDoc" ORDER BY id`)).rows as { id: string }[]).map((r) => r.id), { grants });

  assert.deepEqual(await ids({ id: "ann" }), ["a1", "b2"], "own rows and open rows");
  assert.deepEqual(await ids({ id: "bob" }), ["b1", "b2"]);
  assert.deepEqual(await ids({ id: "zed", admin: true }), ["a1", "b1", "b2"]);
  assert.deepEqual(await ids({ id: "zed" }, { RlsDoc: { read: ["b1"] } }), ["b1", "b2"], "grant-shared keys stay visible");
  assert.deepEqual(await ids(null as unknown as Who), ["b2"], "no actor: only what the rule allows anyone");

  await assert.rejects(
    withActor(pool, { id: "ann" }, () => raw(`INSERT INTO "RlsDoc" (id, owner, open) VALUES ('x', 'bob', false)`)),
    /row-level security/,
  );
  const updated = await withActor(pool, { id: "ann" }, () => raw(`UPDATE "RlsDoc" SET open = true WHERE id = 'b1'`));
  assert.equal((updated as { affectedRows?: number }).affectedRows ?? 0, 0);

  // model writes still work inside withActor, and the table owner (Weft's connection) bypasses RLS
  await withActor(pool, { id: "ann" }, () => Doc.as({ id: "ann" }).create({ id: "a2", owner: "ann", open: false }));
  assert.equal((await Doc.as({ id: "zed", admin: true }).all()).length, 4);
});

test("policyToRls drops untranslatable AND parts and refuses untranslatable ORs", () => {
  const cols = new Set(["owner", "n"]);
  assert.equal(policyToRls({ cmp: "==", l: { field: ["missing"] }, r: { value: 1 } }, cols), null);
  const loose = policyToRls({ and: [{ cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } }, { cmp: "==", l: { field: ["missing"] }, r: { value: 1 } }] }, cols);
  assert.match(loose!, /owner/);
  assert.doesNotMatch(loose!, /missing/);
  assert.equal(policyToRls({ or: [{ truthy: { field: ["owner"] } }, { truthy: { field: ["missing"] } }] }, cols), null);
  assert.equal(policyToRls({ not: { and: [{ truthy: { field: ["owner"] } }, { truthy: { field: ["missing"] } }] } }, cols), null);
  assert.match(policyToRls({ cmp: "==", l: { field: ["owner"] }, r: { value: "it's" } }, cols)!, /'"it''s"'::jsonb/);
});
