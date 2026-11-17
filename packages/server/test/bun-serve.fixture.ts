import { defineComponent, escapeHtml, signal } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";
import { serveBun } from "../src/bun.ts";

const Counter = defineComponent("Counter", (_props: Record<string, never>) => {
  const count = signal(0);
  return {
    handlers: {
      inc() {
        count.value = count.value + 1;
      },
    },
    render: () => `<button data-weft-on-click="inc">${escapeHtml(count.value)}</button>`,
  };
});

const timer = setTimeout(() => {
  console.error("timed out");
  process.exit(2);
}, 10_000);

const app = createApp({
  secret: "bun-secret-bun-secret-bun-secret-bun!",
  routes: { "/": { component: Counter } },
  transports: ["ws", "sse"],
});
const server = serveBun(app, { port: 0 });
const base = new URL(server.url);
const res = await fetch(base);
const html = await res.text();
const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
const lid = /name="weft-live" content="([^"]+)"/.exec(html)?.[1];
if (!lid) {
  throw new Error("no live page id");
}
const ws = new WebSocket(`ws://${base.host}/_weft/live?lid=${lid}`, {
  headers: { cookie, origin: base.origin },
} as never);
const seen: string[] = [];
await new Promise<void>((resolve, reject) => {
  ws.onerror = () => reject(new Error("websocket error"));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.t === "hello") {
      seen.push("hello");
      ws.send(JSON.stringify({ t: "event", id: "r", handler: "inc", event: { type: "click" }, seq: 1 }));
    } else if (msg.t === "patch") {
      seen.push(`patch:${/>(\d+)</.exec(msg.html)?.[1]}`);
      resolve();
    }
  };
});
ws.close();
await server.close();
app.close();
clearTimeout(timer);
console.log(`ok ${seen.join(" ")}`);
