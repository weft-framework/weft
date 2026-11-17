import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeFeed, defineModel } from "@weft/data";
import { defineComponent, defineStore, escapeHtml } from "@weft/runtime";
import { createApp } from "../src/app.ts";

const ORIGIN = "http://app.test";

interface Post {
  id: string;
  title: string;
}

function setup() {
  const feed = new ChangeFeed();
  const Posts = defineModel<Post>(`EtagPost${Math.random().toString(36).slice(2, 7)}`, {
    fields: { id: "string", title: "string" },
    read: () => true,
    write: () => true,
  }).publishTo(feed);
  Posts.as({}).create({ id: "a", title: "First" });
  Posts.as({}).create({ id: "b", title: "Second" });
  let loads = 0;
  const errors: string[] = [];
  const Show = defineComponent("Show", (p: { post: Post | null }) => ({
    render: () => `<h1>${escapeHtml(p.post?.title ?? "none")}</h1>`,
  }));
  const Clicky = defineComponent("Clicky", () => ({
    handlers: { go: () => {} },
    render: () => `<button data-weft-on-click="go">go</button>`,
  }));
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    sync: feed,
    syncDelayMs: 0,
    onError: (e) => errors.push(String((e as Error).message)),
    routes: {
      "/post/[id]": {
        component: Show as never,
        cache: "etag",
        load: (ctx) => {
          loads++;
          return { post: Posts.as({}).get((ctx.params as { id: string }).id) ?? null };
        },
      },
      "/clicky": { component: Clicky as never, cache: "etag" },
      "/live": { component: Show as never, load: () => ({ post: Posts.as({}).get("a") ?? null }) },
    },
  });
  return { app, Posts, loads: () => loads, errors };
}

test("a cached page revalidates to 304 until a write concerns what it read", async () => {
  const { app, Posts, loads } = setup();
  const first = (await app.fetch(new Request(`${ORIGIN}/post/a`)))!;
  const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal(first.headers.get("etag"), null);
  const get = (headers: Record<string, string> = {}) =>
    app.fetch(new Request(`${ORIGIN}/post/a`, { headers: { cookie, ...headers } })) as Promise<Response>;

  const r1 = await get();
  const tag = r1.headers.get("etag")!;
  assert.match(tag, /^"[A-Za-z0-9_-]+"$/);
  assert.equal(r1.headers.get("cache-control"), "private, no-cache");
  const html = await r1.text();
  assert.match(html, /<h1>First<\/h1>/);
  assert.equal(/name="weft-live"/.test(html), false, "no live page");

  const before = loads();
  const r2 = await get({ "if-none-match": tag });
  assert.equal(r2.status, 304);
  assert.equal(r2.headers.get("etag"), tag);
  assert.equal(r2.headers.get("content-security-policy"), null, "the kept page's own CSP stays");
  assert.equal(loads(), before, "load did not run");
  assert.equal((await get({ "if-none-match": `W/"other", ${tag}` })).status, 304, "a list, weak or not");

  Posts.as({}).update((p) => p.id === "b", { title: "Second, edited" });
  assert.equal((await get({ "if-none-match": tag })).status, 304);
  Posts.as({}).update((p) => p.id === "a", { title: "First, edited" });
  const r3 = await get({ "if-none-match": tag });
  assert.equal(r3.status, 200);
  assert.match(await r3.text(), /First, edited/);
  assert.notEqual(r3.headers.get("etag"), tag);

  const other = (await app.fetch(new Request(`${ORIGIN}/live`)))!.headers.get("set-cookie")!.split(";")[0]!;
  const tag3 = r3.headers.get("etag")!;
  const asOther = await app.fetch(new Request(`${ORIGIN}/post/a`, { headers: { cookie: other, "if-none-match": tag3 } }));
  assert.equal(asOther!.status, 200);
  assert.equal((await get({ cookie: `${cookie}; weft-theme=dark`, "if-none-match": tag3 })).status, 200);
  app.close();
});

test("a page that needs a live page is served uncached, and the mistake is named", async () => {
  const { app, errors } = setup();
  const cookie = (await app.fetch(new Request(`${ORIGIN}/live`)))!.headers.get("set-cookie")!.split(";")[0]!;
  const r = (await app.fetch(new Request(`${ORIGIN}/clicky`, { headers: { cookie } })))!;
  assert.equal(r.headers.get("etag"), null);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(errors.some((e) => e.includes('`cache: "etag"` is for pages without server event handlers')), errors.join("\n"));
  app.close();
});

test("a store a cached page read purges it when written", async () => {
  const feed = new ChangeFeed();
  const banner = defineStore("etagBanner", "app", () => "hello");
  const Page = defineComponent("Page", (p: { text: string }) => ({ render: () => `<p>${escapeHtml(p.text)}</p>` }));
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    sync: feed,
    routes: { "/": { component: Page as never, cache: "etag", load: () => ({ text: banner.value }) } },
  });
  const cookie = (await app.fetch(new Request(`${ORIGIN}/`)))!.headers.get("set-cookie")!.split(";")[0]!;
  const tag = (await app.fetch(new Request(`${ORIGIN}/`, { headers: { cookie } })))!.headers.get("etag")!;
  assert.ok(tag);
  assert.equal((await app.fetch(new Request(`${ORIGIN}/`, { headers: { cookie, "if-none-match": tag } })))!.status, 304);
  banner.value = "changed";
  const r = (await app.fetch(new Request(`${ORIGIN}/`, { headers: { cookie, "if-none-match": tag } })))!;
  assert.equal(r.status, 200);
  assert.match(await r.text(), /changed/);
  app.close();
});

test("reads by key concern only those rows; any other read concerns the model", async () => {
  const { DepsIndex, track } = await import("../src/sync.ts");
  const Notes = defineModel<Post>(`EtagKeyed${Math.random().toString(36).slice(2, 7)}`, {
    fields: { id: "string", title: "string" },
    read: () => true,
    write: () => true,
  });
  Notes.as({}).create({ id: "a", title: "A" });
  const index = new DepsIndex<string>();
  const byKey = index.deps("page");
  track(byKey, () => [Notes.as({}).get("a"), Notes.as({}).get("missing")]);
  const change = (key: string) => ({ model: Notes.name, op: "update" as const, key, before: { id: key, title: "" }, after: { id: key, title: "x" } });
  assert.equal(byKey.concerns(change("a")), true);
  assert.equal(byKey.concerns(change("missing")), true, "a row that did not exist yet, once created");
  assert.equal(byKey.concerns(change("b")), false);
  const listed = index.deps("page");
  track(listed, () => [Notes.as({}).get("a"), Notes.as({}).all()]);
  assert.equal(listed.concerns(change("b")), true, "a list may show any row");
});
