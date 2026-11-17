import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft/runtime";
import { createApp } from "../src/app.ts";
import { checkPdfRoute, definePdf, findBrowser, pdfFilename, type PrintJob } from "../src/pdf.ts";

const ORIGIN = "http://app.test";

const Invoice = defineComponent("Invoice", (p: { id: string; owner: string }) => ({
  handlers: { pay: () => {} },
  render: () =>
    `<link rel="stylesheet" href="/print.css"><h1>Invoice ${escapeHtml(p.id)} for ${escapeHtml(p.owner)}</h1>` +
    `<img src="https://tracker.example.net/pixel.gif" alt=""><button data-weft-on-click="pay">Pay</button>`,
}));

function setup(printer = fakePrinter()) {
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    pdf: printer,
    middleware: ({ request }) => (request.headers.get("cookie")?.includes("blocked=1") ? new Response("no", { status: 403 }) : undefined),
    files: async (path) => (path === "/print.css" ? new Response("h1{color:#123}", { headers: { "content-type": "text/css" } }) : null),
    routes: {
      "/invoice/[id]": {
        component: Invoice as never,
        pdf: { filename: "invoice.pdf", format: "Letter" },
        load: (ctx) => ({ owner: ctx.request.headers.get("accept-language") ?? "nobody" }),
      },
      "/plain/[id]": { component: Invoice as never, load: () => ({ owner: "x" }) },
    },
  });
  return { app, printer };
}

function fakePrinter() {
  const jobs: PrintJob[] = [];
  const fetched: Response[] = [];
  return {
    jobs,
    fetched,
    async print(job: PrintJob) {
      jobs.push(job);
      fetched.push(await job.fetch(`${ORIGIN}/print.css`));
      return new TextEncoder().encode("%PDF-1.7 fake");
    },
    async close() {},
  };
}

test("a printing route answers <path>.pdf with the page as the viewer gets it", async () => {
  const { app, printer } = setup();
  const res = (await app.fetch(new Request(`${ORIGIN}/invoice/42.pdf?copy=1`, { headers: { "accept-language": "cs" } })))!;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), 'inline; filename="invoice.pdf"');
  assert.equal(await res.text(), "%PDF-1.7 fake");
  const job = printer.jobs[0]!;
  assert.equal(job.url, `${ORIGIN}/invoice/42?copy=1`);
  assert.equal(job.format, "Letter");
  assert.match(job.html, /Invoice 42 for cs/, "load ran with the viewer's request");
  assert.equal(/name="weft-live"/.test(job.html), false, "no live page is kept for a print");
  assert.equal(await printer.fetched[0]!.text(), "h1{color:#123}", "the page's own files come from the app");

  const blocked = (await app.fetch(new Request(`${ORIGIN}/invoice/42.pdf`, { headers: { cookie: "blocked=1" } })))!;
  assert.equal(blocked.status, 403);
  const plain = (await app.fetch(new Request(`${ORIGIN}/plain/7.pdf`)))!;
  assert.equal(plain.headers.get("content-type"), "text/html; charset=utf-8");
  app.close();
});

test("prints are limited per session, and a failing printer is a 503", async () => {
  const failing = { async print(): Promise<Uint8Array> { throw new Error("no browser"); }, async close() {} };
  const errors: unknown[] = [];
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    pdf: failing,
    onError: (e) => errors.push(e),
    routes: { "/r": { component: Invoice as never, pdf: true, load: () => ({ id: "1", owner: "o" }) } },
  });
  const cookie = (await app.fetch(new Request(`${ORIGIN}/r`)))!.headers.get("set-cookie")!.split(";")[0]!;
  const get = () => app.fetch(new Request(`${ORIGIN}/r.pdf`, { headers: { cookie } })) as Promise<Response>;
  assert.equal((await get()).status, 503);
  assert.equal(errors.length, 1);
  await get();
  await get();
  assert.equal((await get()).status, 429);
  app.close();
});

test("print options are checked", () => {
  assert.equal(checkPdfRoute(true, "t"), true);
  assert.throws(() => checkPdfRoute({ filename: "../x.pdf" }, "t"), /plain file name/);
  assert.throws(() => checkPdfRoute({ filename: "x.exe" }, "t"), /ending in \.pdf/);
  assert.throws(() => checkPdfRoute({ format: "B9" }, "t"), /pdf\.format/);
  assert.throws(() => checkPdfRoute({ margin: 1 }, "t"), /pdf\.margin/);
  assert.equal(pdfFilename("/invoice/42", true), "42.pdf");
  assert.equal(pdfFilename("/", true), "page.pdf");
  assert.equal(pdfFilename('/a/"x"%0d%0a', true), "x-.pdf");
  assert.throws(
    () => createApp({ secret: "test-secret-test-secret-test-secret!", routes: { "/": { component: Invoice as never, pdf: { format: "B9" as never } } } }),
    /route \/: pdf\.format/,
  );
});

const browser = findBrowser();
test("a real browser prints the page, fetching only its own origin", { skip: browser ? false : "no Chromium-based browser found" }, async () => {
  const printer = definePdf({ timeoutMs: 60_000 });
  const asked: string[] = [];
  try {
    const bytes = await printer.print({
      url: `${ORIGIN}/invoice/1`,
      html:
        `<!doctype html><html><head><link rel="stylesheet" href="/print.css"></head><body><h1>Invoice 1</h1>` +
        `<img src="https://tracker.example.net/pixel.gif"><script>document.body.innerHTML = "scripted"</script></body></html>`,
      fetch: async (u) => {
        asked.push(u);
        return new Response("h1{color:#123}", { headers: { "content-type": "text/css" } });
      },
    });
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), "%PDF-");
    assert.deepEqual(asked, [`${ORIGIN}/print.css`], "the other site, and the favicon, were never asked for");
    const again = await printer.print({ url: `${ORIGIN}/x`, html: "<p>x</p>", fetch: async () => new Response("") });
    assert.equal(new TextDecoder().decode(again.subarray(0, 5)), "%PDF-");
  } finally {
    await printer.close();
  }
});
