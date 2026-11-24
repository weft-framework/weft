// SPDX-License-Identifier: MIT
//
// First-time (or bootstrap) publish of the @weft-framework tarballs.
// Log in first (`npm login`); npm will ask for 2FA in the browser.
//
//   node scripts/publish-npm.mjs [dir] [--dry-run] [--build-only] [--platforms win32-x64,linux-x64]
//
// Missing `node_modules` runs `npm ci`. Missing tarballs are built
// (`npm pack` via scripts/build-packages.mjs). The weft binary is compiled
// for every platform in --platforms (default: win32-x64 and linux-x64):
// the host's natively, Linux as a static musl build (through WSL when run on
// Windows). A binary in bins/ is reused only when `weft --version` matches
// the release. Nothing is published unless every required platform's CLI
// tarball exists, so @weft-framework/cli never ships without a Linux binary.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
const platformsAt = args.indexOf("--platforms");
const REQUIRED = platformsAt === -1 ? ["win32-x64", "linux-x64"] : String(args[platformsAt + 1] ?? "").split(",").filter(Boolean);
for (const key of REQUIRED) {
  if (!(key in PLATFORMS)) {
    console.error(`publish-npm: unknown platform ${key} (one of ${Object.keys(PLATFORMS).join(", ")})`);
    process.exit(2);
  }
}
const dirArg = args.find((a, i) => a !== "--dry-run" && a !== "--build-only" && a !== "--platforms" && (platformsAt === -1 || i !== platformsAt + 1));
const NPM = join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");

function packageVersion(short) {
  const pkgDir = short === "create" ? "create-weft" : short.startsWith("cli-") ? "cli" : short;
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages", pkgDir, "package.json"), "utf8"));
  if (pkg.version !== version) {
    console.error(`publish-npm: packages/${pkgDir} is ${pkg.version} but Cargo.toml is ${version}; run node scripts/check-version.mjs`);
    process.exit(1);
  }
  return version;
}

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
  const ver = packageVersion(short);
  return join(dir, `weft-framework-${short}-${ver}.tgz`);
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
  const key = `${process.platform}-${process.arch}`;
  return key in PLATFORMS ? key : null;
}

function capture(cmd, argv) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", cwd: ROOT, windowsHide: true });
  return r.status === 0 ? String(r.stdout) : null;
}

function toWsl(path) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (!m) throw new Error(`publish-npm: cannot map ${path} into WSL`);
  return `/mnt/${m[1].toLowerCase()}/${m[2].replaceAll("\\", "/")}`;
}

