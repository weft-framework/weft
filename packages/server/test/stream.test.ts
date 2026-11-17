import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitBlock, defineComponent, escapeHtml } from "@weft-framework/runtime";
import { createApp, type AppOptions } from "../src/app.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

function setup(extra: Partial<AppOptions> = {}) {
  const gates: { resolve: (v: string) => void; reject: (e: Error) => void }[] = [];
  const later = () =>
    new Promise<string>((resolve, reject) => {
      gates.push({ resolve, reject });
    });
  const Feed = defineComponent("Feed", (props: { a: Promise<string>; b: Promise<string> }) => ({
    handlers: {},
    render: () =>
      `<h1>Feed</h1>` +
      awaitBlock(props.a, () => `<p>loading a</p>`, (v) => `<p>a=${escapeHtml(v)}</p>`) +
      awaitBlock(
        props.b,
        () => `<p>loading b</p>`,
        (v) => `<p>b=${escapeHtml(v)}</p>`,
        (e) => `<p>b failed: ${escapeHtml((e as Error).message)}</p>`,
      ),
  }));
  const Plain = defineComponent("Plain", () => ({ handlers: {}, render: () => `<p>plain</p>` }));
  const errors: unknown[] = [];
  const app = createApp({
    secret: SECRET,
    sync: false,
    routes: {
      "/": { component: Feed as never, load: () => ({ a: later(), b: later() }) },
      "/plain": { component: Plain },
    },
    onError: (e) => errors.push(e),
    ...extra,
  });
  return { app, gates, errors };
}

async function reader(res: Response) {
  const r = res.body!.getReader();
  const dec = new TextDecoder();
  let all = "";
  return {
    async chunk(): Promise<string | null> {
      const { value, done } = await r.read();
      if (done) {
        return null;
      }
      const s = dec.decode(value);
      all += s;
      return s;
    },
    get all() {
      return all;
    },
  };
}

test("the shell goes first and each settled block follows in the response", async () => {
  const { app, gates } = setup();
  const res = await app.fetch(new Request(`${ORIGIN}/`));
  assert.ok(res);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  const nonce = /'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];
  assert.ok(nonce);
  const r = await reader(res);
  const first = (await r.chunk())!;
  assert.match(first, /<h1>Feed<\/h1><p>loading a<\/p><p>loading b<\/p>/);
  assert.ok(!first.includes("</body>"), "the document stays open");

  gates[0].resolve("1 & 2");
  const second = (await r.chunk())!;
  assert.match(second, /^<template data-weft-stream><weft-c data-weft-c="r">.*<p>a=1 &amp; 2<\/p><p>loading b<\/p>/s);
  assert.match(second, new RegExp(`<script nonce="${nonce}">`), "the swap script runs under the page's CSP");

  gates[1].reject(new Error("down"));
  const third = (await r.chunk())!;
  assert.match(third, /<p>a=1 &amp; 2<\/p><p>b failed: down<\/p>/);
  let rest = "";
  for (let c = await r.chunk(); c !== null; c = await r.chunk()) {
    rest += c;
  }
  assert.match(rest, /<\/body>\s*<\/html>\s*$/, "nothing pending: the document ends");
  app.close();
});

test("the live page carries on from the streamed state", async () => {
  const { app, gates } = setup();
  const res = (await app.fetch(new Request(`${ORIGIN}/`)))!;
  const r = await reader(res);
  await r.chunk();
  gates[0].resolve("x");
  gates[1].resolve("y");
  while ((await r.chunk()) !== null) {
  }
  assert.match(r.all, /<p>a=x<\/p><p>b=y<\/p>/);
  assert.match(r.all, /<meta name="weft-live" content="[^"]+">/);
  app.close();
});

test("the stream ends after the timeout; later results are left to live patches", async () => {
  const { app } = setup({ streamTimeoutMs: 30 });
  const res = (await app.fetch(new Request(`${ORIGIN}/`)))!;
  const html = await res.text();
  assert.match(html, /<p>loading a<\/p>/);
  assert.match(html, /<\/html>\s*$/);
  assert.ok(!html.includes("data-weft-stream"));
  app.close();
});

test("client navigation waits and gets one finished document", async () => {
  const { app, gates } = setup();
  const pending = app.fetch(new Request(`${ORIGIN}/`, { headers: { accept: "text/html", "x-weft-nav": "1" } }));
  await new Promise((r) => setTimeout(r, 5));
  gates[0].resolve("A");
  gates[1].resolve("B");
  const html = await (await pending)!.text();
  assert.match(html, /<p>a=A<\/p><p>b=B<\/p>/);
  assert.ok(!html.includes("data-weft-stream") && !html.includes("loading"));
  app.close();
});

test("pages without pending blocks, HEAD requests and streamTimeoutMs: 0 are not streamed", async () => {
  const { app } = setup({ streamTimeoutMs: 0 });
  const res = (await app.fetch(new Request(`${ORIGIN}/`)))!;
  assert.equal(res.headers.get("x-accel-buffering"), null);
  assert.match(await res.text(), /loading a/);
  const on = setup();
  const plain = (await on.app.fetch(new Request(`${ORIGIN}/plain`)))!;
  assert.equal(plain.headers.get("x-accel-buffering"), null);
  const head = (await on.app.fetch(new Request(`${ORIGIN}/`, { method: "HEAD" })))!;
  assert.equal(head.body, null);
  app.close();
  on.app.close();
});

test("a stateless app streams too and disposes the page at the end", async () => {
  let destroyed = 0;
  let resolve!: (v: string) => void;
  const View = defineComponent("View", (props: { v: Promise<string> }) => ({
    handlers: {},
    render: () => awaitBlock(props.v, () => "wait", (v) => `<b>${escapeHtml(v)}</b>`),
    destroy: [() => void (destroyed += 1)],
  }));
  const app = createApp({
    secret: SECRET,
    transports: [],
    sync: false,
    routes: { "/": { component: View as never, load: () => ({ v: new Promise<string>((r) => (resolve = r)) }) } },
  });
  const res = (await app.fetch(new Request(`${ORIGIN}/`)))!;
  const r = await reader(res);
  assert.match((await r.chunk())!, /wait/);
  assert.equal(destroyed, 0, "kept while the response is open");
  resolve("done");
  while ((await r.chunk()) !== null) {
  }
  assert.match(r.all, /<b>done<\/b>/);
  assert.equal(destroyed, 1);
  app.close();
});

test("a client that goes away ends the stream", async () => {
  const { app } = setup();
  const res = (await app.fetch(new Request(`${ORIGIN}/`)))!;
  const r = res.body!.getReader();
  await r.read();
  await r.cancel();
  app.close();
});
