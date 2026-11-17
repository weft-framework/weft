import { strict as assert } from "node:assert";
import { test } from "node:test";

import { actionAttr, BLOCKED_URL, escapeAttr, escapeHtml, escapeUrl, forwardEvents, restProps, safeUrl, spreadAttrs, trustHtml } from "../src/escape.ts";

test("escapes the five HTML metacharacters", () => {
  assert.equal(
    escapeHtml(`<a href="x" onclick='y'>&`),
    "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;",
  );
});

test("neutralises a script-injection payload", () => {
  assert.equal(
    escapeHtml("<script>alert(1)</script>"),
    "&lt;script&gt;alert(1)&lt;/script&gt;",
  );
});

test("does not double-encode an ampersand", () => {
  assert.equal(escapeHtml("a & b"), "a &amp; b");
});

test("leaves ordinary text untouched", () => {
  assert.equal(escapeHtml("Hello, world 123"), "Hello, world 123");
});

test("coerces non-string input", () => {
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeAttr(undefined), "");
});

test("escapeAttr matches escapeHtml for attribute-unsafe input", () => {
  const payload = `" onmouseover="alert(1)`;
  assert.equal(escapeAttr(payload), escapeHtml(payload));
  assert.ok(!escapeAttr(payload).includes('"'));
});

test("trusted markup passes text escaping but never attribute escaping", () => {
  const html = trustHtml("<b>x</b>");
  assert.equal(escapeHtml(html), "<b>x</b>");
  assert.equal(escapeAttr(html), "&lt;b&gt;x&lt;/b&gt;");
  assert.equal(escapeHtml({ html: "<i>" }), "[object Object]");
  assert.equal(escapeHtml(JSON.parse('{"html":"<i>"}')), "[object Object]");
});

test("null and undefined render as nothing in text, as in JSX", () => {
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(0), "0");
  assert.equal(escapeHtml(false), "false");
});

test("URL attributes refuse script URLs however they are spelt", () => {
  const blocked = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "\u0001javascript:alert(1)",
    "jav\u0000ascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "DATA:text/html;base64,PHNjcmlwdD4=",
  ];
  for (const u of blocked) {
    assert.equal(safeUrl(u, "href"), BLOCKED_URL, JSON.stringify(u));
    assert.equal(safeUrl(u, "src"), BLOCKED_URL, JSON.stringify(u));
  }
  for (const u of ["/a?b=1&c=2", "https://x.test/p", "mailto:a@b.test", "#top", "javascript-guide.html", "./javascript:x"]) {
    assert.equal(safeUrl(u), u);
  }
  assert.equal(escapeUrl('/q?a=1&b="x"'), "/q?a=1&amp;b=&quot;x&quot;");
  assert.equal(escapeUrl("javascript&#58;alert(1)"), "javascript&amp;#58;alert(1)");
  assert.equal(safeUrl("data:image/png;base64,iVBO", "src"), "data:image/png;base64,iVBO");
  assert.equal(safeUrl("data:image/png;base64,iVBO", "href"), BLOCKED_URL);
  assert.equal(safeUrl(null), "");
  assert.equal(safeUrl(undefined), "");
  assert.equal(actionAttr("formaction", "javascript:alert(1)"), ` formaction="${BLOCKED_URL}"`);
});

test("spreadAttrs writes events forwarded by a component call, never forged ones", () => {
  const html = ' data-weft-on-change="pick" data-weft-args-change="t1"';
  const props = { name: "s", "data-weft-events": forwardEvents(html) };
  assert.equal(spreadAttrs(restProps(props, ["name"])), html);
  assert.equal(spreadAttrs({ "data-weft-events": html }), "");
  assert.equal(spreadAttrs({ "data-weft-events": { toString: () => html } }), "");
  assert.equal(spreadAttrs({ "data-weft-on-click": "pick" }), "");
});
