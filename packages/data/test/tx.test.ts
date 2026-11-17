import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeFeed, defineModel, inTransaction, transaction, useDatabase, type Change, type Model } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Account {
  id: string;
  balance: number;
}

function setup(sql: boolean) {
  const Accounts = defineModel<Account>("Account", {
    fields: { id: "string", balance: "number" },
    read: () => true,
    write: (_a, r) => r.balance >= 0,
  });
  const feed = new ChangeFeed();
  const seen: Change[] = [];
  feed.subscribe((c) => seen.push(c));
  Accounts.publishTo(feed);
  if (sql) useDatabase(openSqlite(":memory:"), [Accounts] as Model<never>[]);
  const h = Accounts.as({});
  h.create({ id: "a", balance: 100 });
  h.create({ id: "b", balance: 0 });
  seen.length = 0;
  const move = (from: string, to: string, n: number) => {
    const f = h.get(from)!;
    const t = h.get(to)!;
    if (h.update((r) => r.id === from, { balance: f.balance - n }) !== 1) throw new Error("insufficient funds");
    h.update((r) => r.id === to, { balance: t.balance + n });
  };
  const balances = () => h.query().orderBy("id").all().map((r) => r.balance);
  return { h, seen, move, balances };
}

for (const sql of [false, true]) {
  const name = sql ? "sqlite" : "memory";

  test(`${name}: a transaction commits all of its writes, then publishes them`, () => {
    const { h, seen, move, balances } = setup(sql);
    const out = transaction(() => {
      assert.equal(inTransaction(), true);
      move("a", "b", 30);
      h.create({ id: "c", balance: 5 });
      assert.equal(seen.length, 0, "nothing is published before the commit");
      assert.deepEqual(balances(), [70, 30, 5], "the transaction reads its own writes");
      return "done";
    });
    assert.equal(out, "done");
    assert.equal(inTransaction(), false);
    assert.deepEqual(balances(), [70, 30, 5]);
    assert.deepEqual(
      seen.map((c) => `${c.op}:${String(c.key)}`),
      ["update:a", "update:b", "create:c"],
    );
  });

  test(`${name}: a throw undoes every write and publishes nothing`, () => {
    const { h, seen, move, balances } = setup(sql);
    assert.throws(
      () =>
        transaction(() => {
          move("a", "b", 60);
          h.create({ id: "c", balance: 1 });
          h.delete((r) => r.id === "b");
          move("a", "b", 60);
        }),
      /insufficient funds/,
    );
    assert.deepEqual(balances(), [100, 0]);
    assert.equal(h.get("c"), undefined);
    assert.equal(seen.length, 0);
    h.create({ id: "c", balance: 1 });
    assert.deepEqual(balances(), [100, 0, 1]);
  });

  test(`${name}: nested transactions are savepoints`, () => {
    const { h, seen, move, balances } = setup(sql);
    transaction(() => {
      move("a", "b", 10);
      assert.throws(() =>
        transaction(() => {
          move("a", "b", 20);
          h.create({ id: "x", balance: 9 });
          throw new Error("inner");
        }),
      );
      assert.deepEqual(balances(), [90, 10], "only the inner work is undone");
      transaction(() => h.create({ id: "y", balance: 2 }));
    });
    assert.deepEqual(balances(), [90, 10, 2]);
    assert.deepEqual(
      seen.map((c) => `${c.op}:${String(c.key)}`),
      ["update:a", "update:b", "create:y"],
    );
    assert.throws(() =>
      transaction(() => {
        transaction(() => h.create({ id: "z", balance: 3 }));
        throw new Error("outer");
      }),
    );
    assert.equal(h.get("z"), undefined);
  });

  test(`${name}: an async function is refused and rolled back`, async () => {
    const { h, balances } = setup(sql);
    let pending: Promise<void> | undefined;
    assert.throws(
      () =>
        transaction(() => {
          h.create({ id: "c", balance: 1 });
          pending = Promise.resolve();
          return pending;
        }),
      /synchronous/,
    );
    await pending;
    assert.deepEqual(balances(), [100, 0]);
    assert.equal(inTransaction(), false);
  });
}

test("a SQLite transaction holds a write lock from its first read", () => {
  const db = openSqlite(":memory:");
  const statements: string[] = [];
  const traced = {
    exec: (s: string) => {
      statements.push(s);
      db.exec(s);
    },
    prepare: (s: string) => db.prepare(s),
  };
  const M = defineModel<Account>("Acct", { fields: { id: "string", balance: "number" }, read: () => true, write: () => true });
  useDatabase(traced, [M] as Model<never>[]);
  statements.length = 0;
  transaction(() => {
    M.as({}).all();
    transaction(() => M.as({}).create({ id: "a", balance: 1 }));
  });
  assert.deepEqual(
    statements.map((s) => s.replace(/\d+/, "N")),
    ["BEGIN IMMEDIATE", "SAVEPOINT weft_sp_N", "RELEASE weft_sp_N", "COMMIT"],
  );
});
