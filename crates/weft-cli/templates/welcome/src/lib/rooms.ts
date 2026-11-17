import { defineBookings, SqlBookingStore, type Availability } from "@weft-framework/server/calendar";
import type { PageContext } from "@weft-framework/server";
import { access } from "../access.ts";
import { db } from "./db.ts";
import { notify } from "./notify.ts";

export interface Room {
  id: string;
  name: string;
  note: string;
  duration: number;
  capacity: number;
}

export const ROOMS: Room[] = [
  { id: "focus", name: "Focus room", note: "Two chairs and a door that shuts. 30 minutes.", duration: 30, capacity: 1 },
  { id: "studio", name: "Studio", note: "Screen and whiteboard for up to ten. One hour.", duration: 60, capacity: 1 },
];

export const resourceId = (workspace: string, room: string) => `${workspace}~${room}`;

function parse(id: string): { workspace: string; room: Room } | null {
  const i = id.lastIndexOf("~");
  const room = ROOMS.find((r) => r.id === id.slice(i + 1));
  return i > 0 && room ? { workspace: id.slice(0, i), room } : null;
}

type Me = { id: string; tenant?: string; can(p: string, s?: string): boolean } | null;
const meIn = (ctx: PageContext | null, workspace: string) => {
  const me = ctx?.user as Me;
  return me && me.tenant === workspace ? me : null;
};

export function availability(workspace: string, room: Room): Availability {
  const [from, to] = String(access.settingValue(workspace, "calendar.hours") ?? "09:00-18:00").split("-") as [string, string];
  const zone = String(access.settingValue(workspace, "calendar.zone") ?? "UTC");
  const day: [string, string][] = [[from, to]];
  return {
    timeZone: zone,
    hours: { mon: day, tue: day, wed: day, thu: day, fri: day },
    duration: room.duration,
    bufferAfter: 0,
    minNotice: 15,
    maxDaysAhead: 30,
    capacity: room.capacity,
  };
}

export const bookings = defineBookings({
  name: "rooms",
  store: new SqlBookingStore(db),
  resource: (id, ctx) => {
    const r = parse(id);
    if (!r) return null;
    const me = meIn(ctx, r.workspace);
    if (ctx && !(me?.can("calendar.book", r.workspace) || me?.can("calendar.manage", r.workspace))) return null;
    return availability(r.workspace, r.room);
  },
  allow: (ctx, id) => {
    const r = parse(id);
    return !!r && !!meIn(ctx, r.workspace)?.can("calendar.book", r.workspace);
  },
  manage: (ctx, id) => {
    const r = parse(id);
    return !!r && !!meIn(ctx, r.workspace)?.can("calendar.manage", r.workspace);
  },
  changeUntil: 10,
  reminders: {
    before: [15],
    send: (_job, b) => {
      const r = parse(b.resource);
      return notify.send(b.owner, "booking", {
        title: `${r?.room.name ?? "Your room"} in 15 minutes`,
        body: b.note || "Your booking starts soon.",
        url: "/app/rooms",
        tenant: r?.workspace ?? null,
      });
    },
  },
});

export function roomOf(resource: string): Room | null {
  return parse(resource)?.room ?? null;
}
