import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineModel, holdFile, sweepHeldFiles, type FileRef } from "@weft-framework/data";
import { defineComponent } from "@weft-framework/runtime";
import { createApp, type App } from "../src/app.ts";
import { defineAction } from "../src/action.ts";
import { login } from "../src/auth.ts";
import {
  contentMatches,
  defineUploads,
  diskStorage,
  MB,
  MemoryFileStore,
  presignS3,
  s3Storage,
  sniffType,
  SqlFileStore,
  type FileStore,
  type UploadStorage,
} from "../src/uploads.ts";

const KEY = "upload-key-upload-key-upload-key-up!";
const ORIGIN = "http://app.test";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function bytes(head: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 255;
  b.set(head.subarray(0, size));
  return b;
}

test("content sniffing", () => {
  const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const cases: [Uint8Array, string | null][] = [
    [PNG, "image/png"],
    [Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [ascii("GIF89a"), "image/gif"],
    [ascii("RIFF\0\0\0\0WEBPVP8 "), "image/webp"],
    [ascii("RIFF\0\0\0\0WAVEfmt "), "audio/wav"],
    [ascii("\0\0\0\x1cftypavif"), "image/avif"],
    [ascii("\0\0\0\x18ftypheic"), "image/heic"],
    [ascii("\0\0\0\x18ftypisom"), "video/mp4"],
    [ascii("\0\0\0\x14ftypqt  "), "video/quicktime"],
    [ascii("%PDF-1.7"), "application/pdf"],
    [Uint8Array.from([0x50, 0x4b, 3, 4]), "application/zip"],
    [Uint8Array.from([0x1f, 0x8b, 8]), "application/gzip"],
    [Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), "video/webm"],
    [ascii("ID3"), "audio/mpeg"],
    [ascii("OggS"), "audio/ogg"],
    [ascii("fLaC"), "audio/flac"],
    [ascii("hello"), null],
    [ascii("<html>"), null],
  ];
  for (const [head, want] of cases) assert.equal(sniffType(head), want, String.fromCharCode(...head));
  assert.ok(contentMatches("image/png", PNG));
  assert.ok(!contentMatches("image/jpeg", PNG), "a PNG named .jpg");
  assert.ok(contentMatches("application/vnd.openxmlformats-officedocument.wordprocessingml.document", Uint8Array.from([0x50, 0x4b, 3, 4])));
  assert.ok(contentMatches("text/csv", ascii("a,b\n1,2\n")));
  assert.ok(contentMatches("text/plain", new TextEncoder().encode("Příliš žluťoučký kůň")));
  assert.ok(!contentMatches("text/plain", PNG), "binary as text");
  assert.ok(!contentMatches("text/plain", ascii("%PDF-1.7 looks like text")), "a PDF as text");
  assert.ok(!contentMatches("text/plain", Uint8Array.from([0x68, 0x00, 0x69, 0x20, 0x20, 0x20])), "NUL bytes");
  assert.ok(!contentMatches("text/plain", Uint8Array.from([0xc3, 0x28, 0x20, 0x20, 0x20, 0x20])), "invalid UTF-8");
  assert.ok(contentMatches("application/octet-stream", PNG));
});

