import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft/runtime";
import { createApp } from "../src/app.ts";
import { definePdf, findBrowser, type CaptureJob, type PdfPrinter } from "../src/pdf.ts";
import { decodePng } from "../src/image/png.ts";

const ORIGIN = "http://app.test";
const SECRET = "og-test-secret-0123456789abcdefghij";

const Post = defineComponent("OgPost", (p: { slug: string; who: string }) => ({
  handlers: {},
  render: () => `<article>${escapeHtml(p.slug)} read by ${escapeHtml(p.who)}</article>`,
}));
const Card = defineComponent("OgCard", (p: { slug: string; who: string }) => ({
  handlers: {},
  render: () =>
    `<div style="width:100%;height:100vh;background:#1040c0;color:#fff;font:64px sans-serif">${escapeHtml(p.slug)} / ${escapeHtml(p.who)}</div>`,
}));

function fakePrinter() {
  const jobs: CaptureJob[] = [];
  const printer: PdfPrinter = {
    print: async () => new Uint8Array(),
    capture: async (job) => {
      jobs.push(job);
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    },
    close: async () => {},
  };
  return { printer, jobs };
}

function setup(printer: PdfPrinter) {
  return createApp({
    secret: SECRET,
    pdf: printer,
    onError: () => {},
    middleware: ({ request, url }) =>
      url.pathname.startsWith("/drafts/") && !request.headers.get("cookie")?.includes("member=1") ? new Response("no", { status: 403 }) : undefined,
    routes: {
      "/": { component: Post as never, og: Card as never, load: () => ({ slug: "home", who: "x" }) as never },
      "/posts/[slug]": {
        component: Post as never,
        og: { component: Card as never, width: 800, height: 400 },
        load: (ctx) => ({ who: ctx.request.headers.get("cookie") ? "a member" : "anyone" }) as never,
      },
      "/drafts/[slug]": { component: Post as never, og: Card as never, load: () => ({ who: "member" }) as never },
      "/own": { component: Post as never, og: Card as never, meta: { openGraph: { image: "/own.jpg" } }, load: () => ({ slug: "o", who: "x" }) as never },
    },
  });
}

const get = async (app: ReturnType<typeof setup>, path: string, headers: Record<string, string> = {}) =>
  (await app.fetch(new Request(ORIGIN + path, { headers })))!;

test("the page names its card, which is drawn as a visitor with no cookie", async () => {
  const { printer, jobs } = fakePrinter();
  const app = setup(printer);
  const page = await (await get(app, "/posts/hello", { cookie: "member=1" })).text();
  assert.match(page, /<meta property="og:image" content="\/posts\/hello\.og\.png">/);
  assert.match(page, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(await (await get(app, "/")).text(), /content="\/\.og\.png"/, "the front page's card");
  assert.match(await (await get(app, "/own")).text(), /og:image" content="\/own\.jpg"/, "a page's own image wins");

  const img = await get(app, "/posts/hello.og.png", { cookie: "member=1" });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(img.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(jobs.length, 1);
  const job = jobs[0]!;
  assert.deepEqual([job.width, job.height, job.url], [800, 400, `${ORIGIN}/posts/hello`]);
  assert.match(job.html, /hello \/ anyone/, "the card, with props loaded for a visitor with no cookie");
  assert.ok(!job.html.includes("<article>"), "not the page itself");

  assert.equal((await get(app, "/posts/hello.og.png")).status, 200);
  assert.equal(jobs.length, 1, "drawn once");
  assert.equal((await get(app, "/posts/hello.og.png", { "if-none-match": img.headers.get("etag")! })).status, 304);
  assert.equal((await get(app, "/.og.png")).status, 200);
  assert.match(jobs[1]!.html, /home \/ x/);
});

test("a page only signed-in people see has no card for anyone", async () => {
  const { printer, jobs } = fakePrinter();
  const app = setup(printer);
  assert.equal((await get(app, "/drafts/plan", { cookie: "member=1" })).status, 200);
  const img = await get(app, "/drafts/plan.og.png", { cookie: "member=1" });
  assert.equal(img.status, 403);
  assert.equal(jobs.length, 0);
  assert.equal((await get(app, "/nothing.og.png")).status, 404);
});

test("og needs a printer and a component", () => {
  assert.throws(() => createApp({ secret: SECRET, routes: { "/": { component: Post as never, og: Card as never } } }), /drawn by the `pdf` printer/);
  const { printer } = fakePrinter();
  assert.throws(
    () => createApp({ secret: SECRET, pdf: printer, routes: { "/": { component: Post as never, og: { component: Card as never, width: 50 } } } }),
    /sizes 200-2400/,
  );
});

test("a real browser draws the card at its size", { skip: !findBrowser() && "no Chromium-based browser here" }, async () => {
  const printer = definePdf();
  const app = setup(printer);
  try {
    const res = await get(app, "/posts/hello.og.png");
    assert.equal(res.status, 200);
    const png = decodePng(new Uint8Array(await res.arrayBuffer()), 10_000_000);
    assert.deepEqual([png.width, png.height], [800, 400]);
    const at = (x: number, y: number) => Array.from(png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3));
    assert.deepEqual(at(400, 300), [0x10, 0x40, 0xc0], "the card is drawn");
  } finally {
    await printer.close();
  }
});
