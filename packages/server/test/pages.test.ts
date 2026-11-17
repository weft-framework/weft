import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml, signal, type Html } from "@weft-framework/runtime";
import { createApp, notFound, type AppOptions, type Route } from "../src/app.ts";
import { redirect } from "../src/live.ts";
import { mergeMeta, renderMeta, resolveTitle, scriptJson } from "../src/meta.ts";
import { Router, patternForFile, splitPath } from "../src/router.ts";
import { parseShell } from "../src/shell.ts";

const SECRET = "pages-test-secret-0123456789abcdefgh";
const ORIGIN = "http://app.test";

const Post = defineComponent("Post", (props: { slug: string; title: string }) => ({
  handlers: {},
  render: () => `<h1>${escapeHtml(props.title)}</h1><p>${escapeHtml(props.slug)}</p>`,
}));

const Docs = defineComponent("Docs", (props: { path: string[] }) => ({
  handlers: {},
  render: () => `<p>${escapeHtml(props.path.join("|"))}</p>`,
}));

const Missing = defineComponent("Missing", (_p: object) => ({
  handlers: {},
  render: () => `<h1>Nothing here</h1>`,
}));

const Shell = defineComponent("Shell", (props: { children: Html; path: string }) => {
  const open = signal(false);
  function toggle() {
    open.value = !open.value;
  }
  return {
    handlers: { toggle },
    render: () =>
      `<nav data-weft-on-click="toggle">${open.value ? "open" : "closed"} ${escapeHtml(props.path)}</nav>` +
      `<main>${escapeHtml(props.children)}</main>`,
  };
});

const Count = defineComponent("Count", (_p: object) => {
  const n = signal(0);
  function inc() {
    n.value += 1;
  }
  return { handlers: { inc }, render: () => `<button data-weft-on-click="inc">${n.value}</button>` };
});

function app(extra: Partial<AppOptions> = {}) {
  const routes: Record<string, Route<never>> = {
    "/blog/[slug]": {
      component: Post as never,
      load: ({ params }) =>
        params.slug === "old"
          ? redirect("/blog/new")
          : params.slug === "gone"
            ? notFound()
            : ({ title: `Post ${String(params.slug)}` } as never),
      meta: ((_ctx: unknown, data: { title: string }) => ({
        title: data.title,
        description: `About "${data.title}"`,
        openGraph: { title: data.title, image: "/og.png" },
      })) as never,
    },
    "/blog/new": { component: Missing as never, title: "New" },
    "/docs/[...path]": { component: Docs as never },
    "/counter": {
      component: Count as never,
      layouts: [{ component: Shell as never, meta: { titleTemplate: "%s | Site", lang: "cs" } }],
      title: "Counter",
    },
  };
  return createApp({
    secret: SECRET,
    routes,
    notFound: { component: Missing as never, title: "Not found" },
    onError: () => {},
    ...extra,
  });
}

async function get(a: ReturnType<typeof app>, path: string, headers: Record<string, string> = {}) {
  const res = (await a.fetch(new Request(ORIGIN + path, { headers })))!;
  return { res, html: await res.text() };
}

test("router: static beats dynamic beats catch-all; params decode per segment", () => {
  const r = new Router({
    "/docs/[...rest]": "rest",
    "/[page]": "page",
    "/blog/[slug]": "slug",
    "/blog/new": "new",
    "/": "home",
    "/files/[[...p]]": "opt",
  });
  assert.equal(r.match("/blog/new")?.route.value, "new");
  assert.deepEqual({ ...r.match("/blog/a%20b")?.params }, { slug: "a b" });
  assert.deepEqual({ ...r.match("/blog/a%2Fb")?.params }, { slug: "a/b" });
  assert.equal(r.match("/blog/a/b"), null);
  assert.deepEqual({ ...r.match("/docs/x/y")?.params }, { rest: ["x", "y"] });
  assert.equal(r.match("/docs")?.route.value, "page", "a catch-all needs one segment");
  assert.deepEqual({ ...r.match("/files")?.params }, { p: [] });
  assert.equal(r.match("/")?.route.value, "home");
  assert.equal(r.match("/about/")?.route.value, "page");
  for (const bad of ["/blog/..", "/a//b", "/blog/%E0%A4%A", "/x/%00", "no-slash"]) {
    assert.equal(splitPath(bad), null, bad);
  }
  assert.throws(() => new Router({ "/[a]": 1, "/[b]": 2 }), /route conflict/);
  assert.throws(() => new Router({ "/[...a]/x": 1 }), /catch-all must be the last/);
  assert.throws(() => new Router({ "/[a]/[a]": 1 }), /duplicate route parameter/);
  assert.equal(patternForFile("index.wx"), "/");
  assert.equal(patternForFile("blog/[slug].wx"), "/blog/[slug]");
  assert.equal(patternForFile("docs\\index.wx"), "/docs");
});

