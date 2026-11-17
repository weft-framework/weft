import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent } from "@weft-framework/runtime";
import { createApp, type AppOptions } from "../src/app.ts";

const ORIGIN = "http://app.test";

const Home = defineComponent("Home", () => ({
  render: () =>
    `<a href="/about">About</a><a href="/post/1">One</a><a href="/post/2?x=1&amp;y=2">Two</a>` +
    `<a href="https://elsewhere.test/post/3">Away</a><a href="/">Home</a>`,
}));
const Plain = defineComponent("Plain", () => ({ render: () => `<p>page</p>` }));

function setup(prefetch?: AppOptions["prefetch"]) {
  return createApp({
    secret: "test-secret-test-secret-test-secret!",
    prefetch,
    routes: {
      "/": { component: Home as never },
      "/about": { component: Plain as never },
      "/post/[id]": { component: Plain as never },
    },
  });
}

const likely = (html: string) => /<meta name="weft-likely" content="([^"]*)">/.exec(html)?.[1] ?? null;

async function visit(app: ReturnType<typeof setup>, path: string, referer?: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (referer) headers.referer = referer;
  return (await app.fetch(new Request(`${ORIGIN}${path}`, { headers })))!;
}

test("after enough views, a page lists its links to the common next routes", async () => {
  const app = setup({ minVisits: 10 });
  assert.equal(likely(await (await visit(app, "/")).text()), null, "no guess yet");
  for (let i = 0; i < 8; i++) await visit(app, `/post/${i}`, `${ORIGIN}/`);
  await visit(app, "/about", `${ORIGIN}/`);
  for (let i = 0; i < 5; i++) await visit(app, "/about", "https://elsewhere.test/");
  for (let i = 0; i < 5; i++) await visit(app, "/", `${ORIGIN}/`);
  for (let i = 0; i < 5; i++) await visit(app, "/about", `${ORIGIN}/`, { "x-weft-prefetch": "1" });
  assert.equal(likely(await (await visit(app, "/")).text()), null, "9 counted views is under 10");
  await visit(app, "/post/9", `${ORIGIN}/`);

  assert.equal(likely(await (await visit(app, "/")).text()), "/post/1 /post/2?x=1&amp;y=2");
  assert.equal(likely(await (await visit(app, "/about")).text()), null);
  app.close();
});

test("share, links and off", async () => {
  const strict = setup({ minVisits: 4, share: 0.5, links: 1 });
  for (let i = 0; i < 2; i++) await visit(strict, "/about", `${ORIGIN}/`);
  for (let i = 0; i < 2; i++) await visit(strict, `/post/${i}`, `${ORIGIN}/`);
  assert.equal(likely(await (await visit(strict, "/")).text()), "/about", "ties keep page order; one link");
  strict.close();

  const off = setup(false);
  for (let i = 0; i < 30; i++) await visit(off, `/post/${i}`, `${ORIGIN}/`);
  assert.equal(likely(await (await visit(off, "/")).text()), null);
  off.close();

  assert.throws(() => setup({ links: 6 }), /prefetch\.links/);
  assert.throws(() => setup({ minVisits: 0 }), /prefetch\.minVisits/);
  assert.throws(() => setup({ share: 0 }), /prefetch\.share/);
});
