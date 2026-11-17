import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_EVENTS, WeftClient, type ClientOptions, type Timers } from "../src/client.ts";
import type { ClientMessage, EventMessage } from "../src/protocol.ts";
import { frag, h, type FElement } from "../testing/fakedom.ts";

class FakeTimers implements Timers {
  now = 0;
  private next = 1;
  private readonly due = new Map<number, { at: number; fn: () => void; every?: number }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.due.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.due.delete(h as number);
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.due.set(id, { at: this.now + ms, fn, every: ms });
    return id;
  }
  clearInterval(h: unknown): void {
    this.due.delete(h as number);
  }
  get active(): number {
    return this.due.size;
  }
  tick(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let first: [number, { at: number; fn: () => void; every?: number }] | null = null;
      for (const e of this.due) {
        if (e[1].at <= end && (!first || e[1].at < first[1].at)) first = e;
      }
      if (!first) break;
      const [id, t] = first;
      this.now = t.at;
      if (t.every) t.at += t.every;
      else this.due.delete(id);
      t.fn();
    }
    this.now = end;
  }
}

function setup(root: FElement, extra: Partial<ClientOptions> = {}) {
  const sent: EventMessage[] = [];
  const timers = new FakeTimers();
  const client = new WeftClient({
    root,
    send: (m: ClientMessage) => sent.push(m),
    parse: () => frag(),
    timers,
    ...extra,
  });
  client.start();
  return { client, sent, timers };
}

const inst = (...kids: FElement[]) => h("div", { "data-weft-c": "c1" }, ...kids);

test("debounce sends once, after the pause, with the latest value", () => {
  const input = h("input", { "data-weft-on-input": "search", "data-weft-mod-input": "debounce=300" });
  const root = h("body", {}, inst(input));
  const { sent, timers } = setup(root);
  input.value = "w";
  root.dispatch("input", input);
  timers.tick(200);
  input.value = "we";
  root.dispatch("input", input);
  timers.tick(299);
  assert.equal(sent.length, 0);
  input.value = "weft";
  root.dispatch("input", input);
  timers.tick(300);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event.value, "weft");
});

test("throttle sends the leading event and the last one in each window", () => {
  const box = h("div", { "data-weft-on-pointerdown": "drag", "data-weft-mod-pointerdown": "throttle=100" });
  const root = h("body", {}, inst(box));
  const { sent, timers } = setup(root);
  for (let i = 0; i < 5; i++) {
    root.dispatch("pointerdown", box);
    timers.tick(10);
  }
  assert.equal(sent.length, 1, "leading edge only so far");
  timers.tick(100);
  assert.equal(sent.length, 2, "trailing event at the window's end");
  timers.tick(500);
  assert.equal(sent.length, 2, "no further sends without events");
  root.dispatch("pointerdown", box);
  assert.equal(sent.length, 3, "a new window opens with a leading send");
});

test("once fires a single time per element", () => {
  const b = h("button", { "data-weft-on-click": "go", "data-weft-mod-click": "once" });
  const root = h("body", {}, inst(b));
  const { sent } = setup(root);
  assert.equal(root.dispatch("click", b).prevented, true);
  assert.equal(root.dispatch("click", b).prevented, false, "spent: not handled at all");
  assert.equal(sent.length, 1);
});

test("key filters and held keys", () => {
  const input = h("input", { "data-weft-on-keydown": "save", "data-weft-mod-keydown": "ctrl key=Enter prevent" });
  const root = h("body", {}, inst(input));
  const { sent } = setup(root);
  assert.equal(root.dispatch("keydown", input, { key: "Enter" }).prevented, false);
  assert.equal(root.dispatch("keydown", input, { key: "a", ctrlKey: true }).prevented, false);
  assert.equal(root.dispatch("keydown", input, { key: "Enter", ctrlKey: true }).prevented, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event.key, "Enter");

  const k = h("input", { "data-weft-on-keyup": "find", "data-weft-mod-keyup": "key=k key=Space" });
  const r2 = h("body", {}, inst(k));
  const s2 = setup(r2).sent;
  r2.dispatch("keyup", k, { key: "K" });
  r2.dispatch("keyup", k, { key: " " });
  r2.dispatch("keyup", k, { key: "j" });
  assert.equal(s2.length, 2);
});

test("default handling: clicks and submits are prevented, keys and toggles are not", () => {
  const typed = h("input", { "data-weft-on-keydown": "k" });
  const box = h("input", { "data-weft-on-click": "t" });
  box.type = "checkbox";
  const link = h("a", { href: "/x", "data-weft-on-click": "track", "data-weft-mod-click": "passive" });
  const root = h("body", {}, inst(typed, box, link));
  const { sent } = setup(root);
  assert.equal(root.dispatch("keydown", typed, { key: "a" }).prevented, false);
  assert.equal(root.dispatch("click", box).prevented, false);
  assert.equal(root.dispatch("click", link).prevented, false);
  assert.equal(sent.length, 3, "all still delivered");
});

