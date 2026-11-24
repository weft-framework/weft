import { test } from "node:test";
import assert from "node:assert/strict";
import { defineCaptcha } from "../src/captcha.ts";
import { checkCspSources, mergeCspSources, securityHeaders } from "../src/security.ts";

function stub(reply: unknown, status = 200) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetch = (async (url: string, init: { body: URLSearchParams }) => {
    calls.push({ url, body: init.body });
    return new Response(JSON.stringify(reply), { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

test("a captcha provider adds only its fixed origins to the page policy", () => {
  const csp = (sources: object) => securityHeaders({ nonce: "n", secure: true, sources: checkCspSources(sources, "t") })["content-security-policy"]!;
  const plain = csp({});
  assert.match(plain, /script-src 'nonce-n' 'self';/);
  const t = csp({ captcha: "turnstile", frame: ["https://www.youtube.com"] });
  assert.match(t, /script-src 'nonce-n' 'self' https:\/\/challenges\.cloudflare\.com;/);
  assert.match(t, /frame-src https:\/\/www\.youtube\.com https:\/\/challenges\.cloudflare\.com;/);
  assert.match(t, /connect-src 'self' https:\/\/challenges\.cloudflare\.com;/);
  assert.doesNotMatch(t, /style-src[^;]*cloudflare/);
  const h = csp({ captcha: "hcaptcha" });
  assert.match(h, /script-src 'nonce-n' 'self' https:\/\/hcaptcha\.com https:\/\/\*\.hcaptcha\.com;/);
  assert.match(h, /style-src 'self' 'nonce-n' https:\/\/hcaptcha\.com https:\/\/\*\.hcaptcha\.com;/);

  assert.throws(() => checkCspSources({ captcha: "recaptcha" }, "t"), /captcha is one of turnstile, hcaptcha/);
  assert.throws(() => checkCspSources({ script: ["https://challenges.cloudflare.com"] }, "t"), /not one of/);
  assert.deepEqual(mergeCspSources({ connect: ["https://a.example"] }, { captcha: "turnstile" }), { connect: ["https://a.example"], captcha: "turnstile" });
  assert.throws(() => mergeCspSources({ captcha: "turnstile" }, { captcha: "hcaptcha" }), /one captcha provider/);
});

test("turnstile tokens are verified on the server, with action and hostname checks", async () => {
  const s = stub({ success: true, action: "signin", hostname: "app.example" });
  const c = defineCaptcha({ provider: "turnstile", secret: "sekret", siteKey: "0x4AAAAAAA-site", action: "signin", hostname: "app.example", fetch: s.fetch });
  assert.deepEqual(c.csp, { captcha: "turnstile" });
  assert.equal(c.field, "cf-turnstile-response");
  assert.equal(c.script, "https://challenges.cloudflare.com/turnstile/v0/api.js");
  const form = new FormData();
  form.set("cf-turnstile-response", " tok ");
  assert.equal(c.token(form), "tok");
  assert.equal(c.token({ other: "x" }), null);
  assert.deepEqual(await c.verify("tok", "203.0.113.9"), { ok: true, codes: [] });
  assert.equal(s.calls[0]!.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.deepEqual(Object.fromEntries(s.calls[0]!.body), { secret: "sekret", response: "tok", remoteip: "203.0.113.9" });
  assert.deepEqual(await c.verify(""), { ok: false, codes: ["missing-input-response"] });
  assert.equal(s.calls.length, 1, "an empty token is not sent");

  const wrongAction = defineCaptcha({ provider: "turnstile", secret: "s", siteKey: "0x4AAAAAAA-site", action: "signup", fetch: s.fetch });
  assert.deepEqual(await wrongAction.verify("tok"), { ok: false, codes: ["action-mismatch"] });
  const no = stub({ success: false, "error-codes": ["timeout-or-duplicate"] });
  assert.deepEqual(await defineCaptcha({ provider: "turnstile", secret: "s", siteKey: "0x4AAAAAAA-site", fetch: no.fetch }).verify("tok"), { ok: false, codes: ["timeout-or-duplicate"] });
  const down = stub({}, 503);
  assert.deepEqual(await defineCaptcha({ provider: "turnstile", secret: "s", siteKey: "0x4AAAAAAA-site", fetch: down.fetch }).verify("tok"), { ok: false, codes: ["http-503"] });
  const broken = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  assert.deepEqual(await defineCaptcha({ provider: "turnstile", secret: "s", siteKey: "0x4AAAAAAA-site", fetch: broken }).verify("tok"), { ok: false, codes: ["unreachable"] });
});

test("hcaptcha sends the site key; configuration is checked", async () => {
  const s = stub({ success: true });
  const c = defineCaptcha({ provider: "hcaptcha", secret: "sekret", siteKey: "10000000-ffff-ffff-ffff-000000000001", fetch: s.fetch });
  assert.equal(c.field, "h-captcha-response");
  assert.equal((await c.verify("tok")).ok, true);
  assert.equal(s.calls[0]!.url, "https://api.hcaptcha.com/siteverify");
  assert.equal(s.calls[0]!.body.get("sitekey"), "10000000-ffff-ffff-ffff-000000000001");
  assert.throws(() => defineCaptcha({ provider: "recaptcha" as never, secret: "s", siteKey: "abcdefgh" }), /provider/);
  assert.throws(() => defineCaptcha({ provider: "turnstile", secret: "", siteKey: "abcdefgh" }), /secret/);
  assert.throws(() => defineCaptcha({ provider: "turnstile", secret: "s", siteKey: "<bad>" }), /siteKey/);
  assert.throws(() => defineCaptcha({ provider: "turnstile", secret: "s", siteKey: "abcdefgh", timeoutMs: 10 }), /timeoutMs/);
});
