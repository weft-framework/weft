"use strict";

const { accessSync, chmodSync, constants } = require("node:fs");

const PLATFORMS = [
  "win32-x64",
  "win32-arm64",
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
];

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function platformPackage() {
  return `@weft-framework/cli-${platformKey()}`;
}

function ensureExecutable(file) {
  if (process.platform === "win32") return;
  try {
    accessSync(file, constants.X_OK);
  } catch {
    chmodSync(file, 0o755);
  }
}

function binaryPath() {
  if (process.env.WEFT_BIN) return process.env.WEFT_BIN;
  const exe = process.platform === "win32" ? "weft.exe" : "weft";
  const pkg = platformPackage();
  let file;
  try {
    file = require.resolve(`${pkg}/bin/${exe}`);
  } catch {
    const known = PLATFORMS.includes(platformKey());
    throw new Error(
      known
        ? `weft: the binary for ${platformKey()} isn't installed (${pkg} is missing).\n` +
            "This usually means npm skipped optional dependencies. Try reinstalling without\n" +
            "--omit=optional or --no-optional, and make sure the lockfile wasn't made on another OS."
        : `weft: there's no prebuilt binary for ${platformKey()} yet.\n` +
            "You can build one from source and point WEFT_BIN at it:\n" +
            "  cargo install --git https://github.com/weft-framework/weft weft-cli",
    );
  }
  ensureExecutable(file);
  return file;
}

module.exports = { binaryPath, platformPackage, PLATFORMS };
