import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeJpeg, encodeJpeg } from "../src/image/jpeg.ts";
import { decodePng, encodePng } from "../src/image/png.ts";
import { crop, orient, resize, type Bitmap } from "../src/image/bitmap.ts";
import { transform } from "../src/image/transform.ts";
import { defineImages } from "../src/images.ts";
import { createApp } from "../src/app.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "images");
const W = 41;
const H = 29;
const MAX = 40_000_000;

function psnr(a: Uint8Array, b: Uint8Array): number {
  assert.equal(a.length, b.length);
  let se = 0;
  for (let i = 0; i < a.length; i++) se += (a[i]! - b[i]!) ** 2;
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / a.length));
}

const ref = (name: string) => new Uint8Array(readFileSync(join(dir, `${name}.rgba`)));
const file = (name: string) => new Uint8Array(readFileSync(join(dir, name)));

test("JPEG decoding matches an independent decoder", () => {
  for (const name of ["baseline-444", "baseline-422", "baseline-420", "progressive-444", "progressive-420", "grey",
    "grey-progressive", "restart", "cmyk"]) {
    const min = 50;
    const img = decodeJpeg(file(`${name}.jpg`), MAX);
    assert.equal(img.width, W, name);
    assert.equal(img.height, H, name);
    const db = psnr(img.data, ref(name));
    assert.ok(db >= min, `${name}: ${db.toFixed(1)} dB, wanted at least ${min}`);
  }
});

test("the EXIF orientation is read and applied", () => {
  const img = decodeJpeg(file("orient6.jpg"), MAX);
  assert.equal(img.orientation, 6);
  const shown = orient(img, img.orientation);
  assert.equal(shown.width, H);
  assert.equal(shown.height, W);
  assert.ok(psnr(shown.data, ref("orient6")) >= 50);
});

test("PNG decoding is exact for every colour type", () => {
  for (const name of ["rgba", "rgb", "grey8", "grey1", "grey16", "palette", "palette-trns", "la"]) {
    const img = decodePng(file(`${name}.png`), MAX);
    assert.equal(img.width, W, name);
    assert.equal(psnr(img.data, ref(name)), Infinity, name);
  }
});

test("encoders round-trip: PNG exactly, JPEG closely, metadata never copied", () => {
  const src = decodePng(file("rgba.png"), MAX);
  assert.deepEqual(decodePng(encodePng(src), MAX).data, src.data);
  const opaque = decodePng(file("rgb.png"), MAX);
  const png = encodePng(opaque);
  assert.equal(png[25], 2, "RGB when every pixel is opaque");
  const jpg = encodeJpeg(opaque, 92);
  assert.ok(psnr(decodeJpeg(jpg, MAX).data, opaque.data) >= 33);
  assert.ok(psnr(decodeJpeg(encodeJpeg(opaque, 50), MAX).data, opaque.data) >= 18);
  for (let i = 2; i < jpg.length; ) {
    const m = jpg[i + 1]!;
    const len = (jpg[i + 2]! << 8) | jpg[i + 3]!;
    if (m === 0xc4) {
      let o = i + 4;
      while (o < i + 2 + len) {
        let n = 0;
        for (let k = 1; k <= 16; k++) n += jpg[o + k]!;
        o += 17 + n;
      }
      assert.equal(o, i + 2 + len, "DHT segment length");
    }
    if (m === 0xda) break;
    i += 2 + len;
  }
  const out = transform(file("orient6.jpg"), { width: 100, format: "jpeg", quality: 80 }, MAX);
  assert.equal(Buffer.from(out.bytes).includes(Buffer.from("Exif")), false);
  assert.equal(out.width, H, "oriented before anything else");
});

test("resize, crop and transform", () => {
  const solid: Bitmap = { width: 64, height: 32, data: new Uint8Array(64 * 32 * 4).fill(200) };
  const small = resize(solid, 16, 8);
  assert.equal(small.width, 16);
  assert.ok(small.data.every((v) => v === 200), "a flat colour stays flat");
  const edge: Bitmap = { width: 4, height: 1, data: new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0]) };
  const half = resize(edge, 2, 1);
  assert.equal(half.data[1], 0, "no green from transparent pixels");
  assert.deepEqual(Array.from(crop(solid, 60, 30, 10, 10)).length, 0);
  assert.equal(crop(solid, 60, 30, 10, 10).width, 4);

  const t = transform(file("baseline-444.jpg"), { width: 20, aspect: [1, 1], format: "auto", quality: 80 }, MAX);
  assert.equal(t.type, "image/jpeg");
  assert.deepEqual([t.width, t.height], [20, 20]);
  const p = transform(file("rgba.png"), { width: 1000, format: "auto", quality: 80 }, MAX);
  assert.equal(p.type, "image/png", "transparency keeps PNG");
  assert.equal(p.width, W, "never enlarged");
  assert.throws(() => transform(file("rgba.png"), { width: 10, format: "png", quality: 80 }, 100), /too large/);
  assert.throws(() => transform(new TextEncoder().encode("<svg/>"), { width: 10, format: "png", quality: 80 }, MAX), /not a JPEG or PNG/);
});

