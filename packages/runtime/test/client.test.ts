import { test } from "node:test";
import assert from "node:assert/strict";
import { WeftClient } from "../src/client.ts";
import { PROTOCOL_VERSION, decodeServerMessage, encode, type ClientMessage } from "../src/protocol.ts";
import { frag, h, serialize, type FElement } from "../testing/fakedom.ts";

function setup(root: FElement, parse: (html: string) => FElement = () => frag()) {
  const sent: ClientMessage[] = [];
  const nav: string[] = [];
  const errors: string[] = [];
  const client = new WeftClient({
    root,
    send: (m) => sent.push(m),
    parse,
    navigate: (to) => nav.push(to),
    onError: (m) => errors.push(m),
  });
  client.start();
  return { client, sent, nav, errors };
}

test("a click on a directive inside an instance sends an event", () => {
  const label = h("span", {}, "+1");
  const button = h("button", { "data-weft-on-click": "increment" }, label);
  const root = h("body", {}, h("div", { "data-weft-c": "c7" }, h("p", {}, "0"), button));
  const { sent } = setup(root);

  const { prevented } = root.dispatch("click", label);

  assert.equal(prevented, true);
  assert.deepEqual(sent, [
    { t: "event", id: "c7", handler: "increment", event: { type: "click" }, seq: 1 },
  ]);
});

test("events without a directive or outside an instance are ignored", () => {
  const stray = h("button", { "data-weft-on-click": "x" });
  const plain = h("button");
  const root = h("body", {}, stray, h("div", { "data-weft-c": "c1" }, plain));
  const { sent } = setup(root);
  assert.equal(root.dispatch("click", stray).prevented, false);
  assert.equal(root.dispatch("click", plain).prevented, false);
  assert.equal(sent.length, 0);
});

test("the nearest instance wins for nested components", () => {
  const btn = h("button", { "data-weft-on-click": "pick" });
  const root = h("body", {}, h("div", { "data-weft-c": "outer" }, h("div", { "data-weft-c": "inner" }, btn)));
  const { sent } = setup(root);
  root.dispatch("click", btn);
  assert.equal(sent[0].id, "inner");
});

test("a handler passed into another component goes to the instance that rendered it", () => {
  const form = h("form", { "data-weft-on-submit": "add", "data-weft-args-submit": "3", "data-weft-owner-submit": "page" });
  const own = h("button", { "data-weft-on-click": "toggle" });
  const root = h("body", {}, h("div", { "data-weft-c": "page" }, h("div", { "data-weft-c": "page.1" }, own, form)));
  const { sent } = setup(root);
  root.dispatch("submit", form);
  assert.equal(sent[0].id, "page");
  assert.equal(sent[0].args, "3");
  root.dispatch("click", own);
  assert.equal(sent[1].id, "page.1", "the shell's own handler stays the shell's");
});

test("input values, checkbox state and keys are carried", () => {
  const input = h("input", { "data-weft-on-input": "typed" });
  input.value = "hello";
  const box = h("input", { "data-weft-on-change": "toggled" });
  box.type = "checkbox";
  box.value = "on";
  box.checked = true;
  const root = h("body", {}, h("div", { "data-weft-c": "c1" }, input, box));
  const { sent } = setup(root);

  root.dispatch("input", input);
  root.dispatch("change", box);
  root.dispatch("keydown", input, { key: "Enter" });

  assert.deepEqual(sent[0].event, { type: "input", value: "hello" });
  assert.deepEqual(sent[1].event, { type: "change", value: "on", checked: true });
  assert.equal(sent.length, 2, "keydown has no directive here");
  assert.equal(sent[1].seq, 2);
});

test("submit serialises named, enabled fields like a browser", () => {
  const title = h("input", { name: "title" });
  title.value = "Write docs";
  const done = h("input", { name: "done" });
  done.type = "checkbox";
  done.value = "yes";
  done.checked = false;
  const off = h("input", { name: "secret", disabled: "" });
  off.value = "nope";
  const form = h("form", { "data-weft-on-submit": "add" }, h("label", {}, title), done, off);
  const root = h("body", {}, h("div", { "data-weft-c": "todo" }, form));
  const { sent } = setup(root);

  assert.equal(root.dispatch("submit", form).prevented, true);
  assert.deepEqual({ ...sent[0].event.form }, { title: "Write docs" });
});

test("a patch morphs only the addressed instance, in place", () => {
  const count = h("p", {}, "0");
  const other = h("div", { "data-weft-c": "c2" }, "untouched");
  const target = h("div", { "data-weft-c": "c1" }, count);
  const root = h("body", {}, target, other);
  const { client } = setup(root, (html) => {
    assert.equal(html, "<p>1</p>");
    return frag(h("p", {}, "1"));
  });

  client.apply({ t: "patch", id: "c1", html: "<p>1</p>", ack: 1 });

  assert.equal(serialize(target), '<div data-weft-c="c1"><p>1</p></div>');
  assert.equal(target.childNodes[0], count, "paragraph reused");
  assert.equal(serialize(other), '<div data-weft-c="c2">untouched</div>');
});

test("redirect and error are routed to their hooks; unknown ids are ignored", () => {
  const root = h("body");
  const { client, nav, errors } = setup(root, () => {
    throw new Error("must not parse for an unknown instance");
  });
  client.apply({ t: "redirect", to: "/done" });
  client.apply({ t: "error", message: "nope", ack: 1 });
  client.apply({ t: "patch", id: "gone", html: "<p/>" });
  assert.deepEqual(nav, ["/done"]);
  assert.deepEqual(errors, ["nope"]);
});

