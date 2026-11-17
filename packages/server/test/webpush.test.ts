import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";
import { defineAction } from "../src/action.ts";
import { login } from "../src/auth.ts";
import {
  defineWebPush,
  encryptPushPayload,
  generateVapidKeys,
  MemoryPushStore,
  PushError,
  SqlPushStore,
  type PushStore,
} from "../src/webpush.ts";

type Bytes = Uint8Array<ArrayBuffer>;
const utf8 = new TextEncoder();
const ZERO = String.fromCharCode(0);

function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Bytes {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const cat = (...p: Uint8Array[]): Bytes => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of p) (out.set(x, at), (at += x.length));
  return out;
};

async function ecdhPair(priv: string, pub: string): Promise<CryptoKeyPair> {
  const p = fromB64url(pub);
  const jwk = { kty: "EC", crv: "P-256", x: b64url(p.subarray(1, 33)), y: b64url(p.subarray(33)) };
  return {
    privateKey: await crypto.subtle.importKey("jwk", { ...jwk, d: priv }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, []),
  };
}

async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, n: number): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, n * 8));
}

async function decrypt(body: Bytes, ua: CryptoKeyPair, uaPublic: Bytes, auth: Bytes): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  assert.equal(rs, 4096);
  assert.equal(body[20], 65);
  const asPublic = body.slice(21, 86);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(shared, auth, cat(utf8.encode(`WebPush: info${ZERO}`), uaPublic, asPublic), 32);
  const cek = await hkdf(ikm, salt, utf8.encode(`Content-Encoding: aes128gcm${ZERO}`), 16);
  const nonce = await hkdf(ikm, salt, utf8.encode(`Content-Encoding: nonce${ZERO}`), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(86)));
  assert.equal(plain[plain.length - 1], 2, "last-record delimiter");
  return new TextDecoder().decode(plain.subarray(0, -1));
}

async function browser() {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    ua,
    uaPublic,
    auth,
    subscription: (endpoint: string) => ({ endpoint, expirationTime: null, keys: { p256dh: b64url(uaPublic), auth: b64url(auth) } }),
  };
}

