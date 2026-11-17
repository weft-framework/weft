import { ImageError, type Bitmap } from "./bitmap.ts";

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57,
  50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

export function isJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

interface Huffman {
  maxcode: Int32Array;
  valptr: Int32Array;
  mincode: Int32Array;
  values: Uint8Array;
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k;
    mincode[l] = code;
    code += counts[l - 1]!;
    k += counts[l - 1]!;
    maxcode[l] = counts[l - 1] ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { maxcode, valptr, mincode, values };
}

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  bpl: number;
  bpc: number;
  bplMcu: number;
  bpcMcu: number;
  coef: Int16Array;
  pred: number;
  dc?: Huffman;
  ac?: Huffman;
}

export function jpegSize(b: Uint8Array): { width: number; height: number } {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) throw new ImageError("JPEG is damaged");
    const m = b[at + 1]!;
    if (m === 0xff) {
      at++;
      continue;
    }
    const len = (b[at + 2]! << 8) | b[at + 3]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (b[at + 5]! << 8) | b[at + 6]!, width: (b[at + 7]! << 8) | b[at + 8]! };
    }
    at += 2 + len;
  }
  throw new ImageError("JPEG has no frame");
}

export function decodeJpeg(b: Uint8Array, maxPixels: number): Bitmap & { orientation: number } {
  if (!isJpeg(b)) throw new ImageError("not a JPEG");
  const qt: Int32Array[] = [];
  const dcTables: Huffman[] = [];
  const acTables: Huffman[] = [];
  let frame: { width: number; height: number; progressive: boolean; comps: Component[]; maxH: number; maxV: number; mpl: number; mpc: number } | null = null;
  let restart = 0;
  let adobe = -1;
  let orientation = 1;
  let jfif = false;
  let at = 2;
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!;

  for (;;) {
    if (at + 4 > b.length) break;
    if (b[at] !== 0xff) {
      at++;
      continue;
    }
    const m = b[at + 1]!;
    if (m === 0xff || m === 0x00 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      at += m === 0xff ? 1 : 2;
      continue;
    }
    if (m === 0xd9) break;
    const len = u16(at + 2);
    const seg = b.subarray(at + 4, at + 2 + len);
    if (seg.length !== len - 2) throw new ImageError("JPEG is cut short");
    at += 2 + len;
    if (m === 0xe0 && seg[0] === 0x4a && seg[1] === 0x46 && seg[2] === 0x49 && seg[3] === 0x46) jfif = true;
    else if (m === 0xe1) orientation = exifOrientation(seg) ?? orientation;
    else if (m === 0xee && seg[0] === 0x41 && seg[1] === 0x64 && seg[2] === 0x6f && seg[3] === 0x62 && seg[4] === 0x65) adobe = seg[11] ?? 0;
    else if (m === 0xdb) {
      for (let i = 0; i < seg.length; ) {
        const pq = seg[i]! >> 4;
        const tq = seg[i]! & 15;
        i++;
        const t = new Int32Array(64);
        for (let k = 0; k < 64; k++) {
          t[ZIGZAG[k]!] = pq ? (seg[i + k * 2]! << 8) | seg[i + k * 2 + 1]! : seg[i + k]!;
        }
        i += pq ? 128 : 64;
        qt[tq & 3] = t;
      }
    } else if (m === 0xc4) {
      for (let i = 0; i < seg.length; ) {
        const tc = seg[i]! >> 4;
        const th = seg[i]! & 3;
        const counts = seg.subarray(i + 1, i + 17);
        const total = counts.reduce((n, c) => n + c, 0);
        const values = seg.slice(i + 17, i + 17 + total);
        i += 17 + total;
        (tc === 0 ? dcTables : acTables)[th] = buildHuffman(counts, values);
      }
    } else if (m === 0xdd) restart = (seg[0]! << 8) | seg[1]!;
    else if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      if (seg[0] !== 8) throw new ImageError("only 8-bit JPEGs are supported");
      const height = (seg[1]! << 8) | seg[2]!;
      const width = (seg[3]! << 8) | seg[4]!;
      if (!width || !height) throw new ImageError("JPEG without a height (DNL) is not supported");
      if (width * height > maxPixels) throw new ImageError("image too large");
      const n = seg[5]!;
      if (n !== 1 && n !== 3 && n !== 4) throw new ImageError("unsupported JPEG component count");
      const comps: Component[] = [];
      for (let i = 0; i < n; i++) {
        const o = 6 + i * 3;
        const h = seg[o + 1]! >> 4;
        const v = seg[o + 1]! & 15;
        if (h < 1 || h > 4 || v < 1 || v > 4) throw new ImageError("JPEG sampling is invalid");
        comps.push({ id: seg[o]!, h, v, tq: seg[o + 2]! & 3, bpl: 0, bpc: 0, bplMcu: 0, bpcMcu: 0, coef: new Int16Array(0), pred: 0 });
      }
      const maxH = Math.max(...comps.map((c) => c.h));
      const maxV = Math.max(...comps.map((c) => c.v));
      const mpl = Math.ceil(width / (8 * maxH));
      const mpc = Math.ceil(height / (8 * maxV));
      for (const c of comps) {
        c.bpl = Math.ceil(Math.ceil((width * c.h) / maxH) / 8);
        c.bpc = Math.ceil(Math.ceil((height * c.v) / maxV) / 8);
        c.bplMcu = mpl * c.h;
        c.bpcMcu = mpc * c.v;
        c.coef = new Int16Array(c.bplMcu * c.bpcMcu * 64);
      }
      frame = { width, height, progressive: m === 0xc2, comps, maxH, maxV, mpl, mpc };
    } else if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      throw new ImageError("lossless, hierarchical and arithmetic-coded JPEGs are not supported");
    } else if (m === 0xda) {
      if (!frame) throw new ImageError("JPEG scan before its frame");
      const ns = seg[0]!;
      const comps: Component[] = [];
      for (let i = 0; i < ns; i++) {
        const c = frame.comps.find((x) => x.id === seg[1 + i * 2]);
        if (!c) throw new ImageError("JPEG scan names an unknown component");
        const t = seg[2 + i * 2]!;
        c.dc = dcTables[t >> 4];
        c.ac = acTables[t & 15];
        comps.push(c);
      }
      const o = 1 + ns * 2;
      at = decodeScan(b, at, frame, comps, restart, seg[o]!, seg[o + 1]!, seg[o + 2]! >> 4, seg[o + 2]! & 15);
    }
  }
  if (!frame) throw new ImageError("JPEG has no frame");

  const planes = frame.comps.map((c) => {
    const q = qt[c.tq];
    if (!q) throw new ImageError("JPEG quantisation table missing");
    const w = c.bplMcu * 8;
    const plane = new Uint8Array(w * c.bpcMcu * 8);
    const block = new Float32Array(64);
    for (let by = 0; by < c.bpcMcu; by++) {
      for (let bx = 0; bx < c.bplMcu; bx++) {
        const off = (by * c.bplMcu + bx) * 64;
        for (let i = 0; i < 64; i++) block[i] = c.coef[off + i]! * q[i]!;
        idct(block);
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const v = block[y * 8 + x]! + 128;
            plane[(by * 8 + y) * w + bx * 8 + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
          }
        }
      }
    }
    return { plane, w, c };
  });

  const { width, height, maxH, maxV } = frame;
  const out = new Uint8Array(width * height * 4);
  const n = planes.length;
  const ids = frame.comps.map((c) => c.id);
  const rgb = n === 3 && (adobe === 0 || (!jfif && ids[0] === 0x52 && ids[1] === 0x47 && ids[2] === 0x42));
  const axis = (full: number, f: number, max: number) => {
    const n = Math.ceil((full * f) / max);
    const i0 = new Int32Array(full);
    const i1 = new Int32Array(full);
    const w = new Float32Array(full);
    for (let x = 0; x < full; x++) {
      const s = Math.min(n - 1, Math.max(0, ((x + 0.5) * f) / max - 0.5));
      i0[x] = Math.floor(s);
      i1[x] = Math.min(n - 1, i0[x]! + 1);
      w[x] = s - i0[x]!;
    }
    return { i0, i1, w };
  };
  const sample = planes.map(({ plane, w: pw, c }) => {
    if (c.h === maxH && c.v === maxV) return (x: number, y: number) => plane[y * pw + x]!;
    const ax = axis(width, c.h, maxH);
    const ay = axis(height, c.v, maxV);
    return (x: number, y: number) => {
      const r0 = ay.i0[y]! * pw;
      const r1 = ay.i1[y]! * pw;
      const a = ax.i0[x]!;
      const b = ax.i1[x]!;
      const wx = ax.w[x]!;
      const top = plane[r0 + a]! + (plane[r0 + b]! - plane[r0 + a]!) * wx;
      const bottom = plane[r1 + a]! + (plane[r1 + b]! - plane[r1 + a]!) * wx;
      return top + (bottom - top) * ay.w[y]!;
    };
  });
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      if (n === 1) {
        out[d] = out[d + 1] = out[d + 2] = clamp(sample[0]!(x, y));
      } else {
        let c0 = sample[0]!(x, y);
        let c1 = sample[1]!(x, y);
        let c2 = sample[2]!(x, y);
        if (!(n === 3 && rgb) && !(n === 4 && adobe === 0)) {
          const yy = c0;
          const cb = c1 - 128;
          const cr = c2 - 128;
          c0 = clamp(yy + 1.402 * cr);
          c1 = clamp(yy - 0.344136 * cb - 0.714136 * cr);
          c2 = clamp(yy + 1.772 * cb);
        }
        if (n === 4) {
          const k = sample[3]!(x, y);
          c0 = clamp((c0 * k) / 255);
          c1 = clamp((c1 * k) / 255);
          c2 = clamp((c2 * k) / 255);
        }
        out[d] = clamp(c0);
        out[d + 1] = clamp(c1);
        out[d + 2] = clamp(c2);
      }
      out[d + 3] = 255;
    }
  }
  return { width, height, data: out, orientation };
}

