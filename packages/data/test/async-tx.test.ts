import { test } from "node:test";
import assert from "node:assert/strict";
import { afterCommit, asyncTransaction, enlistAsync, flow, inTransaction, transaction, wait, type TxClient, type TxPool } from "../src/index.ts";

function fakePool() {
  const log: string[] = [];
  let open = 0;
  const pool: TxPool = {
    async connect(): Promise<TxClient> {
      open += 1;
      return {
        async query(text: string) {
          await Promise.resolve();
          log.push(text.replace(/weft_sp_\d+/, "sp"));
          return [];
        },
        release() {
          open -= 1;
        },
      };
    },
  };
  return { pool, log, open: () => open };
}

async function stmt(pool: TxPool, text: string) {
  const c = enlistAsync(pool);
  if (c) await (await c).query(text);
}

test("asyncTransaction: one connection, BEGIN on first use, COMMIT, then afterCommit", async () => {
  const { pool, log, open } = fakePool();
  const done: string[] = [];
  await asyncTransaction(async () => {
    assert.equal(inTransaction(), true);
    await stmt(pool, "INSERT 1");
    await stmt(pool, "INSERT 2");
    afterCommit(() => done.push("published"));
    assert.deepEqual(done, []);
  });
  assert.deepEqual(log, ["BEGIN", "INSERT 1", "INSERT 2", "COMMIT"]);
  assert.deepEqual(done, ["published"]);
  assert.equal(open(), 0);
  assert.equal(inTransaction(), false);
});

test("asyncTransaction: a throw rolls back and publishes nothing", async () => {
  const { pool, log, open } = fakePool();
  const done: string[] = [];
  await assert.rejects(
    asyncTransaction(async () => {
      await stmt(pool, "INSERT 1");
      afterCommit(() => done.push("x"));
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.deepEqual(log, ["BEGIN", "INSERT 1", "ROLLBACK"]);
  assert.deepEqual(done, []);
  assert.equal(open(), 0);
});

test("asyncTransaction: nested calls are savepoints; an inner throw keeps the outer work", async () => {
  const { pool, log } = fakePool();
  await asyncTransaction(async () => {
    await stmt(pool, "A");
    await assert.rejects(
      asyncTransaction(async () => {
        await stmt(pool, "B");
        throw new Error("inner");
      }),
    );
    await asyncTransaction(async () => stmt(pool, "C"));
  });
  assert.deepEqual(log, ["BEGIN", "A", "SAVEPOINT sp", "B", "ROLLBACK TO SAVEPOINT sp", "RELEASE SAVEPOINT sp", "SAVEPOINT sp", "C", "RELEASE SAVEPOINT sp", "COMMIT"]);
});

test("asyncTransaction: concurrent transactions do not share frames", async () => {
  const a = fakePool();
  const b = fakePool();
  await Promise.all([
    asyncTransaction(async () => {
      await stmt(a.pool, "A1");
      await new Promise((r) => setTimeout(r, 5));
      await stmt(a.pool, "A2");
    }),
    asyncTransaction(async () => {
      await stmt(b.pool, "B1");
      throw new Error("b fails");
    }).catch(() => undefined),
  ]);
  assert.deepEqual(a.log, ["BEGIN", "A1", "A2", "COMMIT"]);
  assert.deepEqual(b.log, ["BEGIN", "B1", "ROLLBACK"]);
});

test("asyncTransaction refuses a sync parent; sync drivers cannot be used for async ones", async () => {
  let inner: Promise<number> | undefined;
  transaction(() => {
    inner = asyncTransaction(async () => 1);
  });
  await assert.rejects(inner!, /synchronous transaction/);
  assert.equal(enlistAsync(fakePool().pool), null);
});

test("flow: sync while plain, a Promise once a thenable is yielded, errors reach the generator", async () => {
  function* g(x: number | Promise<number>) {
    try {
      return (yield* wait(x)) + 1;
    } finally {
      // runs in both modes
    }
  }
  assert.equal(flow(g(1)), 2);
  const p = flow(g(Promise.resolve(1)));
  assert.ok(p instanceof Promise);
  assert.equal(await p, 2);
  function* h() {
    try {
      yield* wait(Promise.reject(new Error("no")));
      return "unreached";
    } catch (e) {
      return (e as Error).message;
    }
  }
  assert.equal(await flow(h()), "no");
});