test("directives bubble innermost first; .stop ends it; .self needs the element itself", () => {
  const del = h("button", { "data-weft-on-click": "remove" });
  const row = h("li", { "data-weft-on-click": "open" }, del);
  const root = h("body", {}, inst(h("ul", {}, row)));
  const { sent } = setup(root);
  root.dispatch("click", del);
  assert.deepEqual(sent.map((m) => m.handler), ["remove", "open"]);

  del.setAttribute("data-weft-mod-click", "stop");
  root.dispatch("click", del);
  assert.deepEqual(sent.slice(2).map((m) => m.handler), ["remove"]);

  del.removeAttribute("data-weft-mod-click");
  row.setAttribute("data-weft-mod-click", "self");
  root.dispatch("click", del);
  assert.deepEqual(sent.slice(3).map((m) => m.handler), ["remove"], "row skipped: not its own click");
  root.dispatch("click", row);
  assert.deepEqual(sent.slice(4).map((m) => m.handler), ["open"]);
});

test("confirm asks first and fails closed without a prompt", () => {
  const b = h("button", {
    "data-weft-on-click": "drop",
    "data-weft-mod-click": "confirm",
    "data-weft-confirm-click": "Delete it?",
  });
  const asked: string[] = [];
  let answer = false;
  const root = h("body", {}, inst(b));
  const { sent } = setup(root, { confirm: (m) => (asked.push(m), answer) });
  root.dispatch("click", b);
  assert.equal(sent.length, 0);
  answer = true;
  root.dispatch("click", b);
  assert.equal(sent.length, 1);
  assert.deepEqual(asked, ["Delete it?", "Delete it?"]);

  const b2 = h("button", { "data-weft-on-click": "drop", "data-weft-confirm-click": "x" });
  const r2 = h("body", {}, inst(b2));
  const s2 = setup(r2).sent;
  r2.dispatch("click", b2);
  assert.equal(s2.length, 0);
});

test("@load fires once per element, including patched-in ones", () => {
  const a = h("div", { "data-weft-on-load": "init" });
  const host = inst(a);
  const root = h("body", {}, host);
  const parse = () => frag(h("div", { "data-weft-on-load": "init" }), h("p", { "data-weft-on-load": "more" }));
  const { client, sent } = setup(root, { parse });
  assert.deepEqual(sent.map((m) => m.handler), ["init"]);
  assert.equal(sent[0].event.type, "load");
  client.apply({ t: "patch", id: "c1", html: "" });
  assert.deepEqual(sent.map((m) => m.handler), ["init", "more"]);
});

test("@every polls while present and visible, and stops when removed", () => {
  const poll = h("div", { "data-weft-on-every": "refresh", "data-weft-mod-every": "every=5000" });
  const root = h("body", {}, inst(poll));
  let hidden = false;
  const { client, sent, timers } = setup(root, { hidden: () => hidden, parse: () => frag() });
  timers.tick(15_000);
  assert.equal(sent.length, 3);
  hidden = true;
  timers.tick(10_000);
  assert.equal(sent.length, 3, "background tab: no polls");
  hidden = false;
  client.apply({ t: "patch", id: "c1", html: "" });
  timers.tick(20_000);
  assert.equal(sent.length, 3);
  assert.equal(timers.active, 0);
});

test("@visible uses the observer and honours .once", () => {
  const el = h("div", { "data-weft-on-visible": "more", "data-weft-mod-visible": "once" });
  const root = h("body", {}, inst(el));
  const seen: (() => void)[] = [];
  let stopped = 0;
  const { client, sent } = setup(root, {
    observe: (_el, cb) => (seen.push(cb), () => stopped++),
  });
  assert.equal(seen.length, 1);
  seen[0]();
  seen[0]();
  assert.equal(sent.length, 1);
  client.stop();
  assert.equal(stopped, 1);
});

test(":busy marks and disables while the instance's event is pending", () => {
  const btn = h("button", { "data-weft-on-click": "save", "data-weft-busy": "" });
  const pre = h("button", { "data-weft-busy": "", disabled: "" });
  const host = inst(btn, pre);
  const root = h("body", {}, host);
  const { client, sent } = setup(root);
  root.dispatch("click", btn);
  assert.equal(host.hasAttribute("data-weft-pending"), true);
  assert.equal(btn.getAttribute("aria-busy"), "true");
  assert.equal(btn.hasAttribute("disabled"), true);
  assert.equal(pre.hasAttribute("disabled"), true);
  client.apply({ t: "ack", ack: sent[0].seq });
  assert.equal(host.hasAttribute("data-weft-pending"), false);
  assert.equal(btn.hasAttribute("aria-busy"), false);
  assert.equal(btn.hasAttribute("disabled"), false);
  assert.equal(pre.hasAttribute("disabled"), true, "already disabled: left alone");

  root.dispatch("click", btn);
  client.apply({ t: "error", message: "x", ack: sent[1].seq });
  assert.equal(btn.hasAttribute("disabled"), false, "an error answers the event too");
});

test("the client listens for exactly the compiler's events", () => {
  const src = readFileSync(new URL("../../../crates/weft-compiler/src/events.rs", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("pub const DOM_EVENTS"), src.indexOf("];", src.indexOf("pub const DOM_EVENTS")));
  const rust = [...block.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...DEFAULT_EVENTS], rust);
});
