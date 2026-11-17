import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { defineComponent, escapeHtml, signal } from "@weft-framework/runtime";
import { createApp, edgeReason, type AppOptions, type Route } from "../src/app.ts";

const ORIGIN = "http://app.test";
const SECRET = "edge-test-secret-0123456789abcdefgh";

const Text = defineComponent(
  "EdgeText",
  (p: { title?: string; slug?: string }) => ({ handlers: {}, render: () => `<h1>${escapeHtml(p.title ?? p.slug ?? "Terms")}</h1>` }),
  { inert: true, css: ".t{color:red}" },
);
const Signup = defineComponent(
  "EdgeSignup",
  () => ({ handlers: {}, render: () => `<form method="post" action="/_weft/action/join"><button>Join</button></form>` }),
  { inert: true },
);
const Counter = defineComponent("EdgeCounter", () => {
  const n = signal(0);
  return { handlers: { add: () => void (n.value += 1) }, render: () => `<button data-weft-on-click="add">${n.value}</button>` };
});

const routes: Record<string, Route<never>> = {
  "/terms": { component: Text as never },
  "/docs/[slug]": { component: Text as never },
  "/me": { component: Text as never, load: () => ({ title: "me" }) as never },
  "/count": { component: Counter as never },
  "/join": { component: Signup as never },
  "/private": { component: Text as never, edge: false },
};

const app = (extra: Partial<AppOptions> = {}) => createApp({ secret: SECRET, routes, onError: () => {}, ...extra });
const get = async (a: ReturnType<typeof app>, path: string, headers: Record<string, string> = {}) =>
  (await a.fetch(new Request(ORIGIN + path, { headers })))!;

test("a page that is the same for everyone is shared: no cookie, token or nonce", async () => {
  const a = app();
  const res = await get(a, "/terms");
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=0, s-maxage=300, stale-while-revalidate=86400");
  assert.equal(res.headers.get("set-cookie"), null, "a first visit gets no session on a shared copy");
  assert.ok(!html.includes("weft-csrf") && !html.includes("nonce="), html);
  const csp = res.headers.get("content-security-policy")!;
  const style = /<style>([^<]*)<\/style>/.exec(html)![1]!;
  assert.ok(csp.includes(`'sha256-${createHash("sha256").update(style).digest("base64")}'`), csp);
  assert.ok(!csp.includes("nonce-"), csp);
  const again = await get(a, "/terms", { cookie: "weft_session=whatever" });
  assert.equal(await again.text(), html, "byte for byte");
  const etag = res.headers.get("etag")!;
  assert.equal((await get(a, "/terms", { "if-none-match": etag })).status, 304);
  assert.match((await get(a, "/docs/intro")).headers.get("cache-control")!, /s-maxage/);
});

test("anything that could differ per visitor stays private", async () => {
  const a = app();
  for (const path of ["/me", "/count", "/join", "/private"]) {
    const res = await get(a, path);
    await res.body?.cancel();
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.ok(res.headers.get("set-cookie"), `${path} starts a session`);
  }
  for (const opts of [{ edge: false as const }, { devtools: true }]) {
    const res = await get(app(opts), "/terms");
    await res.body?.cancel();
    assert.equal(res.headers.get("cache-control"), "no-store", JSON.stringify(opts));
  }
  const custom = await get(app({ edge: { maxAge: 60, stale: 0 } }), "/terms");
  assert.equal(custom.headers.get("cache-control"), "public, max-age=0, s-maxage=60, stale-while-revalidate=0");
  assert.throws(() => app({ edge: { maxAge: -1 } }), /whole seconds/);
});

test("middleware and <html> attributes need the page's word, and never leak a visitor's", async () => {
  const gated = app({ middleware: () => undefined });
  const res = await get(gated, "/terms");
  await res.body?.cancel();
  assert.equal(res.headers.get("cache-control"), "no-store", "middleware may gate the page");

  const vouched = { ...routes, "/terms": { component: Text as never, edge: true } };
  const themed = createApp({
    secret: SECRET,
    routes: vouched,
    htmlAttributes: (req) => ({ "data-theme": /theme=dark/.test(req.headers.get("cookie") ?? "") ? "dark" : "light" }),
  });
  const dark = await get(themed, "/terms", { cookie: "theme=dark" });
  const html = await dark.text();
  assert.match(dark.headers.get("cache-control")!, /s-maxage/);
  assert.match(html, /data-theme="light"/, "the shared copy has no visitor's preferences");

  const cookied = createApp({
    secret: SECRET,
    routes: vouched,
    middleware: () => ({ headers: { vary: "Cookie" } }),
  });
  const res2 = await get(cookied, "/terms");
  await res2.body?.cancel();
  assert.equal(res2.headers.get("cache-control"), "private, no-store");
  assert.equal(res2.headers.get("etag"), null);
});

test("edgeReason names why a route is served from the origin", () => {
  const r = (x: Partial<Route<never>>) => ({ component: Text as never, ...x }) as Route<never>;
  assert.equal(edgeReason(r({}), {}), null);
  assert.equal(edgeReason(r({ load: () => ({}) as never }), {}), "load");
  assert.equal(edgeReason(r({ meta: () => ({}) }), {}), "meta from the request");
  assert.equal(edgeReason(r({ cache: "etag" }), {}), 'cache: "etag"');
  assert.equal(edgeReason(r({ edge: false }), {}), "edge: false");
  assert.match(edgeReason(r({}), { middleware: () => undefined })!, /^middleware/);
  assert.equal(edgeReason(r({}), { middleware: [] }), null);
  assert.equal(edgeReason(r({ edge: true }), { middleware: () => undefined, htmlAttributes: () => ({}) }), null);
});
