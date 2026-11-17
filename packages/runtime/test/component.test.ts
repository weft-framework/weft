import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignProps,
  bindArgs,
  defineComponent,
  withRenderContext,
  type ComponentDef,
  type RenderContext,
} from "../src/component.ts";
import { signal } from "../src/signal.ts";
import { escapeAttr, escapeHtml } from "../src/escape.ts";

const Badge = defineComponent("Badge", (props: { label: string }) => ({
  handlers: {},
  render: () => `<b>${escapeHtml(props.label)}</b>`,
}));

const Counter = defineComponent("Counter", (props: { start: number }) => {
  const count = signal(props.start);
  function add(n: number) {
    count.value = count.value + n;
  }
  return {
    handlers: { add },
    render: () =>
      `<button data-weft-on-click="add" data-weft-args-click="${escapeAttr(bindArgs([5]))}">${escapeHtml(count.value)}</button>${Badge({ label: "<x>" })}`,
  };
});

test("a static call renders a fresh instance with no live bindings", () => {
  assert.equal(
    Counter({ start: 2 }),
    '<button data-weft-on-click="add" data-weft-args-click="">2</button><b>&lt;x&gt;</b>',
  );
  assert.equal(Counter.def.name, "Counter");
});

test("inside a render context, children and arguments go to the host", () => {
  const children: string[] = [];
  const bound: unknown[][] = [];
  const ctx: RenderContext = {
    child<P extends object>(def: ComponentDef<P>, props: P) {
      children.push(def.name);
      return withRenderContext(ctx, () => def.setup(props).render());
    },
    bindArgs(args) {
      bound.push(args);
      return String(bound.length - 1);
    },
  };
  const inst = Counter.def.setup({ start: 0 });
  const html = withRenderContext(ctx, inst.render);
  assert.equal(children.join(), "Badge");
  assert.deepEqual(bound, [[5]]);
  assert.match(html, /data-weft-args-click="0"/);

  (inst.handlers.add as (n: number) => void)(5);
  assert.match(withRenderContext(ctx, inst.render), />5</);
});

test("the render context is restored after a throw", () => {
  const Boom = defineComponent("Boom", () => ({
    handlers: {},
    render: () => {
      throw new Error("boom");
    },
  }));
  const ctx: RenderContext = {
    child: (def, props) => def.setup(props).render(),
    bindArgs: () => "9",
  };
  assert.throws(() => withRenderContext(ctx, () => Boom({})), /boom/);
  assert.equal(bindArgs([1]), "", "back to the static context");
});

test("assignProps replaces contents but keeps identity", () => {
  const live: Record<string, unknown> = { a: 1, gone: true };
  const same = live;
  assignProps(live, { a: 2, b: 3 });
  assert.equal(live, same);
  assert.deepEqual(live, { a: 2, b: 3 });
});

test("awaitBlock renders by promise state and asks to re-render on settle", async () => {
  const { awaitBlock, withRenderContext } = await import("../src/component.ts");
  const branches = <T,>(v: T) =>
    awaitBlock(
      v,
      () => "pending",
      (x) => `then:${String(x)}`,
      (e) => `catch:${(e as Error).message}`,
    );
  assert.equal(branches(42), "then:42", "a plain value is already fulfilled");

  let invalidated = 0;
  const ctx = { child: () => "", bindArgs: () => "", invalidate: () => void invalidated++ };
  let resolve!: (v: string) => void;
  const p = new Promise<string>((r) => (resolve = r));
  assert.equal(withRenderContext(ctx, () => branches(p)), "pending");
  assert.equal(withRenderContext(ctx, () => branches(p)), "pending");
  resolve("ok");
  await p;
  await Promise.resolve();
  assert.equal(invalidated, 1, "one waiter per invalidate function");
  assert.equal(branches(p), "then:ok");

  const failed = Promise.reject(new Error("nope"));
  assert.equal(branches(failed), "pending");
  await failed.catch(() => {});
  await Promise.resolve();
  assert.equal(branches(failed), "catch:nope");
  assert.equal(awaitBlock(Promise.reject(new Error("x")), () => "p"), "p", "no catch: handled, renders nothing later");
});
