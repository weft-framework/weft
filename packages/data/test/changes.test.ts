import { test } from "node:test";
import assert from "node:assert/strict";
import { canSee, ChangeFeed, defineModel, onRead, UNSCOPED, type Change } from "../src/index.ts";

interface Note {
  id: string;
  owner: string;
  text: string;
}

function notes() {
  const feed = new ChangeFeed();
  const m = defineModel<Note>("Note", {
    fields: { id: "string", owner: "string", text: "string" },
    read: (a, r) => (a as { id: string }).id === r.owner,
    write: (a, r) => (a as { id: string }).id === r.owner,
  }).publishTo(feed);
  const seen: Change[] = [];
  feed.subscribe((c) => seen.push(c));
  return { m, feed, seen };
}

test("writes publish copies of both sides after they apply", () => {
  const { m, seen } = notes();
  const a = { id: "a" };
  m.as(a).create({ id: "n1", owner: "a", text: "hi" });
  m.as(a).update((n) => n.id === "n1", { text: "hello" });
  m.as(a).delete(() => true);
  assert.deepEqual(
    seen.map((c) => [c.op, c.key, c.before?.text ?? null, (c.after as Note | undefined)?.text ?? null]),
    [
      ["create", "n1", null, "hi"],
      ["update", "n1", "hi", "hello"],
      ["delete", "n1", "hello", null],
    ],
  );
  (seen[0].after as Note).text = "mutated";
  assert.equal(m.publicUnscoped().length, 0);
});

test("denied writes publish nothing", () => {
  const { m, seen } = notes();
  m.as({ id: "a" }).create({ id: "n1", owner: "a", text: "x" });
  seen.length = 0;
  assert.equal(m.as({ id: "b" }).create({ id: "n2", owner: "a", text: "x" }), undefined);
  assert.equal(m.as({ id: "b" }).update(() => true, { text: "y" }), 0);
  assert.equal(m.as({ id: "a" }).update(() => true, { owner: "b" }), 0);
  assert.equal(m.as({ id: "b" }).delete(() => true), 0);
  assert.deepEqual(seen, []);
});

test("a failing listener never fails the write", () => {
  const { m, feed } = notes();
  const errors: unknown[] = [];
  const g = globalThis as { reportError?: (e: unknown) => void };
  const prev = g.reportError;
  g.reportError = (e) => errors.push(e);
  try {
    feed.subscribe(() => {
      throw new Error("boom");
    });
    assert.ok(m.as({ id: "a" }).create({ id: "n1", owner: "a", text: "x" }));
    assert.equal(m.as({ id: "a" }).all().length, 1);
    assert.equal(errors.length, 1);
  } finally {
    g.reportError = prev;
  }
});

test("reads are observed with their actor", () => {
  const { m } = notes();
  const reads: unknown[] = [];
  const stop = onRead((model, actor) => reads.push([model.name, actor]));
  const a = { id: "a" };
  m.as(a).all();
  m.as(a).get("x");
  m.publicUnscoped();
  stop();
  m.as(a).all();
  assert.deepEqual(reads, [
    ["Note", a],
    ["Note", a],
    ["Note", UNSCOPED],
  ]);
});

test("relevance follows the read rule on either side of a change", () => {
  const { m } = notes();
  const moved: Change = { model: "Note", op: "update", key: "n", before: { id: "n", owner: "a", text: "" }, after: { id: "n", owner: "b", text: "" } };
  const generic = m as never;
  assert.equal(canSee(generic, { id: "a" }, moved), true, "lost access: must refresh");
  assert.equal(canSee(generic, { id: "b" }, moved), true, "gained access");
  assert.equal(canSee(generic, { id: "c" }, moved), false, "never visible: not told");
  assert.equal(canSee(generic, UNSCOPED, moved), true);
  const throwing = defineModel<Note>("T", { fields: { id: "string" }, read: () => { throw new Error("x"); } });
  assert.equal(canSee(throwing as never, { id: "a" }, moved), false);
});
