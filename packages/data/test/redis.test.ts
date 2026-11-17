import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { bridgeChanges, ChangeFeed, type Broadcast, type Change } from "../src/index.ts";
import { redisBroadcast, respCommand, respParse } from "../src/redis.ts";

function fakeRedis(password: string | null = null) {
  const subs = new Map<string, Set<Socket>>();
  const socks = new Set<Socket>();
  const server: Server = createServer((sock) => {
    socks.add(sock);
    let authed = password === null;
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const got = respParse(buf);
        if (!got) break;
        buf = buf.subarray(got[1]);
        const [cmd, ...args] = got[0] as string[];
        const name = cmd.toUpperCase();
        if (name === "AUTH") {
          authed = args[args.length - 1] === password;
          sock.write(authed ? "+OK\r\n" : "-WRONGPASS invalid username-password pair\r\n");
        } else if (!authed) {
          sock.write("-NOAUTH Authentication required.\r\n");
        } else if (name === "SUBSCRIBE") {
          let set = subs.get(args[0]);
          if (!set) subs.set(args[0], (set = new Set()));
          set.add(sock);
          sock.write(respCommand(["subscribe", args[0], "1"]));
        } else if (name === "PUBLISH") {
          const set = subs.get(args[0]) ?? new Set();
          for (const s of set) s.write(respCommand(["message", args[0], args[1]]));
          sock.write(`:${set.size}\r\n`);
        } else {
          sock.write(`-ERR unknown command '${cmd}'\r\n`);
        }
      }
    });
    sock.on("close", () => {
      socks.delete(sock);
      for (const set of subs.values()) set.delete(sock);
    });
    sock.on("error", () => {});
  });
  return new Promise<{ url: (auth?: string) => string; drop(): void; close(): void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: (auth = "") => `redis://${auth}127.0.0.1:${port}`,
        drop: () => {
          for (const s of socks) s.destroy();
        },
        close: () => {
          for (const s of socks) s.destroy();
          server.close();
        },
      });
    });
  });
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const change = (id: string): Change =>
  ({ model: "Note", op: "create", key: id, after: { id, at: new Date(0), text: "héllo ✓" } }) as unknown as Change;

test("RESP framing: lengths in bytes, partial input waits", () => {
  const cmd = respCommand(["PUBLISH", "c", "✓"]);
  assert.equal(cmd.toString(), "*3\r\n$7\r\nPUBLISH\r\n$1\r\nc\r\n$3\r\n✓\r\n");
  assert.deepEqual(respParse(cmd)?.[0], ["PUBLISH", "c", "✓"]);
  for (let n = 0; n < cmd.length; n++) assert.equal(respParse(cmd.subarray(0, n)), null, `prefix ${n}`);
  assert.deepEqual(respParse(Buffer.from(":42\r\n")), [42, 5]);
  assert.deepEqual(respParse(Buffer.from("$-1\r\n")), [null, 5]);
  assert.ok((respParse(Buffer.from("-ERR x\r\n"))?.[0] as Error).message === "ERR x");
  assert.throws(() => respParse(Buffer.from("?x\r\n")), /unexpected reply type/);
});

test("changes relay between instances through Redis, and a reconnect is a gap", async () => {
  const redis = await fakeRedis("s3cret");
  const errors: unknown[] = [];
  const opts = { url: redis.url(":s3cret@"), retryMs: { min: 10, max: 20 }, onError: (e: unknown) => errors.push(e) };
  const ra = redisBroadcast(opts);
  const rb = redisBroadcast(opts);
  const a = new ChangeFeed();
  const b = new ChangeFeed();
  bridgeChanges(a, ra);
  bridgeChanges(b, rb);
  const got: Change[] = [];
  let gaps = 0;
  b.subscribe((c) => got.push(c));
  b.onGap(() => gaps++);
  await Promise.all([ra.ready(), rb.ready()]);

  a.publish(change("1"));
  await until(() => got.length === 1);
  assert.ok((got[0].after as { at: Date }).at instanceof Date, "dates survive");
  assert.equal((got[0].after as { text: string }).text, "héllo ✓");
  assert.equal(gaps, 0);

  redis.drop();
  await until(() => gaps === 1);
  await Promise.all([ra.ready(), rb.ready()]);
  a.publish(change("2"));
  await until(() => got.length === 2);
  assert.equal(got[1].key, "2");

  ra.close();
  rb.close();
  redis.close();
  assert.ok(errors.every((e) => !/WRONGPASS|NOAUTH/.test(String(e))), String(errors));
});

test("a wrong password is reported", async () => {
  const redis = await fakeRedis("s3cret");
  const errors: unknown[] = [];
  const r = redisBroadcast({ url: redis.url(":nope@"), retryMs: { min: 10, max: 20 }, onError: (e) => errors.push(e) });
  await until(() => errors.some((e) => /WRONGPASS/.test(String(e))));
  r.close();
  redis.close();
  assert.throws(() => redisBroadcast({ url: "http://x" }), /unsupported URL scheme/);
});

test("a skipped message number raises a gap; a channel can report one too", async () => {
  const listeners = new Set<(m: string) => void>();
  let n = 0;
  let gapFn: (() => void) | null = null;
  const lossy = (drop: boolean): Broadcast => ({
    publish: (m) => {
      n++;
      if (drop && n === 2) return;
      for (const l of listeners) l(m);
    },
    subscribe: (on) => {
      listeners.add(on);
      return () => listeners.delete(on);
    },
    onGap: (fn) => {
      gapFn = fn;
    },
  });
  const a = new ChangeFeed();
  const b = new ChangeFeed();
  bridgeChanges(a, lossy(true));
  bridgeChanges(b, lossy(false));
  let gaps = 0;
  const got: string[] = [];
  b.onGap(() => gaps++);
  b.subscribe((c) => got.push(String(c.key)));
  a.publish(change("1"));
  a.publish(change("2"));
  assert.equal(gaps, 0);
  a.publish(change("3"));
  assert.deepEqual(got, ["1", "3"]);
  assert.equal(gaps, 1, "3 after 1: something was missed");
  a.publish(change("4"));
  assert.equal(gaps, 1);
  (gapFn as unknown as () => void)();
  assert.equal(gaps, 2, "the channel's own report is a gap");
});
