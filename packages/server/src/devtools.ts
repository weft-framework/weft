import { UNSCOPED, type AuditEvent } from "@weft/data";
import type { ServerMessage } from "@weft/runtime";
import type { InspectNode } from "./live.ts";
import type { Deps } from "./sync.ts";
import type { RecordedStep } from "./replay.ts";

export const DEV_LOG_MAX = 100;

export interface DevMessage {
  at: number;
  dir: "in" | "push" | "warn";
  what: string;
  ms?: number;
  out: string[];
}

export interface DevDecision {
  at: number;
  model: string;
  action: string;
  outcome: "allowed" | "denied";
  count: number;
  actor: string;
  reason?: string;
}

export const DEV_FRAMES_MAX = 50;
export const DEV_FRAMES_BYTES = 2 * 1024 * 1024;

export interface DevFrame {
  n: number;
  at: number;
  what: string;
  html: string;
}

export interface DevLog {
  messages: DevMessage[];
  frames: DevFrame[];
  step: number;
  opened: number;
  steps: RecordedStep[];
}

export interface DevRead {
  model: string;
  scope: string[];
}

export interface DevSnapshot {
  viewing: { user: string; operator: string; until: number; tenant?: string } | null;
  lid: string;
  path: string;
  tree: InspectNode;
  messages: DevMessage[];
  frames: { n: number; at: number; what: string; bytes: number }[];
  decisions: DevDecision[];
  reads: { load: DevRead[]; render: DevRead[] };
  stores: number;
  cost: { events: number; refreshes: number; ms: number; bytes: number; heldBytes: number };
  capacity: { route: string; heapLimit: number; heapUsed: number; perPage: number; pages: number } | null;
}

export function devLog(): DevLog {
  return { messages: [], frames: [], step: 0, opened: Date.now(), steps: [] };
}

export function frame(log: DevLog, what: string, html: string, at = Date.now()): void {
  if (log.frames.at(-1)?.html === html) return;
  log.frames.push({ n: log.step++, at, what, html });
  let bytes = log.frames.reduce((sum, f) => sum + f.html.length, 0);
  while (log.frames.length > 1 && (log.frames.length > DEV_FRAMES_MAX || bytes > DEV_FRAMES_BYTES)) {
    bytes -= log.frames.shift()!.html.length;
  }
}

export function frameList(log: DevLog | undefined): DevSnapshot["frames"] {
  return (log?.frames ?? []).map((f) => ({ n: f.n, at: f.at, what: f.what, bytes: enc.encode(f.html).length }));
}

const enc = new TextEncoder();

export function note<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > DEV_LOG_MAX) list.splice(0, list.length - DEV_LOG_MAX);
}

export function describe(msg: ServerMessage): string {
  switch (msg.t) {
    case "patch":
      return `patch ${msg.id} (${new TextEncoder().encode(msg.html).length} B)`;
    case "redirect":
      return `redirect ${msg.to}`;
    case "error":
      return `error: ${msg.message}`;
    case "ack":
      return "ack";
    case "head":
      return `head "${msg.title}"`;
    default:
      return msg.t;
  }
}

export function actorLabel(actor: unknown): string {
  if (actor === UNSCOPED) return "unscoped";
  if (actor === null || actor === undefined) return "anonymous";
  if (typeof actor === "object" && "id" in actor) return `id ${String((actor as { id: unknown }).id)}`;
  if (typeof actor === "string" || typeof actor === "number") return `id ${actor}`;
  return "actor";
}

export function decision(ev: AuditEvent): DevDecision {
  const d: DevDecision = {
    at: ev.at.getTime(),
    model: ev.model,
    action: ev.action,
    outcome: ev.outcome,
    count: ev.count,
    actor: actorLabel(ev.actor) + (ev.via !== undefined ? ` (via id ${ev.via})` : ""),
  };
  if (ev.reason !== undefined) d.reason = ev.reason;
  return d;
}

export function readsOf(deps: Deps<unknown>): DevRead[] {
  return [...deps.reads].map(([model, r]) => ({ model, scope: [...r.actors].map(actorLabel) }));
}