const quote = (v) => `'${String(v).replaceAll("'", `'\\''`)}'`;

function linuxShell(script) {
  if (process.platform === "linux") return run("bash", ["-lc", script], { shell: false });
  if (process.platform === "win32") return run("wsl.exe", ["-e", "bash", "-lc", script], { shell: false });
  return 1;
}

function canRun(key) {
  const p = PLATFORMS[key];
  if (p.os === process.platform && p.cpu === process.arch) return true;
  return p.os === "linux" && p.cpu === "x64" && process.platform === "win32" && process.arch === "x64";
}

function binVersion(key, file) {
  if (!existsSync(file)) return null;
  const p = PLATFORMS[key];
  const out =
    p.os === process.platform
      ? p.os === "linux" && process.platform === "win32"
        ? null
        : capture(file, ["--version"])
      : p.os === "linux" && process.platform === "win32"
        ? capture("wsl.exe", ["-e", toWsl(file), "--version"])
        : null;
  return out === null ? null : (/weft\s+(\S+)/.exec(out)?.[1] ?? null);
}

const ZIG_HINT = "install zig and `cargo install --locked cargo-zigbuild` (e.g. `winget install zig.zig` or `pip install ziglang`)";
let zigbuild = null;

function hasZigbuild() {
  zigbuild ??= capture("cargo", ["zigbuild", "--help"]) !== null && (capture("zig", ["version"]) !== null || capture("python", ["-m", "ziglang", "version"]) !== null);
  return zigbuild;
}

function hasTarget(target) {
  return (capture("rustup", ["target", "list", "--installed"]) ?? "").split(/\r?\n/).includes(target);
}

function buildBin(key, dest) {
  const p = PLATFORMS[key];
  const exe = p.os === "win32" ? "weft.exe" : "weft";
  if (p.os === process.platform && p.cpu === process.arch && p.os !== "linux") {
    console.log(`cargo build --release -p weft-cli (${key})`);
    if (run("cargo", ["build", "--release", "-p", "weft-cli"], { shell: false }) !== 0) return false;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(ROOT, "target", "release", exe), dest);
    return true;
  }
  if (p.os !== "win32" && hasZigbuild()) {
    const out = join(ROOT, "target", "zig");
    console.log(`cargo zigbuild --release -p weft-cli --target ${p.target} (${key})`);
    if (!hasTarget(p.target) && run("rustup", ["target", "add", p.target], { shell: false }) !== 0) return false;
    const status = run("cargo", ["zigbuild", "--release", "-p", "weft-cli", "--target", p.target], {
      shell: false,
      env: { ...process.env, CARGO_TARGET_DIR: out },
    });
    if (status !== 0) return false;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(out, p.target, "release", exe), dest);
    return true;
  }
  if (p.os === "linux" && (process.platform === "linux" || process.platform === "win32")) {
    if (p.cpu !== process.arch && !(process.platform === "win32" && p.cpu === "x64")) {
      console.error(`publish-npm: ${key} needs cargo-zigbuild on this machine (${ZIG_HINT})`);
      return false;
    }
    const root = process.platform === "win32" ? toWsl(ROOT) : ROOT;
    const out = `${root}/target/linux`;
    const linker = `${p.target.toUpperCase().replaceAll("-", "_")}_LINKER`;
    console.log(`cargo build --release -p weft-cli --target ${p.target} (${key}${process.platform === "win32" ? ", via WSL" : ""})`);
    const script = [
      "set -e",
      `cd ${quote(root)}`,
      `if command -v cargo-zigbuild >/dev/null 2>&1 && command -v zig >/dev/null 2>&1; then BUILD=zigbuild; else BUILD=build; fi`,
      `rustup target list --installed | grep -qx ${quote(p.target)} || rustup target add ${quote(p.target)}`,
      `if command -v musl-gcc >/dev/null 2>&1 && [ ${quote(p.cpu)} = x64 ]; then export ${linker}=musl-gcc; fi`,
      `CARGO_TARGET_DIR=${quote(out)} cargo "$BUILD" --release -p weft-cli --target ${quote(p.target)}`,
    ].join("\n");
    if (linuxShell(script) !== 0) {
      console.error(`publish-npm: the ${key} build failed; ${ZIG_HINT}, or on Ubuntu/WSL \`sudo apt-get install -y musl-tools\``);
      return false;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(ROOT, "target", "linux", p.target, "release", "weft"), dest);
    return true;
  }
  return false;
}

function ensureBins(version) {
  const wanted = new Set(REQUIRED);
  const host = platformKey();
  if (host) wanted.add(host);
  if (platformsAt === -1 && hasZigbuild()) wanted.add("linux-arm64");
  const missingBins = [];
  const ready = [];
  for (const key of wanted) {
    const exe = PLATFORMS[key].os === "win32" ? "weft.exe" : "weft";
    const dest = join(ROOT, "bins", key, exe);
    const have = canRun(key) ? binVersion(key, dest) : null;
    if (have === version) {
      console.log(`bins/${key}/${exe} is weft ${version}`);
      ready.push(key);
      continue;
    }
    if (existsSync(dest)) console.log(`bins/${key}/${exe} is weft ${have ?? "(unverifiable here)"}, rebuilding for ${version}`);
    if (!buildBin(key, dest)) {
      if (REQUIRED.includes(key)) missingBins.push(key);
      continue;
    }
    const built = canRun(key) ? binVersion(key, dest) : version;
    if (built !== version) {
      console.error(`publish-npm: bins/${key}/${exe} reports ${built ?? "nothing"}, expected ${version}`);
      if (REQUIRED.includes(key)) missingBins.push(key);
      continue;
    }
    ready.push(key);
  }
  if (missingBins.length) {
    console.error(`publish-npm: no weft ${version} binary for ${missingBins.join(", ")}; nothing was published`);
    process.exit(1);
  }
  const staged = join(ROOT, "target", "npm-bins");
  rmSync(staged, { recursive: true, force: true });
  for (const key of ready) {
    const exe = PLATFORMS[key].os === "win32" ? "weft.exe" : "weft";
    mkdirSync(join(staged, key), { recursive: true });
    copyFileSync(join(ROOT, "bins", key, exe), join(staged, key, exe));
  }
  return staged;
}

