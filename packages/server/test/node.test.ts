import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineComponent, escapeHtml, signal } from "@weft/runtime";
import { createApp } from "../src/app.ts";
import { rewriteImports, runtimeAssets, serveNode } from "../src/node.ts";

const Counter = defineComponent("Counter", (_p: Record<string, never>) => {
  const count = signal(0);
  function inc() {
    count.value = count.value + 1;
  }
  return {
    handlers: { inc },
    render: () => `<button data-weft-on-click="inc">${escapeHtml(count.value)}</button>`,
  };
});

test("import specifiers are rewritten to served .js modules", () => {
  assert.equal(
    rewriteImports(`import { a } from "./a.ts";\nexport * from '../b.ts';\nimport("./c.ts")`),
    `import { a } from "./a.js";\nexport * from '../b.js';\nimport("./c.js")`,
  );
  assert.equal(rewriteImports(`import x from "pkg.ts"`), `import x from "pkg.ts"`, "bare specifiers untouched");
});

test("runtime assets form a loadable ES module graph", async () => {
  const assets = runtimeAssets();
  assert.ok(assets["/_weft/client.js"]);
  assert.ok(assets["/_weft/rt/boot.js"]);
  for (const [path, js] of Object.entries(assets)) {
    assert.ok(!/from\s*["']\.[^"']*\.ts["']/.test(js), `${path} still imports .ts`);
    assert.ok(!/\binterface\s+\w+\s*\{/.test(js), `${path} still has types`);
  }
  const dir = mkdtempSync(join(tmpdir(), "weft-assets-"));
  try {
    for (const [path, js] of Object.entries(assets)) {
      const file = join(dir, path.replace(/^\//, "").replace(/\.js$/, ".mjs"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, js.replace(/(["'])(\.\.?\/[^"']+)\.js\1/g, "$1$2.mjs$1"));
    }
    await import(pathToFileURL(join(dir, "_weft", "client.mjs")).href);
    const rt = await import(pathToFileURL(join(dir, "_weft", "rt", "index.mjs")).href);
    assert.equal(typeof rt.WeftClient, "function");
    assert.equal(rt.escapeHtml("<a>"), "&lt;a&gt;");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Node adapter: page, assets and an SSE + POST round trip over real sockets", async () => {
  const app = createApp({
    secret: "node-adapter-test-secret-0123456789",
    routes: { "/": { component: Counter, title: "Node" } },
    assets: runtimeAssets(),
    transports: ["sse"],
    onError: () => {},
  });
  const server = await serveNode(app, { port: 0 });
  try {
    const page = await fetch(server.url + "/");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<meta name="weft-transport" content="sse">/);
    assert.match(html, /<script type="module" nonce="[^"]+" src="\/_weft\/client.js"><\/script>/);
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0];
    const lid = /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "";
    const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";

    const js = await fetch(server.url + "/_weft/rt/client.js");
    assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(await js.text(), /export class WeftClient/);

    const ws = await app.fetch(
      new Request(`${server.url}/_weft/live?lid=${lid}`, {
        headers: { cookie, upgrade: "websocket", origin: server.url },
      }),
    );
    assert.equal(ws?.status, 426, "WebSocket disabled with transports: [sse]");

    const sse = await fetch(`${server.url}/_weft/live/sse?lid=${lid}`, { headers: { cookie } });
    assert.equal(sse.headers.get("content-type"), "text/event-stream");
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const next = async () => {
      for (;;) {
        const m = /data: (.*)\n\n/.exec(buf);
        if (m) {
          buf = buf.slice(m.index + m[0].length);
          return JSON.parse(m[1]);
        }
        const { value } = await reader.read();
        buf += dec.decode(value);
      }
    };
    const hello = await next();
    const post = await fetch(server.url + "/_weft/live/event", {
      method: "POST",
      headers: { cookie, origin: server.url, "x-weft-csrf": csrf, "x-weft-session": hello.session },
      body: JSON.stringify({ t: "event", id: "r", handler: "inc", event: { type: "click" }, seq: 1 }),
    });
    assert.equal(post.status, 204);
    assert.deepEqual(await next(), {
      t: "patch",
      id: "r",
      html: '<button data-weft-on-click="inc">1</button>',
      ack: 1,
    });
    await reader.cancel();
  } finally {
    await server.close();
  }
});
