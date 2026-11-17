import { crop, flatten, ImageError, orient, resize, type Bitmap } from "./bitmap.ts";
import { decodeJpeg, encodeJpeg, isJpeg, jpegSize } from "./jpeg.ts";
import { decodePng, encodePng, isPng, pngSize } from "./png.ts";

export type ImageFormat = "jpeg" | "png";

export interface Variant {
  width: number;
  aspect?: [number, number];
  focus?: [number, number];
  format: ImageFormat | "auto";
  quality: number;
}

export interface Transformed {
  bytes: Uint8Array;
  type: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

export function probe(src: Uint8Array): { format: ImageFormat; width: number; height: number } | null {
  if (isJpeg(src)) return { format: "jpeg", ...jpegSize(src) };
  if (isPng(src)) return { format: "png", ...pngSize(src) };
  return null;
}

export function transform(src: Uint8Array, v: Variant, maxPixels: number): Transformed {
  const kind = probe(src);
  if (!kind) throw new ImageError("not a JPEG or PNG image");
  if (kind.width * kind.height > maxPixels || kind.width < 1 || kind.height < 1) throw new ImageError("image too large");
  let img: Bitmap;
  if (kind.format === "jpeg") {
    const d = decodeJpeg(src, maxPixels);
    img = orient(d, d.orientation);
  } else {
    img = decodePng(src, maxPixels);
  }
  if (v.aspect) {
    const [aw, ah] = v.aspect;
    const fx = v.focus?.[0] ?? 0.5;
    const fy = v.focus?.[1] ?? 0.5;
    let w = img.width;
    let h = Math.round((w * ah) / aw);
    if (h > img.height) {
      h = img.height;
      w = Math.round((h * aw) / ah);
    }
    img = crop(img, (img.width - w) * fx, (img.height - h) * fy, w, h);
  }
  const width = Math.min(v.width, img.width);
  if (width !== img.width) img = resize(img, width, Math.max(1, Math.round((img.height * width) / img.width)));
  let format = v.format;
  if (format === "auto") {
    format = "jpeg";
    for (let i = 3; i < img.data.length; i += 4) {
      if (img.data[i] !== 255) {
        format = "png";
        break;
      }
    }
  }
  const bytes = format === "png" ? encodePng(img) : encodeJpeg(flatten(img), v.quality);
  return { bytes, type: format === "png" ? "image/png" : "image/jpeg", width: img.width, height: img.height };
}
