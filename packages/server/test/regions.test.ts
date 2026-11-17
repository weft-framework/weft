import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setup } from "./fixtures/region-app.ts";
import { defineRegions, RegionWriteError } from "../src/regions.ts";
import { defineModel } from "@weft/data";

const here = dirname(fileURLToPath(import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => done(p));
    });
  });
}

async function startPrimary() {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "weft-region-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(here, "fixtures", "region-app.ts"), String(port), join(dir, "app.db")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  after(async () => {
    const gone = new Promise((done) => child.once("exit", done));
    child.kill();
    if (child.exitCode === null) await gone;
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await new Promise<void>((done, fail) => {
    child.stdout!.on("data", (b: Buffer) => b.toString().includes("ready") && done());
    child.on("exit", (c) => fail(new Error(`primary exited ${c}`)));
  });
  return `http://127.0.0.1:${port}`;
}

const until = async (ok: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("a replica follows the primary, serves reads, and sends the rest there", { timeout: 60_000 }, async () => {
  const primary = await startPrimary();
  const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/notes`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post(primary, { id: "n1", text: "first" })).status, 200);
  assert.equal((await post(primary, { id: "n2", text: "eu only", region: "fra" })).status, 200, "resident in fra");

  const { app, regions, Note } = setup({ region: "syd", primaryUrl: primary, maxLagMs: 3000 });
  after(() => regions.stop());
  await regions.start();
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`https://syd.example.com${path}`, { headers })) as Promise<Response>;

  assert.deepEqual(Note.driver.select([]).map((n) => n.id), ["n1"]);
  assert.ok(Note.driver.select([])[0]!.at instanceof Date, "dates survive");
  const page = await (await get("/notes")).text();
  assert.match(page, /served by syd/);
  assert.match(page, /<li>first<\/li>/);
  assert.ok(!page.includes("eu only"));

  const w = await app.fetch(new Request("https://syd.example.com/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "n3", text: "via syd" }) }))!;
  assert.deepEqual(await w.json(), { ok: true, region: "fra", host: "syd.example.com" });
  const seq = w.headers.getSetCookie().find((c) => c.startsWith("weft-region-seq="));
  assert.ok(seq && /HttpOnly/.test(seq) && /Secure/.test(seq), "the browser's position, for reading its own write");
  const mine = await (await get("/notes", { cookie: seq!.split(";")[0]! })).text();
  assert.match(mine, /served by syd/);
  assert.match(mine, /via syd/);

  await post(primary, { id: "n4", text: "later" });
  await until(() => Note.driver.select([]).some((n) => n.id === "n4"));

  assert.throws(() => Note.as("x").create({ id: "z", text: "z", at: new Date(), region: null }), RegionWriteError);
  assert.match(await (await get("/writes")).text(), /served by fra/);
  assert.match(await (await get("/counter")).text(), /served by fra/);
  assert.match(await (await get("/counter")).text(), /served by fra/);

  assert.equal((await fetch(`${primary}/_weft/region/snapshot`)).status, 403);
  assert.equal((await fetch(`${primary}/_weft/region/log?since=0`, { headers: { "x-weft-region-auth": `syd.${Math.floor(Date.now() / 1000)}.${"0".repeat(64)}` } })).status, 403);
  assert.equal((await get("/_weft/region/snapshot")).status, 404, "not on a replica");
  assert.equal((await fetch(`${primary}/notes`, { headers: { "x-weft-region-url": "https://evil.example/notes" } })).status, 403);
  assert.equal((await get("/_weft/health")).status, 200);
});

test("fly-replay and configuration", () => {
  const M = defineModel<{ id: string }>("RegionCfg", { fields: { id: "string" }, read: () => true, write: () => true });
  const base = { region: "syd", primary: "fra", primaryUrl: "https://fra.internal", secret: "x".repeat(32), models: [M] };
  assert.throws(() => defineRegions({ ...base, secret: "short" }), /32 characters/);
  assert.throws(() => defineRegions({ ...base, region: "Not A Region" }), /region name/);
  assert.throws(() => defineRegions({ ...base, models: [] }), /models/);
  const r = defineRegions({ ...base, forward: "fly-replay" });
  return r.forward(new Request("https://x/y", { method: "POST" })).then((res) => {
    assert.equal(res.status, 409);
    assert.equal(res.headers.get("fly-replay"), "region=fra");
  });
});
