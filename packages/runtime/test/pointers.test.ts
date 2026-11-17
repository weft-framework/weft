import { test } from "node:test";
import assert from "node:assert/strict";
import type { PointMessage } from "../src/protocol.ts";
import { POINT_ATTR, POINT_ON_ATTR, PointerArea, pointerPlace, type PointElement } from "../src/pointers.ts";

type Box = { left: number; top: number; width: number; height: number };

class FakeNode {
  attrs: Record<string, string>;
  box: Box;
  parent: FakeNode | null = null;
  kids: FakeNode[] = [];
  fns = new Map<string, (ev: unknown) => void>();
  events: { type: string; detail: unknown }[] = [];
  constructor(attrs: Record<string, string>, box: Box) {
    this.attrs = attrs;
    this.box = box;
  }
  add(k: FakeNode) {
    k.parent = this;
    this.kids.push(k);
    return k;
  }
  get parentNode() {
    return this.parent;
  }
  getAttribute(n: string) {
    return this.attrs[n] ?? null;
  }
  getBoundingClientRect() {
    return this.box;
  }
  contains(o: unknown): boolean {
    for (let n = o as FakeNode | null; n; n = n.parent) if (n === this) return true;
    return false;
  }
  closest(sel: string): FakeNode | null {
    const attr = /^\[([^\]]+)\]$/.exec(sel)![1]!;
    for (let n: FakeNode | null = this; n; n = n.parent) if (n.attrs[attr] !== undefined) return n;
    return null;
  }
  querySelectorAll(sel: string) {
    const attr = /^\[([^\]]+)\]$/.exec(sel)![1]!;
    const out: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      for (const k of n.kids) {
        if (k.attrs[attr] !== undefined) out.push(k);
        walk(k);
      }
    };
    walk(this);
    return out;
  }
  addEventListener(t: string, fn: (ev: unknown) => void) {
    this.fns.set(t, fn);
  }
  removeEventListener(t: string) {
    this.fns.delete(t);
  }
  dispatchEvent(ev: unknown) {
    this.events.push(ev as { type: string; detail: unknown });
    return true;
  }
}

function setup() {
  const el = new FakeNode({ [POINT_ATTR]: "p.area" }, { left: 0, top: 0, width: 400, height: 300 });
  const row = el.add(new FakeNode({ [POINT_ON_ATTR]: "row-2" }, { left: 0, top: 100, width: 400, height: 50 }));
  const inner = row.add(new FakeNode({}, { left: 10, top: 110, width: 50, height: 20 }));
  const sent: PointMessage[] = [];
  const timers: (() => void)[] = [];
  const area = new PointerArea(el as unknown as PointElement, {
    send: (m) => sent.push(m),
    event: (type, detail) => ({ type, detail }),
    setTimeout: (fn) => (timers.push(fn), timers.length),
    clearTimeout: () => {},
  });
  const tick = () => timers.splice(0).forEach((f) => f());
  const move = (x: number, y: number, target: FakeNode) => el.fns.get("pointermove")!({ clientX: x, clientY: y, target });
  return { el, row, inner, sent, area, tick, move };
}

test("a pointer goes as a fraction of its anchor, coalesced, and only when joined", () => {
  const { el, inner, sent, area, tick, move } = setup();
  move(100, 125, inner);
  tick();
  assert.equal(sent.length, 0, "nothing before joining");
  area.join();
  assert.deepEqual({ ...sent.shift(), tab: undefined }, { t: "point", area: "p.area", join: true, tab: undefined });
  tick();
  assert.deepEqual(sent.shift(), { t: "point", area: "p.area", at: { on: "row-2", x: 0.25, y: 0.5 } });
  move(200, 125, inner);
  move(300, 125, inner);
  tick();
  assert.deepEqual(sent.splice(0), [{ t: "point", area: "p.area", at: { on: "row-2", x: 0.75, y: 0.5 } }]);
  move(300, 125, inner);
  tick();
  assert.equal(sent.length, 0);
  move(200, 30, el);
  tick();
  assert.deepEqual(sent.shift()?.at, { x: 0.5, y: 0.1 });
  el.fns.get("pointerleave")!({});
  tick();
  assert.deepEqual(sent.shift(), { t: "point", area: "p.area", at: null });
  area.stop();
  assert.equal(el.fns.size, 0);
});

test("the others' pointers are dispatched and placed back in pixels", () => {
  const { el, area } = setup();
  area.receive([{ id: "p1", label: "Ada", at: { on: "row-2", x: 0.5, y: 0.5 } }]);
  assert.equal(el.events[0]!.type, "weft:pointers");
  const p = (el.events[0]!.detail as { pointers: never[] }).pointers[0]!;
  assert.deepEqual(pointerPlace(el as unknown as PointElement, p), { x: 200, y: 125 });
  assert.equal(pointerPlace(el as unknown as PointElement, { id: "p2", at: { on: "gone", x: 0, y: 0 } }), null);
  assert.equal(pointerPlace(el as unknown as PointElement, { id: "p3" }), null);
});

