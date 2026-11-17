import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RateLimiter,
  csrfToken,
  importSecret,
  parseCookies,
  sameOrigin,
  securityHeaders,
  sessionCookie,
  signSession,
  timingSafeEqual,
  verifyCsrf,
  verifySession,
} from "../src/security.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const SID = "abcdefghijklmnopqrstuvwx";

test("short secrets are refused", async () => {
  await assert.rejects(importSecret("too-short"), /at least 32/);
});

test("signed sessions verify; tampering fails closed", async () => {
  const key = await importSecret(SECRET);
  const cookie = await signSession(key, SID);
  assert.equal(await verifySession(key, cookie), SID);

  const other = await importSecret(SECRET.replace("0", "1"));
  assert.equal(await verifySession(other, cookie), null, "different key");
  const [sid, mac] = cookie.split(".");
  assert.equal(await verifySession(key, `${sid.replace("a", "b")}.${mac}`), null, "swapped sid");
  assert.equal(await verifySession(key, `${sid}.${mac.slice(1)}`), null, "truncated mac");
  assert.equal(await verifySession(key, sid), null, "no mac");
  assert.equal(await verifySession(key, undefined), null);
  assert.equal(await verifySession(key, `a.b`), null, "sid too short");
});

test("CSRF tokens are bound to the session and distinct from its cookie MAC", async () => {
  const key = await importSecret(SECRET);
  const token = await csrfToken(key, SID);
  assert.equal(await verifyCsrf(key, SID, token), true);
  assert.equal(await verifyCsrf(key, "zyxwvutsrqponmlkjihgfedc", token), false);
  assert.equal(await verifyCsrf(key, SID, null), false);
  const mac = (await signSession(key, SID)).split(".")[1];
  assert.notEqual(token, mac);
  assert.equal(await verifyCsrf(key, SID, mac), false);
});

test("timingSafeEqual", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "ab"), false);
});

test("cookie parsing is prototype-safe and first-wins", () => {
  const c = parseCookies("a=1; __proto__=x; a=2; b = 3 ;junk");
  assert.equal(c.a, "1");
  assert.equal(c.b, "3");
  assert.equal(c.__proto__, "x");
  assert.equal(Object.getPrototypeOf(c), null);
});

test("session cookie flags", () => {
  assert.equal(
    sessionCookie("s", "v", { secure: true, maxAgeSeconds: 60 }),
    "s=v; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=60",
  );
  assert.ok(!sessionCookie("s", "v", { secure: false }).includes("Secure"));
});

test("same-origin check uses Origin, then Sec-Fetch-Site", () => {
  const mk = (h: Record<string, string>) => new Request("https://app.test/x", { method: "POST", headers: h });
  assert.equal(sameOrigin(mk({ origin: "https://app.test" })), true);
  assert.equal(sameOrigin(mk({ origin: "https://evil.test" })), false);
  assert.equal(sameOrigin(mk({ origin: "null" })), false);
  assert.equal(sameOrigin(mk({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(sameOrigin(mk({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(sameOrigin(mk({})), false);
});

test("rate limiter: burst, refill, bounded memory", () => {
  const rl = new RateLimiter({ capacity: 2, refillPerSecond: 1, maxKeys: 2 });
  assert.equal(rl.take("a", 0), true);
  assert.equal(rl.take("a", 0), true);
  assert.equal(rl.take("a", 0), false);
  assert.equal(rl.take("a", 999), false);
  assert.equal(rl.take("a", 1000), true);
  rl.take("b", 1000);
  rl.take("c", 1000);
  assert.equal(rl.take("a", 1000), true, "fresh bucket after eviction");
});

test("security headers: nonce CSP, framing denied, HSTS only when secure", () => {
  const h = securityHeaders({ nonce: "N0", secure: false });
  assert.match(h["content-security-policy"], /script-src 'nonce-N0' 'self'/);
  assert.match(h["content-security-policy"], /frame-ancestors 'none'/);
  assert.match(h["content-security-policy"], /object-src 'none'/);
  assert.equal(h["x-frame-options"], "DENY");
  assert.equal(h["strict-transport-security"], undefined);
  assert.ok(securityHeaders({ nonce: "N", secure: true })["strict-transport-security"]);
});
