import { test } from "node:test";
import assert from "node:assert/strict";
import { DEV_CLIENT_JS, DevEvents, overlayText } from "../src/dev-events.ts";

async function read(res: Response, chunks: number): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (let i = 0; i < chunks; i++) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    out += dec.decode(value);
  }
  await reader.cancel();
  return out;
}

test("a build error reaches open pages and pages opened later", async () => {
  const ev = new DevEvents();
  const open = ev.response();
  assert.equal(open.headers.get("content-type"), "text/event-stream");
  ev.fail("\x1b[31merror\x1b[0m: Page.wx:3:1: unexpected `}`\nsecond line");
  assert.equal(ev.current, "error: Page.wx:3:1: unexpected `}`\nsecond line");
  const seen = await read(open, 2);
  assert.ok(seen.includes(`event: weft-error\ndata: ${JSON.stringify(ev.current)}\n\n`), seen);

  const late = await read(ev.response(), 2);
  assert.ok(late.includes("event: weft-error"), "replayed on connect");

  ev.reload();
  assert.equal(ev.current, null);
  const fresh = await read(ev.response(), 1);
  assert.ok(!fresh.includes("weft-error"), "a good build clears it");
  ev.close();
});

test("overlay text is plain and bounded", () => {
  assert.equal(overlayText("\x1b[1;31mx\x1b[0m"), "x");
  assert.ok(overlayText("a".repeat(30_000)).length < 20_100);
});

test("the overlay builds DOM nodes with text content and CSSOM styles", () => {
  type Node = {
    tag: string;
    id?: string;
    textContent?: string;
    type?: string;
    attrs: Record<string, string>;
    style: { setProperty(k: string, v: string): void; props: Record<string, string> };
    kids: Node[];
    listeners: Record<string, () => void>;
    append(...n: Node[]): void;
    setAttribute(k: string, v: string): void;
    addEventListener(t: string, fn: () => void): void;
    remove(): void;
    focus(): void;
  };
  const made: Node[] = [];
  const body: Node[] = [];
  const el = (tag: string): Node => {
    const props: Record<string, string> = {};
    const n: Node = {
      tag,
      attrs: {},
      style: { setProperty: (k, v) => void (props[k] = v), props },
      kids: [],
      listeners: {},
      append: (...k) => void n.kids.push(...k),
      setAttribute: (k, v) => void (n.attrs[k] = v),
      addEventListener: (t, fn) => void (n.listeners[t] = fn),
      remove: () => void body.splice(body.indexOf(n), 1),
      focus: () => undefined,
    };
    made.push(n);
    return n;
  };
  const sources: { listeners: Record<string, (e: { data: string }) => void>; onmessage?: () => void }[] = [];
  class FakeEventSource {
    listeners: Record<string, (e: { data: string }) => void> = {};
    onmessage?: () => void;
    constructor(url: string) {
      assert.equal(url, "/_weft/dev/events");
      sources.push(this);
    }
    addEventListener(t: string, fn: (e: { data: string }) => void) {
      this.listeners[t] = fn;
    }
  }
  const document = {
    createElement: el,
    getElementById: (id: string) => body.find((n) => n.id === id) ?? null,
    body: { append: (n: Node) => void body.push(n) },
  };
  let reloaded = 0;
  new Function("EventSource", "document", "location", DEV_CLIENT_JS)(FakeEventSource, document, {
    reload: () => void (reloaded += 1),
  });
  const es = sources[0];
  const hostile = `<img src=x onerror=alert(1)>`;
  es.listeners["weft-error"]({ data: JSON.stringify(hostile) });
  assert.equal(body.length, 1);
  const pre = made.find((n) => n.tag === "pre")!;
  assert.equal(pre.textContent, hostile, "inserted as text, never parsed");
  assert.equal(body[0].style.props.position, "fixed");
  assert.ok(made.every((n) => !("style" in n.attrs)), "no style attributes (CSP)");
  es.listeners["weft-error"]({ data: JSON.stringify("second") });
  assert.equal(body.length, 1, "a new error replaces the overlay");
  made.find((n) => n.tag === "button")!.listeners.click();
  assert.equal(body.length, 0, "dismissable");
  es.onmessage!();
  assert.equal(reloaded, 1);
});

test("a hidden tab lets the dev stream go and reloads if a build landed meanwhile", async () => {
  const ev = new DevEvents();
  assert.ok((await read(ev.response(), 1)).includes("event: weft-build\ndata: 0\n\n"));
  ev.reload();
  assert.ok((await read(ev.response(), 1)).includes("event: weft-build\ndata: 1\n\n"));
  ev.close();

  const sources: { listeners: Record<string, (e: { data: string }) => void>; closed: boolean }[] = [];
  class FakeEventSource {
    listeners: Record<string, (e: { data: string }) => void> = {};
    onmessage?: () => void;
    closed = false;
    constructor() {
      sources.push(this);
    }
    addEventListener(t: string, fn: (e: { data: string }) => void) {
      this.listeners[t] = fn;
    }
    close() {
      this.closed = true;
    }
  }
  let onVisibility = () => {};
  const document = {
    visibilityState: "visible",
    addEventListener: (_t: string, fn: () => void) => void (onVisibility = fn),
  };
  const timers: (() => void)[] = [];
  let reloaded = 0;
  new Function("EventSource", "document", "location", "setTimeout", "clearTimeout", DEV_CLIENT_JS)(
    FakeEventSource,
    document,
    { reload: () => void (reloaded += 1) },
    (fn: () => void) => timers.push(fn),
    () => {},
  );
  sources[0].listeners["weft-build"]({ data: "3" });

  document.visibilityState = "hidden";
  onVisibility();
  timers.at(-1)!();
  assert.equal(sources[0].closed, true, "released while hidden");

  document.visibilityState = "visible";
  onVisibility();
  assert.equal(sources.length, 2, "reopened when shown");
  sources[1].listeners["weft-build"]({ data: "3" });
  assert.equal(reloaded, 0, "same build: nothing to do");

  document.visibilityState = "hidden";
  onVisibility();
  timers.at(-1)!();
  document.visibilityState = "visible";
  onVisibility();
  sources[2].listeners["weft-build"]({ data: "4" });
  assert.equal(reloaded, 1, "a rebuild while hidden reloads");
});
