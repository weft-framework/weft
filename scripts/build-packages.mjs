import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "target", "npm-build");
const OUT = join(ROOT, "target", "npm");
export const PACKAGES = ["runtime", "data", "server", "core", "theme", "i18n"];
// Already plain JavaScript: packed as they are, not compiled.
export const PLAIN = ["ui", "create-weft"];

function rewriteSpecifiers(code) {
  return code.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.\.?\/[^"']+)\.ts\2/g, "$1$2$3.js$2");
}

/** `./src/x.ts` -> `{ types: ./dist/x.d.ts, default: ./dist/x.js }`. */
function distExport(target) {
  if (typeof target === "object") {
    return target;
  }
  const m = /^\.\/src\/(.+)\.ts$/.exec(target);
  if (!m) {
    throw new Error(`unexpected export target ${target}`);
  }
  return { types: `./dist/${m[1]}.d.ts`, default: `./dist/${m[1]}.js` };
}

function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, fn);
    } else {
      fn(p);
    }
  }
}

export function buildPackages({ pack = false, quiet = false } = {}) {
  rmSync(BUILD, { recursive: true, force: true });
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", join(ROOT, "tsconfig.build.json")], { stdio: quiet ? "pipe" : "inherit" });
  rmSync(OUT, { recursive: true, force: true });
  const out = {};
  for (const name of PACKAGES) {
    const src = join(ROOT, "packages", name);
    const dest = join(OUT, name);
    mkdirSync(dest, { recursive: true });
    cpSync(join(BUILD, name, "src"), join(dest, "dist"), { recursive: true });
    walk(join(dest, "dist"), (file) => {
      if (file.endsWith(".d.ts")) {
        writeFileSync(file, rewriteSpecifiers(readFileSync(file, "utf8")));
      }
    });
    const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
    delete pkg.scripts;
    delete pkg.devDependencies;
    pkg.exports = Object.fromEntries(Object.entries(pkg.exports).map(([k, v]) => [k, distExport(v)]));
    pkg.types = pkg.exports["."].types;
    // Hand-written browser files next to src/ (theme and i18n `client.js`).
    const extra = (pkg.files ?? []).filter((f) => f !== "src");
    for (const f of extra) {
      cpSync(join(src, f), join(dest, f), { recursive: true });
    }
    pkg.files = ["dist", ...extra];
    pkg.engines ??= { node: ">=22.6" };
    writeFileSync(join(dest, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    copyFileSync(join(ROOT, "LICENSE"), join(dest, "LICENSE"));
    const readme = join(src, "README.md");
    writeFileSync(
      join(dest, "README.md"),
      existsSync(readme)
        ? readFileSync(readme, "utf8")
        : `# ${pkg.name}\n\n${pkg.description}\n\nPart of Weft. MIT licensed.\n`,
    );
    if (pack) {
      execFileSync("npm", ["pack", "--pack-destination", ".."], { cwd: dest, stdio: quiet ? "pipe" : "inherit", shell: process.platform === "win32" });
    }
    out[pkg.name] = dest;
  }
  if (pack) {
    for (const name of PLAIN) {
      execFileSync("npm", ["pack", "--pack-destination", "../../target/npm"], { cwd: join(ROOT, "packages", name), stdio: quiet ? "pipe" : "inherit", shell: process.platform === "win32" });
    }
  }
  return out;
}

// The weft binary on npm: one package per platform, each limited by "os" and
// "cpu" so npm installs only the matching one, and @weft-framework/cli on top listing
// them all as optional dependencies. `target` is the Rust target CI builds.
export const PLATFORMS = {
  "win32-x64": { os: "win32", cpu: "x64", target: "x86_64-pc-windows-msvc", label: "Windows x64" },
  "win32-arm64": { os: "win32", cpu: "arm64", target: "aarch64-pc-windows-msvc", label: "Windows ARM64" },
  "linux-x64": { os: "linux", cpu: "x64", target: "x86_64-unknown-linux-musl", label: "Linux x64 (static)" },
  "linux-arm64": { os: "linux", cpu: "arm64", target: "aarch64-unknown-linux-musl", label: "Linux ARM64 (static)" },
  "darwin-x64": { os: "darwin", cpu: "x64", target: "x86_64-apple-darwin", label: "macOS Intel" },
  "darwin-arm64": { os: "darwin", cpu: "arm64", target: "aarch64-apple-darwin", label: "macOS Apple Silicon" },
};

/**
 * Assemble @weft-framework/cli and its platform packages from `bins/<platform>/weft[.exe]`
 * (for example bins/linux-x64/weft). With `requireAll`, a missing platform is an
 * error, which is what a release wants; otherwise only the binaries present are
 * packaged, which is enough to try it locally.
 */
export function buildCliPackages({ bins, pack = false, quiet = false, requireAll = false }) {
  const src = join(ROOT, "packages", "cli");
  const base = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  const found = [];
  const missing = [];
  for (const [key, p] of Object.entries(PLATFORMS)) {
    const exe = p.os === "win32" ? "weft.exe" : "weft";
    const bin = join(bins, key, exe);
    if (!existsSync(bin)) {
      missing.push(key);
      continue;
    }
    const dest = join(OUT, `cli-${key}`);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(join(dest, "bin"), { recursive: true });
    copyFileSync(bin, join(dest, "bin", exe));
    chmodSync(join(dest, "bin", exe), 0o755);
    const pkg = {
      name: `@weft-framework/cli-${key}`,
      version: base.version,
      description: `The weft binary for ${p.label}. Install @weft-framework/cli instead; it picks this up on its own.`,
      keywords: base.keywords,
      license: base.license,
      author: base.author,
      repository: base.repository,
      homepage: base.homepage,
      bugs: base.bugs,
      os: [p.os],
      cpu: [p.cpu],
      files: ["bin"],
      preferUnplugged: true,
    };
    writeFileSync(join(dest, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    copyFileSync(join(ROOT, "LICENSE"), join(dest, "LICENSE"));
    writeFileSync(join(dest, "README.md"), `# ${pkg.name}\n\n${pkg.description}\n\nPart of [Weft](https://github.com/weft-framework/weft). MIT licensed.\n`);
    found.push(key);
  }
  if (found.length === 0 || (requireAll && missing.length > 0)) {
    throw new Error(`no weft binary for ${missing.join(", ")} under ${bins} (expected bins/<platform>/weft or weft.exe)`);
  }
  const dest = join(OUT, "cli");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const f of base.files) {
    cpSync(join(src, f), join(dest, f), { recursive: true });
  }
  copyFileSync(join(src, "README.md"), join(dest, "README.md"));
  copyFileSync(join(ROOT, "LICENSE"), join(dest, "LICENSE"));
  const pkg = { ...base };
  delete pkg.scripts;
  pkg.optionalDependencies = Object.fromEntries(found.map((key) => [`@weft-framework/cli-${key}`, base.version]));
  writeFileSync(join(dest, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  if (pack) {
    for (const dir of [...found.map((key) => `cli-${key}`), "cli"]) {
      execFileSync("npm", ["pack", "--pack-destination", ".."], { cwd: join(OUT, dir), stdio: quiet ? "pipe" : "inherit", shell: process.platform === "win32" });
    }
  }
  return { found, missing };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const pack = args.includes("--pack");
  const at = args.indexOf("--cli");
  if (!args.includes("--cli-only")) {
    const built = buildPackages({ pack });
    for (const [name, dir] of Object.entries(built)) {
      console.log(`${name} -> ${dir}`);
    }
  }
  if (at !== -1) {
    const bins = args[at + 1];
    if (!bins || bins.startsWith("--")) {
      console.error("usage: node scripts/build-packages.mjs [--pack] [--cli <bins dir> [--require-all] [--cli-only]]");
      process.exit(2);
    }
    const { found, missing } = buildCliPackages({ bins, pack, requireAll: args.includes("--require-all") });
    console.log(`@weft-framework/cli -> ${found.join(", ")}${missing.length ? ` (no binary for ${missing.join(", ")})` : ""}`);
  }
}
