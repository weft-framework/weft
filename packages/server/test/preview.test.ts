import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { previewDown, previewList, previewName, previewUp } from "../src/preview.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const work = join(here, ".weft", "preview");
const exe = join(repo, "target", "debug", process.platform === "win32" ? "weft.exe" : "weft");

test("preview names are safe and distinct", () => {
  assert.equal(previewName("main"), "main");
  assert.match(previewName("feature/Invoices"), /^feature-invoices-[0-9a-f]{6}$/);
  assert.notEqual(previewName("a/b"), previewName("a-b"));
  assert.match(previewName("../../etc"), /^etc-[0-9a-f]{6}$/);
  assert.match(previewName("---"), /^branch-[0-9a-f]{6}$/);
  assert.ok(previewName("x".repeat(200)).length <= 40);
});

test("a branch runs as a preview with its own database", { skip: !existsSync(exe) && "build weft-cli first (cargo build -p weft-cli)", timeout: 300_000 }, async () => {
  process.env.WEFT_BIN = exe;
  const root = join(work, "app");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync(exe, ["new", root, "--minimal"], { stdio: "pipe" });
  writeFileSync(join(root, "weft.config.ts"), `export default { database: "data/app.db" }\n`);
  writeFileSync(join(root, ".gitignore"), "node_modules\ndist\ndata\n.weft\n.env\n");
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: root, stdio: "pipe" }).toString().trim();
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("commit", "-qm", "init");
  g("checkout", "-qb", "feature/hello");
  const about = join(root, "src", "pages", "about.wx");
  writeFileSync(about, readFileSync(about, "utf8").replace("About", "Preview one"));
  g("commit", "-qam", "one");
  g("checkout", "-q", "main");
  writeFileSync(join(root, ".env.preview"), "GREETING=hi\n");

  const lines: string[] = [];
  const s = await previewUp(root, { branch: "feature/hello", log: (l) => lines.push(l) });
  try {
    assert.equal(s.name, previewName("feature/hello"));
    assert.equal(s.url, `http://127.0.0.1:${s.port}`);
    const dir = join(root, ".weft", "previews", s.name);
    assert.match(await (await fetch(`${s.url}/about`)).text(), /Preview one/);
    assert.equal(g("rev-parse", "--abbrev-ref", "HEAD"), "main", "the project's checkout is untouched");
    assert.ok(existsSync(join(dir, "data", "app.db")), "the preview's own database");
    assert.ok(!existsSync(join(root, "data", "app.db")), "not the project's");
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), "GREETING=hi\n", ".env.preview, never .env");
    assert.ok(readFileSync(join(dir, ".weft", "preview-secret"), "utf8").length >= 32);
    assert.deepEqual(previewList(root).map((p) => [p.name, p.running]), [[s.name, true]]);

    g("checkout", "-q", "feature/hello");
    writeFileSync(about, readFileSync(about, "utf8").replace("Preview one", "Preview two"));
    g("commit", "-qam", "two");
    g("checkout", "-q", "main");
    const s2 = await previewUp(root, { branch: "feature/hello", log: () => {} });
    assert.equal(s2.port, s.port, "keeps its port");
    assert.notEqual(s2.commit, s.commit);
    assert.match(await (await fetch(`${s2.url}/about`)).text(), /Preview two/);
    await assert.rejects(fetch(`http://127.0.0.1:${s.port}/about`).then(async (r) => (await r.text()).includes("Preview one") || Promise.reject(new Error("gone"))), /gone/);

    await assert.rejects(previewUp(root, { branch: "--upload-pack=x" }), /names a branch/);
    await assert.rejects(previewUp(root, { branch: "no-such-branch" }), /git rev-parse/);
  } finally {
    assert.equal(await previewDown(root, "feature/hello"), true);
  }
  assert.ok(!existsSync(join(root, ".weft", "previews", s.name)));
  assert.equal(previewList(root).length, 0);
  assert.equal(await previewDown(root, "feature/hello"), false);
  await assert.rejects(fetch(`${s.url}/_weft/health`, { signal: AbortSignal.timeout(2000) }));
  rmSync(work, { recursive: true, force: true });
});
