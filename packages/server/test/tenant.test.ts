import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml } from "@weft-framework/runtime";
import { defineModel } from "@weft-framework/data";
import { openSqlite } from "@weft-framework/data/sqlite";
import { defineAccess } from "@weft-framework/core";
import { createApp, type App } from "../src/app.ts";
import { defineAction } from "../src/action.ts";
import { login, MemorySessionStore, SqlSessionStore, switchTenant } from "../src/auth.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

interface Task {
  id: string;
  org: string;
  title: string;
}

function setup() {
  const access = defineAccess({
    scopes: { org: {} },
    permissions: { "task.read": "See tasks", "task.edit": "Change tasks" },
    roles: {
      owner: { scope: "org", permissions: ["*"] },
      viewer: { scope: "org", permissions: ["task.read"] },
    },
    owner: "owner",
  });
  type Actor = ReturnType<typeof access.user>;
  const Task = defineModel<Task>("Task", {
    fields: { id: "string", org: "string", title: "string" },
    attrs: { org: { tenant: true } },
    read: (a: Actor, t) => a.can("task.read", t.org),
    write: (a: Actor, t) => a.can("task.edit", t.org),
  });
  const acme = access.createTenant("ada", { name: "Acme" });
  const globex = access.createTenant("bob", { name: "Globex" });
  const initech = access.createTenant("bob", { name: "Initech" });
  access.assign("bob", { user: "ada", role: "viewer", scope: globex.id });
  Task.as(access.user("ada").in(acme.id)!).create({ id: "a1", title: "Acme plan" } as Task);
  Task.as(access.user("bob").in(globex.id)!).create({ id: "g1", title: "Globex plan" } as Task);
  Task.as(access.user("bob").in(initech.id)!).create({ id: "i1", title: "Initech plan" } as Task);

  const Board = defineComponent("Board", (props: { org: string; tasks: string }) => ({
    handlers: { noop() {} },
    render: () =>
      `<p id="org">${escapeHtml(props.org)}</p><p id="tasks">${escapeHtml(props.tasks)}</p>` +
      `<button data-weft-on-click="noop">x</button>`,
  }));
  const signIn = defineAction("signIn", [{ name: "id", type: "string" }], async (ctx, id: string) => {
    await login(ctx, id);
  });
  const use = defineAction("use", [{ name: "tenant", type: "string" }], (ctx, tenant: string) =>
    switchTenant(ctx, tenant === "" ? null : tenant),
  );
  const errors: unknown[] = [];
  const store = new MemorySessionStore();
  const app = createApp({
    secret: SECRET,
    transports: ["sse"],
    routes: {
      "/": {
        component: Board as never,
        load: (ctx) => {
          const actor = ctx.user as Actor | null;
          return {
            org: actor?.tenant ?? "none",
            tasks: actor ? Task.as(actor).all().map((t) => t.title).join(",") : "",
          };
        },
      },
      "/sneaky": {
        component: Board as never,
        load: async (ctx) => {
          await switchTenant(ctx, acme.id);
          return { org: "never", tasks: "" };
        },
      },
    },
    actions: { signIn: signIn as never, use: use as never },
    onError: (e) => errors.push(e),
    auth: {
      store,
      user: (id, tenant) => {
        const u = access.user(id);
        return (tenant !== undefined ? u.in(tenant) : null) ?? u;
      },
    },
  });
  return { app, access, acme, globex, initech, errors, store };
}

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

async function page(app: App, cookie = "", path = "/") {
  const res = (await app.fetch(new Request(ORIGIN + path, { headers: cookie ? { cookie } : {} })))!;
  const html = await res.text();
  return {
    res,
    cookie: cookieOf(res) || cookie,
    org: /<p id="org">([^<]*)<\/p>/.exec(html)?.[1],
    tasks: /<p id="tasks">([^<]*)<\/p>/.exec(html)?.[1],
    csrf: /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "",
    lid: /name="weft-live" content="([^"]+)"/.exec(html)?.[1] ?? "",
  };
}

