import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineModel, parseFilter, useDatabase, type Model } from "@weft/data";
import { openSqlite } from "@weft/data/sqlite";
import { defineComponent, escapeHtml, type Component } from "@weft/runtime";
import { decodeForm, decodeJson, defineAction } from "../src/action.ts";
import { createApp } from "../src/app.ts";
import { login } from "../src/auth.ts";
import { compileFile, findCompiler } from "../src/compiler.ts";
import { publicFiles } from "../src/files.ts";
import { parseEnv } from "../src/secret.ts";
import { parseCookies } from "../src/security.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const XSS = [
  `<script>alert(1)</script>`,
  `"><script>alert(1)</script>`,
  `'><img src=x onerror=alert(1)>`,
  `" onmouseover="alert(1)`,
  `' autofocus onfocus='alert(1)`,
  `</a><svg onload=alert(1)>`,
  `</script><script>alert(1)</script>`,
  `<!--<script>alert(1)//-->`,
  `<iframe srcdoc="<script>alert(1)</script>">`,
  `javascript:alert(1)`,
  ` JaVaScRiPt:alert(1)`,
  `java\tscript:alert(1)`,
  `java\nscript:alert(1)`,
  `\u0001javascript:alert(1)`,
  `javascript&colon;alert(1)`,
  `javascript&#58;alert(1)`,
  `&#106;avascript:alert(1)`,
  `vbscript:msgbox(1)`,
  `data:text/html,<script>alert(1)</script>`,
  `data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==`,
  `data:image/svg+xml,<svg onload=alert(1)>`,
  "`${alert(1)}`",
  `\${alert(1)}`,
  `{{constructor.constructor('alert(1)')()}}`,
  `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`,
  `\u2028\u2029</script>`,
  `<a href="javascript:alert(1)">x</a>`,
];

const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const scriptUrl = (u: string) => /^(javascript|vbscript|data):/.test(u.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase());

test("XSS: payloads in text, attributes and URLs render inert", { skip: !hasCargo() }, async () => {
  const dir = join(here, ".weft", "payloads");
  mkdirSync(dir, { recursive: true });
  const wx = join(dir, "Echo.wx");
  writeFileSync(
    wx,
    [
      "component Echo(v: string) {",
      "  view {",
      '    <section id="echo"><div title={v}><a href={v}>{v}</a><img src={v} /><form action={v}><button formaction={v}>go</button></form></div></section>',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  const ts = join(dir, "Echo.ts");
  writeFileSync(ts, compileFile(findCompiler(here), wx));
  const { Echo } = (await import(pathToFileURL(ts).href)) as { Echo: Component };
  const app = createApp({
    secret: SECRET,
    sync: false,
    transports: [],
    routes: { "/": { component: Echo as never, load: (ctx) => ({ v: ctx.query.get("v") ?? "" }) } },
  });
  const render = async (v: string) => {
    const res = (await app.fetch(new Request(`${ORIGIN}/?v=${encodeURIComponent(v)}`)))!;
    assert.equal(res.status, 200);
    return res.text();
  };
  const scripts = (html: string) => (html.match(/<script\b/gi) ?? []).length;
  const baseline = scripts(await render("benign"));
  const SHAPE =
    /<section id="echo"><div title="([^"<>]*)"><a href="([^"<>]*)">([^<>]*)<\/a><img src="([^"<>]*)" \/><form action="([^"<>]*)"[^<>]*><button formaction="([^"<>]*)"[^<>]*>go<\/button><\/form><\/div><\/section>/;
  for (const p of XSS) {
    const html = await render(p);
    const m = SHAPE.exec(html);
    assert.ok(m, `markup structure broken by ${JSON.stringify(p)}:\n${/<section[\s\S]*<\/section>/.exec(html)?.[0]}`);
    const [, title, href, body, src, action, formaction] = m;
    assert.equal(decode(title), p);
    assert.equal(decode(body), p);
    for (const [name, url] of [["href", href], ["src", src], ["action", action], ["formaction", formaction]]) {
      const u = decode(url);
      assert.ok(!scriptUrl(u) || u.startsWith("data:image/"), `${name}=${JSON.stringify(u)} from ${JSON.stringify(p)}`);
    }
    assert.equal(scripts(html), baseline, `script count changed by ${JSON.stringify(p)}`);
  }
});

interface Doc {
  id: string;
  owner: string;
  title: string;
}

function docsModel() {
  return defineModel<Doc>("Doc", {
    fields: { id: "string", owner: "string", title: "string" },
    read: (a: { id: string } | null, d) => a !== null && d.owner === a.id,
    write: (a: { id: string } | null, d) => a !== null && d.owner === a.id,
    readWhere: { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } },
    writeWhere: { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } },
  });
}

