// SPDX-License-Identifier: MIT
//
// Real-browser tests: the starter app (crates/weft-cli/templates/app) plus
// the pages in fixtures/, served by the dev server and driven in headless
// Chromium over the DevTools Protocol (cdp.mjs).
//
//   cargo build -p weft-cli
//   node --test tests/browser/browser.test.mjs
//
// Skipped when no browser is found (set WEFT_BROWSER to one) or the
// compiler has not been built. The site is assembled under
// target/browser-site and served on a free local port.

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser, launch } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const SITE = join(REPO, "target", "browser-site");
const WEFT = join(REPO, "target", "debug", process.platform === "win32" ? "weft.exe" : "weft");
const DEV = join(REPO, "packages", "server", "src", "dev.ts");

const exe = findBrowser();
const skip = !exe ? "no Chromium-based browser found (set WEFT_BROWSER)" : !existsSync(WEFT) ? "run `cargo build -p weft-cli` first" : false;

let browser = null;
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

function buildSite() {
  rmSync(SITE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  cpSync(join(REPO, "crates", "weft-cli", "templates", "app"), SITE, { recursive: true });
  const pkg = join(SITE, "package.json");
  writeFileSync(pkg, readFileSync(pkg, "utf8").replace("{{name}}", "browser-site"));
  for (const page of ["focus", "islands", "streaming", "npm", "tailwind", "use", "shadcn"]) {
    copyFileSync(join(HERE, "fixtures", `${page}.wx`), join(SITE, "src", "pages", `${page}.wx`));
  }
  // Every registry component, copied in by the real CLI (for the shadcn page).
  const added = spawnSync(WEFT, ["add", "--all", "--dir", SITE], { encoding: "utf8" });
  if (added.status !== 0) throw new Error(`weft add failed:\n${added.stdout}${added.stderr}`);
  // Tailwind (the repository's install) for the tailwind page.
  writeFileSync(join(SITE, "src", "app.css"), '@import "tailwindcss";\n@theme { --color-brand: rgb(10, 127, 90); }\n');
  // An "installed" package for the npm page.
  cpSync(join(HERE, "fixtures", "packages"), join(SITE, "node_modules"), { recursive: true });
  // Translations: catalogs, src/i18n.ts, its middleware and htmlAttributes,
  // and the /intl page.
  cpSync(join(HERE, "fixtures", "i18n"), SITE, { recursive: true });
}

/** Start the dev server and wait until it answers. */
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
  buildSite();
  port = await freePort();
  server = await startServer();
  browser = await launch(exe);
});

after(async () => {
  await browser?.close();
  await stopServer(server);
  rmSync(SITE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// Tabs close after each test: each live tab keeps streams open, and the
// browser allows six HTTP/1.1 connections per host.
const tabs = [];
afterEach(async () => {
  for (const tab of tabs.splice(0)) {
    await tab.close().catch(() => {});
  }
});

/** A fresh tab on `path`, with a marker that a full reload would clear. */
async function open(path, { background = false } = {}) {
  const page = await browser.newPage({ background });
  tabs.push(page);
  await page.goto(origin() + path);
  await page.waitFor(`document.querySelector('meta[name="weft-live"]')`, { what: "live meta" });
  await page.eval("window.__kept = 1");
  return page;
}

const diag = (msg) => process.env.WEFT_BROWSER_DEBUG && console.error(`[browser] ${msg}`);
const text = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.textContent ?? "")`;

test("island code runs an npm package resolved for the browser", { skip }, async () => {
  const page = await open("/npm");
  // First rendered on the server (with the package's node build) ...
  await page.waitFor(`${text("#grow")} === "WEFT" && ${text("#count")} === "4 chars"`, { what: "server render" });
  // ... then re-evaluated in the browser with its browser build.
  await page.eval(`document.querySelector("#grow").click()`);
  await page.waitFor(`${text("#grow")} === "WEFT!" && ${text("#count")} === "5 chars"`, {
    what: "browser-side package call",
  });
  const scripts = await page.eval(
    `performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname).filter((p) => p.includes("/npm/"))`,
  );
  assert.ok(scripts.some((p) => p.endsWith("/weft-fixture-text@1.0.0/browser.mjs")), scripts.join("\n"));
  assert.ok(!scripts.some((p) => p.includes("node.cjs")), "the node build never reaches the browser");
  assert.deepEqual(page.errors, []);
});

test("tailwind utilities and a component's @apply style the page", { skip }, async () => {
  const page = await open("/tailwind");
  const style = (sel, prop) => page.eval(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).${prop}`);
  assert.equal(await style("#tw-title", "fontSize"), "30px", "text-3xl from app.css");
  assert.equal(await style("#tw-title", "fontWeight"), "700");
  assert.equal(await style("#tw-title", "color"), "rgb(10, 127, 90)", "the theme's --color-brand");
  assert.equal(await style("#tw-go", "backgroundColor"), "rgb(10, 127, 90)", "@apply bg-brand, scoped");
  assert.equal(await style("#tw-go", "paddingLeft"), "16px");
  // rounded-lg is var(--radius-lg): the site's theme (from `weft add`, the
  // shadcn tokens) sets --radius to 0.625rem.
  assert.equal(await style("#tw-go", "borderTopLeftRadius"), "10px");
  // Still a live page: the styled button answers events.
  await page.eval(`document.querySelector("#tw-go").click()`);
  await page.waitFor(`${text("#tw-go")} === "Pressed 1"`, { what: "live click" });
  assert.deepEqual(page.errors, []);
});

