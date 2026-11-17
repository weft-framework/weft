import { test } from "node:test";
import assert from "node:assert/strict";
import { actionAttr, defineComponent, escapeHtml } from "@weft-framework/runtime";
import { createApp, type App } from "../src/app.ts";
import { defineAction } from "../src/action.ts";
import { openApi } from "../src/contract.ts";

const ORIGIN = "http://app.test";

function setup() {
  let t = Date.parse("2026-11-14T10:00:00Z");
  const calls: unknown[][] = [];
  const rename = defineAction(
    "rename",
    [
      { name: "id", type: "string", held: true },
      { name: "rank", type: "number", held: true },
      { name: "title", type: "string" },
    ],
    (_ctx, id: string, rank: number, title: string) => void calls.push([id, rank, title]),
  );
  const other = defineAction("other", [{ name: "id", type: "string", held: true }], (_ctx, id: string) => void calls.push(["other", id]));
  const Page = defineComponent("Page", (p: { id: string }) => ({
    render: () =>
      `<form${actionAttr("action", rename.with(p.id, 3))}><input name="title"></form>` +
      `<form${actionAttr("action", other.with("o1"))}></form><p>${escapeHtml(p.id)}</p>`,
  }));
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    now: () => t,
    routes: { "/": { component: Page as never, load: () => ({ id: "task-1" }) } },
    actions: { rename, other } as never,
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
  return { app, calls, rename, advance: (ms: number) => void (t += ms) };
}

async function page(app: App, cookie?: string) {
  const res = (await app.fetch(new Request(`${ORIGIN}/`, cookie ? { headers: { cookie } } : {})))!;
  const html = await res.text();
  cookie ??= (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const forms = [...html.matchAll(/<form action="([^"]+)"[^>]*data-weft-held="([^"]+)"/g)].map((m) => ({
    action: m[1]!.replaceAll("&amp;", "&"),
    held: m[2]!,
  }));
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";
  return { html, cookie, forms, csrf };
}

const post = (app: App, cookie: string, action: string, fields: Record<string, string>, extra: Record<string, string> = {}) =>
  app.fetch(
    new Request(`${ORIGIN}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie, ...extra },
      body: new URLSearchParams(fields).toString(),
    }),
  );

test("held values come only from the form the server rendered", async () => {
  const { app, calls } = setup();
  const p = await page(app);
  assert.equal(p.forms.length, 2);
  const [renameForm, otherForm] = p.forms;
  assert.match(renameForm!.action, /^\?\/rename&_weft_held=/);
  assert.equal(p.html.includes('name="id"'), false, "no field to edit");

  const res = (await post(app, p.cookie, renameForm!.action, { title: "New", id: "task-999", rank: "0" }))!;
  assert.equal(res.status, 303);
  assert.deepEqual(calls.at(-1), ["task-1", 3, "New"]);

  const enhanced = (await post(app, p.cookie, renameForm!.action, { title: "Again" }, { "x-weft-enhanced": "1", "x-weft-csrf": p.csrf }))!;
  assert.deepEqual(await enhanced.json(), { ok: true });
  assert.deepEqual(calls.at(-1), ["task-1", 3, "Again"]);
  assert.equal(calls.length, 2);

  const refused = async (action: string, cookie = p.cookie) => {
    const r = (await post(app, cookie, action, { title: "x" }, { "x-weft-enhanced": "1", "x-weft-csrf": p.csrf }))!;
    return { status: r.status, body: (await r.json()) as { ok: boolean; error?: string } };
  };
  for (const action of [
    "?/rename",
    renameForm!.action.replace(/.$/, (c) => (c === "A" ? "B" : "A")),
    `?/rename&_weft_held=${otherForm!.held}`,
  ]) {
    const r = await refused(action);
    assert.equal(r.status, 400, action);
    assert.equal(r.body.error, "This form has expired; reload the page");
  }
  const [body, sig] = renameForm!.held.split(".");
  const forged = Buffer.from(JSON.stringify(["rename", Date.now() + 1e9, ["task-999", 3]])).toString("base64url");
  assert.notEqual(forged, body);
  assert.equal((await refused(`?/rename&_weft_held=${forged}.${sig}`)).status, 400);
  assert.equal(calls.length, 2, "nothing ran");
  app.close();
});

test("a held token opens only in its session, and only for a day", async () => {
  const { app, calls, advance } = setup();
  const p = await page(app);
  const q = await page(app);
  assert.notEqual(p.cookie, q.cookie);
  assert.equal((await post(app, q.cookie, p.forms[0]!.action, { title: "x" }))!.status, 400);
  advance(25 * 60 * 60_000);
  assert.equal((await post(app, p.cookie, p.forms[0]!.action, { title: "x" }))!.status, 400, "expired");
  const again = await page(app, p.cookie);
  assert.equal((await post(app, p.cookie, again.forms[0]!.action, { title: "fresh" }))!.status, 303);
  assert.deepEqual(calls, [["task-1", 3, "fresh"]]);
  app.close();
});

test("binding checks the held values; held actions stay out of the contract", () => {
  const { rename } = setup();
  assert.throws(() => rename.with("only-one"), /expected 2 held value/);
  assert.throws(() => rename.with("id", "3"), /rank: expected number/);
  assert.throws(() => actionAttr("action", rename.with("a", 1)), /renders only in a live server page/);
  assert.throws(
    () => defineAction("bad", [{ name: "a", type: "string" }, { name: "b", type: "string", held: true }], () => {}),
    /held parameters come first/,
  );
  assert.throws(() => defineAction("plain", [], () => {}).with(), /no Held<T> parameters/);
  const contract = openApi({ actions: { rename, plain: defineAction("plain", [], () => {}) } } as never, { title: "t", version: "1" } as never) as {
    paths: Record<string, unknown>;
  };
  assert.ok(contract.paths["/_weft/action/plain"]);
  assert.equal(contract.paths["/_weft/action/rename"], undefined);
});
