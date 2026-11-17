import { test } from "node:test";
import assert from "node:assert/strict";
import { configureStores, defineStore, effect, type Store } from "../src/index.ts";

let sid: string | undefined;
const writes: string[] = [];
const reads: string[] = [];
configureStores({
  session: () => sid,
  read: (s, id) => reads.push(`${s.name}@${id ?? "-"}`),
  write: (s, id) => writes.push(`${s.name}@${id ?? "-"}`),
});

test("an app store is one lazy value, reactive like a signal", () => {
  let made = 0;
  const hits = defineStore("hits", "app", () => {
    made += 1;
    return 0;
  });
  assert.equal(made, 0, "the initial value is lazy");
  const seen: number[] = [];
  effect(() => {
    seen.push(hits.value);
  });
  sid = "a";
  hits.value = 1;
  sid = "b";
  assert.equal(hits.value, 1, "every session sees the same value");
  hits.value = 1;
  assert.deepEqual(seen, [0, 1]);
  assert.equal(made, 1);
  assert.deepEqual(writes.splice(0), ["hits@-"]);
  assert.ok(reads.includes("hits@-"));
});

test("a session store keeps one value per session, never shared", () => {
  const cart: Store<string[]> = defineStore("cart", "session", () => []);
  sid = "a";
  cart.value = [...cart.value, "apple"];
  sid = "b";
  assert.deepEqual(cart.value, [], "b starts from its own initial value");
  cart.value = ["pear"];
  sid = "a";
  assert.deepEqual(cart.value, ["apple"]);
  assert.deepEqual(writes.splice(0), ["cart@a", "cart@b"]);
  sid = undefined;
  assert.throws(() => cart.value, /session store cart used outside a request/);
  assert.throws(() => {
    cart.value = [];
  }, /outside a request/);
});

test("a session store bounds its sessions, dropping the least recently used", () => {
  const n = defineStore("n", "session", () => 0, { maxSessions: 2 });
  for (const s of ["a", "b"]) {
    sid = s;
    n.value = 1;
  }
  sid = "a";
  void n.value;
  sid = "c";
  n.value = 1;
  sid = "a";
  assert.equal(n.value, 1);
  sid = "b";
  assert.equal(n.value, 0, "b was dropped and starts over");
});

test("stores are frozen and validate their scope", () => {
  const s = defineStore("s", "app", () => 1);
  assert.equal(Object.isFrozen(s), true);
  assert.equal(s.scope, "app");
  assert.throws(() => defineStore("x", "global" as never, () => 1), /unknown scope/);
});