test("use: attachments run on the real element and follow their values", { skip }, async () => {
  const page = await open("/use");
  const data = (sel, key) => page.eval(`document.querySelector(${JSON.stringify(sel)}).dataset.${key} ?? null`);
  await page.waitFor(`document.activeElement?.id === "use-focus"`, { what: "focused on mount" });
  assert.equal(await data("#use-toggle", "size"), "off");
  await page.eval(`document.querySelector("#use-toggle").click()`);
  await page.waitFor(`document.querySelector("#use-toggle").dataset.size === "true"`, { what: "re-run on client state" });
  assert.equal(await data("#use-toggle", "cleaned"), "1", "the previous run's cleanup ran first");
  // A server value, in markup passed to <Card>, follows the server patch.
  assert.equal(await data("#use-title", "title"), "first");
  await page.eval(`document.querySelector("#use-rename").click()`);
  await page.waitFor(`document.querySelector("#use-title").dataset.title === "second"`, { what: "server value" });
  assert.equal(await data("#use-toggle", "size"), "true", "an unchanged attachment is kept");
  assert.deepEqual(page.errors, []);
});

test("components from weft add work with keyboard and pointer, and survive live patches", { skip, timeout: 60_000 }, async () => {
  const page = await open("/shadcn");
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const focused = (sel) => `document.activeElement === ${q(sel)}`;

  // Optional props that were not given leave their attributes out.
  assert.equal(await page.eval(`document.querySelectorAll('[aria-label=""],[name=""],[popovertarget=""],[for=""]').length`), 0);

  // The theme (src/theme.ts from weft add) styles the Tailwind utilities.
  const bg = await page.eval(`getComputedStyle(${q("#hit")}).backgroundColor`);
  assert.notEqual(bg, "rgba(0, 0, 0, 0)", "bg-primary resolved from the theme tokens");

  // Dialog: opened by its trigger, Escape closes it, focus goes back.
  await page.eval(`${q("[commandfor=edit][command=show-modal]")}.focus(); ${q("[commandfor=edit][command=show-modal]")}.click()`);
  await page.waitFor(`${q("#edit")}.open && ${q("#edit")}.dataset.state === "open"`, { what: "dialog open" });
  await page.press("Escape");
  await page.waitFor(`!${q("#edit")}.open && ${q("#edit")}.dataset.state === "closed"`, { what: "Escape closes" });
  await page.waitFor(focused("[commandfor=edit][command=show-modal]"), { what: "focus back on the trigger" });

  // Tabs: arrows move the selection; a live patch keeps it.
  await page.eval(`${q("[role=tab][data-value=account]")}.focus()`);
  await page.press("ArrowRight");
  await page.waitFor(`${q("[role=tab][data-value=password]")}.getAttribute("aria-selected") === "true"`, { what: "arrow selects" });
  assert.equal(await page.eval(`${q("[role=tabpanel][data-value=password]")}.hidden`), false);
  assert.equal(await page.eval(`${q("[role=tabpanel][data-value=account]")}.hidden`), true);
  await page.eval(`${q("#hit")}.click()`);
  await page.waitFor(`${q("#hits")}.textContent.includes("hits 1")`, { what: "server patch" });
  assert.equal(await page.eval(`${q("[role=tab][data-value=password]")}.getAttribute("aria-selected")`), "true", "selection kept");
  assert.equal(await page.eval(`${q("[role=tabpanel][data-value=password]")}.hidden`), false, "panel kept");

  // Dropdown menu: first item focused, arrows move, checkbox item flips.
  await page.eval(`${q("#menu-open")}.focus(); ${q("#menu-open")}.click()`);
  await page.waitFor(`${q("#m")}.matches(":popover-open") && ${focused("#menu-first")}`, { what: "menu open, first item focused" });
  await page.press("ArrowDown");
  await page.press("ArrowDown");
  await page.waitFor(focused("#menu-check"), { what: "arrows move" });
  await page.press("Enter");
  await page.waitFor(`${q("#menu-check")}.getAttribute("aria-checked") === "true"`, { what: "checkbox item flips" });
  await page.press("Escape");
  await page.waitFor(`!${q("#m")}.matches(":popover-open") && ${focused("#menu-open")}`, { what: "Escape closes, focus back" });

  // Select: opens on ArrowDown, picks with Enter, fills the form field.
  await page.eval(`${q("#fruit-trigger")}.focus()`);
  await page.press("ArrowDown");
  await page.waitFor(`${q("#fruit")}.matches(":popover-open")`, { what: "listbox open" });
  await page.waitFor(`document.activeElement?.getAttribute("role") === "option"`, { what: "option focused" });
  await page.press("ArrowDown");
  await page.press("Enter");
  await page.waitFor(`new FormData(${q("#f")}).get("fruit") === "banana"`, { what: "value in the form" });
  assert.equal(await page.eval(`${q("#fruit-trigger [data-slot=select-value]")}.textContent`), "Banana");
  await page.waitFor(`!${q("#fruit")}.matches(":popover-open") && ${focused("#fruit-trigger")}`, { what: "closed, focus back" });

  // Toggle group: single selection reaches the form.
  await page.eval(`${q("[data-slot=toggle-group-item][data-value=right]")}.click()`);
  await page.waitFor(`new FormData(${q("#f")}).get("align") === "right"`, { what: "toggle group value" });
  assert.equal(await page.eval(`${q("[data-slot=toggle-group-item][data-value=left]")}.getAttribute("aria-pressed")`), "false");

  // Input OTP: typing fills the boxes.
  await page.eval(`${q("input[name=code]")}.focus()`);
  await page.type("12a34");
  await page.waitFor(`${q("[data-slot=input-otp]")}.hasAttribute("data-complete")`, { what: "code complete" });
  assert.equal(await page.eval(`${q("input[name=code]")}.value`), "1234", "the pattern drops letters");
  assert.equal(await page.eval(`[...document.querySelectorAll("[data-slot=input-otp-char]")].map((c) => c.textContent).join("")`), "1234");

  // Calendar: a month grid with the value selected; arrows and Enter pick.
  await page.waitFor(`!!${q("#cal button[data-date='2026-11-14']")}`, { what: "grid built" });
  assert.equal(await page.eval(`${q("#cal button[data-selected]")}.dataset.date`), "2026-11-14");
  await page.eval(`${q("#cal button[data-date='2026-11-14']")}.focus()`);
  await page.press("ArrowRight");
  await page.waitFor(focused("#cal button[data-date='2026-11-15']"), { what: "arrow moves a day" });
  await page.press("Enter");
  await page.waitFor(`new FormData(${q("#f")}).get("due") === "2026-11-15"`, { what: "date picked" });

  // Accordion: native <details name> keeps one open.
  // Inert components draw inline, so <summary> is the details' own child.
  assert.equal(await page.eval(`document.querySelectorAll("details[name=faq] > summary").length`), 2);
  await page.eval(`document.querySelectorAll("details[name=faq] summary")[1].click()`);
  await page.waitFor(`!document.querySelectorAll("details[name=faq]")[0].open && document.querySelectorAll("details[name=faq]")[1].open`, { what: "one open at a time" });

  assert.deepEqual(page.errors, []);
});

