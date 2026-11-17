import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeFeed, defineModel } from "@weft-framework/data";
import { defineComponent, escapeHtml } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";
import { defineGrants, GrantError } from "../src/grants.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

interface Doc {
  id: string;
  owner: string;
  title: string;
}

let n = 0;

function setup() {
  const feed = new ChangeFeed();
  const name = `GDoc${++n}`;
  const Docs = defineModel<Doc>(name, {
    fields: { id: "string", owner: "string", title: "string" },
    read: (a, d) => (a as { id?: string } | null)?.id === d.owner,
    write: (a, d) => (a as { id?: string } | null)?.id === d.owner && d.title !== "locked",
  }).publishTo(feed);
  Docs.as({ id: "ann" }).create({ id: "d1", owner: "ann", title: "Plans" });
  Docs.as({ id: "ann" }).create({ id: "d2", owner: "ann", title: "locked" });
  Docs.as({ id: "bob" }).create({ id: "b1", owner: "bob", title: "Bob's" });
  const grants = defineGrants({ name: `G${n}`, manage: (user) => user === "staff", maxTtlMs: 7 * 86_400_000, perUser: 3 });
  grants.models.Grant.publishTo(feed);

  const Show = defineComponent(`GShow${n}`, (props: { out: string }) => ({
    render: () => `<p id="out">${escapeHtml(props.out)}</p>`,
  }));
  let last: unknown = null;
  const app = createApp({
    secret: SECRET,
    sync: feed,
    syncDelayMs: 0,
    onError: (e) => {
      throw e;
    },
    routes: {
      "/share/[id]": {
        component: Show as never,
        load: async (ctx) => {
          const q = ctx.query;
          try {
            const r = await grants.issue(ctx, { id: q.get("as") }, Docs, ctx.params.id as string, (q.get("rights") ?? "read") as "read", {
              label: q.get("label") ?? undefined,
              ttlMs: q.has("ttl") ? Number(q.get("ttl")) : undefined,
            });
            last = r;
            return { out: r.token };
          } catch (err) {
            return { out: `error ${(err as GrantError).code}` };
          }
        },
      },
      "/doc/[id]": {
        component: Show as never,
        load: async (ctx) => {
          const g = await grants.accept(ctx, ctx.query.get("t"));
          const docs = g ? Docs.as(null).using(g) : Docs.as(null);
          return { out: docs.get(ctx.params.id)?.title ?? "(none)" };
        },
      },
    },
  });
  return { app, Docs, grants, last: () => last as { id: string; token: string; expires: number } };
}

type App = ReturnType<typeof createApp>;

async function text(app: App, path: string): Promise<string> {
  const html = await (await app.fetch(new Request(ORIGIN + path)))!.text();
  const m = /<p id="out">([^<]*)<\/p>/.exec(html);
  if (!m) return "(no page)";
  let s = m[1]!;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith("&#39;", i)) {
      out += "'";
      i += 4;
    } else if (s.startsWith("&amp;", i)) {
      out += "&";
      i += 4;
    } else {
      out += s[i];
    }
  }
  return out;
}

async function live(app: App, path: string) {
  const res = (await app.fetch(new Request(ORIGIN + path)))!;
  const html = await res.text();
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)![1]!;
  const sse = (await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } })))!;
  const reader = sse.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const next = async (ms = 300): Promise<string | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const m = /data: (.*)\n\n/.exec(buf);
      if (m) {
        buf = buf.slice(m.index + m[0].length);
        return m[1]!;
      }
      pending ??= reader.read();
      const got = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now())))]);
      if (got === null) return null;
      pending = null;
      buf += dec.decode(got.value);
    }
  };
  await next();
  return { next, close: () => reader.cancel() };
}

