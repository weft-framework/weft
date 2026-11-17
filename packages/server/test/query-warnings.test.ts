import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, signal } from "@weft-framework/runtime";
import { defineModel } from "@weft-framework/data";
import { createApp, type QueryWarning } from "../src/app.ts";

const ORIGIN = "http://app.test";
const SECRET = "test-secret-test-secret-test-secret!";
let n = 0;

function models() {
  const Item = defineModel<{ id: string; owner: string }>(`QwItem${++n}`, {
    fields: { id: "string", owner: "string" },
    read: () => true,
    write: () => true,
  });
  const Person = defineModel<{ id: string; name: string }>(`QwPerson${n}`, {
    fields: { id: "string", name: "string" },
    read: () => true,
    write: () => true,
  });
  for (let i = 0; i < 12; i++) {
    Person.as({ id: "a" }).create({ id: `p${i}`, name: `P${i}` });
    Item.as({ id: "a" }).create({ id: `i${i}`, owner: `p${i}` });
  }
  return { Item, Person };
}

async function open(app: ReturnType<typeof createApp>, path: string) {
  const res = (await app.fetch(new Request(`${ORIGIN}${path}`)))!;
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const html = await res.text();
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)![1];
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)![1]!;
  const sse = (await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } })))!;
  const reader = sse.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const session = String((JSON.parse(/data: (.*)\n\n/.exec(first)![1]!) as { session: string }).session);
  let seq = 0;
  const send = async (handler: string) => {
    const r = (await app.fetch(
      new Request(`${ORIGIN}/_weft/live/event`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": session },
        body: JSON.stringify({ t: "event", id: "r", handler, event: { type: "click" }, seq: ++seq }),
      }),
    ))!;
    await r.arrayBuffer();
  };
  return { send, lid, cookie, close: () => reader.cancel() };
}

test("an N+1 in a page load, an event and a re-render; a big read; once a minute", async () => {
  const { Item, Person } = models();
  const owners = () => Item.as({ id: "a" }).all().map((i) => Person.as({ id: "a" }).get(i.owner)?.name ?? "");
  const List = defineComponent("List", (props: { names: string[] }) => {
    const shown = signal(0);
    return {
      handlers: {
        each() {
          shown.value = owners().length;
        },
        once() {
          shown.value = Person.as({ id: "a" }).all().length;
        },
      },
      render: () => `<p>${props.names.length} ${shown.value}</p>`,
    };
  });
  const warnings: QueryWarning[] = [];
  const app = createApp({
    secret: SECRET,
    syncDelayMs: 0,
    routes: { "/lists/[id]": { component: List as never, load: () => ({ names: owners() }) } },
    queryWarnings: { repeat: 10, rows: 20 },
    onQueryWarning: (w) => void warnings.push(w),
  });
  const page = await open(app, "/lists/42");
  const brief = () => warnings.map((w) => `${w.kind} ${w.route} ${w.cause} ${w.model.replace(/\d+$/, "")} ${w.reads}`);
  assert.deepEqual(brief(), ["repeat /lists/[id] GET request QwPerson 12"]);

  await page.send("once");
  assert.equal(warnings.length, 1, "one read of all rows is fine");
  await page.send("each");
  assert.deepEqual(brief().slice(1), ["repeat /lists/[id] List.each QwPerson 12"]);
  await page.send("each");
  assert.equal(warnings.length, 2, "not repeated within a minute");

  Item.as({ id: "a" }).create({ id: "i99", owner: "p1" });
  for (let i = 0; i < 50 && warnings.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(brief().slice(2), ["repeat /lists/[id] data change QwPerson 13"]);

  const again = (await app.fetch(new Request(`${ORIGIN}/lists/42`)))!;
  await again.text();
  assert.equal(warnings.length, 3, "the same key within a minute");
  await page.close();
  app.close();
});

test("rows: many rows of one model in one request", async () => {
  const { Item } = models();
  const Rows = defineComponent("Rows", (props: { k: number }) => ({ handlers: {}, render: () => `<p>${props.k}</p>` }));
  const warnings: QueryWarning[] = [];
  const app = createApp({
    secret: SECRET,
    routes: { "/": { component: Rows as never, load: () => ({ k: Item.as({ id: "a" }).all().length }) } },
    queryWarnings: { rows: 10 },
    onQueryWarning: (w) => void warnings.push(w),
  });
  await (await app.fetch(new Request(`${ORIGIN}/`)))!.text();
  assert.deepEqual(warnings.map((w) => [w.kind, w.rows, w.reads]), [["rows", 12, 1]]);
  app.close();
});

test("off without devtools; on with it, to the console and the overlay; bad limits refused", async () => {
  const { Item, Person } = models();
  const owners = () => Item.as({ id: "a" }).all().map((i) => Person.as({ id: "a" }).get(i.owner));
  const Page = defineComponent("Page", () => ({ handlers: { look() { owners(); } }, render: () => `<p>x</p>` }));
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.map(String).join(" "));
  try {
    const quiet = createApp({ secret: SECRET, routes: { "/": { component: Page as never } } });
    const q = await open(quiet, "/");
    await q.send("look");
    await q.close();
    quiet.close();
    assert.deepEqual(warned, []);

    const dev = createApp({ secret: SECRET, routes: { "/": { component: Page as never } }, devtools: true });
    const p = await open(dev, "/");
    await p.send("look");
    const snap = await (await dev.fetch(new Request(`${ORIGIN}/_weft/dev/inspect?lid=${p.lid}`, { headers: { cookie: p.cookie } })))!.text();
    await p.close();
    dev.close();
    assert.equal(warned.length, 1);
    assert.match(warned[0]!, /query warning: Page\.look on \/ read QwPerson\d+ 12 times/);
    assert.match(snap, /query warning: QwPerson\d+ read 12 times \(Page\.look\)/);
  } finally {
    console.warn = orig;
  }
  for (const queryWarnings of [{ repeat: 1 }, { repeat: 2.5 }, { rows: 0 }]) {
    assert.throws(() => createApp({ secret: SECRET, routes: {}, queryWarnings }), /queryWarnings/);
  }
});
