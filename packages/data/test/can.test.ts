import { test } from "node:test";
import assert from "node:assert/strict";
import { can, defineModel, readOnlyActor } from "../src/index.ts";
import { can as runtimeCan } from "../../runtime/src/can.ts";

type Task = { id: string; owner: string; team: string; title: string };

function models() {
  const n = Math.random().toString(36).slice(2);
  const Team = defineModel<{ id: string; name: string }>(`CanTeam${n}`, {
    fields: { id: "string", name: "string" },
    read: () => true,
    write: (a: { admin?: boolean }) => a.admin === true,
  });
  const Task = defineModel<Task>(`CanTask${n}`, {
    fields: { id: "string", owner: "string", team: "string", title: "string" },
    read: () => true,
    write: (a: { id: string }, r) => r.owner === a.id,
  });
  Team.driver.insert({ id: "t1", name: "Ops" });
  Task.driver.insert({ id: "a", owner: "ada", team: "t1", title: "Ada's" });
  Task.driver.insert({ id: "b", owner: "bob", team: "t1", title: "Bob's" });
  return { Team, Task };
}

test("can: every way a row is handed out answers by the rules", () => {
  const { Team, Task } = models();
  const ada = { id: "ada" };
  const [a, b] = Task.as(ada).all();
  assert.deepEqual([can("write", a), can("write", b), can("read", b)], [true, false, true]);
  assert.equal(can("write", Task.as(ada).get("a")), true);
  assert.equal(can("write", Task.as(ada).find((t) => t.id === "b")), false);
  assert.equal(can("write", Task.as(ada).create({ id: "c", owner: "ada", team: "t1", title: "new" })), true);

  const picked = Task.as(ada).query().select("title").all();
  assert.deepEqual(picked.map((r) => can("write", r)), [true, false, true], "a projection without the key still answers");
  const joined = Task.as(ada).query().with("teamRow", Team, "team").all() as Array<Task & { teamRow: object }>;
  assert.equal(can("write", joined[0]), true);
  assert.equal(can("write", joined[0]!.teamRow), false, "a related row answers by its own model");
  assert.equal(can("read", joined[0]!.teamRow), true);

  assert.equal(runtimeCan("write", a), true, "the runtime finds the checker");
  assert.equal(runtimeCan("write", b), false);
});

test("can fails closed: copies, hand-made rows, read-only actors, changed rows", () => {
  const { Task } = models();
  const ada = { id: "ada" };
  const a = Task.as(ada).get("a")!;
  assert.equal(can("write", { ...a }), false, "a spread copy was not handed out");
  assert.equal(can("write", { id: "a", owner: "ada", team: "t1", title: "x" }), false);
  assert.equal(can("write", null), false);
  assert.equal(can("delete" as never, a), false);
  assert.equal(runtimeCan("write", "a"), false);

  const b = Task.as(ada).get("b")!;
  (b as Task).owner = "ada";
  assert.equal(can("write", b), false);

  assert.equal(Task.as(ada).query().where({ id: "a" }).update({ owner: "bob" }), 0, "the rule refuses giving it away");
  Task.driver.update("a", { id: "a", owner: "bob", team: "t1", title: "Ada's" });
  assert.equal(can("write", a), false);
  Task.driver.update("a", { id: "a", owner: "ada", team: "t1", title: "Ada's" });
  assert.equal(can("write", a), true);
  Task.as({ id: "ada" }).query().where({ id: "a" }).delete();
  assert.equal(can("read", a), false, "a deleted row is no");

  const viewer = readOnlyActor({ id: "bob" });
  const seen = Task.as(viewer).get("b")!;
  assert.deepEqual([can("read", seen), can("write", seen)], [true, false], "view as never shows a write control");
});
