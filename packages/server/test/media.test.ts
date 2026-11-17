import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { releaseFiles } from "../../data/src/files.ts";
import {
  cloudflareStreamProvider,
  defineMedia,
  MemoryMediaStore,
  muxProvider,
  probeMedia,
  SqlMediaStore,
  type MediaProvider,
} from "../src/media.ts";
import { openSqlite } from "@weft-framework/data/sqlite";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PEM_B64 = Buffer.from(PEM).toString("base64");
const HOOK = "whsec-media-test-0123456789";
const NOW = 1_800_000_000_000;

function fakeApi() {
  const calls: { method: string; url: string; body: any; auth: string | null }[] = [];
  let n = 0;
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get("authorization") });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    n++;
    return Response.json(url.includes("mux") ? { data: { id: `asset${n}` } } : { result: { uid: `vid${n}` } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const files: Record<string, { id: string; kind: string; name: string; type: string; size: number }> = {
  f1: { id: "f1", kind: "video", name: "talk.mp4", type: "video/mp4", size: 10 },
  f2: { id: "f2", kind: "doc", name: "a.pdf", type: "application/pdf", size: 10 },
};
const uploads = {
  info: async (id: string) => files[id] ?? null,
  url: async (id: string, o: { ttlSeconds?: number }) => (files[id] ? `/_weft/files/${id}?e=${o.ttlSeconds}&s=sig` : null),
} as never;

function mux(f: typeof fetch) {
  return muxProvider({ tokenId: "tid", tokenSecret: "tsecret", webhookSecret: HOOK, signingKeyId: "kid1", signingKey: PEM_B64, fetch: f, api: "https://mux.test" });
}

function signed(body: string, header: string, sig: (t: number) => string, t = NOW / 1000) {
  return new Request("https://app.test/hooks/media", { method: "POST", body, headers: { [header]: sig(t) } });
}
const muxSig = (body: string) => (t: number) => `t=${t},v1=${createHmac("sha256", HOOK).update(`${t}.${body}`).digest("hex")}`;
const cfSig = (body: string) => (t: number) => `time=${t},sig1=${createHmac("sha256", HOOK).update(`${t}.${body}`).digest("hex")}`;

function checkJwt(token: string, want: Record<string, unknown>) {
  const [h, b, s] = token.split(".");
  assert.ok(verify("sha256", Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s!, "base64url")), "signed with the key");
  assert.equal(JSON.parse(Buffer.from(h!, "base64url").toString()).kid, "kid1");
  const claims = JSON.parse(Buffer.from(b!, "base64url").toString());
  for (const [k, v] of Object.entries(want)) assert.equal(claims[k], v, k);
}

test("mux: process, a signed webhook makes it ready, playback links are signed and expire", async () => {
  const { f, calls } = fakeApi();
  const ready: string[] = [];
  const media = defineMedia({ uploads, provider: mux(f), store: new MemoryMediaStore(), origin: "https://app.test", now: () => NOW, onReady: (r) => void ready.push(r.status) });
  const r = await media.process("f1");
  assert.equal(r.status, "processing");
  assert.equal(calls[0]!.url, "https://mux.test/video/v1/assets");
  assert.equal(calls[0]!.auth, `Basic ${Buffer.from("tid:tsecret").toString("base64")}`);
  assert.deepEqual(calls[0]!.body.inputs, [{ url: "https://app.test/_weft/files/f1?e=3600&s=sig" }], "an hour-long signed link on the app's origin");
  assert.deepEqual(calls[0]!.body.playback_policies, ["signed"]);
  assert.equal(calls[0]!.body.passthrough, r.tag);
  assert.equal(await media.process("f1").then((x) => x.asset), "asset1", "sent once");
  await assert.rejects(media.process("f2"), /not video or audio/);
  await assert.rejects(media.process("nope"), /no such ready file/);

  assert.deepEqual(await media.playback("f1"), { status: "processing", hls: null, poster: null, duration: null, aspect: null, expires: null });
  const body = JSON.stringify({ type: "video.asset.ready", data: { id: "asset1", duration: 62.5, aspect_ratio: "16:9", playback_ids: [{ id: "pubX", policy: "public" }, { id: "pidS", policy: "signed" }] } });

  assert.equal((await media.webhook(signed(body, "mux-signature", () => "t=1,v1=" + "0".repeat(64)))).status, 400);
  assert.equal((await media.webhook(signed(body, "mux-signature", muxSig(body), NOW / 1000 - 301))).status, 400);
  assert.equal((await media.webhook(signed(body.replace("62.5", "1"), "mux-signature", muxSig(body)))).status, 400);
  assert.equal((await media.webhook(new Request("https://app.test/h", { method: "POST", body }))).status, 400);
  assert.equal((await media.playback("f1"))!.status, "processing");

  assert.equal((await media.webhook(signed(body, "mux-signature", muxSig(body)))).status, 200);
  assert.deepEqual(ready, ["ready"]);
  const p = (await media.playback("f1", { ttlSeconds: 600 }))!;
  assert.deepEqual([p.status, p.duration, p.aspect, p.expires], ["ready", 62.5, "16:9", NOW / 1000 + 600]);
  assert.match(p.hls!, /^https:\/\/stream\.mux\.com\/pidS\.m3u8\?token=/);
  assert.match(p.poster!, /^https:\/\/image\.mux\.com\/pidS\/thumbnail\.jpg\?token=/);
  checkJwt(new URL(p.hls!).searchParams.get("token")!, { sub: "pidS", aud: "v", exp: NOW / 1000 + 600 });
  checkJwt(new URL(p.poster!).searchParams.get("token")!, { sub: "pidS", aud: "t" });
  await assert.rejects(media.playback("f1", { ttlSeconds: 90_000 }), /1 day/);
  assert.equal(await media.playback(null), null);

  const other = JSON.stringify({ type: "video.asset.ready", data: { id: "elsewhere", playback_ids: [{ id: "z", policy: "signed" }] } });
  assert.equal((await media.webhook(signed(other, "mux-signature", muxSig(other)))).status, 200);
  const created = JSON.stringify({ type: "video.asset.created", data: { id: "asset1" } });
  assert.equal((await media.webhook(signed(created, "mux-signature", muxSig(created)))).status, 200);
  assert.equal((await media.playback("f1"))!.status, "ready");
});

test("a deleted file deletes its asset", async () => {
  const { f, calls } = fakeApi();
  const media = defineMedia({ uploads, provider: mux(f), store: new MemoryMediaStore(), origin: "https://app.test" });
  await media.process("f1");
  releaseFiles(["f1"]);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.at(-1), { method: "DELETE", url: "https://mux.test/video/v1/assets/asset1", body: null, auth: calls[0]!.auth });
  assert.equal(await media.playback("f1"), null);
});

