import { timingSafeEqual } from "node:crypto";

const ALPHABET = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const BCRYPT = /^\$2[aby]\$(\d{2})\$([./A-Za-z0-9]{22})([./A-Za-z0-9]{31})$/;
const ORPHEAN = [0x4f727068, 0x65616e42, 0x65686f6c, 0x64657253, 0x63727944, 0x6f756274];
const MAX_ROUNDS = 16;

let constants: { p: Uint32Array; s: Uint32Array } | null = null;

function atanInv(x: bigint, scale: bigint): bigint {
  const x2 = x * x;
  let term = scale / x;
  let sum = term;
  let k = 1n;
  let sign = -1n;
  while (term !== 0n) {
    term /= x2;
    sum += (sign * term) / (2n * k + 1n);
    sign = -sign;
    k++;
  }
  return sum;
}

function blowfishConstants(): { p: Uint32Array; s: Uint32Array } {
  if (constants) return constants;
  const words = 18 + 1024;
  const bits = BigInt(words * 32 + 64);
  const scale = 1n << bits;
  const pi = 4n * (4n * atanInv(5n, scale) - atanInv(239n, scale));
  const frac = (pi - 3n * scale) >> 64n;
  const hex = frac.toString(16).padStart(words * 8, "0");
  const all = new Uint32Array(words);
  for (let i = 0; i < words; i++) all[i] = Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16);
  constants = { p: all.slice(0, 18), s: all.slice(18) };
  return constants;
}

function decode(text: string, bytes: number): Uint8Array | null {
  const out = new Uint8Array(bytes);
  let bitsHeld = 0;
  let acc = 0;
  let o = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bitsHeld += 6;
    if (bitsHeld >= 8) {
      bitsHeld -= 8;
      if (o < bytes) out[o++] = (acc >> bitsHeld) & 0xff;
    }
  }
  return o === bytes ? out : null;
}

function encode(data: Uint8Array, chars: number): string {
  let out = "";
  let acc = 0;
  let bitsHeld = 0;
  for (const b of data) {
    acc = ((acc << 8) | b) & 0xffffff;
    bitsHeld += 8;
    while (bitsHeld >= 6) {
      bitsHeld -= 6;
      out += ALPHABET[(acc >> bitsHeld) & 63];
    }
  }
  if (bitsHeld > 0) out += ALPHABET[(acc << (6 - bitsHeld)) & 63];
  return out.slice(0, chars);
}

class Blowfish {
  readonly p: Uint32Array;
  readonly s: Uint32Array;
  constructor() {
    const c = blowfishConstants();
    this.p = c.p.slice();
    this.s = c.s.slice();
  }

  encipher(lr: Uint32Array, off: number): void {
    const { p, s } = this;
    let l = lr[off]! ^ p[0]!;
    let r = lr[off + 1]!;
    for (let i = 0; i <= 14; ) {
      let n = (s[l >>> 24]! + s[0x100 | ((l >>> 16) & 0xff)]!) >>> 0;
      n = (n ^ s[0x200 | ((l >>> 8) & 0xff)]!) >>> 0;
      n = (n + s[0x300 | (l & 0xff)]!) >>> 0;
      r = (r ^ n ^ p[++i]!) >>> 0;
      n = (s[r >>> 24]! + s[0x100 | ((r >>> 16) & 0xff)]!) >>> 0;
      n = (n ^ s[0x200 | ((r >>> 8) & 0xff)]!) >>> 0;
      n = (n + s[0x300 | (r & 0xff)]!) >>> 0;
      l = (l ^ n ^ p[++i]!) >>> 0;
    }
    lr[off] = (r ^ p[17]!) >>> 0;
    lr[off + 1] = l;
  }

  expand(key: Uint8Array, salt: Uint8Array | null): void {
    let k = 0;
    let d = 0;
    const word = (data: Uint8Array, at: () => number, set: (n: number) => void): number => {
      let w = 0;
      let o = at();
      for (let i = 0; i < 4; i++) {
        w = ((w << 8) | data[o]!) >>> 0;
        o = (o + 1) % data.length;
      }
      set(o);
      return w;
    };
    const fromKey = () => word(key, () => k, (n) => (k = n));
    const fromSalt = () => (salt ? word(salt, () => d, (n) => (d = n)) : 0);
    for (let i = 0; i < 18; i++) this.p[i] = (this.p[i]! ^ fromKey()) >>> 0;
    const lr = new Uint32Array(2);
    for (const box of [this.p, this.s]) {
      for (let i = 0; i < box.length; i += 2) {
        lr[0] = (lr[0]! ^ fromSalt()) >>> 0;
        lr[1] = (lr[1]! ^ fromSalt()) >>> 0;
        this.encipher(lr, 0);
        box[i] = lr[0]!;
        box[i + 1] = lr[1]!;
      }
    }
  }
}

export function bcryptDigest(password: string, cost: number, salt: Uint8Array): string {
  const raw = new TextEncoder().encode(password);
  const key = new Uint8Array(Math.min(raw.length + 1, 72));
  key.set(raw.subarray(0, key.length - (raw.length + 1 > 72 ? 0 : 1)));
  const bf = new Blowfish();
  bf.expand(key, salt);
  const rounds = 2 ** cost;
  for (let i = 0; i < rounds; i++) {
    bf.expand(key, null);
    bf.expand(salt, null);
  }
  const data = Uint32Array.from(ORPHEAN);
  for (let i = 0; i < 64; i++) for (let j = 0; j < 6; j += 2) bf.encipher(data, j);
  const out = new Uint8Array(24);
  for (let i = 0; i < 6; i++) {
    out[i * 4] = data[i]! >>> 24;
    out[i * 4 + 1] = (data[i]! >>> 16) & 0xff;
    out[i * 4 + 2] = (data[i]! >>> 8) & 0xff;
    out[i * 4 + 3] = data[i]! & 0xff;
  }
  return encode(out.subarray(0, 23), 31);
}

export function isBcryptHash(stored: string | null | undefined): boolean {
  return typeof stored === "string" && BCRYPT.test(stored);
}

export function verifyBcrypt(password: string, stored: string): boolean {
  const m = BCRYPT.exec(stored);
  if (!m || typeof password !== "string" || password.length === 0) return false;
  const cost = Number(m[1]);
  if (cost < 4 || cost > MAX_ROUNDS) return false;
  const salt = decode(m[2]!, 16);
  if (!salt) return false;
  const got = Buffer.from(bcryptDigest(password, cost, salt));
  const want = Buffer.from(m[3]!);
  return got.length === want.length && timingSafeEqual(got, want);
}
