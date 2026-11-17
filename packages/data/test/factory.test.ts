import { test } from "node:test";
import assert from "node:assert/strict";
import { defineFactory, defineModel } from "../src/index.ts";

interface Task {
  id: string;
  title: string;
  owner: string;
  done: boolean;
}

function setup() {
  const Task = defineModel<Task>("FactoryTask", {
    fields: { id: "string", title: "string", owner: "string", done: "boolean" },
    read: () => true,
    write: (a: { id: string }, t) => t.owner === a.id,
  });
  const tasks = defineFactory(Task, (n, f) => ({ id: `t${n}`, title: `Task ${n} for ${f.owner ?? "ada"}`, owner: "ada", done: n % 2 === 0 }));
  return { Task, tasks };
}

test("build: a sequence, overrides win and are seen by the builder", () => {
  const { tasks } = setup();
  assert.deepEqual(tasks.build(), { id: "t1", title: "Task 1 for ada", owner: "ada", done: false });
  assert.deepEqual(tasks.build({ owner: "bob" }), { id: "t2", title: "Task 2 for bob", owner: "bob", done: true });
  assert.deepEqual(tasks.buildMany(2).map((t) => t.id), ["t3", "t4"]);
  tasks.reset();
  assert.equal(tasks.build().id, "t1");
  assert.throws(() => tasks.buildMany(-1), /count/);
  assert.throws(() => tasks.buildMany(1.5), /count/);
  assert.throws(() => tasks.build(null as never), /overrides/);
});

test("create goes through the write rule; a refusal throws", () => {
  const { Task, tasks } = setup();
  const ada = { id: "ada" };
  const made = tasks.create(ada, { title: "Mine" });
  assert.equal(made.title, "Mine");
  assert.deepEqual(Task.as(ada).get(made.id), made);
  assert.throws(() => tasks.create({ id: "bob" }), /FactoryTask factory: the write rule refused/);
  assert.equal(Task.as(ada).all().length, 1, "nothing stored for the refusal");
  const many = tasks.createMany(ada, 3);
  assert.deepEqual(many.map((t) => t.id), ["t3", "t4", "t5"], "the refused build used t2");
  assert.equal(Task.as(ada).all().length, 4);

  assert.throws(() => defineFactory(null as never, () => ({}) as never), /needs a model/);
  assert.throws(() => defineFactory(Task, null as never), /builder/);
  const broken = defineFactory(Task, () => null as never);
  assert.throws(() => broken.build(), /returns the row/);
});
