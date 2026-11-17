import { test } from "node:test";
import assert from "node:assert/strict";
import { audit, canSee, changes, onRead, useDatabase, type AuditEvent, type Model } from "@weft/data";
import { openSqlite } from "@weft/data/sqlite";
import { bucket, defineFlags } from "../src/flags.ts";
import { isAccessError } from "../src/errors.ts";

let n = 0;

function make(driver: "memory" | "sqlite") {
  let clock = 1000;
  const flags = defineFlags({
    flags: {
      newEditor: { description: "Block editor" },
      fastSearch: { description: "New index", default: true },
    },
    kills: { checkout: "Checkout", export: "CSV export" },
    manage: (u) => u === "staff",
    prefix: `Flag${++n}`,
    now: () => ++clock,
  });
  if (driver === "sqlite") useDatabase(openSqlite(":memory:"), [flags.models.Flag] as unknown as Model<never>[]);
  return flags;
}

for (const driver of ["memory", "sqlite"] as const) {
  test(`${driver}: defaults, overrides and reset`, () => {
    const flags = make(driver);
    assert.equal(flags.enabled("newEditor"), false);
    assert.equal(flags.enabled("fastSearch", { user: "u1" }), true);

    flags.set("staff", "newEditor", { users: ["u1", "u1"], tenants: ["acme"] });
    assert.equal(flags.enabled("newEditor", { user: "u1" }), true);
    assert.equal(flags.enabled("newEditor", { user: "u2" }), false);
    assert.equal(flags.enabled("newEditor", { user: "u2", tenant: "acme" }), true);
    assert.equal(flags.enabled("newEditor"), false);
    const info = flags.list("staff").find((f) => f.name === "newEditor")!;
    assert.deepEqual([info.overridden, info.on, info.users, info.tenants, info.by], [true, false, ["u1"], ["acme"], "staff"]);

    flags.set("staff", "fastSearch", { users: ["u9"] });
    assert.equal(flags.enabled("fastSearch", { user: "u1" }), false);
    assert.equal(flags.enabled("fastSearch", { user: "u9" }), true);

    flags.set("staff", "newEditor", { on: true });
    assert.equal(flags.enabled("newEditor"), true);
    assert.deepEqual(flags.list("staff").find((f) => f.name === "newEditor")!.users, ["u1"]);

    flags.reset("staff", "newEditor");
    flags.reset("staff", "fastSearch");
    assert.equal(flags.enabled("newEditor", { user: "u1" }), false);
    assert.equal(flags.enabled("fastSearch"), true);
    assert.equal(flags.list("staff").find((f) => f.name === "fastSearch")!.overridden, false);
  });

  test(`${driver}: percentage rollout is stable and grows`, () => {
    const flags = make(driver);
    const users = Array.from({ length: 400 }, (_, i) => `user-${i}`);
    flags.set("staff", "newEditor", { percent: 10 });
    const at10 = users.filter((u) => flags.enabled("newEditor", { user: u }));
    assert.ok(at10.length > 15 && at10.length < 70, `${at10.length} of 400 at 10%`);
    for (const u of users) assert.equal(flags.enabled("newEditor", { user: u }), bucket("newEditor", u) < 10);
    flags.set("staff", "newEditor", { percent: 50 });
    const at50 = new Set(users.filter((u) => flags.enabled("newEditor", { user: u })));
    for (const u of at10) assert.ok(at50.has(u), "still in after growing");
    assert.equal(flags.enabled("newEditor", { user: "", tenant: null }), false);
    const t = Array.from({ length: 100 }, (_, i) => `t${i}`).find((x) => bucket("newEditor", x) < 50)!;
    assert.equal(flags.enabled("newEditor", { tenant: t }), true);
    const out = users.find((u) => bucket("newEditor", u) >= 50)!;
    assert.equal(flags.enabled("newEditor", { user: out, tenant: t }), false);
    flags.set("staff", "newEditor", { percent: 0 });
    assert.equal(users.some((u) => flags.enabled("newEditor", { user: u })), false);
    flags.set("staff", "newEditor", { percent: 100 });
    assert.equal(users.every((u) => flags.enabled("newEditor", { user: u })), true);
  });

  test(`${driver}: kill switches`, () => {
    const flags = make(driver);
    assert.equal(flags.killed("checkout"), false);
    flags.guard("checkout");
    flags.kill("staff", "checkout", "  Provider outage ");
    assert.equal(flags.killed("checkout"), true);
    assert.equal(flags.killed("export"), false);
    assert.equal(flags.reason("checkout"), "Provider outage");
    assert.throws(() => flags.guard("checkout"), (e) => isAccessError(e, "forbidden") && /Provider outage/.test(e.message));
    const k = flags.kills("staff").find((x) => x.name === "checkout")!;
    assert.deepEqual([k.killed, k.reason, k.by], [true, "Provider outage", "staff"]);
    flags.restore("staff", "checkout");
    assert.equal(flags.killed("checkout"), false);
    assert.equal(flags.reason("checkout"), "");
    flags.guard("checkout");
    assert.throws(() => flags.kill("staff", "checkout", "two\nlines"), (e) => isAccessError(e, "invalid"));
  });

  test(`${driver}: only manage may change or list; the model is closed`, () => {
    const flags = make(driver);
    const refused = (f: () => unknown) => assert.throws(f, (e) => isAccessError(e, "forbidden"));
    refused(() => flags.set("eve", "newEditor", { on: true }));
    refused(() => flags.reset("eve", "newEditor"));
    refused(() => flags.kill("eve", "checkout"));
    refused(() => flags.restore("eve", "checkout"));
    refused(() => flags.list("eve"));
    refused(() => flags.kills("eve"));
    assert.throws(() => flags.set("", "newEditor", { on: true }), (e) => isAccessError(e, "invalid"));
    assert.equal(flags.enabled("newEditor"), false);
    assert.equal(flags.killed("checkout"), false);

    const strict = defineFlags({ kills: { x: "X" }, manage: () => { throw new Error("boom"); }, prefix: `Flag${++n}` });
    refused(() => strict.kill("staff", "x"));

    const Flag = flags.models.Flag;
    assert.equal(Flag.as({ id: "staff" }).create({ id: "kill:checkout", on: true, percent: 0, users: [], tenants: [], reason: "", updated: 0, by: "x" }), undefined);
    assert.deepEqual(Flag.as({ id: "staff" }).where(() => true), []);

    const bad = (f: () => unknown) => assert.throws(f, (e) => isAccessError(e, "invalid"));
    bad(() => flags.enabled("nope" as "newEditor"));
    bad(() => flags.killed("nope" as "checkout"));
    bad(() => flags.set("staff", "newEditor", { percent: 101 }));
    bad(() => flags.set("staff", "newEditor", { percent: 2.5 }));
    bad(() => flags.set("staff", "newEditor", { users: ["ok", ""] }));
    bad(() => flags.set("staff", "newEditor", { users: Array.from({ length: 1001 }, (_, i) => `u${i}`) }));
    bad(() => flags.set("staff", "newEditor", { on: "yes" as unknown as boolean }));
  });

  test(`${driver}: changes are audited by who made them and reach readers`, () => {
    const flags = make(driver);
    const events: AuditEvent[] = [];
    const stop = audit((e) => void events.push(e));
    const seen: unknown[] = [];
    const unRead = onRead((model, actor) => {
      if (model === (flags.models.Flag as Model<unknown>)) seen.push(actor);
    });
    const feed: unknown[] = [];
    const unFeed = changes.subscribe((c) => {
      if (c.model === flags.models.Flag.name) feed.push(c);
    });
    try {
      assert.equal(flags.enabled("newEditor", { user: "u1" }), false);
      assert.equal(seen.length > 0, true, "evaluating a flag is a watched read");
      const reader = seen[0];
      flags.kill("staff", "checkout", "outage");
      flags.set("staff", "newEditor", { users: ["u1"] });
      assert.equal(feed.length, 2);
      for (const c of feed) assert.equal(canSee(flags.models.Flag as Model<unknown>, reader as never, c as never), true);
      const writes = events.filter((e) => e.model === flags.models.Flag.name);
      assert.equal(writes.length, 2);
      for (const e of writes) assert.equal((e.actor as { id: string }).id, "staff");
    } finally {
      stop();
      unRead();
      unFeed();
    }
  });
}

test("configuration mistakes are refused at startup", () => {
  const bad = (cfg: unknown) => assert.throws(() => defineFlags(cfg as never), (e) => isAccessError(e, "invalid"));
  bad({ flags: { a: { description: "A" } } });
  bad({ manage: () => true });
  bad({ flags: { "bad name": { description: "x" } }, manage: () => true });
  bad({ flags: { a: { description: "A", default: "yes" } }, manage: () => true });
  bad({ kills: { a: 1 }, manage: () => true });
  bad({ flags: { a: { description: "A" } }, manage: () => true, prefix: "lower" });
});
