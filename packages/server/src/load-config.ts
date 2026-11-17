import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError, parseConfig, type WeftConfig } from "./config.ts";

export async function loadConfig(root: string, cacheKey = ""): Promise<WeftConfig> {
  const ts = join(root, "weft.config.ts");
  const js = join(root, "weft.config.js");
  const tsExists = existsSync(ts);
  const jsExists = existsSync(js);
  if (tsExists && jsExists) {
    throw new ConfigError("weft.config.ts: both weft.config.ts and weft.config.js exist");
  }
  const file = tsExists ? ts : jsExists ? js : null;
  if (!file) {
    return {};
  }
  const href = pathToFileURL(file).href + (cacheKey ? `?v=${encodeURIComponent(cacheKey)}` : "");
  let mod: Record<string, unknown>;
  try {
    mod = (await import(href)) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ConfigError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : "error";
    throw new ConfigError(`weft.config.ts: cannot load (${message})`);
  }
  if (!("default" in mod)) {
    throw new ConfigError("weft.config.ts: export a default object");
  }
  return parseConfig(mod.default);
}
