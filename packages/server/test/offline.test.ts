import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeFeed, defineModel } from "@weft-framework/data";
import { defineComponent, escapeHtml, type EventPayload } from "@weft-framework/runtime";
import { createApp, type AppOptions } from "../src/app.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

interface Note {
  id: string;
  text: string;
}

function setup(extra: Partial<AppOptions> = {}) {
  const feed = new ChangeFeed();
  const Notes = defineModel<Note>("OfflineNote", {
    fields: { id: "string", text: "string" },
    read: () => true,
    write: () => true,
  }).publishTo(feed);
  const seen: EventPayload[] = [];
  const Page = defineComponent("Page", (props: { notes: Note[] }) => ({
    handlers: {
      add(ev: EventPayload) {
        seen.push(ev);
        Notes.as({}).create({ id: `n${Notes.publicUnscoped().length + 1}`, text: ev.form?.text ?? "" });
      },
    },
    render: () =>
      `<ul>${props.notes.map((n) => `<li>${escapeHtml(n.text)}</li>`).join("")}</ul>` +
      `<form data-weft-on-submit="add"><input name="text"></form>`,
  }));
  const app = createApp({
    secret: SECRET,
    sync: feed,
    syncDelayMs: 0,
    onError: (e) => {
      throw e;
    },
    routes: { "/": { component: Page as never, load: () => ({ notes: Notes.as({}).all() }) } },
    ...extra,
  });
  return { app, Notes, seen };
}

type App = ReturnType<typeof createApp>;

async function open(app: App) {
  const res = await app.fetch(new Request(ORIGIN + "/"));
  const html = await res!.text();
  const cookie = (res!.headers.get("set-cookie") ?? "").split(";")[0];
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "";
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";
  const sse = await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } }));
  const reader = sse!.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const next = async (ms = 500): Promise<Record<string, unknown> | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const m = /data: (.*)\n\n/.exec(buf);
      if (m) {
        buf = buf.slice(m.index + m[0].length);
        return JSON.parse(m[1]);
      }
      pending ??= reader.read();
      const left = deadline - Date.now();
      const got = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, left)))]);
      if (got === null) return null;
      pending = null;
      buf += dec.decode(got.value);
    }
  };
  const hello = await next();
  assert.equal(hello?.t, "hello");
  const headers = { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": String(hello?.session) };
  const send = async (body: Record<string, unknown>) => {
    const r = await app.fetch(
      new Request(`${ORIGIN}/_weft/live/event`, { method: "POST", headers, body: JSON.stringify(body) }),
    );
    return r!.status;
  };
  return { next, send, close: () => reader.cancel() };
}

const add = (seq: number, text: string, more: Record<string, unknown> = {}) => ({
  t: "event",
  id: "r",
  handler: "add",
  event: { type: "submit", form: { text } },
  seq,
  ...more,
});

test("a page's own events keep its version; others' writes move it on", async () => {
  const { app, Notes, seen } = setup();
  const p = await open(app);
  assert.equal(await p.send(add(1, "mine", { base: 0 })), 204);
  const own: Record<string, unknown>[] = [];
  for (let m = await p.next(200); m; m = await p.next(200)) own.push(m);
  assert.ok(own.some((m) => m.t === "patch" && String(m.html).includes("mine")), JSON.stringify(own));
  assert.ok(own.every((m) => m.v === undefined), "its own write is not a new version");
  assert.equal(seen[0].stale, undefined);
  assert.equal(seen[0].queued, undefined);

  Notes.as({}).create({ id: "x", text: "theirs" });
  const theirs = await p.next();
  assert.equal(theirs?.t, "patch");
  assert.equal(theirs?.v, 1, "a refresh for others' data carries the new version");
  assert.ok(String(theirs?.html).includes("theirs"));
  await p.close();
});

test("a queued event made on old data runs, flagged stale and queued", async () => {
  const { app, Notes, seen } = setup();
  const p = await open(app);
  Notes.as({}).create({ id: "x", text: "theirs" });
  assert.equal((await p.next())?.v, 1);
  assert.equal(await p.send(add(1, "late", { base: 0, queued: true })), 204);
  await p.next();
  assert.equal(seen[0].queued, true);
  assert.equal(seen[0].stale, true);
  assert.equal(await p.send(add(2, "fresh", { base: 1, queued: true })), 204);
  await p.next();
  assert.equal(seen[1].queued, true);
  assert.equal(seen[1].stale, undefined);
  await p.close();
});

test("offline.stale: refuse answers a stale queued event with a conflict and does not run it", async () => {
  const { app, Notes, seen } = setup({ offline: { stale: "refuse" } });
  const p = await open(app);
  Notes.as({}).create({ id: "x", text: "theirs" });
  await p.next();
  assert.equal(await p.send(add(1, "late", { base: 0, queued: true })), 204);
  assert.deepEqual(await p.next(), { t: "conflict", ack: 1, reason: "stale" });
  assert.equal(seen.length, 0, "the handler did not run");
  assert.equal(Notes.publicUnscoped().length, 1);
  assert.equal(await p.send(add(2, "online", { base: 0 })), 204);
  await p.next();
  assert.equal(seen[0].stale, true);
  await p.close();
});

test("the browser cannot set the server's flags, and bad offline fields are refused", async () => {
  const { app, seen } = setup();
  const p = await open(app);
  const forged = { ...add(1, "x"), event: { type: "submit", form: { text: "x" }, stale: true, queued: true } };
  assert.equal(await p.send(forged), 204);
  await p.next();
  assert.equal(seen[0].stale, undefined);
  assert.equal(seen[0].queued, undefined);
  assert.equal(await p.send(add(2, "x", { base: -1 })), 400);
  assert.equal(await p.send(add(3, "x", { queued: "yes" })), 400);
  assert.throws(() => setup({ offline: { stale: "drop" as never } }), /offline.stale/);
  await p.close();
});
