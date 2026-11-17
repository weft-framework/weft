import { test } from "node:test";
import assert from "node:assert/strict";
import { canSee, changes, onRead, useDatabase, type Change, type Model } from "@weft-framework/data";
import { openSqlite } from "@weft-framework/data/sqlite";
import { AccessError } from "../src/errors.ts";
import { defineChat } from "../src/chat.ts";

const code = (fn: () => unknown, c: string) =>
  assert.throws(fn, (e: unknown) => e instanceof AccessError && e.code === c, `expected ${c}`);

function setup(driver: "memory" | "sqlite") {
  let clock = 1_000_000;
  const blocked = new Set(["eve->ada"]);
  const chat = defineChat({
    prefix: driver === "sqlite" ? "S" : "",
    allow: (from, to) => !blocked.has(`${from}->${to}`) && !blocked.has(`${to}->${from}`),
    editMinutes: 5,
    typingMs: 2000,
    now: () => clock,
  });
  if (driver === "sqlite") useDatabase(openSqlite(":memory:"), Object.values(chat.models) as Model<never>[]);
  return { chat, tick: (ms: number) => (clock += ms) };
}

for (const driver of ["memory", "sqlite"] as const) {
  test(`${driver}: direct conversations, unread counts, receipts`, () => {
    const { chat, tick } = setup(driver);
    const id = chat.startDirect("ada", "bo");
    assert.equal(chat.startDirect("bo", "ada"), id, "one direct conversation per pair");
    code(() => chat.startDirect("eve", "ada"), "forbidden");
    code(() => chat.startDirect("ada", "ada"), "invalid");

    const m1 = chat.send("ada", id, "  Hi Bo\u0007  ");
    tick(1000);
    chat.send("ada", id, "Lunch?");
    assert.equal(m1.body, "Hi Bo", "trimmed, control characters removed");
    assert.equal(m1.seq, 1);
    const bo = chat.inbox("bo");
    assert.equal(bo.length, 1);
    assert.deepEqual([bo[0]!.unread, bo[0]!.last!.body, bo[0]!.members], [2, "Lunch?", ["ada", "bo"]]);
    assert.equal(chat.inbox("ada")[0]!.unread, 0, "your own messages are read");
    assert.equal(chat.unreadTotal("bo"), 2);
    assert.deepEqual(chat.readBy("ada", id), [{ user: "bo", lastRead: 0 }]);
    chat.markRead("bo", id, 1);
    assert.equal(chat.unreadTotal("bo"), 1);
    chat.markRead("bo", id, 0);
    assert.equal(chat.unreadTotal("bo"), 1, "never moves back");
    chat.markRead("bo", id, 99);
    assert.deepEqual(chat.readBy("ada", id), [{ user: "bo", lastRead: 2 }], "capped at the newest");
    const reply = chat.send("bo", id, "Sure");
    assert.deepEqual(chat.messages("ada", id).map((m) => [m.seq, m.author, m.body, m.mine]), [
      [1, "ada", "Hi Bo", true],
      [2, "ada", "Lunch?", true],
      [3, "bo", "Sure", false],
    ]);
    assert.deepEqual(chat.messages("ada", id, { before: 3, limit: 1 }).map((m) => m.seq), [2]);
    assert.equal(chat.inbox("ada")[0]!.last!.id, reply.id);

    code(() => chat.messages("eve", id), "not-found");
    code(() => chat.send("eve", id, "hi"), "not-found");
    code(() => chat.conversation("eve", id), "not-found");
    code(() => chat.edit("eve", reply.id, "x"), "not-found");
    code(() => chat.messages("ada", "c_" + "0".repeat(32)), "not-found");
    code(() => chat.messages("ada", "../x"), "not-found");
    assert.deepEqual(chat.inbox("eve"), []);
  });

  test(`${driver}: groups: owner adds, newcomers see only new messages, leaving`, () => {
    const { chat } = setup(driver);
    const g = chat.createGroup("ada", { title: "  Team\nlunch ", members: ["bo", "bo", "ada"] });
    assert.deepEqual(chat.conversation("bo", g).members, ["ada", "bo"]);
    assert.equal(chat.conversation("bo", g).title, "Team lunch");
    code(() => chat.createGroup("eve", { title: "x", members: ["ada"] }), "forbidden");
    const before = chat.send("bo", g, "before cy");
    code(() => chat.addMembers("bo", g, ["cy"]), "forbidden");
    code(() => chat.addMembers("ada", g, ["eve"]), "forbidden");
    chat.addMembers("ada", g, ["cy"]);
    chat.send("ada", g, "welcome cy");
    assert.deepEqual(chat.messages("cy", g).map((m) => m.body), ["welcome cy"], "not what was said before");
    code(() => chat.edit("cy", before.id, "x"), "not-found");
    assert.equal(chat.inbox("cy")[0]!.unread, 1);

    chat.rename("bo", g, "Lunch crew");
    code(() => chat.rename("bo", g, "   "), "invalid");
    chat.leave("ada", g);
    assert.equal(chat.conversation("bo", g).owner, "bo", "ownership passes on");
    code(() => chat.messages("ada", g), "not-found");
    assert.deepEqual(chat.conversation("cy", g).members, ["bo", "cy"]);
    chat.addMembers("bo", g, ["ada"]);
    assert.deepEqual(chat.messages("ada", g), [], "rejoining starts fresh");
  });

  test(`${driver}: edits, deletes, typing, forget`, async () => {
    const { chat, tick } = setup(driver);
    const id = chat.startDirect("ada", "bo");
    const m = chat.send("ada", id, "helo");
    code(() => chat.edit("bo", m.id, "hello"), "forbidden");
    assert.equal(chat.edit("ada", m.id, "hello").body, "hello");
    tick(6 * 60_000);
    code(() => chat.edit("ada", m.id, "late"), "forbidden");
    code(() => chat.delete("bo", m.id), "forbidden");
    chat.delete("ada", m.id);
    const gone = chat.messages("bo", id)[0]!;
    assert.deepEqual([gone.deleted, gone.body], [true, ""]);
    code(() => chat.send("ada", id, "   "), "invalid");
    code(() => chat.send("ada", id, "x".repeat(4001)), "invalid");

    chat.typing("ada", id);
    assert.deepEqual(chat.typingIn("bo", id), ["ada"]);
    assert.deepEqual(chat.typingIn("ada", id), [], "not yourself");
    tick(2001);
    assert.deepEqual(chat.typingIn("bo", id), [], "expired");
    chat.typing("ada", id);
    chat.send("ada", id, "done typing");
    assert.deepEqual(chat.typingIn("bo", id), [], "sending ends typing");
    chat.close();

    assert.equal(chat.forget("ada"), 1);
    assert.deepEqual(chat.messages("bo", id).map((x) => [x.author, x.body]), [["ada", ""], ["ada", ""]]);
    assert.deepEqual(chat.inbox("ada"), []);
  });
}

