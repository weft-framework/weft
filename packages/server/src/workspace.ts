import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export const DEV_RESTART_CODE = 75;

export interface LinkedPackage {
  name: string;
  dir: string;
}

function deps(dir: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const block = pkg[field];
      if (block && typeof block === "object") {
        for (const name of Object.keys(block)) {
          names.add(name);
        }
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

function resolveFrom(from: string, name: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (statSync(join(candidate, "package.json"), { throwIfNoEntry: false })?.isFile()) {
      try {
        return realpathSync(candidate);
      } catch {
        return null;
      }
    }
    if (dirname(dir) === dir) {
      return null;
    }
  }
}

function insideNodeModules(path: string): boolean {
  return path.split(sep).includes("node_modules") || path.split("/").includes("node_modules");
}

export function linkedPackages(root: string): LinkedPackage[] {
  const out = new Map<string, LinkedPackage>();
  let self: string;
  try {
    self = realpathSync(root);
  } catch {
    return [];
  }
  const queue: string[] = [self];
  const seen = new Set<string>(queue);
  while (queue.length > 0) {
    const from = queue.shift()!;
    for (const name of deps(from)) {
      const dir = resolveFrom(from, name);
      if (!dir || insideNodeModules(dir) || seen.has(dir)) {
        continue;
      }
      seen.add(dir);
      out.set(dir, { name, dir });
      queue.push(dir);
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function watchedChange(file: string | null): boolean {
  if (!file) {
    return true;
  }
  const parts = file.split(/[\\/]/);
  return !parts.some((p) => p === "node_modules" || p.startsWith("."));
}