test("RFC 8291 appendix A: the example message", async () => {
  const local = await ecdhPair(
    "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  );
  const body = await encryptPushPayload(
    utf8.encode("When I grow up, I want to be a watermelon"),
    {
      p256dh: fromB64url("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      auth: fromB64url("BTBZMqHH6r4Tts7J_aSIgg"),
    },
    { local, salt: fromB64url("DGv6ra1nlYgDCS1FRnbzlw") },
  );
  assert.equal(
    b64url(body),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
  await assert.rejects(encryptPushPayload(utf8.encode("x"), { p256dh: new Uint8Array(64), auth: new Uint8Array(16) }), /P-256/);
  await assert.rejects(encryptPushPayload(utf8.encode("x"), { p256dh: fromB64url("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"), auth: new Uint8Array(8) }), /16 bytes/);
});

test("configuration mistakes are refused at startup", async () => {
  const keys = await generateVapidKeys();
  const ok = { ...keys, subject: "mailto:ops@acme.example" };
  assert.ok(defineWebPush(ok));
  assert.throws(() => defineWebPush({ ...ok, publicKey: "nope" }), /publicKey/);
  assert.throws(() => defineWebPush({ ...ok, privateKey: "short" }), /privateKey/);
  assert.throws(() => defineWebPush({ ...ok, subject: "ops@acme.example" }), /subject/);
  assert.throws(() => defineWebPush({ ...ok, subject: "http://acme.example" }), /subject/);
  assert.throws(() => defineWebPush({ ...ok, allowHosts: ["10.0.0.1"] }), /allowHosts/);
  assert.throws(() => defineWebPush({ ...ok, allowHosts: ["localhost"] }), /allowHosts/);
  assert.throws(() => defineWebPush({ ...ok, maxPerUser: 0 }), /maxPerUser/);
  assert.throws(() => defineWebPush({ ...ok, ttlSeconds: -1 }), /ttlSeconds/);
});

test("only https push service hosts are contacted", async () => {
  const push = defineWebPush({ ...(await generateVapidKeys()), subject: "https://acme.example/contact", allowHosts: ["push.acme.example"] });
  for (const good of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
    "https://web.push.apple.com/QAbc",
    "https://push.acme.example/x",
    "https://eu.push.acme.example/x",
  ]) {
    assert.ok(push.allowedEndpoint(good), good);
  }
  for (const bad of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com/x#frag",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evilfcm.googleapis.com.example/x",
    "https://attacker-push.acme.example/x",
    "https://notfcm.googleapis.co/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://localhost/x",
    "https://169.254.169.254/latest/meta-data",
    "https://metadata.google.internal/x",
    "https://evil.example/x",
    "file:///etc/passwd",
    "https://fcm.googleapis.com/x\nHost: evil",
    "https://fcm.googleapis.com/" + "a".repeat(2100),
    42,
    null,
  ]) {
    assert.equal(push.allowedEndpoint(bad), false, String(bad));
  }
});

test("a pushed message decrypts in the browser, with a VAPID token for that push service", async () => {
  const keys = await generateVapidKeys();
  const calls: { url: string; init: RequestInit }[] = [];
  const store = new MemoryPushStore();
  const push = defineWebPush({
    ...keys,
    subject: "mailto:ops@acme.example",
    store,
    ttlSeconds: 600,
    now: () => 1_700_000_000_000,
    fetch: async (url, init) => (calls.push({ url, init }), new Response(null, { status: 201 })),
  });
  const b = await browser();
  store.add({ ...b.subscription("https://fcm.googleapis.com/fcm/send/one"), user: "ada", p256dh: b.subscription("").keys.p256dh, auth: b.subscription("").keys.auth, created: 1 });

  const r = await push.send("ada", { title: "Ada <3", body: "Bob replied", url: "/posts/7", tag: "comment", urgency: "high" });
  assert.deepEqual(r, { sent: 1, removed: 0, failed: 0 });
  const { url, init } = calls[0]!;
  assert.equal(url, "https://fcm.googleapis.com/fcm/send/one");
  assert.equal(init.redirect, "error", "a push service cannot redirect the server elsewhere");
  const h = init.headers as Record<string, string>;
  assert.equal(h["content-encoding"], "aes128gcm");
  assert.equal(h.ttl, "600");
  assert.equal(h.urgency, "high");
  assert.deepEqual(JSON.parse(await decrypt(init.body as Bytes, b.ua, b.uaPublic, b.auth)), {
    title: "Ada <3",
    body: "Bob replied",
    url: "/posts/7",
    tag: "comment",
  });

  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(\S+)$/.exec(h.authorization!)!;
  assert.ok(m, h.authorization);
  assert.equal(m[4], keys.publicKey);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromB64url(m[1]!))), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromB64url(m[2]!))), {
    aud: "https://fcm.googleapis.com",
    exp: 1_700_000_000 + 12 * 3600,
    sub: "mailto:ops@acme.example",
  });
  const pub = fromB64url(keys.publicKey);
  const verifier = await crypto.subtle.importKey("raw", pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(
    await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, fromB64url(m[3]!), utf8.encode(`${m[1]}.${m[2]}`)),
    "the token verifies with the public key",
  );

  assert.equal((await push.send("eve", { title: "x" })).sent, 0, "nobody subscribed");
  await assert.rejects(push.send("ada", { title: "two\nlines" }), PushError);
  await assert.rejects(push.send("ada", { title: "" }), /title/);
  await assert.rejects(push.send("ada", { title: "x", url: "https://evil.example/" }), /path on this site/);
  await assert.rejects(push.send("ada", { title: "x", url: "//evil.example/" }), /path on this site/);
  await assert.rejects(push.send("ada", { title: "x", url: "/a b" }), /path on this site/);
  await assert.rejects(push.send("ada", { title: "x", tag: "a b" }), /tag/);
  await assert.rejects(push.send("ada", { title: "x", urgency: "now" as never }), /urgency/);
  await assert.rejects(push.send("ada", { title: "x", body: "y".repeat(1001) }), /body/);
  await assert.rejects(push.send("ada", { title: "x", body: "é".repeat(1000) + "z" }), /body/);
  await assert.rejects(push.send("ada", { title: "€".repeat(200), body: "€".repeat(1000) }), /3 KiB/);
  assert.equal(calls.length, 1, "refused messages are not sent");
});

