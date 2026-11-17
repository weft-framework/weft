import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeFeed, defineModel } from "@weft-framework/data";
import { awaitBlock, defineComponent, escapeHtml } from "@weft-framework/runtime";
import { createApp, notFound, type AppOptions } from "../src/app.ts";
import { DepsIndex, track } from "../src/sync.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

interface Msg {
  id: string;
  author: string;
  text: string;
  public: boolean;
}

type User = { id: string };

function setup(extra: Partial<AppOptions> = {}) {
  const feed = new ChangeFeed();
  const Msgs = defineModel<Msg>("Msg", {
    fields: { id: "string", author: "string", text: "string", public: "boolean" },
    read: (a, r) => r.public || (a as User).id === r.author,
    write: (a, r) => (a as User).id === r.author,
  }).publishTo(feed);

  const Board = defineComponent("Board", (props: { user: string; msgs: Msg[] }) => ({
    handlers: {
      post(form: { form?: Record<string, string> }) {
        const n = Msgs.publicUnscoped().length + 1;
        Msgs.as({ id: props.user }).create({ id: `h${n}`, author: props.user, text: form.form?.text ?? "", public: true });
      },
    },
    render: () =>
      `<ul>${props.msgs.map((m) => `<li>${escapeHtml(m.text)}</li>`).join("")}</ul>` +
      `<form data-weft-on-submit="post"><input name="text"></form>`,
  }));

  const Count = defineComponent("Count", (props: { user: string }) => ({
    handlers: {},
    render: () => `<b>${Msgs.as({ id: props.user }).all().length}</b>`,
  }));

  const Single = defineComponent("Single", (props: { msg: Msg }) => ({
    handlers: {},
    render: () => `<p>${escapeHtml(props.msg.text)}</p>`,
  }));

  const app = createApp({
    secret: SECRET,
    sync: feed,
    syncDelayMs: 0,
    onError: (e) => {
      throw e;
    },
    routes: {
      "/": {
        component: Board as never,
        load: (ctx) => {
          const user = ctx.query.get("as") ?? "anon";
          return { user, msgs: Msgs.as({ id: user }).all() };
        },
      },
      "/count": {
        component: Count as never,
        load: (ctx) => ({ user: ctx.query.get("as") ?? "anon" }),
      },
      "/t/[id]": {
        component: Single as never,
        load: (ctx) => ({ msg: Msgs.as({ id: "anon" }).get(ctx.params.id) }),
        meta: ((_ctx: unknown, d: { msg?: Msg }) => ({ title: d.msg?.text ?? "gone", description: `about ${d.msg?.text}` })) as never,
      },
      "/m/[id]": {
        component: Single as never,
        load: (ctx) => {
          const msg = Msgs.as({ id: "anon" }).get(ctx.params.id);
          return msg ? { msg } : notFound();
        },
      },
    },
    ...extra,
  });
  return { app, feed, Msgs };
}

type App = ReturnType<typeof createApp>;

async function open(app: App, path: string) {
  const res = await app.fetch(new Request(ORIGIN + path));
  assert.ok(res);
  const html = await res.text();
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "";
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";
  return { html, cookie, lid, csrf };
}

async function stream(app: App, cookie: string, lid: string) {
  const res = await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } }));
  assert.equal(res?.status, 200);
  const reader = res!.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const s = {
    async next(ms = 500): Promise<Record<string, unknown> | null> {
      const deadline = Date.now() + ms;
      for (;;) {
        const m = /data: (.*)\n\n/.exec(buf);
        if (m) {
          buf = buf.slice(m.index + m[0].length);
          return JSON.parse(m[1]);
        }
        pending ??= reader.read();
        const left = deadline - Date.now();
        const got = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, left)))]);
        if (got === null) {
          return null;
        }
        pending = null;
        buf += dec.decode(got.value);
      }
    },
    close: () => reader.cancel(),
    session: "",
  };
  const hello = await s.next();
  assert.equal(hello?.t, "hello");
  s.session = String(hello?.session);
  return s;
}

