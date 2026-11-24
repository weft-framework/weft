import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { asyncTransaction } from "@weft-framework/data";
import { pgliteAsPool } from "@weft-framework/data/postgres";
import {
  PgAccountTokenStore,
  PgEmailTokenStore,
  PgFileStore,
  PgJobStore,
  PgPasskeyStore,
  PgSessionStore,
  PgTwoFactorStore,
  PgRateLimitStore,
  PgWebhookStore,
} from "../src/pg-stores.ts";
import type { JobRecord } from "../src/jobs.ts";

const pool = () => pgliteAsPool(new PGlite());

test("sessions: upsert, flags, view-as, per user, sweep", async () => {
  const s = new PgSessionStore(pool());
  await s.set("a", { user: "u1", created: 1, seen: 10, tenant: "t", pending: true, viewAs: { user: "u2", until: 99 } });
  await s.set("b", { user: "u1", created: 2, seen: 20, mfa: true, agent: "Firefox" });
  assert.deepEqual(await s.get("a"), { user: "u1", created: 1, seen: 10, tenant: "t", pending: true, viewAs: { user: "u2", until: 99 } });
  await s.set("a", { user: "u1", created: 1, seen: 30 });
  assert.deepEqual(await s.get("a"), { user: "u1", created: 1, seen: 30 });
  assert.deepEqual((await s.forUser("u1")).map((x) => x.sid).sort(), ["a", "b"]);
  await s.sweep(25);
  assert.equal(await s.get("b"), null);
  await s.delete("a");
  assert.equal(await s.get("a"), null);
});

function job(id: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    id, name: "mail", args: [id], actor: null, status: "queued", attempts: 0, maxAttempts: 3, runAt: 100,
    created: 1, updated: 1, worker: null, leaseUntil: 0, error: null, key: null, keepKey: false, progress: null, ...over,
  };
}

test("jobs: claim is exclusive across concurrent workers, settle, move, counts", async () => {
  const s = new PgJobStore(pool());
  assert.equal(await s.add(job("1", { key: "k" })), true);
  assert.equal(await s.add(job("2", { key: "k" })), false, "a duplicate key is not queued");
  assert.equal(await s.add(job("3", { runAt: 50 })), true);
  const [a, b, c] = await Promise.all([s.claim(200, "w1", 500), s.claim(200, "w2", 500), s.claim(200, "w3", 500)]);
  const claimed = [a, b, c].filter((x) => x !== null).map((x) => x!.id).sort();
  assert.deepEqual(claimed, ["1", "3"], "each job goes to one worker");
  const first = [a, b, c].find((x) => x?.id === "3")!;
  assert.equal(first.attempts, 1);
  assert.equal(await s.extend("3", first.worker!, 900, 0.5), true);
  assert.equal((await s.get("3"))!.progress, 0.5);
  assert.equal(await s.settle("3", "nobody", { status: "done" }, 300), false, "only the holder settles");
  assert.equal(await s.settle("3", first.worker!, { status: "dead", error: "boom" }, 300), true);
  assert.equal((await s.get("3"))!.error, "boom");
  assert.equal(await s.move("3", ["dead"], { status: "queued", runAt: 400, attempts: 0 }, 310), true);
  assert.deepEqual(await s.counts(), { queued: 1, running: 1, done: 0, dead: 0, cancelled: 0 });
  assert.deepEqual((await s.list({ status: "running" })).map((j) => j.id), ["1"]);
  assert.equal(await s.claim(1000, "w4", 2000).then((j) => j?.id), "1", "an expired lease is taken over (earliest run_at first)");
  assert.equal(await s.claim(1000, "w5", 2000).then((j) => j?.id), "3");
  assert.equal(await s.claim(1000, "w6", 2000), null);
});

