// SPDX-License-Identifier: MIT
//
// Every version in the repository has to agree before a release:
//
//   node scripts/check-version.mjs [v1.2.3]
//
// The Rust workspace version is the source of truth. Each package under
// packages/ must carry it, @weft-framework/* dependencies between packages must pin it
// exactly, and the starter templates must ask for ^it. With a tag, the tag has
// to match too. Prints the version on success, so CI can capture it.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

const cargo = readFileSync(join(ROOT, "Cargo.toml"), "utf8");
const section = cargo.split(/^\[workspace\.package\]$/m)[1]?.split(/^\[/m)[0] ?? "";
const version = /^version\s*=\s*"([^"]+)"/m.exec(section)?.[1];
if (!version) {
  console.error("check-version: couldn't find version under [workspace.package] in Cargo.toml");
  process.exit(1);
}

const tag = process.argv[2];
if (tag && tag.replace(/^refs\/tags\//, "") !== `v${version}`) {
  problems.push(`the tag is ${tag}, but Cargo.toml says ${version}. Tag the release v${version}, or bump Cargo.toml first.`);
}

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const rel = (file) => file.slice(ROOT.length + 1).replaceAll("\\", "/");

function checkDeps(file, pkg, want, how) {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (name.startsWith("@weft-framework/") && range !== want) {
        problems.push(`${rel(file)}: ${name} is "${range}" in ${field}, ${how} "${want}"`);
      }
    }
  }
}

for (const dir of readdirSync(join(ROOT, "packages"))) {
  const file = join(ROOT, "packages", dir, "package.json");
  if (!existsSync(file)) continue;
  const pkg = read(file);
  if (pkg.version !== version) {
    problems.push(`${rel(file)}: ${pkg.name} is ${pkg.version}, expected ${version}`);
  }
  checkDeps(file, pkg, version, "packages pin each other exactly, so it should be");
}

for (const t of ["welcome", "app"]) {
  const file = join(ROOT, "crates", "weft-cli", "templates", t, "package.json");
  checkDeps(file, read(file), `^${version}`, "new projects should ask for");
}

const site = join(ROOT, "site", "package.json");
if (existsSync(site)) checkDeps(site, read(site), version, "the site should use");

if (problems.length > 0) {
  console.error(`check-version: the versions don't line up (Cargo.toml says ${version}):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(version);