test("the models are closed to application code", () => {
  const { chat } = setup("memory");
  const id = chat.startDirect("ada", "bo");
  chat.send("ada", id, "secret");
  for (const actor of [{ id: "ada" }, { id: "x", all: true }, { conversation: id }, null]) {
    assert.deepEqual(chat.models.Message.as(actor as never).all(), []);
    assert.deepEqual(chat.models.Conversation.as(actor as never).all(), []);
    assert.deepEqual(chat.models.ConversationMember.as(actor as never).all(), []);
  }
  assert.throws(() => defineChat({} as never), /allow/);
});

test("a page that read the inbox sees the changes that concern it (sync)", () => {
  const { chat } = setup("memory");
  const id = chat.startDirect("ada", "bo");
  const other = chat.startDirect("cy", "dee");
  const reads: [Model<unknown>, unknown][] = [];
  const stop = onRead((model, actor) => void reads.push([model, actor]));
  chat.inbox("bo");
  chat.typingIn("bo", id);
  stop();
  const seen: Change[] = [];
  const unsub = changes.subscribe((c) => void seen.push(c));
  chat.send("ada", id, "for bo");
  chat.typing("ada", id);
  chat.send("cy", other, "not for bo");
  unsub();
  chat.close();
  const affects = (c: Change) => reads.some(([m, a]) => m.name === c.model && canSee(m, a as never, c));
  const mine = seen.filter(affects);
  assert.ok(mine.some((c) => c.model === "Conversation" && c.key === id), "a new message re-renders bo's inbox");
  assert.ok(mine.some((c) => c.model === "ConversationMember" && (c.after as { typingUntil: number }).typingUntil > 0), "typing does too");
  assert.ok(!mine.some((c) => (c.after as { conversation?: string; id: string }).conversation === other || (c.after as { id: string }).id === other), "others' conversations do not");
});
