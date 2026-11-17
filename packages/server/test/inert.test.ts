import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml, signal, type Html } from "@weft-framework/runtime";
import { ChangeFeed, defineModel } from "@weft-framework/data";
import { createApp } from "../src/app.ts";
import { runtimeAssets } from "../src/node.ts";

const ORIGIN = "http://app.test";

const Text = defineComponent(
  "Text",
  (props: { title: string }) => ({ handlers: {}, render: () => `<h1>${escapeHtml(props.title)}</h1>` }),
  { inert: true },
);

const Frame = defineComponent(
  "Frame",
  (props: { children: Html }) => ({ handlers: {}, render: () => `<main>${escapeHtml(props.children)}</main>` }),
  { inert: true },
);

const Menu = defineComponent("Menu", (props: { children: Html }) => {
  const open = signal(false);
  return {
    handlers: {
      toggle() {
        open.value = !open.value;
      },
    },
    render: () => `<nav data-weft-on-click="toggle">${open.value}</nav>${escapeHtml(props.children)}`,
  };
});

function setup() {
  const feed = new ChangeFeed();
  const Notes = defineModel<{ id: string; text: string }>("InertNote", {
    fields: { id: "string", text: "string" },
    read: () => true,
  }).publishTo(feed);
  return createApp({
    secret: "inert-test-secret-0123456789abcdefgh",
    sync: feed,
    assets: runtimeAssets(),
    onError: (e) => {
      throw e;
    },
    routes: {
      "/plain": { component: Text as never, load: () => ({ title: "Plain" }) as never },
      "/framed": { component: Text as never, layouts: [{ component: Frame as never }], load: () => ({ title: "F" }) as never },
      "/menu": { component: Text as never, layouts: [{ component: Menu as never }], load: () => ({ title: "M" }) as never },
      "/notes": {
        component: Text as never,
        load: () => ({ title: `${Notes.publicUnscoped().length} notes` }) as never,
      },
    },
  });
}

async function page(path: string) {
  const app = setup();
  const res = (await app.fetch(new Request(ORIGIN + path)))!;
  const html = await res.text();
  return { html, script: /<script type="module"/.test(html), live: html.includes('name="weft-live"') };
}

test("an inert page, alone or in an inert layout, ships no client JS", async () => {
  for (const path of ["/plain", "/framed"]) {
    const p = await page(path);
    assert.ok(p.html.includes("<h1>"), p.html);
    assert.equal(p.script, false, `${path} ships no runtime`);
    assert.equal(p.live, false, `${path} keeps no live page`);
    assert.ok(p.html.includes('name="weft-csrf"'));
  }
});

test("an interactive layout or a data read keeps the runtime", async () => {
  for (const path of ["/menu", "/notes"]) {
    const p = await page(path);
    assert.equal(p.script, true, `${path} ships the runtime`);
    assert.equal(p.live, true, `${path} is live`);
  }
});
