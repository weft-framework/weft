import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { createApp, type AppSocket } from "../src/app.ts";
import { serveNode } from "../src/node.ts";

const SECRET = "sockets-test-secret-0123456789abcdef";

function opened(url: string, origin: string | null): Promise<{ ws: WebSocket; got: string[] }> {
  const ws = new (WebSocket as unknown as new (u: string, o: unknown) => WebSocket)(url, origin ? { headers: { origin } } : {});
  const got: string[] = [];
  ws.addEventListener("message", (e) => got.push(String((e as MessageEvent).data)));
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ ws, got }));
    ws.addEventListener("error", () => reject(new Error("refused")));
  });
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok());
};

function rawUpgrade(port: number, path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    let out = "";
    sock.on("data", (b) => (out += b.toString("latin1")));
    sock.on("end", () => resolve(out));
    sock.on("error", reject);
    const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade"];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    sock.write(lines.join("\r\n") + "\r\n\r\n");
  });
}

test("apps declare websocket routes; the node adapter upgrades them with the request context", async () => {
  const events: string[] = [];
  const errors: unknown[] = [];
  const app = createApp({
    secret: SECRET,
    routes: {},
    onError: (e) => errors.push(e),
    sockets: {
      "/ws/echo/[room]": {
        open(ws: AppSocket, ctx) {
          events.push(`open ${ctx.params.room} ${ctx.query.get("q")}`);
          ws.send(`hello ${ctx.params.room}`);
        },
        async message(ws, data) {
          await new Promise((r) => setTimeout(r, 5));
          if (data === "boom") throw new Error("handler failed");
          ws.send(typeof data === "string" ? `echo ${data}` : `bytes ${data.byteLength}`);
        },
        close(_ws, code) {
          events.push(`close ${code}`);
        },
        maxBytes: 64,
      },
    },
  });
  const server = await serveNode(app, { port: 0 });
  const base = server.url.replace("http", "ws");
  try {
    const { ws, got } = await opened(`${base}/ws/echo/lobby?q=1`, server.url);
    ws.send("a");
    ws.send("b");
    ws.send(new Uint8Array([1, 2, 3]));
    ws.send("x".repeat(70_000).slice(0, 40));
    await until(() => got.length === 5);
    assert.deepEqual(got, ["hello lobby", "echo a", "echo b", "bytes 3", "echo " + "x".repeat(40)]);
    ws.close(4000);
    await until(() => events.length === 2);
    assert.deepEqual(events, ["open lobby 1", "close 4000"]);

    const big = await opened(`${base}/ws/echo/big`, server.url);
    const bigClosed = new Promise<number>((r) => big.ws.addEventListener("close", (e) => r((e as CloseEvent).code)));
    big.ws.send("y".repeat(100));
    assert.equal(await bigClosed, 1009);

    const failing = await opened(`${base}/ws/echo/err`, server.url);
    const failClosed = new Promise<number>((r) => failing.ws.addEventListener("close", (e) => r((e as CloseEvent).code)));
    failing.ws.send("boom");
    assert.equal(await failClosed, 1011);
    await until(() => errors.length === 1);
    assert.match(String(errors[0]), /handler failed/);

    await assert.rejects(opened(`${base}/ws/echo/x`, "https://evil.test"));
    await assert.rejects(opened(`${base}/ws/nope`, server.url));
    const port = Number(new URL(server.url).port);
    const noKey = await rawUpgrade(port, "/ws/echo/x", { Origin: server.url, "Sec-WebSocket-Version": "13" });
    assert.match(noKey, /^HTTP\/1\.1 400 /);
    const cross = await rawUpgrade(port, "/ws/echo/x", {
      Origin: "https://evil.test",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    });
    assert.match(cross, /^HTTP\/1\.1 403 /);
  } finally {
    await server.close();
  }
});

test("socket routes are checked when the app is created", () => {
  assert.throws(() => createApp({ secret: SECRET, routes: {}, sockets: { "/ws": { open: 1 as never } } }), /open is a function/);
  assert.throws(() => createApp({ secret: SECRET, routes: {}, sockets: { "/ws": { maxBytes: 0 } } }), /maxBytes/);
});
