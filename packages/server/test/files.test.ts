import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetManifest, publicFiles } from "../src/files.ts";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "weft-files-"));
  const pub = join(base, "public");
  mkdirSync(join(pub, "img"), { recursive: true });
  mkdirSync(join(pub, ".well-known"), { recursive: true });
  mkdirSync(join(pub, ".git"), { recursive: true });
  writeFileSync(join(pub, "robots.txt"), "User-agent: *\n");
  writeFileSync(join(pub, "img", "logo.svg"), "<svg/>");
  writeFileSync(join(pub, "data.bin"), "x");
  writeFileSync(join(pub, ".env"), "SECRET=1");
  writeFileSync(join(pub, ".git", "config"), "[core]");
  writeFileSync(join(pub, ".well-known", "security.txt"), "Contact: x");
  writeFileSync(join(base, "secret.txt"), "outside");
  return { base, pub };
}

const req = (path: string, init: RequestInit = {}) => new Request("http://app.test" + path, init);

test("serves files with types, nosniff, ETag revalidation and HEAD", async () => {
  const { base, pub } = fixture();
  try {
    const files = publicFiles(pub);
    const res = (await files("/robots.txt", req("/robots.txt")))!;
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await res.text(), "User-agent: *\n");
    const etag = res.headers.get("etag")!;
    assert.match(etag, /^W\/"/);

    const again = (await files("/robots.txt", req("/robots.txt", { headers: { "if-none-match": etag } })))!;
    assert.equal(again.status, 304);
    const head = (await files("/robots.txt", req("/robots.txt", { method: "HEAD" })))!;
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "14");

    const svg = (await files("/img/logo.svg", req("/img/logo.svg")))!;
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    assert.match(svg.headers.get("content-security-policy") ?? "", /sandbox/);
    await svg.body?.cancel();
    const bin = (await files("/data.bin", req("/data.bin")))!;
    assert.equal(bin.headers.get("content-type"), "application/octet-stream");
    await bin.body?.cancel();
    const wk = (await files("/.well-known/security.txt", req("/")))!;
    assert.equal(await wk.text(), "Contact: x");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("refuses dotfiles, traversal, directories and encoded separators", async () => {
  const { base, pub } = fixture();
  try {
    const files = publicFiles(pub);
    for (const path of [
      "/.env",
      "/.git/config",
      "/img/.hidden",
      "/../secret.txt",
      "/img/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/img%2F..%2F..%2Fsecret.txt",
      "/img%5C..%5C..%5Csecret.txt",
      "/img",
      "/",
      "/missing.txt",
      "/robots.txt%00.png",
    ]) {
      assert.equal(await files(path, req("/")), null, path);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a symlink cannot reach outside the public directory", async (t) => {
  const { base, pub } = fixture();
  try {
    try {
      symlinkSync(join(base, "secret.txt"), join(pub, "link.txt"));
    } catch {
      t.skip("symlinks not permitted here");
      return;
    }
    assert.equal(await publicFiles(pub)("/link.txt", req("/")), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a missing public directory serves nothing", async () => {
  assert.equal(await publicFiles(join(tmpdir(), "weft-no-such-dir"))("/a.txt", req("/")), null);
});

test("content-hashed URLs are immutable and a wrong hash is a miss", async () => {
  const { base, pub } = fixture();
  try {
    const body = "User-agent: *\n";
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
    const manifest = await assetManifest(pub);
    assert.equal(manifest["/robots.txt"], `/robots.${hash}.txt`);
    const files = publicFiles(pub);
    const hashed = (await files(`/robots.${hash}.txt`, req("/robots.txt")))!;
    assert.equal(hashed.status, 200);
    assert.equal(hashed.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(await hashed.text(), body);
    assert.equal(await files("/robots.0000000000000000.txt", req("/")), null);
    const plain = (await files("/robots.txt", req("/robots.txt")))!;
    assert.match(plain.headers.get("cache-control") ?? "", /must-revalidate/);
    await plain.body?.cancel();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