function docsApp() {
  const Docs = docsModel();
  useDatabase(openSqlite(":memory:"), [Docs] as Model<never>[]);
  Docs.as({ id: "ann" }).create({ id: "a1", owner: "ann", title: "Ann's" });
  Docs.as({ id: "bob" }).create({ id: "b1", owner: "bob", title: "Bob's" });
  const signIn = defineAction("signIn", [{ name: "who", type: "string" }], async (ctx, who: string) => {
    await login(ctx, who);
    return true;
  });
  const rename = defineAction(
    "rename",
    [
      { name: "id", type: "string" },
      { name: "title", type: "string" },
    ],
    (ctx, id: string, title: string) => Docs.as(ctx.user as never).update((d) => d.id === id, { title }),
  );
  const add = defineAction(
    "add",
    [
      { name: "title", type: "string" },
      { name: "qty", type: "number" },
    ],
    () => ({ ok: true }),
  );
  const Show = defineComponent("Show", (props: { out: string }) => ({
    handlers: {},
    render: () => `<p id="out">${escapeHtml(props.out)}</p>`,
  }));
  const app = createApp({
    secret: SECRET,
    sync: false,
    transports: [],
    routes: {
      "/": { component: Show as never, load: () => ({ out: "home" }) },
      "/doc/[id]": {
        component: Show as never,
        load: (ctx) => ({ out: Docs.as(ctx.user as never).get(ctx.params.id as string)?.title ?? "(none)" }),
      },
    },
    actions: { signIn: signIn as never, rename: rename as never, add: add as never },
  });
  return { app, Docs };
}

type App = ReturnType<typeof createApp>;

async function visit(app: App, path = "/", cookie = "") {
  const res = (await app.fetch(new Request(ORIGIN + path, { headers: cookie ? { cookie } : {} })))!;
  const html = await res.text();
  return {
    status: res.status,
    cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] || cookie,
    csrf: /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "",
    out: decode(/<p id="out">([^<]*)<\/p>/.exec(html)?.[1] ?? ""),
  };
}