test("passkeys, 2FA, email and account tokens", async () => {
  const p = pool();
  const keys = new PgPasskeyStore(p);
  await keys.add({ id: "c1", user: "u", handle: "h", publicKey: { kty: "EC" }, alg: -7, signCount: 0, transports: ["usb"], backedUp: false, name: "Key", created: 5, lastUsed: null });
  await keys.update("c1", { signCount: 4, backedUp: true, lastUsed: 9 });
  const k = (await keys.get("c1"))!;
  assert.equal(k.signCount, 4);
  assert.equal(k.backedUp, true);
  assert.equal(k.lastUsed, 9);
  assert.deepEqual(k.publicKey, { kty: "EC" });
  assert.equal((await keys.list("u")).length, 1);
  assert.equal(await keys.remove("c1"), true);

  const tf = new PgTwoFactorStore(p);
  assert.equal(await tf.add({ user: "u", secret: "S", lastStep: 0, failures: 0, lockedUntil: 0, created: 1 }), true);
  assert.equal(await tf.add({ user: "u", secret: "S", lastStep: 0, failures: 0, lockedUntil: 0, created: 1 }), false);
  assert.equal(await tf.advance("u", 5), true);
  assert.equal(await tf.advance("u", 5), false, "a step is used once");
  assert.equal(await tf.fail("u", 2, 777), false);
  assert.equal(await tf.fail("u", 2, 777), true, "locked on the second failure");
  await tf.setRecovery("u", ["h1", "h2"]);
  assert.equal(await tf.countRecovery("u"), 2);
  assert.equal(await tf.useRecovery("u", "h1"), true);
  assert.equal(await tf.useRecovery("u", "h1"), false);
  assert.equal(await tf.remove("u"), true);
  assert.equal(await tf.countRecovery("u"), 0);

  const em = new PgEmailTokenStore(p);
  await em.add({ id: "e1", email: "a@b.c", code: "123", session: "s", next: "/", expires: 100, attempts: 0 });
  assert.equal(await em.attempt("e1"), 1);
  assert.equal((await em.find("s", "a@b.c"))!.id, "e1");
  assert.equal(await em.attempt("missing"), Number.POSITIVE_INFINITY);
  await em.sweep(100);
  assert.equal(await em.get("e1"), null);

  const acc = new PgAccountTokenStore(p);
  await acc.add({ id: "t1", kind: "reset", user: "u", email: "a@b.c", expires: 50, data: "x" });
  assert.deepEqual(await acc.take("t1"), { id: "t1", kind: "reset", user: "u", email: "a@b.c", expires: 50, data: "x" });
  assert.equal(await acc.take("t1"), null, "a token is taken once");
});

test("uploads and webhooks", async () => {
  const p = pool();
  const files = new PgFileStore(p);
  const rec = { id: "f", kind: "avatar", owner: "u", name: "a.png", type: "image/png", size: 10, partBytes: 5, status: "uploading" as const, upload: "x", claimed: false, created: 1 };
  await files.put(rec);
  assert.equal(await files.pending("u"), 1);
  await files.put({ ...rec, status: "ready" });
  assert.equal(await files.pending("u"), 0);
  assert.deepEqual((await files.stale(0, 5, 10)).map((f) => f.id), ["f"], "ready but unclaimed");
  await files.remove("f");
  assert.equal(await files.get("f"), null);

  const hooks = new PgWebhookStore(p);
  await hooks.put("message", "m1", "o", "e", 10, "one");
  await hooks.put("message", "m2", "o", "e", 10, "two");
  await hooks.put("message", "m1", "o", "e", 10, "one'");
  assert.deepEqual(await hooks.list("message", "o", { limit: 10 }), ["two", "one'"], "newest first, ties by insertion");
  assert.equal(await hooks.sweep("message", 11, "o"), 2);
});

test("store writes join an async transaction and roll back with it", async () => {
  const s = new PgSessionStore(pool());
  await s.get("warm-up");
  await assert.rejects(
    asyncTransaction(async () => {
      await s.set("x", { user: "u", created: 1, seen: 1 });
      throw new Error("abort");
    }),
    /abort/,
  );
  assert.equal(await s.get("x"), null);
});

test("PgRateLimitStore: one token bucket shared by every instance", async () => {
  const p = pool();
  const a = new PgRateLimitStore(p);
  const b = new PgRateLimitStore(p);
  const rule = { capacity: 2, refillPerSecond: 1 };
  const t0 = 1_700_000_000_000;
  assert.equal(await a.take("signin.email:ada@x.test", rule, t0), true);
  assert.equal(await b.take("signin.email:ada@x.test", rule, t0), true, "another instance draws from the same bucket");
  assert.equal(await a.take("signin.email:ada@x.test", rule, t0 + 10), false);
  assert.equal(await b.take("signin.email:ada@x.test", rule, t0 + 20), false, "a refused attempt costs nothing more");
  assert.equal(await a.take("signin.email:bob@x.test", rule, t0), true, "keys are separate");
  assert.equal(await b.take("signin.email:ada@x.test", rule, t0 + 1010), true, "one second refills one token");
  assert.equal(await a.take("signin.email:ada@x.test", rule, t0 + 1020), false);
  assert.equal(await a.take("signin.email:ada@x.test", rule, t0 - 5000), false, "a clock running behind never refills");
  const burst = await Promise.all(Array.from({ length: 10 }, () => a.take("burst", rule, t0)));
  assert.equal(burst.filter(Boolean).length, 2, "concurrent takes cannot overspend");
});
