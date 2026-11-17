export type QrLevel = "L" | "M" | "Q" | "H";

export interface QrOptions {
  level?: QrLevel;
  minVersion?: number;
  mask?: number;
}

export interface QrCode {
  version: number;
  level: QrLevel;
  mask: number;
  size: number;
  modules: boolean[][];
}

const LEVEL = { L: 0, M: 1, Q: 2, H: 3 } as const;
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 } as const;

const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

const dataCodewords = (ver: number, l: number) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[l]![ver]! * BLOCKS[l]![ver]!;

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = gfMul(r[j]!, root);
      if (j + 1 < degree) r[j]! ^= r[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const r = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ r.shift()!;
    r.push(0);
    divisor.forEach((c, i) => (r[i]! ^= gfMul(c, factor)));
  }
  return r;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 17 - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

class Grid {
  readonly version: number;
  readonly size: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];

  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    this.dark[y]![x] = dark;
    this.fixed[y]![x] = true;
  }

  patterns(level: QrLevel): void {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < s && y >= 0 && y < s) this.set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const pos = alignmentPositions(this.version);
    const last = pos.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.set(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    this.format(level, 0);
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = s - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit(bits, i));
        this.set(b, a, bit(bits, i));
      }
    }
  }

  format(level: QrLevel, mask: number): void {
    const data = (FORMAT_BITS[level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const s = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(bits, i));
    this.set(8, s - 8, true);
  }

  codewords(data: readonly number[]): void {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < s; v++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? s - 1 - v : v;
          if (!this.fixed[y]![x] && i < data.length * 8) {
            this.dark[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  mask(m: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.fixed[y]![x]) continue;
        let flip: boolean;
        switch (m) {
          case 0: flip = (x + y) % 2 === 0; break;
          case 1: flip = y % 2 === 0; break;
          case 2: flip = x % 3 === 0; break;
          case 3: flip = (x + y) % 3 === 0; break;
          case 4: flip = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: flip = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: flip = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: flip = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (flip) this.dark[y]![x] = !this.dark[y]![x];
      }
    }
  }

  penalty(): number {
    const s = this.size;
    const d = this.dark;
    let score = 0;
    const line = (get: (i: number) => boolean) => {
      let run = 1;
      for (let i = 1; i <= s; i++) {
        if (i < s && get(i) === get(i - 1)) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      for (let i = 0; i + 7 <= s; i++) {
        if (!(get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6))) continue;
        const lightBefore = [1, 2, 3, 4].every((k) => i - k < 0 || !get(i - k));
        const lightAfter = [7, 8, 9, 10].every((k) => i + k >= s || !get(i + k));
        if (lightBefore || lightAfter) score += 40;
      }
    };
    for (let y = 0; y < s; y++) line((x) => d[y]![x]!);
    for (let x = 0; x < s; x++) line((y) => d[y]![x]!);
    let darkCount = 0;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        if (d[y]![x]) darkCount++;
        if (x + 1 < s && y + 1 < s) {
          const c = d[y]![x];
          if (c === d[y]![x + 1] && c === d[y + 1]![x] && c === d[y + 1]![x + 1]) score += 3;
        }
      }
    }
    score += Math.floor(Math.abs(darkCount * 20 - s * s * 10) / (s * s)) * 10;
    return score;
  }
}

export function qrCode(text: string, o: QrOptions = {}): QrCode {
  const level = o.level ?? "M";
  const l = LEVEL[level];
  if (l === undefined) throw new TypeError("qrCode: level is L, M, Q or H");
  const bytes = new TextEncoder().encode(String(text));
  const min = o.minVersion ?? 1;
  if (!Number.isInteger(min) || min < 1 || min > 40) throw new RangeError("qrCode: minVersion is 1-40");
  if (o.mask !== undefined && !(Number.isInteger(o.mask) && o.mask >= 0 && o.mask <= 7)) throw new RangeError("qrCode: mask is 0-7");

  let version = min;
  for (; ; version++) {
    if (version > 40) throw new RangeError("qrCode: text too long for a QR code");
    const countBits = version <= 9 ? 8 : 16;
    if (bytes.length < 2 ** countBits && 4 + countBits + bytes.length * 8 <= dataCodewords(version, l) * 8) break;
  }

  const capacity = dataCodewords(version, l) * 8;
  const bits: number[] = [];
  const push = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  const blocks = BLOCKS[l]![version]!;
  const eccLen = ECC_PER_BLOCK[l]![version]!;
  const raw = Math.floor(rawModules(version) / 8);
  const short = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const parts: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < short) dat.push(0);
    parts.push(dat.concat(ecc));
  }
  const codewords: number[] = [];
  for (let i = 0; i < parts[0]!.length; i++) {
    parts.forEach((p, j) => {
      if (i !== shortLen - eccLen || j >= short) codewords.push(p[i]!);
    });
  }

  const grid = new Grid(version);
  grid.patterns(level);
  grid.codewords(codewords);
  let mask = o.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      grid.mask(m);
      grid.format(level, m);
      const p = grid.penalty();
      if (p < best) {
        best = p;
        mask = m;
      }
      grid.mask(m);
    }
  }
  grid.mask(mask);
  grid.format(level, mask);
  return { version, level, mask, size: grid.size, modules: grid.dark };
}

export function qrPath(code: QrCode, quiet = 4): string {
  let d = "";
  code.modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (x + w < row.length && row[x + w]) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w - 1;
    }
  });
  return d;
}

export const qrViewBox = (code: QrCode, quiet = 4) => `0 0 ${code.size + quiet * 2} ${code.size + quiet * 2}`;