test("cloudflare stream: signed copy, webhook format, signed URLs; SQL store", async () => {
  const { f, calls } = fakeApi();
  const provider = cloudflareStreamProvider({
    accountId: "acc1", apiToken: "cf-token", webhookSecret: [HOOK], customerCode: "abc123", signingKeyId: "kid1", signingKey: PEM, fetch: f, api: "https://cf.test",
  });
  const media = defineMedia({ uploads, provider, store: new SqlMediaStore(openSqlite(":memory:")), origin: "https://app.test", now: () => NOW });
  await media.process("f1");
  assert.equal(calls[0]!.url, "https://cf.test/accounts/acc1/stream/copy");
  assert.equal(calls[0]!.auth, "Bearer cf-token");
  assert.equal(calls[0]!.body.requireSignedURLs, true);
  const body = JSON.stringify({ uid: "vid1", readyToStream: true, status: { state: "ready" }, duration: 12, input: { width: 1920, height: 1080 } });
  assert.equal((await media.webhook(signed(body, "webhook-signature", muxSig(body)))).status, 400, "Mux's header format is not Cloudflare's");
  assert.equal((await media.webhook(signed(body, "webhook-signature", cfSig(body)))).status, 200);
  const p = (await media.playback("f1"))!;
  assert.equal(p.aspect, "1920:1080");
  const m = /^https:\/\/customer-abc123\.cloudflarestream\.com\/([^/]+)\/manifest\/video\.m3u8$/.exec(p.hls!);
  assert.ok(m);
  checkJwt(m[1]!, { sub: "vid1", exp: NOW / 1000 + 3600 });
  assert.match(p.poster!, /\/thumbnails\/thumbnail\.jpg$/);
  const bad = JSON.stringify({ uid: "vid1", status: { state: "error", errorReasonText: "bad input" } });
  await media.process("f1");
  assert.equal(calls.length, 1);
  assert.equal((await media.webhook(signed(bad, "webhook-signature", cfSig(bad)))).status, 200);
  assert.equal((await media.playback("f1"))!.status, "errored");
  assert.equal((await media.process("f1")).asset, "vid2", "an errored file is sent again");
  assert.equal(calls.at(-1)!.method, "DELETE", "and the failed asset deleted");
  media.track()();
});

