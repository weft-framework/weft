import { definePresence, type PageContext } from "@weft/server";
import { guestOf, type Guest } from "./guest.ts";

export interface Visitor {
  name: string;
  color: number;
  page: string;
  tab: string;
}

export const site = definePresence<Visitor>("site");

const tabs = new WeakMap<PageContext, string>();

export function visit(ctx: PageContext, page: string): Guest & { tab: string } {
  const guest = guestOf(ctx);
  let tab = tabs.get(ctx);
  if (!tab) {
    tab = Math.random().toString(36).slice(2, 8);
    tabs.set(ctx, tab);
  }
  site.join(ctx, "all", { name: guest.name, color: guest.color, page, tab });
  return { ...guest, tab };
}

export const taskViewers = definePresence<{ name: string; image?: string }>("task-viewers", {
  pointers: { label: (info) => info.name },
});
