import { createHash } from "node:crypto";
import type { DevMessage } from "./devtools.ts";
import type { InspectNode } from "./live.ts";

export interface InspectPage {
  page: string;
  path: string;
}

export interface InspectView {
  page: string;
  path: string;
  tree: InspectNode;
  messages: DevMessage[];
  frames: { n: number; at: number; what: string; bytes: number }[];
  reads: { load: { model: string; scope: string[] }[]; render: { model: string; scope: string[] }[] };
}

export interface InspectHub {
  pages(key: string): InspectPage[];
  watch(key: string, until: number): void;
  view(key: string, page: string): InspectView | null;
  frame(key: string, page: string, n: number): { n: number; at: number; what: string; html: string } | null;
}

const hubs = new Set<InspectHub>();

export function addInspectHub(hub: InspectHub): () => void {
  hubs.add(hub);
  return () => {
    hubs.delete(hub);
  };
}

export function inspectHubs(): InspectHub[] {
  return [...hubs];
}

export function sessionKey(sid: string): string {
  return createHash("sha256").update("weft-inspect\0").update(sid).digest("base64url").slice(0, 32);
}
