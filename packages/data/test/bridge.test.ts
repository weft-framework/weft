import { test } from "node:test";
import assert from "node:assert/strict";
import { canSee, ChangeFeed, type Change } from "../src/changes.ts";
import { defineModel } from "../src/model.ts";
import { bridgeChanges, broadcastChannel, LocalBroadcast } from "../src/bridge.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

function collect(feed: ChangeFeed) {
  const got: Change[] = [];
  feed.subscribe((c) => got.push(c));
  return got;
}

test("changes cross instances once, dates intact, no echo", async () => {
  const hub = new LocalBroadcast();
  const a = new ChangeFeed();
  const b = new ChangeFeed();
  const c = new ChangeFeed();
  const stopA = bridgeChanges(a, hub.channel());
  bridgeChanges(b, hub.channel());
  bridgeChanges(c, hub.channel());
  const [ga, gb, gc] = [collect(a), collect(b), collect(c)];
  const at = new Date("2026-01-02T03:04:05.678Z");
  a.publish({ model: "Msg", op: "create", key: "m1", after: { id: "m1", at, nested: { when: at } } });
  await tick();
  assert.equal(ga.length, 1, "no echo back to the writer");
  assert.equal(gb.length, 1);
  assert.equal(gc.length, 1, "relayed changes are not relayed again");
  const after = gb[0].after as { at: Date; nested: { when: Date } };
  assert.ok(after.at instanceof Date && after.at.getTime() === at.getTime());
  assert.ok(after.nested.when instanceof Date);

  b.publish({ model: "Msg", op: "delete", key: "m1", before: { id: "m1" } });
  await tick();
  assert.equal(ga.length, 2);
  assert.equal(gc.length, 2);

  stopA();
  c.publish({ model: "Msg", op: "update", key: "m1" });
  await tick();
  assert.equal(ga.length, 2, "a stopped bridge hears nothing");
});

test("bad messages are reported, not published", async () => {
  const hub = new LocalBroadcast();
  const feed = new ChangeFeed();
  const errors: unknown[] = [];
  bridgeChanges(feed, hub.channel(), { onError: (e) => errors.push(e) });
  const got = collect(feed);
  const raw = hub.channel();
  raw.publish("{not json");
  raw.publish('{"v":2,"origin":"x","change":{}}');
  raw.publish('{"v":1,"origin":"x","change":{"model":"M","op":"create","key":1}}');
  await tick();
  assert.equal(errors.length, 2);
  assert.equal(got.length, 1);
});

test("a failing channel does not break local publishing", () => {
  const feed = new ChangeFeed();
  const errors: unknown[] = [];
  const failing = {
    publish: () => {
      throw new Error("down");
    },
    subscribe: () => undefined,
  };
  bridgeChanges(feed, failing, { onError: (e) => errors.push(e) });
  const got = collect(feed);
  feed.publish({ model: "M", op: "create", key: 1 });
  assert.equal(got.length, 1);
  assert.equal(errors.length, 1);
});

test("BroadcastChannel carries changes between bridges", async () => {
  const one = broadcastChannel("weft-test-changes");
  const two = broadcastChannel("weft-test-changes");
  const a = new ChangeFeed();
  const b = new ChangeFeed();
  bridgeChanges(a, one);
  bridgeChanges(b, two);
  const got = collect(b);
  a.publish({ model: "M", op: "create", key: 7, after: { id: 7 } });
  for (let i = 0; i < 50 && got.length === 0; i++) {
    await tick();
  }
  assert.deepEqual(
    got.map((c) => c.key),
    [7],
  );
  one.close();
  two.close();
});

test("data residency: resident rows cross whole only over a channel in their region", async () => {
  const feed = new ChangeFeed();
  const Eu = defineModel<{ id: string; tenant: string }>("ResEu", {
    fields: { id: "string", tenant: "string" },
    read: () => true,
    write: () => true,
    residency: "eu",
  }).publishTo(feed);
  const ByTenant = defineModel<{ id: string; tenant: string }>("ResTenant", {
    fields: { id: "string", tenant: "string" },
    read: () => true,
    write: () => true,
    residency: (r) => (r.tenant === "acme" ? "us" : r.tenant === "bad" ? "Not A Region" : null),
  }).publishTo(feed);
  assert.throws(() => defineModel("ResBad", { fields: { id: "string" }, residency: "EU West" }), /residency/);

  const local = collect(feed);
  Eu.as(null).create({ id: "resident-row", tenant: "t" });
  ByTenant.as(null).create({ id: "t1", tenant: "acme" });
  ByTenant.as(null).create({ id: "t2", tenant: "solo" });
  ByTenant.as(null).create({ id: "t3", tenant: "bad" });
  ByTenant.as(null).update((r) => r.id === "t1", { tenant: "solo" });
  assert.deepEqual(local.map((c) => c.regions), [["eu"], ["us"], undefined, ["?"], ["us"]], "a row moving out keeps its old region");

  const global = new LocalBroadcast();
  const euOnly = new LocalBroadcast();
  const heard = { global: [] as Change[], eu: [] as Change[] };
  const g = new ChangeFeed();
  const e = new ChangeFeed();
  g.subscribe((c) => heard.global.push(c));
  e.subscribe((c) => heard.eu.push(c));
  bridgeChanges(feed, global.channel());
  bridgeChanges(g, global.channel());
  bridgeChanges(feed, euOnly.channel(), { channelRegion: "eu" });
  bridgeChanges(e, euOnly.channel(), { channelRegion: "eu", region: "eu" });
  const raw: string[] = [];
  global.channel().subscribe((m) => raw.push(m));

  Eu.as(null).update((r) => r.id === "resident-row", { tenant: "secret-name" });
  ByTenant.as(null).create({ id: "t4", tenant: "solo" });
  await tick();
  assert.deepEqual(heard.global[0], { model: "ResEu", op: "update", key: undefined, redacted: true });
  assert.equal(heard.global[1]!.key, "t4", "rows with no region cross whole");
  assert.ok(!raw.some((m) => m.includes("secret-name") || m.includes("resident-row")), "nothing of the EU row on the global channel");
  assert.equal((heard.eu[0]!.after as { tenant: string }).tenant, "secret-name", "the EU channel carries it whole");

  assert.equal(canSee(Eu as never, { id: "anyone" }, heard.global[0]!), true);

  const errors: unknown[] = [];
  const careless = new LocalBroadcast();
  const r = new ChangeFeed();
  const got = collect(r);
  bridgeChanges(r, careless.channel(), { region: "eu", onError: (x) => errors.push(x) });
  careless.channel().publish(JSON.stringify({ v: 1, origin: "x", s: 1, change: { model: "ResTenant", op: "create", key: "t9", after: { id: "t9" }, regions: ["us"] } }));
  careless.channel().publish(JSON.stringify({ v: 1, origin: "x", s: 2, change: { model: "ResTenant", op: "create", key: "t8", after: { id: "t8" }, redacted: true } }));
  await tick();
  assert.deepEqual(got, [
    { model: "ResTenant", op: "create", key: undefined, redacted: true },
    { model: "ResTenant", op: "create", key: undefined, redacted: true },
  ]);
  assert.match(String(errors[0]), /refused rows of ResTenant resident in us/);
  assert.throws(() => bridgeChanges(r, careless.channel(), { region: "EU" }), /region/);
});