test("stop detaches the delegated listeners", () => {
  const btn = h("button", { "data-weft-on-click": "x" });
  const root = h("body", {}, h("div", { "data-weft-c": "c" }, btn));
  const { client, sent } = setup(root);
  client.stop();
  root.dispatch("click", btn);
  assert.equal(sent.length, 0);
});

test("the server's argument token rides along with the event", () => {
  const btn = h("button", { "data-weft-on-click": "remove", "data-weft-args-click": "3" });
  const root = h("body", {}, h("div", { "data-weft-c": "c1" }, btn));
  const { sent } = setup(root);
  root.dispatch("click", btn);
  assert.equal(sent[0].args, "3");
});

test("a head message replaces the page metadata through setHead", () => {
  const heads: string[][] = [];
  const client = new WeftClient({
    root: h("body"),
    send: () => {},
    parse: () => frag(),
    setHead: (meta, title, lang) => heads.push([meta, title, lang]),
  });
  client.start();
  const wire = encode({ t: "head", meta: "<title>New</title>", title: "New", lang: "en" });
  const msg = decodeServerMessage(wire);
  assert.ok(msg);
  client.apply(msg);
  assert.deepEqual(heads, [["<title>New</title>", "New", "en"]]);
  assert.equal(decodeServerMessage('{"t":"head","meta":1,"title":"x","lang":"en"}'), null);
  assert.equal(decodeServerMessage('{"t":"head","meta":"","title":"x"}'), null);
});

test("a kept child in a patch is the element the page already has", () => {
  const a = h("weft-c", { "data-weft-c": "p.1" }, h("input", { name: "q" }));
  const b = h("weft-c", { "data-weft-c": "p.2" }, h("b", {}));
  const parent = h("weft-c", { "data-weft-c": "p" }, a, b);
  const root = h("body", {}, parent);
  let next = frag();
  let expired = 0;
  const client = new WeftClient({ root, send: () => {}, parse: () => next, onExpired: () => expired++ });
  client.start();
  next = frag(h("weft-c", { "data-weft-c": "p.2", "data-weft-keep": "" }), h("p", {}), h("weft-c", { "data-weft-c": "p.1", "data-weft-keep": "" }));
  client.apply({ t: "patch", id: "p", html: "" });
  const kids = Array.from(parent.childNodes);
  assert.equal(kids.length, 3);
  assert.equal(kids[0], b);
  assert.equal((kids[1] as FElement).nodeName.toUpperCase(), "P");
  assert.equal(kids[2], a);
  assert.equal(expired, 0);
  next = frag(h("weft-c", { "data-weft-c": "p.9", "data-weft-keep": "" }));
  client.apply({ t: "patch", id: "p", html: "" });
  assert.equal(expired, 1);
  assert.equal(parent.childNodes.length, 3, "left as it was");
});

test("offline queue: events carry the data version; conflicts and expiry are reported, not lost", () => {
  const button = h("button", { "data-weft-on-click": "save" });
  const root = h("body", {}, h("div", { "data-weft-c": "c1" }, button), h("div", { "data-weft-c": "c2" }));
  const sent: ClientMessage[] = [];
  const conflicts: unknown[] = [];
  const client = new WeftClient({
    root,
    send: (m) => sent.push(m),
    parse: () => frag(),
    onConflict: (c) => conflicts.push(c),
  });
  client.start();

  root.dispatch("click", button);
  assert.equal((sent[0] as { base?: number }).base, undefined, "version 0 is not sent");
  client.apply({ t: "patch", id: "c2", html: "", v: 3 });
  client.apply({ t: "ack", ack: 1 });
  root.dispatch("click", button);
  assert.equal((sent[1] as { base?: number }).base, 3);
  client.apply({ t: "conflict", ack: 2, reason: "stale" });
  assert.deepEqual(conflicts, [{ reason: "stale", handler: "save", type: "click" }]);

  root.dispatch("click", button);
  client.apply({ t: "expired" });
  assert.deepEqual(conflicts[1], { reason: "expired", handler: "save", type: "click" });
  client.apply({ t: "expired" });
  assert.equal(conflicts.length, 2, "reported once");
});

test("an expiry hands its handoff on; a hello in another protocol version asks for a full load", () => {
  const root = h("div", {});
  const got: (string | undefined)[] = [];
  let incompatible = 0;
  let hellos = 0;
  const client = new WeftClient({
    root,
    send: () => {},
    parse: () => h("div", {}),
    onExpired: (handoff) => got.push(handoff),
    onIncompatible: () => incompatible++,
    onHello: () => hellos++,
  });
  client.start();
  client.apply({ t: "expired", handoff: "tok" });
  client.apply({ t: "expired" });
  assert.deepEqual(got, ["tok", undefined]);
  client.apply({ t: "hello", session: "a", p: PROTOCOL_VERSION });
  client.apply({ t: "hello", session: "b" });
  assert.deepEqual([hellos, incompatible], [2, 0]);
  client.apply({ t: "hello", session: "c", p: PROTOCOL_VERSION + 1 });
  assert.deepEqual([hellos, incompatible], [2, 1]);
});