test("push service answers: gone subscriptions are removed, transient failures throw only when nothing was sent", async () => {
  const status = new Map<string, number | Error>();
  const hits: string[] = [];
  const store = new MemoryPushStore();
  const push = defineWebPush({
    ...(await generateVapidKeys()),
    subject: "mailto:ops@acme.example",
    store,
    fetch: async (url) => {
      hits.push(url);
      const s = status.get(url) ?? 201;
      if (s instanceof Error) throw s;
      return new Response("body", { status: s });
    },
  });
  const b = await browser();
  const add = (endpoint: string, created: number) => store.add({ endpoint, user: "ada", ...b.subscription("").keys, created });
  add("https://fcm.googleapis.com/a", 1);
  add("https://fcm.googleapis.com/b", 2);
  add("https://fcm.googleapis.com/c", 3);
  add("https://evil.example/stored-before", 4);
  status.set("https://fcm.googleapis.com/a", 410);
  status.set("https://fcm.googleapis.com/b", 404);
  status.set("https://fcm.googleapis.com/c", 503);
  await assert.rejects(push.send("ada", { title: "x" }), (e: unknown) => e instanceof PushError && !e.permanent);
  assert.ok(!hits.includes("https://evil.example/stored-before"), "a disallowed stored endpoint is never contacted");
  assert.deepEqual(store.forUser("ada").map((r) => r.endpoint), ["https://fcm.googleapis.com/c"]);

  add("https://fcm.googleapis.com/d", 5);
  assert.deepEqual(await push.send("ada", { title: "x" }), { sent: 1, removed: 0, failed: 1 }, "one got it: no retry");
  status.set("https://fcm.googleapis.com/d", 400);
  status.set("https://fcm.googleapis.com/c", 400);
  assert.deepEqual(await push.send("ada", { title: "x" }), { sent: 0, removed: 0, failed: 2 }, "permanent failures do not retry");
  status.set("https://fcm.googleapis.com/c", 400);
  status.set("https://fcm.googleapis.com/d", 429);
  await assert.rejects(push.send("ada", { title: "x" }), /HTTP 429/, "rate limited: retry");
  status.set("https://fcm.googleapis.com/c", new Error("ECONNRESET"));
  status.set("https://fcm.googleapis.com/d", 400);
  await assert.rejects(push.send("ada", { title: "x" }), /ECONNRESET/, "network error: retry");
  assert.equal(await push.forget("ada"), 2);
  assert.deepEqual(store.forUser("ada"), []);
});

function setup(store: PushStore, keys: { publicKey: string; privateKey: string }) {
  const push = defineWebPush({ ...keys, subject: "mailto:ops@acme.example", store, maxPerUser: 2, fetch: async () => new Response(null, { status: 201 }) });
  let clock = 0;
  const signIn = defineAction("signIn", [{ name: "id", type: "string" }], async (ctx, id: string) => void (await login(ctx, id)));
  const enable = defineAction("enable", [{ name: "s", type: "string" }], async (ctx, s: string) => {
    clock++;
    await push.subscribe(ctx, s);
    return clock;
  });
  const disable = defineAction("disable", [{ name: "e", type: "string" }], (ctx, e: string) => push.unsubscribe(ctx, e));
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: { "/": { component: defineComponent("P", () => ({ handlers: { noop() {} }, render: () => `<button data-weft-on-click="noop">x</button>` })) as never } },
    actions: { signIn: signIn as never, enable: enable as never, disable: disable as never },
    api: { "/push-worker.js": { GET: () => push.worker() } },
    auth: { user: (id) => ({ id }), twoFactor: { page: "/", needed: (u) => u === "mallory" } },
  });
  return { app, push };
}

