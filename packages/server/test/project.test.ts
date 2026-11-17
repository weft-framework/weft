import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IslandRegistry } from "@weft-framework/runtime";
import { createApp, type App } from "../src/app.ts";
import { findCompiler } from "../src/compiler.ts";
import { ProjectError, loadProject } from "../src/project.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const work = join(here, ".weft", "project");
const ORIGIN = "http://demo.test";

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function scaffold(name: string): string {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "new", dir, "--minimal"], { cwd: repo, stdio: "pipe" });
  return dir;
}

async function get(app: App, path: string, headers: Record<string, string> = {}) {
  const res = (await app.fetch(new Request(ORIGIN + path, { headers })))!;
  return { res, html: await res.text() };
}

test("the starter project serves pages, layouts, metadata and public files", { skip: !hasCargo() }, async () => {
  const root = scaffold("demo-app");
  const compiler = findCompiler(repo);
  const project = await loadProject(root, { compiler, outDir: join(root, ".weft", "build") });
  assert.deepEqual(Object.keys(project.routes).sort(), ["/", "/about", "/blog", "/blog/[slug]"]);
  const app = createApp({ secret: "project-test-secret-0123456789abcdef", ...project, onError: () => {} });

  const home = await get(app, "/");
  assert.equal(home.res.status, 200);
  assert.match(home.html, /^<!doctype html>\n<html lang="en">/);
  assert.ok(home.html.includes("<title>Home | demo-app</title>"), home.html);
  assert.ok(home.html.includes('<meta name="description" content="A Weft application.">'));
  assert.ok(home.html.includes('<meta property="og:site_name" content="demo-app">'));
  assert.ok(home.html.includes('<link rel="stylesheet" href="/styles.css">'), "shell kept");
  assert.ok(
    home.html.includes('<a data-weft-key="/" href="/" class="active" aria-current="page">Home</a>'),
    "nav marks the active page",
  );
  assert.ok(home.html.includes('<button data-weft-on-click="increment">Clicked 0 times</button>'));

  const post = await get(app, "/blog/hello-weft");
  assert.ok(post.html.includes("<title>Hello, Weft | demo-app</title>"));
  assert.ok(post.html.includes('<meta property="og:type" content="article">'), "page meta overrides layout");
  assert.ok(post.html.includes("<h1>Hello, Weft</h1>"));

  const blog = await get(app, "/blog");
  assert.ok(blog.html.includes('<a href="/blog/live-pages">Live pages</a>'));
  assert.ok(blog.html.includes('<a data-weft-key="/blog" href="/blog" class="active" aria-current="page">Blog</a>'));

  for (const path of ["/blog/no-such-post", "/nope", "/../package.json", "/.gitignore"]) {
    const missing = await get(app, path);
    assert.equal(missing.res.status, 404, path);
    assert.ok(missing.html.includes("<h1>Page not found</h1>"), path);
    assert.ok(missing.html.includes('<meta name="robots" content="noindex">'), path);
    assert.ok(missing.html.includes('<header class="site-header">'), "404 page gets the layout");
  }

  const robots = await get(app, "/robots.txt");
  assert.equal(robots.res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(robots.html, /User-agent/);
  const css = await get(app, "/styles.css");
  assert.equal(css.res.headers.get("content-type"), "text/css; charset=utf-8");

  const cookie = (home.res.headers.get("set-cookie") ?? "").split(";")[0];
  const lid = /name="weft-live" content="([^"]+)"/.exec(home.html)?.[1] ?? "";
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(home.html)?.[1] ?? "";
  const counter = /data-weft-c="(r[.\d]*)"><div class="counter">/.exec(home.html)?.[1] ?? "";
  assert.ok(counter.startsWith("r."), "counter is a nested instance");
  const sse = (await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } })))!;
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
  const posted = await app.fetch(
    new Request(`${ORIGIN}/_weft/live/event`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": session },
      body: JSON.stringify({ t: "event", id: counter, handler: "increment", event: { type: "click" }, seq: 1 }),
    }),
  );
  assert.equal(posted?.status, 204);
  const patch = await next();
  assert.equal(patch.id, counter);
  assert.ok(patch.html.includes("Clicked 1 times"), patch.html);
  await reader.cancel();
});

const TOGGLE = `component Page() {
  client signal open = false
  client derived label = open ? "Hide" : "Show"
  signal count = 0
  client function toggle() { open = !open }
  function inc() { count = count + 1 }
  view {
    <button @click={toggle} aria-expanded={open}>{label}</button>
    <p hidden={!open}>{count} <button @click={inc}>+</button></p>
  }
}
`;

