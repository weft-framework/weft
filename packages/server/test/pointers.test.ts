import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeClientMessage, type ServerMessage } from "@weft-framework/runtime";
import type { PageContext } from "../src/context.ts";
import { definePresence, presenceBegin, presenceEnd, presenceRelease } from "../src/presence.ts";
import { pointerArea, pointLeave, pointMessage, resetPointers } from "../src/pointers.ts";

type Point = Extract<ServerMessage, { t: "point" }>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

function page(viewers: ReturnType<typeof definePresence<{ name: string; id: string }>>, room: string | null, info: { name: string; id: string }) {
  const ctx = {} as PageContext;
  presenceBegin(ctx);
  if (room) viewers.join(ctx, room, info);
  presenceEnd(ctx);
  const entry = {};
  const inbox: Point[] = [];
  return {
    ctx,
    entry,
    inbox,
    say: (raw: object) => {
      const msg = decodeClientMessage(JSON.stringify({ t: "point", ...raw }));
      assert.ok(msg && msg.t === "point", `decodes: ${JSON.stringify(raw)}`);
      pointMessage(entry, ctx, msg, (m) => inbox.push(m as Point));
    },
    last: () => inbox[inbox.length - 1],
  };
}

test("pages in a room see each other's pointers, labelled, and nobody else does", async () => {
  resetPointers();
  const viewers = definePresence<{ name: string; id: string }>(`ptr${++n}`, { pointers: { label: (i) => i.name } });
  const area = pointerArea(viewers, "doc1")["data-weft-point"]!;
  const ada = page(viewers, "doc1", { name: "Ada", id: "u-ada" });
  const bob = page(viewers, "doc1", { name: "Bob", id: "u-bob" });
  const eve = page(viewers, "doc2", { name: "Eve", id: "u-eve" });
  for (const p of [ada, bob, eve]) p.say({ area, join: true });
  ada.say({ area, at: { on: "row-3", x: 0.25, y: 0.5 } });
  bob.say({ area, sel: { a: 2, h: 9 } });
  await wait(90);
  const toBob = bob.last()!;
  assert.equal(toBob.list.length, 1);
  assert.equal(toBob.list[0]!.label, "Ada");
  assert.deepEqual(toBob.list[0]!.at, { on: "row-3", x: 0.25, y: 0.5 });
  assert.doesNotMatch(JSON.stringify(toBob), /u-ada/, "never the info or the actor");
  assert.deepEqual(ada.last()!.list.map((p) => [p.label, p.sel]), [["Bob", { a: 2, h: 9 }]]);
  assert.equal(eve.inbox.length, 0, "not in the room: told nothing");

  presenceBegin(ada.ctx);
  presenceEnd(ada.ctx);
  await wait(90);
  assert.deepEqual(bob.last()!.list, []);

  viewers.join(ada.ctx, "doc1", { name: "Ada", id: "u-ada" });
  ada.say({ area, join: true });
  presenceRelease(bob.ctx);
  pointLeave(bob.entry);
  await wait(90);
  assert.deepEqual(ada.last()!.list, []);
  pointLeave(ada.entry);
  pointLeave(eve.entry);
});

test("an area token names only its own room, and malformed reports are refused", async () => {
  resetPointers();
  const viewers = definePresence<{ name: string; id: string }>(`ptr${++n}`, { pointers: {} });
  const eve = page(viewers, "mine", { name: "Eve", id: "u-eve" });
  const other = pointerArea(viewers, "secret")["data-weft-point"]!;
  eve.say({ area: other, join: true });
  eve.say({ area: other, at: { x: 0.1, y: 0.1 } });
  await wait(90);
  assert.equal(eve.inbox.length, 0);
  const ada = page(viewers, "secret", { name: "Ada", id: "u-ada" });
  const bob = page(viewers, "secret", { name: "Bob", id: "u-bob" });
  ada.say({ area: other, join: true });
  bob.say({ area: other, at: { x: 1, y: 0 } });
  await wait(90);
  assert.equal(ada.last()!.list[0]!.label, undefined);
  for (const bad of [
    { area: other, at: { x: 2, y: 0 } },
    { area: other, at: { x: 0.5, y: 0.5, on: "a b" } },
    { area: other, sel: { a: -1, h: 3 } },
    { area: other },
    { area: other, join: true, at: null },
    { area: "", join: true },
  ]) {
    assert.equal(decodeClientMessage(JSON.stringify({ t: "point", ...bad })), null, JSON.stringify(bad));
  }
  pointLeave(ada.entry);
  pointLeave(bob.entry);
  pointLeave(eve.entry);
});

test("a presence without pointers has no pointer area", () => {
  const viewers = definePresence(`ptr${++n}`);
  assert.throws(() => pointerArea(viewers, "x"), /does not share pointers/);
});

test("a presenting page's view reaches the room; its id is a hash of its tab, kept across pages", async () => {
  resetPointers();
  const viewers = definePresence<{ name: string; id: string }>(`ptr${++n}`, { pointers: { label: (i) => i.name } });
  const area = pointerArea(viewers, "ws")["data-weft-point"]!;
  const ada = page(viewers, "ws", { name: "Ada", id: "u-ada" });
  const bob = page(viewers, "ws", { name: "Bob", id: "u-bob" });
  const tab = "tab-0123456789abcdef";
  ada.say({ area, join: true, tab });
  bob.say({ area, join: true });
  ada.say({ area, view: { path: "/docs/2?x=1", on: "h-3", y: 0.25 } });
  await wait(90);
  const first = bob.last()!.list[0]!;
  assert.deepEqual(first.view, { path: "/docs/2?x=1", on: "h-3", y: 0.25 });
  assert.ok(!first.id.includes(tab), "the tab id is never shown");
  pointLeave(ada.entry);
  const ada2 = page(viewers, "ws", { name: "Ada", id: "u-ada" });
  ada2.say({ area, join: true, tab });
  ada2.say({ area, view: { path: "/docs/3", y: 0 } });
  await wait(90);
  assert.equal(bob.last()!.list[0]!.id, first.id);
  for (const bad of [
    { area, view: { path: "//evil.example", y: 0 } },
    { area, view: { path: "https://evil.example/", y: 0 } },
    { area, view: { path: "/a\nb", y: 0 } },
    { area, join: true, tab: "short" },
    { area, tab, at: null },
  ]) {
    assert.equal(decodeClientMessage(JSON.stringify({ t: "point", ...bad })), null, JSON.stringify(bad));
  }
  pointLeave(ada2.entry);
  pointLeave(bob.entry);
});
