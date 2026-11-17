import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defineModel,
  fieldSpec,
  holdFile,
  holdsFile,
  onFileRelease,
  sweepHeldFiles,
  transaction,
  useDatabase,
  type FileRef,
} from "../src/index.ts";
import { setFileClock } from "../src/files.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Profile {
  id: string;
  owner: string;
  avatar: FileRef | null;
  cover: FileRef | null;
}

function profiles() {
  return defineModel<Profile>("Profile", {
    fields: { id: "string", owner: "string", avatar: "File | null", cover: "File | null" },
    read: (actor, row) => actor === row.owner,
    write: (actor, row) => actor === row.owner,
  });
}

const f = (id: string) => id as FileRef;

function released(): { ids: string[]; stop: () => void } {
  const ids: string[] = [];
  return { ids, stop: onFileRelease((id) => ids.push(id)) };
}

test("File fields are text, and only one file per field", () => {
  const s = fieldSpec("avatar", "File | null");
  assert.equal(s.kind, "text");
  assert.equal(s.file, true);
  assert.equal(s.nullable, true);
  assert.equal(fieldSpec("a", "FileRef").file, true);
  assert.equal(fieldSpec("a", "string").file, false);
  assert.equal(fieldSpec("a", "Profile").file, false);
  for (const t of ["File[]", "File | string", "{ file: File }", "Array<FileRef>"]) {
    assert.throws(() => fieldSpec("a", t), /holds one file/, t);
  }
  assert.deepEqual(profiles().fileFields, ["avatar", "cover"]);
});

test("a row takes only a file the actor holds, once", () => {
  const P = profiles();
  const r = released();
  try {
    assert.throws(() => P.as("alice").create({ id: "p1", owner: "alice", avatar: f("f".repeat(32)), cover: null }), /not a file claimed/);
    assert.equal(P.as("alice").get("p1"), undefined, "nothing written");

    holdFile("a".repeat(32), "alice");
    assert.throws(() => P.as("mallory").create({ id: "m1", owner: "mallory", avatar: f("a".repeat(32)), cover: null }), /not a file claimed/);
    assert.equal(holdsFile("a".repeat(32), "alice"), true);
    assert.throws(
      () => P.as("alice").create({ id: "p1", owner: "alice", avatar: f("a".repeat(32)), cover: f("a".repeat(32)) }),
      /not a file claimed/,
    );
    const row = P.as("alice").create({ id: "p1", owner: "alice", avatar: f("a".repeat(32)), cover: null });
    assert.equal(row?.avatar, "a".repeat(32));
    assert.equal(holdsFile("a".repeat(32), "alice"), false, "used up");
    assert.throws(() => P.as("alice").create({ id: "p2", owner: "alice", avatar: f("a".repeat(32)), cover: null }), /not a file claimed/);
    assert.equal(P.as("alice").update((p) => p.id === "p1", { owner: "alice", avatar: f("a".repeat(32)) }), 1);
    holdFile("b".repeat(32), { id: "u1" });
    assert.equal(holdsFile("b".repeat(32), { id: "u1", role: "admin" }), true);
    assert.equal(holdsFile("b".repeat(32), { id: "u2" }), false);
    assert.equal(holdsFile("b".repeat(32), null), false);
    assert.deepEqual(r.ids, [], "nothing released");
  } finally {
    r.stop();
  }
});

