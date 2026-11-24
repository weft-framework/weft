import { test } from "node:test";
import assert from "node:assert/strict";
import { atomXml, defineFeed, feedXml, rssXml, type Feed } from "../src/feed.ts";

const feed = (): Feed => ({
  title: "News & notes",
  siteUrl: "https://app.example/",
  feedUrl: "https://app.example/blog/rss.xml",
  description: "Updates <from> the team",
  language: "en",
  author: "Team",
  items: [
    { url: "https://app.example/blog/old", title: "Old", published: Date.UTC(2026, 0, 1) },
    { url: "https://app.example/blog/new", title: "New \u0001 <b>post</b>", summary: "A & B", content: "<p>Hi</p>", published: Date.UTC(2026, 5, 1), updated: Date.UTC(2026, 5, 2), categories: ["release", " "], author: "Ana" },
  ],
});

test("rss: channel, self link, newest first, escaped, control chars dropped", () => {
  const xml = rssXml(feed());
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<title>News &amp; notes<\/title>/);
  assert.match(xml, /<atom:link href="https:\/\/app.example\/blog\/rss.xml" rel="self" type="application\/rss\+xml"\/>/);
  assert.match(xml, /<description>Updates &lt;from&gt; the team<\/description>/);
  assert.match(xml, /<language>en<\/language>/);
  assert.ok(xml.indexOf("/blog/new") < xml.indexOf("/blog/old"));
  assert.match(xml, /<title>New  &lt;b&gt;post&lt;\/b&gt;<\/title>/);
  assert.ok(!xml.includes("\u0001"));
  assert.match(xml, /<guid isPermaLink="true">https:\/\/app.example\/blog\/new<\/guid>/);
  assert.match(xml, /<content:encoded>&lt;p&gt;Hi&lt;\/p&gt;<\/content:encoded>/);
  assert.match(xml, /<dc:creator>Ana<\/dc:creator>/);
  assert.match(xml, /<dc:creator>Team<\/dc:creator>/);
  assert.equal((xml.match(/<category>/g) ?? []).length, 1);
  assert.match(xml, /<pubDate>Mon, 01 Jun 2026 00:00:00 GMT<\/pubDate>/);
  assert.match(xml, /<lastBuildDate>Tue, 02 Jun 2026 00:00:00 GMT<\/lastBuildDate>/);
});

test("atom: ids, links, dates, lang", () => {
  const xml = atomXml(feed());
  assert.match(xml, /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom" xml:lang="en">/);
  assert.match(xml, /<id>https:\/\/app.example\/blog\/rss.xml<\/id>/);
  assert.match(xml, /<link href="https:\/\/app.example\/blog\/rss.xml" rel="self" type="application\/atom\+xml"\/>/);
  assert.match(xml, /<updated>2026-06-02T00:00:00.000Z<\/updated>/);
  assert.match(xml, /<author><name>Team<\/name><\/author>/);
  assert.match(xml, /<summary type="text">A &amp; B<\/summary>/);
  assert.match(xml, /<category term="release"\/>/);
});

test("limit keeps the newest items", () => {
  const xml = feedXml(feed(), { format: "atom", limit: 1 });
  assert.ok(xml.includes("/blog/new"));
  assert.ok(!xml.includes("/blog/old"));
});

test("explicit id is not a permalink", () => {
  const f = feed();
  const xml = rssXml({ ...f, items: [{ ...f.items[0]!, id: "tag:app.example,2026:1" }] });
  assert.match(xml, /<guid isPermaLink="false">tag:app.example,2026:1<\/guid>/);
});

test("rejects bad input", () => {
  assert.throws(() => rssXml({ ...feed(), siteUrl: "/relative" }), /siteUrl/);
  assert.throws(() => rssXml({ ...feed(), feedUrl: "javascript:alert(1)" }), /feedUrl/);
  assert.throws(() => rssXml({ ...feed(), title: " " }), /title is required/);
  assert.throws(() => rssXml({ ...feed(), language: "en_US!" }), /language/);
  assert.throws(() => rssXml({ ...feed(), items: [{ url: "https://a.example/", title: "x", published: Number.NaN }] }), /bad date/);
  assert.throws(() => rssXml({ ...feed(), items: [{ url: "ftp://a.example/", title: "x", published: 0 }] }), /items\[0\]\.url/);
  assert.throws(() => feedXml(feed(), { limit: 0 }), /limit/);
  assert.throws(() => feedXml(feed(), { format: "json" as never }), /format/);
  assert.throws(() => defineFeed(feed, { maxAge: -1 }), /maxAge/);
});

test("defineFeed: headers, etag revalidation, HEAD", async () => {
  let calls = 0;
  const handler = defineFeed(() => {
    calls++;
    return feed();
  }, { format: "atom", maxAge: 60 });
  const res = await handler(new Request("https://app.example/feed"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/atom+xml; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const etag = res.headers.get("etag")!;
  assert.match(etag, /^W\/"[A-Za-z0-9_-]+"$/);
  assert.match(await res.text(), /<feed /);
  const again = await handler(new Request("https://app.example/feed", { headers: { "if-none-match": `"other", ${etag}` } }));
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  const head = await handler(new Request("https://app.example/feed", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const bare = await handler();
  assert.equal(bare.status, 200);
  assert.equal(calls, 4);
});