test("a write re-renders every page that may see it, without an ack", async () => {
  const { app, Msgs } = setup();
  const a = await open(app, "/?as=alice");
  const b = await open(app, "/?as=bob");
  const sa = await stream(app, a.cookie, a.lid);
  const sb = await stream(app, b.cookie, b.lid);

  Msgs.as({ id: "carol" }).create({ id: "1", author: "carol", text: "hello <all>", public: true });
  for (const s of [sa, sb]) {
    const msg = await s.next();
    assert.equal(msg?.t, "patch");
    assert.equal("ack" in msg!, false);
    assert.match(String(msg?.html), /<li>hello &lt;all&gt;<\/li>/);
  }
  await sa.close();
  await sb.close();
  app.close();
});

test("a private write reaches only its reader (authorization-aware fan-out)", async () => {
  const { app, Msgs } = setup();
  const a = await open(app, "/?as=alice");
  const b = await open(app, "/?as=bob");
  const sa = await stream(app, a.cookie, a.lid);
  const sb = await stream(app, b.cookie, b.lid);

  Msgs.as({ id: "alice" }).create({ id: "p", author: "alice", text: "secret", public: false });
  assert.match(String((await sa.next())?.html), /secret/);
  assert.equal(await sb.next(150), null, "bob's page is not even refreshed");

  Msgs.as({ id: "alice" }).update((m) => m.id === "p", { public: true });
  assert.match(String((await sb.next())?.html), /secret/);
  await sa.next();
  Msgs.as({ id: "alice" }).update((m) => m.id === "p", { public: false });
  assert.doesNotMatch(String((await sb.next())?.html), /secret/);
  await sa.close();
  await sb.close();
  app.close();
});

test("a handler's write syncs to other pages", async () => {
  const { app } = setup();
  const a = await open(app, "/?as=alice");
  const b = await open(app, "/?as=bob");
  const sa = await stream(app, a.cookie, a.lid);
  const sb = await stream(app, b.cookie, b.lid);
  const id = /data-weft-c="([^"]+)"/.exec(a.html)![1];
  const res = await app.fetch(
    new Request(`${ORIGIN}/_weft/live/event`, {
      method: "POST",
      headers: { cookie: a.cookie, origin: ORIGIN, "x-weft-csrf": a.csrf, "x-weft-session": sa.session },
      body: JSON.stringify({ t: "event", id, handler: "post", event: { type: "submit", form: { text: "from alice" } }, seq: 1 }),
    }),
  );
  assert.equal(res?.status, 204);
  assert.match(String((await sb.next())?.html), /from alice/);
  assert.deepEqual(await sa.next(), { t: "ack", ack: 1 });
  assert.match(String((await sa.next())?.html), /from alice/, "the author's own page reloads too");
  await sa.close();
  await sb.close();
  app.close();
});

test("reads made while rendering are tracked too", async () => {
  const { app, Msgs } = setup();
  const p = await open(app, "/count?as=bob");
  assert.match(p.html, /<b>0<\/b>/);
  const s = await stream(app, p.cookie, p.lid);
  Msgs.as({ id: "carol" }).create({ id: "1", author: "carol", text: "x", public: true });
  assert.match(String((await s.next())?.html), /<b>1<\/b>/);
  await s.close();
  app.close();
});

test("a page with no open stream catches up when one connects", async () => {
  const { app, Msgs } = setup();
  const a = await open(app, "/?as=alice");
  Msgs.as({ id: "carol" }).create({ id: "1", author: "carol", text: "missed", public: true });
  await new Promise((r) => setTimeout(r, 20));
  const s = await stream(app, a.cookie, a.lid);
  assert.match(String((await s.next())?.html), /missed/);
  await s.close();
  app.close();
});

test("a page whose subject is deleted reloads into the 404", async () => {
  const { app, Msgs } = setup();
  Msgs.as({ id: "carol" }).create({ id: "7", author: "carol", text: "soon gone", public: true });
  const p = await open(app, "/m/7");
  assert.match(p.html, /soon gone/);
  const s = await stream(app, p.cookie, p.lid);
  Msgs.as({ id: "carol" }).delete((m) => m.id === "7");
  assert.deepEqual(await s.next(), { t: "redirect", to: "/m/7" });
  await s.close();
  app.close();
});

