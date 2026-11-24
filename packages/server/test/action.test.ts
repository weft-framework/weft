import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";
import { decodeForm, decodeJson, defineAction, fail, isAction, type ParamSpec } from "../src/action.ts";
import { redirect } from "../src/live.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

const SPECS: ParamSpec[] = [
  { name: "title", type: "string" },
  { name: "qty", type: "number" },
  { name: "urgent", type: "boolean" },
  { name: "tags", type: "string", list: true },
  { name: "note", type: "string", optional: true },
  { name: "max", type: "number", optional: true },
];

test("form decoding coerces by declared type", () => {
  const f = new URLSearchParams("title=Milk&qty=2&urgent=on&tags=a&tags=b&submit=Go&max=");
  assert.deepEqual(decodeForm(SPECS, f), { ok: true, args: ["Milk", 2, true, ["a", "b"], undefined, undefined] });
  const g = new URLSearchParams("title=&qty=0");
  assert.deepEqual(decodeForm(SPECS, g), { ok: true, args: ["", 0, false, [], undefined, undefined] });
  assert.deepEqual(decodeForm(SPECS, new URLSearchParams("qty=1")), { ok: false, error: "title is required" });
  assert.deepEqual(decodeForm(SPECS, new URLSearchParams("title=x&qty=two")), {
    ok: false,
    error: "qty: expected a number",
  });
  assert.equal(decodeForm(SPECS, new URLSearchParams("title=x&qty=Infinity")).ok, false);
  assert.equal(decodeForm(SPECS, new URLSearchParams("title=x&qty= ")).ok, false);
  const files = new FormData();
  files.append("title", new Blob(["x"]), "x.txt");
  files.append("qty", "1");
  assert.deepEqual(decodeForm(SPECS, files), { ok: false, error: "title: files are not accepted" });
});

test("JSON decoding is exact", () => {
  assert.deepEqual(decodeJson(SPECS, { title: "a", qty: 1, urgent: false, tags: ["x"], note: null }), {
    ok: true,
    args: ["a", 1, false, ["x"], undefined, undefined],
  });
  assert.deepEqual(decodeJson(SPECS, { title: "a", qty: "1", urgent: false, tags: [] }), {
    ok: false,
    error: "qty: expected number",
  });
  assert.deepEqual(decodeJson(SPECS, { title: "a", qty: 1, urgent: false, tags: [1] }), {
    ok: false,
    error: "tags: expected string[]",
  });
  assert.deepEqual(decodeJson(SPECS, { title: "a", qty: 1, urgent: true, tags: [], admin: true }), {
    ok: false,
    error: "unknown argument admin",
  });
  assert.equal(decodeJson(SPECS, [1, 2]).ok, false);
  assert.equal(decodeJson(SPECS, { title: "a", urgent: true, tags: [] }).ok, false);
  assert.equal(decodeJson([{ name: "toString", type: "string" }], {}).ok, false);
});

test("defineAction validates its shape", () => {
  const a = defineAction("add", [{ name: "x", type: "number" }], () => 1);
  assert.ok(isAction(a));
  assert.ok(!isAction({ name: "add" }));
  assert.throws(() => defineAction("not a name", [], () => 1), /invalid action name/);
  assert.throws(
    () => defineAction("a", [{ name: "x", type: "string" }, { name: "x", type: "string" }], () => 1),
    /bad parameter x/,
  );
  assert.throws(() => defineAction("a", [{ name: "_weft_csrf", type: "string" }], () => 1), /bad parameter/);
});

function makeApp() {
  const items: string[] = [];
  const add = defineAction("add", [{ name: "title", type: "string" }, { name: "qty", type: "number" }], (ctx, title: string, qty: number) => {
    if (title === "") {
      fail("A title is required <b>");
    }
    if (title === "boom") {
      throw new Error("secret detail");
    }
    if (title === "go") {
      return redirect(`/list/${String(ctx.params.slug)}`);
    }
    if (title === "evil") {
      return redirect("https://evil.test/");
    }
    items.push(`${title}x${qty}`);
    return { count: items.length };
  });
  const errors: unknown[] = [];
  const Page = defineComponent("Page", () => ({
    handlers: {},
    render: () => `<p>${escapeHtml(items.join(","))}</p>`,
  }));
  const app = createApp({
    secret: SECRET,
    routes: { "/list/[slug]": { component: Page } },
    actions: { add: add as never },
    sync: false,
    onError: (e) => errors.push(e),
  });
  return { app, items, errors };
}