test("i18n: locale prefixes, localised paths, plurals that follow live state, lang and dir", { skip }, async () => {
  const html = (page, attr) => page.eval(`document.documentElement.getAttribute(${JSON.stringify(attr)})`);
  const en = await open("/intl");
  assert.equal(await html(en, "lang"), "en");
  assert.equal(await html(en, "dir"), "ltr");
  assert.equal(await en.eval(text("#intl-title")), "Shopping");
  assert.equal(await en.eval(text("#intl-items")), "Your cart is empty");
  await en.eval(`document.querySelector("#intl-add").click()`);
  await en.waitFor(`${text("#intl-items")} === "1 item in your cart"`, { what: "English plural after a live event" });

  const cs = await open("/cs/mezinarodni");
  assert.equal(await html(cs, "lang"), "cs");
  assert.equal(await cs.eval(text("#intl-title")), "Nákupy");
  for (let i = 0; i < 3; i += 1) await cs.eval(`document.querySelector("#intl-add").click()`);
  await cs.waitFor(`${text("#intl-items")} === "3 položky v košíku"`, { what: "Czech 'few' plural" });
  assert.equal(await cs.eval(text("#intl-fallback")), "Only in English", "an untranslated key falls back");
  assert.equal(await cs.eval(text("#intl-date")), "14. listopadu 2026");
  assert.deepEqual(
    await cs.eval(`[...document.querySelectorAll("a[hreflang]")].map((a) => a.hreflang + " " + a.getAttribute("href"))`),
    ["en /intl", "cs /cs/mezinarodni", "ar /ar/intl", "x-default /intl"],
  );

  const ar = await open("/ar/intl");
  assert.equal(await html(ar, "dir"), "rtl");
  assert.equal(await ar.eval(text("#intl-title")), "التسوق");

  // One URL per page: the canonical path under a prefix redirects.
  const moved = await fetch(`${origin()}/cs/intl?x=1`, { redirect: "manual" });
  assert.equal(moved.status, 307);
  assert.equal(new URL(moved.headers.get("location")).pathname + new URL(moved.headers.get("location")).search, "/cs/mezinarodni?x=1");
  for (const page of [en, cs, ar]) assert.deepEqual(page.errors, []);
});