test("close stops following the feed; sync can be disabled", async () => {
  const { app, feed } = setup();
  assert.equal(feed.size, 1);
  app.close();
  assert.equal(feed.size, 0);

  const off = setup({ sync: false });
  assert.equal(off.feed.size, 0);
  const p = await open(off.app, "/?as=alice");
  const s = await stream(off.app, p.cookie, p.lid);
  off.Msgs.as({ id: "alice" }).create({ id: "1", author: "alice", text: "x", public: true });
  assert.equal(await s.next(100), null);
  await s.close();
  off.app.close();
});

test("streamed data: an awaited promise from load arrives as a patch", async () => {
  let resolve!: (v: { name: string }) => void;
  let reject!: (e: Error) => void;
  let loads = 0;
  const Profile = defineComponent("Profile", (props: { user: Promise<{ name: string }> }) => ({
    handlers: {},
    render: () =>
      awaitBlock(
        props.user,
        () => `<p>Loading</p>`,
        (u) => `<p>${escapeHtml(u.name)}</p>`,
        (e) => `<p>Failed: ${escapeHtml((e as Error).message)}</p>`,
      ),
  }));
  const app = createApp({
    secret: SECRET,
    sync: false,
    syncDelayMs: 0,
    streamTimeoutMs: 0,
    routes: {
      "/": {
        component: Profile as never,
        load: () => {
          loads += 1;
          return { user: new Promise<{ name: string }>((r) => (resolve = r)) };
        },
      },
      "/bad": {
        component: Profile as never,
        load: () => ({ user: new Promise<{ name: string }>((_, j) => (reject = j)) }),
      },
    },
  });
  const p = await open(app, "/");
  assert.match(p.html, /<p>Loading<\/p>/, "the page is sent before the data");
  const s = await stream(app, p.cookie, p.lid);
  resolve({ name: "Ada <3" });
  const msg = await s.next();
  assert.equal(msg?.t, "patch");
  assert.match(String(msg?.html), /<p>Ada &lt;3<\/p>/);
  assert.equal(loads, 1, "settling re-renders without re-running load");
  await s.close();

  const b = await open(app, "/bad");
  const sb = await stream(app, b.cookie, b.lid);
  reject(new Error("db <down>"));
  assert.match(String((await sb.next())?.html), /Failed: db &lt;down&gt;/);
  await sb.close();
  app.close();
});

test("streamed data settling before the stream connects is delivered on connect", async () => {
  let resolve!: (v: string) => void;
  const View = defineComponent("View", (props: { v: Promise<string> }) => ({
    handlers: {},
    render: () => awaitBlock(props.v, () => "wait", (v) => `<b>${escapeHtml(v)}</b>`),
  }));
  const app = createApp({
    secret: SECRET,
    syncDelayMs: 0,
    streamTimeoutMs: 0,
    routes: { "/": { component: View as never, load: () => ({ v: new Promise<string>((r) => (resolve = r)) }) } },
  });
  const p = await open(app, "/");
  resolve("late");
  await new Promise((r) => setTimeout(r, 20));
  const s = await stream(app, p.cookie, p.lid);
  assert.match(String((await s.next())?.html), /<b>late<\/b>/);
  await s.close();
  app.close();
});

test("changes are matched against the pages that read their model only", () => {
  const A = defineModel<{ id: string }>("IdxA", { fields: { id: "string" }, read: () => true });
  const B = defineModel<{ id: string }>("IdxB", { fields: { id: "string" }, read: () => true });
  const index = new DepsIndex<string>();
  const orphan = index.deps();
  track(orphan, () => A.as(null).all());
  assert.equal(index.size, 0);
  const p1 = index.deps();
  track(p1, () => A.as(null).all());
  p1.adopt("p1");
  const p2 = index.deps("p2");
  track(p2, () => B.as(null).all());
  assert.deepEqual([...index.readersOf("IdxA")], ["p1"]);
  assert.deepEqual([...index.readersOf("IdxB")], ["p2"]);
  assert.deepEqual([...index.readersOf("Other")], []);
  const p1b = p1.renew();
  track(p1b, () => B.as(null).all());
  assert.deepEqual([...index.readersOf("IdxA")], []);
  assert.deepEqual([...index.readersOf("IdxB")].sort(), ["p1", "p2"]);
  p1b.release();
  p2.release();
  assert.equal(index.size, 0);
  track(p2, () => A.as(null).all());
  assert.equal(index.size, 0, "a released pass stays out");
});

