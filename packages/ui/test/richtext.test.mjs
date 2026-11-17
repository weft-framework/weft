// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeHref, richText, mentionQuery, mentionMatches } from "../index.js";

test("safeHref allows web, mail and same-site links only", () => {
  assert.equal(safeHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeHref("example.com"), "https://example.com/");
  assert.equal(safeHref("http://example.com"), "http://example.com/");
  assert.equal(safeHref("/app/notes"), "/app/notes");
  assert.equal(safeHref("mailto:ada@example.com"), "mailto:ada@example.com");
  for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "//evil.example", "/\\evil.example", "vbscript:x", "", " ", "ftp://x.example"]) {
    assert.equal(safeHref(bad), null, bad);
  }
  assert.equal(safeHref("https://x.example/" + "a".repeat(2001)), null);
});

test("richText without a surface does nothing", () => {
  const el = { querySelector: () => null };
  const stop = richText(el);
  assert.equal(typeof stop, "function");
  stop();
});

test("mentionQuery finds the name typed after an @", () => {
  assert.equal(mentionQuery("@"), "");
  assert.equal(mentionQuery("hi @ad"), "ad");
  assert.equal(mentionQuery("(@Zoë"), "Zoë");
  assert.equal(mentionQuery("line\n@x"), "x");
  assert.equal(mentionQuery("mail ada@example"), null, "an address is not a mention");
  assert.equal(mentionQuery("hi @ada lovelace"), null, "a space ends it");
  assert.equal(mentionQuery("@@a"), null);
  assert.equal(mentionQuery("@" + "a".repeat(33)), null);
  assert.equal(mentionQuery("no at sign"), null);
});

test("mentionMatches is case- and accent-blind, at word starts", () => {
  assert.equal(mentionMatches("", "Anyone"), true);
  assert.equal(mentionMatches("ad", "Ada Lovelace"), true);
  assert.equal(mentionMatches("love", "Ada Lovelace"), true);
  assert.equal(mentionMatches("LOVE", "ada lovelace"), true);
  assert.equal(mentionMatches("zoe", "Zoë Šimková"), true);
  assert.equal(mentionMatches("sim", "Zoë Šimková"), true);
  assert.equal(mentionMatches("doe", "jane.doe"), true);
  assert.equal(mentionMatches("lace", "Ada Lovelace"), false, "not in the middle of a word");
  assert.equal(mentionMatches("bob", "Ada Lovelace"), false);
});
