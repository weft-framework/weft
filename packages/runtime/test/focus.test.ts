import { test } from "node:test";
import assert from "node:assert/strict";
import { WeftClient } from "../src/client.ts";
import type { MElement } from "../src/dom.ts";
import { captureFocus, restoreFocus, type FocusHost } from "../src/focus.ts";
import { morphChildren } from "../src/morph.ts";
import { FElement, frag, h, type FNode } from "../testing/fakedom.ts";

function field(attrs: Record<string, string>, value = ""): FElement {
  const el = h("input", attrs) as FElement & Record<string, unknown>;
  el.value = value;
  el.selectionStart = 0;
  el.selectionEnd = 0;
  el.selectionDirection = "none";
  el.setSelectionRange = (s: number, e: number, d: string) => {
    el.selectionStart = s;
    el.selectionEnd = e;
    el.selectionDirection = d;
  };
  return el;
}

function host(): FocusHost & { current: MElement | null; moves: number } {
  const h = {
    current: null as MElement | null,
    moves: 0,
    active: () => h.current,
    focus: (el: MElement) => {
      h.current = el;
      h.moves += 1;
    },
  };
  return h;
}

test("a reordered keyed row keeps focus and caret in its field", () => {
  const input = field({ name: "title" }, "hello");
  const rowA = h("li", { "data-weft-key": "a" }, input);
  const rowB = h("li", { "data-weft-key": "b" });
  const list = h("ul", {}, rowA, rowB);
  const f = host();
  f.current = input;
  Object.assign(input, { selectionStart: 2, selectionEnd: 4 });

  const mark = captureFocus(f, list)!;
  f.current = h("body");
  morphChildren(list, frag(h("li", { "data-weft-key": "b" }), h("li", { "data-weft-key": "a" }, h("input", { name: "title" }))));
  restoreFocus(f, list, mark);

  assert.equal(list.childNodes[1], rowA, "the row was reused");
  assert.equal(f.current, input);
  assert.equal((input as unknown as { selectionStart: number }).selectionStart, 2);
  assert.equal((input as unknown as { selectionEnd: number }).selectionEnd, 4);
});

test("a replaced field gets focus back, by id, with the caret clamped", () => {
  const old = field({ id: "q" }, "long text");
  const root = h("div", {}, h("p", {}, old));
  const f = host();
  f.current = old;
  Object.assign(old, { selectionStart: 9, selectionEnd: 9 });
  const mark = captureFocus(f, root)!;

  const next = field({ id: "q" }, "short");
  morphChildren(root, frag(h("section", {}, next)));
  f.current = h("body");
  restoreFocus(f, root, mark);

  assert.equal(f.current, next);
  assert.equal((next as unknown as { selectionStart: number }).selectionStart, 5);
});

test("focus is not moved when it never left, or went elsewhere", () => {
  const input = field({ name: "a" });
  const root = h("div", {}, input);
  const f = host();
  f.current = input;
  let mark = captureFocus(f, root)!;
  restoreFocus(f, root, mark);
  assert.equal(f.moves, 0, "still focused: nothing to do");

  mark = captureFocus(f, root)!;
  const other = h("button");
  f.current = other;
  root.removeChild(input);
  restoreFocus(f, root, mark);
  assert.equal(f.current, other, "focus that moved on purpose stays");
});

test("nothing is captured when focus is outside the patched instance", () => {
  const f = host();
  f.current = h("input");
  assert.equal(captureFocus(f, h("div")), null);
});

test("focus inside a kept child survives its parent's patch", () => {
  const input = field({ name: "title" }, "draft");
  const kept = h("weft-c", { "data-weft-c": "p.1" }, input);
  const parent = h("weft-c", { "data-weft-c": "p" }, h("p", {}, "1 here"), kept);
  const root = h("body", {}, parent);
  const f = host();
  f.current = input;
  const body = h("body");
  const remove = FElement.prototype.removeChild;
  FElement.prototype.removeChild = function (this: FElement, node: FNode) {
    for (let n: FNode | null = f.current as FNode | null; n; n = n.parentNode) {
      if (n === node) f.current = body;
    }
    return remove.call(this, node);
  };
  try {
    const client = new WeftClient({
      root,
      send: () => {},
      parse: () => frag(h("p", {}, "2 here"), h("weft-c", { "data-weft-c": "p.1", "data-weft-keep": "" })),
      focus: f,
    });
    client.start();
    client.apply({ t: "patch", id: "p", html: "" });
  } finally {
    FElement.prototype.removeChild = remove;
  }
  assert.equal(parent.childNodes[1], kept, "the child was kept");
  assert.equal(kept.childNodes[0], input);
  assert.equal(f.current, input, "focus is back on the field");
  assert.equal((input as unknown as { value: string }).value, "draft");
});

test("the client restores focus around a patch", () => {
  const input = field({ name: "draft" }, "typed");
  const inst = h("div", { "data-weft-c": "c1" }, h("p", {}, "0"), input);
  const root = h("body", {}, inst);
  const f = host();
  f.current = input;
  const client = new WeftClient({
    root,
    send: () => {},
    parse: () => frag(h("div", {}, "new"), field({ name: "draft" })),
    focus: f,
  });
  client.start();
  client.apply({ t: "patch", id: "c1", html: "" });
  assert.equal(inst.childNodes[1], input);
  assert.equal(f.current, input);
  assert.equal((input as unknown as { value: string }).value, "typed", "typed text kept");
});