test("a sync refresh that changes the page's metadata sends the new head", async () => {
  const { app, Msgs } = setup();
  Msgs.as({ id: "carol" }).create({ id: "t1", author: "carol", text: "First <draft>", public: true });
  const a = await open(app, "/t/t1");
  assert.match(a.html, /<title>First &lt;draft&gt;<\/title>/);
  const sa = await stream(app, a.cookie, a.lid);
  Msgs.as({ id: "carol" }).update((m) => m.id === "t1", { text: "Final" });
  const patch = await sa.next();
  assert.equal(patch?.t, "patch");
  const head = await sa.next();
  assert.equal(head?.t, "head");
  assert.equal(head?.title, "Final");
  assert.equal(head?.lang, "en");
  assert.match(String(head?.meta), /<title>Final<\/title>/);
  assert.match(String(head?.meta), /content="about Final"/);
  Msgs.as({ id: "carol" }).create({ id: "t2", author: "carol", text: "other", public: true });
  const next = await sa.next(150);
  assert.ok(next === null || next.t === "patch", JSON.stringify(next));
  assert.equal(await sa.next(150), null);
  await sa.close();
  app.close();
});

test("a gap in the change feed reloads every page that read data", async () => {
  const { app, feed, Msgs } = setup();
  const a = await open(app, "/?as=alice");
  const sa = await stream(app, a.cookie, a.lid);
  Msgs.driver.insert({ id: "g1", author: "dan", text: "missed", public: true });
  assert.equal(await sa.next(100), null, "no notice, no refresh");
  feed.gap();
  const msg = await sa.next();
  assert.equal(msg?.t, "patch");
  assert.match(String(msg?.html), /<li>missed<\/li>/);
  await sa.close();
  app.close();
});

test("dev overlay: inspect answers only the owning session, with tree, reads and decisions", async () => {
  const { app: plain } = setup();
  const p = await open(plain, "/?as=alice");
  const off = await plain.fetch(new Request(`${ORIGIN}/_weft/dev/inspect?lid=${p.lid}`, { headers: { cookie: p.cookie } }));
  assert.equal(off?.status, 404, "off unless devtools is on");
  plain.close();

  const { app, Msgs } = setup({ devtools: true });
  Msgs.as({ id: "alice" }).create({ id: "1", author: "alice", text: "mine", public: false });
  const a = await open(app, "/?as=alice");
  const b = await open(app, "/?as=bob");
  const inspect = (cookie: string, lid: string) =>
    app.fetch(new Request(`${ORIGIN}/_weft/dev/inspect?lid=${lid}`, { headers: { cookie } }));

  const res = await inspect(a.cookie, a.lid);
  assert.equal(res?.status, 200);
  assert.equal(res?.headers.get("cache-control"), "no-store");
  const snap = await res!.json();
  assert.equal(snap.path, "/");
  assert.equal(snap.tree.name, "Board");
  assert.ok(snap.tree.renders >= 1);
  assert.deepEqual(snap.reads.load, [{ model: "Msg", scope: ["id alice"] }]);
  const reads = snap.decisions.filter((d: { action: string }) => d.action === "read");
  assert.ok(reads.length >= 1, "the first load's reads are recorded for the session");
  assert.ok(reads.every((d: { actor: string }) => d.actor === "id alice"), "actors by id, this session only");

  assert.equal((await inspect(b.cookie, a.lid))?.status, 404, "another session cannot look in");
  assert.equal((await inspect("", a.lid))?.status, 404);
  const other = await (await inspect(b.cookie, b.lid))!.json();
  assert.ok(other.decisions.every((d: { actor: string }) => d.actor === "id bob"));
  app.close();
});

