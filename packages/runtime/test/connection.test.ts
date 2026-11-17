import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointsFor, LiveConnection, type Status } from "../src/connection.ts";
import type { ClientMessage, ServerMessage } from "../src/protocol.ts";

class FakeWs {
  static all: FakeWs[] = [];
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWs.all.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

class FakeEs {
  static all: FakeEs[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEs.all.push(this);
  }
  close(): void {}
}

function harness(extra: Partial<ConstructorParameters<typeof LiveConnection>[0]> = {}) {
  FakeWs.all = [];
  FakeEs.all = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const received: ServerMessage[] = [];
  const statuses: Status[] = [];
  const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
  const conn = new LiveConnection({
    wsUrl: "ws://h/_weft/live",
    sseUrl: "/_weft/live/sse",
    postUrl: "/_weft/live/event",
    onMessage: (m) => received.push(m),
    onStatus: (s) => statuses.push(s),
    WebSocket: FakeWs,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    random: () => 0.5,
    fetch: async (url, init) => {
      posts.push({ url, body: init.body, headers: init.headers });
      return { ok: true, status: 204 };
    },
    ...extra,
  });
  return { conn, timers, received, statuses, posts };
}

const ev = (seq: number): ClientMessage => ({
  t: "event",
  id: "c1",
  handler: "go",
  event: { type: "click" },
  seq,
});

test("messages queue until open, then flush in order", () => {
  const { conn } = harness();
  conn.start();
  conn.send(ev(1));
  conn.send(ev(2));
  const ws = FakeWs.all[0];
  assert.equal(ws.sent.length, 0);
  ws.onopen!();
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s).seq), [1, 2]);
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s).queued), [true, true], "events that waited say so");
  conn.send(ev(3));
  assert.equal(JSON.parse(ws.sent[2]).seq, 3);
  assert.equal(JSON.parse(ws.sent[2]).queued, undefined);
});

test("incoming messages are decoded; garbage is dropped", () => {
  const { conn, received } = harness();
  conn.start();
  const ws = FakeWs.all[0];
  ws.onopen!();
  ws.onmessage!({ data: '{"t":"patch","id":"c1","html":"<p>1</p>"}' });
  ws.onmessage!({ data: "{broken" });
  ws.onmessage!({ data: '{"t":"redirect","to":"//evil"}' });
  assert.deepEqual(received, [{ t: "patch", id: "c1", html: "<p>1</p>" }]);
});

test("a dropped socket reconnects with growing, jittered backoff", () => {
  const { conn, timers, statuses } = harness({ baseDelayMs: 100 });
  conn.start();
  FakeWs.all[0].onopen!();
  FakeWs.all[0].onclose!();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 75);
  timers[0].fn();
  assert.equal(FakeWs.all.length, 2);
  FakeWs.all[1].onclose!();
  assert.equal(timers[1].ms, 150);
  assert.ok(statuses.includes("reconnecting"));
});

test("backoff resets after a successful open", () => {
  const { conn, timers } = harness({ baseDelayMs: 100 });
  conn.start();
  FakeWs.all[0].onclose!();
  timers[0].fn();
  FakeWs.all[1].onopen!();
  FakeWs.all[1].onclose!();
  assert.equal(timers[1].ms, 75);
});

test("falls back to SSE + POST after repeated WebSocket failures", async () => {
  const { conn, timers, posts, received } = harness({ EventSource: FakeEs, maxWsFailures: 2 });
  conn.start();
  FakeWs.all[0].onclose!();
  timers[0].fn();
  FakeWs.all[1].onclose!();
  timers[1].fn();
  assert.equal(FakeWs.all.length, 2, "no third socket");
  assert.equal(FakeEs.all.length, 1);
  assert.equal(conn.transport, "sse");

  conn.send(ev(1));
  const es = FakeEs.all[0];
  es.onopen!();
  assert.equal(posts.length, 0, "upstream waits for the session id");
  es.onmessage!({ data: '{"t":"hello","session":"s-42"}' });
  await Promise.resolve();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/_weft/live/event");
  assert.equal(posts[0].headers["x-weft-session"], "s-42");
  assert.equal(JSON.parse(posts[0].body).seq, 1);
  assert.deepEqual(received, [{ t: "hello", session: "s-42" }]);
});

test("extra headers (CSRF) ride on upstream POSTs", async () => {
  const { conn, posts } = harness({
    WebSocket: undefined,
    EventSource: FakeEs,
    headers: () => ({ "x-csrf-token": "t0k" }),
  });
  conn.start();
  const es = FakeEs.all[0];
  es.onopen!();
  es.onmessage!({ data: '{"t":"hello","session":"s"}' });
  conn.send(ev(1));
  await Promise.resolve();
  assert.equal(posts[0].headers["x-csrf-token"], "t0k");
});

test("close stops reconnecting", () => {
  const { conn, timers, statuses } = harness();
  conn.start();
  conn.close();
  FakeWs.all[0].onclose?.();
  assert.equal(timers.length, 0);
  assert.equal(statuses.at(-1), "closed");
});

