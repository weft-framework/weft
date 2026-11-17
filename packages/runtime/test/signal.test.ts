import { strict as assert } from "node:assert";
import { test } from "node:test";

import { derived, effect, signal } from "../src/signal.ts";

test("signal holds and updates a value", () => {
  const count = signal(1);
  assert.equal(count.value, 1);
  count.value = 5;
  assert.equal(count.value, 5);
});

test("derived recomputes when a dependency changes", () => {
  const count = signal(2);
  const doubled = derived(() => count.value * 2);
  assert.equal(doubled.value, 4);
  count.value = 10;
  assert.equal(doubled.value, 20);
});

test("derived chains propagate", () => {
  const n = signal(1);
  const a = derived(() => n.value + 1);
  const b = derived(() => a.value * 10);
  assert.equal(b.value, 20);
  n.value = 4;
  assert.equal(a.value, 5);
  assert.equal(b.value, 50);
});

test("effect runs on creation and on each change", () => {
  const s = signal("a");
  const seen: string[] = [];
  effect(() => seen.push(s.value));
  s.value = "b";
  s.value = "c";
  assert.deepEqual(seen, ["a", "b", "c"]);
});

test("setting an equal value does not re-run subscribers", () => {
  const s = signal(1);
  let runs = 0;
  effect(() => {
    s.value;
    runs++;
  });
  assert.equal(runs, 1);
  s.value = 1;
  assert.equal(runs, 1);
  s.value = 2;
  assert.equal(runs, 2);
});
