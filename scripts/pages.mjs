// SPDX-License-Identifier: MIT
//
// Turn a `weft build` edge folder into a GitHub Pages site.
//
//   node scripts/pages.mjs <dist/edge> <out> [base]
//
// Pages serves a project site under /<repo>/, so root links such as
// href="/styles.css" are rewritten to start with the base path. The base comes
// from the third argument or PAGES_BASE (actions/configure-pages gives it as
// base_path; it is empty on a custom domain). routes.json is build metadata
// and is left out.

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [from, to, arg] = process.argv.slice(2);
if (!from || !to) {
  console.error("usage: node scripts/pages.mjs <dist/edge> <out> [base]");
  process.exit(2);
}
const src = resolve(from);
const out = resolve(to);
if (!existsSync(join(src, "index.html"))) {
  console.error(`pages: ${src} has no index.html. Run weft build first, and keep the home page static.`);
  process.exit(1);
}

const base = (arg ?? process.env.PAGES_BASE ?? "").replace(/\/+$/, "");
if (base && !/^\/[\w.-]+(\/[\w.-]+)*$/.test(base)) {
  console.error(`pages: '${base}' doesn't look like a base path (expected something like /weft)`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
rmSync(join(out, "routes.json"), { force: true });

function rebase(text) {
  if (!base) return text;
  return text
    .replace(/(\b(?:href|src|action|content)=")\/(?!\/)/g, `$1${base}/`)
    .replace(/(\burl\(\s*["']?)\/(?!\/)/g, `$1${base}/`);
}

let pages = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
    } else if (name.endsWith(".html") || name.endsWith(".css")) {
      writeFileSync(p, rebase(readFileSync(p, "utf8")));
      if (name.endsWith(".html")) pages++;
    }
  }
};
walk(out);

// No Jekyll: GitHub would otherwise skip files and folders starting with _.
writeFileSync(join(out, ".nojekyll"), "");
console.log(`pages: ${pages} page(s) in ${out}${base ? `, served under ${base}/` : ""}`);
