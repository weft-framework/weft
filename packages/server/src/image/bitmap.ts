export class ImageError extends Error {}

export interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

export function crop(img: Bitmap, x: number, y: number, w: number, h: number): Bitmap {
  x = Math.max(0, Math.min(img.width - 1, Math.floor(x)));
  y = Math.max(0, Math.min(img.height - 1, Math.floor(y)));
  w = Math.max(1, Math.min(img.width - x, Math.round(w)));
  h = Math.max(1, Math.min(img.height - y, Math.round(h)));
  const data = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const s = ((y + row) * img.width + x) * 4;
    data.set(img.data.subarray(s, s + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}

export function orient(img: Bitmap, orientation: number): Bitmap {
  if (orientation < 2 || orientation > 8) return img;
  const { width: W, height: H, data } = img;
  const swap = orientation >= 5;
  const w = swap ? H : W;
  const h = swap ? W : H;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let nx: number;
      let ny: number;
      switch (orientation) {
        case 2: nx = W - 1 - x; ny = y; break;
        case 3: nx = W - 1 - x; ny = H - 1 - y; break;
        case 4: nx = x; ny = H - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = H - 1 - y; ny = x; break;
        case 7: nx = H - 1 - y; ny = W - 1 - x; break;
        default: nx = y; ny = W - 1 - x; break;
      }
      const s = (y * W + x) * 4;
      const d = (ny * w + nx) * 4;
      out[d] = data[s]!;
      out[d + 1] = data[s + 1]!;
      out[d + 2] = data[s + 2]!;
      out[d + 3] = data[s + 3]!;
    }
  }
  return { width: w, height: h, data: out };
}

const lanczos = (x: number): number => {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
};

function weights(src: number, dst: number): { start: Int32Array; count: Int32Array; w: Float32Array; taps: number } {
  const scale = dst / src;
  const support = 3 * Math.max(1, 1 / scale);
  const taps = Math.ceil(support) * 2 + 1;
  const start = new Int32Array(dst);
  const count = new Int32Array(dst);
  const w = new Float32Array(dst * taps);
  for (let i = 0; i < dst; i++) {
    const center = (i + 0.5) / scale - 0.5;
    const lo = Math.max(0, Math.floor(center - support));
    const hi = Math.min(src - 1, Math.ceil(center + support));
    const f = Math.min(1, scale);
    let sum = 0;
    let n = 0;
    for (let j = lo; j <= hi && n < taps; j++, n++) {
      const v = lanczos((j - center) * f);
      w[i * taps + n] = v;
      sum += v;
    }
    for (let k = 0; k < n; k++) w[i * taps + k]! /= sum || 1;
    start[i] = lo;
    count[i] = n;
  }
  return { start, count, w, taps };
}

export function resize(img: Bitmap, w: number, h: number): Bitmap {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (w === img.width && h === img.height) return img;
  const { width: W, height: H, data } = img;
  const src = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const a = data[i * 4 + 3]! / 255;
    src[i * 4] = data[i * 4]! * a;
    src[i * 4 + 1] = data[i * 4 + 1]! * a;
    src[i * 4 + 2] = data[i * 4 + 2]! * a;
    src[i * 4 + 3] = data[i * 4 + 3]!;
  }
  const hx = weights(W, w);
  const mid = new Float32Array(w * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const s0 = hx.start[x]!;
      for (let k = 0; k < hx.count[x]!; k++) {
        const wt = hx.w[x * hx.taps + k]!;
        const s = (y * W + s0 + k) * 4;
        r += src[s]! * wt;
        g += src[s + 1]! * wt;
        b += src[s + 2]! * wt;
        a += src[s + 3]! * wt;
      }
      const d = (y * w + x) * 4;
      mid[d] = r;
      mid[d + 1] = g;
      mid[d + 2] = b;
      mid[d + 3] = a;
    }
  }
  const vy = weights(H, h);
  const out = new Uint8Array(w * h * 4);
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let y = 0; y < h; y++) {
    const s0 = vy.start[y]!;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < vy.count[y]!; k++) {
        const wt = vy.w[y * vy.taps + k]!;
        const s = ((s0 + k) * w + x) * 4;
        r += mid[s]! * wt;
        g += mid[s + 1]! * wt;
        b += mid[s + 2]! * wt;
        a += mid[s + 3]! * wt;
      }
      const d = (y * w + x) * 4;
      const alpha = clamp(a);
      const k = alpha > 0 ? 255 / a : 0;
      out[d] = alpha ? clamp(r * k) : 0;
      out[d + 1] = alpha ? clamp(g * k) : 0;
      out[d + 2] = alpha ? clamp(b * k) : 0;
      out[d + 3] = alpha;
    }
  }
  return { width: w, height: h, data: out };
}

export function flatten(img: Bitmap, rgb: [number, number, number] = [255, 255, 255]): Bitmap {
  const data = new Uint8Array(img.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = img.data[i + 3]! / 255;
    data[i] = Math.round(img.data[i]! * a + rgb[0] * (1 - a));
    data[i + 1] = Math.round(img.data[i + 1]! * a + rgb[1] * (1 - a));
    data[i + 2] = Math.round(img.data[i + 2]! * a + rgb[2] * (1 - a));
    data[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}
