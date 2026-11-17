import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fromDom,
  isEmptyRichText,
  mentionsIn,
  parseRichText,
  renderRichText,
  richLink,
  richTextToPlain,
  type RichDoc,
  type RichDomNode,
} from "../src/richtext.ts";

const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, extra: object = {}) => ({ type: "text", text, ...extra });
const doc = (...content: unknown[]) => ({ type: "doc", content });
const ok = (v: unknown, limits = {}) => {
  const r = parseRichText(v, limits);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.doc;
};
const bad = (v: unknown, re: RegExp, limits = {}) => {
  const r = parseRichText(v, limits);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, re);
};

test("documents are checked and normalised", () => {
  const d = ok(
    JSON.stringify(
      doc(
        p(t("Hi "), t("there", { marks: ["italic", "bold", "bold"] }), t("\nnext line\u0000"), { type: "mention", id: "u_1", label: "  Ada   L " }),
        { type: "heading", level: 2, content: [t("Title")] },
        { type: "list", ordered: true, items: [[p(t("one"))], [{ type: "quote", content: [p(t("deep"))] }]] },
        { type: "code", text: "a < b\r\nc" },
        { type: "image", src: "file_abc", alt: "A cat" },
        { type: "rule" },
      ),
    ),
  );
  assert.deepEqual(d.content[0], {
    type: "paragraph",
    content: [
      t("Hi "),
      t("there", { marks: ["bold", "italic"] }),
      { type: "break" },
      t("next line"),
      { type: "mention", id: "u_1", label: "Ada L" },
    ],
  });
  assert.deepEqual(d.content[3], { type: "code", text: "a < b\nc" });
  assert.deepEqual(mentionsIn(d), ["u_1"]);
  assert.equal(richTextToPlain(d), "Hi there\nnext line@Ada L\nTitle\n1. one\n2. > deep\na < b\nc\nA cat");
  assert.equal(isEmptyRichText(ok(doc(p(t("  ")), p()))), true, "only spaces");
  assert.equal(isEmptyRichText(ok(doc({ type: "rule" }))), false);
  assert.equal(isEmptyRichText(ok(doc(p()))), true);

  assert.deepEqual(ok(doc(p(t("a"), t("b"), { type: "break" }))).content[0], p(t("ab")));

  bad(doc({ type: "script", text: "x" }), /unknown block/);
  bad(doc(p(t("x", { style: "color:red" }))), /unknown property/);
  bad(doc(p({ type: "html", html: "<b>" })), /unknown inline/);
  bad(doc(p(t("x", { marks: ["blink"] }))), /mark blink/);
  bad(doc({ type: "heading", level: 4, content: [] }), /level/);
  bad(doc(p({ type: "mention", id: "a b", label: "x" })), /mention/);
  bad(doc({ type: "image", src: "java script:x" }), /src/);
  bad({ type: "doc", content: [], __proto__: { x: 1 }, extra: 1 }, /unknown property/);
  bad("<p>html</p>", /not a document/);
  bad(doc(p(t("x", { href: "javascript:alert(1)" }))), /link/);
  bad(doc(p(t("x", { href: "//evil.example" }))), /link/);
});

test("limits and feature switches", () => {
  bad(doc(p(t("x".repeat(11)))), /more than 10 characters/, { maxText: 10 });
  bad(doc(p(), p(), p()), /more than 2 blocks/, { maxBlocks: 2 });
  let deep: unknown = p(t("x"));
  for (let i = 0; i < 6; i++) deep = { type: "quote", content: [deep] };
  bad(doc(deep), /nested more than 4/);
  bad(doc(p({ type: "mention", id: "a", label: "a" }, { type: "mention", id: "b", label: "b" })), /more than 1 mentions/, { maxMentions: 1 });
  const plain = { allow: { headings: false, images: false, links: false, marks: ["bold"] as const } };
  bad(doc({ type: "heading", level: 1, content: [] }), /headings not allowed/, plain);
  bad(doc({ type: "image", src: "x" }), /images not allowed/, plain);
  bad(doc(p(t("x", { href: "https://a.example" }))), /links not allowed/, plain);
  bad(doc(p(t("x", { marks: ["italic"] }))), /mark italic/, plain);
  ok(doc(p(t("x", { marks: ["bold"] }))), plain);
  let worst: unknown = p();
  for (let i = 0; i < 20_000; i++) worst = { type: "quote", content: [worst] };
  assert.equal(parseRichText(doc(worst), { maxDepth: Infinity }).ok, false);
});

test("links", () => {
  for (const good of ["https://a.example/x?y#z", "http://a.example", "mailto:a@example.com", "/docs", "#top"]) assert.equal(richLink(good), good);
  for (const evil of ["javascript:alert(1)", "JaVaScRiPt:x", " javascript:x", "data:text/html,x", "//evil.example", "/\\evil.example", "vbscript:x", "ftp://x", "", "https://a.example/ x"]) {
    assert.equal(richLink(evil), null, evil);
  }
});

