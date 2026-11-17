import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent } from "@weft/runtime";
import { createApp, type AppOptions } from "../src/app.ts";
import { fillPattern, robotsTxt, sitemapEntries, sitemapXml } from "../src/seo.ts";

const SITE = "https://app.example";
const Page = defineComponent("Page", () => ({ render: () => `<p>x</p>` })) as never;

test("entries: static routes, listed dynamic ones, exclusions, noindex", async () => {
  const routes = [
    { pattern: "/" },
    { pattern: "/about" },
    { pattern: "/account" },
    { pattern: "/admin/users" },
    { pattern: "/drafts", meta: { robots: "noindex, follow" } },
    { pattern: "/blog/[slug]" },
    { pattern: "/docs/[...path]" },
    { pattern: "/secret/[id]" },
  ];
  const updated = Date.UTC(2026, 10, 1);
  const out = await sitemapEntries(SITE, routes, {
    exclude: ["/account", /^\/admin(\/|$)/g],
    changeFrequency: "weekly",
    params: {
      "/blog/[slug]": () => [{ params: { slug: "hello world/é" }, lastModified: updated, priority: 0.8 }, { params: { slug: "second" } }],
      "/docs/[...path]": async () => [{ params: { path: ["guide", "a b"] } }],
    },
    extra: () => [{ url: "/feed.xml" }, { url: "https://evil.example/x" }, { url: "/about" }, { url: "javascript:alert(1)" }],
  });
  assert.deepEqual(
    out.map((e) => e.url),
    [
      `${SITE}/`,
      `${SITE}/about`,
      `${SITE}/blog/hello%20world%2F%C3%A9`,
      `${SITE}/blog/second`,
      `${SITE}/docs/guide/a%20b`,
      `${SITE}/feed.xml`,
    ],
    "sorted routes, then extra; other origins, duplicates and bad URLs left out",
  );
  assert.deepEqual(out[2], { url: `${SITE}/blog/hello%20world%2F%C3%A9`, changeFrequency: "weekly", lastModified: updated, priority: 0.8 });
  const twice = await sitemapEntries(SITE, [{ pattern: "/admin" }, { pattern: "/admin/x" }], { exclude: [/^\/admin/g] });
  assert.deepEqual(twice, []);

  await assert.rejects(sitemapEntries(SITE, routes, { params: { "/nope/[x]": () => [] } }), /not a route/);
  await assert.rejects(sitemapEntries(SITE, routes, { params: { "/blog/[slug]": () => [{ params: {} }] } }), /lacks its params/);
});

test("filling patterns refuses empty and dot segments", () => {
  assert.equal(fillPattern("/blog/[slug]", { slug: "a" }), "/blog/a");
  assert.equal(fillPattern("/blog/[slug]", { slug: ".." }), null);
  assert.equal(fillPattern("/blog/[slug]", { slug: "" }), null);
  assert.equal(fillPattern("/docs/[...p]", { p: [] }), null);
  assert.equal(fillPattern("/files/[[...p]]", { p: [] }), "/files");
  assert.equal(fillPattern("/files/[[...p]]", {}), "/files");
  assert.equal(fillPattern("/docs/[...p]", { p: ["a", "."] }), null);
});

test("XML is escaped and checked", () => {
  const xml = sitemapXml([{ url: "https://app.example/?a=1&b=<2>", lastModified: Date.UTC(2026, 0, 2), changeFrequency: "daily", priority: 1 }]);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  assert.match(xml, /<loc>https:\/\/app.example\/\?a=1&amp;b=%3C2%3E<\/loc><lastmod>2026-01-02T00:00:00.000Z<\/lastmod><changefreq>daily<\/changefreq><priority>1.0<\/priority>/);
  assert.throws(() => sitemapXml([{ url: "/relative" }]), /absolute/);
  assert.throws(() => sitemapXml([{ url: SITE, priority: 2 }]), /priority/);
  assert.throws(() => sitemapXml([{ url: SITE, lastModified: Number.NaN }]), /lastModified/);
  assert.throws(() => sitemapXml([{ url: SITE, changeFrequency: "often" as never }]), /changeFrequency/);
});

