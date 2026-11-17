// SPDX-License-Identifier: MIT
//
// Real-browser tests of the default starter: a project made by `weft new`
// (the component tour), served by the dev server and driven by two headless
// browsers, so two guests with separate sessions.
//
//   cargo build -p weft-cli
//   node --test tests/browser/welcome.test.mjs
//
// Skipped when no browser is found (set WEFT_BROWSER to one) or the
// compiler has not been built. The project is made under
// target/browser-welcome and served on a free local port.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser, launch } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const SITE = join(REPO, "target", "browser-welcome");
const WEFT = join(REPO, "target", "debug", process.platform === "win32" ? "weft.exe" : "weft");
const DEV = join(REPO, "packages", "server", "src", "dev.ts");

const exe = findBrowser();
const skip = !exe ? "no Chromium-based browser found (set WEFT_BROWSER)" : !existsSync(WEFT) ? "run `cargo build -p weft-cli` first" : false;

let alice = null;
let bob = null;
let a = null;
let b = null;
let server = null;
let port = 0;
const origin = () => `http://127.0.0.1:${port}`;

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function startServer() {
  const proc = spawn(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", DEV, SITE, "--port", String(port), "--host", "127.0.0.1"],
    { cwd: SITE, env: { ...process.env, WEFT_BIN: WEFT }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const end = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`dev server exited:\n${log}`);
    }
    try {
      const res = await fetch(`${origin()}/`);
      if (res.ok) {
        await res.body?.cancel();
        return proc;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > end) {
      proc.kill();
      throw new Error(`dev server did not start:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

function stopServer(proc) {
  return new Promise((r) => {
    if (!proc || proc.exitCode !== null) {
      r();
      return;
    }
    proc.once("exit", () => r());
    proc.kill();
  });
}

before(async () => {
  if (skip) {
    return;
  }
  rmSync(SITE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const made = spawnSync(WEFT, ["new", SITE], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`weft new failed:\n${made.stdout}${made.stderr}`);
  port = await freePort();
  server = await startServer();
  alice = await launch(exe);
  bob = await launch(exe);
  a = await alice.newPage();
  b = await bob.newPage();
});

after(async () => {
  await alice?.close();
  await bob?.close();
  await stopServer(server);
  rmSync(SITE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Navigate and wait until the page is live. */
async function go(page, path) {
  await page.goto(origin() + path);
  await page.waitFor(`document.querySelector('meta[name="weft-live"]')`, { what: `live meta on ${path}` });
}

function jsString(value) {
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const click = (label) =>
  `[...document.querySelectorAll('button')].find((x) => x.innerText.includes(${jsString(label)}) || x.getAttribute('aria-label') === ${jsString(label)}).click()`;

test("live data: a guest's new task reaches the other, whose delete the data rules refuse", { skip, timeout: 60_000 }, async () => {
  await go(a, "/live-data");
  await go(b, "/live-data");
  await a.eval(`document.querySelector('input[name=title]').focus()`);
  await a.type("Ship the beta");
  await a.press("Enter");
  await b.waitFor(`document.querySelector('[data-slot=live-table]')?.innerText.includes("Ship the beta")`, { what: "row on B" });
  await b.eval(click("Delete Ship the beta"));
  const refusal = await b.waitFor(`document.querySelector('[role=alert]')?.innerText`, { what: "refusal" });
  assert.match(refusal, /Only the owner/);
  assert.ok(await a.eval(`document.body.innerText.includes("Ship the beta")`), "still there for its owner");
});

test("audit: a refused write by one guest shows on the other's timeline", { skip, timeout: 60_000 }, async () => {
  await go(a, "/audit");
  await go(b, "/audit");
  const before = await a.eval(`document.querySelectorAll('[data-slot=audit-timeline] li').length`);
  await b.eval(click("Rename as you"));
  await a.waitFor(`document.querySelectorAll('[data-slot=audit-timeline] li').length > ${before}`, { what: "timeline on A" });
});

test("sharing: a link opens the note for another guest; a tampered one does not", { skip, timeout: 60_000 }, async () => {
  await go(a, "/sharing");
  await a.eval(click("Create a link"));
  const link = await a.waitFor(`(document.querySelector('[data-slot=share-link] input') || {}).value`, { what: "link" });
  assert.ok(link.startsWith(origin() + "/shared/"), link);
  await go(b, link.slice(origin().length));
  assert.doesNotMatch(await b.eval(`document.querySelector('main').innerText`), /403/);
  const bad = link.slice(0, -3) + (link.endsWith("A") ? "BBB" : "AAA");
  await go(b, bad.slice(origin().length));
  assert.match(await b.eval(`document.querySelector('main').innerText`), /403/);
});

test("forms: the server's field errors land on the fields", { skip, timeout: 60_000 }, async () => {
  await go(a, "/forms");
  await a.eval(`document.querySelector('input[name=email]').focus()`);
  await a.type("nope");
  await a.eval(`document.querySelector('[data-slot=server-form] button[type=submit], [data-slot=server-form] button').click()`);
  await a.waitFor(`document.querySelector('input[name=email]')?.getAttribute('aria-invalid') === 'true'`, { what: "field error" });
  const described = await a.eval(`document.querySelector('input[name=email]').getAttribute('aria-describedby')`);
  assert.ok(described && (await a.eval(`!!document.getElementById(${JSON.stringify(described)})`)), "error is linked to the field");
});

test("presence: a guest who leaves a page drops off it at once", { skip, timeout: 60_000 }, async () => {
  const count = `document.querySelector('main').innerText.match(/Only you on this page|\\d+ on this page/)?.[0]`;
  await go(a, "/presence");
  await go(b, "/presence");
  await b.waitFor(`${count} === "2 on this page"`, { what: "both on /presence", timeout: 15_000 });
  // Editing now: B focuses the title, A sees it.
  await b.eval(`document.querySelector('#rn-title').focus()`);
  await a.waitFor(`/editing|typing/i.test(document.querySelector('[data-slot=editing-now]')?.innerText ?? "")`, { what: "editing on A", timeout: 15_000 });
  // A navigates away (a client navigation, then a full load): B sees it
  // well before the 15 s presence grace period would have.
  const left = Date.now();
  await go(a, "/forms");
  await b.waitFor(`${count} === "Only you on this page"`, { what: "A gone from /presence", timeout: 8_000 });
  assert.ok(Date.now() - left < 8_000);
});
