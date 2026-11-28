import { test } from "node:test";
import assert from "node:assert/strict";
import { openSqlite } from "@weft-framework/data/sqlite";
import { SqlSessionStore } from "../src/auth.ts";

test("SqlSessionStore keeps the sign-in address of a session", () => {
  const store = new SqlSessionStore(openSqlite(":memory:"));
  store.set("s1", { user: "u1", created: 1, seen: 2, agent: "Firefox", address: "203.0.113.7" });
  store.set("s2", { user: "u1", created: 3, seen: 4 });
  assert.equal(store.get("s1")?.address, "203.0.113.7");
  assert.equal(store.get("s2")?.address, undefined);
  const rows = store.forUser("u1").sort((a, b) => a.sid.localeCompare(b.sid));
  assert.deepEqual(rows.map((r) => r.record.address ?? null), ["203.0.113.7", null]);
});

test("SqlSessionStore adds the address column to an older table", () => {
  const db = openSqlite(":memory:");
  db.exec(`CREATE TABLE "weft_sessions" (sid TEXT PRIMARY KEY NOT NULL, user TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL)`);
  const store = new SqlSessionStore(db);
  store.set("s1", { user: "u1", created: 1, seen: 1, address: "2001:db8::1" });
  assert.equal(store.get("s1")?.address, "2001:db8::1");
});