function decodeScan(
  b: Uint8Array,
  start: number,
  frame: { comps: Component[]; mpl: number; mpc: number; progressive: boolean },
  comps: Component[],
  restart: number,
  ss: number,
  se: number,
  ah: number,
  al: number,
): number {
  let pos = start;
  let bits = 0;
  let nbits = 0;
  let marker = false;
  const bit = (): number => {
    if (nbits === 0) {
      if (marker || pos >= b.length) return 0;
      const byte = b[pos]!;
      if (byte === 0xff) {
        const next = b[pos + 1];
        if (next === 0x00) pos += 2;
        else {
          marker = true;
          return 0;
        }
      } else pos++;
      bits = byte;
      nbits = 8;
    }
    nbits--;
    return (bits >> nbits) & 1;
  };
  const receive = (n: number): number => {
    let v = 0;
    while (n-- > 0) v = (v << 1) | bit();
    return v;
  };
  const extend = (n: number): number => {
    if (n === 0) return 0;
    if (n > 16) throw new ImageError("JPEG data is damaged");
    const v = receive(n);
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  };
  const decode = (h: Huffman | undefined): number => {
    if (!h) throw new ImageError("JPEG Huffman table missing");
    let code = 0;
    for (let l = 1; l <= 16; l++) {
      code = (code << 1) | bit();
      if (code <= h.maxcode[l]!) return h.values[h.valptr[l]! + code - h.mincode[l]!]!;
    }
    throw new ImageError("JPEG data is damaged");
  };

  let eobrun = 0;
  let acState = 0;
  let acNext = 0;
  let acRun = 0;
  type Decoder = (c: Component, off: number) => void;
  const baseline: Decoder = (c, off) => {
    const t = decode(c.dc);
    c.pred += extend(t);
    c.coef[off] = c.pred;
    for (let k = 1; k < 64; ) {
      const rs = decode(c.ac);
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r < 15) break;
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) break;
      c.coef[off + ZIGZAG[k]!] = extend(s);
      k++;
    }
  };
  const dcFirst: Decoder = (c, off) => {
    const t = decode(c.dc);
    c.pred += extend(t) * (1 << al);
    c.coef[off] = c.pred;
  };
  const dcRefine: Decoder = (c, off) => {
    if (bit()) c.coef[off]! |= 1 << al;
  };
  const acFirst: Decoder = (c, off) => {
    if (eobrun > 0) {
      eobrun--;
      return;
    }
    for (let k = ss; k <= se; ) {
      const rs = decode(c.ac);
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r < 15) {
          eobrun = receive(r) + (1 << r) - 1;
          break;
        }
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) break;
      c.coef[off + ZIGZAG[k]!] = extend(s) * (1 << al);
      k++;
    }
  };
  const acRefine: Decoder = (c, off) => {
    for (let k = ss; k <= se; k++) {
      const z = off + ZIGZAG[k]!;
      const sign = c.coef[z]! < 0 ? -1 : 1;
      switch (acState) {
        case 0: {
          const rs = decode(c.ac);
          const s = rs & 15;
          acRun = rs >> 4;
          if (s === 0) {
            if (acRun < 15) {
              eobrun = receive(acRun) + (1 << acRun);
              acState = 4;
            } else {
              acRun = 16;
              acState = 1;
            }
          } else {
            if (s !== 1) throw new ImageError("JPEG data is damaged");
            acNext = extend(s);
            acState = acRun ? 2 : 3;
          }
          k--;
          continue;
        }
        case 1:
        case 2:
          if (c.coef[z]) c.coef[z]! += sign * (bit() << al);
          else if (--acRun === 0) acState = acState === 2 ? 3 : 0;
          break;
        case 3:
          if (c.coef[z]) c.coef[z]! += sign * (bit() << al);
          else {
            c.coef[z] = acNext * (1 << al);
            acState = 0;
          }
          break;
        case 4:
          if (c.coef[z]) c.coef[z]! += sign * (bit() << al);
          break;
      }
    }
    if (acState === 4 && --eobrun === 0) acState = 0;
  };
  const fn: Decoder = !frame.progressive ? baseline : ss === 0 ? (ah === 0 ? dcFirst : dcRefine) : ah === 0 ? acFirst : acRefine;
  if (frame.progressive && ss !== 0 && comps.length !== 1) throw new ImageError("JPEG AC scan with several components");

  const single = comps.length === 1;
  const total = single ? comps[0]!.bpl * comps[0]!.bpc : frame.mpl * frame.mpc;
  const interval = restart || total;
  for (let n = 0; n < total; ) {
    for (const c of comps) c.pred = 0;
    eobrun = 0;
    acState = 0;
    const end = Math.min(total, n + interval);
    for (; n < end; n++) {
      if (single) {
        const c = comps[0]!;
        const row = Math.floor(n / c.bpl);
        const col = n % c.bpl;
        fn(c, (row * c.bplMcu + col) * 64);
      } else {
        const mrow = Math.floor(n / frame.mpl);
        const mcol = n % frame.mpl;
        for (const c of comps) {
          for (let v = 0; v < c.v; v++) {
            for (let h = 0; h < c.h; h++) {
              fn(c, ((mrow * c.v + v) * c.bplMcu + mcol * c.h + h) * 64);
            }
          }
        }
      }
    }
    nbits = 0;
    marker = false;
    while (pos + 1 < b.length && !(b[pos] === 0xff && b[pos + 1] !== 0x00 && b[pos + 1] !== 0xff)) pos++;
    if (n < total && b[pos + 1]! >= 0xd0 && b[pos + 1]! <= 0xd7) pos += 2;
    else if (n < total) break;
  }
  return pos;
}

