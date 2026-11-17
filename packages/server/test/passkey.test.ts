import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft/runtime";
import { openSqlite } from "@weft/data/sqlite";
import { defineAction } from "../src/action.ts";
import { createApp, type App } from "../src/app.ts";
import { login } from "../src/auth.ts";
import {
  decodeCbor,
  definePasskeys,
  derToRaw,
  PasskeyError,
  SqlPasskeyStore,
  type PasskeyChallenge,
  type PasskeyOptions,
} from "../src/passkey.ts";
import { base64url, fromBase64url } from "../src/security.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";
const RP = "https://app.example";
const enc = new TextEncoder();

type Item = number | string | Uint8Array | Item[] | Map<Item, Item> | boolean;

function cbor(v: Item): Uint8Array {
  const head = (major: number, n: number): number[] => {
    if (n < 24) return [(major << 5) | n];
    if (n < 256) return [(major << 5) | 24, n];
    if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
    return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const cat = (...parts: (number[] | Uint8Array)[]) => {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  if (typeof v === "boolean") return new Uint8Array([v ? 0xf5 : 0xf4]);
  if (typeof v === "number") return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") {
    const b = enc.encode(v);
    return cat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  if (Array.isArray(v)) return cat(head(4, v.length), ...v.map(cbor));
  return cat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

const sha256 = async (b: Uint8Array | string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", typeof b === "string" ? enc.encode(b) : new Uint8Array(b)));

async function authenticator(kind: "ES256" | "Ed25519" = "ES256", opts: { origin?: string; rpId?: string; uv?: boolean; counter?: boolean } = {}) {
  const pair = (kind === "ES256"
    ? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
    : await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const cose =
    kind === "ES256"
      ? new Map<Item, Item>([[1, 2], [3, -7], [-1, 1], [-2, fromBase64url(jwk.x!)!], [-3, fromBase64url(jwk.y!)!]])
      : new Map<Item, Item>([[1, 1], [3, -8], [-1, 6], [-2, fromBase64url(jwk.x!)!]]);
  const credId = crypto.getRandomValues(new Uint8Array(32));
  let counter = opts.counter === false ? 0 : 1;
  let handle = "";
  const origin = opts.origin ?? RP;
  const rpId = opts.rpId ?? "app.example";
  const authData = async (flags: number, attested: boolean) => {
    const parts = [await sha256(rpId), new Uint8Array([flags]), new Uint8Array([counter >>> 24, (counter >> 16) & 255, (counter >> 8) & 255, counter & 255])];
    if (attested) parts.push(new Uint8Array(16), new Uint8Array([0, credId.length]), credId, cbor(cose));
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const flags = 0x01 | (opts.uv === false ? 0 : 0x04);
  const clientData = (type: string, challenge: unknown, extra: Record<string, unknown> = {}) =>
    enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }));
  return {
    credId: base64url(credId),
    async create(options: PasskeyChallenge["publicKey"], tamper: (c: Record<string, unknown>) => void = () => {}) {
      handle = (options.user as { id: string }).id;
      const data = await authData(flags | 0x40, true);
      const att = cbor(new Map<Item, Item>([["fmt", "none"], ["attStmt", new Map()], ["authData", data]]));
      const c = {
        id: base64url(credId),
        rawId: base64url(credId),
        type: "public-key",
        response: { clientDataJSON: base64url(clientData("webauthn.create", options.challenge)), attestationObject: base64url(att), transports: ["internal"] },
      };
      tamper(c);
      return JSON.stringify(c);
    },
    async get(options: PasskeyChallenge["publicKey"], o: { step?: number; tamper?: (c: Record<string, unknown>) => void; type?: string } = {}) {
      if (opts.counter !== false) counter += o.step ?? 1;
      const data = await authData(flags, false);
      const cd = clientData(o.type ?? "webauthn.get", options.challenge);
      const signed = new Uint8Array([...data, ...(await sha256(cd))]);
      const raw = new Uint8Array(
        kind === "ES256"
          ? await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed)
          : await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, signed),
      );
      const c = {
        id: base64url(credId),
        rawId: base64url(credId),
        type: "public-key",
        response: {
          clientDataJSON: base64url(cd),
          authenticatorData: base64url(data),
          signature: base64url(kind === "ES256" ? rawToDer(raw) : raw),
          userHandle: handle,
        },
      };
      o.tamper?.(c);
      return JSON.stringify(c);
    },
    rewind(n: number) {
      counter -= n;
    },
  };
}

function setup(extra: Partial<PasskeyOptions> = {}) {
  const passkeys = definePasskeys({ url: RP, name: "Acme", ...extra });
  const rejected: string[] = [];
  const Who = defineComponent("Who", (props: { who: string }) => ({ render: () => `<p id="who">${escapeHtml(props.who)}</p>` }));
  const s = { name: "state", type: "string" } as const;
  const c = { name: "credential", type: "string" } as const;
  const wrap = async (f: () => Promise<unknown>) => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof PasskeyError) return `error:${err.code}`;
      throw err;
    }
  };
  const actions = {
    as: defineAction("as", [{ name: "id", type: "string" }], (ctx, id: string) => login(ctx, id)),
    add: defineAction("add", [], (ctx) => wrap(() => passkeys.registrationOptions(ctx, { userName: "ada@example.com" }))),
    addDone: defineAction("addDone", [s, c], (ctx, state: string, cred: string) => wrap(async () => (await passkeys.register(ctx, state, cred)).id)),
    start: defineAction("start", [], (ctx) => passkeys.signInOptions(ctx)),
    finish: defineAction("finish", [s, c], (ctx, state: string, cred: string) => passkeys.signIn(ctx, state, cred, (e) => rejected.push(e.message))),
  };
  const app = createApp({
    secret: SECRET,
    routes: { "/": { component: Who as never, load: (ctx) => ({ who: (ctx.user as { id: string } | null)?.id ?? "nobody" }) } },
    actions: actions as never,
  });
  return { app, passkeys, rejected };
}