test("islands: marked instances, served browser modules, live client state", { skip: !hasCargo() }, async () => {
  const root = scaffold("island-app");
  writeFileSync(join(root, "src", "pages", "toggle.wx"), TOGGLE);
  const compiler = findCompiler(repo);
  const outDir = join(root, ".weft", "build");
  const project = await loadProject(root, { compiler, outDir });
  assert.ok(!Object.keys(project.routes).some((r) => r.includes("client")), "browser modules are not routes");
  const app = createApp({ secret: "project-test-secret-0123456789abcdef", ...project, onError: () => {} });

  const page = await get(app, "/toggle");
  assert.equal(page.res.status, 200);
  const key = /<weft-c data-weft-c="[^"]+" data-weft-island="(Page\.[0-9a-f]{8})">/.exec(page.html)?.[1];
  assert.ok(key, page.html);
  assert.ok(page.html.includes('data-weft-do-click="toggle"'), page.html);
  assert.ok(page.html.includes('<weft-t data-weft-t="'), "client text binding");
  assert.ok(page.html.includes('data-weft-on-click="inc"'), "server handler beside it");

  const registry = await get(app, "/_weft/islands.js");
  assert.equal(registry.res.status, 200);
  assert.ok(registry.html.includes('from "/_weft/islands/pages/toggle.js"'), registry.html);
  const mod = await get(app, "/_weft/islands/pages/toggle.js");
  assert.equal(mod.res.status, 200);
  assert.ok(mod.html.includes('from "/_weft/rt/index.js"'), "runtime import points at the served runtime");
  assert.ok(!mod.html.includes("function inc"), "server code is not shipped");
  assert.ok(!/:\s*unknown\[\]/.test(mod.html), "types are stripped");
  assert.ok((await get(app, "/_weft/client.js")).html.includes("boot({ islands })"));

  const client = (await import(pathToFileURL(join(outDir, "pages", "toggle.client.ts")).href)) as {
    islands: IslandRegistry;
  };
  assert.deepEqual(Object.keys(client.islands), [key], "the registry is keyed like the server's marker");
  const inst = client.islands[key].setup();
  const values = () => inst.binds.map((b) => b());
  assert.deepEqual(values(), [false, "Show", true]);
  (inst.fns.toggle as () => void)();
  assert.deepEqual(values(), [true, "Hide", false]);
  const saved = inst.snapshot();
  (inst.fns.toggle as () => void)();
  inst.restore(saved);
  assert.deepEqual(values(), [true, "Hide", false]);

  mkdirSync(join(root, "src", "pages", "more"), { recursive: true });
  writeFileSync(join(root, "src", "pages", "more", "toggle.wx"), TOGGLE.replace('"Hide"', '"Close"'));
  const two = await loadProject(root, { compiler, outDir: join(root, ".weft", "two") });
  const app2 = createApp({ secret: "project-test-secret-0123456789abcdef", ...two, onError: () => {} });
  const other = /data-weft-island="(Page\.[0-9a-f]{8})"/.exec((await get(app2, "/more/toggle")).html)?.[1];
  assert.ok(other && other !== key, `${other} vs ${key}`);
  const merged = (await get(app2, "/_weft/islands.js")).html;
  assert.ok(merged.includes("pages/toggle.js") && merged.includes("pages/more/toggle.js"), merged);
});

const GUESTBOOK = `import { fail } from "@weft-framework/server/action"

const entries: string[] = []

action sign(name: string, stars: number) {
  if (name.trim() === "") fail("Please give a name")
  entries.push(\`\${name}:\${stars}\`)
}

component Page() {
  client signal sent = 0
  client function quick() { sign("Bo", 5).then(() => { sent = sent + 1 }) }
  view {
    <form action={sign}>
      <input name="name" aria-label="Name" />
      <input name="stars" aria-label="Stars" />
      <button>Sign</button>
    </form>
    <p>{entries.join(",")}</p>
    <button @click={quick}>{sent}</button>
  }
}
`;

