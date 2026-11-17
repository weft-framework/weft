import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject } from "../index.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("npm create weft writes the starter and refuses unsafe names", () => {
  const cwd = mkdtempSync(join(tmpdir(), "weft-create-"));
  try {
    const root = createProject("my-app", cwd, { minimal: true });
    assert.equal(root, join(cwd, "my-app"));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(pkg.name, "my-app");
    assert.equal(readFileSync(join(root, "src", "lib", "site.ts"), "utf8").includes("my-app"), true);
    assert.equal(readFileSync(join(root, ".gitignore"), "utf8").includes("node_modules"), true);
    assert.equal(readFileSync(join(root, "src", "pages", "index.wx"), "utf8").includes("component"), true);
    for (const name of ["../evil", "..", "My-App", "a/b", ".hidden", "", "has space"]) {
      assert.throws(() => createProject(name, cwd), /valid package name|invalid project directory/);
    }
    writeFileSync(join(root, "keep.txt"), "x");
    assert.throws(() => createProject("my-app", cwd), /not empty/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function hasCargo() {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function files(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files(path, base, out);
    } else {
      out.push(relative(base, path).split(sep).join("/"));
    }
  }
  return out.sort();
}

test("the default starter is the workspace app, the same as `weft new`", () => {
  const cwd = mkdtempSync(join(tmpdir(), "weft-create-app-"));
  try {
    const root = createProject("tour-app", cwd);
    assert.ok(existsSync(join(root, "src", "pages", "app", "tasks", "[id].wx")));
    assert.ok(existsSync(join(root, "src", "components", "ui", "live-table.wx")));
    assert.ok(existsSync(join(root, "src", "lib", "utils.ts")));
    assert.ok(readFileSync(join(root, "src", "pages", "_layout.wx"), "utf8").includes("%s | tour-app"));
    if (hasCargo()) {
      const other = join(cwd, "cli", "tour-app");
      execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "new", other], { cwd: REPO, stdio: "pipe" });
      assert.deepEqual(files(root), files(other));
      for (const rel of files(root)) {
        assert.equal(readFileSync(join(root, rel), "utf8"), readFileSync(join(other, rel), "utf8"), rel);
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--tailwind writes the same project as `weft new --tailwind`", () => {
  const cwd = mkdtempSync(join(tmpdir(), "weft-create-tw-"));
  try {
    assert.throws(() => createProject("tw-app", cwd, { tailwind: true }), /applies to --minimal/);
    const root = createProject("tw-app", cwd, { minimal: true, tailwind: true });
    assert.ok(!existsSync(join(root, "public", "styles.css")));
    const css = readFileSync(join(root, "src", "app.css"), "utf8");
    assert.ok(css.startsWith('@import "tailwindcss";'));
    assert.ok(css.includes("  --accent: var(--color-accent);"), css);
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies.tailwindcss, "^4.3.5");
    if (hasCargo()) {
      const other = join(cwd, "cli", "tw-app");
      execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "new", other, "--minimal", "--tailwind"], { cwd: REPO, stdio: "pipe" });
      for (const rel of ["src/app.css", "src/index.html", "package.json"]) {
        assert.equal(readFileSync(join(root, rel), "utf8"), readFileSync(join(other, rel), "utf8"), rel);
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