test("configuration is checked", () => {
  const { f } = fakeApi();
  assert.throws(() => defineMedia({ uploads, provider: mux(f), store: new MemoryMediaStore(), origin: "http://app.test" }), /must be https/);
  assert.throws(() => muxProvider({ tokenId: "a", tokenSecret: "b", webhookSecret: "short", signingKeyId: "k", signingKey: PEM }), /webhook secret/);
  assert.throws(() => muxProvider({ tokenId: "a", tokenSecret: "b", webhookSecret: HOOK, signingKeyId: "k", signingKey: "not a key" }), /RSA private key/);
  assert.throws(
    () => cloudflareStreamProvider({ accountId: "../x", apiToken: "t", webhookSecret: HOOK, customerCode: "c", signingKeyId: "k", signingKey: PEM }),
    /accountId/,
  );
  const p: MediaProvider = mux(f);
  assert.equal(p.name, "mux");
});

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}
const u32 = (...n: number[]) => {
  const b = Buffer.alloc(4 * n.length);
  n.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4));
  return b;
};
function track(handler: string, w: number, h: number) {
  const tkhd = box("tkhd", u32(0, 0, 0, 1, 0, 0, 0, 0, 0, 0), u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000), u32(w * 65536, h * 65536));
  const hdlr = box("hdlr", u32(0, 0), Buffer.from(handler, "latin1"), u32(0, 0, 0), Buffer.from("\0"));
  return box("trak", tkhd, box("mdia", hdlr));
}

test("probeMedia: MP4 duration, size and tracks; WAV duration; anything else null", () => {
  const mvhd = box("mvhd", u32(0, 0, 0, 600, 600 * 75), Buffer.alloc(80));
  const moov = box("moov", mvhd, track("soun", 0, 0), track("vide", 1280, 720));
  const ftyp = box("ftyp", Buffer.from("isom"), u32(512), Buffer.from("isomiso2mp41"));
  const mdat = box("mdat", Buffer.alloc(64));
  const fast = Buffer.concat([ftyp, moov, mdat]);
  assert.deepEqual(probeMedia(fast), { container: "mp4", duration: 75, width: 1280, height: 720, video: true, audio: true });
  assert.deepEqual(probeMedia(Buffer.concat([ftyp, mdat, moov])), probeMedia(fast), "moov at the end");
  const bigMdat = Buffer.concat([u32(1_000_000), Buffer.from("mdat"), Buffer.alloc(100)]);
  assert.equal(probeMedia(Buffer.concat([ftyp, bigMdat])), null);
  assert.equal(probeMedia(Buffer.concat([ftyp, box("moov", Buffer.alloc(3))]))!.duration, null);
  assert.equal(probeMedia(Buffer.concat([ftyp, u32(4), Buffer.from("moov")])), null);

  const wav = Buffer.alloc(44 + 16_000);
  wav.write("RIFF", 0, "latin1");
  wav.writeUInt32LE(36 + 16_000, 4);
  wav.write("WAVEfmt ", 8, "latin1");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "latin1");
  wav.writeUInt32LE(16_000, 40);
  assert.deepEqual(probeMedia(wav), { container: "wav", duration: 1, width: null, height: null, video: false, audio: true });
  assert.equal(probeMedia(new TextEncoder().encode("not media at all")), null);
});