test("a spread renders data-weft-point only from the runtime's own object", async () => {
  const { runtimeAttrs, spreadAttrs } = await import("../src/escape.ts");
  assert.equal(spreadAttrs({ "data-weft-point": "p.x", id: "a" }), ` id="a"`);
  assert.equal(spreadAttrs(runtimeAttrs({ "data-weft-point": "p.x" })), ` data-weft-point="p.x"`);
  assert.equal(spreadAttrs(runtimeAttrs({ "data-weft-on-click": "go" })), "", "only the pointer area name");
  assert.equal(spreadAttrs({ ...runtimeAttrs({ "data-weft-point": "p.x" }) }), "", "a copy is not trusted");
});

function followSetup(path: string) {
  const base = setup();
  const scrolls: number[] = [];
  const navs: string[] = [];
  const win = {
    scrollY: 0,
    scrollTo: (_x: number, y: number) => scrolls.push(y),
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { pathname: path, search: "" },
  };
  const area = new PointerArea(base.el as unknown as PointElement, {
    send: (m) => base.sent.push(m),
    event: (type, detail) => ({ type, detail }),
    setTimeout: () => 1,
    clearTimeout: () => {},
    window: win,
    navigate: (to) => navs.push(to),
    storage: { getItem: () => null, setItem: () => {} },
  });
  return { ...base, area, win, scrolls, navs };
}

test("presenting shares the path and the anchor at the top of the window", async () => {
  const { resetPointerChoices } = await import("../src/pointers.ts");
  resetPointerChoices();
  const { area, sent, row } = followSetup("/doc/1");
  area.join();
  const join = sent.shift()!;
  assert.match(join.tab ?? "", /^[0-9a-f]{32}$/);
  row.box = { left: 0, top: -20, width: 400, height: 50 };
  area.present(true);
  assert.equal(area.presenting, true);
  (area as unknown as { flush(): void }).flush();
  assert.deepEqual(sent.shift()?.view, { path: "/doc/1", on: "row-2", y: 0.4 });
  area.present(false);
  (area as unknown as { flush(): void }).flush();
  assert.equal(sent.shift()?.view, null);
});

test("following navigates to the presenter's path, then scrolls to its anchor", async () => {
  const { resetPointerChoices } = await import("../src/pointers.ts");
  resetPointerChoices();
  const f = followSetup("/doc/1");
  f.area.join();
  f.area.follow("t-ada");
  f.area.receive([{ id: "t-ada", label: "Ada", view: { path: "/doc/2", on: "row-2", y: 0.5 } }]);
  assert.deepEqual(f.navs, ["/doc/2"]);
  f.area.receive([{ id: "t-ada", view: { path: "/doc/2", on: "row-2", y: 0.5 } }]);
  assert.deepEqual(f.navs, ["/doc/2"], "navigates once per path");
  f.area.stop();
  f.win.location.pathname = "/doc/2";
  const next = new PointerArea(f.el as unknown as PointElement, {
    send: () => {},
    event: (type, detail) => ({ type, detail }),
    setTimeout: () => 1,
    clearTimeout: () => {},
    window: f.win,
    navigate: (to) => f.navs.push(to),
  });
  assert.equal(next.following, "t-ada");
  f.row.box = { left: 0, top: 300, width: 400, height: 50 };
  next.receive([{ id: "t-ada", view: { path: "/doc/2", on: "row-2", y: 0.5 } }]);
  assert.deepEqual(f.scrolls, [325]);
  f.el.events.length = 0;
  next.receive([{ id: "t-ada", at: { x: 0, y: 0 } }]);
  assert.equal(next.following, null);
  assert.deepEqual(f.el.events.at(-1), { type: "weft:follow", detail: { following: null, reason: "stopped" } });
});

test("going somewhere else yourself stops following; an unsafe path is never followed", async () => {
  const { resetPointerChoices } = await import("../src/pointers.ts");
  resetPointerChoices();
  const f = followSetup("/doc/1");
  f.area.follow("t-ada");
  f.area.receive([{ id: "t-ada", view: { path: "/doc/2", y: 0 } }]);
  f.area.stop();
  f.win.location.pathname = "/elsewhere";
  const next = new PointerArea(f.el as unknown as PointElement, { send: () => {}, window: f.win, navigate: () => {} });
  assert.equal(next.following, null);
  next.follow("t-eve");
  next.receive([{ id: "t-eve", view: { path: "//evil.example/x", y: 0 } }]);
  assert.deepEqual(f.navs, ["/doc/2"]);
});