function call(app: App, name: string, body: unknown, headers: Record<string, string>) {
  return app.fetch(
    new Request(`${ORIGIN}/?/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  ) as Promise<Response>;
}

async function signedIn(app: App, who: string) {
  const anon = await visit(app);
  const res = await call(app, "signIn", { who }, { cookie: anon.cookie, "x-weft-csrf": anon.csrf });
  assert.equal(res.status, 200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(cookie && cookie !== anon.cookie, "login rotates the session");
  return visit(app, "/", cookie);
}

test("IDOR: another user's row is unreachable by any spelling of its id", async () => {
  const { app, Docs } = docsApp();
  const ann = await signedIn(app, "ann");
  const ids = ["b1", "b1 ", " b1", "B1", "b1\u0000", "b1' OR '1'='1", "b1\" OR \"1\"=\"1", "%", "_1", "*", "", "../b1", "b1;"];
  for (const id of ids) {
    const res = await call(app, "rename", { id, title: "pwned" }, { cookie: ann.cookie, "x-weft-csrf": ann.csrf });
    assert.equal(res.status, 200, id);
    assert.deepEqual(await res.json(), { ok: true, value: 0 }, `rename ${JSON.stringify(id)}`);
    const read = await visit(app, `/doc/${encodeURIComponent(id)}`, ann.cookie);
    assert.ok(read.status === 200 ? read.out === "(none)" : read.status === 404, `read ${JSON.stringify(id)}: ${read.status} ${read.out}`);
  }
  for (const id of [{ ne: "" }, { $ne: null }, ["b1"], { in: ["b1"] }, null, 1]) {
    const res = await call(app, "rename", { id, title: "pwned" }, { cookie: ann.cookie, "x-weft-csrf": ann.csrf });
    assert.equal(res.status, 400, JSON.stringify(id));
  }
  const own = await call(app, "rename", { id: "a1", title: "Mine" }, { cookie: ann.cookie, "x-weft-csrf": ann.csrf });
  assert.deepEqual(await own.json(), { ok: true, value: 1 });
  assert.equal((await visit(app, "/doc/a1", ann.cookie)).out, "Mine");
  assert.equal((await visit(app, "/doc/a1")).out, "(none)");
  assert.equal(Docs.as({ id: "ann" }).create({ id: "x", owner: "bob", title: "planted" }), undefined);
  assert.equal(Docs.as({ id: "bob" }).get("x"), undefined);
  assert.equal(Docs.as({ id: "bob" }).get("b1")?.title, "Bob's");
});

test("CSRF: a state change needs this session's token from this origin", async () => {
  const { app } = docsApp();
  const ann = await signedIn(app, "ann");
  const bob = await signedIn(app, "bob");
  const body = { id: "a1", title: "forged" };
  const tamper = ann.csrf.slice(0, -2) + (ann.csrf.endsWith("A") ? "BB" : "AA");
  const refused: [string, Record<string, string>][] = [
    ["no token", { cookie: ann.cookie }],
    ["empty token", { cookie: ann.cookie, "x-weft-csrf": "" }],
    ["another session's token", { cookie: ann.cookie, "x-weft-csrf": bob.csrf }],
    ["altered token", { cookie: ann.cookie, "x-weft-csrf": tamper }],
    ["the cookie as the token", { cookie: ann.cookie, "x-weft-csrf": ann.cookie.split("=")[1] ?? "" }],
    ["cross-origin", { cookie: ann.cookie, "x-weft-csrf": ann.csrf, origin: "https://evil.test" }],
    ["look-alike origin", { cookie: ann.cookie, "x-weft-csrf": ann.csrf, origin: "http://app.test.evil.test" }],
    ["opaque origin", { cookie: ann.cookie, "x-weft-csrf": ann.csrf, origin: "null" }],
    ["no session", { "x-weft-csrf": ann.csrf }],
  ];
  for (const [why, headers] of refused) {
    const res = await call(app, "rename", body, headers);
    assert.equal(res.status, 403, why);
  }
  for (const ct of ["application/x-www-form-urlencoded", "text/plain", "multipart/form-data; boundary=x"]) {
    const res = (await app.fetch(
      new Request(`${ORIGIN}/?/rename`, {
        method: "POST",
        headers: { "content-type": ct, cookie: ann.cookie, origin: "https://evil.test" },
        body: ct === "text/plain" ? JSON.stringify(body) : "id=a1&title=forged",
      }),
    ))!;
    assert.equal(res.status, 403, ct);
  }
  assert.equal((await visit(app, "/doc/a1", ann.cookie)).out, "Ann's", "nothing was renamed");
  const ok = await call(app, "rename", body, { cookie: ann.cookie, "x-weft-csrf": ann.csrf });
  assert.deepEqual(await ok.json(), { ok: true, value: 1 });
});

const SQLI = [
  "' OR '1'='1",
  "' OR 1=1 --",
  '" OR "1"="1',
  "'; DROP TABLE Doc; --",
  "x'); DELETE FROM Doc; --",
  "%",
  "_",
  "%' --",
  "\\",
  "\\'",
  "' UNION SELECT id, owner, title FROM Doc --",
  "\u0000",
  "' || (SELECT title FROM Doc WHERE owner='bob') || '",
];

test("SQL injection: values stay values, identifiers are checked", () => {
  const Docs = docsModel();
  const db = openSqlite(":memory:");
  useDatabase(db, [Docs] as Model<never>[]);
  const rows: Doc[] = [
    { id: "a1", owner: "ann", title: "plain" },
    { id: "a2", owner: "ann", title: "100% sure" },
    { id: "a3", owner: "ann", title: "under_score" },
    { id: "a4", owner: "ann", title: "it's" },
    { id: "b1", owner: "bob", title: "Bob's secret" },
  ];
  for (const r of rows) Docs.as({ id: r.owner }).create(r);
  const ann = Docs.as({ id: "ann" });
  const mine = rows.filter((r) => r.owner === "ann");
  const ids = (ds: Doc[]) => ds.map((d) => d.id).sort();
  for (const p of SQLI) {
    assert.deepEqual(ids(ann.query().where({ title: { eq: p } }).all()), ids(mine.filter((r) => r.title === p)), `eq ${p}`);
    assert.deepEqual(ids(ann.query().where({ title: { contains: p } }).all()), ids(mine.filter((r) => r.title.includes(p))), `contains ${p}`);
    assert.deepEqual(ids(ann.query().where({ title: { startsWith: p } }).all()), ids(mine.filter((r) => r.title.startsWith(p))), `startsWith ${p}`);
    assert.deepEqual(ids(ann.query().where({ id: { in: [p, "a1"] } }).all()), ["a1"], `in ${p}`);
    assert.equal(ann.get(p), undefined, `get ${p}`);
    assert.deepEqual(Docs.as({ id: p }).query().all(), [], `actor ${p}`);
    assert.equal(Docs.as({ id: p }).update(() => true, { title: "x" }), 0);
  }
  assert.deepEqual(
    (db.prepare("SELECT id, owner, title FROM Doc ORDER BY id").all() as unknown as Doc[]).map((r) => ({ ...r })),
    rows,
  );
  for (const f of ["title; DROP TABLE Doc", "title--", "1=1", "rowid", "__proto__", "constructor"]) {
    assert.throws(() => ann.query().where({ [f]: { eq: 1 } } as never).all(), `filter field ${f}`);
    assert.throws(() => ann.query().orderBy(f as never).all(), `orderBy ${f}`);
  }
  assert.throws(() => ann.query().where({ title: { "eq) OR (1": 1 } } as never).all(), /operator/);
});

test("path traversal: no spelling of a path leaves the public directory", async () => {
  const base = mkdtempSync(join(tmpdir(), "weft-traversal-"));
  try {
    const pub = join(base, "public");
    mkdirSync(join(pub, "img"), { recursive: true });
    writeFileSync(join(pub, "img", "a.txt"), "inside");
    writeFileSync(join(base, "secret.txt"), "outside");
    writeFileSync(join(pub, ".env"), "SECRET=1");
    const files = publicFiles(pub);
    const paths = [
      "/../secret.txt",
      "/img/../../secret.txt",
      "/./../secret.txt",
      "/img/..//../secret.txt",
      "//../secret.txt",
      "/%2e%2e/secret.txt",
      "/%2E%2E/secret.txt",
      "/.%2e/secret.txt",
      "/%252e%252e/secret.txt",
      "/img%2f..%2f..%2fsecret.txt",
      "/img%5c..%5c..%5csecret.txt",
      "/..\\secret.txt",
      "/img\\..\\..\\secret.txt",
      "/%c0%ae%c0%ae/secret.txt",
      "/%e0%80%ae%e0%80%ae/secret.txt",
      "/\uff0e\uff0e/secret.txt",
      "/img/a.txt%00.png",
      "/img/a.txt\u0000",
      "/.env",
      "/img/../.env",
      "/%2eenv",
      "/img/a.txt/..",
      "/C:/Windows/win.ini",
      "/" + base.replace(/\\/g, "/") + "/secret.txt",
    ];
    for (const p of paths) {
      const res = await files(p, new Request("http://app.test/"));
      const text = res ? await res.text() : "";
      assert.ok(!text.includes("outside") && !text.includes("SECRET"), `${p} -> ${text}`);
    }
    assert.equal(await (await files("/img/a.txt", new Request("http://app.test/")))?.text(), "inside");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

const clean = () => {
  const probe = {} as Record<string, unknown>;
  return probe.polluted === undefined && probe.isAdmin === undefined && Object.keys(Object.prototype).length === 0;
};

test("prototype pollution: no input reaches Object.prototype", async () => {
  const { app } = docsApp();
  const ann = await signedIn(app, "ann");
  const specs = [
    { name: "title", type: "string" as const },
    { name: "qty", type: "number" as const },
  ];
  for (const body of [
    '{"title":"x","qty":1,"__proto__":{"polluted":true}}',
    '{"title":"x","qty":1,"constructor":{"prototype":{"polluted":true}}}',
    '{"__proto__":{"isAdmin":true},"title":"x","qty":1}',
  ]) {
    const res = await call(app, "add", body, { cookie: ann.cookie, "x-weft-csrf": ann.csrf });
    assert.equal(res.status, 400, body);
    assert.ok(clean(), body);
    assert.equal(decodeJson(specs, JSON.parse(body)).ok, false);
  }
  const form = new URLSearchParams("title=x&qty=1&__proto__[polluted]=1&constructor[prototype][polluted]=1&__proto__.isAdmin=1");
  assert.deepEqual(decodeForm(specs, form), { ok: true, args: ["x", 1] });
  const posted = (await app.fetch(
    new Request(`${ORIGIN}/?/add`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: ann.cookie, origin: ORIGIN },
      body: form.toString(),
    }),
  ))!;
  assert.equal(posted.status, 303);
  assert.ok(clean());
  const jar = parseCookies("__proto__=polluted; constructor=x; prototype=y; weft_sid=abc");
  assert.equal(Object.getPrototypeOf(jar) === Object.prototype ? jar.polluted : undefined, undefined);
  assert.equal(jar.weft_sid, "abc");
  const withJar = (await app.fetch(new Request(ORIGIN + "/", { headers: { cookie: `__proto__=1; ${ann.cookie}` } })))!;
  assert.equal(withJar.status, 200);
  assert.ok(clean());
  assert.throws(() => parseFilter(JSON.parse('{"__proto__":{"eq":1}}'), new Set(["title"]), "Doc"), /field/);
  assert.throws(() => parseFilter(JSON.parse('{"title":{"__proto__":1}}'), new Set(["title"]), "Doc"));
  assert.ok(clean());
  assert.throws(() => parseEnv("__proto__=1"), /__proto__ is not a variable name/);
  assert.equal(parseEnv("constructor=1").constructor, "1");
  assert.ok(clean());
});
