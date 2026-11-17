import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineComponent } from "@weft-framework/runtime";
import { createApp, type AppOptions } from "../src/app.ts";
import { ConfigError, parseConfig, resolveSecret } from "../src/config.ts";
import { loadConfig } from "../src/load-config.ts";
import { applySite } from "../src/meta.ts";

const SECRET = "section3-test-secret-0123456789abcd";
const ORIGIN = "http://app.test";

const Page = defineComponent("Page", (props: { title?: string }) => ({
  handlers: {},
  render: () => `<h1>${props.title ?? "ok"}</h1>`,
}));

const Broken = defineComponent("Broken", () => ({
  handlers: {},
  render: () => {
    throw new Error("password=hunter2");
  },
}));

function app(extra: Partial<AppOptions> = {}) {
  return createApp({
    secret: SECRET,
    routes: { "/": { component: Page as never, title: "Home" }, "/boom": { component: Broken as never } },
    onError: () => {},
    ...extra,
  });
}

async function send(a: ReturnType<typeof app>, path: string, init: RequestInit = {}) {
  const res = (await a.fetch(new Request(ORIGIN + path, init)))!;
  return { res, text: await res.text() };
}

test("config accepts an origin, a port, and a secret source, and rejects the rest", () => {
  const config = parseConfig({
    port: 8080,
    host: "127.0.0.1",
    secret: { env: "WEFT_SECRET" },
    siteUrl: "https://example.com/",
    cookieName: "sid",
    meta: { title: "Site", description: "Hello" },
  });
  assert.equal(config.port, 8080);
  assert.equal(config.siteUrl, "https://example.com");
  assert.equal(config.secret?.env, "WEFT_SECRET");
  assert.equal(config.meta?.title, "Site");

  assert.throws(() => parseConfig({ secret: "abcdefghijklmnopqrstuvwxyz012345" }), ConfigError);
  assert.throws(() => parseConfig({ siteUrl: "https://user:pass@example.com" }), ConfigError);
  assert.throws(() => parseConfig({ siteUrl: "javascript:alert(1)" }), ConfigError);
  assert.throws(() => parseConfig({ siteUrl: "https://example.com/app" }), ConfigError);
  assert.throws(() => parseConfig({ port: -1 }), ConfigError);
  assert.throws(() => parseConfig({ host: "bad host" }), ConfigError);
  assert.throws(() => parseConfig({ cookieName: "a=b" }), ConfigError);
  assert.throws(() => parseConfig({ meta: { title: "a\nb" } }), ConfigError);
  assert.throws(() => parseConfig({ extra: true }), ConfigError);
  assert.throws(() => parseConfig(JSON.parse('{"__proto__":{"polluted":true}}')), ConfigError);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);

  const secret = "s".repeat(32);
  assert.equal(resolveSecret(config, { WEFT_SECRET: secret }, false), secret);
  assert.throws(() => resolveSecret(config, { WEFT_SECRET: "short-secret" }, false), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.message.includes("short-secret"), false);
    return true;
  });
  assert.throws(() => resolveSecret({}, {}, true), /production requires a session secret/);
  assert.equal(resolveSecret({}, { WEFT_SECRET: "x".repeat(32) }, true), "x".repeat(32), "production falls back to WEFT_SECRET");
  assert.throws(() => resolveSecret({}, { WEFT_SECRET: "short" }, true), /at least 32/);
  assert.equal(resolveSecret({}, { WEFT_SECRET: "x".repeat(32) }, false), null, "dev keeps its per-run secret");
  assert.equal(resolveSecret({}, {}, false), null);
});

