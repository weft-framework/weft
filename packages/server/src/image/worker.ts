import { parentPort } from "node:worker_threads";
import { transform, type Variant } from "./transform.ts";

parentPort?.on("message", (m: { id: number; src: Uint8Array; variant: Variant; maxPixels: number }) => {
  try {
    const r = transform(m.src, m.variant, m.maxPixels);
    parentPort!.postMessage({ id: m.id, ok: r }, [r.bytes.buffer as ArrayBuffer]);
  } catch (err) {
    parentPort!.postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
});
