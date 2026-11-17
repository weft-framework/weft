import { defineHistory, defineModel, type Actor } from "@weft-framework/data";
import { emptyRichText, parseRichText, richTextToPlain, type RichDoc } from "@weft-framework/runtime";

export interface Note {
  id: string;
  workspace: string;
  title: string;
  body: string;
  author: string;
  shared: boolean;
  updated: number;
  deleted: number | null;
}

type Can = { id: string; can(permission: string, scope?: string): boolean };
const me = (a: Actor) => (typeof (a as Can | null)?.can === "function" ? (a as Can) : null);

export const Notes = defineModel<Note>("Note", {
  fields: {
    id: "string",
    workspace: "string",
    title: "string",
    body: "string",
    author: "string",
    shared: "boolean",
    updated: "number",
    deleted: "number | null",
  },
  attrs: { workspace: { tenant: true, index: true }, deleted: { softDelete: true } },
  read: (a, n) => {
    const p = me(a);
    return !!p && p.can("notes.read", n.workspace) && (n.shared || n.author === p.id);
  },
  write: (a, n) => {
    const p = me(a);
    return !!p && p.can("notes.edit", n.workspace) && (n.shared || n.author === p.id);
  },
});

export const noteHistory = defineHistory(Notes, { keep: 30 });

export const LIMITS = { maxBlocks: 500, maxText: 50_000 };

export function docOf(n: Note): RichDoc {
  const r = parseRichText(n.body, LIMITS);
  return r.ok ? r.doc : emptyRichText();
}

export function excerpt(n: Note, length = 140): string {
  const text = richTextToPlain(docOf(n)).replace(/\s+/g, " ").trim();
  return text.length > length ? text.slice(0, length - 1) + "…" : text;
}

export function newNoteId(): string {
  return "n_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}