test("rendering escapes text, checks URLs and resolves mentions now", () => {
  const d: RichDoc = ok(
    doc(
      p(
        t("<script>alert(1)</script> & \"q\"", { marks: ["bold", "code"] }),
        t("site", { href: "/x" }),
        t("out", { href: "https://other.example/?a=1&b=\"2\"" }),
        t("home", { href: "https://app.example/y" }),
        { type: "mention", id: "u1", label: "Old name" },
        { type: "mention", id: "u2", label: "<img src=x onerror=alert(1)>" },
      ),
      { type: "heading", level: 3, content: [t("H")] },
      { type: "image", src: "file_1", alt: "\"><script>" },
      { type: "image", src: "https://cdn.example/a.png", alt: "" },
      { type: "image", src: "unknown", alt: "" },
      { type: "code", text: "</code><script>" },
    ),
  );
  const html = String(
    renderRichText(d, {
      origin: "https://app.example",
      headingOffset: 4,
      mention: (id) => (id === "u1" ? { label: "Ada", href: "/u/u1" } : null),
      image: (src) => (src === "file_1" ? "/_weft/files/f1?sig=a&b" : src.startsWith("https://") ? src : null),
    }),
  );
  assert.doesNotMatch(html, /<script|<img src=x|<img [^>]*onerror/, "markup in text stays text");
  assert.match(html, /<p><strong><code>&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;q&quot;<\/code><\/strong>/);
  assert.match(html, /<a href="\/x">site<\/a>/);
  assert.match(html, /<a href="https:\/\/other\.example\/\?a=1&amp;b=&quot;2&quot;" rel="noopener noreferrer nofollow ugc">out<\/a>/);
  assert.match(html, /<a href="https:\/\/app\.example\/y">home<\/a>/, "own origin is not external");
  assert.match(html, /<a href="\/u\/u1" data-mention="u1" data-label="Old name">@Ada<\/a>/);
  assert.match(html, /<span data-mention="u2" data-label="&lt;img src=x onerror=alert\(1\)&gt;">@&lt;img/);
  assert.match(html, /<h6>H<\/h6>/, "offset capped at h6");
  assert.match(html, /<img src="\/_weft\/files\/f1\?sig=a&amp;b" alt="&quot;&gt;&lt;script&gt;" data-src="file_1" loading="lazy">/);
  assert.match(html, /src="https:\/\/cdn\.example\/a\.png"/);
  assert.equal(html.match(/<img/g)!.length, 2, "an unresolved image is dropped");
  assert.match(html, /<pre><code>&lt;\/code&gt;&lt;script&gt;<\/code><\/pre>/);

  assert.equal(String(renderRichText(JSON.stringify(doc(p(t("x")))))), "<p>x</p>");
  assert.equal(String(renderRichText('{"type":"doc","content":[{"type":"raw","html":"<script>"}]}')), "");
  assert.equal(String(renderRichText(null)), "");
  assert.equal(String(renderRichText(ok(doc({ type: "image", src: "x", alt: "" })), { image: () => "javascript:alert(1)" })), "");
  assert.doesNotMatch(String(renderRichText(ok(doc(p({ type: "mention", id: "a", label: "a" }))), { mention: () => ({ href: "javascript:x" }) })), /href/);
});

function el(name: string, attrs: Record<string, string>, ...kids: (RichDomNode | string)[]): RichDomNode {
  const childNodes = kids.map((k) => (typeof k === "string" ? txt(k) : k));
  return {
    nodeType: 1,
    nodeName: name,
    childNodes,
    get textContent() {
      return childNodes.map((c) => c.textContent).join("");
    },
    getAttribute: (a) => (Object.hasOwn(attrs, a) ? attrs[a]! : null),
  };
}
function txt(s: string): RichDomNode {
  return { nodeType: 3, nodeName: "#text", childNodes: [], textContent: s };
}

test("fromDom reads an editable element, pasted markup included, and round-trips", () => {
  const root = el(
    "DIV",
    {},
    "loose  text ",
    el("B", {}, "bold"),
    el("H4", {}, "  Small heading "),
    el("P", { style: "color:red", onclick: "x()" }, el("A", { href: "javascript:alert(1)" }, "bad link"), " and ", el("A", { href: "https://a.example" }, el("EM", {}, "good"))),
    el("SCRIPT", {}, "alert(1)"),
    el("UL", {}, el("LI", {}, "one"), txt("\n"), el("LI", {}, el("P", {}, "two"))),
    el("PRE", {}, "x < y\n"),
    el("P", {}, "Hi ", el("SPAN", { "data-mention": "u1", "data-label": "Ada" }, "@Ada"), el("BR", {}), "bye"),
    el("IMG", { src: "/_weft/files/f1?sig=1", "data-src": "file_1", alt: "cat" }),
    el("IMG", { src: "data:image/png;base64,AAAA" }),
    el("TABLE", {}, el("TR", {}, el("TD", {}, "cell"))),
    el("STYLE", {}, "p{}"),
    el("svg", {}, el("script", {}, "alert(1)")),
  );
  const d = fromDom(root);
  assert.deepEqual(d.content, [
    p(t("loose text "), t("bold", { marks: ["bold"] })),
    { type: "heading", level: 3, content: [t("Small heading")] },
    p(t("bad link and "), t("good", { marks: ["italic"], href: "https://a.example" })),
    { type: "list", ordered: false, items: [[p(t("one"))], [p(t("two"))]] },
    { type: "code", text: "x < y" },
    p(t("Hi "), { type: "mention", id: "u1", label: "Ada" }, { type: "break" }, t("bye")),
    { type: "image", src: "file_1", alt: "cat" },
    p(t("cell")),
  ]);
  assert.doesNotMatch(JSON.stringify(d), /alert|javascript|color/);
  const again = ok(doc(p(t("Hi "), { type: "mention", id: "u1", label: "Ada" })));
  const html = String(renderRichText(again));
  assert.match(html, /data-mention="u1" data-label="Ada"/);
});