test("dev overlay: a sync refresh names the write behind it", async () => {
  const { app, Msgs } = setup({ devtools: true });
  const a = await open(app, "/?as=alice");
  const c = await open(app, "/count?as=alice");
  const sa = await stream(app, a.cookie, a.lid);
  const sc = await stream(app, c.cookie, c.lid);
  Msgs.as({ id: "alice" }).create({ id: "w1", author: "alice", text: "hi", public: false });
  await sa.next();
  await sc.next();
  const pushes = async (o: { cookie: string; lid: string }) => {
    const snap = await (await app.fetch(new Request(`${ORIGIN}/_weft/dev/inspect?lid=${o.lid}`, { headers: { cookie: o.cookie } })))!.json();
    return (snap.messages as { dir: string; what: string }[]).filter((m) => m.dir === "push").map((m) => m.what);
  };
  assert.deepEqual(await pushes(a), ['data changed: load and render again because: create Msg "w1" (read in load)']);
  assert.deepEqual(await pushes(c), ['data changed: load and render again because: create Msg "w1" (read in render)']);
  const snap = await (await app.fetch(new Request(ORIGIN + "/_weft/dev/inspect?lid=" + a.lid, { headers: { cookie: a.cookie } })))!.json();
  const cost = snap.cost;
  assert.ok(cost.heldBytes > 100, "the page holds its HTML and load data");
  assert.equal(snap.capacity.route, "/");
  assert.ok(snap.capacity.perPage > 0 && snap.capacity.pages > 1000 && snap.capacity.heapLimit > snap.capacity.heapUsed);
  assert.equal(cost.events, 0);
  assert.equal(cost.refreshes, 1);
  assert.ok(cost.bytes > 20 && cost.ms >= 0, "the refresh is charged to the page");
  await sa.close();
  await sc.close();
  app.close();
});

test("dev overlay: time travel keeps the page state after each event and refresh, for its session only", async () => {
  const { app, Msgs } = setup({ devtools: true });
  const a = await open(app, "/?as=alice");
  const b = await open(app, "/?as=bob");
  const sa = await stream(app, a.cookie, a.lid);
  Msgs.as({ id: "alice" }).create({ id: "t1", author: "alice", text: "first", public: true });
  await sa.next();
  const get = (path: string, cookie: string) => app.fetch(new Request(ORIGIN + path, { headers: { cookie } }));
  const snap = await (await get("/_weft/dev/inspect?lid=" + a.lid, a.cookie))!.json();
  const frames = snap.frames as { n: number; what: string; bytes: number }[];
  assert.deepEqual(frames.map((f) => [f.n, f.what]), [[0, "the page opened"], [1, "data changed"]]);
  assert.ok(frames.every((f) => f.bytes > 0));
  const zero = await (await get("/_weft/dev/frame?lid=" + a.lid + "&n=0", a.cookie))!.json();
  assert.equal(zero.html.includes("first"), false, "the state before the write");
  const one = await (await get("/_weft/dev/frame?lid=" + a.lid + "&n=1", a.cookie))!.json();
  assert.ok(one.html.includes("<li>first</li>"));
  assert.equal((await get("/_weft/dev/frame?lid=" + a.lid + "&n=0", b.cookie))?.status, 404, "another session cannot look in");
  assert.equal((await get("/_weft/dev/frame?lid=" + a.lid + "&n=9", a.cookie))?.status, 404);
  assert.equal((await get("/_weft/dev/frame?lid=" + a.lid + "&n=x", a.cookie))?.status, 404);
  await sa.close();
  app.close();
  const plain = setup().app;
  const p = await open(plain, "/");
  assert.equal((await plain.fetch(new Request(ORIGIN + "/_weft/dev/frame?lid=" + p.lid + "&n=0", { headers: { cookie: p.cookie } })))?.status, 404, "off unless devtools");
  plain.close();
});

test("dev frames are bounded by count and bytes, and a repeated state is not kept twice", async () => {
  const { devLog, frame, DEV_FRAMES_MAX, DEV_FRAMES_BYTES } = await import("../src/devtools.ts");
  const log = devLog();
  for (let i = 0; i < DEV_FRAMES_MAX + 10; i++) frame(log, "e" + i, "<p>" + i + "</p>");
  assert.equal(log.frames.length, DEV_FRAMES_MAX);
  assert.equal(log.frames[0].n, 10);
  frame(log, "same", log.frames.at(-1)!.html);
  assert.equal(log.frames.at(-1)!.what, "e" + (DEV_FRAMES_MAX + 9));
  const big = "x".repeat(DEV_FRAMES_BYTES / 3);
  for (let i = 0; i < 5; i++) frame(log, "big" + i, big + i);
  assert.ok(log.frames.reduce((s, f) => s + f.html.length, 0) <= DEV_FRAMES_BYTES);
});
