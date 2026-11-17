import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, defineHistory, defineModel, useDatabase, type Model } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Task {
  id: string;
  owner: string;
  title: string;
  done: boolean;
  private: boolean;
}
interface Note {
  id: string;
  owner: string;
  text: string;
}

const ada = { id: "ada" };
const bob = { id: "bob" };

function setup(driver: "memory" | "sqlite") {
  const Task = defineModel<Task>("Task", {
    fields: { id: "string", owner: "string", title: "string", done: "boolean", private: "boolean" },
    read: (a: { id: string }, r) => !r.private || r.owner === a.id,
    write: (a: { id: string }, r) => r.owner === a.id,
  });
  const Note = defineModel<Note>("Note", {
    fields: { id: "string", owner: "string", text: "string" },
    read: (a: { id: string }, r) => r.owner === a.id,
    write: (a: { id: string }, r) => r.owner === a.id,
  });
  let clock = 0;
  const now = () => (clock += 10);
  const tasks = defineHistory(Task, { now });
  const notes = defineHistory(Note, { now });
  if (driver === "sqlite") {
    useDatabase(openSqlite(":memory:"), [Task, Note, tasks.model, notes.model] as Model<never>[]);
  }
  return { Task, Note, tasks, notes };
}

const sentence = (v: { actor: string | null; action: string; row: Partial<Task>; changes: { field: string; after: unknown }[] }) => {
  if (v.action === "create") return `${v.actor} added ${v.row.title}`;
  if (v.changes.some((c) => c.field === "done" && c.after === true)) return `${v.actor} closed ${v.row.title}`;
  return null;
};

for (const driver of ["memory", "sqlite"] as const) {
  test(`${driver}: the viewer's feed holds only rows they may read now`, () => {
    const { Task, tasks } = setup(driver);
    Task.as(ada).create({ id: "t1", owner: "ada", title: "Ship the beta", done: false, private: false });
    for (let i = 0; i < 30; i++) Task.as(ada).create({ id: `p${i}`, owner: "ada", title: `secret ${i}`, done: false, private: true });
    Task.as(ada).update((t) => t.id === "t1", { done: true });

    const bobs = tasks.recent(Task.as(bob), { limit: 5 });
    assert.deepEqual(bobs.map((v) => [v.key, v.action]), [["t1", "update"], ["t1", "create"]], "30 hidden rows neither show nor crowd out");
    assert.deepEqual(bobs[0]!.changes, [{ field: "done", before: false, after: true }]);
    const adas = tasks.recent(Task.as(ada), { limit: 3 });
    assert.deepEqual(adas.map((v) => v.key), ["t1", "p29", "p28"]);
    const next = tasks.recent(Task.as(ada), { limit: 3, before: adas.at(-1)!.at });
    assert.deepEqual(next.map((v) => v.key), ["p27", "p26", "p25"]);
    Task.as(ada).update((t) => t.id === "t1", { private: true });
    assert.deepEqual(tasks.recent(Task.as(bob)), []);
    Task.as(ada).update((t) => t.id === "t1", { private: false });
    assert.deepEqual(tasks.recent(Task.as(bob), { scan: 1 }).map((v) => v.version), [4]);
  });

  test(`${driver}: activity merges models in time order with the app's wording`, () => {
    const { Task, Note, tasks, notes } = setup(driver);
    Task.as(ada).create({ id: "t1", owner: "ada", title: "Ship the beta", done: false, private: false });
    Note.as(ada).create({ id: "n1", owner: "ada", text: "remember" });
    Task.as(ada).update(() => true, { title: "Ship the beta!" });
    Task.as(ada).update(() => true, { done: true });
    const feed = (who: { id: string }) =>
      activity(
        [
          { history: tasks, scoped: Task.as(who), describe: sentence },
          { history: notes, scoped: Note.as(who), describe: (v) => `${v.actor} wrote a note` },
        ],
        { limit: 10 },
      );
    assert.deepEqual(feed(ada).map((i) => i.text), ["ada closed Ship the beta!", "ada wrote a note", "ada added Ship the beta"]);
    assert.deepEqual(feed(bob).map((i) => i.text), ["ada closed Ship the beta!", "ada added Ship the beta"], "bob cannot read the note");
    assert.deepEqual(feed(bob).map((i) => i.model), ["Task", "Task"]);
    assert.equal(activity([{ history: tasks, scoped: Task.as(ada), describe: sentence }], { limit: 1 }).length, 1);
  });
}

test("activity checks its sources", () => {
  const { Task, Note, tasks } = setup("memory");
  assert.throws(() => activity([{ history: {} as never, scoped: Task.as(ada), describe: () => "" }]), /sources/);
  assert.throws(() => activity([{ history: tasks, scoped: Note.as(ada) as never, describe: () => "x" }]), /pass Task.as/);
});
