import { test } from "node:test";
import assert from "node:assert/strict";
import { audit, defineModel, useDatabase, type AuditEvent, type Model } from "@weft/data";
import { openSqlite } from "@weft/data/sqlite";
import { defineAccess, explainText, isAccessError, type AccessErrorCode } from "../src/index.ts";

function make(driver: "memory" | "sqlite") {
  const access = defineAccess({
    scopes: { org: {}, project: { parent: "org" } },
    permissions: { "project.read": "See projects", "project.export": "Export projects" },
    roles: {
      owner: { scope: "org", permissions: ["*"] },
      admin: { scope: "org", permissions: ["access.members.manage", "access.settings.manage", "project.read"] },
      member: { scope: "org", permissions: ["project.read"] },
      viewer: { scope: ["org", "project"], permissions: ["project.read"] },
    },
    owner: "owner",
    settings: {
      seats: { type: "number", default: 3, min: 1, max: 1000, integer: true, label: "Seats" },
      "storage.mb": { type: "number", default: 512, min: 0 },
      "exports.enabled": { type: "boolean", default: false },
      theme: { type: "string", default: "light", options: ["light", "dark"], editable: true },
      "welcome.text": { type: "string", default: "", maxLength: 20, editable: true },
    },
    seats: "seats",
  });
  let db: ReturnType<typeof openSqlite> | null = null;
  if (driver === "sqlite") {
    db = openSqlite(":memory:");
    useDatabase(db, Object.values(access.models) as Model<never>[]);
  }
  const org = access.createTenant("alice", { name: "Acme" });
  access.assign("alice", { user: "adam", role: "admin", scope: org.id });
  return { access, org, db };
}

function fails(fn: () => unknown, code: AccessErrorCode, msg?: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(isAccessError(e), `expected an AccessError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (msg) assert.match(e.message, msg);
    return true;
  });
}

test("setting declarations are checked at startup", () => {
  const base = {
    scopes: { org: {} },
    permissions: {},
    roles: { owner: { scope: "org", permissions: ["*"] } },
    owner: "owner",
  } as const;
  const bad = (patch: object, msg: RegExp) => fails(() => defineAccess({ ...base, ...patch } as never), "invalid", msg);
  bad({ settings: { "Bad Key": { type: "boolean", default: true } } }, /not a valid key/);
  bad({ settings: { x: { type: "date", default: 1 } } }, /type is/);
  bad({ settings: { x: { type: "number", default: 0, min: 1 } } }, /default must be at least 1/);
  bad({ settings: { x: { type: "number", default: 1.5, integer: true } } }, /default must be a whole number/);
  bad({ settings: { x: { type: "number", default: 1, min: 5, max: 2 } } }, /min is above max/);
  bad({ settings: { x: { type: "string", default: "a", options: ["a", "a"] } } }, /distinct/);
  bad({ settings: { x: { type: "string", default: "c", options: ["a", "b"] } } }, /must be one of a, b/);
  bad({ settings: { x: { type: "string", default: "", maxLength: 0 } } }, /maxLength/);
  bad({ settings: { x: { type: "boolean", default: "yes" } } }, /true or false/);
  bad({ settings: { x: { type: "number", default: 1, integer: true } }, seats: "x" }, /min of at least 1/);
  bad({ settings: { x: { type: "number", default: 1, min: 1 } }, seats: "x" }, /whole-number/);
  bad({ seats: "nothing" }, /seats/);
  bad({ roles: { owner: { scope: "org", permissions: ["access.members.manage"] } } }, /lacks `access\./);
});

