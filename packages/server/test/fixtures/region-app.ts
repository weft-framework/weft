import { defineModel } from "@weft-framework/data";
import { openSqlite } from "@weft-framework/data/sqlite";
import { useDatabase } from "@weft-framework/data";
import { defineComponent, escapeHtml, signal } from "@weft-framework/runtime";
import { createApp } from "../../src/app.ts";
import { external } from "../../src/api.ts";
import { MemorySessionStore } from "../../src/auth.ts";
import { defineRegions } from "../../src/regions.ts";
import { serveNode } from "../../src/node.ts";

export const SECRET = "region-test-app-secret-0123456789abcdef";
export const REGION_SECRET = "region-test-shared-secret-0123456789abc";

export interface Note {
  id: string;
  text: string;
  at: Date;
  region: string | null;
}

export function setup(o: { region: string; primaryUrl: string; db?: string; fetch?: typeof fetch; maxLagMs?: number }) {
  const Note = defineModel<Note>("RegionNote", {
    fields: { id: "string", text: "string", at: "Date", region: "string | null" },
    read: () => true,
    write: () => true,
    residency: (n) => n.region,
  });
  if (o.db) useDatabase(openSqlite(o.db), [Note as never]);
  const regions = defineRegions({
    region: o.region,
    primary: "fra",
    primaryUrl: o.primaryUrl,
    secret: REGION_SECRET,
    models: [Note],
    onError: () => {},
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.maxLagMs !== undefined ? { maxLagMs: o.maxLagMs } : {}),
  });
  const List = defineComponent("RegionList", (p: { notes: Note[]; region: string }) => ({
    handlers: {},
    render: () => `<p>served by ${p.region}</p><ul>${p.notes.map((n) => `<li>${escapeHtml(n.text)}</li>`).join("")}</ul>`,
  }));
  const Counter = defineComponent("RegionCounter", (p: { region: string }) => {
    const n = signal(0);
    return { handlers: { add: () => void (n.value += 1) }, render: () => `<p>served by ${p.region}</p><button data-weft-on-click="add">${n.value}</button>` };
  });
  const app = createApp({
    secret: SECRET,
    regions,
    auth: { store: regions.sessions(new MemorySessionStore()) },
    onError: () => {},
    routes: {
      "/notes": {
        component: List as never,
        load: () => ({ notes: Note.as("anyone").query().orderBy("id").rows(), region: o.region }) as never,
      },
      "/counter": { component: Counter as never, load: () => ({ region: o.region }) as never },
      "/writes": {
        component: List as never,
        load: () => {
          Note.as("anyone").create({ id: `w${Date.now()}`, text: "from a load", at: new Date(), region: null });
          return { notes: [], region: o.region } as never;
        },
      },
    },
    api: {
      "/api/notes": {
        POST: external(async (ctx) => {
          const body = (await ctx.request.json()) as { id: string; text: string; region?: string };
          Note.as("anyone").create({ id: body.id, text: body.text, at: new Date(Date.UTC(2026, 0, 2)), region: body.region ?? null });
          return Response.json({ ok: true, region: o.region, host: new URL(ctx.request.url).host });
        }),
      },
    },
  });
  return { app, regions, Note };
}

if (process.argv[2]) {
  const port = Number(process.argv[2]);
  const { app } = setup({ region: "fra", primaryUrl: `http://127.0.0.1:${port}`, db: process.argv[3] });
  const s = await serveNode(app, { port, host: "127.0.0.1" });
  console.log(`ready ${s.url}`);
}
