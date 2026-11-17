import { test } from "node:test";
import assert from "node:assert/strict";
import { WeftClient, type ClientOptions } from "../src/client.ts";
import { defineIsland, type IslandRegistry } from "../src/island.ts";
import type { ClientMessage, EventMessage } from "../src/protocol.ts";
import { derived, signal } from "../src/signal.ts";
import { frag, h, serialize, text, type FElement, type FNode } from "../testing/fakedom.ts";

let setups = 0;
const Toggle = defineIsland("Toggle", () => {
  setups += 1;
  const open = signal(false);
  const label = derived(() => (open.value ? "Hide" : "Show"));
  function toggle() {
    open.value = !open.value;
  }
  function set(v: boolean) {
    open.value = v;
  }
  return {
    fns: { toggle, set },
    binds: [() => label.value, () => !open.value],
    snapshot: () => [open.value],
    restore: (v: unknown[]) => {
      open.value = v[0] as boolean;
    },
  };
});
const islands: IslandRegistry = { Toggle };

function markup(extra: Record<string, string> = {}): FElement {
  return h(
    "div",
    { "data-weft-c": "c1", "data-weft-island": "Toggle" },
    h("button", { "data-weft-do-click": "toggle", ...extra }, h("weft-t", { "data-weft-t": "0" }, text("Show"))),
    h("p", { "data-weft-ca": "hidden?=1", hidden: "" }, text("details")),
  );
}

function setup(root: FElement, extra: Partial<ClientOptions> = {}) {
  const sent: EventMessage[] = [];
  const errors: string[] = [];
  const client = new WeftClient({
    root,
    send: (m: ClientMessage) => sent.push(m as EventMessage),
    parse: () => frag(),
    islands,
    createText: (s: string) => text(s) as FNode,
    onError: (m) => errors.push(m),
    ...extra,
  });
  client.start();
  return { client, sent, errors };
}

const button = (root: FElement) => (root.childNodes[0] as FElement).childNodes[0] as FElement;
const para = (root: FElement) => (root.childNodes[0] as FElement).childNodes[1] as FElement;

test("a client action updates bound text and attributes locally", () => {
  const root = h("body", {}, markup());
  const { sent } = setup(root);
  assert.equal(serialize(button(root)).includes(">Show<"), true);
  root.dispatch("click", button(root));
  assert.equal(sent.length, 0, "nothing goes to the server");
  assert.match(serialize(button(root)), />Hide</);
  assert.equal(para(root).hasAttribute("hidden"), false);
  root.dispatch("click", button(root));
  assert.match(serialize(button(root)), />Show</);
  assert.equal(para(root).hasAttribute("hidden"), true);
});

test("bound JSON arguments are passed to the client function", () => {
  const root = h("body", {}, markup({ "data-weft-do-click": "set", "data-weft-doargs-click": "[true]" }));
  setup(root);
  root.dispatch("click", button(root));
  root.dispatch("click", button(root));
  assert.match(serialize(button(root)), />Hide</);
});

test("client state survives a server patch and is re-bound", () => {
  setups = 0;
  const root = h("body", {}, markup());
  const { client } = setup(root, { parse: () => frag(...markup().childNodes) });
  root.dispatch("click", button(root));
  client.apply({ t: "patch", id: "c1", html: "" });
  assert.equal(setups, 1, "setup runs once per instance");
  assert.match(serialize(button(root)), />Hide</);
  assert.equal(para(root).hasAttribute("hidden"), false);
  root.dispatch("click", button(root));
  assert.match(serialize(button(root)), />Show</);
});

test("an optimistic update is kept on success and undone on error", () => {
  const root = h("body", {}, markup({ "data-weft-on-click": "save", "data-weft-opt-click": "toggle" }));
  button(root).removeAttribute("data-weft-do-click");
  const { client, sent } = setup(root);
  root.dispatch("click", button(root));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].handler, "save");
  assert.match(serialize(button(root)), />Hide</, "applied before the answer");
  client.apply({ t: "ack", ack: sent[0].seq });
  assert.match(serialize(button(root)), />Hide</, "kept after success");

  root.dispatch("click", button(root));
  assert.match(serialize(button(root)), />Show</);
  client.apply({ t: "error", message: "nope", ack: sent[1].seq });
  assert.match(serialize(button(root)), />Hide</, "restored after an error");
});

test("unknown client functions and islands are reported, not evaluated", () => {
  const root = h("body", {}, markup({ "data-weft-do-click": "constructor" }));
  const { errors } = setup(root);
  root.dispatch("click", button(root));
  assert.deepEqual(errors, ["no client function constructor"]);

  const other = h("body", {}, h("div", { "data-weft-c": "c9", "data-weft-island": "Nope" }));
  const r = setup(other);
  assert.deepEqual(r.errors, ["no island module for Nope"]);
});

test("islands that leave the page are disposed", () => {
  const root = h("body", {}, h("main", { "data-weft-c": "c0" }, markup()));
  const { client } = setup(root, { parse: () => frag() });
  client.apply({ t: "patch", id: "c0", html: "" });
  assert.equal((root.childNodes[0] as FElement).childNodes.length, 0);
});

