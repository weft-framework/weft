import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Component, EventPayload } from "@weft/runtime";
import { LivePage } from "../src/live.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const out = join(here, ".weft");

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function compile(example: string): Promise<Record<string, unknown>> {
  const ts = execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "emit", example], {
    cwd: repo,
    encoding: "utf8",
  });
  mkdirSync(out, { recursive: true });
  const file = join(out, example.replace(/[\\/]/g, "_").replace(/\.wx$/, ".ts"));
  writeFileSync(file, ts);
  return import(pathToFileURL(file).href);
}

test("compiled Counter.wx counts on the server", { skip: !hasCargo() }, async () => {
  const mod = await compile("examples/counter/Counter.wx");
  const Counter = mod.Counter as Component<Record<string, never>>;

  const page = new LivePage(Counter, {});
  const html = page.render();
  const scope = /class="counter (w-[0-9a-z]+)"/.exec(html)?.[1];
  assert.ok(scope, html);
  assert.ok(html.startsWith(`<weft-c data-weft-c="r"><div class="counter ${scope}" data-weft-vars="{&quot;--${scope}-0&quot;:&quot;0&quot;}">`), html);
  assert.ok(!html.includes(`--${scope}-1`), "one property per distinct expression");
  assert.match(html, /Count: 0 \(doubled: 0\)/);
  assert.match(html, new RegExp(`<button data-weft-on-click="increment" class="${scope}">\\+1</button>`));
  assert.ok(Counter.def.css?.includes(`:where(.${scope})`), Counter.def.css);

  for (let i = 1; i <= 2; i++) {
    const [msg] = await page.dispatch({
      t: "event",
      id: "r",
      handler: "increment",
      event: { type: "click" },
      seq: i,
    });
    assert.ok(msg.t === "patch", JSON.stringify(msg));
    assert.match(msg.html, new RegExp(`Count: ${i} \\(doubled: ${i * 2}\\)`));
  }

  assert.match(Counter({}), /Count: 0/);
});

test("compiled TodoApp.wx: forms, bound arguments, child components", { skip: !hasCargo() }, async () => {
  const mod = await compile("examples/todo/TodoApp.wx");
  const TodoApp = mod.TodoApp as Component<Record<string, never>>;
  const page = new LivePage(TodoApp, {});
  let seq = 0;
  const send = async (handler: string, event: EventPayload, args?: string) => {
    const msgs = await page.dispatch({ t: "event", id: "r", handler, event, seq: ++seq, args });
    assert.equal(msgs.length, 1, JSON.stringify(msgs));
    const [m] = msgs;
    assert.ok(m.t === "patch", JSON.stringify(m));
    return m.html;
  };
  const tokens = (html: string, type: string) =>
    [...html.matchAll(new RegExp(`data-weft-args-${type}="(\\d+)"`, "g"))].map((m) => m[1]);

  const first = page.render();
  assert.match(first, /Nothing to do yet\./);
  assert.match(first, /<\/p>\s*<p class="stats">0 of 0 open<\/p>\s*<\/section>/);
  assert.equal(page.size, 1);
  assert.match(first, /<button data-weft-busy>Add<\/button>/);

  await send("add", { type: "submit", form: { title: "  Write docs " } });
  let html = await send("add", { type: "submit", form: { title: "Ship <v0.1>" } });
  assert.match(html, /Write docs/);
  assert.match(html, /Ship &lt;v0\.1&gt;/, "escaped");
  assert.match(html, /2 of 2 open/);
  assert.ok(!html.includes(" checked"));
  assert.match(html, /data-weft-mod-click="confirm" data-weft-confirm-click="Remove this task\?"/);

  html = await send("toggle", { type: "change", checked: true }, tokens(html, "change")[1]);
  assert.equal(html.match(/ checked/g)?.length, 1);
  assert.match(html, /1 of 2 open/);

  html = await send("remove", { type: "click" }, tokens(html, "click")[0]);
  assert.ok(!html.includes("Write docs"));
  assert.match(html, /Ship &lt;v0\.1&gt;/);
  assert.match(html, /0 of 1 open/);
  assert.equal(page.size, 1, "inert stats never becomes an instance");

  assert.deepEqual(
    await page.dispatch({ t: "event", id: "r", handler: "add", event: { type: "submit", form: {} }, seq: ++seq }),
    [{ t: "ack", ack: seq }],
  );
});
