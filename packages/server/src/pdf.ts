import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

export class PdfError extends Error {}

const PAPER = {
  A3: [11.69, 16.54],
  A4: [8.27, 11.69],
  A5: [5.83, 8.27],
  Letter: [8.5, 11],
  Legal: [8.5, 14],
} as const;
export type PaperFormat = keyof typeof PAPER;

export interface PdfRouteOptions {
  filename?: string;
  format?: PaperFormat;
  landscape?: boolean;
}

export interface PrintJob {
  url: string;
  html: string;
  fetch(url: string): Promise<Response>;
  format?: PaperFormat;
  landscape?: boolean;
}

export interface CaptureJob {
  url: string;
  html: string;
  fetch(url: string): Promise<Response>;
  width: number;
  height: number;
}

export interface PdfPrinter {
  print(job: PrintJob): Promise<Uint8Array>;
  capture?(job: CaptureJob): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface PdfOptions {
  browser?: string;
  concurrency?: number;
  timeoutMs?: number;
  maxBytes?: number;
  args?: string[];
}

const FILENAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,99}\.pdf$/;

export function checkPdfRoute(raw: unknown, where: string): true | PdfRouteOptions {
  if (raw === true) return true;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(`${where}: pdf is true or { filename, format, landscape }`);
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== "filename" && k !== "format" && k !== "landscape") throw new TypeError(`${where}: pdf.${k} is not filename, format or landscape`);
  }
  if (o.filename !== undefined && (typeof o.filename !== "string" || !FILENAME.test(o.filename))) {
    throw new TypeError(`${where}: pdf.filename is a plain file name ending in .pdf`);
  }
  if (o.format !== undefined && !(typeof o.format === "string" && o.format in PAPER)) {
    throw new TypeError(`${where}: pdf.format is one of ${Object.keys(PAPER).join(", ")}`);
  }
  if (o.landscape !== undefined && typeof o.landscape !== "boolean") throw new TypeError(`${where}: pdf.landscape is true or false`);
  return o as PdfRouteOptions;
}

export function pdfFilename(path: string, spec: true | PdfRouteOptions): string {
  if (spec !== true && spec.filename) return spec.filename;
  const last = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "page").replace(/[^A-Za-z0-9._()-]+/g, "-");
  const name = (last.replace(/^[^A-Za-z0-9]+/, "") || "page").slice(0, 90);
  return `${name}.pdf`;
}

