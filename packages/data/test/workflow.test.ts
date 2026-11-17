import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canSee,
  commitImport,
  defineHistory,
  defineModel,
  defineWorkflow,
  previewImport,
  useDatabase,
  type Change,
  type Model,
} from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Post {
  id: string;
  org: string;
  author: string;
  title: string;
  status: "draft" | "review" | "approved";
  deletedAt: number | null;
}
interface Who {
  id: string;
  tenant?: string;
  editor?: boolean;
}

const ada: Who = { id: "ada", tenant: "acme" };
const bob: Who = { id: "bob", tenant: "acme", editor: true };
const cy: Who = { id: "cy", tenant: "acme" };
const eve: Who = { id: "eve", tenant: "evil", editor: true };

function posts() {
  return defineModel<Post, "deletedAt">("Post", {
    fields: { id: "string", org: "string", author: "string", title: "string", status: '"draft" | "review" | "approved"', deletedAt: "number | null" },
    attrs: { org: { tenant: true }, deletedAt: { softDelete: true } },
    read: (a: Who, p) => p.status === "approved" || p.author === a.id || a.editor === true,
    write: (a: Who, p) => (p.author === a.id && p.status !== "approved") || a.editor === true,
  });
}

function setup(driver: "memory" | "sqlite") {
  const Post = posts();
  let clock = 0;
  const flow = defineWorkflow(Post, {
    field: "status",
    initial: "draft",
    now: () => (clock += 1),
    maxNote: 30,
    transitions: {
      submit: { from: "draft", to: "review", allow: (u: Who, p) => p.author === u.id, note: "none" },
      approve: { from: "review", to: "approved", allow: (u: Who, p) => u.editor === true && p.author !== u.id },
      reject: { from: "review", to: "draft", note: "required" },
      reopen: { from: "approved", to: "draft", allow: (u: Who) => u.editor === true },
    },
  });
  if (driver === "sqlite") useDatabase(openSqlite(":memory:"), [Post, flow.model] as Model<never>[]);
  Post.as(ada).create({ id: "p1", org: "acme", author: "ada", title: "Hello" });
  return { Post, flow };
}

for (const driver of ["memory", "sqlite"] as const) {
  test(`${driver}: rows start in the initial state, which only the workflow changes`, () => {
    const { Post } = setup(driver);
    assert.equal(Post.as(ada).get("p1")!.status, "draft");
    assert.throws(() => Post.as(bob).create({ id: "p2", org: "acme", author: "bob", title: "x", status: "approved" }), /rows start with `status` = "draft"/);
    assert.ok(Post.as(bob).create({ id: "p3", org: "acme", author: "bob", title: "x", status: "draft" }), "the initial value may be given");
    assert.throws(() => Post.as(bob).update((p) => p.id === "p1", { status: "approved" }), /changed by the Post workflow, not by update/);
    assert.equal(Post.as(ada).update((p) => p.id === "p1", { title: "Hi" }), 1, "other fields as usual");
    assert.deepEqual(Post.lockedFields, ["status"]);
  });

  test(`${driver}: moves follow from-states, allow and the write rule; steps record them`, () => {
    const { Post, flow } = setup(driver);
    assert.deepEqual(flow.available(Post.as(ada), "p1"), ["submit"]);
    assert.deepEqual(flow.available(Post.as(bob), "p1"), [], "submit is the author's");
    assert.deepEqual(flow.move(Post.as(bob), "p1", "submit"), { ok: false, reason: "not allowed" });
    assert.deepEqual(flow.move(Post.as(cy), "p1", "submit"), { ok: false, reason: "not found" }, "cy cannot read a draft");
    assert.deepEqual(flow.move(Post.as(eve), "p1", "submit"), { ok: false, reason: "not found" }, "nor another tenant");
    assert.deepEqual(flow.move(Post.as(ada), "p1", "approve"), { ok: false, reason: "wrong state" });
    assert.deepEqual(flow.move(Post.as(ada), "p1", "publish"), { ok: false, reason: "no such transition" });
    assert.deepEqual(flow.move(Post.as(ada), "p1", "submit", { note: "please" }), { ok: false, reason: "bad note" });

    const r = flow.move(Post.as(ada), "p1", "submit");
    assert.ok(r.ok);
    assert.equal(r.row.status, "review");
    assert.deepEqual({ ...r.step, id: "" }, { id: "", key: '"p1"', n: 1, transition: "submit", from: "draft", to: "review", by: "ada", at: 1, note: null });
    assert.deepEqual(flow.move(Post.as(ada), "p1", "submit"), { ok: false, reason: "wrong state" }, "once");

    assert.deepEqual(flow.available(Post.as(ada), "p1"), ["reject"]);
    assert.deepEqual(flow.move(Post.as(ada), "p1", "approve"), { ok: false, reason: "not allowed" });
    assert.deepEqual(flow.move(Post.as(bob), "p1", "reject"), { ok: false, reason: "note required" });
    assert.deepEqual(flow.move(Post.as(bob), "p1", "reject", { note: "   " }), { ok: false, reason: "note required" });
    assert.deepEqual(flow.move(Post.as(bob), "p1", "reject", { note: "x".repeat(31) }), { ok: false, reason: "bad note" });
    assert.ok(flow.move(Post.as(bob), "p1", "reject", { note: " Needs a title " }).ok);
    assert.ok(flow.move(Post.as(ada), "p1", "submit").ok);
    assert.ok(flow.move(Post.as(bob), "p1", "approve").ok);

    assert.deepEqual(flow.available(Post.as(ada), "p1"), []);
    assert.deepEqual(flow.available(Post.as(bob), "p1"), ["reopen"]);
    assert.deepEqual(
      flow.steps(Post.as(cy), "p1").map((s) => [s.n, s.transition, s.from, s.to, s.by, s.note]),
      [
        [1, "submit", "draft", "review", "ada", null],
        [2, "reject", "review", "draft", "bob", "Needs a title"],
        [3, "submit", "draft", "review", "ada", null],
        [4, "approve", "review", "approved", "bob", null],
      ],
      "steps of a row cy may now read",
    );
    assert.deepEqual(flow.steps(Post.as(eve), "p1"), []);

    assert.ok(flow.move(Post.as(bob), "p1", "reopen").ok);
    assert.deepEqual(flow.steps(Post.as(cy), "p1"), []);
    assert.equal(flow.model.as(cy).all().length, 0, "not through the model either");
    assert.equal(flow.model.as(ada).all().length, 5);
    assert.equal(flow.model.as(ada).create({ id: "x", key: '"p1"', n: 9, transition: "approve", from: "review", to: "approved", by: "ada", at: 0, note: null }), undefined, "steps are written only by move");
    assert.equal(flow.model.as(bob).update(() => true, { by: "eve" }), 0);
    assert.equal(flow.model.as(bob).delete(() => true), 0);

    Post.as(bob).delete((p) => p.id === "p1");
    assert.deepEqual(flow.move(Post.as(bob), "p1", "submit"), { ok: false, reason: "not found" });
    assert.deepEqual(flow.steps(Post.as(bob), "p1"), []);
    assert.equal(flow.model.publicUnscoped().length, 5);
    Post.as(bob).trash().delete(() => true);
    assert.equal(flow.model.publicUnscoped().length, 0);
  });
}