test("loadConfig reads weft.config.ts and refuses a literal secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-config-"));
  try {
    writeFileSync(join(dir, "weft.config.ts"), `export default { port: 3210, siteUrl: "https://example.com" }\n`);
    const loaded = await loadConfig(dir, "1");
    assert.equal(loaded.port, 3210);
    assert.equal(loaded.siteUrl, "https://example.com");
    writeFileSync(join(dir, "weft.config.js"), "export default {}\n");
    await assert.rejects(loadConfig(dir, "2"), /both weft.config.ts and weft.config.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("siteUrl expands root-relative canonical and social URLs only", () => {
  const meta = applySite(
    { canonical: "/posts/1", openGraph: { url: "/posts/1", image: "https://cdn.test/a.png" }, title: "T" },
    "https://example.com",
  );
  assert.equal(meta.canonical, "https://example.com/posts/1");
  assert.equal(meta.openGraph?.url, "https://example.com/posts/1");
  assert.equal(meta.openGraph?.image, "https://cdn.test/a.png");
  assert.equal(applySite({ canonical: "//evil.test/x" }, "https://example.com").canonical, "//evil.test/x");
});

test("a thrown load or render shows the error page and not the exception", async () => {
  const seen: string[] = [];
  const Err = defineComponent("Err", () => ({ handlers: {}, render: () => "<h1>Something went wrong</h1>" }));
  const a = app({
    error: { component: Err as never, title: "Error" },
    routes: {
      "/": { component: Page as never, load: () => { throw new Error("password=hunter2"); } },
      "/render": { component: Broken as never },
    },
    onError: (err) => seen.push(err instanceof Error ? err.message : ""),
  });
  for (const path of ["/", "/render"]) {
    const res = await send(a, path);
    assert.equal(res.res.status, 500, path);
    assert.match(res.text, /Something went wrong/);
    assert.equal(res.text.includes("hunter2"), false, path);
    assert.equal(res.text.includes("password"), false, path);
  }
  assert.ok(seen.some((m) => m.includes("hunter2")));

  const Falling = defineComponent("Falling", () => ({
    handlers: {},
    render: () => {
      throw new Error("secret=xyzzy");
    },
  }));
  const b = app({
    error: { component: Falling as never },
    routes: { "/": { component: Page as never, load: () => { throw new Error("password=hunter2"); } } },
    onError: () => {},
  });
  const fallback = await send(b, "/");
  assert.equal(fallback.res.status, 500);
  assert.equal(fallback.text, "Server error");
  assert.equal(fallback.text.includes("hunter2") || fallback.text.includes("xyzzy"), false);
});

test("api routes enforce method, origin, CSRF, body size, and redirect targets", async () => {
  const a = app({
    api: {
      "/api/health": {
        GET: () => Response.json({ ok: true }),
        POST: async (ctx) => {
          const body = await ctx.request.text();
          if (body === "redirect") {
            return new Response(null, { status: 302, headers: { location: "https://evil.test/phish" } });
          }
          return Response.json({ echo: body });
        },
      },
    },
  });
  const health = await send(a, "/api/health");
  assert.equal(health.res.status, 200);
  assert.deepEqual(JSON.parse(health.text), { ok: true });
  assert.match(health.res.headers.get("set-cookie") ?? "", /HttpOnly/);
  const cookie = (health.res.headers.get("set-cookie") ?? "").split(";")[0];
  const csrf = health.res.headers.get("x-weft-csrf") ?? "";
  assert.ok(csrf.length > 10);

  const cross = await send(a, "/api/health", {
    method: "POST",
    headers: { origin: "https://evil.test", cookie, "x-weft-csrf": csrf },
    body: "hi",
  });
  assert.equal(cross.res.status, 403);
  assert.equal(cross.text.includes("evil.test"), false);

  const missing = await send(a, "/api/health", { method: "POST", headers: { origin: ORIGIN, cookie }, body: "hi" });
  assert.equal(missing.res.status, 403);

  const posted = await send(a, "/api/health", {
    method: "POST",
    headers: { origin: ORIGIN, cookie, "x-weft-csrf": csrf },
    body: "hi",
  });
  assert.equal(posted.res.status, 200);
  assert.deepEqual(JSON.parse(posted.text), { echo: "hi" });

  const phish = await send(a, "/api/health", {
    method: "POST",
    headers: { origin: ORIGIN, cookie, "x-weft-csrf": csrf },
    body: "redirect",
  });
  assert.equal(phish.res.status, 500);
  assert.equal(phish.text.includes("evil.test"), false);

  const put = await send(a, "/api/health", { method: "PUT", headers: { origin: ORIGIN, cookie, "x-weft-csrf": csrf } });
  assert.equal(put.res.status, 405);
  assert.match(put.res.headers.get("allow") ?? "", /GET/);
  assert.equal((put.res.headers.get("allow") ?? "").includes("PUT"), false);

  const huge = await send(a, "/api/health", {
    method: "POST",
    headers: { origin: ORIGIN, cookie, "x-weft-csrf": csrf, "content-length": String(300 * 1024) },
    body: "x".repeat(300 * 1024),
  });
  assert.equal(huge.res.status, 413);

  const leaked = await send(
    app({
      api: { "/api/boom": { GET: () => { throw new Error("password=hunter2"); } } },
      onError: () => {},
    }),
    "/api/boom",
  );
  assert.equal(leaked.res.status, 500);
  assert.equal(leaked.text.includes("hunter2"), false);
});

test("middleware can guard and add headers, and cannot replace the security policy", async () => {
  let rendered = false;
  const Guarded = defineComponent("Guarded", () => ({
    handlers: {},
    render: () => {
      rendered = true;
      return "<h1>secret</h1>";
    },
  }));
  const a = app({
    routes: { "/": { component: Page as never, title: "Home" }, "/private": { component: Guarded as never } },
    middleware: [
      () => ({ headers: { "x-request-id": "abc", "content-security-policy": "default-src *", "x-bad": "a\r\nSet-Cookie: pwn=1" } }),
      (ctx) => (ctx.url.pathname === "/private" ? Response.redirect(`${ORIGIN}/`, 303) : undefined),
    ],
  });
  const home = await send(a, "/");
  assert.equal(home.res.headers.get("x-request-id"), "abc");
  assert.equal(home.res.headers.get("x-bad"), null);
  const csp = home.res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /nonce-/);
  assert.equal(csp.includes("default-src *"), false);
  assert.equal((home.res.headers.get("set-cookie") ?? "").includes("pwn=1"), false);

  rendered = false;
  const blocked = await send(a, "/private");
  assert.equal(blocked.res.status, 303);
  assert.equal(blocked.res.headers.get("location"), `${ORIGIN}/`);
  assert.equal(rendered, false);
});

test("a middleware rewrite routes the request, keeps its URL, and refuses unsafe targets", async () => {
  const About = defineComponent("About", (props: { path?: string; slug?: string }) => ({
    handlers: {},
    render: () => `<p>about ${props.path ?? ""} ${props.slug ?? ""}</p>`,
  }));
  const a = app({
    routes: {
      "/": { component: Page as never, title: "Home" },
      "/about/[slug]": { component: About as never, load: (ctx) => ({ path: ctx.url.pathname, slug: ctx.params.slug }) },
    },
    middleware: [
      (ctx) => {
        const m = /^\/cs\/o-nas\/(.+)$/.exec(ctx.url.pathname);
        return m ? { rewrite: `/about/${m[1]}` } : undefined;
      },
      (ctx) => (ctx.url.pathname === "/evil" ? { rewrite: "/_weft/live/sse" } : undefined),
      (ctx) => (ctx.url.pathname === "/up" ? { rewrite: "/about/../boom" } : undefined),
      (ctx) => (ctx.url.pathname === "/far" ? { rewrite: "//other.test/about/x" } : undefined),
    ],
  });
  const cs = await send(a, "/cs/o-nas/tym");
  assert.equal(cs.res.status, 200);
  assert.match(cs.text, /about \/cs\/o-nas\/tym tym/, "params from the rewrite, URL as sent");
  for (const path of ["/evil", "/up", "/far"]) {
    assert.equal((await send(a, path)).res.status, 404, path);
  }
});

test("<html lang>: page metadata first, then htmlAttributes (a locale), else en", async () => {
  const a = app({
    routes: { "/": { component: Page as never }, "/fixed": { component: Page as never, meta: { lang: "de" } } },
    htmlAttributes: (req) => ({ lang: new URL(req.url).searchParams.get("l") ?? undefined, dir: "rtl" }),
  });
  assert.match((await send(a, "/?l=ar")).text, /<html dir="rtl" lang="ar">/);
  assert.match((await send(a, "/fixed?l=ar")).text, /<html dir="rtl" lang="de">/);
  assert.match((await send(a, "/")).text, /<html dir="rtl" lang="en">/);
  assert.match((await send(a, "/?l=x%22y")).text, /lang="en"/, "a value that is not a language tag is refused");
});

test("prefetch is rate limited and does not evict a page that has a stream", async () => {
  const Other = defineComponent("Other", () => ({ handlers: {}, render: () => "<p>other</p>" }));
  const Third = defineComponent("Third", () => ({ handlers: {}, render: () => "<p>third</p>" }));
  const a = app({
    maxPages: 2,
    routes: {
      "/": { component: Page as never },
      "/a": { component: Other as never },
      "/b": { component: Third as never },
    },
  });
  const home = await send(a, "/");
  const cookie = (home.res.headers.get("set-cookie") ?? "").split(";")[0];
  const lid = /name="weft-live" content="([^"]+)"/.exec(home.text)?.[1] ?? "";
  const sse = (await a.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } })))!;
  assert.equal(sse.status, 200);
  const prefetch = (path: string) =>
    a.fetch(new Request(ORIGIN + path, { headers: { cookie, "x-weft-prefetch": "1" } }));
  assert.equal((await prefetch("/a"))?.status, 200);
  assert.equal((await prefetch("/b"))?.status, 200);
  const still = (await a.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } })))!;
  assert.equal(still.status, 200);
  await sse.body?.cancel();
  await still.body?.cancel();
  for (let i = 0; i < 20; i += 1) {
    await prefetch("/a");
  }
  const limited = await prefetch("/a");
  assert.equal(limited?.status, 429);
});