test("variants are read as the viewer, revalidated and never served from another viewer's read", async () => {
  const images = defineImages({ widths: [16, 32], aspects: ["1x1"], workers: 1 });
  const jpg = file("orient6.jpg");
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    images,
    middleware: ({ request }) =>
      new URL(request.url).pathname.startsWith("/private/") && !request.headers.get("cookie")?.includes("member=1")
        ? new Response("no", { status: 403 })
        : undefined,
    files: async (path) =>
      path === "/photo.jpg" || path === "/private/photo.jpg"
        ? new Response(jpg as BodyInit, { headers: { "content-type": "image/jpeg" } })
        : path === "/notes.txt"
          ? new Response("plain words", { headers: { "content-type": "text/plain" } })
          : null,
    routes: {},
  });
  const get = async (q: string, headers: Record<string, string> = {}) =>
    (await app.fetch(new Request(`http://app.test/_weft/img?${q}`, { headers })))!;
  try {
    const res = await get("src=/photo.jpg&w=16");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.equal(res.headers.get("cache-control"), "private, no-cache");
    assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const img = decodeJpeg(bytes, MAX);
    assert.deepEqual([img.width, img.height, img.orientation], [16, Math.round((16 * W) / H), 1]);
    assert.equal(Buffer.from(bytes).includes(Buffer.from("Exif")), false, "metadata stripped");

    const again = await get("src=/photo.jpg&w=16", { "if-none-match": res.headers.get("etag")! });
    assert.equal(again.status, 304);

    assert.equal((await get("src=/photo.jpg&w=20")).status, 400, "only the listed widths");
    assert.equal((await get("src=/photo.jpg&w=16&ar=4x3")).status, 400, "only the listed aspects");
    assert.equal((await get("src=//elsewhere.example/a.jpg&w=16")).status, 400);
    assert.equal((await get(`src=${encodeURIComponent("/_weft/./img?src=/photo.jpg&w=16")}&w=16`)).status, 400);
    assert.equal((await get(`src=${encodeURIComponent("/_weft/%2e/img")}&w=16`)).status, 400);
    assert.equal((await get("src=/notes.txt&w=16")).status, 415);
    assert.equal((await get("src=/missing.png&w=16")).status, 404);

    const member = await get("src=/private/photo.jpg&w=32&ar=1x1", { cookie: "member=1" });
    assert.equal(member.status, 200);
    assert.equal(decodeJpeg(new Uint8Array(await member.arrayBuffer()), MAX).width, 29, "never enlarged");
    assert.equal((await get("src=/private/photo.jpg&w=32&ar=1x1")).status, 403);
    assert.equal((await get("src=/private/photo.jpg&w=32&ar=1x1", { cookie: "member=1" })).status, 200);
  } finally {
    await images.close();
  }
});

test("revalidation reuses the variant; busy and uncacheable variants are handled", async () => {
  const jpg = file("baseline-444.jpg");
  const images = defineImages({ widths: [16], workers: 1, queue: 0, cacheBytes: 1 });
  const seen: (string | undefined)[] = [];
  const read = async (_src: string, inm?: string) => {
    seen.push(inm);
    return inm === '"v1"' ? new Response(null, { status: 304 }) : new Response(jpg as BodyInit, { headers: { etag: '"v1"' } });
  };
  const req = (src: string) => new Request(`http://app.test/_weft/img?src=${src}&w=16`);
  try {
    assert.equal((await images.handle(req("/a.jpg"), read)).status, 200);
    assert.equal((await images.handle(req("/a.jpg"), read)).status, 200);
    assert.deepEqual(seen, [undefined, undefined]);
    const both = await Promise.all([images.handle(req("/b.jpg"), read), images.handle(req("/c.jpg"), read)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 503]);
    assert.equal(both.find((r) => r.status === 503)!.headers.get("retry-after"), "2");
  } finally {
    await images.close();
  }
  const cached = defineImages({ widths: [16], workers: 1 });
  seen.length = 0;
  try {
    const first = await cached.handle(req("/a.jpg"), read);
    const second = await cached.handle(req("/a.jpg"), read);
    assert.deepEqual(seen, [undefined, '"v1"'], "the source is revalidated, not re-read");
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("etag"), first.headers.get("etag"));
    assert.equal(cached.srcset("/a.jpg"), "/_weft/img?src=%2Fa.jpg&w=16 16w");
    assert.throws(() => cached.url("/a.jpg", { width: 17 }), /not one of/);
    const t = await cached.transform(file("rgba.png"), { width: 10 });
    assert.deepEqual([t.type, t.width, t.height], ["image/png", 10, 7]);
  } finally {
    await cached.close();
  }
});
