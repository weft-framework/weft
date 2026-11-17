import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel } from "@weft/data";
import { sharedAttrs, type ServerMessage } from "@weft/runtime";
import { resetShared, sharedChange, sharedLeave, sharedMessage } from "../src/shared.ts";

type Text = Extract<ServerMessage, { t: "text" }>;
type Note = { id: string; owner: string; body: string; secret: string | null };

let n = 0;
function notes() {
  const Notes = defineModel<Note>(`SharedNote${++n}${Math.random().toString(36).slice(2, 6)}`, {
    fields: { id: "string", owner: "string", body: "string", secret: "string | null" },
    attrs: { secret: { read: (actor: { id?: string } | null, row: Note) => actor?.id === row.owner } },
    read: (actor: { id?: string; staff?: boolean } | null, row: Note) => actor?.id === row.owner || actor?.staff === true,
    write: (actor: { id?: string } | null, row: Note) => actor?.id === row.owner,
  } as never);
  Notes.driver.insert({ id: "n1", owner: "ada", body: "hello", secret: "s" });
  return Notes;
}

function docOf(row: unknown, field: string): string {
  const m = /data-weft-shared="([^"]+)"/.exec(sharedAttrs(row, field));
  assert.ok(m, `rendered as shared: ${sharedAttrs(row, field)}`);
  return m[1]!;
}

function page(actor: unknown) {
  const entry = {};
  const inbox: Text[] = [];
  const opts = { saveMs: 50, onError: (e: unknown) => assert.fail(String(e)), label: (a: unknown) => (a as { id?: string })?.id === "ada" ? "Ada" : null };
  return {
    entry,
    inbox,
    say: (msg: Omit<Extract<import("@weft/runtime").ClientMessage, { t: "text" }>, "t">) =>
      sharedMessage(entry, actor, { t: "text", ...msg } as never, (m) => inbox.push(m as Text), opts),
    last: () => inbox[inbox.length - 1]!,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("two pages converge and the text is saved through the model", async () => {
  resetShared();
  const Notes = notes();
  const doc = docOf(Notes.as({ id: "ada" }).get("n1"), "body");
  const a = page({ id: "ada" });
  const b = page({ id: "ada" });
  a.say({ doc, rev: 0, join: true });
  b.say({ doc, rev: 0, join: true });
  assert.deepEqual([a.last().text, a.last().writable], ["hello", true]);
  a.say({ doc, rev: 0, edit: [{ i: 5, s: "!" }] });
  b.say({ doc, rev: 0, edit: [{ i: 0, s: ">" }] });
  assert.ok(a.inbox.some((m) => m.mine && m.rev === 1));
  assert.deepEqual(a.inbox.find((m) => m.rev === 2 && m.edit)?.edit, [{ i: 0, s: ">" }]);
  assert.deepEqual(b.inbox.find((m) => m.rev === 1 && m.edit)?.edit, [{ i: 5, s: "!" }]);
  await wait(120);
  assert.equal(Notes.driver.select([], "n1")[0]!.body, ">hello!");
  assert.match(sharedAttrs(Notes.as({ id: "ada" }).get("n1"), "body"), /data-weft-shared-rev="2"/);
  sharedLeave(a.entry);
  sharedLeave(b.entry);
});

test("the write rule is asked of every edit; a reader cannot change the text", async () => {
  resetShared();
  const Notes = notes();
  const doc = docOf(Notes.as({ id: "ada" }).get("n1"), "body");
  const staff = page({ id: "sam", staff: true });
  staff.say({ doc, rev: 0, join: true });
  assert.equal(staff.last().writable, false);
  staff.say({ doc, rev: 0, edit: [{ i: 0, s: "x" }] });
  assert.equal(staff.last().refused, "You may not change this field.");
  await wait(80);
  assert.equal(Notes.driver.select([], "n1")[0]!.body, "hello");
  const eve = page({ id: "eve" });
  eve.say({ doc, rev: 0, join: true });
  assert.deepEqual([eve.last().text, eve.last().refused], ["", "You cannot read this field."]);
  sharedLeave(staff.entry);
  sharedLeave(eve.entry);
});

test("a field hidden by its read rule cannot be joined", () => {
  resetShared();
  const Notes = notes();
  const doc = docOf(Notes.as({ id: "ada" }).get("n1"), "secret");
  const staff = page({ id: "sam", staff: true });
  staff.say({ doc, rev: 0, join: true });
  assert.deepEqual([staff.last().text, staff.last().refused], ["", "You cannot read this field."]);
  const ada = page({ id: "ada" });
  ada.say({ doc: "s.bogus", rev: 0, join: true });
  assert.equal(ada.inbox.length, 0);
});

test("a write from elsewhere is merged; the last page leaving saves", () => {
  resetShared();
  const Notes = notes();
  const doc = docOf(Notes.as({ id: "ada" }).get("n1"), "body");
  const a = page({ id: "ada" });
  a.say({ doc, rev: 0, join: true });
  a.say({ doc, rev: 0, edit: [{ i: 5, s: " world" }] });
  Notes.driver.update("n1", { id: "n1", owner: "ada", body: "Hello", secret: "s" } as never);
  sharedChange({ model: Notes.name, op: "update", key: "n1", after: { body: "Hello" } } as never);
  const merged = a.inbox.find((m) => m.rev === 2 && m.edit);
  assert.ok(merged, "the form's change reaches the page");
  sharedLeave(a.entry);
  assert.equal(Notes.driver.select([], "n1")[0]!.body, "Hello world");
});

test("a deleted row ends the field", () => {
  resetShared();
  const Notes = notes();
  const doc = docOf(Notes.as({ id: "ada" }).get("n1"), "body");
  const a = page({ id: "ada" });
  a.say({ doc, rev: 0, join: true });
  Notes.driver.delete("n1");
  sharedChange({ model: Notes.name, op: "delete", key: "n1" } as never);
  assert.deepEqual([a.last().refused, a.last().writable], ["This row is gone.", false]);
});
