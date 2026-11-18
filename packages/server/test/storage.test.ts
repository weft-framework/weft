import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineModel } from "@weft-framework/data";
import { ModelStorage } from "../src/storage.ts";
import { parseConfig } from "../src/config.ts";

type Note = { id: string; text: string };

function note(fields: Record<string, string> = { id: "string", text: "string" }) {
  return defineModel<Note>("Note", { fields, read: () => true, write: () => true });
}

test("memory: rows carry over to a rebuilt model with the same schema", async () => {
  const storage = new ModelStorage();
  const first = note();
  await storage.attach([first]);
  first.as({}).create({ id: "a", text: "kept" });

  const second = note();
  await storage.attach([second]);
  assert.deepEqual(second.publicUnscoped(), [{ id: "a", text: "kept" }]);

  const changed = note({ id: "string", text: "string", done: "boolean" });
  await storage.attach([changed]);
  assert.deepEqual(changed.publicUnscoped(), [], "a changed schema starts empty");

  await storage.attach([]);
  const back = note({ id: "string", text: "string", done: "boolean" });
  await storage.attach([back]);
  assert.deepEqual(back.publicUnscoped(), [], "a removed model's rows are dropped");
});

test("database: rows persist across builds and a reopened storage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-storage-"));
  const file = join(dir, "nested", "app.db");
  try {
    const storage = new ModelStorage();
    const first = note();
    await storage.attach([first], { database: file, onWarning: () => undefined });
    assert.ok(existsSync(file), "the directory is created");
    first.as({}).create({ id: "a", text: "on disk" });

    const second = note();
    await storage.attach([second], { database: file });
    assert.deepEqual(second.publicUnscoped(), [{ id: "a", text: "on disk" }]);
    storage.close();

    const restarted = new ModelStorage();
    const third = note();
    await restarted.attach([third], { database: file });
    assert.deepEqual(third.publicUnscoped(), [{ id: "a", text: "on disk" }]);
    restarted.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: database is a path, :memory:, or a Postgres URL; never another URL", () => {
  assert.equal(parseConfig({ database: "data/app.db" }).database, "data/app.db");
  assert.equal(parseConfig({ database: ":memory:" }).database, ":memory:");
  assert.equal(parseConfig({ database: "postgres://x/y" }).database, "postgres://x/y");
  for (const bad of ["", "  ", "mysql://x/y", "http://x/y", "a\0b", 3]) {
    assert.throws(() => parseConfig({ database: bad }), /database must be/);
  }
});