test("a move whose row changed meanwhile does nothing; steps and moves are one transaction", () => {
  const { Post, flow } = setup("sqlite");
  const scoped = Post.as(ada);
  const realGet = scoped.get.bind(scoped);
  let raced = false;
  scoped.get = ((k: never) => {
    const row = realGet(k);
    if (!raced) {
      raced = true;
      flow.move(Post.as(ada), "p1", "submit");
    }
    return row;
  }) as typeof scoped.get;
  assert.deepEqual(flow.move(scoped, "p1", "submit"), { ok: false, reason: "changed meanwhile" });
  assert.equal(flow.steps(Post.as(ada), "p1").length, 1, "only the move that landed");
});

test("the lock reaches CSV import, history restore and the generated handle", () => {
  const { Post, flow } = setup("memory");
  const preview = previewImport(Post, "id,author,title,status\np9,ada,From CSV,approved\n");
  assert.equal(preview.mapping.status, null, "never imported");
  assert.equal(commitImport(Post.as(ada), preview).created, 1);
  assert.equal(Post.as(ada).get("p9")!.status, "draft");

  const h = defineHistory(Post);
  flow.move(Post.as(ada), "p9", "submit");
  Post.as(bob).update((p) => p.id === "p9", { title: "Edited" });
  flow.move(Post.as(bob), "p9", "reject", { note: "no" });
  assert.equal(h.restore(Post.as(bob), "p9", 1), true);
  const p9 = Post.as(bob).get("p9")!;
  assert.equal(p9.title, "From CSV", "the title restored");
  assert.equal(p9.status, "draft", "the state is not");
  h.stop();
});

test("readers who may not write, and moves into a state the write rule forbids", () => {
  interface Task {
    id: string;
    owner: string;
    stage: "open" | "doing" | "done";
  }
  const Task = defineModel<Task>("Task", {
    fields: { id: "string", owner: "string", stage: '"open" | "doing" | "done"' },
    read: () => true,
    write: (a: Who, t) => (t.owner === a.id && t.stage !== "done") || a.editor === true,
  });
  const flow = defineWorkflow(Task, {
    field: "stage",
    initial: "open",
    transitions: { start: { from: "open", to: "doing" }, finish: { from: "doing", to: "done" } },
  });
  Task.as(ada).create({ id: "t1", owner: "ada" });
  assert.deepEqual(flow.available(Task.as(cy), "t1"), [], "cy reads it but may not write it");
  assert.deepEqual(flow.move(Task.as(cy), "t1", "start"), { ok: false, reason: "not allowed" });
  assert.ok(flow.move(Task.as(ada), "t1", "start").ok);
  assert.deepEqual(flow.available(Task.as(ada), "t1"), [], "ada may not write a done task");
  assert.deepEqual(flow.move(Task.as(ada), "t1", "finish"), { ok: false, reason: "not allowed" });
  assert.deepEqual(flow.available(Task.as(bob), "t1"), ["finish"]);
  assert.ok(flow.move(Task.as(bob), "t1", "finish").ok);
  assert.deepEqual(flow.steps(Task.as(cy), "t1").map((s) => s.to), ["doing", "done"]);
});

