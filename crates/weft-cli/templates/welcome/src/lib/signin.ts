import { verifyPassword } from "@weft/server/password";
import { userByEmail, normalEmail } from "./users.ts";

export function nextPath(next: string | null | undefined, fallback = "/app"): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next.slice(0, 500);
}

const tries = new Map<string, { n: number; until: number }>();
const WINDOW_MS = 15 * 60_000;

export async function checkPassword(email: string, password: string): Promise<{ ok: true; user: string } | { ok: false; error: string }> {
  const address = normalEmail(email);
  const now = Date.now();
  const t = tries.get(address);
  if (t && t.until > now && t.n >= 5) return { ok: false, error: "Too many wrong passwords. Try again in 15 minutes, or sign in with an email link." };
  const user = userByEmail(address);
  const good = await verifyPassword(password, user?.password ?? null);
  if (user && user.password && good) {
    tries.delete(address);
    return { ok: true, user: user.id };
  }
  tries.set(address, { n: (t && t.until > now ? t.n : 0) + 1, until: now + WINDOW_MS });
  if (tries.size > 10_000) for (const [k, v] of tries) if (v.until <= now) tries.delete(k);
  return { ok: false, error: "That email and password do not match an account." };
}
