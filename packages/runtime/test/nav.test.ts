import { test } from "node:test";
import assert from "node:assert/strict";
import { META_END, META_START, installNavigation, navigationUrl, parseLikely, sanitizeTree, splitDocument } from "../src/nav.ts";
import { h, serialize, type FElement } from "../testing/fakedom.ts";

function document(title: string, body: string, live = "L1"): string {
  return (
    `<!doctype html><html lang="en"><head>` +
    `${META_START}<title>${title}</title>${META_END}` +
    `<meta name="weft-live" content="${live}"><meta name="weft-csrf" content="tok">` +
    `</head><body>${body}</body></html>`
  );
}

function harness(pages: { url: string; html: string; type?: string; status?: number; finalUrl?: string; fail?: boolean }[]) {
  let href = "http://app.test/";
  let state: unknown = null;
  const historyLog: unknown[] = [];
  const morphed: string[] = [];
  const metas: { title: string; lang: string | null }[] = [];
  const reloads: string[] = [];
  const lives: string[] = [];
  const scrolls: unknown[] = [];
  const fetched: { url: string; prefetch: boolean }[] = [];
  const handoffs: (string | undefined)[] = [];
  const listeners = new Map<string, (ev: { target: unknown; button?: number; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; defaultPrevented?: boolean; preventDefault(): void }) => void>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const nav = installNavigation({
    current: () => new URL(href),
    async fetch(url, init) {
      fetched.push({ url, prefetch: init.headers["x-weft-prefetch"] === "1" });
      handoffs.push(init.headers["x-weft-handoff"]);
      const page = pages.shift();
      if (page?.fail) {
        throw new TypeError("network error");
      }
      const res = new Response(page?.html ?? "nope", {
        status: page?.status ?? (page ? 200 : 500),
        headers: { "content-type": page?.type ?? (page ? "text/html; charset=utf-8" : "text/plain") },
      });
      if (page?.finalUrl) {
        Object.defineProperty(res, "url", { value: page.finalUrl });
      }
      return res;
    },
    refreshHeaders: () => ({ "x-weft-handoff": "tok", accept: "text/plain" }),
    parse: (html) => h("div", {}, html),
    morph: (fragment) => morphed.push(serialize(fragment)),
    setMeta: (_meta, lang, title) => {
      metas.push({ title, lang });
      return true;
    },
    onPage: (page) => lives.push(page.live),
    reload: (url) => reloads.push(url),
    scroll: () => ({ x: 0, y: 40 }),
    scrollTo: (pos) => scrolls.push(pos),
    scrollToHash: (hash) => scrolls.push(hash),
    history: {
      get state() {
        return state;
      },
      pushState(data, _title, url) {
        state = data;
        if (url) {
          href = new URL(url, href).href;
        }
        historyLog.push(["push", url]);
      },
      replaceState(data, _title, url) {
        state = data;
        if (url) {
          href = new URL(url, href).href;
        }
        historyLog.push(["replace", url ?? ""]);
      },
      scrollRestoration: "auto",
    },
    listen(type, fn) {
      listeners.set(type, fn);
      return () => listeners.delete(type);
    },
    now: () => 5_000,
    setTimeout(fn) {
      const id = ++timerId;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
  });
  return { nav, listeners, fetched, handoffs, morphed, metas, reloads, lives, scrolls, historyLog, timers, href: () => href, state: () => state };
}

function click(el: FElement, extra: { metaKey?: boolean; button?: number } = {}) {
  let prevented = false;
  return {
    target: el,
    button: extra.button ?? 0,
    metaKey: extra.metaKey,
    preventDefault() {
      prevented = true;
    },
    get prevented() {
      return prevented;
    },
  };
}

test("splitDocument reads the meta block and refuses a page without one", () => {
  const page = splitDocument(document("Hello &amp; co", "<p>Hi</p>", "live-9"));
  assert.ok(page);
  assert.equal(page?.title, "Hello & co");
  assert.equal(page?.body, "<p>Hi</p>");
  assert.equal(page?.live, "live-9");
  assert.equal(page?.lang, "en");
  assert.equal(splitDocument("<html><body><p>x</p></body></html>"), null);
  assert.equal(navigationUrl("javascript:alert(1)", new URL("https://app.test/")), null);
  assert.equal(navigationUrl("//evil.test/a", new URL("https://app.test/")), null);
  assert.equal(navigationUrl("/docs", new URL("https://app.test/x"))?.pathname, "/docs");
});

test("sanitizeTree drops scripts, inline handlers, and scriptable URLs", () => {
  const root = h(
    "div",
    {},
    h("script", {}, "alert(1)"),
    h("a", { href: "javascript:alert(1)", onclick: "nope" }, "go"),
    h("img", { src: "data:image/gif;base64,AAAA" }),
    h("base", { href: "https://evil.test/" }),
  );
  sanitizeTree(root);
  const html = serialize(root);
  assert.equal(html.includes("script"), false);
  assert.equal(html.includes("onclick"), false);
  assert.equal(html.includes("evil.test"), false);
  assert.ok(html.includes('href="#"'), html);
  assert.ok(html.includes("data:image/gif"), html);
});

test("same-origin clicks morph the body, update the title, and restore scroll", async () => {
  const env = harness([
    { url: "/about", html: document("About", "<p>About</p>", "L2") },
    { url: "/", html: document("Home", "<p>Home</p>", "L3") },
  ]);
  const anchor = h("a", { href: "/about" }, "About");
  const event = click(anchor);
  env.listeners.get("click")?.(event);
  assert.equal(event.prevented, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(env.metas.at(-1)?.title, "About");
  assert.deepEqual(env.lives, ["L2"]);
  assert.ok(env.morphed.at(-1)?.includes("<p>About</p>"));
  assert.equal(env.href(), "http://app.test/about");
  assert.deepEqual(env.scrolls.at(-1), { x: 0, y: 0 });
  assert.equal((env.state() as { y: number }).y, 0);
  const saved = env.historyLog.some((entry) => Array.isArray(entry) && entry[0] === "replace");
  assert.equal(saved, true);
});

test("modified, external, and script URLs are not boosted; a non-html response reloads", async () => {
  const env = harness([{ url: "/file", html: "binary", type: "application/octet-stream" }]);
  const plain = click(h("a", { href: "https://other.test/x" }));
  env.listeners.get("click")?.(plain);
  assert.equal(plain.prevented, false);

  const modified = click(h("a", { href: "/about" }), { metaKey: true });
  env.listeners.get("click")?.(modified);
  assert.equal(modified.prevented, false);

  const blank = click(h("a", { href: "/about", target: "_blank" }));
  env.listeners.get("click")?.(blank);
  assert.equal(blank.prevented, false);

  const script = click(h("a", { href: " javascript:alert(1)" }));
  env.listeners.get("click")?.(script);
  assert.equal(script.prevented, true);
  assert.equal(env.fetched.length, 0);

  assert.equal(await env.nav.go("/file"), false);
  assert.deepEqual(env.reloads, ["http://app.test/file"]);
  assert.equal(env.morphed.length, 0);
});

test("hover prefetches a page and the following click reuses it", async () => {
  const env = harness([{ url: "/docs", html: document("Docs", "<p>Docs</p>", "L9") }]);
  const anchor = h("a", { href: "/docs" });
  env.listeners.get("mouseover")?.(click(anchor));
  const timer = env.timers.values().next().value;
  timer?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(env.fetched.length, 1);
  assert.equal(env.fetched[0]?.prefetch, true);
  assert.equal(await env.nav.go("/docs"), true);
  assert.equal(env.fetched.length, 1);
  assert.equal(env.metas.at(-1)?.title, "Docs");
  assert.deepEqual(env.lives, ["L9"]);
});

test("refresh re-renders the current page in place and leaves history alone", async () => {
  const env = harness([
    { url: "/", html: "starting", status: 503 },
    { url: "/", html: "", fail: true },
    { url: "/", html: document("Home", "<p>Fresh</p>", "L7") },
  ]);
  assert.equal(await env.nav.go("/", "refresh"), false, "a 503 is retried, not loaded");
  assert.equal(await env.nav.go("/", "refresh"), false, "a network error is retried, not loaded");
  assert.deepEqual(env.reloads, []);
  assert.equal(await env.nav.go("/", "refresh"), true);
  assert.deepEqual(env.lives, ["L7"]);
  assert.ok(env.morphed.at(-1)?.includes("<p>Fresh</p>"));
  assert.deepEqual(env.historyLog.slice(1), [], "no history entry");
  assert.deepEqual(env.scrolls, [], "scroll kept");
});

test("only a refresh sends the resume headers, and they cannot replace the navigation ones", async () => {
  const env = harness([
    { url: "/a", html: document("A", "<p>A</p>", "L1") },
    { url: "/a", html: document("A", "<p>A</p>", "L2") },
  ]);
  assert.equal(await env.nav.go("/a"), true);
  assert.equal(await env.nav.go("/a", "refresh"), true);
  assert.deepEqual(env.handoffs, [undefined, "tok"]);
  assert.deepEqual(env.lives, ["L1", "L2"], "accept stayed text/html");
});

test("a refresh that the server redirects replaces the entry and scrolls up", async () => {
  const env = harness([{ url: "/", html: document("Login", "<p>Login</p>", "L8"), finalUrl: "http://app.test/login" }]);
  assert.equal(await env.nav.go("/", "refresh"), true);
  assert.equal(env.href(), "http://app.test/login");
  assert.deepEqual(env.historyLog.at(-1), ["replace", "/login"]);
  assert.deepEqual(env.scrolls, [{ x: 0, y: 0 }]);
});

test("splitDocument accepts a stateless page: a CSRF token but no live id", () => {
  const html =
    `<!doctype html><html lang="en"><head>${META_START}<title>S</title>${META_END}` +
    `<meta name="weft-csrf" content="tok"></head><body><p>s</p></body></html>`;
  const page = splitDocument(html);
  assert.ok(page);
  assert.equal(page.live, null);
  assert.equal(page.csrf, "tok");
  assert.equal(page.body, "<p>s</p>");
});

test("parseLikely keeps same-site paths only, at most five", () => {
  assert.deepEqual(parseLikely(null), []);
  assert.deepEqual(parseLikely(" /a  /b?x=1 //evil.test /\\evil https://x.test/ c "), ["/a", "/b?x=1"]);
  assert.equal(parseLikely("/1 /2 /3 /4 /5 /6 /7").length, 5);
});

test("likely next pages are prefetched a moment later, and a navigation cancels them", async () => {
  const env = harness([
    { url: "/a", html: document("A", "<p>A</p>") },
    { url: "/b", html: document("B", "<p>B</p>") },
  ]);
  env.nav.likely(["/", "/a", "/b"]);
  assert.equal(env.fetched.length, 0, "not at once");
  [...env.timers.values()].at(-1)?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(env.fetched.map((f) => [f.url.replace("http://app.test", ""), f.prefetch]), [
    ["/a", true],
    ["/b", true],
  ]);

  const env2 = harness([]);
  env2.nav.likely(["/a"]);
  const pending = [...env2.timers.keys()];
  void env2.nav.go("/elsewhere");
  assert.ok(pending.every((id) => !env2.timers.has(id)), "the timer was cleared");
});
