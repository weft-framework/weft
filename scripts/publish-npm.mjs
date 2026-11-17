// SPDX-License-Identifier: MIT
//
// First-time (or bootstrap) publish of the @weft-framework tarballs.
// Log in first (`npm login`); npm will ask for 2FA in the browser.
//
//   node scripts/publish-npm.mjs [dir] [--dry-run]
//
// Missing `node_modules` runs `npm ci`. Missing tarballs are built
// (`npm pack` via scripts/build-packages.mjs) and the native weft binary
// is compiled for this machine so @weft-framework/cli can be packed.
// Other-OS CLI tarballs are skipped unless they are already in `dir`.
// Version is taken from Cargo.toml. Names already on npm are skipped.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { buildCliPackages, buildPackages, PLATFORMS } from "./build-packages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "target", "npm");
const JS = ["runtime", "data", "server", "core", "theme", "i18n", "ui", "create"];
const CLI_PLATFORMS = Object.keys(PLATFORMS);
const ORDER = [...JS, ...CLI_PLATFORMS.map((p) => `cli-${p}`), "cli"];

const cargo = readFileSync(join(ROOT, "Cargo.toml"), "utf8");
const section = cargo.split(/^\[workspace\.package\]$/m)[1]?.split(/^\[/m)[0] ?? "";
const version = /^version\s*=\s*"([^"]+)"/m.exec(section)?.[1];
if (!version) {
  console.error("publish-npm: no version in Cargo.toml [workspace.package]");
  process.exit(1);
}

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const dirArg = args.find((a) => a !== "--dry-run");
const NPM = join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, {
    stdio: "inherit",
    cwd: ROOT,
    windowsHide: true,
    shell: process.platform === "win32",
    ...opts,
  });
  if (r.error) {
    console.error(`publish-npm: ${cmd} failed: ${r.error.message}`);
    process.exit(1);
  }
  return r.status ?? 1;
}

function npm(argv, opts) {
  return run(existsSync(NPM) ? NPM : "npm", argv, opts);
}

function packSpec(file) {
  const rel = relative(ROOT, file);
  if (rel && !rel.startsWith("..") && !rel.startsWith("/")) return `./${rel.replaceAll("\\", "/")}`;
  return pathToFileURL(file).href;
}

function tarball(dir, short) {
  return join(dir, `weft-framework-${short}-${version}.tgz`);
}

function missing(dir, names = ORDER) {
  return names.filter((s) => !existsSync(tarball(dir, s)));
}

function ensureDeps() {
  if (existsSync(join(ROOT, "node_modules", "typescript", "bin", "tsc"))) return;
  console.log("npm ci");
  if (npm(["ci", "--no-audit", "--no-fund"]) !== 0) process.exit(1);
}

function platformKey() {
  const arch = process.arch === "x64" ? "x64" : process.arch;
  const key = `${process.platform}-${arch}`;
  return key in PLATFORMS ? key : null;
}

function ensureNativeBin() {
  const key = platformKey();
  if (!key) return;
  const exe = process.platform === "win32" ? "weft.exe" : "weft";
  const dest = join(ROOT, "bins", key, exe);
  if (existsSync(dest)) return;
  console.log(`cargo build -p weft-cli --release (${key})`);
  if (run("cargo", ["build", "--release", "-p", "weft-cli"]) !== 0) process.exit(1);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(ROOT, "target", "release", exe), dest);
}

function ensureTarballs(dir) {
  const needJs = missing(dir, JS);
  const needCli = missing(dir, [...CLI_PLATFORMS.map((p) => `cli-${p}`), "cli"]);
  if (needJs.length === 0 && needCli.length === 0) return dir;

  ensureDeps();
  if (needJs.length) {
    console.log("building npm packages");
    buildPackages({ pack: true });
  }
  if (needCli.length) {
    ensureNativeBin();
    console.log("packing @weft-framework/cli");
    buildCliPackages({ bins: join(ROOT, "bins"), pack: true, requireAll: false });
  }

  const built = existsSync(OUT) ? OUT : dir;
  const stillJs = missing(built, JS);
  if (stillJs.length) {
    console.error(`publish-npm: still missing ${stillJs.map((s) => tarball(built, s)).join(", ")}`);
    process.exit(1);
  }
  return built;
}

if (npm(["whoami"]) !== 0) {
  console.error("publish-npm: run `npm login` first, then try again");
  process.exit(1);
}

const dir = ensureTarballs(resolve(dirArg ?? (existsSync(join(ROOT, "tarballs")) ? join(ROOT, "tarballs") : OUT)));

let published = 0;
let skipped = 0;
for (const short of ORDER) {
  const file = tarball(dir, short);
  const name = `@weft-framework/${short}`;
  if (!existsSync(file)) {
    console.log(`skip ${name} (no tarball on this machine)`);
    skipped++;
    continue;
  }
  const view = spawnSync(existsSync(NPM) ? NPM : "npm", ["view", `${name}@${version}`, "version"], {
    encoding: "utf8",
    cwd: ROOT,
    windowsHide: true,
    shell: process.platform === "win32",
  });
  if (view.status === 0 && String(view.stdout).trim() === version) {
    console.log(`skip ${name}@${version} (already on npm)`);
    skipped++;
    continue;
  }
  const publish = ["publish", packSpec(file), "--access", "public"];
  if (dry) publish.push("--dry-run");
  console.log(`${dry ? "dry-run" : "publish"} ${name}@${version}`);
  if (npm(publish) !== 0) process.exit(1);
  published++;
}

console.log(`${dry ? "would publish" : "published"} ${published}, skipped ${skipped}, version ${version}`);
