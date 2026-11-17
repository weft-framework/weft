import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "./secret.ts";

export function loadEnvFile(file: string, env: Record<string, string | undefined> = process.env): string[] {
  if (!existsSync(file)) return [];
  const parsed = parseEnv(readFileSync(file, "utf8"), file);
  const set: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined) {
      env[k] = v;
      set.push(k);
    }
  }
  return set;
}
