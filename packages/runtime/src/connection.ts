import {
  decodeServerMessage,
  encode,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.ts";

export type Status = "connecting" | "open" | "reconnecting" | "suspended" | "offline" | "closed";

export interface WsLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface EsLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  readyState?: number;
  close(): void;
}

const ES_CLOSED = 2;
const ES_EXPIRE_DELAY_MS = 1000;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; credentials: "same-origin" },
) => Promise<{ ok: boolean; status: number }>;

export interface ConnectionOptions {
  wsUrl: string;
  sseUrl: string;
  postUrl: string;
  onMessage(msg: ServerMessage): void;
  onStatus?(status: Status): void;
  headers?(): Record<string, string>;
  WebSocket?: new (url: string) => WsLike;
  EventSource?: new (url: string, init?: { withCredentials?: boolean }) => EsLike;
  fetch?: FetchLike;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  random?(): number;
  maxWsFailures?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

type Mode = "ws" | "sse" | "none";

export class LiveConnection {
  private readonly opts: ConnectionOptions;
  private mode: Mode = "none";
  private ws: WsLike | null = null;
  private es: EsLike | null = null;
  private open = false;
  private closed = false;
  private suspended = false;
  private offlineNow = false;
  private failures = 0;
  private attempt = 0;
  private timer: unknown = null;
  private session: string | null = null;
  private readonly queue: ClientMessage[] = [];

  constructor(opts: ConnectionOptions) {
    this.opts = opts;
  }

  start(): void {
    this.closed = false;
    this.status("connecting");
    this.connect();
  }

  send(msg: ClientMessage): void {
    if (!this.open) {
      this.queue.push(msg.t === "event" ? { ...msg, queued: true } : msg);
      this.resume();
      return;
    }
    this.transmit(msg);
  }

  offline(): void {
    if (this.closed || this.offlineNow) {
      return;
    }
    this.offlineNow = true;
    this.drop();
    this.status("offline");
  }

  online(): void {
    if (this.closed || !this.offlineNow) {
      return;
    }
    this.offlineNow = false;
    if (this.suspended) {
      return;
    }
    this.attempt = 0;
    this.status("connecting");
    this.connect();
  }

  suspend(): void {
    if (this.closed || this.suspended) {
      return;
    }
    this.suspended = true;
    this.drop();
    this.status("suspended");
  }

  resume(): void {
    if (this.closed || !this.suspended) {
      return;
    }
    this.suspended = false;
    if (this.offlineNow) {
      this.status("offline");
      return;
    }
    this.attempt = 0;
    this.status("connecting");
    this.connect();
  }

  close(): void {
    this.closed = true;
    this.drop();
    this.status("closed");
  }

  get transport(): Mode {
    return this.mode;
  }

  private status(s: Status): void {
    this.opts.onStatus?.(s);
  }

  private drop(): void {
    this.open = false;
    if (this.timer !== null) {
      (this.opts.clearTimeout ?? clearTimeout)(this.timer as never);
      this.timer = null;
    }
    const ws = this.ws;
    const es = this.es;
    this.ws = null;
    this.es = null;
    this.session = null;
    ws?.close();
    es?.close();
  }

  private connect(): void {
    const useWs =
      this.opts.WebSocket !== undefined &&
      (this.failures < (this.opts.maxWsFailures ?? 3) ||
        this.opts.EventSource === undefined);
    if (useWs) {
      this.connectWs();
    } else if (this.opts.EventSource !== undefined) {
      this.connectSse();
    } else {
      this.status("closed");
    }
  }

  private connectWs(): void {
    const Ws = this.opts.WebSocket!;
    const ws = new Ws(this.opts.wsUrl);
    this.ws = ws;
    this.mode = "ws";
    let opened = false;
    ws.onopen = () => {
      if (this.ws !== ws) {
        return;
      }
      opened = true;
      this.failures = 0;
      this.onOpen();
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) {
        this.receive(ev.data);
      }
    };
    ws.onerror = () => {
    };
    ws.onclose = () => {
      if (this.ws !== ws) {
        return;
      }
      this.ws = null;
      this.open = false;
      if (this.closed) {
        return;
      }
      if (!opened) {
        this.failures += 1;
      }
      this.scheduleReconnect();
    };
  }

