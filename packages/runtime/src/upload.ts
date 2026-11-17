export interface UploadedFile {
  id: string;
  kind: string;
  name: string;
  type: string;
  size: number;
}

export interface UploadOptions {
  onProgress?(sent: number, total: number): void;
  signal?: AbortSignal;
  concurrency?: number;
  resume?: string;
  base?: string;
}

export class UploadFailed extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "UploadFailed";
    this.code = code;
    this.status = status;
  }
}

function csrf(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="weft-csrf"]')?.content ?? "";
}

function remembered(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
  }
  return null;
}

async function call<T>(base: string, path: string, method: "GET" | "POST", body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(base + path, {
    method,
    credentials: "same-origin",
    headers: { "x-weft-csrf": csrf(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  let data: { ok?: boolean; error?: string; code?: string } & Record<string, unknown> = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
  }
  if (!res.ok) throw new UploadFailed(data.error ?? `HTTP ${res.status}`, data.code ?? "http", res.status);
  return data as T;
}

function put(url: string, headers: Record<string, string>, blob: Blob, sameSite: boolean, onSent: (n: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.withCredentials = false;
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (sameSite) xhr.setRequestHeader("x-weft-csrf", csrf());
    xhr.upload.onprogress = (e) => onSent(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new UploadFailed(`part refused: HTTP ${xhr.status}`, "part", xhr.status)));
    xhr.onerror = () => reject(new UploadFailed("network error", "network", 0));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

export async function uploadFile(file: File | Blob, kind: string, o: UploadOptions = {}): Promise<UploadedFile> {
  const base = o.base ?? "/_weft/uploads/";
  const name = (file as File).name ?? "file";
  const type = file.type || "application/octet-stream";
  const memo = `weft-upload:${kind}:${name}:${file.size}:${(file as File).lastModified ?? 0}`;
  const concurrency = Math.min(6, Math.max(1, Math.floor(o.concurrency ?? 3)));

  type Status = UploadedFile & { parts: number; partBytes: number; received: number[]; ready: boolean };
  let id = o.resume ?? remembered(memo);
  let plan: { parts: number; partBytes: number; received: Set<number> } | null = null;
  if (id) {
    try {
      const s = await call<Status>(base, encodeURIComponent(id), "GET", undefined, o.signal);
      if (s.size === file.size && s.kind === kind) {
        if (s.ready) {
          remembered(memo, null);
          o.onProgress?.(file.size, file.size);
          return { id: s.id, kind: s.kind, name: s.name, type: s.type, size: s.size };
        }
        plan = { parts: s.parts, partBytes: s.partBytes, received: new Set(s.received) };
      }
    } catch (err) {
      if (o.signal?.aborted) throw err;
    }
  }
  if (!plan) {
    const s = await call<{ id: string; parts: number; partBytes: number }>(base, "start", "POST", { kind, name, size: file.size, type }, o.signal);
    id = s.id;
    plan = { parts: s.parts, partBytes: s.partBytes, received: new Set() };
    remembered(memo, id);
  }
  const uid = id!;
  const sizeOf = (i: number) => (i < plan!.parts ? plan!.partBytes : file.size - plan!.partBytes * (plan!.parts - 1));
  const inFlight = new Map<number, number>();
  let done = 0;
  for (const i of plan.received) done += sizeOf(i);
  const report = () => {
    let sent = done;
    for (const n of inFlight.values()) sent += n;
    o.onProgress?.(Math.min(sent, file.size), file.size);
  };
  report();

  const queue: number[] = [];
  for (let i = 1; i <= plan.parts; i++) if (!plan.received.has(i)) queue.push(i);
  const worker = async () => {
    for (;;) {
      const i = queue.shift();
      if (i === undefined) return;
      const start = (i - 1) * plan!.partBytes;
      const blob = file.slice(start, start + sizeOf(i));
      for (let attempt = 1; ; attempt++) {
        try {
          const target = await call<{ url: string; headers: Record<string, string> }>(base, `${encodeURIComponent(uid)}/part/${i}`, "POST", {}, o.signal);
          const sameSite = new URL(target.url, location.href).origin === location.origin;
          await put(target.url, target.headers ?? {}, blob, sameSite, (n) => (inFlight.set(i, n), report()), o.signal);
          inFlight.delete(i);
          done += blob.size;
          report();
          break;
        } catch (err) {
          inFlight.delete(i);
          report();
          const status = err instanceof UploadFailed ? err.status : 0;
          const permanent = status === 400 || status === 403 || status === 404 || status === 413 || status === 415;
          if (o.signal?.aborted || permanent || attempt >= 5) throw err;
          await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** attempt)));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker));
  const info = await call<UploadedFile>(base, `${encodeURIComponent(uid)}/complete`, "POST", {}, o.signal);
  remembered(memo, null);
  return info;
}

export async function abortUpload(id: string, base = "/_weft/uploads/"): Promise<boolean> {
  const r = await call<{ ok: boolean }>(base, `${encodeURIComponent(id)}/abort`, "POST", {});
  return r.ok === true;
}