const COS = (() => {
  const t = new Float32Array(64);
  for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) t[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return t;
})();

function idct(blk: Float32Array): void {
  const tmp = new Float32Array(64);
  for (let v = 0; v < 8; v++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += COS[x * 8 + u]! * blk[v * 8 + u]!;
      tmp[v * 8 + x] = s / 2;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += COS[y * 8 + v]! * tmp[v * 8 + x]!;
      blk[y * 8 + x] = s / 2;
    }
  }
}

function fdct(blk: Float32Array): void {
  const tmp = new Float32Array(64);
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += COS[x * 8 + u]! * blk[y * 8 + x]!;
      tmp[y * 8 + u] = s / 2;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += COS[y * 8 + v]! * tmp[y * 8 + u]!;
      blk[v * 8 + u] = s / 2;
    }
  }
}

function exifOrientation(seg: Uint8Array): number | null {
  if (seg.length < 14 || String.fromCharCode(...seg.subarray(0, 4)) !== "Exif") return null;
  const t = seg.subarray(6);
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return null;
  const r16 = (i: number) => (le ? t[i]! | (t[i + 1]! << 8) : (t[i]! << 8) | t[i + 1]!);
  const r32 = (i: number) => (le ? (r16(i) | (r16(i + 2) << 16)) >>> 0 : ((r16(i) << 16) | r16(i + 2)) >>> 0);
  const ifd = r32(4);
  if (ifd + 2 > t.length) return null;
  const count = r16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return null;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56,
  68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  ...new Array<number>(32).fill(99),
];
const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALS = hex(
  "01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa",
);
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALS = hex(
  "000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa",
);