export function findBrowser(env: Record<string, string | undefined> = process.env): string | null {
  if (env.WEFT_BROWSER) return existsSync(env.WEFT_BROWSER) ? env.WEFT_BROWSER : null;
  const fixed = [
    join(env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    join(env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const p of fixed) if (p && existsSync(p)) return p;
  const roots = [env.PLAYWRIGHT_BROWSERS_PATH, join(env.LOCALAPPDATA ?? "", "ms-playwright"), join(homedir(), ".cache", "ms-playwright")];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const d of dirs) {
      for (const rel of [["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"], ["chrome-linux", "chrome"], ["chrome-linux64", "chrome"]]) {
        const p = join(root, d, ...rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string }; sessionId?: string };

class Chromium {
  readonly #proc: ChildProcess;
  readonly #in: Writable;
  readonly #profile: string;
  #next = 1;
  #buf = "";
  readonly #calls = new Map<number, { resolve(r: Record<string, unknown>): void; reject(e: Error): void; method: string }>();
  readonly #events = new Map<string, (m: Message) => void>();
  closed = false;

  constructor(exe: string, args: string[]) {
    this.#profile = mkdtempSync(join(tmpdir(), "weft-pdf-"));
    this.#proc = spawn(
      exe,
      [
        "--headless=new",
        "--remote-debugging-pipe",
        `--user-data-dir=${this.#profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--mute-audio",
        ...args,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    );
    this.#in = this.#proc.stdio[3] as Writable;
    const out = this.#proc.stdio[4] as Readable;
    out.setEncoding("utf8");
    out.on("data", (chunk: string) => {
      this.#buf += chunk;
      for (let end = this.#buf.indexOf("\0"); end >= 0; end = this.#buf.indexOf("\0")) {
        const text = this.#buf.slice(0, end);
        this.#buf = this.#buf.slice(end + 1);
        let msg: Message;
        try {
          msg = JSON.parse(text) as Message;
        } catch {
          continue;
        }
        this.#dispatch(msg);
      }
    });
    this.#in.on("error", () => this.#gone());
    this.#proc.on("error", () => this.#gone());
    this.#proc.on("exit", () => this.#gone());
  }

  #dispatch(msg: Message): void {
    if (msg.id !== undefined) {
      const call = this.#calls.get(msg.id);
      this.#calls.delete(msg.id);
      if (!call) return;
      if (msg.error) call.reject(new PdfError(`${call.method}: ${msg.error.message}`));
      else call.resolve(msg.result ?? {});
      return;
    }
    if (msg.sessionId) this.#events.get(msg.sessionId)?.(msg);
  }

  #gone(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, call] of this.#calls) call.reject(new PdfError(`${call.method}: the browser stopped`));
    this.#calls.clear();
    try {
      rmSync(this.#profile, { recursive: true, force: true });
    } catch {
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new PdfError("the browser stopped"));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#calls.set(id, { resolve, reject, method });
      this.#in.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }

  on(sessionId: string, fn: ((m: Message) => void) | null): void {
    if (fn) this.#events.set(sessionId, fn);
    else this.#events.delete(sessionId);
  }

  kill(): void {
    this.#proc.kill();
    this.#gone();
  }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

class Printer implements PdfPrinter {
  readonly #o: Required<Omit<PdfOptions, "browser">> & { browser: string | undefined };
  #browser: Chromium | null = null;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(o: PdfOptions) {
    const concurrency = o.concurrency ?? 2;
    const timeoutMs = o.timeoutMs ?? 30_000;
    const maxBytes = o.maxBytes ?? 20 * 1024 * 1024;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new RangeError("definePdf: concurrency is 1-16");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new RangeError("definePdf: timeoutMs is at least 1000");
    if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw new RangeError("definePdf: maxBytes is at least 1024");
    if (o.args !== undefined && (!Array.isArray(o.args) || !o.args.every((a) => typeof a === "string" && a.startsWith("--")))) {
      throw new TypeError("definePdf: args are browser flags (\"--...\")");
    }
    this.#o = { browser: o.browser, concurrency, timeoutMs, maxBytes, args: o.args ?? [] };
  }

  #chromium(): Chromium {
    if (this.#browser && !this.#browser.closed) return this.#browser;
    const exe = this.#o.browser ?? findBrowser();
    if (!exe || !existsSync(exe)) {
      throw new PdfError("no browser to print with: install Chrome, Edge or Chromium, or set definePdf({ browser }) or WEFT_BROWSER");
    }
    this.#browser = new Chromium(exe, this.#o.args);
    return this.#browser;
  }

  print(job: PrintJob): Promise<Uint8Array> {
    return this.#queued(() =>
      this.#render(job, undefined, async (call) => {
        const [w, h] = PAPER[job.format ?? "A4"];
        const out = (await call("Page.printToPDF", {
          printBackground: true,
          preferCSSPageSize: true,
          landscape: job.landscape === true,
          paperWidth: w,
          paperHeight: h,
          marginTop: 0.4,
          marginBottom: 0.4,
          marginLeft: 0.4,
          marginRight: 0.4,
        })) as { data?: string };
        if (typeof out.data !== "string") throw new PdfError("the browser returned no PDF");
        return out.data;
      }),
    );
  }

  capture(job: CaptureJob): Promise<Uint8Array> {
    const size = (n: number) => Number.isInteger(n) && n >= 16 && n <= 4096;
    if (!size(job.width) || !size(job.height)) throw new RangeError("capture: width and height are 16-4096");
    return this.#queued(() =>
      this.#render(job, { width: job.width, height: job.height }, async (call) => {
        const out = (await call("Page.captureScreenshot", {
          format: "png",
          clip: { x: 0, y: 0, width: job.width, height: job.height, scale: 1 },
          captureBeyondViewport: false,
        })) as { data?: string };
        if (typeof out.data !== "string") throw new PdfError("the browser returned no image");
        return out.data;
      }),
    );
  }

  async #queued<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#o.concurrency) await new Promise<void>((r) => this.#waiting.push(r));
    this.#running += 1;
    try {
      return await fn();
    } finally {
      this.#running -= 1;
      this.#waiting.shift()?.();
    }
  }

  async #render(
    job: { url: string; html: string; fetch(url: string): Promise<Response> },
    viewport: { width: number; height: number } | undefined,
    produce: (call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<string>,
  ): Promise<Uint8Array> {
    const page = new URL(job.url);
    const browser = this.#chromium();
    const { targetId } = (await browser.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    let sessionId = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      ({ sessionId } = (await browser.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string });
      const call = (method: string, params: Record<string, unknown> = {}) => browser.send(method, params, sessionId);
      let requests = 0;
      let loaded!: () => void;
      const load = new Promise<void>((r) => (loaded = r));
      browser.on(sessionId, (m) => {
        if (m.method === "Page.loadEventFired") loaded();
        if (m.method !== "Fetch.requestPaused") return;
        const p = m.params as { requestId: string; request: { url: string; method: string } };
        void (async () => {
          try {
            const asked = new URL(p.request.url);
            if (p.request.method === "GET" && asked.href.split("#")[0] === page.href.split("#")[0]) {
              await call("Fetch.fulfillRequest", {
                requestId: p.requestId,
                responseCode: 200,
                responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
                body: b64(new TextEncoder().encode(job.html)),
              });
              return;
            }
            const own = asked.origin === page.origin && p.request.method === "GET" && asked.pathname !== "/favicon.ico";
            if (!own || ++requests > 200) throw new Error("refused");
            const res = await job.fetch(asked.href);
            const body = new Uint8Array(await res.arrayBuffer());
            if (body.byteLength > 10 * 1024 * 1024) throw new Error("too large");
            const type = res.headers.get("content-type");
            await call("Fetch.fulfillRequest", {
              requestId: p.requestId,
              responseCode: res.status >= 200 && res.status < 600 ? res.status : 502,
              responseHeaders: type ? [{ name: "content-type", value: type }] : [],
              body: b64(body),
            });
          } catch {
            await call("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }).catch(() => {});
          }
        })();
      });
      const run = (async () => {
        await call("Emulation.setScriptExecutionDisabled", { value: true });
        if (viewport) await call("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
        await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
        await call("Page.enable");
        await call("Page.navigate", { url: page.href });
        await load;
        const data = await produce(call);
        if (data.length * 0.75 > this.#o.maxBytes) throw new PdfError(`the output is larger than ${this.#o.maxBytes} bytes`);
        return new Uint8Array(Buffer.from(data, "base64"));
      })();
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PdfError(`printing took longer than ${this.#o.timeoutMs} ms`)), this.#o.timeoutMs);
      });
      run.catch(() => {});
      return await Promise.race([run, limit]);
    } finally {
      clearTimeout(timer);
      if (sessionId) browser.on(sessionId, null);
      await browser.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.#browser?.kill();
    this.#browser = null;
  }
}

export function definePdf(o: PdfOptions = {}): PdfPrinter {
  return new Printer(o);
}