test("updateLocked takes only this model's lock", () => {
  const P = posts();
  defineWorkflow(P, { field: "status", initial: "draft", transitions: { submit: { from: "draft", to: "review" } } });
  P.as(ada).create({ id: "p1", org: "acme", author: "ada", title: "x" });
  const Q = defineModel<{ id: string; status: string }>("Q", { fields: { id: "string", status: "string" }, read: () => true, write: () => true });
  const foreign = Q.lock("status", "draft", "someone");
  assert.throws(() => P.as(ada).updateLocked(foreign, () => true, { status: "approved" }), /not a lock on this model/);
  const forged = { model: "Post", field: "status", owner: "me", initial: "draft" };
  assert.throws(() => P.as(ada).updateLocked(forged as never, () => true, { status: "approved" }), /not a lock/);
  assert.equal(P.as(ada).get("p1")!.status, "draft");
});

test("change relevance for steps follows the row", () => {
  const { Post, flow } = setup("memory");
  const got: Change[] = [];
  const off = flow.model.feed.subscribe((c) => {
    if (c.model === flow.model.name) got.push(c);
  });
  flow.move(Post.as(ada), "p1", "submit");
  flow.move(Post.as(bob), "p1", "approve");
  off();
  const M = flow.model as Model<unknown>;
  assert.deepEqual(got.map((c) => canSee(M, cy, c)), [true, true]);
  assert.deepEqual(got.map((c) => canSee(M, eve, c)), [false, false]);
});

test("declarations", () => {
  const mk = () => posts();
  const T = { submit: { from: "draft", to: "review" } };
  assert.throws(() => defineWorkflow({} as never, { field: "status", initial: "draft", transitions: T }), /needs a model/);
  assert.throws(() => defineWorkflow(mk(), { field: "nope" as never, initial: "draft", transitions: T }), /no field `nope`/);
  assert.throws(() => defineWorkflow(mk(), { field: "deletedAt", initial: "draft", transitions: T }), /`string` or a union/);
  assert.throws(() => defineWorkflow(mk(), { field: "status", initial: "draft", transitions: {} }), /no transitions/);
  assert.throws(() => defineWorkflow(mk(), { field: "status", initial: "draft", transitions: { Submit: T.submit } }), /lower-case/);
  assert.throws(() => defineWorkflow(mk(), { field: "status", initial: "draft", transitions: { go: { from: [], to: "review" } } }), /from is a state/);
  assert.throws(() => defineWorkflow(mk(), { field: "status", initial: "draft", transitions: { go: { from: "draft", to: "draft" } } }), /to itself/);
  assert.throws(() => defineWorkflow(mk(), { field: "status", initial: "draft", transitions: { go: { from: "draft", to: "done" } } }), /`done` is not one of `status`/);
  assert.throws(() => defineWorkflow(mk(), { field: "status", initial: "draft", transitions: { go: { from: "approved", to: "review" } } }), /no transition reaches `approved`/);
  assert.throws(() => defineWorkflow(mk(), { field: "status", initial: "draft", transitions: { go: { from: "draft", to: "review", note: "maybe" as never } } }), /note is/);
  assert.throws(() => defineWorkflow(mk(), { field: "status", initial: "draft", transitions: T, maxNote: 0 }), /maxNote/);
  assert.throws(() => defineWorkflow(mk(), { field: "status", initial: "draft", transitions: T, name: "bad name" }), /model name/);
  const P = mk();
  assert.throws(() => defineWorkflow(P, { field: "status", initial: "draft", transitions: {} }));
  assert.deepEqual(P.lockedFields, []);
  const w = defineWorkflow(P, { field: "status", initial: "draft", transitions: T });
  assert.throws(() => defineWorkflow(P, { field: "status", initial: "draft", transitions: T }), /already changed by the Post workflow/);
  assert.throws(() => w.move(mk().as(ada) as never, "p1", "submit"), /pass Post.as/);
  assert.throws(() => P.lock("id", "x", "me"), /cannot be locked/);
  assert.throws(() => P.lock("org", "x", "me"), /cannot be locked/);
  const Q = defineModel<{ id: string; stage: string }>("Q", { fields: { id: "string", stage: "string" }, read: () => true, write: () => true });
  const q = defineWorkflow(Q, { field: "stage", initial: "new", transitions: { start: { from: "new", to: "doing" } } });
  assert.deepEqual(q.states, ["new", "doing"]);
});
