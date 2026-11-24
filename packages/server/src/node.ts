import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, type Duplex } from "node:stream";
import type { App } from "./app.ts";
import { acceptWebSocket, handshakeKey } from "./ws.ts";
import { attachClientAddress, checkTrustedProxies, peerTrusted, resolveClientAddress, type TrustedProxies } from "./client-address.ts";

export interface NodeServeOptions {
  port?: number;
  host?: string;
  trustProxy?: boolean;
  trustedProxies?: TrustedProxies;
  onError?(err: unknown): void;
}

export interface NodeServer {
  url: string;
  close(): Promise<void>;
}

function toRequest(req: IncomingMessage, opts: NodeServeOptions, signal: AbortSignal): Request {
  const peer = req.socket.remoteAddress ?? null;
  const trusted = opts.trustedProxies ?? (opts.trustProxy ? 1 : undefined);
  const viaProxy = opts.trustedProxies === undefined ? opts.trustProxy === true : peerTrusted(peer, trusted);
  const fwd = (name: string) => {
    const v = req.headers[name];
    return viaProxy && typeof v === "string" ? v.split(",")[0].trim() : undefined;
  };
  const xff = req.headers["x-forwarded-for"];
  const address = resolveClientAddress(peer, Array.isArray(xff) ? xff.join(",") : (xff ?? null), trusted);
  const proto = fwd("x-forwarded-proto") ?? "http";
  const host = fwd("x-forwarded-host") ?? req.headers.host ?? "localhost";
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return attachClientAddress(new Request(`${proto}://${host}${req.url ?? "/"}`, {
    method,
    headers,
    signal,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    duplex: hasBody ? "half" : undefined,
  } as RequestInit), address);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") {
      headers[name] = value;
    }
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    headers["set-cookie"] = cookies;
  }
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on("close", () => {
    reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      res.write(value);
    }
  } finally {
    res.end();
  }
}

export function serveNode(app: App, opts: NodeServeOptions = {}): Promise<NodeServer> {
  checkTrustedProxies(opts.trustedProxies, "serveNode: trustedProxies");
  const onError = opts.onError ?? ((err: unknown) => console.error("[weft]", err));
  const server = createServer((req, res) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    (async () => {
      const response =
        (await app.fetch(toRequest(req, opts, abort.signal))) ?? new Response(null, { status: 426 });
      await send(res, response);
    })().catch((err: unknown) => {
      onError(err);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
  const upgrades = new Set<Duplex>();
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const refuse = (code: number, text: string) => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.on("error", () => socket.destroy());
    (async () => {
      if (!app.socket || !app.socketRoute) return refuse(404, "Not Found");
      const accept = handshakeKey(req.headers);
      if (accept === null) return refuse(400, "Bad Request");
      const abort = new AbortController();
      const result = await app.socket(toRequest(req, opts, abort.signal));
      if (result instanceof Response) {
        await result.body?.cancel().catch(() => undefined);
        return refuse(result.status, result.statusText || "Refused");
      }
      if (socket.destroyed) return;
      const bindRoute = app.socketRoute;
      upgrades.add(socket);
      socket.on("close", () => upgrades.delete(socket));
      const ws = acceptWebSocket(socket, head, accept, () => bindRoute(ws, result), { maxBytes: result.route.maxBytes });
    })().catch((err: unknown) => {
      onError(err);
      refuse(500, "Internal Server Error");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 3000, opts.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            for (const s of upgrades) s.destroy();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

export { runtimeAssets, rewriteImports } from "./assets.ts";
export { assetManifest, publicFiles } from "./files.ts";
export type { FileHandler, PublicFilesOptions } from "./files.ts";
export { parseConfig, resolveSecret, ConfigError, isSiteUrl } from "./config.ts";
export { loadConfig } from "./load-config.ts";
export { loadProject, ProjectError } from "./project.ts";
export type { ProjectApp, ProjectOptions } from "./project.ts";
export { projectStyles, StyleError } from "./tailwind.ts";
export type { ProjectStyles, StyleOptions } from "./tailwind.ts";
export { CompileError, compileFile, compileTree, findCompiler } from "./compiler.ts";
export type { Compiler } from "./compiler.ts";
export { ModelStorage } from "./storage.ts";
export type { StorageOptions } from "./storage.ts";

export { loadEnvFile } from "./env.ts";
