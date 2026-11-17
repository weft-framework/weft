import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, transform, type Edit } from "../src/ot.ts";
import type { ServerMessage, TextMessage } from "../src/protocol.ts";
import { SHARED_ATTR, SHARED_REV_ATTR, SharedField, type SharedElement } from "../src/shared.ts";

type Text = Extract<ServerMessage, { t: "text" }>;

class FakeEl implements SharedElement {
  value: string;
  readOnly = false;
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  selectionDirection: string | null = "forward";
  events: { type: string; detail: unknown }[] = [];
  private fns = new Map<string, Set<(ev: unknown) => void>>();
  private attrs: Record<string, string>;
  constructor(value: string, attrs: Record<string, string>) {
    this.attrs = attrs;
    this.value = value;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    if (!this.fns.has(type)) this.fns.set(type, new Set());
    this.fns.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void) {
    this.fns.get(type)?.delete(fn);
  }
  setSelectionRange(a: number, b: number) {
    this.selectionStart = a;
    this.selectionEnd = b;
  }
  dispatchEvent(ev: unknown) {
    this.events.push(ev as { type: string; detail: unknown });
    return true;
  }
  type(from: number, to: number, s: string) {
    this.value = this.value.slice(0, from) + s + this.value.slice(to);
    this.selectionStart = this.selectionEnd = from + s.length;
    for (const fn of this.fns.get("input") ?? []) fn({});
  }
  states() {
    return this.events.filter((e) => e.type === "weft:shared").map((e) => (e.detail as { state: string }).state);
  }
}

class Server {
  text: string;
  rev = 0;
  log: { rev: number; edit: Edit }[] = [];
  pages: { field: SharedField; inbox: Text[] }[] = [];
  writable = true;
  constructor(text: string) {
    this.text = text;
  }
  page(): { field: SharedField; el: FakeEl; inbox: Text[]; deliver(): void } {
    const el = new FakeEl(this.text, { [SHARED_ATTR]: "s.doc", [SHARED_REV_ATTR]: String(this.rev) });
    const inbox: Text[] = [];
    const out: TextMessage[] = [];
    const field = new SharedField(el, {
      send: (m) => out.push(m),
      event: (type, detail) => ({ type, detail }),
      setTimeout: () => 1,
      clearTimeout: () => {},
    });
    const me = { field, inbox };
    this.pages.push(me);
    const server = this;
    const pump = () => {
      while (out.length) server.take(me, out.shift()!);
    };
    return {
      field,
      el,
      inbox,
      deliver() {
        pump();
        while (inbox.length) {
          field.receive(inbox.shift()!);
          pump();
        }
      },
    };
  }
  take(from: { field: SharedField; inbox: Text[] }, m: TextMessage): void {
    if (m.join) {
      from.inbox.push({ t: "text", doc: m.doc, rev: this.rev, text: this.text, writable: this.writable });
      return;
    }
    if (m.edit) {
      if (!this.writable) {
        from.inbox.push({ t: "text", doc: m.doc, rev: this.rev, text: this.text, writable: false, refused: "no" });
        return;
      }
      let edit = m.edit;
      for (const e of this.log) if (e.rev > m.rev) edit = transform(edit, e.edit, false)[0];
      this.text = applyEdit(this.text, edit);
      this.rev += 1;
      this.log.push({ rev: this.rev, edit });
      for (const p of this.pages) {
        p.inbox.push(p === from ? { t: "text", doc: m.doc, rev: this.rev, mine: true } : { t: "text", doc: m.doc, rev: this.rev, edit });
      }
    }
  }
}

function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("three fields typing at once converge on the server's text", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rnd = random(seed);
    const server = new Server("hello world");
    const pages = [server.page(), server.page(), server.page()];
    for (const p of pages) {
      p.field.join();
      p.deliver();
    }
    for (let step = 0; step < 60; step++) {
      const p = pages[Math.floor(rnd() * pages.length)]!;
      if (rnd() < 0.6) {
        const len = p.el.value.length;
        const from = Math.floor(rnd() * (len + 1));
        const to = Math.min(len, from + (rnd() < 0.3 ? Math.floor(rnd() * 3) : 0));
        p.el.type(from, to, rnd() < 0.8 ? "abcxyz"[Math.floor(rnd() * 6)]! : "");
      } else {
        p.deliver();
      }
    }
    for (let round = 0; round < 20; round++) for (const p of pages) p.deliver();
    for (const p of pages) assert.equal(p.el.value, server.text, `seed ${seed}`);
  }
});

test("an edit typed while the join is pending is kept and sent", () => {
  const server = new Server("abc");
  const p = server.page();
  p.field.join();
  p.el.type(3, 3, "d");
  p.deliver();
  for (let i = 0; i < 3; i++) p.deliver();
  assert.equal(server.text, "abcd");
  assert.equal(p.el.value, "abcd");
  assert.deepEqual(p.el.states().slice(-1), ["saved"]);
});

test("a read-only join makes the field read only and drops what was typed", () => {
  const server = new Server("abc");
  server.writable = false;
  const p = server.page();
  p.field.join();
  p.el.type(0, 0, "x");
  p.deliver();
  assert.equal(p.el.readOnly, true);
  assert.equal(p.el.value, "abc");
  assert.equal(server.text, "abc");
});

test("a gap in revisions rejoins from the server's text", () => {
  const server = new Server("abc");
  const p = server.page();
  p.field.join();
  p.deliver();
  server.text = "abcXY";
  server.rev = 2;
  p.field.receive({ t: "text", doc: "s.doc", rev: 2, edit: [{ i: 4, s: "Y" }] });
  p.deliver();
  assert.equal(p.el.value, "abcXY");
});

test("carets are sent only when the field is synced", () => {
  const sent: TextMessage[] = [];
  const el = new FakeEl("abc", { [SHARED_ATTR]: "s.doc", [SHARED_REV_ATTR]: "0" });
  const field = new SharedField(el, { send: (m) => sent.push(m), setTimeout: () => 1, clearTimeout: () => {} });
  field.join();
  field.receive({ t: "text", doc: "s.doc", rev: 0, text: "abc", writable: true });
  assert.ok(sent.some((m) => m.sel), "a caret after joining");
  sent.length = 0;
  el.type(0, 0, "x");
  assert.ok(sent.some((m) => m.edit) && !sent.some((m) => m.sel), "no caret while an edit is in flight");
  field.stop();
});
