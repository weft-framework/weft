import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel } from "@weft-framework/data";
import { defineComponent, escapeHtml } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";
import { acceptGrant, grantToken, openWith, seal, sealWith, unseal } from "../src/seal.ts";
import { importSecret } from "../src/security.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

test("a sealed value opens only as it was sealed", async () => {
  const key = await importSecret(SECRET);
  const other = await importSecret("another-secret-another-secret-123!");
  const t = await sealWith(key, { id: 7, to: "/next" }, { purpose: "invite" });
  assert.deepEqual((await openWith(key, t, { purpose: "invite" }))?.value, { id: 7, to: "/next" });
  assert.equal(await openWith(key, t, { purpose: "reset" }), null, "another purpose");
  assert.equal(await openWith(other, t, { purpose: "invite" }), null, "another key");
  assert.equal(await openWith(key, t, { purpose: "invite", session: true }, "sid-a"), null, "unbound token, bound check");
  const [body, tag] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ v: { id: 8, to: "/next" }, e: Date.now() + 1e6 })).toString("base64url");
  for (const bad of [`${forged}.${tag}`, `${body}.${tag.slice(1)}`, `${body}.${tag}.x`, body, "", "a".repeat(9000), null, undefined]) {
    assert.equal(await openWith(key, bad as string, { purpose: "invite" }), null, String(bad).slice(0, 20));
  }
  const bound = await sealWith(key, "x", { purpose: "p", session: true }, "sid-a");
  assert.equal((await openWith(key, bound, { purpose: "p", session: true }, "sid-a"))?.value, "x");
  assert.equal(await openWith(key, bound, { purpose: "p", session: true }, "sid-b"), null);
  assert.equal(await openWith(key, bound, { purpose: "p" }), null);
  const brief = await sealWith(key, 1, { purpose: "p", ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await openWith(key, brief, { purpose: "p" }), null);
  for (const v of [null, 0, false, ""]) {
    assert.deepEqual((await openWith(key, await sealWith(key, v, { purpose: "p" }), { purpose: "p" }))?.value, v);
  }
  await assert.rejects(sealWith(key, undefined, { purpose: "p" }), /JSON/);
  await assert.rejects(sealWith(key, 1, { purpose: "a:b" }), /purpose/);
  await assert.rejects(sealWith(key, 1, { purpose: "p", ttlMs: 0 }), /ttlMs/);
});

interface Doc {
  id: string;
  owner: string;
  title: string;
}

function setup() {
  const Docs = defineModel<Doc>("Doc", {
    fields: { id: "string", owner: "string", title: "string" },
    read: (a: { id: string } | null, d) => a !== null && d.owner === a.id,
    write: (a: { id: string } | null, d) => a !== null && d.owner === a.id,
    readWhere: { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } },
  });
  Docs.as({ id: "ann" }).create({ id: "d1", owner: "ann", title: "Plans" });
  Docs.as({ id: "ann" }).create({ id: "d2", owner: "ann", title: "Diary" });
  const Show = defineComponent("Show", (props: { out: string }) => ({
    render: () => `<p id="out">${escapeHtml(props.out)}</p>`,
  }));
  const app = createApp({
    secret: SECRET,
    sync: false,
    transports: [],
    routes: {
      "/share/[id]": {
        component: Show as never,
        load: async (ctx) => ({ out: await grantToken(ctx, Docs, ctx.params.id as string, "read", { ttlMs: 60_000 }) }),
      },
      "/doc/[id]": {
        component: Show as never,
        load: async (ctx) => {
          const g = await acceptGrant(ctx, ctx.query.get("t"));
          const docs = g ? Docs.as(ctx.user as never).using(g) : Docs.as(ctx.user as never);
          return { out: docs.get(ctx.params.id)?.title ?? "(none)" };
        },
      },
      "/seal": {
        component: Show as never,
        load: async (ctx) => ({ out: await seal(ctx, ctx.query.get("v"), { purpose: "echo", session: true }) }),
      },
      "/unseal": {
        component: Show as never,
        load: async (ctx) => ({ out: String(await unseal(ctx, ctx.query.get("t"), { purpose: "echo", session: true })) }),
      },
    },
  });
  return { app, Docs };
}

async function get(app: ReturnType<typeof createApp>, path: string, cookie = ""): Promise<{ out: string; cookie: string }> {
  const res = await app.fetch(new Request(ORIGIN + path, { headers: cookie ? { cookie } : {} }));
  assert.ok(res);
  const html = await res.text();
  const m = /<p id="out">([^<]*)<\/p>/.exec(html);
  const set = res.headers.get("set-cookie") ?? "";
  return { out: m ? m[1].replace(/&amp;/g, "&") : `(status ${res.status})`, cookie: set.split(";")[0] || cookie };
}

test("a grant token admits exactly its row, through the data layer", async () => {
  const { app, Docs } = setup();
  const { out: token } = await get(app, "/share/d1");
  assert.equal((await get(app, "/doc/d1")).out, "(none)", "no token: the rules alone");
  assert.equal((await get(app, `/doc/d1?t=${encodeURIComponent(token)}`)).out, "Plans");
  assert.equal((await get(app, `/doc/d2?t=${encodeURIComponent(token)}`)).out, "(none)", "the token names d1 only");
  assert.equal((await get(app, `/doc/d1?t=${encodeURIComponent(token.slice(0, -2))}`)).out, "(none)", "altered");
  const g = { model: "Doc", key: "d1", rights: "read" as const };
  assert.equal(Docs.as(null).using(g).update(() => true, { title: "x" }), 0);
  assert.equal(Docs.as(null).using({ ...g, rights: "write" }).update(() => true, { title: "Plans!" }), 1);
  assert.equal(Docs.as(null).using({ ...g, expires: Date.now() - 1 }).get("d1"), undefined, "expired");
  assert.equal(Docs.as(null).using({ ...g, model: "Other" }).get("d1"), undefined, "another model");
  assert.deepEqual(
    Docs.as(null).using(g).query().all().map((d) => d.id),
    ["d1"],
    "queries see the granted row, pushed into the scope",
  );
});

test("session-bound seals open only in the session that sealed them", async () => {
  const { app } = setup();
  const a = await get(app, "/seal?v=hello");
  assert.ok(a.cookie.startsWith("weft_sid="));
  assert.equal((await get(app, `/unseal?t=${encodeURIComponent(a.out)}`, a.cookie)).out, "hello");
  const b = await get(app, "/seal?v=other");
  assert.equal((await get(app, `/unseal?t=${encodeURIComponent(a.out)}`, b.cookie)).out, "undefined");
});
