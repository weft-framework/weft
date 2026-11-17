// SPDX-License-Identifier: MIT
//
// The class helpers `weft add` copies into a project (registry/lib/utils.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { cn, variants } from "../../crates/weft-cli/registry/lib/utils.ts";

test("cn joins strings, arrays and condition objects, skipping falsy values", () => {
  assert.equal(cn("a", ["b", ["c"]], { d: true, e: false }, null, undefined, false, ""), "a b c d");
  assert.equal(cn("  a   b "), "a b");
  assert.equal(cn(0), "0");
});

test("cn: the later conflicting utility wins", () => {
  assert.equal(cn("px-4 bg-primary", "bg-secondary px-2"), "bg-secondary px-2", "each winner where it stands");
  assert.equal(cn("text-sm text-red-500", "text-lg"), "text-red-500 text-lg", "size and colour are separate groups");
  assert.equal(cn("font-bold", "font-mono"), "font-bold font-mono");
  assert.equal(cn("block", "hidden"), "hidden");
  assert.equal(cn("rounded-md", "rounded-lg"), "rounded-lg");
  assert.equal(cn("border", "border-2", "border-input"), "border-2 border-input");
});

test("cn: a wider utility replaces narrower ones before it, not after", () => {
  assert.equal(cn("px-2 py-1", "p-4"), "p-4");
  assert.equal(cn("p-4", "px-2"), "p-4 px-2");
  assert.equal(cn("w-4 h-4", "size-6"), "size-6");
  assert.equal(cn("rounded-tl-md", "rounded-none"), "rounded-none");
});

test("cn: variants and important are part of the key", () => {
  assert.equal(cn("hover:bg-a bg-b", "hover:bg-c"), "bg-b hover:bg-c");
  assert.equal(cn("md:px-2", "px-4"), "md:px-2 px-4");
  assert.equal(cn("!px-2", "px-4"), "!px-2 px-4");
  assert.equal(cn("data-[state=open]:bg-a", "data-[state=open]:bg-b"), "data-[state=open]:bg-b");
});

test("cn keeps arbitrary and unknown classes", () => {
  assert.equal(cn("[&_svg]:size-4", "my-class", "my-class-2"), "[&_svg]:size-4 my-class my-class-2");
  assert.equal(cn("my-card top-bar", "my-2 top-0"), "my-card top-bar my-2 top-0", "not margins or insets");
  assert.equal(cn("-mt-2 top-1/2", "mt-[3px] top-(--x)"), "mt-[3px] top-(--x)");
});

test("variants picks from tables, with defaults, null opting out, and extras last", () => {
  const button = variants(
    "inline-flex",
    { size: { sm: "h-8 px-3", lg: "h-10 px-6" }, tone: { plain: "bg-muted", loud: "bg-primary" } },
    { size: "sm", tone: "plain" },
  );
  assert.equal(button(), "inline-flex h-8 px-3 bg-muted");
  assert.equal(button({ size: "lg" }), "inline-flex h-10 px-6 bg-muted");
  assert.equal(button({ tone: null }), "inline-flex h-8 px-3");
  assert.equal(button({}, "px-1 w-full"), "inline-flex h-8 bg-muted px-1 w-full", "a caller's class wins");
});