test("replacing, clearing or deleting releases the old file after commit", () => {
  const P = profiles();
  const r = released();
  try {
    holdFile("1".repeat(32), "alice");
    P.as("alice").create({ id: "p1", owner: "alice", avatar: f("1".repeat(32)), cover: null });
    holdFile("2".repeat(32), "alice");
    assert.equal(P.as("alice").update((p) => p.id === "p1", { avatar: f("2".repeat(32)) }), 1);
    assert.deepEqual(r.ids, ["1".repeat(32)]);
    assert.equal(P.as("alice").update((p) => p.id === "p1", { avatar: null }), 1);
    assert.deepEqual(r.ids, ["1".repeat(32), "2".repeat(32)]);

    holdFile("3".repeat(32), "alice");
    holdFile("4".repeat(32), "alice");
    P.as("alice").update((p) => p.id === "p1", { avatar: f("3".repeat(32)), cover: f("4".repeat(32)) });
    assert.equal(P.as("mallory").delete(() => true), 0);
    assert.equal(r.ids.length, 2);
    assert.equal(P.as("alice").delete((p) => p.id === "p1"), 1);
    assert.deepEqual(r.ids.slice(2).sort(), ["3".repeat(32), "4".repeat(32)]);

    holdFile("5".repeat(32), "alice");
    holdFile("6".repeat(32), "alice");
    holdFile("7".repeat(32), "alice");
    P.as("alice").create({ id: "q1", owner: "alice", avatar: f("5".repeat(32)), cover: null });
    P.as("alice").create({ id: "q2", owner: "alice", avatar: f("6".repeat(32)), cover: null });
    assert.throws(() => P.as("alice").update(() => true, { cover: f("7".repeat(32)) }), /one row/);
    assert.equal(P.as("alice").get("q1")?.cover, null, "nothing written");
    assert.equal(holdsFile("7".repeat(32), "alice"), true, "still held");
    assert.equal(P.as("alice").update((p) => p.id === "q1", { owner: "bob", cover: f("7".repeat(32)) }), 0);
    assert.equal(holdsFile("7".repeat(32), "alice"), true);
  } finally {
    r.stop();
  }
});

test("a rollback keeps the old file and gives the hold back", () => {
  const P = profiles();
  const r = released();
  try {
    holdFile("c".repeat(32), "alice");
    P.as("alice").create({ id: "p1", owner: "alice", avatar: f("c".repeat(32)), cover: null });
    holdFile("d".repeat(32), "alice");
    assert.throws(() =>
      transaction(() => {
        P.as("alice").update((p) => p.id === "p1", { avatar: f("d".repeat(32)) });
        assert.deepEqual(r.ids, [], "not released before the commit");
        throw new Error("boom");
      }),
    /boom/);
    assert.equal(P.as("alice").get("p1")?.avatar, "c".repeat(32));
    assert.deepEqual(r.ids, [], "the old file is still in the row");
    assert.equal(holdsFile("d".repeat(32), "alice"), true, "hold given back");
    transaction(() => {
      P.as("alice").update((p) => p.id === "p1", { avatar: f("d".repeat(32)) });
      assert.deepEqual(r.ids, []);
    });
    assert.deepEqual(r.ids, ["c".repeat(32)]);
  } finally {
    r.stop();
  }
});

test("holds expire and the sweep releases them", () => {
  let now = 1_000_000;
  const prev = setFileClock(() => now);
  const r = released();
  try {
    sweepHeldFiles();
    r.ids.length = 0;
    holdFile("e".repeat(32), "alice", 60_000);
    now += 59_999;
    assert.equal(holdsFile("e".repeat(32), "alice"), true);
    assert.equal(sweepHeldFiles(), 0);
    now += 1;
    assert.equal(holdsFile("e".repeat(32), "alice"), false);
    const P = profiles();
    assert.throws(() => P.as("alice").create({ id: "p1", owner: "alice", avatar: f("e".repeat(32)), cover: null }), /not a file claimed/);
    assert.equal(sweepHeldFiles(), 1);
    assert.deepEqual(r.ids, ["e".repeat(32)]);
    assert.throws(() => holdFile("", "alice"), /file id/);
    assert.throws(() => holdFile("x", "alice", 0), /ttlMs/);
    const stop = onFileRelease(() => {
      throw new Error("listener down");
    });
    try {
      holdFile("9".repeat(32), "alice");
      P.as("alice").create({ id: "p9", owner: "alice", avatar: f("9".repeat(32)), cover: null });
      assert.equal(P.as("alice").delete(() => true), 1);
      assert.deepEqual(r.ids, ["e".repeat(32), "9".repeat(32)]);
    } finally {
      stop();
    }
  } finally {
    r.stop();
    setFileClock(prev);
  }
});

test("File fields in SQLite are text columns", () => {
  const db = openSqlite(":memory:");
  const P = profiles();
  useDatabase(db, [P as never]);
  const cols = db.prepare(`PRAGMA table_info("Profile")`).all() as { name: string; type: string }[];
  assert.equal(cols.find((c) => c.name === "avatar")?.type, "TEXT");
  holdFile("0".repeat(32), "alice");
  P.as("alice").create({ id: "p1", owner: "alice", avatar: f("0".repeat(32)), cover: null });
  assert.equal(P.as("alice").get("p1")?.avatar, "0".repeat(32));
  assert.equal(P.as("alice").get("p1")?.cover, null);
});