test("robots.txt: groups, an empty disallow, the sitemap, no injected lines", () => {
  const txt = robotsTxt(
    { rules: [{ userAgent: "*", disallow: ["/account", "/_weft/"] }, { userAgent: ["GPTBot", "CCBot"], crawlDelay: 10 }], sitemap: `${SITE}/other.xml` },
    `${SITE}/sitemap.xml`,
  );
  assert.equal(
    txt,
    [
      "User-agent: *",
      "Disallow: /account",
      "Disallow: /_weft/",
      "",
      "User-agent: GPTBot",
      "User-agent: CCBot",
      "Disallow:",
      "Crawl-delay: 10",
      "",
      `Sitemap: ${SITE}/other.xml`,
      `Sitemap: ${SITE}/sitemap.xml`,
      "",
    ].join("\n"),
  );
  assert.throws(() => robotsTxt({ rules: [{ userAgent: "*", disallow: ["/a\nAllow: /admin"] }] }), /one line/);
  assert.throws(() => robotsTxt({ rules: [{ userAgent: [] }] }), /userAgent/);
  assert.throws(() => robotsTxt({ rules: [{ userAgent: "*" }], sitemap: "/sitemap.xml" }), /absolute/);
});

test("the app serves them when configured, on siteUrl whatever the Host", async () => {
  const make = (extra: Partial<AppOptions>) =>
    createApp({
      secret: "test-secret-test-secret-test-secret!",
      routes: { "/": { component: Page }, "/blog/[slug]": { component: Page }, "/hidden": { component: Page, meta: { robots: "noindex" } } },
      onError: () => {},
      ...extra,
    });
  const bare = make({});
  assert.equal((await bare.fetch(new Request("http://evil.example/sitemap.xml")))!.status, 404, "not served unless configured");
  assert.equal((await bare.fetch(new Request("http://evil.example/robots.txt")))!.status, 404);

  let fail = false;
  const app = make({
    siteUrl: SITE,
    sitemap: {
      params: {
        "/blog/[slug]": () => {
          if (fail) throw new Error("db down");
          return [{ params: { slug: "a" } }];
        },
      },
    },
    robots: { rules: [{ userAgent: "*", disallow: ["/hidden"] }] },
  });
  const map = (await app.fetch(new Request("http://evil.example/sitemap.xml")))!;
  assert.equal(map.status, 200);
  assert.equal(map.headers.get("content-type"), "application/xml; charset=utf-8");
  assert.equal(map.headers.get("cache-control"), "public, max-age=3600");
  const xml = await map.text();
  assert.deepEqual([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), [`${SITE}/`, `${SITE}/blog/a`]);
  const robots = (await app.fetch(new Request("http://evil.example/robots.txt")))!;
  assert.equal(await robots.text(), `User-agent: *\nDisallow: /hidden\n\nSitemap: ${SITE}/sitemap.xml\n`);
  assert.equal((await app.fetch(new Request(`${SITE}/robots.txt`, { method: "POST" })))!.status, 405);
  const head = (await app.fetch(new Request(`${SITE}/sitemap.xml`, { method: "HEAD" })))!;
  assert.deepEqual([head.status, await head.text()], [200, ""]);
  fail = true;
  assert.equal((await app.fetch(new Request(`${SITE}/sitemap.xml`)))!.status, 500, "a failing list is an error, not a short sitemap");

  assert.throws(() => make({ sitemap: {} }), /siteUrl/);
  assert.throws(() => make({ siteUrl: SITE, sitemap: { priority: 3 } }), /priority/);
  assert.throws(() => make({ robots: { rules: [{ userAgent: "*\nX" }] } }), /one line/);
});