test("meta: merged, templated and escaped", () => {
  const m = mergeMeta(
    { titleTemplate: "%s | Site", openGraph: { siteName: "Site" }, tags: [{ name: "a", content: "1" }] },
    { title: '<x> & "y"', openGraph: { title: "T" }, tags: [{ property: "b", content: "2" }] },
  );
  assert.equal(resolveTitle(m), '<x> & "y" | Site');
  assert.equal(resolveTitle({ titleTemplate: "%s | Site" }), "Site");
  const html = renderMeta({ ...m, jsonLd: { name: "</script><script>alert(1)</script>" } }, { nonce: "n1" });
  assert.ok(html.startsWith("<title>&lt;x&gt; &amp; &quot;y&quot; | Site</title>"), html);
  assert.ok(html.includes('<meta property="og:title" content="T">'));
  assert.ok(html.includes('<meta property="og:site_name" content="Site">'));
  assert.ok(html.includes('<meta name="a" content="1"><meta property="b" content="2">'));
  assert.ok(!html.includes("</script><script>"), "JSON-LD cannot close its element");
  assert.ok(html.includes('<script type="application/ld+json" nonce="n1">'));
  assert.equal(JSON.parse(scriptJson({ s: "</script>&" })).s, "</script>&");
});

test("shell: markers required once, own scripts get the nonce, inline handlers refused", () => {
  assert.throws(() => parseShell("<html><body><!--weft:body--></body></html>"), /missing <!--weft:head-->/);
  assert.throws(() => parseShell("<!--weft:head--><!--weft:body--><!--weft:body-->"), /more than once/);
  assert.throws(() => parseShell("<!--weft:body--><!--weft:head-->"), /must come before/);
  assert.throws(() => parseShell('<body onload="x()"><!--weft:head--><!--weft:body-->'), /inline event handler/);
  assert.throws(() => parseShell('<script nonce="a"></script><!--weft:head--><!--weft:body-->'), /nonce/);
  const shell = parseShell(
    '<html lang="%lang%"><head><!--weft:head--><script src="/a.js"></script></head><body><!--weft:body--></body></html>',
  );
  assert.equal(
    shell.render({ lang: "cs", head: "<title>t</title>", body: "<p>b</p>", nonce: "N" }),
    '<html lang="cs"><head><title>t</title><script nonce="N" src="/a.js"></script></head><body><p>b</p></body></html>',
  );
});

test("dynamic route: load feeds props, meta sees the loaded data", async () => {
  const { res, html } = await get(app(), "/blog/hello%20world");
  assert.equal(res.status, 200);
  assert.ok(html.includes("<h1>Post hello world</h1><p>hello world</p>"), html);
  assert.ok(html.includes("<title>Post hello world</title>"));
  assert.ok(html.includes('<meta name="description" content="About &quot;Post hello world&quot;">'));
  assert.ok(html.includes('<meta property="og:image" content="/og.png">'));
});

