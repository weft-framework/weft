import { defineRoom, type Room } from "@weft/runtime";
import type { PageContext } from "./context.ts";

interface Member {
  gen: number;
  away: boolean;
  recs: Map<PresenceImpl<unknown>, Map<string, { info: unknown; json: string; gen: number }>>;
}

const members = new WeakMap<PageContext, Member>();

export interface Presence<I> {
  readonly name: string;
  join(ctx: PageContext, room: string, info: I): void;
  in(room: string): readonly I[];
}

export interface PresenceOptions<I = unknown> {
  maxRooms?: number;
  pointers?: { label?: (info: I) => string | null | undefined };
}

class PresenceImpl<I> implements Presence<I> {
  readonly name: string;
  private readonly rooms: Room<readonly I[]>;
  private readonly here = new Map<string, Map<Member, I>>();
  private readonly max: number;
  readonly pointers: PresenceOptions<I>["pointers"];

  constructor(name: string, opts: PresenceOptions<I>) {
    this.name = name;
    this.max = opts.maxRooms ?? 10_000;
    this.pointers = opts.pointers;
    this.rooms = defineRoom<readonly I[]>(`presence:${name}`, () => Object.freeze([]), { maxRooms: this.max + 1 });
  }

  join(ctx: PageContext, room: string, info: I): void {
    const m = members.get(ctx);
    if (!m) {
      throw new Error(`@weft/server: presence ${this.name}: join from the load of a live page`);
    }
    if (typeof room !== "string" || room === "" || room.length > 256) {
      throw new Error(`@weft/server: presence ${this.name}: a room is a string of 1-256 characters`);
    }
    let mine = m.recs.get(this as PresenceImpl<unknown>);
    if (!mine) {
      mine = new Map();
      m.recs.set(this as PresenceImpl<unknown>, mine);
    }
    const json = JSON.stringify(info) ?? "";
    const before = mine.get(room);
    mine.set(room, { info, json, gen: m.gen });
    if (visible(m) && before?.json !== json) {
      this.put(m, room, info);
    }
  }

  in(room: string): readonly I[] {
    return this.rooms.in(room).value;
  }

  put(m: Member, room: string, info: I): void {
    let set = this.here.get(room);
    if (!set) {
      if (this.here.size >= this.max) {
        return;
      }
      set = new Map();
      this.here.set(room, set);
    }
    set.set(m, info);
    this.publish(room, set);
    for (const fn of roomWatchers) fn(this.name, room);
  }

  remove(m: Member, room: string): void {
    const set = this.here.get(room);
    if (!set?.delete(m)) return;
    this.publish(room, set);
    for (const fn of roomWatchers) fn(this.name, room);
    if (set.size === 0) {
      this.here.delete(room);
    }
  }

  private publish(room: string, set: Map<Member, I>): void {
    this.rooms.in(room).value = Object.freeze([...set.values()]);
  }
}

const visible = (m: Member) => !m.away;

const named = new Map<string, PresenceImpl<unknown>>();
const roomWatchers = new Set<(presence: string, room: string) => void>();

export function watchRooms(fn: (presence: string, room: string) => void): void {
  roomWatchers.add(fn);
}

export function pointerPresence(name: string): { name: string; label?: (info: unknown) => string | null | undefined } | null {
  const p = named.get(name);
  return p?.pointers ? { name, ...(p.pointers.label ? { label: p.pointers.label } : {}) } : null;
}

export function presenceIn(ctx: PageContext, name: string, room: string): { info: unknown } | null {
  const p = named.get(name);
  const m = members.get(ctx);
  if (!p || !m || !visible(m)) return null;
  const rec = m.recs.get(p)?.get(room);
  return rec ? { info: rec.info } : null;
}

export function definePresence<I>(name: string, opts: PresenceOptions<I> = {}): Presence<I> {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    throw new Error("@weft/server: a presence name is 1-64 letters, digits, `_`, `-` or `.`");
  }
  if (opts.pointers !== undefined && (typeof opts.pointers !== "object" || opts.pointers === null || (opts.pointers.label !== undefined && typeof opts.pointers.label !== "function"))) {
    throw new Error("@weft/server: presence `pointers` is `{ label?: (info) => string }`");
  }
  const p = new PresenceImpl<I>(name, opts);
  named.set(name, p as PresenceImpl<unknown>);
  return p;
}

export function presenceStartAway(ctx: PageContext): void {
  if (!members.has(ctx)) {
    members.set(ctx, { gen: 0, away: true, recs: new Map() });
  }
}

export function presenceBegin(ctx: PageContext): void {
  let m = members.get(ctx);
  if (!m) {
    m = { gen: 0, away: false, recs: new Map() };
    members.set(ctx, m);
  }
  m.gen += 1;
}

export function presenceEnd(ctx: PageContext): void {
  const m = members.get(ctx);
  if (!m) return;
  for (const [p, mine] of m.recs) {
    for (const [room, rec] of mine) {
      if (rec.gen !== m.gen) {
        mine.delete(room);
        p.remove(m, room);
      }
    }
  }
}

export function presenceHeld(ctx: PageContext): boolean {
  const m = members.get(ctx);
  if (!m) return false;
  for (const mine of m.recs.values()) {
    if (mine.size > 0) return true;
  }
  return false;
}

export function presenceAway(ctx: PageContext, away: boolean): void {
  const m = members.get(ctx);
  if (!m || m.away === away) return;
  m.away = away;
  if (away) hide(m);
  else show(m);
}

export function presenceRelease(ctx: PageContext): void {
  const m = members.get(ctx);
  if (!m) return;
  hide(m);
  m.recs.clear();
  members.delete(ctx);
}

function show(m: Member): void {
  for (const [p, mine] of m.recs) {
    for (const [room, rec] of mine) p.put(m, room, rec.info);
  }
}

function hide(m: Member): void {
  for (const [p, mine] of m.recs) {
    for (const room of mine.keys()) p.remove(m, room);
  }
}
