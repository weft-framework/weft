import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeFeed, defineModel } from "@weft-framework/data";
import { decodeServerMessage, defineComponent, escapeHtml } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";
import { checkNotice, NoticeError, notifyReaders } from "../src/notice.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

interface Doc {
  id: string;
  owner: string;
  shared: boolean;
}

function setup() {
  const feed = new ChangeFeed();
  const Docs = defineModel<Doc>("NoticeDoc", {
    fields: { id: "string", owner: "string", shared: "boolean" },
    read: (a, r) => r.shared || (a as { id: string }).id === r.owner,
    write: (a, r) => (a as { id: string }).id === r.owner,
  }).publishTo(feed);
  Docs.as({ id: "ann" }).create({ id: "d1", owner: "ann", shared: false });

  const List = defineComponent("NoticeList", (props: { user: string; docs: Doc[] }) => ({
    handlers: {
      ping() {
        const row = Docs.as({ id: props.user }).get("d1")!;
        notifyReaders(Docs, row, { text: `${props.user} looked`, kind: "seen" });
      },
    },
    render: () => `<ul>${props.docs.map((d) => `<li>${escapeHtml(d.id)}</li>`).join("")}</ul>`,
  }));
  const app = createApp({
    secret: SECRET,
    sync: feed,
    syncDelayMs: 0,
    onError: (e) => {
      throw e;
    },
    routes: {
      "/": {
        component: List as never,
        load: (ctx) => {
          const user = ctx.query.get("as") ?? "anon";
          return { user, docs: Docs.as({ id: user }).all() };
        },
      },
      "/all": {
        component: List as never,
        load: () => ({ user: "op", docs: Docs.publicUnscoped() }),
      },
    },
  });
  return { app, Docs };
}

type App = ReturnType<typeof createApp>;

async function open(app: App, path: string) {
  const res = (await app.fetch(new Request(ORIGIN + path)))!;
  const html = await res.text();
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)![1]!;
  const id = /data-weft-c="([^"]+)"/.exec(html)![1]!;
  const sse = (await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } })))!;
  const reader = sse.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const next = async (ms = 300): Promise<Record<string, unknown> | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const m = /data: (.*)\n\n/.exec(buf);
      if (m) {
        buf = buf.slice(m.index + m[0].length);
        return JSON.parse(m[1]!) as Record<string, unknown>;
      }
      pending ??= reader.read();
      const got = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now())))]);
      if (got === null) return null;
      pending = null;
      buf += dec.decode(got.value);
    }
  };
  const session = String((await next())?.session);
  const event = async (handler: string, seq: number) => {
    const r = (await app.fetch(
      new Request(`${ORIGIN}/_weft/live/event`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": session },
        body: JSON.stringify({ t: "event", id, handler, event: { type: "click" }, seq }),
      }),
    ))!;
    await r.arrayBuffer();
  };
  return { next, event, close: () => reader.cancel() };
}

test("a notice reaches only pages whose read rule admits the row", async () => {
  const { app, Docs } = setup();
  const ann = await open(app, "/?as=ann");
  const bob = await open(app, "/?as=bob");
  const all = await open(app, "/all");
  const row = Docs.as({ id: "ann" }).get("d1")!;

  assert.equal(notifyReaders(Docs, row, { text: "Review requested", kind: "task.review", data: { id: "d1" } }), 1);
  const got = await ann.next();
  assert.deepEqual(got, { t: "notice", text: "Review requested", kind: "task.review", data: { id: "d1" } });
  assert.deepEqual(decodeServerMessage(JSON.stringify(got)), got, "the browser accepts it");
  assert.equal(await bob.next(150), null, "bob cannot read the row");
  assert.equal(await all.next(150), null, "an unscoped read says nothing about who is looking");

  Docs.as({ id: "ann" }).update((d) => d.id === "d1", { shared: true });
  await ann.next();
  await bob.next();
  await all.next();
  const shared = Docs.as({ id: "ann" }).get("d1")!;
  assert.equal(notifyReaders(Docs, shared, { text: "Shared" }), 2);
  assert.deepEqual(await ann.next(), { t: "notice", text: "Shared", kind: "info" });
  assert.deepEqual(await bob.next(), { t: "notice", text: "Shared", kind: "info" });

  await bob.event("ping", 1);
  assert.deepEqual(await ann.next(), { t: "notice", text: "bob looked", kind: "seen" });
  assert.equal((await bob.next())?.t, "ack");
  assert.equal(await bob.next(150), null, "the writer is not told about their own action");

  await ann.close();
  await bob.close();
  await all.close();
  app.close();
  assert.equal(notifyReaders(Docs, shared, { text: "after close" }), 0, "a closed app is no longer told");
});

test("notices are checked", () => {
  assert.deepEqual(checkNotice({ text: "Hi" }), { text: "Hi", kind: "info" });
  assert.deepEqual(checkNotice({ text: "Hi", data: { a: [1, "x"] } }), { text: "Hi", kind: "info", data: { a: [1, "x"] } });
  for (const bad of [
    { text: "" },
    { text: "   " },
    { text: "two\nlines" },
    { text: "x".repeat(501) },
    { text: "Hi", kind: "Bad Kind" },
    { text: "Hi", kind: "x".repeat(33) },
    { text: "Hi", data: { big: "x".repeat(5000) } },
    { text: "Hi", data: () => 1 },
    { text: "Hi", data: 10n },
    { text: 5 as unknown as string },
  ]) {
    assert.throws(() => checkNotice(bad), NoticeError, JSON.stringify(bad, (_k, v) => (typeof v === "bigint" ? "big" : v)));
  }
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  assert.throws(() => checkNotice({ text: "Hi", data: cyc }), NoticeError);
  assert.equal(decodeServerMessage(JSON.stringify({ t: "notice", text: "x", kind: "<b>" })), null);
  assert.equal(decodeServerMessage(JSON.stringify({ t: "notice", text: "x".repeat(501), kind: "info" })), null);
});