function hex(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

function codes(bits: number[], vals: number[]): { code: Uint16Array; size: Uint8Array } {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < bits[l - 1]!; i++) {
      code[vals[k]!] = c++;
      size[vals[k]!] = l;
      k++;
    }
    c <<= 1;
  }
  return { code, size };
}

const DC_LUMA = codes(DC_LUMA_BITS, DC_VALS);
const DC_CHROMA = codes(DC_CHROMA_BITS, DC_VALS);
const AC_LUMA = codes(AC_LUMA_BITS, AC_LUMA_VALS);
const AC_CHROMA = codes(AC_CHROMA_BITS, AC_CHROMA_VALS);

function scaled(table: number[], quality: number): Int32Array {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const s = q < 50 ? 5000 / q : 200 - q * 2;
  return Int32Array.from(table, (v) => Math.max(1, Math.min(255, Math.floor((v * s + 50) / 100))));
}

export function encodeJpeg(img: Bitmap, quality = 82): Uint8Array {
  const { width, height, data } = img;
  if (width > 65535 || height > 65535) throw new ImageError("image too large for JPEG");
  const lq = scaled(STD_LUMA, quality);
  const cq = scaled(STD_CHROMA, quality);
  const sub = quality < 90 ? 2 : 1;
  const out: number[] = [];
  const w16 = (v: number) => out.push((v >> 8) & 255, v & 255);
  const marker = (m: number, body: number[]) => {
    out.push(0xff, m);
    w16(body.length + 2);
    for (const v of body) out.push(v);
  };
  out.push(0xff, 0xd8);
  marker(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  marker(0xdb, [0, ...Array.from(ZIGZAG, (z) => lq[z]!), 1, ...Array.from(ZIGZAG, (z) => cq[z]!)]);
  marker(0xc0, [8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, (sub << 4) | sub, 0, 2, 0x11, 1, 3, 0x11, 1]);
  marker(0xc4, [
    0x00, ...DC_LUMA_BITS, ...DC_VALS,
    0x10, ...AC_LUMA_BITS, ...AC_LUMA_VALS,
    0x01, ...DC_CHROMA_BITS, ...DC_VALS,
    0x11, ...AC_CHROMA_BITS, ...AC_CHROMA_VALS,
  ]);
  marker(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);

  let acc = 0;
  let nacc = 0;
  const put = (code: number, size: number) => {
    acc = (acc << size) | (code & ((1 << size) - 1));
    nacc += size;
    while (nacc >= 8) {
      const byte = (acc >> (nacc - 8)) & 255;
      out.push(byte);
      if (byte === 0xff) out.push(0);
      nacc -= 8;
      acc &= (1 << nacc) - 1;
    }
  };
  const category = (v: number) => {
    let a = Math.abs(v);
    let n = 0;
    while (a) {
      n++;
      a >>= 1;
    }
    return n;
  };
  const bitsOf = (v: number, n: number) => (v < 0 ? v + (1 << n) - 1 : v);
  const preds = [0, 0, 0];
  const blk = new Float32Array(64);
  const block = (plane: 0 | 1 | 2, sample: (x: number, y: number) => number, q: Int32Array) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) blk[y * 8 + x] = sample(x, y) - 128;
    fdct(blk);
    const dc = DC_LUMA_OR(plane);
    const ac = plane === 0 ? AC_LUMA : AC_CHROMA;
    const zz = new Int32Array(64);
    for (let k = 0; k < 64; k++) zz[k] = Math.round(blk[ZIGZAG[k]!]! / q[ZIGZAG[k]!]!);
    const diff = zz[0]! - preds[plane]!;
    preds[plane] = zz[0]!;
    const c = category(diff);
    put(dc.code[c]!, dc.size[c]!);
    if (c) put(bitsOf(diff, c), c);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = zz[k]!;
      if (v === 0) {
        run++;
        continue;
      }
      while (run > 15) {
        put(ac.code[0xf0]!, ac.size[0xf0]!);
        run -= 16;
      }
      const s = category(v);
      const sym = (run << 4) | s;
      put(ac.code[sym]!, ac.size[sym]!);
      put(bitsOf(v, s), s);
      run = 0;
    }
    if (run) put(ac.code[0]!, ac.size[0]!);
  };
  const DC_LUMA_OR = (plane: number) => (plane === 0 ? DC_LUMA : DC_CHROMA);
  const px = (x: number, y: number) => ((Math.min(height - 1, y) * width + Math.min(width - 1, x)) * 4);
  const Y = (x: number, y: number) => {
    const i = px(x, y);
    return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
  };
  const C = (x: number, y: number, which: 1 | 2) => {
    let s = 0;
    for (let dy = 0; dy < sub; dy++) {
      for (let dx = 0; dx < sub; dx++) {
        const i = px(x * sub + dx, y * sub + dy);
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        s += which === 1 ? -0.168736 * r - 0.331264 * g + 0.5 * b + 128 : 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
      }
    }
    return s / (sub * sub);
  };
  const mcu = 8 * sub;
  for (let my = 0; my < height; my += mcu) {
    for (let mx = 0; mx < width; mx += mcu) {
      for (let by = 0; by < sub; by++) {
        for (let bx = 0; bx < sub; bx++) block(0, (x, y) => Y(mx + bx * 8 + x, my + by * 8 + y), lq);
      }
      block(1, (x, y) => C(mx / sub + x, my / sub + y, 1), cq);
      block(2, (x, y) => C(mx / sub + x, my / sub + y, 2), cq);
    }
  }
  if (nacc) put(0x7f, 8 - nacc);
  out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}