async function session(app: ReturnType<typeof createApp>) {
  const res = await app.fetch(new Request(`${ORIGIN}/list/a`));
  assert.ok(res);
  const html = await res.text();
  return {
    cookie: (res.headers.get("set-cookie") ?? "").split(";")[0],
    csrf: /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "",
  };
}

async function postForm(app: ReturnType<typeof createApp>, path: string, body: string, headers: Record<string, string>) {
  const res = await app.fetch(
    new Request(ORIGIN + path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body,
    }),
  );
  assert.ok(res);
  return res;
}

test("a plain form post runs the action and redirects back (no JavaScript)", async () => {
  const { app, items } = makeApp();
  const { cookie } = await session(app);
  const ok = await postForm(app, "/list/a?/add", "title=Milk&qty=2", { cookie, origin: ORIGIN });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/list/a");
  assert.deepEqual(items, ["Milkx2"]);

  const go = await postForm(app, "/list/zz?/add", "title=go&qty=1", { cookie, origin: ORIGIN });
  assert.equal(go.headers.get("location"), "/list/zz");

  const bad = await postForm(app, "/list/a?/add", "title=&qty=1", { cookie, origin: ORIGIN });
  assert.equal(bad.status, 400);
  const text = await bad.text();
  assert.ok(text.includes("A title is required &lt;b&gt;"), text);
  assert.ok(text.includes('href="/list/a"'));
  assert.ok(bad.headers.get("content-security-policy"));

  const invalid = await postForm(app, "/list/a?/add", "title=x&qty=lots", { cookie, origin: ORIGIN });
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.text()).includes("qty: expected a number"));
  assert.deepEqual(items, ["Milkx2"]);
});

test("action posts are refused cross-origin, without a session, or when unknown", async () => {
  const { app, items } = makeApp();
  const { cookie } = await session(app);
  const body = "title=Milk&qty=2";
  assert.equal((await postForm(app, "/list/a?/add", body, { cookie, origin: "https://evil.test" })).status, 403);
  assert.equal((await postForm(app, "/list/a?/add", body, { cookie })).status, 403, "no Origin nor Sec-Fetch-Site");
  assert.equal(
    (await postForm(app, "/list/a?/add", body, { cookie, "sec-fetch-site": "cross-site" })).status,
    403,
  );
  assert.equal((await postForm(app, "/list/a?/add", body, { origin: ORIGIN })).status, 403, "no session");
  assert.equal((await postForm(app, "/list/a?/nope", body, { cookie, origin: ORIGIN })).status, 404);
  assert.equal((await postForm(app, "/list/a?/x-y", body, { cookie, origin: ORIGIN })).status, 404);
  assert.equal((await postForm(app, "/list/a", body, { cookie, origin: ORIGIN })).status, 405, "not an action");
  assert.equal(
    (await postForm(app, "/list/a?/add", "title=" + "x".repeat(300_000), { cookie, origin: ORIGIN })).status,
    413,
  );
  assert.deepEqual(items, []);
});

