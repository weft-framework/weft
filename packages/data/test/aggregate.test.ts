import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeFeed, defineAggregate, defineModel, onRead, transaction, useDatabase, AggregateError, type Model } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Task {
  id: string;
  team: string;
  done: boolean;
  points: number;
  deletedAt: number | null;
}

type Who = { id: string; team?: string };
let n = 0;

for (const driver of ["memory", "sqlite"] as const) {
  const make = (read: (a: Who, r: Task) => boolean = (a, r) => a.id === "op" || a.team === r.team) => {
    const feed = new ChangeFeed();
    const m = defineModel<Task, "deletedAt">(`AggTask${++n}`, {
      fields: { id: "string", team: "string", done: "boolean", points: "number", deletedAt: "number | null" },
      attrs: { deletedAt: { softDelete: true } },
      read: read as never,
      write: () => true,
    }).publishTo(feed);
    if (driver === "sqlite") useDatabase(openSqlite(":memory:"), [m as Model<never>]);
    return { m, feed };
  };
  const red: Who = { id: "r", team: "red" };
  const blue: Who = { id: "b", team: "blue" };
  const op: Who = { id: "op" };

  test(`${driver}: totals follow every kind of write`, () => {
    const { m, feed } = make();
    m.as(op).create({ id: "1", team: "red", done: false, points: 3 });
    m.as(op).create({ id: "2", team: "red", done: true, points: 5 });
    m.as(op).create({ id: "3", team: "blue", done: false, points: 8 });
    const open = defineAggregate(m, { by: (t) => t.team, of: (a: Who) => a.team ?? null, where: (t) => !t.done, sum: ["points"] });
    const both = () => [open.count(m.as(red)), open.sum(m.as(red), "points"), open.count(m.as(blue)), open.sum(m.as(blue), "points")];
    assert.deepEqual(both(), [1, 3, 1, 8]);

    m.as(op).create({ id: "4", team: "red", done: false, points: 2 });
    assert.deepEqual(both(), [2, 5, 1, 8], "create");
    m.as(op).update((t) => t.id === "1", { done: true });
    assert.deepEqual(both(), [1, 2, 1, 8], "an update out of `where`");
    m.as(op).update((t) => t.id === "4", { team: "blue", points: 4 });
    assert.deepEqual(both(), [0, 0, 2, 12], "an update to another group");
    m.as(op).delete((t) => t.id === "3");
    assert.deepEqual(both(), [0, 0, 1, 4], "trash");
    m.as(op).trash().restore((t) => t.id === "3");
    assert.deepEqual(both(), [0, 0, 2, 12], "restore");
    m.purgeTrash(Date.now() + 1);
    m.removeUnscoped(["4"], "test");
    assert.deepEqual(both(), [0, 0, 1, 8], "unscoped maintenance");

    assert.throws(() =>
      transaction(() => {
        m.as(op).create({ id: "5", team: "blue", done: false, points: 100 });
        throw new Error("rollback");
      }),
    );
    assert.deepEqual(both(), [0, 0, 1, 8]);

    open.stop();
    const again = defineAggregate(m, { by: (t) => t.team, of: (a: Who) => a.team ?? null });
    assert.equal(again.count(m.as(blue)), 1);
    feed.gap();
    assert.equal(again.count(m.as(blue)), 1);
    assert.equal(again.count(m.as({ id: "nobody" })), 0, "no group, nothing");
    assert.throws(() => again.count(m.as(op)), /outside the group/, "reads rows, but has no group");
    assert.throws(() => again.sum(m.as(blue), "points"), AggregateError, "points is not summed here");
  });

  test(`${driver}: a total is a read by the actor; bad options and handles are refused`, () => {
    const { m } = make();
    const agg = defineAggregate(m, { by: (t) => t.team, of: (a: Who) => a.team ?? null });
    const seen: unknown[] = [];
    const off = onRead((model, actor) => model === (m as never) && seen.push(actor));
    agg.count(m.as(red));
    off();
    assert.equal(seen[0], red);
    assert.throws(() => agg.count(m.as(red).trash()), TypeError);
    assert.throws(() => agg.count(defineModel(`AggOther${++n}`, { fields: { id: "string" } }).as(red) as never), TypeError);
    assert.throws(() => defineAggregate(m, { by: (t) => t.team } as never), TypeError);
    assert.throws(() => defineAggregate(m, { by: (t) => t.team, of: () => null, sum: ["team" as never] }), /not a number field/);
    assert.throws(() => defineAggregate(m, { by: (t) => t.team, of: () => null, groups: 0 }), /groups/);
  });

  test(`${driver}: verify finds a by/of pair that does not match the read rule`, () => {
    const { m } = make((a, r) => a.team === r.team && !r.done);
    m.as(op).create({ id: "1", team: "red", done: false, points: 1 });
    m.as(op).create({ id: "2", team: "red", done: true, points: 1 });
    const wrong = defineAggregate(m, { by: (t) => t.team, of: (a: Who) => a.team ?? null, verify: true });
    assert.throws(() => wrong.count(m.as(red)), (e) => e instanceof AggregateError && /2 counted in the group, 1 readable/.test(e.message));
    const right = defineAggregate(m, { by: (t) => t.team, of: (a: Who) => a.team ?? null, where: (t) => !t.done, verify: true });
    assert.equal(right.count(m.as(red)), 1);

    const { m: all } = make(() => true);
    all.as(op).create({ id: "1", team: "red", done: false, points: 1 });
    all.as(op).create({ id: "2", team: "blue", done: false, points: 1 });
    const leaky = defineAggregate(all, { by: (t) => t.team, of: (a: Who) => a.team ?? null, verify: true });
    assert.throws(() => leaky.count(all.as(red)), /outside the group/);
    const off = defineAggregate(all, { by: (t) => t.team, of: (a: Who) => a.team ?? null, verify: false });
    assert.equal(off.count(all.as(red)), 1, "unchecked when verify is off");
  });

  test(`${driver}: least recently used groups are dropped and recounted`, () => {
    const { m } = make();
    for (const team of ["a", "b", "c"]) m.as(op).create({ id: team, team, done: false, points: 1 });
    const agg = defineAggregate(m, { by: (t) => t.team, of: (a: Who) => a.team ?? null, groups: 2 });
    const as = (team: string) => m.as({ id: team, team });
    assert.deepEqual(["a", "b", "c", "a"].map((t) => agg.count(as(t))), [1, 1, 1, 1]);
    m.as(op).create({ id: "a2", team: "a", done: false, points: 1 });
    m.as(op).create({ id: "b2", team: "b", done: false, points: 1 });
    assert.deepEqual(["a", "b", "c"].map((t) => agg.count(as(t))), [2, 2, 1]);
  });
}
