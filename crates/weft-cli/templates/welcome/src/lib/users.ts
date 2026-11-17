import { defineModel, type Actor } from "@weft-framework/data";
import { access } from "../access.ts";

export interface User {
  id: string;
  email: string;
  name: string;
  password: string | null;
  created: number;
}

export interface Profile {
  id: string;
  name: string;
  color: number;
}

class System {}
const system = new System();
const isSystem = (a: Actor) => a instanceof System;
const idOf = (a: Actor) => (a as { id?: unknown } | null)?.id;

export const Users = defineModel<User>("User", {
  fields: { id: "string", email: "string", name: "string", password: "string | null", created: "number" },
  attrs: { email: { unique: true } },
  read: (a, u) => isSystem(a) || idOf(a) === u.id,
  write: (a, u) => isSystem(a) || idOf(a) === u.id,
});

export function sharesWorkspace(a: string, b: string): boolean {
  if (a === b) return true;
  return access.tenantsOf(a).some((t) => access.memberOf(b, t.id));
}

export const Profiles = defineModel<Profile>("Profile", {
  fields: { id: "string", name: "string", color: "number" },
  read: (a, p) => isSystem(a) || (typeof idOf(a) === "string" && sharesWorkspace(idOf(a) as string, p.id)),
  write: (a, p) => isSystem(a) || idOf(a) === p.id,
});

export const COLORS = ["#2f6bff", "#e5484d", "#12a594", "#f76b15", "#8e4ec6", "#c79a00", "#d6409f", "#46a758"];

export const normalEmail = (email: string) => email.trim().toLowerCase();

export function userByEmail(email: string): User | null {
  return Users.as(system).find((u) => u.email === normalEmail(email)) ?? null;
}

export function userById(id: string): User | null {
  return Users.as(system).get(id) ?? null;
}

export function profileOf(id: string): Profile {
  return Profiles.as(system).get(id) ?? { id, name: "Someone", color: 0 };
}

export function nameOf(id: string): string {
  return profileOf(id).name;
}

export function colorOf(id: string): string {
  return COLORS[profileOf(id).color % COLORS.length]!;
}

export function namesFor(ids: Iterable<string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) if (id && !(id in out)) out[id] = nameOf(id);
  return out;
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createUser(email: string, password: string | null, name?: string): User {
  const address = normalEmail(email);
  const id = "u_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const shown = (name ?? "").trim().slice(0, 60) || address.split("@")[0]!.slice(0, 60);
  const user = Users.as(system).create({ id, email: address, name: shown, password, created: Date.now() })!;
  Profiles.as(system).create({ id, name: shown, color: hash(id) % COLORS.length });
  return user;
}

export function rename(id: string, name: string): void {
  const shown = name.trim().replace(/\s+/g, " ").slice(0, 60);
  if (shown === "") return;
  Users.as(system).update((u) => u.id === id, { name: shown });
  Profiles.as(system).update((p) => p.id === id, { name: shown });
}

export function setPassword(id: string, hash: string): void {
  Users.as(system).update((u) => u.id === id, { password: hash });
}

export function setEmail(id: string, email: string): void {
  Users.as(system).update((u) => u.id === id, { email: normalEmail(email) });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "")).toUpperCase();
}