for (const driver of ["memory", "sqlite"] as const) {
  test(`${driver}: every declared setting reads, with its default until set`, () => {
    const { access, org } = make(driver);
    assert.deepEqual(access.settings("alice", org.id), {
      seats: 3,
      "storage.mb": 512,
      "exports.enabled": false,
      theme: "light",
      "welcome.text": "",
    });
    assert.equal(access.settings("adam", org.id).theme, "light", "any member reads them");
    fails(() => access.settings("eve", org.id), "forbidden");
    fails(() => access.settings("alice", "not-a-tenant"), "forbidden");
  });

  test(`${driver}: members change only editable settings, and only with the permission`, () => {
    const { access, org } = make(driver);
    access.assign("alice", { user: "mia", role: "member", scope: org.id });
    const after = access.updateSettings("adam", org.id, { theme: "dark", "welcome.text": "Hi" });
    assert.equal(after.theme, "dark");
    assert.equal(access.settings("mia", org.id)["welcome.text"], "Hi");
    fails(() => access.updateSettings("mia", org.id, { theme: "light" }), "forbidden", /change settings/);
    fails(() => access.updateSettings("eve", org.id, { theme: "light" }), "forbidden");
    fails(() => access.updateSettings("adam", org.id, { seats: 100 }), "forbidden", /seats/);
    fails(() => access.updateSettings("alice", org.id, { "exports.enabled": true }), "forbidden");
    fails(() => access.updateSettings("adam", org.id, { theme: "purple" } as never), "invalid", /one of light, dark/);
    fails(() => access.updateSettings("adam", org.id, { "welcome.text": "x".repeat(21) }), "invalid", /too long/);
    fails(() => access.updateSettings("adam", org.id, { nope: 1 } as never), "invalid", /no setting/);
    fails(() => access.updateSettings("adam", org.id, null as never), "invalid");
    fails(() => access.updateSettings("adam", org.id, { theme: "light", seats: 9 }), "forbidden");
    assert.equal(access.settings("adam", org.id).theme, "dark");
  });

  test(`${driver}: the application sets limits and features`, () => {
    const { access, org } = make(driver);
    const after = access.configureTenant(org.id, { "storage.mb": 10_240, "exports.enabled": true });
    assert.equal(after["storage.mb"], 10_240);
    assert.equal(after["exports.enabled"], true);
    fails(() => access.configureTenant(org.id, { "storage.mb": -1 }), "invalid", /at least 0/);
    fails(() => access.configureTenant(org.id, { seats: 2.5 }), "invalid", /whole number/);
    fails(() => access.configureTenant(org.id, { seats: Number.NaN }), "invalid");
    fails(() => access.configureTenant("not-a-tenant", { seats: 5 }), "not-found");
    fails(() => access.configureTenant(`${org.id}/x`, { seats: 5 }), "not-found");
  });

  test(`${driver}: seats cap the tenant's distinct members`, async () => {
    const { access, org } = make(driver);
    const project = access.createScope("alice", { type: "project", parent: org.id, name: "P" });
    access.assign("alice", { user: "mia", role: "member", scope: org.id });
    fails(() => access.assign("alice", { user: "bob", role: "member", scope: org.id }), "limit", /no free seat/);
    fails(() => access.assign("alice", { user: "bob", role: "viewer", scope: project.id }), "limit");
    access.assign("alice", { user: "mia", role: "viewer", scope: project.id });
    await assert.rejects(access.createInvite("alice", { scope: org.id, role: "member" }), (e) => isAccessError(e, "limit"));

    access.configureTenant(org.id, { seats: 4 });
    const { token } = await access.createInvite("alice", { scope: org.id, role: "member" });
    access.assign("alice", { user: "bob", role: "member", scope: org.id });
    await assert.rejects(access.acceptInvite(token, "carol"), (e) => isAccessError(e, "limit"));
    access.configureTenant(org.id, { seats: 1 });
    assert.equal(new Set(access.members("alice", org.id).map((m) => m.user)).size, 4);
    fails(() => access.assign("alice", { user: "dan", role: "member", scope: org.id }), "limit");
    access.configureTenant(org.id, { seats: 4 });
    access.removeFromTenant("alice", { user: "bob", tenant: org.id });
    await access.acceptInvite(token, "carol");
    assert.ok(access.user("carol").in(org.id));
  });

  test(`${driver}: rules read settings through the principal`, () => {
    const { access, org } = make(driver);
    interface Report {
      id: string;
      org: string;
    }
    type Actor = ReturnType<typeof access.user>;
    const Report = defineModel<Report>("Report", {
      fields: { id: "string", org: "string" },
      attrs: { org: { tenant: true } },
      read: (a: Actor) => a.can("project.read"),
      write: (a: Actor) => a.setting("exports.enabled") === true && a.can("project.export"),
    });
    if (driver === "sqlite") useDatabase(openSqlite(":memory:"), [Report as unknown as Model<never>]);
    const alice = access.user("alice").in(org.id)!;
    assert.equal(alice.setting("exports.enabled"), false);
    assert.equal(Report.as(alice).create({ id: "r1" } as Report), undefined, "the feature is off");
    access.configureTenant(org.id, { "exports.enabled": true });
    assert.equal(alice.setting("exports.enabled"), true, "the same principal sees the change");
    assert.ok(Report.as(alice).create({ id: "r1" } as Report));
    assert.equal(access.user("alice").setting("theme"), undefined, "unbound: no tenant to read");
    assert.equal(alice.setting("nope" as never), undefined);
  });

  test(`${driver}: changes are audited and a deleted tenant takes its settings`, () => {
    const { access, org } = make(driver);
    const events: AuditEvent[] = [];
    const stop = audit((e) => events.push(e));
    access.updateSettings("adam", org.id, { theme: "dark" });
    access.configureTenant(org.id, { seats: 10 });
    stop();
    const writes = events.filter((e) => e.model === "AccessSetting" && (e.action === "create" || e.action === "update"));
    assert.deepEqual(writes.map((e) => (e.actor as { id: string }).id), ["adam", "access:app"]);
    access.deleteScope("alice", org.id);
    assert.deepEqual(access.models.Setting.as({ id: "x" }).all(), [], "closed to other actors");
    const again = access.createTenant("alice", { name: "Acme again" });
    assert.equal(access.settings("alice", again.id).theme, "light");
    void again;
  });
}