test("subscriptions belong to the signed-in user", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const keys = await generateVapidKeys();
  for (const store of [new MemoryPushStore(), new SqlPushStore(new DatabaseSync(":memory:") as never)]) {
    const { app } = setup(store, keys);
    const ORIGIN = "http://app.test";
    const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const csrfOf = async (cookie: string) => {
      const html = await (await app.fetch(new Request(`${ORIGIN}/`, { headers: cookie ? { cookie } : {} })))!.text();
      return /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";
    };
    const call = async (name: string, body: object, cookie: string) => {
      const res = (await app.fetch(
        new Request(`${ORIGIN}/?/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": await csrfOf(cookie) },
          body: JSON.stringify(body),
        }),
      ))!;
      return { res, text: await res.text() };
    };
    const as = async (id: string) => {
      const anon = cookieOf((await app.fetch(new Request(`${ORIGIN}/`)))!);
      const { res } = await call("signIn", { id }, anon);
      return cookieOf(res) || anon;
    };
    const ada = await as("ada");
    const bob = await as("bob");
    const mallory = await as("mallory");
    const anon = cookieOf((await app.fetch(new Request(`${ORIGIN}/`)))!);
    const b = await browser();
    const sub = (e: string) => JSON.stringify(b.subscription(`https://fcm.googleapis.com/${e}`));

    assert.notEqual((await call("enable", { s: sub("x") }, anon)).res.status, 200, "signed out: refused");
    assert.deepEqual(await store.forUser(""), []);
    assert.notEqual((await call("enable", { s: JSON.stringify(b.subscription("https://127.0.0.1/x")) }, ada)).res.status, 200);
    assert.notEqual((await call("enable", { s: JSON.stringify({ endpoint: "https://fcm.googleapis.com/k", keys: { p256dh: "AAAA", auth: b64url(b.auth) } }) }, ada)).res.status, 200);
    const shortAuth = { ...b.subscription("https://fcm.googleapis.com/k"), keys: { ...b.subscription("").keys, auth: b64url(b.auth.subarray(0, 8)) } };
    assert.notEqual((await call("enable", { s: JSON.stringify(shortAuth) }, ada)).res.status, 200, "auth secret is 16 bytes");
    assert.notEqual((await call("enable", { s: sub("pending") }, mallory)).res.status, 200, "a login waiting for its second factor is not signed in");
    assert.deepEqual(await store.forUser("mallory"), []);
    assert.notEqual((await call("enable", { s: "not json" }, ada)).res.status, 200);

    for (const e of ["one", "two", "three"]) assert.equal((await call("enable", { s: sub(e) }, ada)).res.status, 200);
    assert.deepEqual((await store.forUser("ada")).map((r) => r.endpoint.slice(-3)), ["two", "ree"], "the oldest is replaced past maxPerUser");

    const { text } = await call("disable", { e: "https://fcm.googleapis.com/two" }, bob);
    assert.match(text, /false/, "Bob cannot remove Ada's");
    assert.equal((await store.forUser("ada")).length, 2);
    assert.equal((await call("enable", { s: sub("two") }, bob)).res.status, 200, "a shared browser moves to whoever signs in");
    assert.deepEqual((await store.forUser("ada")).map((r) => r.endpoint.slice(-3)), ["ree"]);
    assert.deepEqual((await store.forUser("bob")).map((r) => r.endpoint.slice(-3)), ["two"]);
    assert.match((await call("disable", { e: "https://fcm.googleapis.com/three" }, ada)).text, /true/);
    assert.deepEqual(await store.forUser("ada"), []);

    const worker = (await app.fetch(new Request(`${ORIGIN}/push-worker.js`)))!;
    assert.match(worker.headers.get("content-type")!, /text\/javascript/);
    const js = await worker.text();
    assert.match(js, /showNotification/);
    assert.match(js, /u\.origin === self\.location\.origin/, "clicks open same-site links only");
    new Function(js);
    app.close();
  }
});

test("as a notification channel", async () => {
  const sent: unknown[] = [];
  const store = new MemoryPushStore();
  const push = defineWebPush({ ...(await generateVapidKeys()), subject: "mailto:ops@acme.example", store, fetch: async (_u, init) => (sent.push(init.body), new Response(null, { status: 201 })) });
  const b = await browser();
  store.add({ endpoint: "https://fcm.googleapis.com/a", user: "ada", ...b.subscription("").keys, created: 1 });
  const ch = push.channel("This device");
  assert.equal(ch.label, "This device");
  await ch.send({ user: "ada", notification: { title: "Hi", body: "there", url: "https://evil.example/", type: "comment" } });
  assert.deepEqual(JSON.parse(await decrypt(sent[0] as Bytes, b.ua, b.uaPublic, b.auth)), { title: "Hi", body: "there", url: "/", tag: "comment" });
});
