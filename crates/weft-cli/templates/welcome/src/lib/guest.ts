import type { PageContext } from "@weft-framework/server";

export interface Guest {
  id: string;
  name: string;
  color: number;
}

export const THREADS = ["#2f6bff", "#e5484d", "#12a594", "#f76b15", "#8e4ec6", "#c79a00", "#d6409f", "#46a758"];

const ANIMALS = ["Otter", "Heron", "Lynx", "Wren", "Ibex", "Marten", "Puffin", "Gecko", "Orca", "Kestrel", "Bison", "Newt"];

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function guestOf(ctx: PageContext): Guest {
  const h = hash("weft-guest:" + ctx.session);
  const tag = (h >>> 8).toString(36).slice(0, 3).toUpperCase();
  const name = `${ANIMALS[h % ANIMALS.length]} ${tag}`;
  return { id: name, name, color: (h >>> 4) % THREADS.length };
}
