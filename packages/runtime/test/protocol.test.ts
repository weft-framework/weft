import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeClientMessage,
  decodeServerMessage,
  encode,
  isSafePath,
  LIMITS,
} from "../src/protocol.ts";

const good = {
  t: "event",
  id: "c1",
  handler: "increment",
  event: { type: "click" },
  seq: 1,
};

test("a well-formed event round-trips", () => {
  const msg = decodeClientMessage(JSON.stringify(good));
  assert.deepEqual(msg, good);
});

test("form fields decode into a null-prototype record", () => {
  const raw = JSON.stringify({
    ...good,
    event: { type: "submit", form: { title: "x", ["__proto__"]: "y" } },
  });
  const msg = decodeClientMessage(raw);
  assert.ok(msg?.event.form);
  assert.equal(Object.getPrototypeOf(msg.event.form), null);
  assert.equal(msg.event.form.title, "x");
  assert.equal(({} as Record<string, unknown>).y, undefined, "no prototype pollution");
});

test("malformed or hostile client messages are rejected", () => {
  const cases: unknown[] = [
    "not json",
    "[]",
    { ...good, t: "patch" },
    { ...good, id: "a b" },
    { ...good, id: "<script>" },
    { ...good, handler: "constructor()" },
    { ...good, handler: "x".repeat(LIMITS.name + 1) },
    { ...good, seq: -1 },
    { ...good, seq: 1.5 },
    { ...good, event: { type: "" } },
    { ...good, event: { type: "click", value: 5 } },
    { ...good, event: { type: "click", checked: "yes" } },
    { ...good, event: { type: "submit", form: { a: 1 } } },
    { ...good, event: { type: "submit", form: [] } },
  ];
  for (const c of cases) {
    const raw = typeof c === "string" ? c : JSON.stringify(c);
    assert.equal(decodeClientMessage(raw), null, `accepted: ${raw}`);
  }
});

test("size limits are enforced", () => {
  const big = { ...good, event: { type: "input", value: "x".repeat(LIMITS.value + 1) } };
  assert.equal(decodeClientMessage(JSON.stringify(big)), null);

  const form: Record<string, string> = {};
  for (let i = 0; i <= LIMITS.formFields; i += 1) form[`f${i}`] = "";
  assert.equal(decodeClientMessage(JSON.stringify({ ...good, event: { type: "submit", form } })), null);

  assert.equal(decodeClientMessage(" ".repeat(LIMITS.message + 1)), null);
});

test("server messages decode, and redirects stay same-origin", () => {
  assert.deepEqual(decodeServerMessage(encode({ t: "patch", id: "c1", html: "<p>x</p>", ack: 3 })), {
    t: "patch",
    id: "c1",
    html: "<p>x</p>",
    ack: 3,
  });
  assert.deepEqual(decodeServerMessage('{"t":"hello","session":"s1"}'), { t: "hello", session: "s1" });
  assert.deepEqual(decodeServerMessage('{"t":"redirect","to":"/done"}'), { t: "redirect", to: "/done" });
  for (const to of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)", "done"]) {
    assert.equal(isSafePath(to), false, to);
    assert.equal(decodeServerMessage(JSON.stringify({ t: "redirect", to })), null, to);
  }
  assert.equal(decodeServerMessage('{"t":"patch","id":"c1"}'), null);
  assert.equal(decodeServerMessage('{"t":"error","message":"x","ack":-2}'), null);
  assert.deepEqual(decodeServerMessage('{"t":"ack","ack":4}'), { t: "ack", ack: 4 });
  assert.equal(decodeServerMessage('{"t":"ack"}'), null);
  assert.deepEqual(decodeServerMessage('{"t":"expired"}'), { t: "expired" });
  assert.deepEqual(decodeServerMessage('{"t":"hello","session":"s","p":2}'), { t: "hello", session: "s", p: 2 });
  assert.equal(decodeServerMessage('{"t":"hello","session":"s","p":"2"}'), null);
  assert.deepEqual(decodeServerMessage('{"t":"expired","handoff":"Ab-_9"}'), { t: "expired", handoff: "Ab-_9" });
  for (const bad of ['"a b"', '""', "7", JSON.stringify("x".repeat(6145))]) {
    assert.deepEqual(decodeServerMessage(`{"t":"expired","handoff":${bad}}`), { t: "expired" });
  }
});

test("argument tokens are short decimal strings or absent", () => {
  const base = { t: "event", id: "c1", handler: "go", event: { type: "click" }, seq: 1 };
  assert.equal(decodeClientMessage(JSON.stringify({ ...base, args: "12" }))?.args, "12");
  assert.equal(decodeClientMessage(JSON.stringify(base))?.args, undefined);
  for (const bad of ["", "x", "1e3", "1234567890", 3, ["1"]]) {
    assert.equal(decodeClientMessage(JSON.stringify({ ...base, args: bad })), null, String(bad));
  }
});

test("handler names may use any ECMAScript identifier characters", () => {
  const ev = (handler: string) =>
    decodeClientMessage(JSON.stringify({ t: "event", id: "r.1", handler, event: { type: "click" }, seq: 1 }));
  for (const ok of ["přidej", "名前", "$x", "_a1", "café"]) {
    assert.ok(ev(ok), ok);
  }
  for (const bad of ["1a", "a b", "a<b", "a\"", "a;b", "a/b", ""]) {
    assert.equal(ev(bad), null, bad);
  }
});

test("offline fields: base, queued, patch v and conflict decode strictly", () => {
  const ev = { t: "event", id: "r", handler: "h", event: { type: "click" }, seq: 1 };
  assert.deepEqual(decodeClientMessage(JSON.stringify({ ...ev, base: 2, queued: true })), { ...ev, base: 2, queued: true });
  assert.equal(decodeClientMessage(JSON.stringify({ ...ev, base: -1 })), null);
  assert.equal(decodeClientMessage(JSON.stringify({ ...ev, queued: false })), null);
  const flags = decodeClientMessage(JSON.stringify({ ...ev, event: { type: "click", stale: true, queued: true } }));
  assert.deepEqual(flags && flags.t === "event" && flags.event, { type: "click" }, "server-only flags are dropped");
  assert.deepEqual(decodeServerMessage(JSON.stringify({ t: "patch", id: "r", html: "", v: 4 })), { t: "patch", id: "r", html: "", v: 4 });
  assert.equal(decodeServerMessage(JSON.stringify({ t: "patch", id: "r", html: "", v: 1.5 })), null);
  assert.deepEqual(decodeServerMessage(JSON.stringify({ t: "conflict", ack: 2, reason: "stale" })), { t: "conflict", ack: 2, reason: "stale" });
  assert.equal(decodeServerMessage(JSON.stringify({ t: "conflict", ack: 2, reason: "other" })), null);
});
