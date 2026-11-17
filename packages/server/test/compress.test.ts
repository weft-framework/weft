import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { defineComponent } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";
import { acceptsGzip, compress, compressibleType } from "../src/compress.ts";
import { csrfToken, importSecret, verifyCsrf } from "../src/security.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";
const BIG = "<p>" + "weft ".repeat(600) + "</p>";

test("accept-encoding and type rules", () => {
  assert.ok(acceptsGzip("gzip, deflate, br"));
  assert.ok(acceptsGzip("br;q=1.0, gzip;q=0.8"));
  assert.ok(!acceptsGzip("gzip;q=0"));
  assert.ok(!acceptsGzip("br"));
  assert.ok(!acceptsGzip(null));
  assert.ok(acceptsGzip("*"));
  assert.ok(!acceptsGzip("*;q=0"));
  assert.ok(!acceptsGzip("gzip;q=0, *"), "an explicit refusal wins over *");
  assert.ok(compressibleType("text/html"));
  assert.ok(compressibleType("application/json"));
  assert.ok(compressibleType("application/vnd.api+json"));
  assert.ok(compressibleType("image/svg+xml"));
  assert.ok(!compressibleType("text/event-stream"));
  assert.ok(!compressibleType("image/png"));
});

const gz = (headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/x`, { headers: { "accept-encoding": "gzip", ...headers } });

test("compress gzips text and leaves the rest alone", async () => {
  const res = compress(gz(), new Response(BIG, { headers: { "content-type": "text/html", etag: '"abc"' } }));
  assert.equal(res.headers.get("content-encoding"), "gzip");
  assert.equal(res.headers.get("vary"), "Accept-Encoding");
  assert.equal(res.headers.get("etag"), 'W/"abc"', "a strong ETag no longer names these bytes");
  assert.equal(res.headers.get("content-length"), null);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.ok(bytes.length < BIG.length / 4);
  assert.equal(gunzipSync(bytes).toString(), BIG);

  const plain = compress(new Request(`${ORIGIN}/x`), new Response(BIG, { headers: { "content-type": "text/html" } }));
  assert.equal(plain.headers.get("content-encoding"), null);
  assert.equal(plain.headers.get("vary"), "Accept-Encoding", "caches must key on the encoding");
  assert.equal(await plain.text(), BIG);

  const keep = (res: Response, why: string) => assert.equal(res.headers.get("content-encoding"), null, why);
  keep(compress(gz(), new Response(BIG, { headers: { "content-type": "image/png" } })), "binary");
  keep(compress(gz(), new Response(BIG, { headers: { "content-type": "text/event-stream" } })), "SSE");
  keep(compress(gz(), new Response(BIG, { headers: { "content-type": "text/html", "x-accel-buffering": "no" } })), "streamed");
  keep(compress(gz(), new Response(BIG, { headers: { "content-type": "text/html", "cache-control": "no-transform" } })), "no-transform");
  const br = compress(gz(), new Response(BIG, { headers: { "content-type": "text/html", "content-encoding": "br" } }));
  assert.equal(br.headers.get("content-encoding"), "br", "already encoded");
  keep(compress(gz(), new Response("tiny", { headers: { "content-type": "text/html", "content-length": "4" } })), "small");
  keep(compress(new Request(`${ORIGIN}/x`, { method: "HEAD", headers: { "accept-encoding": "gzip" } }), new Response(BIG, { headers: { "content-type": "text/html" } })), "HEAD");
  const vary = compress(gz(), new Response(BIG, { headers: { "content-type": "text/css", vary: "Cookie" } }));
  assert.equal(vary.headers.get("vary"), "Cookie, Accept-Encoding");
});

test("the app compresses pages unless told not to", async () => {
  const Big = defineComponent("Big", () => ({ handlers: {}, render: () => BIG }));
  const on = createApp({ secret: SECRET, sync: false, routes: { "/": { component: Big } } });
  const res = (await on.fetch(gz()))!;
  assert.equal(res.status, 404);
  const page = (await on.fetch(new Request(`${ORIGIN}/`, { headers: { "accept-encoding": "gzip" } })))!;
  assert.equal(page.headers.get("content-encoding"), "gzip");
  assert.match(gunzipSync(new Uint8Array(await page.arrayBuffer())).toString(), /weft weft/);
  on.close();
  const off = createApp({ secret: SECRET, sync: false, compress: false, routes: { "/": { component: Big } } });
  const raw = (await off.fetch(new Request(`${ORIGIN}/`, { headers: { "accept-encoding": "gzip" } })))!;
  assert.equal(raw.headers.get("content-encoding"), null);
  off.close();
});

test("CSRF tokens are masked per issue and every masking verifies (BREACH)", async () => {
  const key = await importSecret(SECRET);
  const a = await csrfToken(key, "session-aaaaaaaaaaaa");
  const b = await csrfToken(key, "session-aaaaaaaaaaaa");
  assert.notEqual(a, b);
  assert.ok(await verifyCsrf(key, "session-aaaaaaaaaaaa", a));
  assert.ok(await verifyCsrf(key, "session-aaaaaaaaaaaa", b));
  assert.ok(!(await verifyCsrf(key, "session-bbbbbbbbbbbb", a)), "bound to its session");
  assert.ok(!(await verifyCsrf(key, "session-aaaaaaaaaaaa", a.slice(0, -2))));
  assert.ok(!(await verifyCsrf(key, "session-aaaaaaaaaaaa", a.slice(0, 43))), "half a token is no token");
  assert.ok(!(await verifyCsrf(key, "session-aaaaaaaaaaaa", "!" + a.slice(1))));
  assert.ok(!(await verifyCsrf(key, "session-aaaaaaaaaaaa", null)));
  const flipped = (a[10] === "A" ? "B" : "A");
  assert.ok(!(await verifyCsrf(key, "session-aaaaaaaaaaaa", a.slice(0, 10) + flipped + a.slice(11))));
});