test("client onMount runs once after binding; cleanup and onDestroy on removal", () => {
  const log: string[] = [];
  const Hooked = defineIsland("Hooked", () => ({
    fns: {},
    binds: [],
    mount: [
      () => {
        log.push("mount");
        return () => log.push("cleanup");
      },
    ],
    destroy: [() => log.push("destroy")],
    snapshot: () => [],
    restore: () => {},
  }));
  const island = () => h("div", { "data-weft-c": "c1", "data-weft-island": "Hooked" });
  const root = h("body", {}, h("main", { "data-weft-c": "c0" }, island()));
  const { client } = setup(root, { islands: { Hooked }, parse: () => frag(island()) });
  assert.deepEqual(log, ["mount"]);
  client.apply({ t: "patch", id: "c0", html: "" });
  assert.deepEqual(log, ["mount"], "a patch keeps the mounted island");
  client.stop();
  assert.deepEqual(log, ["mount", "cleanup", "destroy"]);
});

test("an expired page is reported, and island state carries to a fresh render", () => {
  let expired = 0;
  const islandAt = (id: string) => {
    const el = markup();
    el.setAttribute("data-weft-c", id);
    return el;
  };
  const oldRoot = h("body", {}, islandAt("c1"), islandAt("c2"));
  const { client } = setup(oldRoot, { onExpired: () => (expired += 1) });
  const second = (root: FElement) => (root.childNodes[1] as FElement).childNodes[0] as FElement;
  oldRoot.dispatch("click", second(oldRoot));
  client.apply({ t: "expired" });
  assert.equal(expired, 1);
  const states = client.islandStates();
  assert.deepEqual(states, [
    { name: "Toggle", state: [false] },
    { name: "Toggle", state: [true] },
  ]);
  client.stop();

  const fresh = h("body", {}, islandAt("n1"), islandAt("n2"));
  setup(fresh, { resume: states });
  assert.match(serialize(button(fresh)), />Show</, "first stays closed");
  assert.match(serialize(second(fresh)), />Hide</, "second is open again");
});

test("a bound URL attribute never becomes a script URL", () => {
  const url = signal("/safe");
  const Link = defineIsland("Link", () => ({ fns: {}, binds: [() => url.value] }));
  const root = h("body", {}, h("div", { "data-weft-c": "c1", "data-weft-island": "Link" }, h("a", { "data-weft-ca": "href=0", href: "/safe" })));
  setup(root, { islands: { Link } });
  const a = (root.childNodes[0] as FElement).childNodes[0] as FElement;
  assert.equal(a.getAttribute("href"), "/safe");
  url.value = " JaVa\tScRiPt:alert(1)";
  assert.equal(a.getAttribute("href"), "about:invalid#weft-blocked");
  url.value = "/next?x=1";
  assert.equal(a.getAttribute("href"), "/next?x=1");
});

test("use: attachments get the element, follow their value and clean up", () => {
  const log: string[] = [];
  const open = signal(false);
  const unrelated = signal(0);
  const tag = (el: unknown) => (el as FElement).nodeName.toLowerCase();
  function trap(el: unknown, on: unknown) {
    log.push(`trap ${tag(el)} ${String(on)} (${unrelated.value})`);
    return () => log.push(`untrap ${String(on)}`);
  }
  function tip(el: unknown, text: unknown) {
    (el as FElement).setAttribute("title", String(text));
    return () => log.push(`untip ${String(text)}`);
  }
  function mark(el: unknown) {
    log.push(`mark ${tag(el)}`);
    return () => log.push("unmark");
  }
  function boom() {
    throw new Error("no");
  }
  const Pop = defineIsland("Pop.1", () => ({
    fns: {},
    binds: [],
    uses: [[trap, () => open.value], [tip], [mark], [boom]],
    snapshot: () => [],
    restore: () => {},
  }));
  const body = (hint: string, slotted: boolean) => [
    h("button", { "data-weft-use": JSON.stringify(["Pop.1", [0], [1, hint]]) }),
    h(
      "section",
      { "data-weft-c": "c2" },
      ...(slotted ? [h("i", { "data-weft-use": JSON.stringify(["Pop.1", [2]]) })] : []),
      h("b", { "data-weft-use": JSON.stringify(["Other.9", [0]]) }),
      h("u", { "data-weft-use": JSON.stringify(["Pop.1", [99], [3]]) }),
    ),
  ];
  let next = body("hi", true);
  const root = h("body", {}, h("div", { "data-weft-c": "c1", "data-weft-island": "Pop.1" }, ...body("hi", true)));
  const { client, errors } = setup(root, { islands: { "Pop.1": Pop }, parse: () => frag(...next) });
  const btn = () => (root.childNodes[0] as FElement).childNodes[0] as FElement;
  assert.deepEqual(log, ["trap button false (0)", "mark i"]);
  assert.equal(btn().getAttribute("title"), "hi");
  assert.deepEqual(errors, ["use:boom failed: Error: no"]);

  open.value = true;
  assert.deepEqual(log.splice(0), ["trap button false (0)", "mark i", "untrap false", "trap button true (0)"]);
  unrelated.value = 1;
  assert.deepEqual(log, [], "reads inside the attachment are not tracked");

  next = body("bye", false);
  client.apply({ t: "patch", id: "c1", html: "" });
  assert.deepEqual(log.splice(0), ["untip hi", "unmark"]);
  assert.equal(btn().getAttribute("title"), "bye");

  client.stop();
  assert.deepEqual(log, ["untrap true", "untip bye"]);
});
