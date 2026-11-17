import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

const CARD = ".card:where(.w-a){color:red}";
const LATER = ".later:where(.w-b){color:blue}";
const Card = defineComponent("Card", () => ({ handlers: {}, render: () => `<p class="card w-a">x</p>` }), { css: CARD });
defineComponent("Later", () => ({ handlers: {}, render: () => "" }), { css: LATER });
const Page = defineComponent("Page", () => ({ handlers: {}, render: () => `<main>${Card({})}</main>` }));
const Plain = defineComponent("Plain", () => ({ handlers: {}, render: () => `<p>plain</p>` }));

const app = createApp({
  secret: SECRET,
  routes: { "/": { component: Page as never }, "/plain": { component: Plain as never } },
});

test("a page inlines the styles of the components it renders, under its nonce", async () => {
  const res = await app.fetch(new Request(ORIGIN + "/"));
  const html = await res!.text();
  const nonce = /<style nonce="([^"]+)">/.exec(html)?.[1];
  assert.ok(nonce);
  assert.match(res!.headers.get("content-security-policy") ?? "", new RegExp(`'nonce-${nonce}'`));
  const inline = /<style nonce="[^"]+">([^<]*)<\/style>/.exec(html)?.[1] ?? "";
  assert.ok(inline.includes(CARD), inline);
  assert.ok(!inline.includes(LATER), "only the components on the page");
  assert.match(html, /<link rel="stylesheet" href="\/_weft\/styles\.css\?v=[0-9a-z]+">\s*<\/body>/);
});

test("the bundle holds every stylesheet, cached immutably by version", async () => {
  const page = await (await app.fetch(new Request(ORIGIN + "/plain")))!.text();
  assert.ok(!/<style nonce="[^"]+">[^<]*\.card/.test(page), "no critical CSS for unstyled pages");
  const href = /href="(\/_weft\/styles\.css\?v=[0-9a-z]+)"/.exec(page)?.[1];
  assert.ok(href, "still linked: later patches may bring styled components");
  const res = await app.fetch(new Request(ORIGIN + href));
  assert.equal(res?.status, 200);
  assert.equal(res?.headers.get("content-type"), "text/css; charset=utf-8");
  assert.match(res?.headers.get("cache-control") ?? "", /immutable/);
  const css = await res!.text();
  assert.ok(css.includes(CARD) && css.includes(LATER), css);
  const stale = await app.fetch(new Request(ORIGIN + "/_weft/styles.css?v=old"));
  assert.equal(stale?.headers.get("cache-control"), "no-cache");
});