test("an expired page stops the connection and is reported once", () => {
  const { conn, timers, received, statuses } = harness();
  conn.start();
  const ws = FakeWs.all[0];
  ws.onopen!();
  ws.onmessage!({ data: '{"t":"hello","session":"s"}' });
  ws.onmessage!({ data: '{"t":"expired"}' });
  ws.onclose?.();
  conn.send(ev(1));
  assert.deepEqual(received, [{ t: "hello", session: "s" }, { t: "expired" }]);
  assert.equal(ws.closed, true);
  assert.equal(timers.length, 0, "no reconnect");
  assert.equal(statuses.at(-1), "closed");
  assert.equal(ws.sent.length, 0, "nothing sent after expiry");
});

test("an SSE stream the server refused counts as expired", () => {
  const { conn, timers, received } = harness({ WebSocket: undefined, EventSource: FakeEs });
  conn.start();
  const es = FakeEs.all[0] as FakeEs & { readyState?: number };
  es.onerror!();
  assert.deepEqual(received, []);
  es.readyState = 2;
  es.onerror!();
  es.onerror!();
  assert.deepEqual(received, [], "not at once: a page being left cuts its stream too");
  assert.equal(timers.length, 1, "one wait, however many errors");
  timers[0].fn();
  assert.deepEqual(received, [{ t: "expired" }]);
});

test("an SSE stream cut while the page is left does not expire it", () => {
  const { conn, timers, received } = harness({ WebSocket: undefined, EventSource: FakeEs });
  conn.start();
  const es = FakeEs.all[0] as FakeEs & { readyState?: number };
  es.readyState = 2;
  es.onerror!();
  conn.suspend();
  timers[0].fn();
  assert.deepEqual(received, []);
});

test("a suspended connection lets its transport go and resumes on demand", () => {
  const { conn, timers, received, statuses } = harness({ WebSocket: undefined, EventSource: FakeEs });
  conn.start();
  const first = FakeEs.all[0];
  first.onopen!();
  first.onmessage!({ data: '{"t":"hello","session":"s1"}' });
  let closed = 0;
  first.close = () => {
    closed += 1;
  };

  conn.suspend();
  assert.equal(closed, 1, "the stream is released");
  assert.equal(statuses.at(-1), "suspended");
  first.onmessage!({ data: '{"t":"patch","id":"c1","html":"x"}' });
  first.onerror!();
  assert.equal(received.length, 1);
  assert.equal(timers.length, 0, "no reconnect while suspended");

  conn.resume();
  assert.equal(FakeEs.all.length, 2);
  assert.equal(statuses.at(-1), "connecting");
});

test("sending while suspended resumes, and the message waits for the new session", async () => {
  const { conn, posts } = harness({ WebSocket: undefined, EventSource: FakeEs });
  conn.start();
  FakeEs.all[0].onopen!();
  FakeEs.all[0].onmessage!({ data: '{"t":"hello","session":"old"}' });
  conn.suspend();
  conn.send(ev(1));
  assert.equal(FakeEs.all.length, 2, "reconnected");
  const es = FakeEs.all[1];
  es.onopen!();
  await Promise.resolve();
  assert.equal(posts.length, 0, "not sent on the old session");
  es.onmessage!({ data: '{"t":"hello","session":"new"}' });
  await Promise.resolve();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers["x-weft-session"], "new");
});

test("endpoints follow the page scheme", () => {
  assert.deepEqual(endpointsFor({ protocol: "https:", host: "app.test" }), {
    wsUrl: "wss://app.test/_weft/live",
    sseUrl: "/_weft/live/sse",
    postUrl: "/_weft/live/event",
  });
  assert.equal(endpointsFor({ protocol: "http:", host: "h:3000" }).wsUrl, "ws://h:3000/_weft/live");
});

test("the live page id is carried on the downstream URLs", () => {
  assert.deepEqual(endpointsFor({ protocol: "http:", host: "h" }, { lid: "a b" }), {
    wsUrl: "ws://h/_weft/live?lid=a%20b",
    sseUrl: "/_weft/live/sse?lid=a%20b",
    postUrl: "/_weft/live/event",
  });
});

test("offline: the transport goes, events only queue, and online sends them in order", () => {
  const { conn, statuses } = harness();
  conn.start();
  FakeWs.all[0].onopen!();
  conn.offline();
  assert.equal(statuses.at(-1), "offline");
  conn.send(ev(1));
  conn.send(ev(2));
  conn.resume();
  assert.equal(FakeWs.all.length, 1, "no new socket while offline");
  conn.online();
  const ws = FakeWs.all[1];
  ws.onopen!();
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s)).map((m) => [m.seq, m.queued]), [[1, true], [2, true]]);
});

test("an upstream POST the network failed waits for the next stream, in order", async () => {
  let fail = true;
  const { conn, posts } = harness({
    WebSocket: undefined,
    EventSource: FakeEs,
    fetch: async (url, init) => {
      if (fail) throw new Error("network");
      posts.push({ url, body: init.body, headers: init.headers });
      return { ok: true, status: 204 };
    },
  });
  conn.start();
  const es = FakeEs.all[0];
  es.onopen!();
  es.onmessage!({ data: JSON.stringify({ t: "hello", session: "s1" }) });
  conn.send(ev(1));
  conn.send(ev(2));
  await new Promise((r) => setTimeout(r, 0));
  fail = false;
  es.onmessage!({ data: JSON.stringify({ t: "hello", session: "s2" }) });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(posts.map((p) => JSON.parse(p.body)).map((m) => [m.seq, m.queued]), [[1, true], [2, true]]);
});