test("actions: plain form posts, refusals, island stubs, unique names", { skip: !hasCargo() }, async () => {
  const root = scaffold("action-app");
  writeFileSync(join(root, "src", "pages", "guest.wx"), GUESTBOOK);
  const compiler = findCompiler(repo);
  const outDir = join(root, ".weft", "build");
  const project = await loadProject(root, { compiler, outDir });
  assert.deepEqual(Object.keys(project.actions ?? {}), ["sign"]);
  const app = createApp({ secret: "project-test-secret-0123456789abcdef", ...project, onError: () => {} });

  const page = await get(app, "/guest");
  assert.ok(page.html.includes('<form action="?/sign" method="post" data-weft-action="sign">'), page.html);
  const cookie = (page.res.headers.get("set-cookie") ?? "").split(";")[0];
  const post = (body: string) =>
    app.fetch(
      new Request(`${ORIGIN}/guest?/sign`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );

  const ok = (await post("name=Ann&stars=4"))!;
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/guest");
  assert.ok((await get(app, "/guest", { cookie })).html.includes("<p>Ann:4</p>"));
  const refused = (await post("name=+&stars=4"))!;
  assert.equal(refused.status, 400);
  assert.ok((await refused.text()).includes("Please give a name"));
  assert.equal((await post("name=Cy&stars=many"))!.status, 400, "typed decoding");

  const mod = await get(app, "/_weft/islands/pages/guest.js");
  assert.ok(mod.html.includes('clientAction("sign", ["name", "stars"])'), mod.html);
  assert.ok(!mod.html.includes("entries"), "server code is not shipped");

  writeFileSync(
    join(root, "src", "pages", "again.wx"),
    "action sign(name: string) {}\ncomponent Page() { view { <p>again</p> } }\n",
  );
  await assert.rejects(
    loadProject(root, { compiler, outDir: join(root, ".weft", "dup") }),
    (err: unknown) => err instanceof ProjectError && /action sign is defined in both/.test(err.message),
  );
});

test("models, api routes, middleware, config, and the error page are wired", { skip: !hasCargo() }, async () => {
  const root = scaffold("structured-app");
  writeFileSync(
    join(root, "weft.config.ts"),
    `export default { siteUrl: "https://demo.test", meta: { description: "From config" } }\n`,
  );
  writeFileSync(
    join(root, "src", "middleware.ts"),
    `export function middleware() { return { headers: { "x-from": "middleware" } } }\n`,
  );
  mkdirSync(join(root, "src", "models"), { recursive: true });
  writeFileSync(
    join(root, "src", "models", "Note.ts"),
    `import { defineModel } from "@weft-framework/data"\n` +
      `interface Note { id: string }\n` +
      `export const Note = defineModel<Note>("Note", { fields: { id: "string" }, read: () => true, write: () => false })\n`,
  );
  mkdirSync(join(root, "src", "pages", "api"), { recursive: true });
  writeFileSync(
    join(root, "src", "pages", "api", "health.ts"),
    `export function GET() { return Response.json({ ok: true }) }\n`,
  );
  writeFileSync(
    join(root, "src", "pages", "_error.wx"),
    `component Page() { view { <h1>Something went wrong</h1> } }\n`,
  );
  writeFileSync(
    join(root, "src", "pages", "boom.ts"),
    `import { defineComponent } from "@weft-framework/runtime"\n` +
      `export function load(): never { throw new Error("password=hunter2") }\n` +
      `export const Page = defineComponent("Boom", () => ({ handlers: {}, render: () => "<p>hidden</p>" }))\n`,
  );
  const compiler = findCompiler(repo);
  const project = await loadProject(root, { compiler, outDir: join(root, ".weft", "build") });
  assert.equal(project.siteUrl, "https://demo.test");
  assert.equal(project.meta?.description, "From config");
  assert.equal(typeof project.middleware, "function");
  assert.ok(project.models.Note);
  assert.equal(project.models.Note.name, "Note");
  assert.ok(project.api?.["/api/health"]);
  assert.equal(project.routes["/api/health"], undefined);
  assert.ok(project.error);
  const app = createApp({ secret: "project-test-secret-0123456789abcdef", ...project, onError: () => {} });
  const home = await get(app, "/");
  assert.equal(home.res.headers.get("x-from"), "middleware");
  assert.match(home.html, /<!--weft:meta--><title>/);
  const health = await get(app, "/api/health");
  assert.equal(health.res.status, 200);
  assert.equal(JSON.parse(health.html).ok, true);
  const boom = await get(app, "/boom");
  assert.equal(boom.res.status, 500);
  assert.match(boom.html, /Something went wrong/);
  assert.equal(boom.html.includes("hunter2"), false);
});

test("project errors name the file", { skip: !hasCargo() }, async () => {
  const root = scaffold("broken-app");
  const compiler = findCompiler(repo);
  writeFileSync(join(root, "src", "pages", "contact.wx"), "component A() { view { <p/> } }\ncomponent B() { view { <p/> } }\n");
  await assert.rejects(
    loadProject(root, { compiler, outDir: join(root, ".weft", "a") }),
    (err: unknown) => err instanceof ProjectError && /src\/pages\/contact: 2 components/.test(err.message),
  );
  writeFileSync(join(root, "src", "pages", "contact.wx"), "component Page() { view { <p>{missing}</p> } }\n");
  await assert.rejects(loadProject(root, { compiler, outDir: join(root, ".weft", "b") }), /missing/);
});

test("src/auth.ts can export sign-in providers", { skip: !hasCargo() }, async () => {
  const root = scaffold("signin-app");
  const compiler = findCompiler(repo);
  writeFileSync(
    join(root, "src", "auth.ts"),
    [
      `import { google } from "@weft-framework/server"`,
      `export const providers = [google({ clientId: "c", clientSecret: "s" })]`,
      `export function signIn(identity: { subject: string }) { return "g:" + identity.subject }`,
      `export const signInError = "/signin"`,
      ``,
    ].join("\n"),
  );
  const project = await loadProject(root, { compiler, outDir: join(root, ".weft", "a") });
  assert.equal(project.auth?.user, undefined, "user() is optional with providers");
  assert.equal(project.auth?.providers?.[0].id, "google");
  assert.equal(project.auth?.signIn?.({ subject: "7" } as never), "g:7");
  assert.equal(project.auth?.signInError, "/signin");

  writeFileSync(join(root, "src", "auth.ts"), `export const providers = []\n`);
  await assert.rejects(
    loadProject(root, { compiler, outDir: join(root, ".weft", "b") }),
    (err: unknown) => err instanceof ProjectError && /signIn\(identity\)/.test(err.message),
  );
});

test("src/auth.ts can export a second factor", { skip: !hasCargo() }, async () => {
  const root = scaffold("two-factor-app");
  const compiler = findCompiler(repo);
  writeFileSync(
    join(root, "src", "auth.ts"),
    [
      `import { defineTwoFactor } from "@weft-framework/server"`,
      `export function user(id: string) { return { id } }`,
      `export const twoFactor = defineTwoFactor({ key: "k".repeat(32), issuer: "Acme", page: "/two-factor" })`,
      ``,
    ].join("\n"),
  );
  const project = await loadProject(root, { compiler, outDir: join(root, ".weft", "a") });
  assert.equal(project.auth?.twoFactor?.page, "/two-factor");
  assert.equal(await project.auth?.twoFactor?.needed("ada"), false);

  writeFileSync(join(root, "src", "auth.ts"), `export function user(id: string) { return { id } }\nexport const twoFactor = {}\n`);
  await assert.rejects(
    loadProject(root, { compiler, outDir: join(root, ".weft", "b") }),
    (err: unknown) => err instanceof ProjectError && /defineTwoFactor/.test(err.message),
  );
});

test("src/emails templates load with subject and samples, and preview in dev", { skip: !hasCargo() }, async () => {
  const root = scaffold("emails-app");
  mkdirSync(join(root, "src", "emails", "billing"), { recursive: true });
  writeFileSync(
    join(root, "src", "emails", "welcome.wx"),
    "export const subject = (p: { name: string }) => `Welcome,\n ${p.name}`\n" +
      'export const previews = { short: { name: "Ada" }, long: { name: "Ada <Lovelace>" } }\n' +
      "component Welcome(name: string) { view { <p>Hello {name}</p> } }\n",
  );
  writeFileSync(join(root, "src", "emails", "billing", "receipt.wx"), "component Receipt() { view { <p>Paid</p> } }\n");
  const compiler = findCompiler(repo);
  const project = await loadProject(root, { compiler, outDir: join(root, ".weft", "build") });
  assert.deepEqual(Object.keys(project.emails).sort(), ["billing/receipt", "welcome"]);
  assert.deepEqual(Object.keys(project.emails.welcome!.previews), ["short", "long"]);

  const { mailPreview } = await import("../src/mail.ts");
  const at = (p: string) => mailPreview(new Request(`${ORIGIN}/_weft/dev/mail${p}`), project.emails)!;
  const index = await at("").text();
  assert.match(index, /Templates \(2\)/);
  assert.match(index, /no `preview` export in src\/emails\/billing\/receipt/);
  const html = at("/t/welcome/long.html");
  assert.match(html.headers.get("content-security-policy")!, /^sandbox/);
  const body = await html.text();
  assert.match(body, /Hello Ada &lt;Lovelace&gt;/);
  assert.match(body, /<title>Welcome, Ada &lt;Lovelace&gt;<\/title>/, "one-line subject");
  assert.match(await at("/t/welcome/short.txt").text(), /^Subject: Welcome, Ada\n\nHello Ada/);
  assert.equal(at("/t/welcome/missing.html").status, 404);
  assert.equal(at("/t/../welcome/short.html").status, 404);

  writeFileSync(join(root, "src", "emails", "bad.wx"), "export const preview = 3\ncomponent Bad() { view { <p>x</p> } }\n");
  await assert.rejects(
    loadProject(root, { compiler, outDir: join(root, ".weft", "bad") }),
    (err: unknown) => err instanceof ProjectError && /src\/emails\/bad: `preview` is sample props/.test(err.message),
  );
});
