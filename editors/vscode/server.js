// SPDX-License-Identifier: MIT
//
// Which `weft` executable runs the language server. Kept free of the
// `vscode` module so it can be tested with plain Node.
//
//   1. the `weft.server.path` setting (a relative path is taken from the
//      first workspace folder);
//   2. `node_modules/.bin/weft` in a workspace folder;
//   3. `weft` on PATH.

"use strict";

const path = require("node:path");
const fs = require("node:fs");

/**
 * @param {string | undefined} setting  the `weft.server.path` value
 * @param {string[]} folders  workspace folder paths
 * @param {{ exists?: (p: string) => boolean, platform?: string }} [env]
 * @returns {string}
 */
function resolveServer(setting, folders, env = {}) {
  const exists = env.exists ?? ((p) => fs.existsSync(p));
  const platform = env.platform ?? process.platform;
  const configured = (setting ?? "").trim();
  if (configured) {
    if (path.isAbsolute(configured) || folders.length === 0) {
      return configured;
    }
    return path.join(folders[0], configured);
  }
  const bin = platform === "win32" ? "weft.cmd" : "weft";
  for (const folder of folders) {
    const local = path.join(folder, "node_modules", ".bin", bin);
    if (exists(local)) {
      return local;
    }
  }
  return "weft";
}

module.exports = { resolveServer };
