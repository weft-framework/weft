// SPDX-License-Identifier: MIT
//
// A small Chrome DevTools Protocol driver for the browser tests: no
// dependencies beyond Node's own WebSocket (Node 22+).
//
// `findBrowser()` looks for a Chromium-based browser: `WEFT_BROWSER`, then
// the usual install locations, then a Playwright download. `launch()` starts
// it headless with a throwaway profile and returns a `Browser`; each
// `newPage()` is a tab driven over a flattened session.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Path to a Chromium-based browser, or null. */
export function findBrowser() {
  if (process.env.WEFT_BROWSER) {
    return existsSync(process.env.WEFT_BROWSER) ? process.env.WEFT_BROWSER : null;
  }
  const env = process.env;
  const fixed = [
    join(env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    join(env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const p of fixed) {
    if (p && existsSync(p)) {
      return p;
    }
  }
  // A browser Playwright downloaded (`npx playwright install chromium`).
  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    join(env.LOCALAPPDATA ?? "", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
    join(homedir(), "Library", "Caches", "ms-playwright"),
  ];
  for (const root of roots) {
    if (!root || !existsSync(root)) {
      continue;
    }
    const dirs = readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of dirs) {
      for (const rel of [
        ["chrome-win64", "chrome.exe"],
        ["chrome-win", "chrome.exe"],
        ["chrome-linux", "chrome"],
        ["chrome-linux64", "chrome"],
        ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
      ]) {
        const p = join(root, d, ...rel);
        if (existsSync(p)) {
          return p;
        }
      }
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start `exe` headless and connect to it. */
export async function launch(exe) {
  const profile = mkdtempSync(join(tmpdir(), "weft-browser-"));
  const proc = spawn(
    exe,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  let wsUrl = null;
  for (let i = 0; i < 200 && !wsUrl; i++) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").split("\n");
      if (port && path) {
        wsUrl = `ws://127.0.0.1:${port.trim()}${path.trim()}`;
      }
    }
    if (!wsUrl) {
      await sleep(50);
    }
  }
  if (!wsUrl) {
    proc.kill();
    throw new Error(`${exe} did not open a DevTools port`);
  }
  const conn = await Connection.open(wsUrl);
  return new Browser(conn, proc, profile);
}

class Connection {
  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Connection(ws));
      ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.calls = new Map();
    this.listeners = new Set();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const call = this.calls.get(msg.id);
        this.calls.delete(msg.id);
        if (msg.error) {
          call?.reject(new Error(`${call.method}: ${msg.error.message}`));
        } else {
          call?.resolve(msg.result);
        }
        return;
      }
      for (const fn of this.listeners) {
        fn(msg);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    this.ws.close();
  }
}

export class Browser {
  constructor(conn, proc, profile) {
    this.conn = conn;
    this.proc = proc;
    this.profile = profile;
  }

  /** A new tab; `background` tabs report `document.visibilityState` as
   * "hidden", like a tab the user is not looking at. */
  async newPage({ background = false } = {}) {
    const { targetId } = await this.conn.send("Target.createTarget", { url: "about:blank", background });
    const { sessionId } = await this.conn.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this.conn, sessionId, targetId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    return page;
  }

  async close() {
    try {
      await this.conn.send("Browser.close");
    } catch {
      // Already gone.
    }
    this.conn.close();
    await new Promise((r) => {
      if (this.proc.exitCode !== null) {
        r();
      } else {
        this.proc.once("exit", r);
        setTimeout(() => {
          this.proc.kill();
          r();
        }, 3000);
      }
    });
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export class Page {
  constructor(conn, sessionId, targetId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
    /** Uncaught exceptions and console errors seen on the page. */
    this.errors = [];
    conn.listeners.add((msg) => {
      if (msg.sessionId !== sessionId) {
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        this.errors.push(d.exception?.description ?? d.text);
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        this.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
      }
    });
  }

  send(method, params = {}) {
    return this.conn.send(method, params, this.sessionId);
  }

  /** Evaluate `expr` in the page and return its (JSON) value. */
  async eval(expr) {
    const res = await this.send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`${expr}: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value;
  }

  /** Poll until `expr` is truthy; return its value. */
  async waitFor(expr, { timeout = 5000, what = expr } = {}) {
    const end = Date.now() + timeout;
    let last;
    for (;;) {
      try {
        last = await this.eval(expr);
        if (last) {
          return last;
        }
      } catch (err) {
        // A navigation can destroy the context mid-poll; retry.
        last = err;
      }
      if (Date.now() > end) {
        throw new Error(`timed out waiting for ${what} (last: ${String(last)})`);
      }
      await sleep(50);
    }
  }

  /** Load `url` in this tab. A fresh tab's own `about:blank` load can abort
   * the first navigation (`net::ERR_ABORTED`), so an aborted one is retried. */
  async goto(url) {
    const loaded = `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`;
    for (let attempt = 1; ; attempt++) {
      const res = await this.send("Page.navigate", { url });
      try {
        await this.waitFor(loaded, { timeout: res.errorText ? 0 : 3000, what: `load of ${url}` });
        return;
      } catch (err) {
        if (attempt === 4) {
          throw new Error(`${err.message}${res.errorText ? ` (${res.errorText})` : ""}`);
        }
      }
    }
  }

  /** Close the tab (and its live streams: a browser allows six HTTP/1.1
   * connections per host, and each live tab holds some open). */
  async close() {
    await this.conn.send("Target.closeTarget", { targetId: this.targetId });
  }

  /** Type into the focused element as a user would (input events). */
  async type(text) {
    for (const ch of text) {
      await this.send("Input.insertText", { text: ch });
    }
  }

  /** Press a named key ("Escape", "ArrowDown", "Enter", " ") as a user would. */
  async press(key) {
    const codes = { Escape: 27, Enter: 13, " ": 32, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35 };
    const base = { key, code: key === " " ? "Space" : key, windowsVirtualKeyCode: codes[key] ?? 0 };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(key === " " || key === "Enter" ? { text: key === " " ? " " : "\r" } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}
