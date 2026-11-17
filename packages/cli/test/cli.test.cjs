"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const { binaryPath, platformPackage, PLATFORMS } = require("../index.cjs");

test("WEFT_BIN wins over the platform package", () => {
  const before = process.env.WEFT_BIN;
  process.env.WEFT_BIN = "/opt/weft/bin/weft";
  try {
    assert.equal(binaryPath(), "/opt/weft/bin/weft");
  } finally {
    if (before === undefined) delete process.env.WEFT_BIN;
    else process.env.WEFT_BIN = before;
  }
});

test("the platform package is named after this OS and CPU", () => {
  assert.equal(platformPackage(), `@weft-framework/cli-${process.platform}-${process.arch}`);
  assert.ok(PLATFORMS.includes("linux-x64") && PLATFORMS.includes("win32-x64") && PLATFORMS.includes("darwin-arm64"));
});

test("without a binary, the error says what to do", () => {
  const env = { ...process.env };
  delete env.WEFT_BIN;
  let message = "";
  try {
    execFileSync(process.execPath, [join(__dirname, "..", "bin", "weft.cjs"), "version"], { env, stdio: "pipe" });
  } catch (err) {
    message = String(err.stderr);
  }
  assert.match(message, /weft: (the binary for|there's no prebuilt binary)/);
});

test("the wrapper passes arguments and the exit code through", () => {
  const env = { ...process.env, WEFT_BIN: process.execPath };
  const out = execFileSync(process.execPath, [join(__dirname, "..", "bin", "weft.cjs"), "-e", "console.log(process.argv.length)"], { env, encoding: "utf8" });
  assert.equal(out.trim(), "1");
  assert.throws(
    () => execFileSync(process.execPath, [join(__dirname, "..", "bin", "weft.cjs"), "-e", "process.exit(3)"], { env, stdio: "pipe" }),
    (err) => err.status === 3,
  );
});
