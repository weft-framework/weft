import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataManifest } from "../src/datamap.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, ".weft", "datamap");

const FILES: Record<string, string> = {
  "models/Note.ts": [
    `import { defineModel } from "@weft-framework/data";`,
    `export interface Note { id: string; owner: string; secret: string }`,
    `export const DmNote = defineModel<Note>("DmNote", { fields: { id: "string", owner: "string", secret: "string" }, read: () => true, write: () => true });`,
    `// DmOld: a model nothing reads.`,
    `export const DmOld = defineModel<{ id: string; note: string }>("DmOld", { fields: { id: "string", note: "string" }, read: () => true, write: () => true });`,
    `export const DmTag = defineModel<{ id: string }>("DmTag", { fields: { id: "string" }, read: () => true, write: () => true });`,
  ].join("\n"),
  "models/switches.ts": [
    `import { defineModel } from "@weft-framework/data";`,
    `const Switch = defineModel<{ id: string }>("DmSwitch", { fields: { id: "string" }, read: () => true, write: () => true });`,
    `export const switches = { models: { Switch }, on: (n: string) => Switch.as(null).get(n) !== undefined };`,
    `export const { Switch: DmSwitch } = switches.models;`,
  ].join("\n"),
  "lib/notes.ts": [
    `import { DmNote, type Note } from "../models/Note.ts";`,
    `export function mine(a: unknown): Note[] { return DmNote.as(a).where((n) => n.owner === "x"); }`,
    `export function add(a: unknown) { return DmNote.as(a).create({ id: "1", owner: "x", secret: "s" }); }`,
  ].join("\n"),
  "pages/_layout.ts": [`import { switches } from "../models/switches.ts";`, `export const beta = () => switches.on("beta");`].join("\n"),
  "pages/index.ts": [`import { mine } from "../lib/notes.ts";`, `import { escapeHtml } from "@weft-framework/runtime";`, `export const load = () => mine(null);`].join("\n"),
  "pages/about.ts": [`import type { DmNote } from "../models/Note.ts";`, `type N = typeof DmNote;`, `export const load = () => ({});`].join("\n"),
  "pages/notes/[id].ts": [
    `import { DmNote, DmTag } from "../../models/Note.ts";`,
    `export const load = (ctx: any, g: any) => ({ note: DmNote.as(ctx.user).using(g).get(ctx.params.id), tags: DmTag.publicUnscoped() });`,
  ].join("\n"),
  "pages/api/notes.ts": [
    `import * as M from "../../models/Note.ts";`,
    `export function GET() { const h = M.DmNote.as(null); h.get("1"); return new Response("ok"); }`,
  ].join("\n"),
  "pages/_private/skip.ts": `export const x = 1;`,
};

test("each route's models: reads, writes, unscoped, grants and unseen handles", async () => {
  rmSync(root, { recursive: true, force: true });
  for (const [rel, src] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), src + "\n");
  }
  const m = await dataManifest(root);
  assert.deepEqual(Object.keys(m.routes).sort(), ["/", "/about", "/notes/[id]"]);
  assert.deepEqual(Object.keys(m.api), ["/api/notes"]);
  assert.equal(m.middleware, null);

  const home = m.routes["/"]!;
  assert.deepEqual(home.modules, ["lib/notes.ts", "models/Note.ts", "models/switches.ts", "pages/_layout.ts", "pages/index.ts"]);
  assert.deepEqual(home.reads, ["DmNote"], "lib/notes.ts reads");
  assert.deepEqual(home.writes, ["DmNote"], "the whole helper module counts: it also writes");
  assert.deepEqual(home.uses, ["DmSwitch"], "the layout uses an object with .models");
  assert.ok(home.packages.includes("@weft-framework/runtime") && home.packages.includes("@weft-framework/data"));

  const about = m.routes["/about"]!;
  assert.deepEqual([about.reads, about.writes, about.uses, about.unscoped], [[], [], ["DmSwitch"], []], "types are not uses");

  const note = m.routes["/notes/[id]"]!;
  assert.deepEqual(note.reads, ["DmNote"]);
  assert.deepEqual(note.grants, ["DmNote"]);
  assert.deepEqual(note.unscoped, ["DmTag"]);
  assert.deepEqual(note.writes, []);

  assert.deepEqual(m.api["/api/notes"]!.uses, ["DmNote"], "a handle stored in a variable: read or write");

  assert.deepEqual(m.models.DmNote, { readBy: ["/", "/notes/[id]", "api /api/notes"], writtenBy: ["/", "api /api/notes"] });
  assert.deepEqual(m.models.DmTag, { readBy: ["/notes/[id]"], writtenBy: [] });
  assert.deepEqual(m.models.DmSwitch!.readBy, ["/", "/about", "/notes/[id]"]);
  assert.deepEqual(m.unused, { models: ["DmOld"], fields: { DmNote: ["secret"], DmOld: ["note"] } });
  rmSync(root, { recursive: true, force: true });
});