test("a live event round-trips and patches the page", { skip }, async () => {
  const page = await open("/");
  await page.eval(`document.querySelector(".counter button").click()`);
  await page.waitFor(`${text(".counter button")}.includes("Clicked 1 times")`);
  await page.eval(`document.querySelector(".counter button").click()`);
  await page.waitFor(`${text(".counter button")}.includes("Clicked 2 times")`);
  assert.equal(await page.eval("window.__kept"), 1, "no reload");
  assert.deepEqual(page.errors, []);
});

test("a link click navigates without a reload and the new page is live", { skip }, async () => {
  const page = await open("/");
  await page.eval(`[...document.querySelectorAll("nav a")].find((a) => a.textContent === "About").click()`);
  await page.waitFor(`location.pathname === "/about" && ${text("h1")} === "About"`);
  assert.equal(await page.eval("window.__kept"), 1, "no reload");
  assert.match(await page.eval("document.title"), /About/);
  await page.eval("history.back()");
  await page.waitFor(`location.pathname === "/" && !!document.querySelector(".counter")`);
  await page.eval(`document.querySelector(".counter button").click()`);
  await page.waitFor(`${text(".counter button")}.includes("Clicked 1 times")`);
  assert.equal(await page.eval("window.__kept"), 1);
  assert.deepEqual(page.errors, []);
});

test("focus and caret stay in a field whose row the server moves", { skip }, async () => {
  const page = await open("/focus");
  await page.eval(`document.querySelector('input[name="row2"]').focus()`);
  await page.type("ab");
  // The row sorts first once the server has the name.
  await page.waitFor(`document.querySelector("#rows li input").name === "row2" && ${text("#rows li .name")} === "ab"`);
  const state = await page.eval(`(() => {
    const el = document.activeElement;
    return { name: el?.name, value: el?.value, caret: el?.selectionStart };
  })()`);
  assert.deepEqual(state, { name: "row2", value: "ab", caret: 2 });
  await page.type("c");
  await page.waitFor(`${text("#rows li .name")} === "abc"`);
  assert.equal(await page.eval("document.activeElement?.value"), "abc");
  assert.deepEqual(page.errors, []);
});

