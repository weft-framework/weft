import { defaultActorId } from "./audit.ts";
import type { Actor } from "./model.ts";
import { afterCommit, snapshot } from "./tx.ts";

declare const FILE: unique symbol;

export type FileRef = string & { readonly [FILE]: true };

interface Hold {
  actor: string;
  expires: number;
}

export const HOLD_MS = 60_000;

const holds = new Map<string, Hold>();
const listeners = new Set<(id: string) => void>();
let clock: () => number = () => Date.now();

function actorKey(actor: Actor): string {
  const id = defaultActorId(actor);
  if (id !== null) return `id:${id}`;
  return actor === null || actor === undefined ? "none" : `json:${JSON.stringify(actor)}`;
}

export function holdFile(id: string, actor: Actor, ttlMs = HOLD_MS): void {
  if (typeof id !== "string" || id === "") throw new Error("holdFile: a file id is required");
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("holdFile: ttlMs must be a positive integer");
  holds.set(id, { actor: actorKey(actor), expires: clock() + ttlMs });
}

export function holdsFile(id: unknown, actor: Actor): boolean {
  if (typeof id !== "string") return false;
  const h = holds.get(id);
  return h !== undefined && h.expires > clock() && h.actor === actorKey(actor);
}

export function takeFile(id: string): void {
  snapshot(holds, () => {
    const saved = new Map(holds);
    return () => {
      holds.clear();
      for (const [k, v] of saved) holds.set(k, v);
    };
  });
  holds.delete(id);
}

export function releaseFiles(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const list = [...ids];
  afterCommit(() => {
    for (const id of list) notify(id);
  });
}

function notify(id: string): void {
  for (const fn of listeners) {
    try {
      fn(id);
    } catch {
    }
  }
}

export function onFileRelease(fn: (id: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function sweepHeldFiles(): number {
  const now = clock();
  const expired = [...holds].filter(([, h]) => h.expires <= now).map(([id]) => id);
  for (const id of expired) holds.delete(id);
  for (const id of expired) notify(id);
  return expired.length;
}

export function setFileClock(now: () => number): () => number {
  const prev = clock;
  clock = now;
  return prev;
}
