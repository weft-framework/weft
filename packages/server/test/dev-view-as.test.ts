import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft-framework/runtime";
import { audit, defineModel, isReadOnlyActor, SqlAuditLog } from "@weft-framework/data";
import { openSqlite } from "@weft-framework/data/sqlite";
import { createApp, type App } from "../src/app.ts";
import { defineAction } from "../src/action.ts";
import { login } from "../src/auth.ts";

const ORIGIN = "http://app.test";
const PEOPLE = new Set(["ada", "dev"]);

function setup(devtools = true) {
  const Note = defineModel<{ id: string; owner: string; text: string }>(`DevNote${Math.random().toString(36).slice(2)}`, {
    fields: { id: "string", owner: "string", text: "string" },
    read: (a: { id: string }, r) => r.owner === a.id,
    write: (a: { id: string }, r) => r.owner === a.id,
  });
  Note.driver.insert({ id: "n1", owner: "ada", text: "ada's note" });
  const Home = defineComponent<{ who: string; notes: string[]; ro: boolean }>("DevHome", (p) => ({
    render: () =>
      `<p id="who">${escapeHtml(p.who)}</p><p id="ro">${p.ro}</p><ul>${p.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`,
  }));
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    devtools,
    routes: {
      "/": {
        component: Home as never,
        load: (ctx) => {
          const u = ctx.user as { id: string } | null;
          return { who: u ? u.id : "nobody", notes: u ? Note.as(u).all().map((n) => n.text) : [], ro: isReadOnlyActor(u) };
        },
      },
    },
    actions: { signIn: defineAction("signIn", [{ name: "id", type: "string" }], async (ctx, id: string) => void (await login(ctx, id))) } as never,
    auth: { user: (id) => (PEOPLE.has(id) ? { id } : null) },
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
  return { app, Note };
}

function client(app: App) {
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const page = async (cookie: string) => {
    const html = await (await app.fetch(new Request(`${ORIGIN}/`, { headers: { cookie } })))!.text();
    return {
      who: /<p id="who">([^<]*)<\/p>/.exec(html)?.[1],
      ro: /<p id="ro">([^<]*)<\/p>/.exec(html)?.[1] === "true",
      html,
      csrf: /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "",
    };
  };
  return {
    page,
    async signIn(id: string) {
      const anon = cookieOf((await app.fetch(new Request(`${ORIGIN}/`)))!);
      const res = (await app.fetch(
        new Request(`${ORIGIN}/?/signIn`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, cookie: anon, "x-weft-csrf": (await page(anon)).csrf },
          body: JSON.stringify({ id }),
        }),
      ))!;
      return cookieOf(res) || anon;
    },
    async anon() {
      return cookieOf((await app.fetch(new Request(`${ORIGIN}/`)))!);
    },
    async viewAs(cookie: string, body: object, headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" }) {
      const res = (await app.fetch(
        new Request(`${ORIGIN}/_weft/dev/view-as`, { method: "POST", headers: { ...headers, cookie }, body: JSON.stringify(body) }),
      ))!;
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
      }
      return { status: res.status, json };
    },
  };
}

test("dev view as: read-only, audited via the developer, and back", async () => {
  const { app } = setup();
  const c = client(app);
  const db = openSqlite(":memory:");
  const log = new SqlAuditLog(db);
  const stop = audit(log.sink, { reads: true });
  try {
    assert.equal((await c.viewAs(await c.anon(), { user: "ada" })).status, 409, "sign in first");
    const dev = await c.signIn("dev");
    assert.equal((await c.page(dev)).who, "dev");
    assert.equal((await c.viewAs(dev, { user: "ada" }, { "content-type": "application/json" })).status, 403, "same origin only");
    assert.equal((await c.viewAs(dev, { user: "ada" }, { origin: ORIGIN, "content-type": "text/plain" })).status, 403);
    assert.equal((await c.viewAs(dev, { user: "nobody" })).json.reason, "The app does not know that user (in that tenant).");
    assert.equal((await c.viewAs(dev, { user: "dev" })).json.reason, "That is you.");
    assert.equal((await c.viewAs(dev, { user: 7 })).status, 400);

    const on = await c.viewAs(dev, { user: "ada" });
    assert.equal(on.status, 200);
    assert.equal(on.json.viewing.user, "ada");
    const seen = await c.page(dev);
    assert.deepEqual([seen.who, seen.ro], ["ada", true]);
    assert.match(seen.html, /ada&#39;s note|ada's note/);
    const read = log.byActor("ada", { actions: ["read"] })[0]!;
    assert.equal(read.via, "dev", "the read is ada's view, looked at by dev");

    const off = await c.viewAs(dev, { user: null });
    assert.deepEqual(off.json, { ok: true, viewing: null });
    assert.deepEqual([(await c.page(dev)).who, (await c.page(dev)).ro], ["dev", false]);
  } finally {
    stop();
    db.close();
  }
});

test("dev view as is not served without devtools, nor in production", async () => {
  const off = setup(false);
  const c = client(off.app);
  assert.notEqual((await c.viewAs(await c.signIn("dev"), { user: "ada" })).status, 200);

  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const prod = setup(true);
    const p = client(prod.app);
    const dev = await p.signIn("dev");
    assert.notEqual((await p.viewAs(dev, { user: "ada" })).status, 200);
    assert.equal((await p.page(dev)).who, "dev");
  } finally {
    if (was === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = was;
  }
});