test("background tabs give their connections back", { skip, timeout: 60_000 }, async () => {
  // Three live tabs hold all six HTTP/1.1 connections the browser allows
  // per host (a live stream and the dev stream each).
  const hidden = [];
  for (let i = 0; i < 3; i++) {
    hidden.push(await open("/", { background: true }));
  }
  assert.equal(await hidden[0].eval("document.visibilityState"), "hidden");
  // Hidden tabs let their streams go after ten seconds.
  await new Promise((r) => setTimeout(r, 11_000));
  const page = await open("/");
  await page.eval(`document.querySelector(".counter button").click()`);
  await page.waitFor(`${text(".counter button")}.includes("Clicked 1 times")`);
  assert.deepEqual(page.errors, []);
});

test("after a server restart the page resumes with its island state", { skip, timeout: 120_000 }, async () => {
  const page = await open("/islands");
  await page.eval(`document.getElementById("toggle").click()`);
  await page.waitFor(`${text("#toggle")} === "Hide details"`);
  await page.eval(`document.getElementById("like").click()`);
  await page.waitFor(`${text("#like")} === "Like (1)"`);
  const before = await page.eval(`document.querySelector('meta[name="weft-live"]').content`);

  // A restart loses every live page (and the session secret).
  const t0 = Date.now();
  await stopServer(server);
  diag(`stopped after ${Date.now() - t0} ms`);
  server = await startServer();
  diag(`restarted after ${Date.now() - t0} ms`);

  // The old stream is refused, the page is rendered again in place.
  await page.waitFor(`document.querySelector('meta[name="weft-live"]')?.content !== ${JSON.stringify(before)}`, {
    timeout: 45_000,
    what: "a new live page id",
  });
  assert.equal(await page.eval("window.__kept"), 1, "no reload");
  assert.equal(await page.eval(text("#toggle")), "Hide details", "client state kept");
  assert.equal(await page.eval(`document.getElementById("details").hidden`), false);
  assert.equal(await page.eval(text("#like")), "Like (0)", "server state is the new server's");
  await page.eval(`document.getElementById("like").click()`);
  await page.waitFor(`${text("#like")} === "Like (1)"`, { what: "an event on the new live page" });
  assert.deepEqual(page.errors, []);
});

test("a streamed {#await} result is in place before the page goes live", { skip }, async () => {
  const page = await open("/streaming");
  await page.waitFor(`${text("#state")} === "ready"`, { what: "settled value" });
  assert.equal(await page.eval(`document.querySelectorAll("template[data-weft-stream], body > script:not([src])").length`), 0);
  await page.eval(`document.querySelector("#inc").click()`);
  await page.waitFor(`${text("#inc")} === "1"`, { what: "live click after the stream" });
  assert.equal(await page.eval(text("#state")), "ready");
  assert.equal(await page.eval("window.__kept"), 1);
});

test("dev overlay: Alt+Shift+D opens the panel with the page's tree and live messages", { skip }, async () => {
  const page = await open("/tailwind");
  await page.eval(`document.querySelector("#tw-go").click()`);
  await page.waitFor(`${text("#tw-go")} === "Pressed 1"`, { what: "live click" });
  const panel = `document.getElementById("weft-dev-panel")`;
  await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "D", code: "KeyD", altKey: true, shiftKey: true }))`);
  await page.waitFor(`${panel}?.textContent.includes("Last render") && ${panel}.textContent.includes("Page")`, { what: "tree view" });
  await page.eval(`${panel}.querySelector("button[data-view=messages]").click()`);
  await page.waitFor(`${panel}.textContent.includes("event") && ${panel}.textContent.includes("patch")`, { what: "messages view" });
  assert.equal(await page.eval(`${panel}.querySelectorAll("[style]").length > 0`), true, "styled through CSSOM");
  await page.eval(`${panel}.querySelector("button[data-view=access]").click()`);
  await page.waitFor(`${panel}.textContent.includes("decisions")`, { what: "access view" });
  await page.eval(`[...${panel}.querySelectorAll("button")].find((b) => b.textContent === "Close").click()`);
  await page.waitFor(`!${panel}`, { what: "closed" });
  assert.deepEqual(page.errors, []);
});