test("load can redirect (303) or answer with the not-found page (404)", async () => {
  const a = app();
  const moved = await get(a, "/blog/old");
  assert.equal(moved.res.status, 303);
  assert.equal(moved.res.headers.get("location"), "/blog/new");
  const gone = await get(a, "/blog/gone");
  assert.equal(gone.res.status, 404);
  assert.ok(gone.html.includes("<h1>Nothing here</h1>"));
  assert.ok(gone.html.includes("<title>Not found</title>"));
  const unknown = await get(a, "/no/such/page");
  assert.equal(unknown.res.status, 404);
  assert.ok(unknown.html.includes("<h1>Nothing here</h1>"));
  assert.equal((await get(a, "/_weft/nope")).res.status, 404);

  const bad = createApp({
    secret: SECRET,
    routes: { "/": { component: Missing as never, load: () => redirect("//evil.example") as never } },
    onError: () => {},
  });
  assert.equal((await bad.fetch(new Request(ORIGIN + "/")))!.status, 500, "off-site redirects refused");
});

test("catch-all params arrive as arrays", async () => {
  const { html } = await get(app(), "/docs/a/b%2Fc");
  assert.ok(html.includes("<p>a|b/c</p>"), html);
});

test("layouts wrap the page, set metadata, and keep their own state", async () => {
  const a = app();
  const res = (await a.fetch(new Request(ORIGIN + "/counter")))!;
  const html = await res.text();
  assert.match(html, /<html lang="cs">/);
  assert.ok(html.includes("<title>Counter | Site</title>"));
  assert.match(
    html,
    /<weft-c data-weft-c="r"><weft-c data-weft-c="(r\.\d+)"><nav data-weft-on-click="toggle">closed \/counter<\/nav><main><weft-c data-weft-c="(r\.\d+)"><button data-weft-on-click="inc">0<\/button><\/weft-c><\/main><\/weft-c><\/weft-c>/,
  );
  const [, shellId, pageId] =
    /data-weft-c="(r\.\d+)"><nav[\s\S]*data-weft-c="(r\.\d+)"><button/.exec(html) ?? [];
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "";
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";

  const sse = (await a.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } })))!;
  const reader = sse.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const next = async () => {
    for (;;) {
      const m = /data: (.*)\n\n/.exec(buf);
      if (m) {
        buf = buf.slice(m.index + m[0].length);
        return JSON.parse(m[1]);
      }
      buf += dec.decode((await reader.read()).value);
    }
  };
  const { session } = await next();
  const send = (id: string, handler: string, seq: number) =>
    a.fetch(
      new Request(`${ORIGIN}/_weft/live/event`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": session },
        body: JSON.stringify({ t: "event", id, handler, event: { type: "click" }, seq }),
      }),
    );

  await send(pageId, "inc", 1);
  assert.deepEqual(await next(), {
    t: "patch",
    id: pageId,
    html: '<button data-weft-on-click="inc">1</button>',
    ack: 1,
  });
  await send(shellId, "toggle", 2);
  const patch = await next();
  assert.equal(patch.id, shellId);
  assert.ok(
    patch.html.includes(`open /counter</nav><main><weft-c data-weft-c="${pageId}" data-weft-keep></weft-c></main>`),
    patch.html,
  );
  await reader.cancel();
});

test("public files are served for paths no page claims; pages win", async () => {
  const a = app({
    routes: { "/": { component: Missing as never } },
    files: (path) => (path === "/robots.txt" || path === "/" ? new Response("User-agent: *") : null),
  });
  const robots = await get(a, "/robots.txt");
  assert.equal(robots.html, "User-agent: *");
  assert.ok((await get(a, "/")).html.includes("<h1>Nothing here</h1>"));
  const post = (await a.fetch(new Request(ORIGIN + "/robots.txt", { method: "POST" })))!;
  assert.equal(post.status, 404);
});

test("a custom shell is used for every page", async () => {
  const a = app({
    shell:
      '<!doctype html><html lang="%lang%"><head><!--weft:head--><style>body{margin:0}</style></head><body class="x"><!--weft:body--></body></html>',
  });
  const { res, html } = await get(a, "/blog/a");
  const nonce = /'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];
  assert.ok(html.includes(`<style nonce="${nonce}">body{margin:0}</style>`));
  assert.match(html, /<body class="x"><weft-c data-weft-c="r">/);
});
