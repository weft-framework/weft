import { nameOf } from "./lib/users.ts";

export const label = (actor: unknown) => {
  const id = (actor as { id?: unknown } | null)?.id;
  return typeof id === "string" ? nameOf(id) : null;
};

export const maxLength = 4000;
