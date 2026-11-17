import { test } from "node:test";
import assert from "node:assert/strict";
import { morphChildren, noteServed } from "../src/morph.ts";
import { frag, h, serialize, text } from "../testing/fakedom.ts";

test("text and attributes update in place, reusing nodes", () => {
  const p = h("p", { class: "a", title: "old" }, "count: 1");
  const root = h("div", {}, p);
  const label = p.childNodes[0];

  morphChildren(root, frag(h("p", { class: "b" }, "count: 2")));

  assert.equal(serialize(root), '<div><p class="b">count: 2</p></div>');
  assert.equal(root.childNodes[0], p, "element reused");
  assert.equal(p.childNodes[0], label, "text node reused");
});

test("keyed children keep identity across a reorder", () => {
  const a = h("li", { "data-weft-key": "a" }, "A");
  const b = h("li", { "data-weft-key": "b" }, "B");
  const c = h("li", { "data-weft-key": "c" }, "C");
  const ul = h("ul", {}, a, b, c);

  morphChildren(
    ul,
    frag(
      h("li", { "data-weft-key": "c" }, "C"),
      h("li", { "data-weft-key": "a" }, "A!"),
      h("li", { "data-weft-key": "b" }, "B"),
    ),
  );

  assert.deepEqual(ul.childNodes, [c, a, b]);
  assert.equal(serialize(a), '<li data-weft-key="a">A!</li>');
});

test("ids act as keys when no data-weft-key is present", () => {
  const x = h("section", { id: "x" }, "x");
  const y = h("section", { id: "y" }, "y");
  const root = h("main", {}, x, y);
  morphChildren(root, frag(h("section", { id: "y" }, "y"), h("section", { id: "x" }, "x")));
  assert.deepEqual(root.childNodes, [y, x]);
});

test("insertions and removals", () => {
  const keep = h("li", { "data-weft-key": "keep" }, "keep");
  const drop = h("li", { "data-weft-key": "drop" }, "drop");
  const ul = h("ul", {}, keep, drop);

  morphChildren(
    ul,
    frag(
      h("li", { "data-weft-key": "new" }, "new"),
      h("li", { "data-weft-key": "keep" }, "keep"),
    ),
  );

  assert.equal(
    serialize(ul),
    '<ul><li data-weft-key="new">new</li><li data-weft-key="keep">keep</li></ul>',
  );
  assert.equal(ul.childNodes[1], keep);
  assert.equal(drop.parentNode, null);
});

test("a changed tag replaces the node", () => {
  const old = h("span", {}, "x");
  const root = h("div", {}, old);
  morphChildren(root, frag(h("strong", {}, "x")));
  assert.equal(serialize(root), "<div><strong>x</strong></div>");
  assert.notEqual(root.childNodes[0], old);
});

test("a key match with a different tag is not reused", () => {
  const old = h("span", { id: "k" }, "x");
  const root = h("div", {}, old);
  morphChildren(root, frag(h("em", { id: "k" }, "x")));
  assert.equal(serialize(root), '<div><em id="k">x</em></div>');
  assert.equal(old.parentNode, null);
});

test("data-weft-ignore regions are left alone", () => {
  const widget = h("div", { "data-weft-ignore": "", class: "client-owned" }, "client state");
  const root = h("div", {}, widget);
  morphChildren(root, frag(h("div", { "data-weft-ignore": "" }, "server copy")));
  assert.equal(root.childNodes[0], widget);
  assert.equal(serialize(widget), '<div data-weft-ignore="" class="client-owned">client state</div>');
});

test("mixed text and element children, emptied target", () => {
  const root = h("p", {}, "a", h("b", {}, "b"), "c");
  morphChildren(root, frag(text("x"), h("b", {}, "y")));
  assert.equal(serialize(root), "<p>x<b>y</b></p>");
  morphChildren(root, frag());
  assert.equal(serialize(root), "<p></p>");
});

test("the source fragment is consumed by inserted nodes", () => {
  const root = h("div");
  const incoming = frag(h("i", {}, "1"), h("i", {}, "2"));
  morphChildren(root, incoming);
  assert.equal(serialize(root), "<div><i>1</i><i>2</i></div>");
  assert.equal(incoming.childNodes.length, 0);
});

test("a field survives the removal of an unkeyed sibling before it", () => {
  const field = h("input", { name: "email" });
  field.value = "typed@example";
  const root = h("form", {}, h("p", { class: "error" }, "required"), field);
  morphChildren(root, frag(h("input", { name: "email" })));
  assert.equal(root.childNodes.length, 1);
  assert.equal(root.childNodes[0], field);
  assert.equal(field.value, "typed@example");
});

test("a field is never reused for a differently named one", () => {
  const a = h("input", { name: "a" });
  a.value = "secret for a";
  const root = h("form", {}, a);
  morphChildren(root, frag(h("input", { name: "b" })));
  assert.notEqual(root.childNodes[0], a);
  assert.equal(root.childNodes.length, 1);
});

test("data-weft-own attributes and a dialog's or details' open are the page's", () => {
  const tab = h("button", { "data-weft-own": "aria-selected tabindex", "aria-selected": "true", tabindex: "0" }, "A");
  const box = h("details", { open: "" }, "x");
  const root = h("div", {}, tab, box);
  morphChildren(
    root,
    frag(h("button", { "data-weft-own": "aria-selected tabindex", "aria-selected": "false" }, "A"), h("details", {}, "x")),
  );
  assert.equal(tab.getAttribute("aria-selected"), "true", "not reset by the server");
  assert.equal(tab.getAttribute("tabindex"), "0", "not removed");
  assert.equal(box.getAttribute("open"), "", "the user's open section stays open");
});

test("an attached element keeps what its attachment wrote, but not what the server dropped", () => {
  const el = h("button", { class: "a", disabled: "" }, "go");
  const root = h("div", {}, el);
  noteServed(el);
  el.setAttribute("aria-expanded", "true");
  morphChildren(root, frag(h("button", { class: "b" }, "go")));
  assert.equal(el.getAttribute("aria-expanded"), "true");
  assert.equal(el.getAttribute("class"), "b");
  assert.equal(el.hasAttribute("disabled"), false, "the server stopped sending it");
  morphChildren(root, frag(h("button", { class: "b", title: "t" }, "go")));
  morphChildren(root, frag(h("button", { class: "b" }, "go")));
  assert.equal(el.hasAttribute("title"), false);
  assert.equal(el.getAttribute("aria-expanded"), "true");
});
