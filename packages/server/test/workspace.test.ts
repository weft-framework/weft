import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_RESTART_CODE, linkedPackages, watchedChange } from "../src/workspace.ts";

const here = dirname(fileURLToPath(import.meta.url));

function pkg(dir: string, name: string, deps: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, dependencies: deps }));
}

function link(target: string, at: string): void {
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at, "junction");
}

test("linkedPackages finds workspace links transitively and skips installed packages", () => {
  const ws = join(here, ".weft", "workspace");
  rmSync(ws, { recursive: true, force: true });
  pkg(ws, "root");
  const app = join(ws, "apps", "web");
  const shared = join(ws, "packages", "shared");
  const kit = join(ws, "packages", "kit");
  pkg(app, "web", { "@demo/shared": "*", lodash: "*" });
  pkg(shared, "@demo/shared", { "@demo/kit": "*" });
  pkg(kit, "@demo/kit", { "@demo/shared": "*" });
  pkg(join(ws, "node_modules", "lodash"), "lodash");
  link(shared, join(ws, "node_modules", "@demo", "shared"));
  link(kit, join(ws, "node_modules", "@demo", "kit"));
  const found = linkedPackages(app);
  assert.deepEqual(found.map((p) => p.name), ["@demo/kit", "@demo/shared"]);
  assert.ok(found.every((p) => !p.dir.includes("node_modules")));
  rmSync(ws, { recursive: true, force: true });
});

test("linkedPackages is empty without links or package.json", () => {
  const dir = join(here, ".weft", "workspace-none");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  assert.deepEqual(linkedPackages(dir), []);
  assert.deepEqual(linkedPackages(join(dir, "missing")), []);
  rmSync(dir, { recursive: true, force: true });
});

test("watchedChange ignores dependency and dot paths", () => {
  assert.equal(watchedChange("src/catalog.ts"), true);
  assert.equal(watchedChange(null), true);
  assert.equal(watchedChange("node_modules/x/index.js"), false);
  assert.equal(watchedChange(".turbo\\cache"), false);
  assert.equal(watchedChange("src/.cache/x"), false);
  assert.equal(DEV_RESTART_CODE, 75);
});
