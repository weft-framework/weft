import type { Change, ChangeFeed } from "./changes.ts";

export interface Broadcast {
  publish(message: string): unknown;
  subscribe(onMessage: (message: string) => void): (() => void) | void;
  onGap?(fn: () => void): (() => void) | void;
}

export interface BridgeOptions {
  origin?: string;
  onError?(err: unknown): void;
  channelRegion?: string;
  region?: string;
}

function redact(change: Change): Change {
  return { model: change.model, op: change.op, key: undefined, redacted: true };
}

function mayCross(change: Change, region: string | undefined): boolean {
  const r = change.regions;
  return r === undefined || r.length === 0 || (region !== undefined && r.every((x) => x === region));
}

const DATE = "$weft:date";

function encode(origin: string, seq: number, change: Change): string {
  return JSON.stringify({ v: 1, origin, s: seq, change }, function (this: Record<string, unknown>, key, value) {
    const raw = this[key];
    return raw instanceof Date ? { [DATE]: raw.toISOString() } : value;
  });
}

function decode(message: string): { origin: string; seq: number | null; change: Change } | null {
  const msg = JSON.parse(message, (_key, value) =>
    value !== null && typeof value === "object" && Object.keys(value).length === 1 && typeof value[DATE] === "string"
      ? new Date(value[DATE])
      : value,
  ) as { v?: unknown; origin?: unknown; s?: unknown; change?: Change };
  const c = msg?.change;
  if (msg?.v !== 1 || typeof msg.origin !== "string" || !c || typeof c.model !== "string" || typeof c.op !== "string") {
    return null;
  }
  const seq = Number.isSafeInteger(msg.s) && (msg.s as number) > 0 ? (msg.s as number) : null;
  return { origin: msg.origin, seq, change: c };
}

export function bridgeChanges(feed: ChangeFeed, channel: Broadcast, opts: BridgeOptions = {}): () => void {
  const origin = opts.origin ?? crypto.randomUUID();
  for (const r of [opts.channelRegion, opts.region]) {
    if (r !== undefined && !(typeof r === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(r))) {
      throw new Error("@weft-framework/data: change bridge: a region is a name like `eu` or `us-east`");
    }
  }
  const report = opts.onError ?? ((err: unknown) => console.error("@weft-framework/data: change bridge:", err));
  const relayed = new WeakSet<Change>();
  let sent = 0;
  const heard = new Map<string, number>();
  const MAX_ORIGINS = 1024;
  const off = feed.subscribe((change) => {
    if (relayed.has(change)) {
      return;
    }
    try {
      sent += 1;
      const out = channel.publish(encode(origin, sent, mayCross(change, opts.channelRegion) ? change : redact(change)));
      if (out instanceof Promise) {
        out.catch(report);
      }
    } catch (err) {
      report(err);
    }
  });
  const unsubscribe = channel.subscribe((message) => {
    let msg: ReturnType<typeof decode>;
    try {
      msg = decode(message);
    } catch (err) {
      report(err);
      return;
    }
    if (!msg) {
      report(new Error("@weft-framework/data: change bridge: unexpected message"));
      return;
    }
    if (msg.origin === origin) {
      return;
    }
    if (msg.seq !== null) {
      const last = heard.get(msg.origin);
      heard.delete(msg.origin);
      heard.set(msg.origin, last === undefined ? msg.seq : Math.max(last, msg.seq));
      if (heard.size > MAX_ORIGINS) {
        heard.delete(heard.keys().next().value as string);
      }
      if (last !== undefined && msg.seq > last + 1) {
        feed.gap();
      }
    }
    let change = msg.change;
    if (change.redacted === true) {
      change = redact(change);
    } else if (opts.region !== undefined && !mayCross(change, opts.region)) {
      report(new Error(`@weft-framework/data: change bridge: refused rows of ${change.model} resident in ${change.regions!.join(", ")}`));
      change = redact(change);
    }
    relayed.add(change);
    feed.publish(change);
  });
  const unGap = channel.onGap?.(() => {
    heard.clear();
    feed.gap();
  });
  return () => {
    off();
    unsubscribe?.();
    unGap?.();
  };
}

export function broadcastChannel(name: string): Broadcast & { close(): void } {
  const Ctor = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (!Ctor) {
    throw new Error("@weft-framework/data: this runtime has no BroadcastChannel");
  }
  const ch = new Ctor(name);
  (ch as { unref?(): void }).unref?.();
  const listeners = new Set<(m: string) => void>();
  ch.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === "string") {
      for (const l of listeners) {
        l(ev.data);
      }
    }
  };
  return {
    publish: (m) => ch.postMessage(m),
    subscribe(on) {
      listeners.add(on);
      return () => listeners.delete(on);
    },
    close: () => ch.close(),
  };
}

export class LocalBroadcast {
  private readonly listeners = new Set<(m: string) => void>();

  channel(): Broadcast {
    return {
      publish: (m) => {
        queueMicrotask(() => {
          for (const l of [...this.listeners]) {
            l(m);
          }
        });
      },
      subscribe: (on) => {
        this.listeners.add(on);
        return () => this.listeners.delete(on);
      },
    };
  }
}
