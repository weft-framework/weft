import { test } from "node:test";
import assert from "node:assert/strict";
import { audit, defineModel, eraseData, personalData, useDatabase, type AuditEvent, type Model } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

let n = 0;

function app(sql: boolean) {
  const p = `P${++n}`;
  const User = defineModel<{ id: string; email: string; invitedBy: string | null }>(`${p}User`, {
    fields: { id: "string", email: "string", invitedBy: "string | null" },
    attrs: { invitedBy: { ref: `${p}User` } },
  });
  const Note = defineModel<{ id: string; owner: string; text: string; pic: string | null }>(`${p}Note`, {
    fields: { id: "string", owner: "string", text: "string", pic: "File | null" },
    attrs: { owner: { ref: `${p}User` } },
  });
  const Comment = defineModel<{ id: string; note: string; author: string; text: string }>(`${p}Comment`, {
    fields: { id: "string", note: "string", author: "string", text: "string" },
    attrs: { note: { ref: `${p}Note` }, author: { ref: `${p}User` } },
  });
  const Task = defineModel<{ id: string; owner: string; assignee: string | null }>(`${p}Task`, {
    fields: { id: "string", owner: "string", assignee: "string | null" },
    attrs: { owner: { ref: `${p}User` }, assignee: { ref: `${p}User` } },
  });
  const Other = defineModel<{ id: string; who: string }>(`${p}Other`, {
    fields: { id: "string", who: "string" },
    attrs: { who: { ref: `${p}Missing` } },
  });
  const models = [User, Note, Comment, Task, Other] as unknown as Model<never>[];
  if (sql) useDatabase(openSqlite(":memory:"), models);
  const put = <T>(m: Model<T, never>, rows: T[]) => rows.forEach((r) => m.driver.insert(r));
  put(User, [
    { id: "ann", email: "ann@example.test", invitedBy: null },
    { id: "bob", email: "bob@example.test", invitedBy: "ann" },
  ]);
  put(Note, [
    { id: "n1", owner: "ann", text: "mine", pic: "file-1" },
    { id: "n2", owner: "bob", text: "his", pic: null },
  ]);
  put(Comment, [
    { id: "c1", note: "n1", author: "bob", text: "bob on ann's note" },
    { id: "c2", note: "n2", author: "ann", text: "ann on bob's note" },
    { id: "c3", note: "n2", author: "bob", text: "bob on his own" },
  ]);
  put(Task, [
    { id: "t1", owner: "bob", assignee: "ann" },
    { id: "t2", owner: "ann", assignee: "bob" },
    { id: "t3", owner: "bob", assignee: "bob" },
  ]);
  return { User, Note, Comment, Task, Other, models, p };
}

const ids = (rows: unknown[] | undefined) => (rows ?? []).map((r) => (r as { id: string }).id).sort();

for (const sql of [false, true]) {
  const name = sql ? "sqlite" : "memory";

  test(`${name}: export follows refs; erasure deletes owned rows and unlinks the rest`, () => {
    const { User, Note, Comment, Task, models, p } = app(sql);
    const data = personalData(models, User, "ann");
    assert.deepEqual(ids(data.rows[`${p}User`]), ["ann", "bob"], "bob is linked through invitedBy");
    assert.equal((data.rows[`${p}User`]![0] as { id: string }).id, "ann", "the person first");
    assert.deepEqual(ids(data.rows[`${p}Note`]), ["n1"]);
    assert.deepEqual(ids(data.rows[`${p}Comment`]), ["c1", "c2"], "her comment, and a comment on her note");
    assert.deepEqual(ids(data.rows[`${p}Task`]), ["t1", "t2"]);
    assert.deepEqual(data.files, ["file-1"]);
    assert.deepEqual(data.missing, [`${p}Missing`]);

    const events: AuditEvent[] = [];
    const stop = audit((e) => void events.push(e));
    let result;
    try {
      result = eraseData(data);
    } finally {
      stop();
    }
    assert.deepEqual(result.removed, { [`${p}Comment`]: 2, [`${p}Note`]: 1, [`${p}Task`]: 1, [`${p}User`]: 1 });
    assert.deepEqual(result.unlinked, { [`${p}User`]: 1, [`${p}Task`]: 1 });
    const all = <T>(m: Model<T, never>) => m.publicUnscoped() as unknown[];
    assert.deepEqual(ids(all(User)), ["bob"]);
    assert.equal((all(User)[0] as { invitedBy: string | null }).invitedBy, null);
    assert.deepEqual(ids(all(Note)), ["n2"]);
    assert.deepEqual(ids(all(Comment)), ["c3"]);
    assert.deepEqual(ids(all(Task)), ["t1", "t3"]);
    assert.equal((all(Task).find((t) => (t as { id: string }).id === "t1") as { assignee: unknown }).assignee, null);
    assert.ok(events.length >= 5 && events.every((e) => e.reason === "erasure" && e.actor === null));
    assert.ok(!JSON.stringify(all(User)).includes("ann@"), "her email is gone");
  });

  test(`${name}: a plan overrides per model`, () => {
    const { User, Task, Comment, models, p } = app(sql);
    assert.throws(
      () => personalData(models, User, "ann", { plan: { [`${p}Comment`]: "keep" } }),
      /a kept .*Comment refers through note to a .*Note being erased/,
    );
    const data = personalData(models, User, "ann", { plan: { [`${p}Task`]: "delete" } });
    eraseData(data);
    const left = (m: Model<unknown, never>) => ids(m.publicUnscoped());
    assert.deepEqual(left(Task as never), ["t3"], "t1, assigned to her, deleted by plan");
    assert.deepEqual(left(Comment as never), ["c3"]);
    assert.throws(() => personalData(models, User, "bob", { plan: { [`${p}Note`]: "unlink" } }), /cannot be unlinked/);
  });
}

test("refusals: subject not among models, unknown key, bad plan, too many rows", () => {
  const { User, models, p } = app(false);
  assert.throws(() => personalData(models.slice(1), User, "ann"), /among the models/);
  assert.throws(() => personalData(models, User, "nobody"), /no .*User with that key/);
  assert.throws(() => personalData(models, User, "ann", { plan: { Nope: "delete" } }), /no given model/);
  assert.throws(() => personalData(models, User, "ann", { plan: { [`${p}Task`]: "burn" as "delete" } }), /delete, unlink or keep/);
  assert.throws(() => personalData(models, User, "ann", { maxRows: 3 }), /more than 3 rows/);
  assert.throws(() => personalData(models, User, "ann", { maxRows: 0 }), /maxRows/);
});
