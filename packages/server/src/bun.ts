import type { App } from "./app.ts";

export interface BunServeOptions {
  port?: number;
  hostname?: string;
  trustProxy?: boolean;
  idleTimeout?: number;
  onError?(err: unknown): void;
}

export interface BunServer {
  url: string;
  close(): Promise<void>;
}

export interface BunServeApi {
  serve(opts: {
    port: number;
    hostname: string;
    idleTimeout: number;
    fetch(req: Request, server: unknown): Promise<Response | undefined>;
    error(err: unknown): Response;
    websocket: App["websocket"] & { sendPings?: boolean; idleTimeout?: number };
  }): { url: URL; stop(closeActive?: boolean): unknown };
}

export function forwarded(req: Request): Request {
  const first = (name: string) => req.headers.get(name)?.split(",")[0].trim() || undefined;
  const proto = first("x-forwarded-proto");
  const host = first("x-forwarded-host");
  if (!proto && !host) {
    return req;
  }
  const url = new URL(req.url);
  if (proto === "http" || proto === "https") {
    url.protocol = `${proto}:`;
  }
  if (host) {
    try {
      const parsed = new URL(`http://${host}`);
      if (parsed.username === "" && parsed.password === "" && parsed.pathname === "/" && !parsed.search) {
        url.hostname = parsed.hostname;
        url.port = parsed.port;
      }
    } catch {
    }
  }
  return url.href === req.url ? req : new Request(url, req);
}

export function serveBun(app: App, opts: BunServeOptions = {}, bun?: BunServeApi): BunServer {
  const api = bun ?? (globalThis as { Bun?: BunServeApi }).Bun;
  if (!api) {
    throw new Error("serveBun: not running on Bun (no global `Bun`)");
  }
  const onError = opts.onError ?? ((err: unknown) => console.error("[weft]", err));
  const server = api.serve({
    port: opts.port ?? 3000,
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout: Math.min(255, Math.max(0, opts.idleTimeout ?? 60)),
    fetch: (req, srv) => app.fetch(opts.trustProxy ? forwarded(req) : req, srv as never),
    error(err) {
      onError(err);
      return new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } });
    },
    websocket: {
      open: (ws) => app.websocket.open(ws),
      message: (ws, data) => app.websocket.message(ws, data),
      close: (ws) => app.websocket.close(ws),
      sendPings: true,
    },
  });
  return {
    url: server.url.href,
    close: async () => {
      await server.stop(true);
    },
  };
}
