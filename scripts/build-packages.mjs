import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    pkg.repository ??= { type: "git", url: "git+https://github.com/aleroycz/weft.git", directory: `packages/${name}` };
    pkg.homepage ??= "https://github.com/aleroycz/weft#readme";
    pkg.bugs ??= { url: "https://github.com/aleroycz/weft/issues" };
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = buildPackages({ pack: process.argv.includes("--pack") });
  for (const [name, dir] of Object.entries(built)) {
    console.log(`${name} -> ${dir}`);
  }
}