test("S3 presigning matches the AWS documented example", async () => {
  const url = await presignS3({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    expiresSeconds: 86400,
    now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(new URL(url).searchParams.get("X-Amz-Signature"), "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
});

test("configuration mistakes are refused at startup", () => {
  const storage = diskStorage({ dir: join(tmpdir(), "weft-x") });
  const ok = { key: KEY, storage, kinds: { avatar: { maxBytes: MB, types: ["image/png"] } } };
  assert.ok(defineUploads(ok));
  assert.throws(() => defineUploads({ ...ok, key: "short" }), /key/);
  assert.throws(() => defineUploads({ ...ok, kinds: {} }), /kinds/);
  assert.throws(() => defineUploads({ ...ok, kinds: { "bad-name": { maxBytes: 1, types: ["image/png"] } } }), /kind name/);
  assert.throws(() => defineUploads({ ...ok, kinds: { a: { maxBytes: 0, types: ["image/png"] } } }), /maxBytes/);
  assert.throws(() => defineUploads({ ...ok, kinds: { a: { maxBytes: 1, types: ["png"] } } }), /MIME/);
  assert.throws(() => defineUploads({ ...ok, partBytes: MB }), /partBytes/);
  assert.throws(() => s3Storage({ endpoint: "http://s3.example.com", region: "us-east-1", bucket: "b-1", accessKeyId: "a", secretAccessKey: "s" }), /https/);
  assert.throws(() => s3Storage({ endpoint: "https://s3.example.com", region: "us-east-1", bucket: "B", accessKeyId: "a", secretAccessKey: "s" }), /bucket/);
});

function setup(storage: UploadStorage, o: { store?: FileStore; scan?: (f: { type: string }) => boolean | string; clock?: { now: number } } = {}) {
  const clock = o.clock ?? { now: Date.UTC(2026, 10, 14, 12) };
  const uploads = defineUploads({
    key: KEY,
    storage,
    store: o.store ?? new MemoryFileStore(),
    kinds: {
      avatar: { maxBytes: 12 * MB, types: ["image/png", "image/jpeg", "image/svg+xml"] },
      note: { maxBytes: 1000, types: ["text/plain"], anonymous: true },
    },
    partBytes: 5 * MB,
    maxPending: 3,
    ...(o.scan ? { scan: o.scan } : {}),
    now: () => clock.now,
  });
  const signIn = defineAction("signIn", [{ name: "id", type: "string" }], async (ctx, id: string) => void (await login(ctx, id)));
  const setAvatar = defineAction("setAvatar", [{ name: "file", type: "string" }], async (ctx, file: string) => {
    const f = await uploads.claim(ctx, file, "avatar");
    return { link: await uploads.url(f.id), download: await uploads.url(f.id, { download: true }) };
  });
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: { "/": { component: defineComponent("P", () => ({ handlers: { noop() {} }, render: () => `<button data-weft-on-click="noop">x</button>` })) as never } },
    actions: { signIn: signIn as never, setAvatar: setAvatar as never },
    auth: { user: (id) => ({ id }), twoFactor: { page: "/", needed: (u) => u === "mallory" } },
    uploads,
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
  return { app, uploads, clock };
}

function client(app: App) {
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrfOf = async (cookie: string) => {
    const html = await (await app.fetch(new Request(`${ORIGIN}/`, { headers: { cookie } })))!.text();
    return /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";
  };
  return {
    async anon() {
      return cookieOf((await app.fetch(new Request(`${ORIGIN}/`)))!);
    },
    async as(id: string) {
      const anon = await this.anon();
      const res = (await app.fetch(
        new Request(`${ORIGIN}/?/signIn`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, cookie: anon, "x-weft-csrf": await csrfOf(anon) },
          body: JSON.stringify({ id }),
        }),
      ))!;
      await res.text();
      return cookieOf(res) || anon;
    },
    async api(cookie: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST", extra: Record<string, string> = {}) {
      const res = (await app.fetch(
        new Request(`${ORIGIN}/_weft/uploads/${path}`, {
          method,
          headers: { origin: ORIGIN, cookie, "x-weft-csrf": await csrfOf(cookie), "content-type": "application/json", ...extra },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      ))!;
      return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: string; code?: string } };
    },
    async put(cookie: string, url: string, data: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) {
      const res = (await app.fetch(new Request(new URL(url, ORIGIN), { method: "PUT", headers: { origin: ORIGIN, cookie, ...headers }, body: data })))!;
      return { status: res.status, body: (await res.json()) as { error?: string } };
    },
    async action(cookie: string, name: string, body: object) {
      const res = (await app.fetch(
        new Request(`${ORIGIN}/?/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": await csrfOf(cookie) },
          body: JSON.stringify(body),
        }),
      ))!;
      return { status: res.status, text: await res.text() };
    },
    async get(path: string, headers: Record<string, string> = {}) {
      return (await app.fetch(new Request(new URL(path, ORIGIN), { headers })))!;
    },
  };
}

async function sendAll(c: ReturnType<typeof client>, cookie: string, id: string, data: Uint8Array<ArrayBuffer>, parts: number[], partBytes = 5 * MB) {
  for (const i of parts) {
    const t = await c.api(cookie, `${id}/part/${i}`, {});
    assert.equal(t.status, 200, JSON.stringify(t.body));
    const r = await c.put(cookie, t.body.url as string, data.slice((i - 1) * partBytes, i * partBytes));
    assert.equal(r.status, 200, r.body.error);
  }
}

test("uploads to disk: owners, limits, parts, resume, checks, claims and signed links", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-uploads-"));
  try {
    const { app, uploads, clock } = setup(diskStorage({ dir }));
    const c = client(app);
    const ada = await c.as("ada");
    const bob = await c.as("bob");
    const anon = await c.anon();
    const data = bytes(PNG, 11 * MB + 123);

    assert.equal((await c.api(anon, "start", { kind: "avatar", name: "a.png", size: 10, type: "image/png" })).status, 403, "signed out");
    const mallory = await c.as("mallory");
    assert.equal((await c.api(mallory, "start", { kind: "avatar", name: "a.png", size: 10, type: "image/png" })).status, 403, "waiting for a second factor");
    assert.equal((await c.api(ada, "start", { kind: "avatar", name: "a.png", size: 13 * MB, type: "image/png" })).status, 413);
    assert.equal((await c.api(ada, "start", { kind: "avatar", name: "a.gif", size: 10, type: "image/gif" })).status, 415);
    assert.equal((await c.api(ada, "start", { kind: "nope", name: "a.png", size: 10, type: "image/png" })).status, 400);
    assert.equal((await c.api(ada, "start", { kind: "avatar", name: "a.png", size: 0, type: "image/png" })).status, 400);
    assert.equal((await c.api(ada, "start", { kind: "avatar", name: "/", size: 10, type: "image/png" })).status, 400);
    const noCsrf = (await app.fetch(new Request(`${ORIGIN}/_weft/uploads/start`, { method: "POST", headers: { origin: ORIGIN, cookie: ada }, body: "{}" })))!;
    assert.equal(noCsrf.status, 403, "CSRF token required");
    const cross = (await app.fetch(new Request(`${ORIGIN}/_weft/uploads/start`, { method: "POST", headers: { origin: "https://evil.example", cookie: ada }, body: "{}" })))!;
    assert.equal(cross.status, 403, "same origin only");

    const s = await c.api(ada, "start", { kind: "avatar", name: "../../etc/Ada's photo.png", size: data.length, type: "image/png" });
    assert.equal(s.status, 200);
    const id = s.body.id as string;
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.deepEqual([s.body.parts, s.body.partBytes], [3, 5 * MB]);

    assert.equal((await c.api(bob, `${id}/part/1`, {})).status, 404, "Bob cannot add parts to Ada's upload");
    assert.equal((await c.api(bob, id)).status, 404, "or see it");
    assert.equal((await c.api(ada, `${id}/part/4`, {})).status, 400, "no fourth part");

    const t1 = await c.api(ada, `${id}/part/1`, {});
    assert.equal((await c.put(bob, t1.body.url as string, data.slice(0, 5 * MB))).status, 404, "the part link is Ada's");
    const forged = (t1.body.url as string).replace(/s=[0-9a-f]+/, `s=${"0".repeat(40)}`);
    assert.equal((await c.put(ada, forged, data.slice(0, 5 * MB))).status, 403);
    assert.equal((await c.put(ada, t1.body.url as string, data.slice(0, 5 * MB + 1))).status, 413, "a part over its size is cut off");
    assert.equal((await c.put(ada, t1.body.url as string, data.slice(0, 5 * MB - 1))).status, 400, "a short part");
    assert.equal((await c.put(ada, t1.body.url as string, data.slice(0, 5 * MB), { "content-length": "7" })).status, 400, "a wrong declared length");
    assert.equal((await c.put(ada, t1.body.url as string, data.slice(0, 5 * MB), { "content-length": String(5 * MB) })).status, 200);
    assert.equal((await c.api(ada, `${id}/complete`, {})).status, 400, "parts still missing");

    assert.deepEqual((await c.api(ada, id)).body.received, [1]);
    await sendAll(c, ada, id, data, [3, 2]);
    assert.deepEqual((await c.api(ada, id)).body.received, [1, 2, 3]);
    const old = await c.api(ada, `${id}/part/1`, {});
    clock.now += 16 * 60_000;
    assert.equal((await c.put(ada, old.body.url as string, data.slice(0, 5 * MB))).status, 403, "part links expire");
    const fresh = await c.api(ada, `${id}/part/1`, {});
    assert.equal((await c.put(ada, fresh.body.url as string, data.slice(0, 5 * MB))).status, 200, "a fresh link works");
    const crossPut = (await app.fetch(
      new Request(new URL(fresh.body.url as string, ORIGIN), { method: "PUT", headers: { origin: "https://evil.example", cookie: ada }, body: data.slice(0, 5 * MB) }),
    ))!;
    assert.equal(crossPut.status, 403, "parts are same-origin too");
    clock.now -= 16 * 60_000;
    const done = await c.api(ada, `${id}/complete`, {});
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body, { id, kind: "avatar", name: "Ada's photo.png", type: "image/png", size: data.length });
    assert.equal((await c.api(ada, `${id}/part/1`, {})).status, 400, "finished");

    assert.equal((await c.action(bob, "setAvatar", { file: id })).status, 404, "Bob cannot claim Ada's file");
    const txt = new TextEncoder().encode("hello") as Uint8Array<ArrayBuffer>;
    const note = await c.api(ada, "start", { kind: "note", name: "n.txt", size: txt.length, type: "text/plain" });
    await sendAll(c, ada, note.body.id as string, txt, [1]);
    assert.equal((await c.api(ada, `${note.body.id}/complete`, {})).status, 200);
    assert.equal((await c.action(ada, "setAvatar", { file: note.body.id })).status, 415, "a note is not an avatar");
    assert.ok(await uploads.remove(note.body.id as string));
    const claimed = await c.action(ada, "setAvatar", { file: id });
    assert.equal(claimed.status, 200, claimed.text);
    const { link, download } = JSON.parse(claimed.text).value ?? JSON.parse(claimed.text);
    assert.notEqual((await c.action(ada, "setAvatar", { file: id })).status, 200, "claimed once");

    const res = await c.get(link);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy")!, /sandbox/);
    assert.match(res.headers.get("content-disposition")!, /^inline; filename="Ada's photo.png"/);
    const got = new Uint8Array(await res.arrayBuffer());
    assert.equal(got.length, data.length);
    assert.ok(got.every((b, i) => b === data[i]), "the same bytes");
    assert.match((await c.get(download)).headers.get("content-disposition")!, /^attachment/);

    const part = await c.get(link, { range: "bytes=10-19" });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 10-19/${data.length}`);
    assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [...data.slice(10, 20)]);
    assert.equal((await c.get(link, { range: "bytes=-5" })).headers.get("content-range"), `bytes ${data.length - 5}-${data.length - 1}/${data.length}`);
    assert.equal((await c.get(link, { range: `bytes=${data.length}-` })).status, 416);
    assert.equal((await c.get(link, { range: "bytes=5-2" })).status, 416);

    assert.equal((await c.get(link.replace(/s=[0-9a-f]+/, `s=${"1".repeat(40)}`))).status, 404, "tampered");
    assert.equal((await c.get(link.replace("d=0", "d=1"))).status, 404, "the disposition is signed");
    assert.equal((await c.get(link.replace("d=0", "d=2"))).status, 404, "d is 0 or 1");
    assert.equal((await c.get(link.replace(/e=\d+/, (m: string) => `e=${Number(m.slice(2)) + 1000}`))).status, 404, "the expiry is signed");
    clock.now += 301_000;
    assert.equal((await c.get(link)).status, 404, "expired");
    clock.now -= 301_000;

    const fake = bytes(new TextEncoder().encode("GIF89a"), 100);
    const f = await c.api(ada, "start", { kind: "avatar", name: "x.png", size: 100, type: "image/png" });
    await sendAll(c, ada, f.body.id as string, fake, [1]);
    const bad = await c.api(ada, `${f.body.id}/complete`, {});
    assert.equal(bad.status, 415);
    assert.match(bad.body.error!, /not image\/png/);
    assert.equal(await uploads.info(f.body.id as string), null);

    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const v = await c.api(ada, "start", { kind: "avatar", name: "x.svg", size: svg.length, type: "image/svg+xml" });
    await sendAll(c, ada, v.body.id as string, svg as Uint8Array<ArrayBuffer>, [1]);
    assert.equal((await c.api(ada, `${v.body.id}/complete`, {})).status, 200);
    assert.match((await c.get((await uploads.url(v.body.id as string))!)).headers.get("content-disposition")!, /^attachment/);

    const n = await c.api(anon, "start", { kind: "note", name: "n.txt", size: 5, type: "text/plain" });
    assert.equal(n.status, 200);
    const other = await c.anon();
    assert.equal((await c.api(other, n.body.id as string)).status, 404, "another session");
    assert.equal((await c.api(ada, n.body.id as string)).status, 404, "or a signed-in user");

    for (let i = 0; i < 3; i++) await c.api(bob, "start", { kind: "avatar", name: "b.png", size: 10, type: "image/png" });
    assert.equal((await c.api(bob, "start", { kind: "avatar", name: "b.png", size: 10, type: "image/png" })).status, 429);
    const pending = await c.api(bob, "start", { kind: "note", name: "n.txt", size: 5, type: "text/plain" });
    assert.equal(pending.status, 429);

    const a = await c.api(ada, "start", { kind: "avatar", name: "z.png", size: 10, type: "image/png" });
    assert.deepEqual((await c.api(ada, `${a.body.id}/abort`, {})).body, { ok: true });
    assert.deepEqual((await c.api(bob, `${a.body.id}/abort`, {})).body, { ok: false });
    clock.now += 25 * 3600_000;
    const swept = await uploads.sweep();
    assert.equal(swept, 5, "Bob's three, the anonymous note and the unclaimed SVG");
    assert.notEqual(await uploads.info(id), null, "the claimed file stays");
    assert.deepEqual(readdirSync(join(dir, ".parts")), [], "no parts left behind");
    assert.ok(await uploads.remove(id));
    assert.equal(await uploads.info(id), null);
    app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeS3() {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, Map<number, Uint8Array>>();
  const calls: string[] = [];
  let n = 0;
  const fetchFn = async (input: string, init: RequestInit = {}) => {
    const u = new URL(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const key = decodeURIComponent(u.pathname.replace(/^\/bucket\//, ""));
    const presigned = u.searchParams.has("X-Amz-Signature");
    if (!presigned && !/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(headers.get("authorization") ?? "")) {
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    }
    if (!presigned && headers.get("x-amz-content-sha256") === null) return new Response("<Error><Code>InvalidRequest</Code></Error>", { status: 400 });
    calls.push(`${method} ${u.search.includes("uploads=") ? "create" : u.searchParams.has("partNumber") ? "part" : u.searchParams.has("uploadId") ? "upload" : "object"}`);
    if (method === "POST" && u.searchParams.has("uploads")) {
      const id = `up${++n}&x`;
      uploads.set(id, new Map());
      return new Response(`<InitiateMultipartUploadResult><UploadId>${id.replace("&", "&amp;")}</UploadId></InitiateMultipartUploadResult>`);
    }
    const uploadId = u.searchParams.get("uploadId");
    if (method === "PUT" && presigned) {
      assert.ok(u.searchParams.get("X-Amz-SignedHeaders")!.split(";").includes("content-length"), "the part length is signed");
      const body = new Uint8Array(init.body as ArrayBuffer);
      uploads.get(uploadId!)!.set(Number(u.searchParams.get("partNumber")), body);
      return new Response(null, { headers: { etag: `"etag${u.searchParams.get("partNumber")}"` } });
    }
    if (method === "GET" && uploadId) {
      const parts = [...uploads.get(uploadId)!.entries()].map(([i, b]) => `<Part><PartNumber>${i}</PartNumber><ETag>&quot;etag${i}&quot;</ETag><Size>${b.length}</Size></Part>`);
      return new Response(`<ListPartsResult><IsTruncated>false</IsTruncated>${parts.join("")}</ListPartsResult>`);
    }
    if (method === "POST" && uploadId) {
      const xml = String(init.body);
      const order = [...xml.matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>&quot;etag(\d+)&quot;<\/ETag>/g)].map((m) => Number(m[1]));
      const parts = uploads.get(uploadId)!;
      const all = order.map((i) => parts.get(i)!);
      const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
      let off = 0;
      for (const b of all) (out.set(b, off), (off += b.length));
      objects.set(key, out);
      uploads.delete(uploadId);
      return new Response("<CompleteMultipartUploadResult/>");
    }
    if (method === "DELETE" && uploadId) return (uploads.delete(uploadId), new Response(null, { status: 204 }));
    const obj = objects.get(key);
    if (method === "HEAD") return obj ? new Response(null, { headers: { "content-length": String(obj.length) } }) : new Response(null, { status: 404 });
    if (method === "DELETE") return (objects.delete(key), new Response(null, { status: 204 }));
    if (method === "GET") {
      if (!obj) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      const m = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
      return new Response(m ? obj.slice(Number(m[1]), Number(m[2]) + 1) : obj, { status: m ? 206 : 200 });
    }
    return new Response("<Error><Code>NotImplemented</Code></Error>", { status: 501 });
  };
  return { fetch: fetchFn, objects, uploads, calls };
}

test("uploads to S3: parts go straight to the bucket, links are presigned", async () => {
  const s3 = fakeS3();
  const storage = s3Storage({ endpoint: "https://acct.r2.example.com", region: "auto", bucket: "bucket", accessKeyId: "AK", secretAccessKey: "SK", pathStyle: true, fetch: s3.fetch });
  const { app, uploads } = setup(storage);
  const c = client(app);
  const ada = await c.as("ada");
  const data = bytes(PNG, 6 * MB);
  const s = await c.api(ada, "start", { kind: "avatar", name: "a.png", size: data.length, type: "image/png" });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const id = s.body.id as string;
  for (const i of [1, 2]) {
    const t = await c.api(ada, `${id}/part/${i}`, {});
    const url = new URL(t.body.url as string);
    assert.equal(url.origin, "https://acct.r2.example.com", "the browser sends parts to the bucket");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
    const res = await s3.fetch(url.href, { method: "PUT", body: data.slice((i - 1) * 5 * MB, i * 5 * MB).buffer as ArrayBuffer });
    assert.equal(res.status, 200);
  }
  assert.deepEqual((await c.api(ada, id)).body.received, [1, 2]);
  const done = await c.api(ada, `${id}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(s3.objects.get(id)!.length, data.length);
  const link = new URL((await uploads.url(id, { ttlSeconds: 60 }))!);
  assert.equal(link.origin, "https://acct.r2.example.com");
  assert.equal(link.searchParams.get("response-content-type"), "image/png");
  assert.match(link.searchParams.get("response-content-disposition")!, /^inline; filename="a.png"/);
  assert.equal(link.searchParams.get("X-Amz-Expires"), "60");
  assert.ok(await uploads.remove(id));
  assert.equal(s3.objects.size, 0);
  assert.ok(s3.calls.includes("POST create") && s3.calls.includes("POST upload"));
  app.close();
});

test("the scanner decides before a file is ready; SQLite keeps the records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-uploads-"));
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    let verdict: boolean | string | Error = "EICAR test signature";
    const { app, uploads } = setup(diskStorage({ dir }), {
      store: new SqlFileStore(db as never),
      scan: () => {
        if (verdict instanceof Error) throw verdict;
        return verdict;
      },
    });
    const c = client(app);
    const ada = await c.as("ada");
    const data = bytes(PNG, 2000);
    const start = async () => {
      const s = await c.api(ada, "start", { kind: "avatar", name: "a.png", size: data.length, type: "image/png" });
      await sendAll(c, ada, s.body.id as string, data, [1]);
      return s.body.id as string;
    };
    const infected = await start();
    const r = await c.api(ada, `${infected}/complete`, {});
    assert.equal(r.status, 422);
    assert.match(r.body.error!, /EICAR/);
    assert.equal(await uploads.info(infected), null);
    assert.deepEqual(readdirSync(dir).filter((n) => n !== ".parts"), [], "deleted");

    verdict = new Error("clamd unreachable");
    const later = await start();
    assert.equal((await c.api(ada, `${later}/complete`, {})).status, 429, "scanner down: try again later");
    verdict = true;
    assert.equal((await c.api(ada, `${later}/complete`, {})).status, 200, "completed once the scanner is back");
    const row = db.prepare("SELECT * FROM weft_files WHERE id = ?").all(later)[0] as Record<string, unknown>;
    assert.equal(row.status, "ready");
    assert.equal(row.owner, "user:ada");
    assert.deepEqual(await uploads.info(later), { id: later, kind: "avatar", name: "a.png", type: "image/png", size: 2000 });
    app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("File fields: a row takes the caller's claimed file, links follow the row's rules, replaced files are deleted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-file-fields-"));
  try {
    const uploads = defineUploads({
      key: KEY,
      storage: diskStorage({ dir }),
      kinds: { avatar: { maxBytes: MB, types: ["image/png"] } },
    });
    interface Profile {
      id: string;
      avatar: FileRef | null;
    }
    const Profile = defineModel<Profile>("Profile", {
      fields: { id: "string", avatar: "File | null" },
      read: (actor: { id: string } | null, row) => actor?.id === row.id,
      write: (actor: { id: string } | null, row) => actor?.id === row.id,
    });
    const me = (ctx: { user: unknown }) => ctx.user as { id: string };
    const signIn = defineAction("signIn", [{ name: "id", type: "string" }], async (ctx, id: string) => void (await login(ctx, id)));
    const setAvatar = defineAction("setAvatar", [{ name: "file", type: "string" }], async (ctx, file: string) => {
      const f = await uploads.claim(ctx, file, "avatar");
      const p = Profile.as(ctx.user);
      if (!p.get(me(ctx).id)) p.create({ id: me(ctx).id, avatar: f.id });
      else p.update((r) => r.id === me(ctx).id, { avatar: f.id });
      return true;
    });
    const useFile = defineAction("useFile", [{ name: "file", type: "string" }], async (ctx, file: string) => {
      const p = Profile.as(ctx.user);
      if (!p.get(me(ctx).id)) p.create({ id: me(ctx).id, avatar: file as FileRef });
      else p.update((r) => r.id === me(ctx).id, { avatar: file as FileRef });
      return true;
    });
    const avatarOf = defineAction("avatarOf", [{ name: "id", type: "string" }], async (ctx, id: string) => {
      return await uploads.link(Profile.as(ctx.user).get(id)?.avatar);
    });
    const removeMe = defineAction("removeMe", [], async (ctx) => Profile.as(ctx.user).delete((r) => r.id === me(ctx).id));
    const app = createApp({
      secret: "test-secret-test-secret-test-secret!",
      routes: { "/": { component: defineComponent("P", () => ({ handlers: { noop() {} }, render: () => `<button data-weft-on-click="noop">x</button>` })) as never } },
      actions: { signIn, setAvatar, useFile, avatarOf, removeMe } as never,
      auth: { user: (id) => ({ id }) },
      uploads,
      rateLimit: { capacity: 1000, refillPerSecond: 1000 },
      onError: () => {},
    });
    const c = client(app);
    const ada = await c.as("ada");
    const bob = await c.as("bob");
    const upload = async (cookie: string) => {
      const data = bytes(PNG, 100);
      const s = await c.api(cookie, "start", { kind: "avatar", name: "me.png", size: data.length, type: "image/png" });
      await sendAll(c, cookie, s.body.id as string, data, [1]);
      assert.equal((await c.api(cookie, `${s.body.id}/complete`, {})).status, 200);
      return s.body.id as string;
    };
    const value = (r: { text: string }) => {
      const v = JSON.parse(r.text);
      return v && typeof v === "object" && "value" in v ? v.value : v;
    };
    const settle = () => new Promise((r) => setTimeout(r, 30));
    const gone = async (id: string) => {
      for (let i = 0; i < 200 && (await uploads.info(id)) !== null; i++) await new Promise((r) => setTimeout(r, 10));
      return (await uploads.info(id)) === null;
    };

    const first = await upload(ada);
    assert.equal((await c.action(ada, "setAvatar", { file: first })).status, 200);
    const link = value(await c.action(ada, "avatarOf", { id: "ada" }));
    assert.equal(link.id, first);
    assert.equal(link.type, "image/png");
    assert.equal((await c.get(link.url)).status, 200);
    assert.equal(value(await c.action(bob, "avatarOf", { id: "ada" })), null);

    assert.notEqual((await c.action(bob, "useFile", { file: first })).status, 200);
    assert.equal(value(await c.action(bob, "avatarOf", { id: "bob" })), null);
    assert.equal((await c.action(bob, "setAvatar", { file: first })).status, 404);
    const loose = await upload(ada);
    assert.notEqual((await c.action(ada, "useFile", { file: loose })).status, 200);

    assert.equal((await c.action(ada, "setAvatar", { file: loose })).status, 200);
    assert.ok(await gone(first), "the old file is gone");
    assert.equal(readdirSync(dir).includes(first), false);
    assert.equal((await c.get(link.url)).status, 404, "and so is its link");
    assert.equal(value(await c.action(ada, "avatarOf", { id: "ada" })).id, loose);
    assert.equal((await c.action(ada, "removeMe", {})).status, 200);
    assert.ok(await gone(loose));

    const kept = await upload(bob);
    app.close();
    holdFile(kept, { id: "bob" }, 1);
    await settle();
    sweepHeldFiles();
    await settle();
    assert.ok(await uploads.info(kept), "not tracked after close");
    const stop = uploads.track();
    holdFile(kept, { id: "bob" }, 1);
    await settle();
    await uploads.sweep();
    assert.ok(await gone(kept), "released by the sweep");
    stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
