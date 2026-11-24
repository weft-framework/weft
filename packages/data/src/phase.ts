export type Phase = "build" | "run";

export function currentPhase(): Phase {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.WEFT_PHASE === "build" ? "build" : "run";
}

export function isBuildPhase(): boolean {
  return currentPhase() === "build";
}

export async function inBuildPhase<R>(fn: () => Promise<R>): Promise<R> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!env) return fn();
  const before = env.WEFT_PHASE;
  env.WEFT_PHASE = "build";
  try {
    return await fn();
  } finally {
    if (before === undefined) delete env.WEFT_PHASE;
    else env.WEFT_PHASE = before;
  }
}
