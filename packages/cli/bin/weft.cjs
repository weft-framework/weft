#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { binaryPath } = require("../index.cjs");

let bin;
try {
  bin = binaryPath();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit", windowsHide: false });
if (result.error) {
  console.error(`weft: couldn't start ${bin}: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