  private connectSse(): void {
    const Es = this.opts.EventSource!;
    const es = new Es(this.opts.sseUrl, { withCredentials: true });
    this.es = es;
    this.mode = "sse";
    es.onopen = () => {
      if (this.es === es) {
        this.onOpen();
      }
    };
    es.onmessage = (ev) => {
      if (this.es === es) {
        this.receive(ev.data);
      }
    };
    es.onerror = () => {
      if (this.es !== es) {
        return;
      }
      this.open = false;
      if (this.closed) {
        return;
      }
      if (es.readyState === ES_CLOSED) {
        if (this.timer === null) {
          this.timer = (this.opts.setTimeout ?? setTimeout)(() => {
            this.timer = null;
            if (this.es === es) {
              this.expire();
            }
          }, ES_EXPIRE_DELAY_MS);
        }
        return;
      }
      this.status("reconnecting");
    };
  }

  private onOpen(): void {
    this.open = true;
    this.attempt = 0;
    this.status("open");
    if (this.mode === "ws" || this.session !== null) {
      this.flush();
    }
  }

  private flush(): void {
    while (this.open && this.queue.length > 0) {
      this.transmit(this.queue.shift()!);
    }
  }

  private transmit(msg: ClientMessage): void {
    if (this.mode === "ws" && this.ws) {
      this.ws.send(encode(msg));
      return;
    }
    if (this.mode === "sse") {
      if (this.session === null) {
        this.queue.push(msg);
        return;
      }
      const fetchFn = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-weft-session": this.session,
        ...(this.opts.headers?.() ?? {}),
      };
      void fetchFn(this.opts.postUrl, {
        method: "POST",
        headers,
        body: encode(msg),
        credentials: "same-origin",
      }).catch(() => {
        this.queue.push(msg.t === "event" ? { ...msg, queued: true } : msg);
        this.queue.sort((x, y) => (x.t === "event" && y.t === "event" ? x.seq - y.seq : 0));
      });
    }
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }
    const msg = decodeServerMessage(data);
    if (!msg) {
      return;
    }
    if (msg.t === "hello") {
      this.session = msg.session;
      this.flush();
    }
    if (msg.t === "expired") {
      this.expire();
      return;
    }
    this.opts.onMessage(msg);
  }

  private expire(): void {
    if (this.closed) {
      return;
    }
    this.queue.length = 0;
    this.close();
    this.opts.onMessage({ t: "expired" });
  }

  private scheduleReconnect(): void {
    this.status("reconnecting");
    const base = this.opts.baseDelayMs ?? 250;
    const max = this.opts.maxDelayMs ?? 15_000;
    const random = this.opts.random ?? Math.random;
    const exp = Math.min(max, base * 2 ** this.attempt);
    const delay = Math.floor(exp / 2 + (random() * exp) / 2);
    this.attempt += 1;
    const set = this.opts.setTimeout ?? setTimeout;
    this.timer = set(() => {
      this.timer = null;
      if (!this.closed && !this.suspended && !this.offlineNow) {
        this.connect();
      }
    }, delay);
  }
}

export function endpointsFor(
  location: { protocol: string; host: string },
  opts: { lid?: string; path?: string } = {},
): { wsUrl: string; sseUrl: string; postUrl: string } {
  const path = opts.path ?? "/_weft/live";
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const q = opts.lid ? `?lid=${encodeURIComponent(opts.lid)}` : "";
  return {
    wsUrl: `${wsProto}//${location.host}${path}${q}`,
    sseUrl: `${path}/sse${q}`,
    postUrl: `${path}/event`,
  };
}