test("a stored value the configuration no longer allows reads as the default", () => {
  const { access, org, db } = make("sqlite");
  access.configureTenant(org.id, { "storage.mb": 2048 });
  db!.prepare(`UPDATE "AccessSetting" SET value = ? WHERE key = ?`).run('"lots"', "storage.mb");
  access.models.Setting.feed.gap();
  assert.equal(access.settings("alice", org.id)["storage.mb"], 512);
  db!.prepare(`UPDATE "AccessSetting" SET value = ? WHERE key = ?`).run("not json", "storage.mb");
  access.models.Setting.feed.gap();
  assert.equal(access.settings("alice", org.id)["storage.mb"], 512);
});

test("explain lists the settings, with a tenant's values", () => {
  const { access, org } = make("memory");
  access.configureTenant(org.id, { seats: 25 });
  const report = access.explain(org.id);
  const seats = report.settings.find((s) => s.key === "seats")!;
  assert.deepEqual(seats, { key: "seats", type: "number", label: "Seats", default: 3, editable: false, seats: true, value: 25 });
  const text = explainText(report);
  assert.match(text, /Settings:\n {2}seats {12}number, default 3, now 25 \[set by the app, seats\]/);
  assert.match(text, /theme {12}string, default "light", now "light" \[editable\]/);
  assert.doesNotMatch(explainText(access.explain()), /now /);
});

test("settings are typed", () => {
  const { access, org } = make("memory");
  const s = access.settings("alice", org.id);
  const seats: number = s.seats;
  const theme: "light" | "dark" = s.theme;
  const on: boolean = s["exports.enabled"];
  // @ts-expect-error not a declared setting
  void (() => access.updateSettings("alice", org.id, { colour: "red" }));
  // @ts-expect-error not one of the options
  void (() => access.updateSettings("alice", org.id, { theme: "purple" }));
  void [seats, theme, on];
  assert.ok(true);
});

test("settingsForm: what defineSettings needs for a tenant's settings", () => {
  const { access, org } = make("memory");
  access.assign("alice", { user: "mia", role: "member", scope: org.id });
  type Ctx = { user?: string; tenant?: string };
  const page = access.settingsForm<Ctx>({ user: (c) => c.user, tenant: (c) => c.tenant });
  assert.deepEqual(Object.keys(page.schema), ["seats", "storage.mb", "exports.enabled", "theme", "welcome.text"]);
  assert.equal(page.schema.theme!.editable, true);
  const adam = { user: "adam", tenant: org.id };
  const mia = { user: "mia", tenant: org.id };
  assert.equal(page.load({})?.theme, undefined, "not signed in");
  assert.equal(page.load({ user: "adam" }), undefined, "no tenant");
  assert.equal(page.load({ user: "zed", tenant: org.id }), undefined, "not a member");
  assert.equal(page.load(mia)!.theme, "light", "members see them");
  assert.equal(page.canEdit(mia, "theme"), false);
  assert.equal(page.canEdit(adam, "theme"), true);
  assert.equal(page.canEdit({ user: "zed", tenant: org.id }, "theme"), false);
  page.save(adam, { theme: "dark" });
  assert.equal(page.load(mia)!.theme, "dark");
  fails(() => page.save(mia, { theme: "light" }), "forbidden");
  fails(() => page.save(adam, { seats: 99 }), "forbidden", /configureTenant|editable|not/);
  fails(() => page.save({}, { theme: "light" }), "forbidden");
  fails(() => access.settingsForm(null as never), "invalid");
});