test("grants are issued only for access the maker has, and open only their row", async () => {
  const { app, Docs, grants, last } = setup();
  const t1 = await text(app, "/share/d1?as=ann&label=For%20the%20auditors");
  assert.doesNotMatch(t1, /^error/);
  assert.equal(await text(app, `/doc/d1?t=${encodeURIComponent(t1)}`), "Plans");
  assert.equal(await text(app, `/doc/d2?t=${encodeURIComponent(t1)}`), "(none)", "only the granted row");
  assert.equal(await text(app, `/doc/d1?t=${encodeURIComponent(t1.slice(0, -2))}`), "(none)", "altered");
  assert.equal(await text(app, "/doc/d1"), "(none)", "no token: the rules alone");

  assert.equal(await text(app, "/share/b1?as=ann"), "error forbidden", "ann cannot read bob's doc");
  assert.equal(await text(app, "/share/d2?as=ann&rights=write"), "error forbidden", "ann cannot change a locked doc");
  assert.equal(await text(app, "/share/d1?as="), "error invalid", "no actor");
  assert.equal(await text(app, "/share/d1?as=ann&ttl=999999999999"), "error invalid", "past maxTtlMs");
  assert.equal(await text(app, "/share/d1?as=ann&label=two%0Alines"), "error invalid");

  const tw = await text(app, "/share/d1?as=ann&rights=write");
  assert.equal(Docs.as(null).using({ model: Docs.name, key: "d1", rights: "read" }).update(() => true, { title: "x" }), 0);
  assert.notEqual(tw, t1);

  await text(app, "/share/d1?as=ann");
  assert.equal(await text(app, "/share/d1?as=ann"), "error limit");
  assert.ok(grants.revoke("ann", last().id));
  assert.doesNotMatch(await text(app, "/share/d1?as=ann"), /^error/, "a revoked grant frees its place");

  assert.deepEqual(grants.models.Grant.as({ id: "ann" }).all(), []);
  assert.equal(grants.models.Grant.as({ id: "ann", grant: "*" }).all().length, 0, "a look-alike actor is not a holder");
  app.close();
});

test("listing and revoking: the maker, or whoever manage admits", async () => {
  const { app, grants } = setup();
  const t1 = await text(app, "/share/d1?as=ann&label=Auditors");
  const t2 = await text(app, "/share/b1?as=bob");
  const mine = grants.list("ann");
  assert.equal(mine.length, 1);
  assert.deepEqual(
    { ...mine[0], id: "", created: 0, expires: 0 },
    { id: "", model: mine[0]!.model, key: "d1", rights: "read", by: "ann", label: "Auditors", created: 0, expires: 0, live: true, revoked: null, revokedBy: null },
  );
  assert.ok(!("token" in mine[0]!), "lists never carry the token");
  assert.deepEqual(grants.list("bob").map((g) => g.key), ["b1"]);
  assert.equal(grants.list("staff").length, 2, "manage sees everyone's");
  assert.equal(grants.list("ann", { model: mine[0]!.model, key: "d2" }).length, 0);

  assert.equal(grants.revoke("bob", mine[0]!.id), false);
  assert.equal(grants.revoke("bob", "x".repeat(22)), false);
  assert.equal(grants.revoke("bob", "not an id"), false);
  assert.equal(await text(app, `/doc/d1?t=${encodeURIComponent(t1)}`), "Plans");

  assert.equal(grants.revoke("staff", grants.list("bob")[0]!.id), true, "staff revokes bob's");
  assert.equal(await text(app, `/doc/b1?t=${encodeURIComponent(t2)}`), "(none)");
  assert.equal(grants.revokeAll("ann", mine[0]!.model, "d1"), 1);
  assert.equal(await text(app, `/doc/d1?t=${encodeURIComponent(t1)}`), "(none)", "revoked: the token no longer opens");
  assert.equal(grants.revoke("ann", mine[0]!.id), false, "already revoked");
  assert.deepEqual(grants.list("ann"), []);
  const all = grants.list("ann", { all: true });
  assert.equal(all[0]!.live, false);
  assert.equal(all[0]!.revokedBy, "ann");

  assert.equal(grants.purge(60_000), 0, "kept for a while");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(grants.purge(0), 2);
  assert.throws(() => defineGrants({ name: "bad name" }), GrantError);
  assert.throws(() => defineGrants({ perUser: 0 }), GrantError);
  app.close();
});

test("revoking re-renders only the live pages opened with that grant", async () => {
  const { app, grants } = setup();
  const t1 = await text(app, "/share/d1?as=ann");
  const id1 = grants.list("ann")[0]!.id;
  const t2 = await text(app, "/share/d1?as=ann");
  const a = await live(app, `/doc/d1?t=${encodeURIComponent(t1)}`);
  const b = await live(app, `/doc/d1?t=${encodeURIComponent(t2)}`);

  assert.equal(grants.revoke("ann", id1), true);
  const msg = await a.next();
  assert.ok(msg !== null, "the page opened with the revoked grant re-renders");
  assert.match(msg, /\(none\)/, "and no longer shows the row");
  assert.equal(await b.next(150), null, "a page opened with another grant is untouched");

  await a.close();
  await b.close();
  app.close();
});
