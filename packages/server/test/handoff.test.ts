import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml, signal } from "@weft/runtime";
import { createApp, type App } from "../src/app.ts";
import { LivePage } from "../src/live.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

function makeApp(opts: { secret?: string; now?: () => number; signals?: number } = {}) {
  const Counter = defineComponent("Counter", (p: { label: string }) => {
    const n = signal(0);
    const tags = signal<string[]>([]);
    const when = signal(new Date(0));
    for (let i = 2; i < (opts.signals ?? 3); i++) signal(i);
    return {
      handlers: {
        inc: () => {
          n.value += 1;
          tags.value = [...tags.value, `t${n.value}`];
          when.value = new Date(1);
        },
      },
      render: () =>
        `<p>${escapeHtml(p.label)} <b id="n">${n.value}</b> <i>${escapeHtml(tags.value.join(","))}</i> ` +
        `<s>${when.value.getTime()}</s></p><button data-weft-on-click="inc">+</button>`,
    };
  });
  const Page = defineComponent("Page", () => ({
    render: () => `<main>${Counter({ label: "a" })}</main>`,
  }));
  return createApp({
    secret: opts.secret ?? SECRET,
    ...(opts.now ? { now: opts.now } : {}),
    onError: (e) => {
      throw e;
    },
    routes: { "/": { component: Page as never }, "/other": { component: Page as never } },
  });
}

async function open(app: App, cookie?: string) {
  const res = await app.fetch(new Request(ORIGIN + "/", cookie ? { headers: { cookie } } : {}));
  const html = await res!.text();
  cookie ??= (res!.headers.get("set-cookie") ?? "").split(";")[0]!;
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "";
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";
  const childId = /data-weft-c="(r\.\d+)"/.exec(html)?.[1] ?? "";
  const sse = await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } }));
  const reader = sse!.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const next = async (ms = 500): Promise<Record<string, unknown> | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const m = /data: (.*)\n\n/.exec(buf);
      if (m) {
        buf = buf.slice(m.index + m[0].length);
        return JSON.parse(m[1]!);
      }
      pending ??= reader.read();
      const left = deadline - Date.now();
      const got = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, left)))]);
      if (got === null) return null;
      pending = null;
      if (got.done) return null;
      buf += dec.decode(got.value);
    }
  };
  const hello = await next();
  assert.equal(hello?.t, "hello");
  const headers = { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": String(hello?.session) };
  let seq = 0;
  const click = async () => {
    const r = await app.fetch(
      new Request(`${ORIGIN}/_weft/live/event`, {
        method: "POST",
        headers,
        body: JSON.stringify({ t: "event", id: childId, handler: "inc", event: { type: "click" }, seq: ++seq }),
      }),
    );
    assert.equal(r!.status, 204);
    for (let m = await next(200); m; m = await next(200)) if (m.t === "patch" || m.t === "ack") break;
  };
  return { cookie, next, click, close: () => reader.cancel().catch(() => {}) };
}

const resume = (app: App, cookie: string, handoff: string, path = "/") =>
  app.fetch(new Request(ORIGIN + path, { headers: { cookie, "x-weft-nav": "1", "x-weft-handoff": handoff } }));

async function drained(old: App) {
  const p = await open(old);
  await p.click();
  await p.click();
  const draining = old.drain();
  let expired: Record<string, unknown> | null = null;
  for (let m = await p.next(); m; m = await p.next()) if (m.t === "expired") expired = m;
  await draining;
  await p.close();
  return { cookie: p.cookie, expired };
}

test("a drained page's server state comes back on the next version", async () => {
  const old = makeApp();
  const { cookie, expired } = await drained(old);
  assert.equal(typeof expired?.handoff, "string", "the expiry carries the sealed state");
  const token = String(expired!.handoff);
  assert.equal(token.includes("t1"), false);
  assert.equal(Buffer.from(token, "base64url").toString("latin1").includes("t1,t2"), false, "the browser cannot read it");
  old.close();

  const next = makeApp();
  const html = await (await resume(next, cookie, token))!.text();
  assert.match(html, /<b id="n">2<\/b>/, "the count carried over");
  assert.match(html, /<i>t1,t2<\/i>/, "plain data carried over");
  assert.match(html, /<s>0<\/s>/, "a Date is not plain data: it starts fresh");
  assert.match(await (await next.fetch(new Request(ORIGIN + "/", { headers: { cookie } })))!.text(), /<b id="n">0<\/b>/);
  next.close();
});

test("the handoff holds only for its session, its URL, its secret and its time", async () => {
  let t = Date.now();
  const old = makeApp({ now: () => t });
  const { cookie, expired } = await drained(old);
  const token = String(expired!.handoff);
  old.close();

  const fresh = /<b id="n">0<\/b>/;
  const other = makeApp({ now: () => t });
  const stranger = (await other.fetch(new Request(ORIGIN + "/")))!.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(await (await resume(other, stranger, token))!.text(), fresh, "another session");
  assert.match(await (await resume(other, cookie, token, "/other"))!.text(), fresh, "another URL");
  const flipped = token.slice(0, 20) + (token[20] === "A" ? "B" : "A") + token.slice(21);
  assert.match(await (await resume(other, cookie, flipped))!.text(), fresh, "a changed token");
  assert.match(await (await resume(other, cookie, "not a token!"))!.text(), fresh, "garbage");
  const rekeyed = makeApp({ secret: "another-secret-another-secret-another!" });
  assert.match(await (await resume(rekeyed, cookie, token))!.text(), fresh, "another secret");
  t += 6 * 60_000;
  assert.match(await (await resume(other, cookie, token))!.text(), fresh, "too old");
  other.close();
  rekeyed.close();
});

test("a component that changed shape starts fresh; drain can skip the handoff", async () => {
  const old = makeApp();
  const { cookie, expired } = await drained(old);
  old.close();
  const changed = makeApp({ signals: 4 });
  assert.match(await (await resume(changed, cookie, String(expired!.handoff)))!.text(), /<b id="n">0<\/b>/);
  changed.close();

  const quiet = makeApp();
  const p = await open(quiet);
  await p.click();
  const draining = quiet.drain({ handoff: false });
  let got: Record<string, unknown> | null = null;
  for (let m = await p.next(); m; m = await p.next()) if (m.t === "expired") got = m;
  await draining;
  assert.deepEqual(got, { t: "expired" });
  await p.close();
  quiet.close();
});

test("LivePage snapshot and restore by tree path, kind-checked", () => {
  const C = defineComponent("C", () => {
    const a = signal(1);
    const b = signal<string | null>(null);
    const c = signal({ x: 1 });
    return {
      handlers: {
        set: () => {
          a.value = 5;
          b.value = "hi";
          c.value = { x: 9 };
        },
      },
      render: () => `${a.value}|${b.value}|${c.value.x}`,
    };
  });
  const P = defineComponent("P", () => ({ render: () => C({}) }));
  const page = new LivePage(P as never, {});
  page.render();
  assert.deepEqual(page.snapshot(), [["r/C:0", "C", 3, [[0, 1], [1, null], [2, { x: 1 }]]]]);
  const restored = new LivePage(P as never, {}, { restore: [["r/C:0", "C", 3, [[0, 7], [1, "yo"], [2, { x: 2 }]]]] });
  assert.match(restored.render(), /7\|yo\|2/);
  const wrong = new LivePage(P as never, {}, { restore: [["r/C:0", "C", 3, [[0, "seven"], [2, [1]]]]] });
  assert.match(wrong.render(), /1\|null\|1/);
  page.close();
  restored.close();
  wrong.close();
});
