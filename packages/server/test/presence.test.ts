import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, defineRoom, escapeHtml } from "@weft/runtime";
import { createApp } from "../src/app.ts";
import { definePresence } from "../src/presence.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

function setup() {
  const here = definePresence<{ name: string }>("viewers");
  const Who = defineComponent("Who", (props: { names: string[] }) => ({
    handlers: {},
    render: () => `<p id="v">${escapeHtml(props.names.join(","))}</p>`,
  }));
  const app = createApp({
    secret: SECRET,
    syncDelayMs: 0,
    presenceGraceMs: 40,
    transports: ["sse"],
    onError: (e) => {
      throw e;
    },
    routes: {
      "/doc/[id]": {
        component: Who as never,
        load: (ctx) => {
          const id = ctx.params.id as string;
          here.join(ctx, id, { name: ctx.query.get("as") ?? "anon" });
          return { names: here.in(id).map((i) => i.name) };
        },
      },
    },
    api: {
      "/api/join": { GET: (ctx) => (here.join(ctx, "x", { name: "api" }), Response.json({})) },
    },
  });
  return { app, here };
}

type App = ReturnType<typeof createApp>;

async function open(app: App, path: string) {
  const res = (await app.fetch(new Request(ORIGIN + path)))!;
  const html = await res.text();
  return {
    cookie: (res.headers.get("set-cookie") ?? "").split(";")[0],
    lid: /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "",
    shown: /<p id="v">([^<]*)<\/p>/.exec(html)?.[1],
  };
}

async function stream(app: App, page: { cookie: string; lid: string }) {
  const res = (await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${page.lid}`, { headers: { cookie: page.cookie } })))!;
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
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
      const got = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now())))]);
      if (got === null) return null;
      pending = null;
      if (got.done) return null;
      buf += dec.decode(got.value);
    }
  };
  assert.equal((await next())?.t, "hello");
  const names = async (ms = 500) => {
    const msg = await next(ms);
    if (msg === null) return null;
    assert.equal(msg.t, "patch");
    return /<p id="v">([^<]*)<\/p>/.exec(String(msg.html))?.[1] ?? "";
  };
  return { names, close: () => reader.cancel() };
}

test("presence lists who has a page open, live", async () => {
  const { app, here } = setup();
  const ann = await open(app, "/doc/1?as=ann");
  assert.equal(ann.shown, "ann", "a page sees itself on first render");
  const sa = await stream(app, ann);

  await open(app, "/doc/2?as=cy");
  assert.deepEqual(here.in("2").map((i) => i.name), ["cy"]);
  assert.equal(await sa.names(150), null);
  assert.deepEqual(here.in("2"), [], "cy opened no stream: gone after the grace period");

  const bob = await open(app, "/doc/1?as=bob");
  assert.equal(bob.shown, "ann,bob");
  assert.equal(await sa.names(), "ann,bob");

  assert.equal(await sa.names(), "ann");
  const sb = await stream(app, bob);
  assert.equal(await sa.names(), "ann,bob");
  assert.equal(await sa.names(150), null);

  await sb.close();
  assert.equal(await sa.names(), "ann");

  await sa.close();
  app.close();
  assert.deepEqual(here.in("1"), [], "closing the pages empties the room");
  assert.deepEqual(here.in("2"), []);
});

test("join outside a live page's load is an error", async () => {
  const { app } = setup();
  await assert.rejects(Promise.resolve(app.fetch(new Request(ORIGIN + "/api/join"))), /join from the load of a live page/);
  app.close();
  assert.throws(() => definePresence("bad name"), /presence name/);
});

test("a room store is one shared value per key", () => {
  const votes = defineRoom("votes", (k) => (k === "seeded" ? 10 : 0), { maxRooms: 2 });
  votes.in("a").value += 1;
  votes.in("a").value += 1;
  assert.equal(votes.in("a").value, 2);
  assert.equal(votes.in("seeded").value, 10);
  assert.equal(votes.in("a"), votes.in("a"), "the same store each time");
  votes.in("b");
  assert.equal(votes.size, 2);
  assert.equal(votes.in("seeded").value, 10, "evicted keys start again");
  votes.drop("seeded");
  assert.throws(() => votes.in(""), /key/);
  assert.throws(() => votes.in("x".repeat(257)), /key/);
});