async function call(app: App, name: string, body: object, cookie: string, csrf: string) {
  const res = (await app.fetch(
    new Request(`${ORIGIN}/?/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": csrf },
      body: JSON.stringify(body),
    }),
  ))!;
  return { res, body: (await res.json()) as { ok: boolean; value?: unknown } };
}

async function stream(app: App, cookie: string, lid: string) {
  const res = (await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } })))!;
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const next = async (ms = 1000): Promise<Record<string, unknown> | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const m = /data: (.*)\n\n/.exec(buf);
      if (m) {
        buf = buf.slice(m.index + m[0].length);
        return JSON.parse(m[1]) as Record<string, unknown>;
      }
      pending ??= reader.read();
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now())));
      const got = await Promise.race([pending, timeout]);
      if (got === null || got.done) return null;
      pending = null;
      buf += dec.decode(got.value);
    }
  };
  const patched = async (text: string): Promise<boolean> => {
    for (;;) {
      const msg = await next();
      if (msg === null) return false;
      if (msg.t === "patch" && String(msg.html).includes(text)) return true;
    }
  };
  assert.equal((await next())?.t, "hello");
  return { next, patched, close: () => reader.cancel() };
}

async function signedIn(app: App, id: string) {
  const anon = await page(app);
  const { res } = await call(app, "signIn", { id }, anon.cookie, anon.csrf);
  return page(app, cookieOf(res));
}

test("switching tenant re-renders the session's live pages as the new actor", async () => {
  const { app, acme, globex } = setup();
  const ada = await signedIn(app, "ada");
  assert.equal(ada.org, "none");
  assert.equal(ada.tasks, "", "acting in no tenant: no @tenant rows");

  const live = await stream(app, ada.cookie, ada.lid);
  const toAcme = await call(app, "use", { tenant: acme.id }, ada.cookie, ada.csrf);
  assert.equal(toAcme.body.value, true);
  assert.equal(toAcme.res.headers.get("set-cookie"), null, "the session id stays");
  assert.ok(await live.patched("Acme plan"), "the open page re-rendered without a reload");

  const later = await page(app, ada.cookie);
  assert.equal(later.org, acme.id);
  assert.equal(later.tasks, "Acme plan");

  const toGlobex = await call(app, "use", { tenant: globex.id }, ada.cookie, ada.csrf);
  assert.equal(toGlobex.body.value, true);
  assert.ok(await live.patched("Globex plan"));
  assert.equal((await page(app, ada.cookie)).tasks, "Globex plan", "only the current tenant's rows");

  const none = await call(app, "use", { tenant: "" }, ada.cookie, ada.csrf);
  assert.equal(none.body.value, true);
  assert.equal((await page(app, ada.cookie)).org, "none");
  await live.close();
  app.close();
});

test("a tenant the user is not in cannot be switched to", async () => {
  const { app, acme, initech, errors } = setup();
  const ada = await signedIn(app, "ada");
  await call(app, "use", { tenant: acme.id }, ada.cookie, ada.csrf);
  for (const tenant of [initech.id, "no-such-tenant", `${acme.id}/not-a-root`]) {
    const res = await call(app, "use", { tenant }, ada.cookie, ada.csrf);
    assert.equal(res.body.value, false, tenant);
  }
  const after = await page(app, ada.cookie);
  assert.equal(after.org, acme.id, "a refused switch changes nothing");
  assert.equal(after.tasks, "Acme plan");

  const anon = await page(app);
  assert.equal((await call(app, "use", { tenant: acme.id }, anon.cookie, anon.csrf)).body.value, false);

  const sneaky = await page(app, ada.cookie, "/sneaky");
  assert.equal(sneaky.res.status, 500);
  assert.match(String(errors.at(-1)), /switchTenant only work in actions and in API handlers for POST/);
  app.close();
});

test("losing the last role in a tenant takes the session out of it at once", async () => {
  const { app, access, globex } = setup();
  const ada = await signedIn(app, "ada");
  await call(app, "use", { tenant: globex.id }, ada.cookie, ada.csrf);
  const now = await page(app, ada.cookie);
  assert.equal(now.tasks, "Globex plan");
  const live = await stream(app, now.cookie, now.lid);

  access.removeFromTenant("bob", { user: "ada", tenant: globex.id });
  assert.ok(await live.patched('<p id="tasks"></p>'), "the open page lost the rows");
  const after = await page(app, ada.cookie);
  assert.equal(after.org, "none");
  assert.equal(after.tasks, "");
  await live.close();
  app.close();
});

test("a new login starts in no tenant", async () => {
  const { app, acme, store } = setup();
  const ada = await signedIn(app, "ada");
  await call(app, "use", { tenant: acme.id }, ada.cookie, ada.csrf);
  assert.equal((await page(app, ada.cookie)).org, acme.id);
  const again = await call(app, "signIn", { id: "ada" }, ada.cookie, ada.csrf);
  assert.equal((await page(app, cookieOf(again.res))).org, "none");
  assert.equal(store.size, 1, "the old login is gone");
  app.close();
});

test("the SQL session store keeps the tenant and upgrades an older table", () => {
  const db = openSqlite(":memory:");
  db.exec(`CREATE TABLE weft_sessions (sid TEXT PRIMARY KEY NOT NULL, user TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL)`);
  db.prepare(`INSERT INTO weft_sessions VALUES ('old', 'u1', 1, 2)`).run();
  const store = new SqlSessionStore(db);
  assert.deepEqual(store.get("old"), { user: "u1", created: 1, seen: 2 });
  store.set("old", { user: "u1", created: 1, seen: 3, tenant: "t1" });
  assert.deepEqual(store.get("old"), { user: "u1", created: 1, seen: 3, tenant: "t1" });
  store.set("old", { user: "u1", created: 1, seen: 4 });
  assert.deepEqual(store.get("old"), { user: "u1", created: 1, seen: 4 }, "cleared");
  assert.deepEqual(new SqlSessionStore(db).get("old"), { user: "u1", created: 1, seen: 4 });
  db.close();
});
