import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel, type Model } from "@weft-framework/data";
import { ModelStorage } from "../src/storage.ts";
import { redactUrl } from "../src/migrate.ts";
import { parseConfig } from "../src/config.ts";

test("storage: a pglite: database attaches async Postgres drivers", async () => {
  const Notes = defineModel<{ id: string; body: string }>("PgNote", {
    fields: { id: "string", body: "string" },
    read: () => true,
    write: () => true,
  });
  const storage = new ModelStorage();
  await storage.attach([Notes] as Model<unknown>[], { database: "pglite:memory", onWarning: () => {} });
  assert.equal(Notes.isAsync, true);
  await Notes.as({}).create({ id: "1", body: "hi" });
  assert.deepEqual((await Notes.as({}).all()).map((n) => n.body), ["hi"]);
  storage.close();
});

test("config: database accepts postgres:// and pglite:, still rejects other URLs", () => {
  assert.equal(parseConfig({ database: "postgres://u:p@h/db" }).database, "postgres://u:p@h/db");
  assert.equal(parseConfig({ database: "pglite:./data/pg" }).database, "pglite:./data/pg");
  assert.throws(() => parseConfig({ database: "mysql://h/db" }), /postgres:\/\//);
});

test("migrate: database URLs are printed without the password", () => {
  assert.equal(redactUrl("postgres://loom:s3cret@db:5432/loom"), "postgres://loom:***@db:5432/loom");
  assert.equal(redactUrl("pglite:memory"), "pglite:memory");
});
