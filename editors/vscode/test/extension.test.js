// SPDX-License-Identifier: MIT
//
// Checks that need no VS Code: the grammar and manifests are valid JSON,
// every grammar regex compiles, every `#name` include resolves, and the
// server-path resolution picks the right executable.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveServer } = require("../server.js");

const root = path.join(__dirname, "..");
const load = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

/** Visit every rule object in a grammar. */
function rules(grammar, visit) {
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      visit(node);
      Object.values(node).forEach(walk);
    }
  };
  walk(grammar);
}

test("manifests are valid JSON and agree", () => {
  const pkg = load("package.json");
  const grammar = pkg.contributes.grammars[0];
  assert.equal(grammar.scopeName, "source.weft");
  assert.ok(fs.existsSync(path.join(root, grammar.path)));
  assert.ok(fs.existsSync(path.join(root, pkg.contributes.languages[0].configuration)));
  assert.ok(fs.existsSync(path.join(root, pkg.main)));
  load("language-configuration.json");
});

test("grammar regexes compile", () => {
  const grammar = load("syntaxes/weft.tmLanguage.json");
  let count = 0;
  rules(grammar, (rule) => {
    for (const key of ["match", "begin", "end", "while"]) {
      if (typeof rule[key] === "string") {
        assert.doesNotThrow(() => new RegExp(rule[key]), `${key}: ${rule[key]}`);
        count++;
      }
    }
  });
  assert.ok(count > 30, `only ${count} regexes found`);
});

test("grammar includes resolve", () => {
  const grammar = load("syntaxes/weft.tmLanguage.json");
  const names = new Set(Object.keys(grammar.repository));
  rules(grammar, (rule) => {
    if (typeof rule.include === "string" && rule.include.startsWith("#")) {
      assert.ok(names.has(rule.include.slice(1)), `missing ${rule.include}`);
    }
  });
});

test("language configuration patterns compile", () => {
  const config = load("language-configuration.json");
  new RegExp(config.wordPattern);
  const inc = new RegExp(config.indentationRules.increaseIndentPattern);
  const dec = new RegExp(config.indentationRules.decreaseIndentPattern);
  assert.ok(inc.test("  view {"));
  assert.ok(inc.test("    <div class=\"x\">"));
  assert.ok(!inc.test("    <br>"));
  assert.ok(!inc.test("    <p>text</p>"));
  assert.ok(dec.test("    </div>"));
  assert.ok(dec.test("    {:else}"));
  assert.ok(dec.test("  }"));
});

test("server path: setting wins", () => {
  const abs = path.resolve("/opt/weft/bin/weft");
  assert.equal(resolveServer(abs, ["/w"], { exists: () => true }), abs);
  assert.equal(
    resolveServer("tools/weft", ["/w"], { exists: () => false }),
    path.join("/w", "tools/weft"),
  );
  assert.equal(resolveServer("  weft-dev ", [], {}), "weft-dev");
});

test("server path: workspace node_modules, then PATH", () => {
  const seen = [];
  const exists = (p) => {
    seen.push(p);
    return p === path.join("/b", "node_modules", ".bin", "weft");
  };
  assert.equal(
    resolveServer("", ["/a", "/b"], { exists, platform: "linux" }),
    path.join("/b", "node_modules", ".bin", "weft"),
  );
  assert.equal(seen.length, 2);
  assert.equal(
    resolveServer(undefined, ["/a"], { exists: (p) => p.endsWith("weft.cmd"), platform: "win32" }),
    path.join("/a", "node_modules", ".bin", "weft.cmd"),
  );
  assert.equal(resolveServer("", ["/a"], { exists: () => false }), "weft");
});