function ensureTarballs(dir) {
  const needJs = missing(dir, JS);
  const needCli = missing(dir, [...REQUIRED.map((p) => `cli-${p}`), "cli"]);
  if (needJs.length === 0 && needCli.length === 0) return dir;

  ensureDeps();
  if (needJs.length) {
    console.log("building npm packages");
    buildPackages({ pack: true });
  }
  if (needCli.length) {
    const staged = ensureBins(packageVersion("cli"));
    console.log("packing @weft-framework/cli");
    const { found } = buildCliPackages({ bins: staged, pack: true, requireAll: false });
    const absent = REQUIRED.filter((key) => !found.includes(key));
    if (absent.length) {
      console.error(`publish-npm: @weft-framework/cli was packed without ${absent.join(", ")}; nothing was published`);
      process.exit(1);
    }
  }

  const built = existsSync(OUT) ? OUT : dir;
  const stillCli = missing(built, [...REQUIRED.map((p) => `cli-${p}`), "cli"]);
  if (stillCli.length) {
    console.error(`publish-npm: missing ${stillCli.map((s) => tarball(built, s)).join(", ")}; nothing was published`);
    process.exit(1);
  }
  const stillJs = missing(built, JS);
  if (stillJs.length) {
    console.warn(`publish-npm: still missing ${stillJs.map((s) => tarball(built, s)).join(", ")}`);
    process.exit(1);
  }
  return built;
}

if (args.includes("--build-only")) {
  const built = ensureTarballs(resolve(dirArg ?? OUT));
  console.log(`built ${ORDER.filter((s) => existsSync(tarball(built, s))).map((s) => `@weft-framework/${s}`).join(", ")} in ${built}`);
  process.exit(0);
}

if (npm(["whoami"]) !== 0) {
  console.error("publish-npm: run `npm login` first, then try again");
  process.exit(1);
}

const dir = ensureTarballs(resolve(dirArg ?? (existsSync(join(ROOT, "tarballs")) ? join(ROOT, "tarballs") : OUT)));

let published = 0;
let skipped = 0;
for (const short of ORDER) {
  const ver = packageVersion(short);
  const file = tarball(dir, short);
  const name = `@weft-framework/${short}`;
  if (!existsSync(file)) {
    console.log(`skip ${name} (no tarball on this machine)`);
    skipped++;
    continue;
  }
  const view = spawnSync(existsSync(NPM) ? NPM : "npm", ["view", `${name}@${ver}`, "version"], {
    encoding: "utf8",
    cwd: ROOT,
    windowsHide: true,
    shell: process.platform === "win32",
  });
  if (view.status === 0 && String(view.stdout).trim() === ver) {
    console.log(`skip ${name}@${ver} (already on npm)`);
    skipped++;
    continue;
  }
  const publish = ["publish", packSpec(file), "--access", "public"];
  if (dry) publish.push("--dry-run");
  console.log(`${dry ? "dry-run" : "publish"} ${name}@${ver}`);
  if (npm(publish) !== 0) process.exit(1);
  published++;
}

console.log(`${dry ? "would publish" : "published"} ${published}, skipped ${skipped}`);