test("JSON action calls need the CSRF token and answer JSON", async () => {
  const { app, items, errors } = makeApp();
  const { cookie, csrf } = await session(app);
  const call = async (body: unknown, token = csrf) => {
    const res = await app.fetch(
      new Request(`${ORIGIN}/list/a?/add`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: ORIGIN, "x-weft-csrf": token },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    assert.ok(res);
    return { status: res.status, body: await res.json() };
  };
  assert.deepEqual(await call({ title: "Tea", qty: 3 }), { status: 200, body: { ok: true, value: { count: 1 } } });
  assert.deepEqual(await call({ title: "go", qty: 1 }), { status: 200, body: { ok: true, redirect: "/list/a" } });
  assert.equal((await call({ title: "Tea", qty: 3 }, "forged")).status, 403);
  assert.deepEqual(await call({ title: "Tea", qty: "3" }), {
    status: 400,
    body: { ok: false, error: "qty: expected number" },
  });
  assert.deepEqual((await call("{not json")).body, { ok: false, error: "Malformed request body" });
  assert.deepEqual(await call({ title: "", qty: 1 }), {
    status: 400,
    body: { ok: false, error: "A title is required <b>" },
  });
  assert.deepEqual(await call({ title: "boom", qty: 1 }), { status: 500, body: { ok: false, error: "Server error" } });
  assert.equal(errors.length, 1);
  assert.equal((await call({ title: "evil", qty: 1 })).status, 500);
  assert.equal(errors.length, 2);
  assert.deepEqual(items, ["Teax3"]);
});

test("actions must be registered under their own name", () => {
  const a = defineAction("add", [], () => 1);
  assert.throws(
    () => createApp({ secret: SECRET, routes: {}, actions: { other: a as never } }),
    /registered as other is named add/,
  );
});

test("actions are callable without a page: session bootstrap and /_weft/action", async () => {
  const { app, items } = makeApp();
  const foreign = await app.fetch(new Request(`${ORIGIN}/_weft/session`, { headers: { origin: "https://evil.test" } }));
  assert.equal(foreign?.status, 403);
  assert.equal(foreign?.headers.get("set-cookie"), null);
  assert.equal((await app.fetch(new Request(`${ORIGIN}/_weft/session`, { method: "POST", headers: { origin: ORIGIN } })))?.status, 405);

  const boot = await app.fetch(new Request(`${ORIGIN}/_weft/session`, { headers: { "sec-fetch-site": "same-origin" } }));
  assert.ok(boot);
  assert.equal(boot.status, 200);
  assert.equal(boot.headers.get("cache-control"), "no-store");
  const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0];
  const { csrf } = (await boot.json()) as { csrf: string };
  assert.ok(cookie && csrf);
  const again = await app.fetch(new Request(`${ORIGIN}/_weft/session`, { headers: { origin: ORIGIN, cookie } }));
  assert.equal(again?.headers.get("set-cookie"), null);
  const second = ((await again?.json()) as { csrf: string }).csrf;
  assert.notEqual(second, csrf);

  const call = (name: string, body: string, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request(`${ORIGIN}/_weft/action/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": csrf, ...headers },
        body,
      }),
    );
  const ok = await call("add", '{"title":"Tea","qty":3}');
  assert.deepEqual(await ok?.json(), { ok: true, value: { count: 1 } });
  assert.deepEqual(items, ["Teax3"]);
  assert.deepEqual(await (await call("add", '{"title":"go","qty":1}'))?.json(), { ok: true, redirect: "/list/undefined" });
  assert.equal((await call("nope", "{}"))?.status, 404);
  assert.equal((await call("a%2", "{}"))?.status, 404);
  assert.equal((await call("add", '{"title":"x","qty":1}', { "x-weft-csrf": "forged" }))?.status, 403);
  assert.equal((await call("add", '{"title":"x","qty":1}', { origin: "https://evil.test" }))?.status, 403);
  const form = await postForm(app, "/_weft/action/add", "title=Pie&qty=1", { cookie, origin: ORIGIN });
  assert.equal(form.status, 403);
  assert.match(form.headers.get("content-type") ?? "", /application\/json/);
  const enhanced = await postForm(app, "/_weft/action/add", "title=Pie&qty=1", { cookie, origin: ORIGIN, "x-weft-csrf": csrf });
  assert.deepEqual(await enhanced.json(), { ok: true, value: { count: 2 } });
  assert.equal((await call("add", '{"title":"Pie","qty":2}', { "x-weft-csrf": second }))?.status, 200);
  assert.equal((await app.fetch(new Request(`${ORIGIN}/_weft/action/add`)))?.status, 405);
});

test("middleware guards standalone actions", async () => {
  const add = defineAction("add", [], () => "ran");
  const app = createApp({
    secret: SECRET,
    routes: {},
    actions: { add: add as never },
    sync: false,
    middleware: [({ url }) => (url.pathname.startsWith("/_weft/action/") ? new Response("no", { status: 401 }) : undefined)],
  });
  const boot = await app.fetch(new Request(`${ORIGIN}/_weft/session`, { headers: { origin: ORIGIN } }));
  const cookie = (boot?.headers.get("set-cookie") ?? "").split(";")[0];
  const { csrf } = (await boot?.json()) as { csrf: string };
  const res = await app.fetch(
    new Request(`${ORIGIN}/_weft/action/add`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": csrf },
      body: "{}",
    }),
  );
  assert.equal(res?.status, 401);
});

test("File parameters are decoded from multipart forms and refused elsewhere", async () => {
  const specs: ParamSpec[] = [
    { name: "doc", type: "file" },
    { name: "extra", type: "file", list: true },
    { name: "logo", type: "file", optional: true },
    { name: "title", type: "string" },
  ];
  const form = new FormData();
  form.append("doc", new File(["hello"], "a.txt", { type: "text/plain" }));
  form.append("extra", new File(["1"], "b.txt"));
  form.append("extra", new File(["22"], "c.txt"));
  form.append("logo", new File([], ""));
  form.append("title", "T");
  const d = decodeForm(specs, form);
  assert.ok(d.ok, d.ok ? "" : d.error);
  const [doc, extra, logo, title] = d.args as [File, File[], File | undefined, string];
  assert.equal(doc.name, "a.txt");
  assert.equal(await doc.text(), "hello");
  assert.deepEqual(extra.map((f) => f.name), ["b.txt", "c.txt"]);
  assert.equal(logo, undefined, "an empty file input is no file");
  assert.equal(title, "T");

  const missing = new FormData();
  missing.append("doc", new File([], ""));
  missing.append("title", "T");
  assert.deepEqual(decodeForm(specs, missing), { ok: false, error: "doc is required" });
  assert.deepEqual(decodeForm(specs, new URLSearchParams("doc=x&title=T")), { ok: false, error: "doc: expected a file upload" });
  const smuggled = new FormData();
  smuggled.append("doc", new File(["x"], "x"));
  smuggled.append("title", new File(["x"], "x"));
  assert.deepEqual(decodeForm(specs, smuggled), { ok: false, error: "title: files are not accepted" });
  assert.deepEqual(decodeJson(specs.slice(0, 1), { doc: "x" }), { ok: false, error: "doc: files are sent as a multipart form, not JSON" });
  assert.throws(() => defineAction("a", [{ name: "f", type: "file", held: true }], () => 1), /held parameter cannot be a file/);

  let got = "";
  const upload = defineAction<[File, string], number>("upload", [{ name: "doc", type: "file" }, { name: "title", type: "string" }], async (_ctx, f, t) => {
    got = `${t}:${f.name}:${await f.text()}`;
    return f.size;
  });
  const Page = defineComponent("Page", () => ({ handlers: {}, render: () => "<p></p>" }));
  const app = createApp({ secret: SECRET, routes: { "/u": { component: Page } }, actions: { upload: upload as never }, sync: false, onError: () => {} });
  const { cookie, csrf } = await session2(app);
  const body = new FormData();
  body.append("doc", new File(["abc"], "r.csv", { type: "text/csv" }));
  body.append("title", "Report");
  const res = await app.fetch(new Request(`${ORIGIN}/u?/upload`, { method: "POST", headers: { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-enhanced": "1", accept: "application/json" }, body }));
  assert.ok(res);
  assert.deepEqual(await res.json(), { ok: true, value: 3 });
  assert.equal(got, "Report:r.csv:abc");
});

async function session2(app: ReturnType<typeof createApp>) {
  const res = await app.fetch(new Request(`${ORIGIN}/u`));
  assert.ok(res);
  const html = await res.text();
  return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]!, csrf: /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "" };
}

test("Record<string, string> parameters collect name[key] fields", () => {
  const specs: ParamSpec[] = [{ name: "vars", type: "record" }, { name: "title", type: "string" }];
  const form = new URLSearchParams();
  form.append("vars[first name]", "Ada");
  form.append("vars[__proto__]", "x");
  form.append("vars[plan]", "");
  form.append("other[k]", "no");
  form.append("title", "T");
  const d = decodeForm(specs, form);
  assert.ok(d.ok, d.ok ? "" : d.error);
  const vars = d.args[0] as Record<string, string>;
  assert.deepEqual(Object.keys(vars), ["first name", "__proto__", "plan"]);
  assert.equal(vars["first name"], "Ada");
  assert.equal(Object.getPrototypeOf(vars), Object.prototype, "the prototype is untouched");
  assert.equal(({} as Record<string, unknown>).x, undefined);
  assert.deepEqual(decodeForm(specs, new URLSearchParams("title=T")), { ok: true, args: [{}, "T"] });
  assert.deepEqual(decodeForm(specs, new URLSearchParams("vars[a]=1&vars[a]=2&title=T")), { ok: false, error: "vars[a] is given twice" });
  assert.deepEqual(decodeForm(specs, new URLSearchParams("vars[]=1&title=T")), { ok: false, error: "vars: invalid key" });
  const many = new URLSearchParams(Array.from({ length: 201 }, (_, i) => [`vars[k${i}]`, "v"]));
  many.append("title", "T");
  assert.deepEqual(decodeForm(specs, many), { ok: false, error: "vars: at most 200 entries" });
  assert.deepEqual(decodeJson(specs, { vars: { a: "1" }, title: "T" }), { ok: true, args: [{ a: "1" }, "T"] });
  assert.equal(decodeJson(specs, { vars: { a: 1 }, title: "T" }).ok, false);
  assert.equal(decodeJson(specs, { vars: ["a"], title: "T" }).ok, false);
});
