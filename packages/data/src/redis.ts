import { connect as tcp, type Socket } from "node:net";
import { connect as tls } from "node:tls";
import type { Broadcast } from "./bridge.ts";

export interface RedisBroadcastOptions {
  url?: string;
  channel?: string;
  maxQueue?: number;
  retryMs?: { min: number; max: number };
  onError?(err: unknown): void;
}

export interface RedisBroadcast extends Broadcast {
  onGap(fn: () => void): () => void;
  ready(): Promise<void>;
  close(): void;
}

type Value = string | number | null | Error | Value[];

export function respCommand(args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.from(a, "utf8");
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

export function respParse(buf: Buffer, i = 0): [Value, number] | null {
  const eol = buf.indexOf("\r\n", i);
  if (eol < 0 || eol === i) return null;
  const type = String.fromCharCode(buf[i]);
  const line = buf.toString("utf8", i + 1, eol);
  const after = eol + 2;
  switch (type) {
    case "+":
      return [line, after];
    case "-":
      return [new Error(line), after];
    case ":":
      return [Number(line), after];
    case "$": {
      const n = Number(line);
      if (n < 0) return [null, after];
      if (!Number.isSafeInteger(n)) throw new Error(`redis: bad bulk length ${line}`);
      if (buf.length < after + n + 2) return null;
      return [buf.toString("utf8", after, after + n), after + n + 2];
    }
    case "*": {
      const n = Number(line);
      if (n < 0) return [null, after];
      if (!Number.isSafeInteger(n)) throw new Error(`redis: bad array length ${line}`);
      const out: Value[] = [];
      let at = after;
      for (let k = 0; k < n; k++) {
        const got = respParse(buf, at);
        if (!got) return null;
        out.push(got[0]);
        at = got[1];
      }
      return [out, at];
    }
    default:
      throw new Error(`redis: unexpected reply type ${JSON.stringify(type)}`);
  }
}

interface Target {
  secure: boolean;
  host: string;
  port: number;
  auth: string[] | null;
}

function target(url: string): Target {
  const u = new URL(url);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") {
    throw new Error(`redis: unsupported URL scheme ${u.protocol}`);
  }
  const pass = decodeURIComponent(u.password);
  const user = decodeURIComponent(u.username);
  return {
    secure: u.protocol === "rediss:",
    host: u.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1",
    port: u.port ? Number(u.port) : 6379,
    auth: pass ? (user ? ["AUTH", user, pass] : ["AUTH", pass]) : null,
  };
}

class Conn {
  private sock: Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private delay: number;
  private closed = false;
  up = false;
  private readonly t: Target;
  private readonly retry: { min: number; max: number };
  private readonly onUp: () => void;
  private readonly onValue: (v: Value) => void;
  private readonly report: (err: unknown) => void;

  constructor(
    t: Target,
    retry: { min: number; max: number },
    onUp: () => void,
    onValue: (v: Value) => void,
    report: (err: unknown) => void,
  ) {
    this.t = t;
    this.retry = retry;
    this.onUp = onUp;
    this.onValue = onValue;
    this.report = report;
    this.delay = retry.min;
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const opts = { host: this.t.host, port: this.t.port };
    const sock = this.t.secure ? tls({ ...opts, servername: this.t.host }) : tcp(opts);
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    sock.setNoDelay(true);
    sock.once(this.t.secure ? "secureConnect" : "connect", () => {
      this.delay = this.retry.min;
      if (this.t.auth) sock.write(respCommand(this.t.auth));
      this.up = true;
      this.onUp();
    });
    sock.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      try {
        let at = 0;
        for (;;) {
          const got = respParse(this.buf, at);
          if (!got) break;
          at = got[1];
          this.onValue(got[0]);
        }
        this.buf = this.buf.subarray(at);
      } catch (err) {
        this.report(err);
        sock.destroy();
      }
    });
    sock.on("error", (err) => this.report(err));
    sock.on("close", () => {
      this.up = false;
      this.sock = null;
      if (this.closed) return;
      const wait = this.delay;
      this.delay = Math.min(this.delay * 2, this.retry.max);
      setTimeout(() => this.open(), wait).unref?.();
    });
    sock.unref?.();
  }

  write(cmd: Buffer): void {
    this.sock?.write(cmd);
  }

  close(): void {
    this.closed = true;
    this.sock?.destroy();
  }
}

export function redisBroadcast(opts: RedisBroadcastOptions = {}): RedisBroadcast {
  const t = target(opts.url ?? "redis://127.0.0.1:6379");
  const channel = opts.channel ?? "weft-changes";
  const maxQueue = opts.maxQueue ?? 10_000;
  const retry = opts.retryMs ?? { min: 100, max: 5000 };
  const report = opts.onError ?? ((err: unknown) => console.error("@weft/data: redis:", err));
  const listeners = new Set<(m: string) => void>();
  const gaps = new Set<() => void>();
  const queue: Buffer[] = [];
  let subscribedOnce = false;
  let subscribed = false;
  let waiting: (() => void)[] = [];

  const settle = () => {
    if (pub.up && subscribed) {
      const w = waiting;
      waiting = [];
      for (const fn of w) fn();
    }
  };

  const pub: Conn = new Conn(
    t,
    retry,
    () => {
      for (const cmd of queue.splice(0)) pub.write(cmd);
      settle();
    },
    (v) => {
      if (v instanceof Error) report(v);
    },
    report,
  );
  const sub: Conn = new Conn(
    t,
    retry,
    () => {
      subscribed = false;
      sub.write(respCommand(["SUBSCRIBE", channel]));
    },
    (v) => {
      if (v instanceof Error) {
        report(v);
        return;
      }
      if (!Array.isArray(v) || typeof v[0] !== "string") return;
      if (v[0] === "message" && v[1] === channel && typeof v[2] === "string") {
        for (const l of [...listeners]) l(v[2]);
      } else if (v[0] === "subscribe" && v[1] === channel) {
        subscribed = true;
        if (subscribedOnce) {
          for (const g of [...gaps]) g();
        }
        subscribedOnce = true;
        settle();
      }
    },
    report,
  );

  return {
    publish(message: string): void {
      const cmd = respCommand(["PUBLISH", channel, message]);
      if (pub.up) {
        pub.write(cmd);
        return;
      }
      queue.push(cmd);
      if (queue.length > maxQueue) queue.shift();
    },
    subscribe(on) {
      listeners.add(on);
      return () => {
        listeners.delete(on);
      };
    },
    onGap(fn) {
      gaps.add(fn);
      return () => {
        gaps.delete(fn);
      };
    },
    ready() {
      return new Promise<void>((resolve) => {
        waiting.push(resolve);
        settle();
      });
    },
    close() {
      pub.close();
      sub.close();
    },
  };
}
