import { deflateSync, inflateSync } from "node:zlib";
import { ImageError, type Bitmap } from "./bitmap.ts";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function isPng(b: Uint8Array): boolean {
  return b.length > 8 && SIGNATURE.every((v, i) => b[i] === v);
}

const u32 = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

export function pngSize(b: Uint8Array): { width: number; height: number } {
  if (!isPng(b) || b.length < 24) throw new ImageError("not a PNG");
  return { width: u32(b, 16), height: u32(b, 20) };
}

export function decodePng(b: Uint8Array, maxPixels: number): Bitmap {
  if (!isPng(b)) throw new ImageError("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (at + 8 <= b.length) {
    const len = u32(b, at);
    const name = String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!);
    const data = b.subarray(at + 8, at + 8 + len);
    if (data.length !== len) throw new ImageError("PNG is cut short");
    at += 12 + len;
    if (name === "IHDR") {
      width = u32(data, 0);
      height = u32(data, 4);
      depth = data[8]!;
      type = data[9]!;
      interlace = data[12]!;
      if (data[10] !== 0 || data[11] !== 0 || interlace > 1) throw new ImageError("unsupported PNG compression or interlace");
      const ok: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!ok[type]?.includes(depth)) throw new ImageError("unsupported PNG colour type or depth");
      if (width < 1 || height < 1 || width * height > maxPixels) throw new ImageError("image too large");
    } else if (name === "PLTE") palette = data;
    else if (name === "tRNS") trns = data;
    else if (name === "IDAT") idat.push(data);
    else if (name === "IEND") break;
  }
  if (!width || !idat.length) throw new ImageError("PNG has no image data");
  if (type === 3 && !palette) throw new ImageError("PNG palette missing");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type as 0 | 2 | 3 | 4 | 6]!;
  const bpp = Math.max(1, (channels * depth) >> 3);
  const rowBytes = (w: number) => ((w * channels * depth + 7) >> 3) + 1;
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  let expected = 0;
  const dims = passes.map(([x0, y0, dx, dy]) => {
    const w = Math.ceil((width - x0!) / dx!);
    const h = Math.ceil((height - y0!) / dy!);
    if (w > 0 && h > 0) expected += rowBytes(w) * h;
    return [w, h];
  });
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1024 });
  } catch {
    throw new ImageError("PNG data is damaged");
  }
  if (raw.length < expected) throw new ImageError("PNG data is cut short");
  const out = new Uint8Array(width * height * 4);
  let pos = 0;
  passes.forEach(([x0, y0, dx, dy], p) => {
    const [w, h] = dims[p]!;
    if (w! <= 0 || h! <= 0) return;
    const rb = rowBytes(w!) - 1;
    let prev = new Uint8Array(rb);
    for (let y = 0; y < h!; y++) {
      const filter = raw[pos++]!;
      const line = new Uint8Array(raw.buffer, raw.byteOffset + pos, rb).slice();
      pos += rb;
      unfilter(filter, line, prev, bpp);
      prev = line;
      for (let x = 0; x < w!; x++) {
        const px = ((y0! + y * dy!) * width + x0! + x * dx!) * 4;
        pixel(line, x, out, px);
      }
    }
  });
  return { width, height, data: out };

  function sample(line: Uint8Array, i: number): number {
    if (depth === 8) return line[i]!;
    if (depth === 16) return line[i * 2]!;
    const perByte = 8 / depth;
    const byte = line[Math.floor(i / perByte)]!;
    const shift = 8 - depth - (i % perByte) * depth;
    const v = (byte >> shift) & ((1 << depth) - 1);
    return type === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  }
  function raw16(line: Uint8Array, i: number): number {
    return depth === 16 ? (line[i * 2]! << 8) | line[i * 2 + 1]! : -1;
  }
  function pixel(line: Uint8Array, x: number, o: Uint8Array, px: number): void {
    if (type === 3) {
      const i = sample(line, x);
      o[px] = palette![i * 3] ?? 0;
      o[px + 1] = palette![i * 3 + 1] ?? 0;
      o[px + 2] = palette![i * 3 + 2] ?? 0;
      o[px + 3] = trns && i < trns.length ? trns[i]! : 255;
      return;
    }
    const c = x * channels;
    if (type === 0 || type === 4) {
      const g = sample(line, c);
      o[px] = o[px + 1] = o[px + 2] = g;
      let a = type === 4 ? sample(line, c + 1) : 255;
      if (type === 0 && trns && trns.length >= 2) {
        const key = (trns[0]! << 8) | trns[1]!;
        const v = depth === 16 ? raw16(line, c) : depth === 8 ? line[c]! : rawLow(line, c);
        if (v === key) a = 0;
      }
      o[px + 3] = a;
      return;
    }
    o[px] = sample(line, c);
    o[px + 1] = sample(line, c + 1);
    o[px + 2] = sample(line, c + 2);
    let a = type === 6 ? sample(line, c + 3) : 255;
    if (type === 2 && trns && trns.length >= 6) {
      const k = [(trns[0]! << 8) | trns[1]!, (trns[2]! << 8) | trns[3]!, (trns[4]! << 8) | trns[5]!];
      const v = depth === 16 ? [raw16(line, c), raw16(line, c + 1), raw16(line, c + 2)] : [line[c]!, line[c + 1]!, line[c + 2]!];
      if (v[0] === k[0] && v[1] === k[1] && v[2] === k[2]) a = 0;
    }
    o[px + 3] = a;
  }
  function rawLow(line: Uint8Array, i: number): number {
    const perByte = 8 / depth;
    const byte = line[Math.floor(i / perByte)]!;
    return (byte >> (8 - depth - (i % perByte) * depth)) & ((1 << depth) - 1);
  }
}

function unfilter(filter: number, line: Uint8Array, prev: Uint8Array, bpp: number): void {
  const n = line.length;
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < n; i++) line[i] = (line[i]! + line[i - bpp]!) & 255;
      return;
    case 2:
      for (let i = 0; i < n; i++) line[i] = (line[i]! + prev[i]!) & 255;
      return;
    case 3:
      for (let i = 0; i < n; i++) line[i] = (line[i]! + (((i >= bpp ? line[i - bpp]! : 0) + prev[i]!) >> 1)) & 255;
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        line[i] = (line[i]! + paeth(a, b, c)) & 255;
      }
      return;
    default:
      throw new ImageError("PNG row filter is invalid");
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(name: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  const tag = new TextEncoder().encode(name);
  out.set(tag, 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32([tag, data]));
  return out;
}

export function encodePng(img: Bitmap): Uint8Array {
  const { width, height, data } = img;
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const ch = opaque ? 3 : 4;
  const rb = width * ch;
  const raw = new Uint8Array((rb + 1) * height);
  let prev = new Uint8Array(rb);
  const cur = new Uint8Array(rb);
  const trial = new Uint8Array(rb);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      cur[x * ch] = data[s]!;
      cur[x * ch + 1] = data[s + 1]!;
      cur[x * ch + 2] = data[s + 2]!;
      if (ch === 4) cur[x * ch + 3] = data[s + 3]!;
    }
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < rb; i++) {
        const a = i >= ch ? cur[i - ch]! : 0;
        const b = prev[i]!;
        const c = i >= ch ? prev[i - ch]! : 0;
        const p = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (cur[i]! - p) & 255;
        trial[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
        raw.set(trial, y * (rb + 1) + 1);
      }
    }
    raw[y * (rb + 1)] = best;
    prev = cur.slice();
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  const idat = deflateSync(raw, { level: 9 });
  const parts = [new Uint8Array(SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
