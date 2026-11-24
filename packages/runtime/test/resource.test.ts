import { test } from "node:test";
import assert from "node:assert/strict";
import { asyncDerived, collectSignals, effect, signal, withRenderContext, withResourceHost, type RenderContext } from "../src/index.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("asyncDerived resolves, follows the signals it reads, and keeps the last value while refreshing", async () => {
  const id = signal(1);
  const calls: number[] = [];
  const made = collectSignals(() =>
    asyncDerived(async () => {
      const n = id.value;
      calls.push(n);
      await tick();
      return `row ${n}`;
    }),
  );
  const row = made.value;
  assert.equal(made.signals.length, 0, "the resource's own state is not restorable component state");
  assert.equal(row.value, undefined);
  assert.equal(row.pending, true);
  const seen: (string | undefined)[] = [];
  effect(() => {
    seen.push(row.value);
  });
  await tick();
  await tick();
  assert.equal(row.value, "row 1");
  assert.equal(row.pending, false);
  id.value = 2;
  assert.equal(row.value, "row 1");
  assert.equal(row.pending, true);
  await tick();
  await tick();
  assert.equal(row.value, "row 2");
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(seen.filter((v, i) => i === 0 || v !== seen[i - 1]), [undefined, "row 1", "row 2"]);
});

test("a slower earlier run never overwrites a newer one; errors keep the last good value", async () => {
  const which = signal(0);
  const gates: Array<() => void> = [];
  const r = asyncDerived(() => {
    const w = which.value;
    if (w === 9) return Promise.reject(new Error("nope"));
    return new Promise<number>((resolve) => gates.push(() => resolve(w)));
  });
  which.value = 1;
  gates[1]!();
  await tick();
  gates[0]!();
  await tick();
  assert.equal(r.value, 1);
  which.value = 9;
  await tick();
  assert.equal(r.value, 1);
  assert.match(String(r.error), /nope/);
  assert.equal(r.pending, false);
});

test("a first render that reads a pending resource is marked awaiting; a host reruns it", async () => {
  let awaited = 0;
  const ctx: RenderContext = { child: () => "", bindArgs: () => "", awaiting: () => void awaited++ };
  let rerun: (() => void) | null = null;
  const ran: string[] = [];
  let n = 0;
  const r = withResourceHost(
    (again) => {
      rerun = again;
      return { run: (fn) => (ran.push("tracked"), fn()), dispose: () => undefined };
    },
    () => asyncDerived(async () => ++n),
  );
  withRenderContext(ctx, () => r.value);
  assert.equal(awaited, 1);
  await tick();
  withRenderContext(ctx, () => r.value);
  assert.equal(awaited, 1);
  assert.equal(r.value, 1);
  rerun!();
  rerun!();
  await tick();
  await tick();
  assert.equal(r.value, 2, "reruns in one turn coalesce");
  assert.deepEqual(ran, ["tracked", "tracked"]);
  r.refresh();
  await tick();
  await tick();
  assert.equal(r.value, 3);
  const sync = asyncDerived(() => 5);
  assert.equal(sync.value, 5);
  assert.equal(sync.pending, false);
});