function visitor(app: App) {
  let cookie = "";
  let csrf = "";
  const keep = (res: Response) => {
    const set = res.headers.getSetCookie().find((x) => x.startsWith("weft_sid="));
    if (set) cookie = set.split(";")[0];
    csrf = res.headers.get("x-weft-csrf") ?? csrf;
  };
  const self = {
    async who() {
      const res = (await app.fetch(new Request(ORIGIN + "/", { headers: cookie ? { cookie } : {} })))!;
      keep(res);
      const html = await res.text();
      csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? csrf;
      return /<p id="who">([^<]*)<\/p>/.exec(html)?.[1];
    },
    async call(name: string, body: object = {}): Promise<unknown> {
      if (!csrf) await self.who();
      const res = (await app.fetch(
        new Request(`${ORIGIN}/?/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": csrf },
          body: JSON.stringify(body),
        }),
      ))!;
      keep(res);
      const out = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
      if (!out.ok) throw new Error(`${name}: ${out.error}`);
      if (name === "as") await self.who();
      return out.value;
    },
  };
  return self;
}

async function enrol(app: App, key: Awaited<ReturnType<typeof authenticator>>, user = "ada") {
  const v = visitor(app);
  await v.call("as", { id: user });
  const opts = (await v.call("add")) as PasskeyChallenge;
  return { v, opts, id: await v.call("addDone", { state: opts.state, credential: await key.create(opts.publicKey) }) };
}

async function signIn(app: App, key: Awaited<ReturnType<typeof authenticator>>, o: Parameters<typeof key.get>[1] = {}) {
  const v = visitor(app);
  const opts = (await v.call("start")) as PasskeyChallenge;
  const ok = await v.call("finish", { state: opts.state, credential: await key.get(opts.publicKey, o) });
  return { v, ok, who: await v.who() };
}

test("a passkey is registered for the signed-in user and signs them in", async () => {
  for (const kind of ["ES256", "Ed25519"] as const) {
    const { app, passkeys } = setup();
    const key = await authenticator(kind);
    const { opts, id } = await enrol(app, key);
    const pk = opts.publicKey as Record<string, any>;
    assert.deepEqual(pk.rp, { id: "app.example", name: "Acme" });
    assert.equal(pk.attestation, "none");
    assert.equal(pk.authenticatorSelection.residentKey, "required");
    assert.equal(pk.authenticatorSelection.userVerification, "required");
    assert.notEqual(pk.user.id, "ada", "the authenticator gets a random handle, not the user id");
    assert.equal(fromBase64url(pk.user.id)!.length, 32);
    assert.equal(id, key.credId);
    const listed = await passkeys.list("ada");
    assert.equal(listed.length, 1);
    assert.equal("publicKey" in listed[0], false);
    assert.deepEqual(listed[0].transports, ["internal"]);

    const { ok, who } = await signIn(app, key);
    assert.equal(ok, true, kind);
    assert.equal(who, "ada");
    assert.equal((await passkeys.list("ada"))[0].signCount, 2);
    assert.ok((await passkeys.list("ada"))[0].lastUsed !== null);
  }
});

test("a sign-in response is checked: challenge, origin, type, signature, counter", async () => {
  const { app, rejected } = setup();
  const key = await authenticator();
  await enrol(app, key);
  const tamper = async (f: (c: Record<string, any>) => void, why: RegExp) => {
    const r = await signIn(app, key, { tamper: f });
    assert.equal(r.ok, false);
    assert.equal(r.who, "nobody");
    assert.match(rejected.at(-1)!, why);
  };
  await tamper((c) => {
    const ad = fromBase64url(c.response.authenticatorData)!;
    ad[36] ^= 1;
    c.response.authenticatorData = base64url(ad);
  }, /bad signature/);
  await tamper((c) => (c.response.signature = base64url(new Uint8Array(70))), /not DER|bad signature/);
  await tamper((c) => (c.response.userHandle = base64url(new Uint8Array(32))), /handle/);
  await tamper((c) => {
    c.id = base64url(new Uint8Array(32));
    c.rawId = c.id;
  }, /unknown credential/);
  await tamper((c) => (c.rawId = base64url(new Uint8Array(32))), /rawId differ/);
  const r = await signIn(app, key, { type: "webauthn.create" });
  assert.equal(r.ok, false);
  assert.match(rejected.at(-1)!, /not webauthn.get/);

  assert.equal((await signIn(app, key)).ok, true);
  key.rewind(2);
  assert.equal((await signIn(app, key)).ok, false);
  assert.match(rejected.at(-1)!, /counter/);

  await tamper((c) => {
    const cd = JSON.parse(new TextDecoder().decode(fromBase64url(c.response.clientDataJSON)!));
    cd.origin = "https://app-example.evil";
    c.response.clientDataJSON = base64url(enc.encode(JSON.stringify(cd)));
  }, /origin does not match/);
});

test("a challenge is used once, in the session it was given to", async () => {
  const { app, rejected } = setup();
  const key = await authenticator();
  await enrol(app, key);
  const a = visitor(app);
  const opts = (await a.call("start")) as PasskeyChallenge;
  const cred = await key.get(opts.publicKey);
  const b = visitor(app);
  assert.equal(await b.call("finish", { state: opts.state, credential: cred }), false);
  assert.match(rejected.at(-1)!, /challenge/);
  assert.equal(await a.call("finish", { state: opts.state, credential: cred }), true);
  const c = visitor(app);
  assert.equal(await c.call("finish", { state: opts.state, credential: cred }), false);
  const d = visitor(app);
  const once = (await d.call("start")) as PasskeyChallenge;
  const broken = await key.get(once.publicKey, { tamper: (x: Record<string, any>) => (x.response.signature = base64url(new Uint8Array(8))) });
  assert.equal(await d.call("finish", { state: once.state, credential: broken }), false);
  assert.equal(await d.call("finish", { state: once.state, credential: await key.get(once.publicKey) }), false);
  assert.match(rejected.at(-1)!, /expired or was used/);
  const s1 = (await c.call("start")) as PasskeyChallenge;
  const s2 = (await c.call("start")) as PasskeyChallenge;
  assert.equal(await c.call("finish", { state: s1.state, credential: await key.get(s2.publicKey) }), false);
  assert.match(rejected.at(-1)!, /challenge does not match/);
});

test("registration is checked and limited", async () => {
  const { app, passkeys } = setup({ maxPerUser: 2 });
  assert.equal(await visitor(app).call("add"), "error:signed-out");
  const key = await authenticator();
  const { v } = await enrol(app, key);
  const again = (await v.call("add")) as PasskeyChallenge;
  assert.deepEqual((again.publicKey as { excludeCredentials: { id: string }[] }).excludeCredentials.map((d) => d.id), [key.credId]);
  assert.equal(await v.call("addDone", { state: again.state, credential: await key.create(again.publicKey) }), "error:conflict");
  const opts = (await v.call("add")) as PasskeyChallenge;
  await v.call("as", { id: "eve" });
  const other = await authenticator();
  assert.equal(await v.call("addDone", { state: opts.state, credential: await other.create(opts.publicKey) }), "error:expired");
  for (const bad of [{ origin: "https://evil.example" }, { rpId: "evil.example" }, { uv: false }]) {
    const k = await authenticator("ES256", bad);
    const o = (await v.call("add")) as PasskeyChallenge;
    assert.equal(await v.call("addDone", { state: o.state, credential: await k.create(o.publicKey) }), "error:invalid", JSON.stringify(bad));
  }
  const o = (await v.call("add")) as PasskeyChallenge;
  const k = await authenticator();
  const forged = await k.create(o.publicKey, (c) => {
    c.id = base64url(new Uint8Array(32).fill(7));
    c.rawId = c.id;
  });
  assert.equal(await v.call("addDone", { state: o.state, credential: forged }), "error:invalid");
  const k2 = await authenticator();
  const o2 = (await v.call("add")) as PasskeyChallenge;
  assert.equal(await v.call("addDone", { state: o2.state, credential: await k2.create(o2.publicKey) }), k2.credId);
  const k3 = await authenticator();
  const o3 = (await v.call("add")) as PasskeyChallenge;
  assert.equal(
    (o3.publicKey as { user: { id: string } }).user.id,
    (o2.publicKey as { user: { id: string } }).user.id,
    "one handle per user",
  );
  assert.equal(await v.call("addDone", { state: o3.state, credential: await k3.create(o3.publicKey) }), k3.credId);
  assert.equal(await v.call("add"), "error:limit");
  await passkeys.remove("eve", k3.credId);
  await assert.rejects(passkeys.remove("ada", k2.credId), PasskeyError);
  await passkeys.rename("eve", k2.credId, "Laptop");
  assert.equal((await passkeys.list("eve"))[0].name, "Laptop");
  await passkeys.remove("eve", k2.credId);
  assert.deepEqual(await passkeys.list("eve"), []);
});

test("an authenticator without a counter is accepted; user verification can be optional", async () => {
  const { app } = setup({ userVerification: false });
  const key = await authenticator("ES256", { counter: false, uv: false });
  await enrol(app, key);
  assert.equal((await signIn(app, key)).ok, true);
  assert.equal((await signIn(app, key)).ok, true);
});

test("the SQL store keeps passkeys", async () => {
  const db = openSqlite(":memory:");
  const store = new SqlPasskeyStore(db);
  const { app } = setup({ store });
  const key = await authenticator("Ed25519");
  await enrol(app, key);
  const { app: other } = setup({ store });
  assert.equal((await signIn(other, key)).who, "ada");
  assert.equal((await store.get(key.credId))!.signCount, 2);
  assert.equal(await store.remove(key.credId), true);
  assert.equal(await store.remove(key.credId), false);
});

test("CBOR and DER parsing refuse malformed input", () => {
  assert.throws(() => decodeCbor(new Uint8Array([0x5f])), /indefinite/);
  assert.throws(() => decodeCbor(new Uint8Array([0x42, 1])), /truncated/);
  assert.throws(() => decodeCbor(new Uint8Array([0xa2, 1, 1, 1, 1])), /duplicate/);
  assert.throws(() => decodeCbor(new Uint8Array(40).fill(0x81)), /deeply/);
  assert.deepEqual(decodeCbor(new Uint8Array([0x82, 0x01, 0x20])).value, [1, -1]);
  assert.throws(() => derToRaw(new Uint8Array([0x31, 0]), 32), /DER/);
  assert.throws(() => derToRaw(new Uint8Array([0x30, 6, 2, 1, 1, 2, 1, 1, 0]), 32), /DER/);
  assert.equal(derToRaw(new Uint8Array([0x30, 6, 2, 1, 1, 2, 1, 2]), 32)[63], 2);
});

test("configuration mistakes throw", () => {
  assert.throws(() => definePasskeys({ url: "http://app.example", name: "A" }), /https/);
  assert.throws(() => definePasskeys({ url: "http://127.0.0.1:3000", name: "A" }), /https/, "browsers allow http only on localhost");
  assert.throws(() => definePasskeys({ url: RP, name: "A", rpId: "other.example" }), /parent domain/);
  assert.throws(() => definePasskeys({ url: RP, name: "" }), /name/);
  definePasskeys({ url: "https://app.example", name: "A", rpId: "example" });
  definePasskeys({ url: "http://localhost:3000", name: "A" });
});
