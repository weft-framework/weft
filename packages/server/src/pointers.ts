import { createHash, randomBytes } from "node:crypto";
import { runtimeAttrs, type PointAt, type PointMessage, type Pointer, type PointSel, type PointView, type ServerMessage } from "@weft/runtime";
import type { PageContext } from "./context.ts";
import { pointerPresence, presenceIn, watchRooms, type Presence } from "./presence.ts";

type Send = (msg: ServerMessage) => void;

interface Member {
  id: string;
  ctx: PageContext;
  send: Send;
  at: PointAt | null;
  sel: PointSel | null;
  view: PointView | null;
}

interface Area {
  token: string;
  presence: string;
  room: string;
  members: Map<object, Member>;
  timer: ReturnType<typeof setTimeout> | null;
}

const BROADCAST_MS = 50;
const areas = new Map<string, Area>();

const tokenOf = (presence: string, room: string) => "p." + Buffer.from(JSON.stringify([presence, room]), "utf8").toString("base64url");

function parseToken(token: string): { presence: string; room: string } | null {
  if (!token.startsWith("p.")) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(token.slice(2), "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || typeof v[1] !== "string") return null;
    return tokenOf(v[0], v[1]) === token ? { presence: v[0], room: v[1] } : null;
  } catch {
    return null;
  }
}

export function pointerArea(presence: Presence<any>, room: string): Readonly<Record<string, string>> {
  if (!pointerPresence(presence.name)) {
    throw new Error(`@weft/server: presence ${presence.name} does not share pointers; define it with \`pointers: {}\``);
  }
  if (typeof room !== "string" || room === "" || room.length > 256) {
    throw new Error("@weft/server: a room is a string of 1-256 characters");
  }
  return runtimeAttrs({ "data-weft-point": tokenOf(presence.name, room) });
}

const SALT = randomBytes(32);
let counter = 0;
const memberId = (area: string, tab: string | undefined) =>
  tab === undefined
    ? `p${(++counter).toString(36)}${randomBytes(3).toString("hex")}`
    : "t" + createHash("sha256").update(SALT).update(area).update("\0").update(tab).digest("base64url").slice(0, 16);

function prune(a: Area): void {
  for (const [entry, m] of a.members) {
    if (!presenceIn(m.ctx, a.presence, a.room)) a.members.delete(entry);
  }
  if (a.members.size === 0) {
    if (a.timer !== null) clearTimeout(a.timer);
    areas.delete(a.token);
  }
}

function soon(a: Area): void {
  if (a.timer !== null) return;
  a.timer = setTimeout(() => {
    a.timer = null;
    broadcast(a);
  }, BROADCAST_MS);
  a.timer.unref?.();
}

function broadcast(a: Area): void {
  prune(a);
  if (a.members.size === 0) return;
  const p = pointerPresence(a.presence);
  const shown: Pointer[] = [];
  const of = new Map<Member, Pointer>();
  for (const m of a.members.values()) {
    if (!m.at && !m.sel && !m.view) continue;
    const ptr: Pointer = { id: m.id };
    if (p?.label) {
      try {
        const info = presenceIn(m.ctx, a.presence, a.room)?.info;
        const label = p.label(info);
        if (typeof label === "string" && label !== "") ptr.label = label.slice(0, 200);
      } catch {
      }
    }
    if (m.at) ptr.at = m.at;
    if (m.sel) ptr.sel = m.sel;
    if (m.view) ptr.view = m.view;
    shown.push(ptr);
    of.set(m, ptr);
  }
  for (const m of a.members.values()) {
    const mine = of.get(m);
    m.send({ t: "point", area: a.token, list: mine ? shown.filter((x) => x !== mine) : shown });
  }
}

export function pointMessage(entry: object, ctx: PageContext, msg: PointMessage, send: Send): void {
  const name = parseToken(msg.area);
  if (!name || !pointerPresence(name.presence) || !presenceIn(ctx, name.presence, name.room)) {
    const a = areas.get(msg.area);
    if (a?.members.delete(entry)) soon(a);
    return;
  }
  let a = areas.get(msg.area);
  if (!a) {
    a = { token: msg.area, presence: name.presence, room: name.room, members: new Map(), timer: null };
    areas.set(a.token, a);
  }
  let m = a.members.get(entry);
  if (!m) {
    m = { id: memberId(a.token, msg.tab), ctx, send, at: null, sel: null, view: null };
    a.members.set(entry, m);
  }
  m.ctx = ctx;
  m.send = send;
  if (msg.join) {
    if (msg.tab !== undefined) m.id = memberId(a.token, msg.tab);
    m.at = m.sel = m.view = null;
  } else {
    if (msg.at !== undefined) m.at = msg.at;
    if (msg.sel !== undefined) m.sel = msg.sel;
    if (msg.view !== undefined) m.view = msg.view;
  }
  soon(a);
}

export function pointLeave(entry: object): void {
  for (const a of [...areas.values()]) {
    if (a.members.delete(entry)) {
      if (a.members.size === 0) {
        if (a.timer !== null) clearTimeout(a.timer);
        areas.delete(a.token);
      } else {
        soon(a);
      }
    }
  }
}

watchRooms((presence, room) => {
  const a = areas.get(tokenOf(presence, room));
  if (a) soon(a);
});

export function resetPointers(): void {
  for (const a of areas.values()) if (a.timer !== null) clearTimeout(a.timer);
  areas.clear();
}
