import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel } from "@weft-framework/data";
import { defineComponent, escapeHtml } from "@weft-framework/runtime";
import { createApp, type AppOptions } from "../src/app.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";
let n = 0;

function setup(degrade: AppOptions["degrade"], clock = { t: 1_000_000 }) {
  const Item = defineModel<{ id: string; text: string }>(`DegItem${++n}`, {
    fields: { id: "string", text: "string" },
    read: () => true,
    write: () => true,
  });
  Item.as({ id: "a" }).create({ id: "1", text: "first" });
  const List = defineComponent("DegList", (props: { items: { text: string }[] }) => ({
    handlers: {},
    render: () => `<ul>${props.items.map((i) => `<li>${escapeHtml(i.text)}</li>`).join("")}</ul>`,
  }));
  const app = createApp({
    secret: SECRET,
    now: () => clock.t,
    degrade,
    routes: { "/": { component: List as never, load: () => ({ items: Item.as({ id: "a" }).all() }) } },
  });
  return { app, clock };
}

async function get(app: ReturnType<typeof createApp>) {
  const res = (await app.fetch(new Request(`${ORIGIN}/`)))!;
  const html = await res.text();
  return { html, lid: /name="weft-live" content="([^"]+)"/.exec(html)?.[1], cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]! };
}

test("past the page limit, new pages render without a live page", async () => {
  const heard: unknown[] = [];
  const { app, clock } = setup({ pages: 2, onDegrade: (i) => heard.push(i) });
  const a = await get(app);
  const b = await get(app);
  assert.ok(a.lid && b.lid, "under the limit, pages are live");
  const c = await get(app);
  assert.equal(c.lid, undefined, "the third page is not kept");
  assert.match(c.html, /<li>first<\/li>/, "but shows the data");
  assert.doesNotMatch(c.html, /weft-transport/);
  await get(app);
  assert.deepEqual(heard, [{ route: "/", reason: "pages", pages: 2, heapBytes: null }], "heard once a minute");
  clock.t += 61_000;
  await get(app);
  assert.equal(heard.length, 2);

  const sse = (await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${a.lid}`, { headers: { cookie: a.cookie } })))!;
  assert.equal(sse.status, 200);
  await sse.body!.cancel();
  app.close();
});

test("above the heap limit, new pages render without a live page", async () => {
  const heard: { reason: string; heapBytes: number | null }[] = [];
  const real = process.memoryUsage;
  const fake = Object.assign(() => ({ ...real(), heapUsed: 32 * 1024 * 1024 }), { rss: real.rss });
  process.memoryUsage = fake as typeof process.memoryUsage;
  try {
    const { app } = setup({ heapBytes: 16 * 1024 * 1024, onDegrade: (i) => heard.push(i) });
    const p = await get(app);
    assert.equal(p.lid, undefined);
    assert.equal(heard[0]?.reason, "memory");
    assert.equal(heard[0]?.heapBytes, 32 * 1024 * 1024);
    app.close();
    const { app: roomy } = setup({ heapBytes: 64 * 1024 * 1024 });
    assert.ok((await get(roomy)).lid, "a heap under the limit keeps pages live");
    roomy.close();
  } finally {
    process.memoryUsage = real;
  }
});

test("degrade options are checked", () => {
  assert.throws(() => setup({ pages: 0 }), /degrade.pages/);
  assert.throws(() => setup({ pages: 1.5 }), /degrade.pages/);
  assert.throws(() => setup({ heapBytes: 1024 }), /degrade.heapBytes/);
  const { app } = setup(undefined);
  app.close();
});
