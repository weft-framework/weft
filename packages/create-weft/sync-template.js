// SPDX-License-Identifier: MIT
//
// Copy the starter templates and the component registry from the Rust CLI
// (their single source, embedded in `weft new`) into this package as
// `template/{welcome,minimal,registry}`, so the published `create-weft`
// carries them. Run by `npm pack`/`npm publish` (prepack); the
// copy is git-ignored.

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "crates", "weft-cli");
const to = join(here, "template");
const copies = [
  [join(cli, "templates", "welcome"), join(to, "welcome")],
  [join(cli, "templates", "app"), join(to, "minimal")],
  [join(cli, "registry", "ui"), join(to, "registry", "ui")],
  [join(cli, "registry", "lib"), join(to, "registry", "lib")],
];

for (const [from] of copies) {
  if (!existsSync(from)) {
    console.error(`sync-template: ${from} not found`);
    process.exit(1);
  }
}
rmSync(to, { recursive: true, force: true });
for (const [from, dest] of copies) {
  cpSync(from, dest, { recursive: true, verbatimSymlinks: true });
}
console.log("sync-template: template/ updated");
