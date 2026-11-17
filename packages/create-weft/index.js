import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED = join(HERE, "template");
const CLI = join(HERE, "..", "..", "crates", "weft-cli");
const SOURCES = existsSync(BUNDLED)
  ? { welcome: join(BUNDLED, "welcome"), minimal: join(BUNDLED, "minimal"), registry: join(BUNDLED, "registry") }
  : { welcome: join(CLI, "templates", "welcome"), minimal: join(CLI, "templates", "app"), registry: join(CLI, "registry") };

const TOKENS = ["ink", "paper", "muted", "line", "accent"];

function tailwindCss(starterCss) {
  let base = starterCss;
  for (const token of TOKENS) {
    base = base.replace(new RegExp(`(^  --${token}: )[^;]*`, "m"), `$1var(--color-${token})`);
  }
  return (
    '@import "tailwindcss";\n\n' +
    "/* Design tokens: every --color-*, --font-*, --radius-* here is also a\n" +
    "   utility (bg-accent, font-sans, rounded-card). */\n" +
    "@theme {\n" +
    "  --color-ink: #1d2433;\n" +
    "  --color-paper: #f8f7f4;\n" +
    "  --color-muted: #5d6475;\n" +
    "  --color-line: #dedbd2;\n" +
    "  --color-accent: #2c5d8f;\n" +
    '  --font-sans: system-ui, -apple-system, "Segoe UI", sans-serif;\n' +
    "}\n\n" +
    "/* The starter's styles, under the utilities. */\n" +
    "@layer base {\n" +
    base +
    "}\n"
  );
}

function useTailwind(root) {
  const publicCss = join(root, "public", "styles.css");
  writeFileSync(join(root, "src", "app.css"), tailwindCss(readFileSync(publicCss, "utf8")));
  rmSync(publicCss);
  const shell = join(root, "src", "index.html");
  writeFileSync(shell, readFileSync(shell, "utf8").replace('    <link rel="stylesheet" href="/styles.css">\n', ""));
  const pkg = join(root, "package.json");
  const deps = '  "devDependencies": {\n    "@tailwindcss/node": "^4.3.5",\n    "tailwindcss": "^4.3.5",\n';
  writeFileSync(pkg, readFileSync(pkg, "utf8").replace('  "devDependencies": {\n', deps));
}

export function createProject(name, cwd = process.cwd(), { minimal = false, tailwind = false } = {}) {
  if (tailwind && !minimal) {
    throw new Error("--tailwind applies to --minimal (the default starter already uses Tailwind)");
  }
  if (!validPackageName(name)) {
    throw new Error(`'${typeof name === "string" ? name : ""}' is not a valid package name (lowercase letters, digits, '-', '_', '.')`);
  }
  const base = resolve(cwd);
  const root = join(base, name);
  const rel = relative(base, root);
  if (rel !== name || rel.startsWith("..") || rel.includes("/") || rel.includes("\\") || !root.startsWith(base + sep)) {
    throw new Error("invalid project directory");
  }
  if (existsSync(root)) {
    const existing = readdirSync(root);
    if (existing.length > 0) {
      throw new Error(`'${name}' exists and is not empty`);
    }
  } else {
    mkdirSync(root, { recursive: true });
  }
  const template = minimal ? SOURCES.minimal : SOURCES.welcome;
  if (!existsSync(template) || (!minimal && !existsSync(SOURCES.registry))) {
    throw new Error("starter template is missing");
  }
  copyTree(template, root, name, root);
  if (minimal) {
    if (tailwind) {
      useTailwind(root);
    }
  } else {
    copyTree(join(SOURCES.registry, "ui"), root, name, join(root, "src", "components", "ui"));
    copyTree(join(SOURCES.registry, "lib"), root, name, join(root, "src", "lib"));
  }
  return root;
}

function copyTree(fromDir, root, name, destRoot) {
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error("template contains a symlink");
    }
    const from = join(fromDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      copyTree(from, root, name, join(destRoot, entry.name));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const destName = entry.name === "gitignore" ? ".gitignore" : entry.name;
    const dest = join(destRoot, destName);
    if (dest !== destRoot && !dest.startsWith(destRoot + sep)) {
      throw new Error("template path escaped the project");
    }
    if (!dest.startsWith(root + sep) && dest !== root) {
      throw new Error("template path escaped the project");
    }
    mkdirSync(dirname(dest), { recursive: true });
    const text = readFileSync(from);
    const source = text.includes(Buffer.from("{{name}}")) ? text.toString("utf8").replaceAll("{{name}}", name) : text;
    writeFileSync(dest, source);
  }
}

function validPackageName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 214) {
    return false;
  }
  if (name.startsWith(".") || name.startsWith("_")) {
    return false;
  }
  for (const char of name) {
    const ok = (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "-" || char === "_" || char === ".";
    if (!ok) {
      return false;
    }
  }
  return true;
}
