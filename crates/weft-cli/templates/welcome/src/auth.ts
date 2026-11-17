import { SqlSessionStore, type Identity } from "@weft/server";
import { access } from "./access.ts";
import { db } from "./lib/db.ts";
import { userByEmail, userById } from "./lib/users.ts";

export { email, twoFactor } from "./lib/accounts.ts";

export const sessions = new SqlSessionStore(db);

export function user(id: string, tenant?: string) {
  if (!userById(id)) return null;
  const me = access.user(id);
  const where = tenant ?? me.tenants()[0]?.id;
  return (where ? me.in(where) : null) ?? me;
}

export function signIn(identity: Identity): string | null {
  if (!identity.email || !identity.emailVerified) return null;
  return userByEmail(identity.email)?.id ?? null;
}

export const signInError = "/sign-in";
