import { test } from "node:test";
import assert from "node:assert/strict";
import { audit, canSee, defineModel, onRead, transaction, useDatabase, type AuditEvent, type Model } from "@weft-framework/data";
import { openSqlite } from "@weft-framework/data/sqlite";
import { AccessError, defineAccess, explainText, isAccessError, type AccessErrorCode } from "../src/index.ts";

let clock = 1_000_000;

function make(driver: "memory" | "sqlite" = "memory") {
  const access = defineAccess({
    scopes: {
      org: {},
      team: { parent: "org" },
      project: { parent: ["org", "team"] },
    },
    permissions: {
      "project.read": "See projects",
      "project.edit": { label: "Change projects", description: "Edit tasks and settings" },
      "billing.manage": "Change the plan",
    },
    roles: {
      owner: { scope: "org", permissions: ["*"] },
      admin: {
        scope: "org",
        permissions: [
          "access.members.manage",
          "access.scopes.manage",
          "access.roles.manage",
          "access.permissions.manage",
          "project.edit",
        ],
        includes: ["member"],
      },
      member: { scope: "org", permissions: ["project.read", "access.members.read"] },
      lead: { scope: ["team", "project"], permissions: ["project.read", "project.edit", "access.members.manage", "access.members.read"] },
      viewer: { scope: ["org", "team", "project"], permissions: ["project.read"] },
    },
    owner: "owner",
    custom: { roles: { max: 3 }, permissions: { max: 3 } },
    invites: { max: 3 },
    now: () => clock,
  });
  if (driver === "sqlite") {
    useDatabase(openSqlite(":memory:"), Object.values(access.models) as Model<never>[]);
  }
  return access;
}

function fails(fn: () => unknown, code: AccessErrorCode, msg?: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(isAccessError(e), `expected an AccessError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (msg) assert.match(e.message, msg);
    return true;
  });
}

async function failsAsync(fn: () => Promise<unknown>, code: AccessErrorCode): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(isAccessError(e), `expected an AccessError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    return true;
  });
}

function world(driver: "memory" | "sqlite" = "memory") {
  const access = make(driver);
  const org = access.createTenant("alice", { name: "Acme" });
  const team = access.createScope("alice", { type: "team", parent: org.id, name: "Design" });
  const inTeam = access.createScope("alice", { type: "project", parent: team.id, name: "Logo" });
  const outside = access.createScope("alice", { type: "project", parent: org.id, name: "Payroll" });
  access.assign("alice", { user: "adam", role: "admin", scope: org.id });
  access.assign("alice", { user: "mia", role: "member", scope: org.id });
  access.assign("alice", { user: "lea", role: "lead", scope: team.id });
  return { access, org, team, inTeam, outside };
}

test("configuration mistakes are refused at startup", () => {
  const base = {
    scopes: { org: {} },
    permissions: { "doc.read": "Read" },
    roles: { owner: { scope: "org", permissions: ["*"] } },
    owner: "owner",
  } as const;
  const bad = (patch: object, msg: RegExp) =>
    fails(() => defineAccess({ ...base, ...patch } as never), "invalid", msg);
  bad({ scopes: { team: { parent: "org" } } }, /unknown parent|no root/);
  bad({ scopes: { org: {}, a: { parent: "b" }, b: { parent: "a" } } }, /never reaches a root/);
  bad({ scopes: { "bad name": {} } }, /not an identifier/);
  bad({ permissions: { "Doc.Read": "x" } }, /not a valid name/);
  bad({ permissions: { "access.hack": "x" } }, /reserved/);
  bad({ permissions: { "custom.x": "x" } }, /reserved/);
  bad({ roles: { owner: { scope: "org", permissions: ["nope"] } } }, /unknown permission/);
  bad({ roles: { owner: { scope: "nowhere", permissions: ["*"] } } }, /unknown scope type/);
  bad({ roles: { owner: { scope: "org", permissions: ["doc.read"] } } }, /lacks `access\./);
  bad({ owner: "ghost" }, /not a declared role/);
  bad(
    { roles: { owner: { scope: "org", permissions: ["*"], includes: ["a"] }, a: { scope: "org", includes: ["owner"] } } },
    /include each other/,
  );
  bad({ invites: { ttlMs: 91 * 24 * 3600 * 1000 } }, /ttlMs/);
  bad({ prefix: "1x" }, /prefix/);
  assert.ok(defineAccess(base));
});

for (const driver of ["memory", "sqlite"] as const) {
  test(`${driver}: the creator owns the tenant and holds everything`, () => {
    const access = make(driver);
    const org = access.createTenant("alice", { name: "  Acme  " });
    assert.equal(org.name, "Acme");
    assert.equal(org.parent, null);
    assert.equal(org.tenant, org.id);
    const alice = access.user("alice");
    assert.ok(alice.can("billing.manage", org.id));
    assert.ok(alice.can("access.tenant.manage", org.id));
    assert.deepEqual(alice.tenants().map((t) => t.id), [org.id]);
    assert.ok(alice.permissions(org.id).includes("project.edit"));
    assert.deepEqual(access.members("alice", org.id).map((m) => [m.user, m.role, m.label]), [["alice", "owner", "owner"]]);
    assert.equal(access.user("bob").in(org.id), null, "not a member");
    assert.deepEqual(access.user("bob").tenants(), []);
  });

  test(`${driver}: roles hold on their scope and everything below it`, () => {
    const { access, org, team, inTeam, outside } = world(driver);
    const lea = access.user("lea");
    assert.ok(lea.can("project.edit", team.id));
    assert.ok(lea.can("project.edit", inTeam.id), "inherited by the project in the team");
    assert.ok(!lea.can("project.edit", outside.id), "not a sibling");
    assert.ok(!lea.can("project.read", org.id), "not upwards");
    const mia = access.user("mia");
    assert.ok(mia.can("project.read", inTeam.id) && mia.can("project.read", outside.id));
    assert.ok(!mia.can("project.edit", inTeam.id));
    assert.ok(!mia.can("billing.manage", org.id));
    // @ts-expect-error: an undeclared permission is a type error
    assert.ok(!mia.can("project.reed", org.id));
    assert.ok(!mia.can("custom.not-defined", org.id), "custom names type-check, and are false until defined");
    assert.ok(!mia.can("project.read", "not-a-scope"));
    assert.ok(!mia.can("project.read", `${org.id}/00000000-0000-4000-8000-000000000000`));
    assert.ok(!mia.can("project.read"), "no scope and no bound tenant");
    assert.deepEqual(access.scopes("lea", org.id).map((s) => s.name).sort(), ["Acme", "Design", "Logo"]);
    assert.equal(access.scope("lea", outside.id), null);
    assert.equal(access.scope("lea", inTeam.id)?.name, "Logo");
  });

  test(`${driver}: a role is only given on the scope types it names`, () => {
    const { access, org, team } = world(driver);
    fails(() => access.assign("alice", { user: "x", role: "lead", scope: org.id }), "invalid", /cannot be given on a org/);
    fails(() => access.assign("alice", { user: "x", role: "admin", scope: team.id }), "invalid");
    fails(() => access.assign("alice", { user: "x", role: "ghost" as never, scope: org.id }), "not-found");
    assert.equal(access.assign("alice", { user: "x", role: "viewer", scope: team.id }).role, "viewer");
    access.assign("alice", { user: "x", role: "viewer", scope: team.id });
    assert.equal(access.members("alice", team.id).filter((m) => m.user === "x").length, 1);
  });

  test(`${driver}: tenants are isolated`, () => {
    const { access, org } = world(driver);
    const other = access.createTenant("eve", { name: "Evil" });
    const eve = access.user("eve");
    assert.ok(!eve.can("project.read", org.id));
    fails(() => access.members("eve", org.id), "forbidden");
    fails(() => access.assign("eve", { user: "eve", role: "owner", scope: org.id }), "forbidden");
    fails(() => access.createScope("eve", { type: "team", parent: org.id, name: "x" }), "forbidden");
    fails(() => access.members("eve", `${org.id}/00000000-0000-4000-8000-000000000000`), "forbidden");
    fails(() => access.members("alice", `${org.id}/00000000-0000-4000-8000-000000000000`), "not-found");
    const bound = access.user("alice").in(org.id)!;
    assert.equal(bound.tenant, org.id);
    assert.ok(bound.can("project.read"));
    assert.ok(!bound.can("project.read", other.id));
    access.assign("eve", { user: "alice", role: "viewer", scope: other.id });
    assert.ok(access.user("alice").can("project.read", other.id), "unbound: any tenant she belongs to");
    assert.ok(!bound.can("project.read", other.id), "bound: still only Acme");
    assert.equal(access.user("alice").tenants().length, 2);
  });

  test(`${driver}: no one gives, invites to or takes away more than they hold`, async () => {
    const { access, org, team, inTeam } = world(driver);
    fails(() => access.assign("adam", { user: "adam", role: "owner", scope: org.id }), "forbidden", /billing\.manage|access\.tenant/);
    fails(() => access.assign("mia", { user: "x", role: "member", scope: org.id }), "forbidden", /manage members/);
    access.assign("lea", { user: "v", role: "viewer", scope: inTeam.id });
    access.assign("lea", { user: "l2", role: "lead", scope: team.id });
    fails(() => access.assign("lea", { user: "v", role: "viewer", scope: org.id }), "forbidden");
    fails(() => access.revoke("adam", { user: "alice", role: "owner", scope: org.id }), "forbidden");
    fails(() => access.removeFromTenant("adam", { user: "alice", tenant: org.id }), "forbidden");
    access.revoke("adam", { user: "mia", role: "member", scope: org.id });
    assert.ok(!access.user("mia").can("project.read", org.id));
    await failsAsync(() => access.createInvite("adam", { scope: org.id, role: "owner" }), "forbidden");
    await failsAsync(() => access.createInvite("mia", { scope: org.id, role: "viewer" }), "forbidden");
  });

  test(`${driver}: a tenant always keeps an owner`, () => {
    const { access, org } = world(driver);
    fails(() => access.revoke("alice", { user: "alice", role: "owner", scope: org.id }), "last-owner");
    fails(() => access.removeFromTenant("alice", { user: "alice", tenant: org.id }), "last-owner");
    access.assign("alice", { user: "olga", role: "owner", scope: org.id });
    access.revoke("olga", { user: "alice", role: "owner", scope: org.id });
    assert.ok(!access.user("alice").can("billing.manage", org.id));
    fails(() => access.removeFromTenant("olga", { user: "olga", tenant: org.id }), "last-owner");
    access.removeFromTenant("mia", { user: "mia", tenant: org.id });
    assert.equal(access.user("mia").in(org.id), null);
    fails(() => access.removeFromTenant("mia", { user: "mia", tenant: org.id }), "not-found");
    fails(() => access.revoke("olga", { user: "nobody", role: "member", scope: org.id }), "not-found");
  });

  test(`${driver}: tenants define custom permissions and custom roles`, () => {
    const { access, org, inTeam } = world(driver);
    const p = access.definePermission("alice", { tenant: org.id, name: "invoices.approve", label: "Approve invoices" });
    assert.equal(p.name, "custom.invoices.approve");
    assert.ok(access.user("alice").can("custom.invoices.approve", org.id), "`*` includes custom permissions");
    assert.ok(!access.user("adam").can("custom.invoices.approve", org.id));
    fails(() => access.definePermission("alice", { tenant: org.id, name: "invoices.approve", label: "x" }), "conflict");
    fails(() => access.definePermission("alice", { tenant: org.id, name: "Bad Name", label: "x" }), "invalid");
    fails(() => access.definePermission("mia", { tenant: org.id, name: "x", label: "x" }), "forbidden");

    fails(
      () => access.createRole("adam", { tenant: org.id, name: "Approver", scopes: ["org"], permissions: ["custom.invoices.approve"] }),
      "forbidden",
      /custom\.invoices\.approve/,
    );
    fails(
      () => access.createRole("alice", { tenant: org.id, name: "X", scopes: ["org"], permissions: ["custom.nope"] }),
      "invalid",
      /unknown permission/,
    );
    const approver = access.createRole("alice", {
      tenant: org.id,
      name: "Approver",
      scopes: ["org", "project"],
      permissions: ["custom.invoices.approve", "project.read"],
    });
    assert.match(approver.role, /^custom:/);
    fails(() => access.createRole("alice", { tenant: org.id, name: "approver", scopes: ["org"], permissions: [] }), "conflict");
    fails(() => access.createRole("alice", { tenant: org.id, name: "admin", scopes: ["org"], permissions: [] }), "conflict");

    access.assign("alice", { user: "ivy", role: approver.role, scope: inTeam.id });
    assert.ok(access.user("ivy").can("custom.invoices.approve", inTeam.id));
    assert.ok(!access.user("ivy").can("custom.invoices.approve", org.id));
    assert.equal(access.members("alice", inTeam.id).find((m) => m.user === "ivy")?.label, "Approver");
    assert.ok(access.roleList("ivy", org.id).some((r) => r.role === approver.role && r.custom));
    assert.ok(access.permissionList("ivy", org.id).some((x) => x.name === "custom.invoices.approve" && x.custom));
    fails(() => access.roleList("eve", org.id), "forbidden");

    fails(() => access.updateRole("adam", approver.role, { name: "Mine" }), "forbidden");
    access.updateRole("alice", approver.role, { permissions: ["project.read", "project.edit"] });
    assert.ok(access.user("ivy").can("project.edit", inTeam.id), "holders get the new permissions");
    assert.ok(!access.user("ivy").can("custom.invoices.approve", inTeam.id));
    access.updateRole("alice", approver.role, { scopes: ["org"] });
    assert.ok(!access.user("ivy").can("project.read", inTeam.id), "no longer valid on a project");

    access.updateRole("alice", approver.role, { scopes: ["org", "project"], permissions: ["custom.invoices.approve"] });
    assert.ok(access.user("ivy").can("custom.invoices.approve", inTeam.id));
    fails(() => access.deletePermission("adam", { tenant: org.id, name: "invoices.approve" }), "forbidden");
    access.deletePermission("alice", { tenant: org.id, name: "invoices.approve" });
    assert.ok(!access.user("ivy").can("custom.invoices.approve", inTeam.id));
    assert.deepEqual(access.roleList("alice", org.id).find((r) => r.role === approver.role)?.permissions, []);
    access.deleteRole("alice", approver.role);
    assert.equal(access.members("alice", inTeam.id).find((m) => m.user === "ivy"), undefined);
    fails(() => access.assign("alice", { user: "ivy", role: approver.role, scope: org.id }), "not-found");
  });

  test(`${driver}: custom limits hold`, () => {
    const { access, org } = world(driver);
    for (const n of ["a", "b", "c"]) access.definePermission("alice", { tenant: org.id, name: n, label: n });
    fails(() => access.definePermission("alice", { tenant: org.id, name: "d", label: "d" }), "limit");
    for (const n of ["A", "B", "C"]) access.createRole("alice", { tenant: org.id, name: n, scopes: ["org"], permissions: [] });
    fails(() => access.createRole("alice", { tenant: org.id, name: "D", scopes: ["org"], permissions: [] }), "limit");
    const other = access.createTenant("eve", { name: "Evil" });
    access.definePermission("eve", { tenant: other.id, name: "a", label: "a" });
    assert.ok(!access.user("alice").can("custom.a", other.id));
    assert.ok(access.user("eve").can("custom.a", other.id));
  });

  test(`${driver}: a custom role from another tenant cannot be given`, () => {
    const { access, org } = world(driver);
    const other = access.createTenant("eve", { name: "Evil" });
    const role = access.createRole("eve", { tenant: other.id, name: "Spy", scopes: ["org"], permissions: ["project.read"] });
    fails(() => access.assign("alice", { user: "eve", role: role.role, scope: org.id }), "not-found");
    fails(() => access.deleteRole("alice", role.role), "forbidden");
  });

  test(`${driver}: invites are single-use bearer tokens, stored hashed`, async () => {
    const { access, org, team } = world(driver);
    const { token, invite } = await access.createInvite("lea", { scope: team.id, role: "viewer" });
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const stored = access.models.Invite.as({ id: "x" }).all();
    assert.deepEqual(stored, [], "the models are closed to other actors");
    assert.equal((await access.inspectInvite(token))?.scope, "Design");
    assert.deepEqual(access.invites("lea", team.id).map((i) => i.id), [invite.id]);
    const m = await access.acceptInvite(token, "newbie");
    assert.equal(m.role, "viewer");
    assert.equal(m.by, "lea");
    assert.ok(access.user("newbie").can("project.read", team.id));
    await failsAsync(() => access.acceptInvite(token, "someone-else"), "not-found");
    assert.equal(await access.inspectInvite(token), null);
    await failsAsync(() => access.acceptInvite("garbage", "x"), "not-found");
    await failsAsync(() => access.acceptInvite("A".repeat(43), "x"), "not-found");
    assert.deepEqual(access.invites("lea", team.id), []);
    void org;
  });

  test(`${driver}: invites expire, bind to an email and die with their sender's rights`, async () => {
    const { access, org, team } = world(driver);
    const short = await access.createInvite("alice", { scope: org.id, role: "member", ttlMs: 1000 });
    clock += 1001;
    await failsAsync(() => access.acceptInvite(short.token, "x"), "expired");

    const bound = await access.createInvite("alice", { scope: org.id, role: "member", email: " Bo@Example.com " });
    assert.equal(bound.invite.email, "bo@example.com");
    await failsAsync(() => access.acceptInvite(bound.token, "x"), "forbidden");
    await failsAsync(() => access.acceptInvite(bound.token, "x", { email: "eve@example.com" }), "forbidden");
    await access.acceptInvite(bound.token, "bo", { email: "BO@example.com" });
    assert.ok(access.user("bo").can("project.read", org.id));

    const fromLea = await access.createInvite("lea", { scope: team.id, role: "lead" });
    access.revoke("alice", { user: "lea", role: "lead", scope: team.id });
    await failsAsync(() => access.acceptInvite(fromLea.token, "x"), "forbidden");

    const withdrawn = await access.createInvite("alice", { scope: org.id, role: "viewer" });
    fails(() => access.revokeInvite("mia", withdrawn.invite.id), "forbidden");
    access.revokeInvite("adam", withdrawn.invite.id);
    await failsAsync(() => access.acceptInvite(withdrawn.token, "x"), "not-found");

    await failsAsync(() => access.createInvite("alice", { scope: org.id, role: "viewer", ttlMs: 8 * 24 * 3600 * 1000 }), "invalid");
    await failsAsync(() => access.createInvite("alice", { scope: org.id, role: "viewer", email: "nope" }), "invalid");
  });

  test(`${driver}: pending invites per tenant are limited; expired ones are cleared`, async () => {
    const { access, org } = world(driver);
    for (let i = 0; i < 3; i++) await access.createInvite("alice", { scope: org.id, role: "viewer", ttlMs: 1000 });
    await failsAsync(() => access.createInvite("alice", { scope: org.id, role: "viewer" }), "limit");
    clock += 1001;
    await access.createInvite("alice", { scope: org.id, role: "viewer" });
    assert.equal(access.invites("alice", org.id).length, 1);
  });

  test(`${driver}: deleting a scope removes what is inside it`, async () => {
    const { access, org, team, inTeam, outside } = world(driver);
    await access.createInvite("lea", { scope: inTeam.id, role: "viewer" });
    fails(() => access.deleteScope("lea", team.id), "forbidden");
    fails(() => access.renameScope("lea", team.id, "x"), "forbidden");
    assert.equal(access.renameScope("adam", team.id, "Brand").name, "Brand");
    access.deleteScope("adam", team.id);
    assert.ok(!access.user("lea").can("project.read", inTeam.id));
    assert.equal(access.user("lea").in(org.id), null);
    assert.deepEqual(access.scopes("alice", org.id).map((s) => s.id).sort(), [org.id, outside.id].sort());
    assert.deepEqual(access.models.Invite.as({ id: "alice" }).all(), []);
    fails(() => access.deleteScope("adam", org.id), "forbidden");
    access.definePermission("alice", { tenant: org.id, name: "x", label: "x" });
    access.deleteScope("alice", org.id);
    assert.deepEqual(access.user("alice").tenants(), []);
    assert.ok(!access.user("adam").can("project.read", outside.id));
  });

  test(`${driver}: the models refuse every actor but this package`, () => {
    const { access, org } = world(driver);
    const forged = { id: "eve", tenant: org.id, user: "alice" };
    assert.deepEqual(access.models.Member.as(forged).all(), []);
    assert.deepEqual(access.models.Scope.as(forged).all(), []);
    assert.equal(
      access.models.Member.as(forged).create({ id: "m", tenant: org.id, scope: org.id, user: "eve", role: "owner", by: "eve", created: 0 }),
      undefined,
    );
    assert.equal(access.models.Member.as(forged).delete(() => true), 0);
    assert.ok(!access.user("eve").can("project.read", org.id));
  });

  test(`${driver}: @tenant models and rules use the principal`, () => {
    const { access, org, inTeam, outside } = world(driver);
    interface Task {
      id: string;
      org: string;
      project: string;
    }
    type Actor = ReturnType<typeof access.user>;
    const Task = defineModel<Task>("Task", {
      fields: { id: "string", org: "string", project: "string" },
      attrs: { org: { tenant: true } },
      read: (a: Actor, t) => a.can("project.read", t.project),
      write: (a: Actor, t) => a.can("project.edit", t.project),
    });
    if (driver === "sqlite") useDatabase(openSqlite(":memory:"), [Task as unknown as Model<never>]);
    const lea = access.user("lea").in(org.id)!;
    assert.ok(Task.as(lea).create({ id: "t1", project: inTeam.id } as Task), "tenant filled from the principal");
    assert.equal(Task.as(lea).create({ id: "t2", project: outside.id } as Task), undefined);
    assert.ok(Task.as(access.user("alice").in(org.id)!).create({ id: "t2", project: outside.id } as Task));
    assert.deepEqual(Task.as(lea).all().map((t) => t.id), ["t1"]);
    assert.equal(Task.as(lea).all()[0].org, org.id);
    assert.deepEqual(Task.as(access.user("alice")).all(), []);
  });

  test(`${driver}: a revoked role takes effect at once`, () => {
    const { access, org, team } = world(driver);
    const lea = access.user("lea");
    assert.ok(lea.can("project.edit", team.id));
    assert.ok(lea.can("project.edit", team.id), "cached");
    access.revoke("adam", { user: "lea", role: "lead", scope: team.id });
    assert.ok(!lea.can("project.edit", team.id));
    void org;
  });

  test(`${driver}: a bound principal leaves its tenant with its last role`, () => {
    const { access, org } = world(driver);
    interface Note {
      id: string;
      org: string;
    }
    const Note = defineModel<Note>("Note", {
      fields: { id: "string", org: "string" },
      attrs: { org: { tenant: true } },
      read: () => true,
      write: () => true,
    });
    if (driver === "sqlite") useDatabase(openSqlite(":memory:"), [Note as unknown as Model<never>]);
    const lea = access.user("lea").in(org.id)!;
    assert.ok(Note.as(lea).create({ id: "n1" } as Note));
    assert.equal(Note.as(lea).all().length, 1);
    const other = access.createTenant("eve", { name: "Elsewhere" });
    access.assign("eve", { user: "lea", role: "viewer", scope: other.id });
    access.removeFromTenant("alice", { user: "lea", tenant: org.id });
    assert.equal(lea.tenant, undefined);
    assert.deepEqual(Note.as(lea).all(), []);
    assert.equal(Note.as(lea).create({ id: "n2" } as Note), undefined);
    assert.ok(!lea.can("project.read", other.id), "still never answers for another tenant");
    assert.equal(lea.permissions().length, 0);
    access.assign("alice", { user: "lea", role: "viewer", scope: org.id });
    assert.equal(lea.tenant, org.id);
  });
}

test("a cache hit still reports the read, so sync re-renders on a change", () => {
  const { access, org } = world();
  const mia = access.user("mia");
  const seen: [string, unknown][] = [];
  const stop = onRead((model, actor) => seen.push([model.name, actor]));
  assert.ok(mia.can("project.read", org.id));
  const first = seen.length;
  assert.ok(first > 0);
  assert.ok(mia.can("project.read", org.id));
  assert.ok(seen.length > first, "noted again on a cache hit");
  stop();
  const memberRead = seen.find(([name]) => name === "AccessMember")!;
  const changes: Parameters<typeof canSee>[2][] = [];
  const unsub = access.models.Member.feed.subscribe((c) => changes.push(c));
  access.revoke("alice", { user: "mia", role: "member", scope: org.id });
  unsub();
  assert.ok(changes.some((c) => canSee(access.models.Member as Model<unknown>, memberRead[1] as never, c)));
});

test("what a rolled-back transaction saw is not cached", () => {
  const { access, org } = world();
  assert.throws(() =>
    transaction(() => {
      access.assign("alice", { user: "temp", role: "admin", scope: org.id });
      assert.ok(access.user("temp").can("project.edit", org.id));
      throw new Error("roll back");
    }),
  );
  assert.ok(!access.user("temp").can("project.edit", org.id));
  assert.equal(access.user("temp").in(org.id), null);
});

test("a gap on the change feed drops the cache", () => {
  const access = make("sqlite");
  const db = openSqlite(":memory:");
  useDatabase(db, Object.values(access.models) as Model<never>[]);
  const org = access.createTenant("alice", { name: "Acme" });
  access.assign("alice", { user: "mia", role: "member", scope: org.id });
  assert.ok(access.user("mia").can("project.read", org.id));
  db.prepare(`DELETE FROM "AccessMember" WHERE "user" = ?`).run("mia");
  assert.ok(access.user("mia").can("project.read", org.id), "still cached");
  access.models.Member.feed.gap();
  assert.ok(!access.user("mia").can("project.read", org.id));
});

test("writes are audited under the acting user", () => {
  const { access, org } = world();
  const events: AuditEvent[] = [];
  const stop = audit((e) => events.push(e));
  access.assign("adam", { user: "zed", role: "viewer", scope: org.id });
  try {
    access.assign("mia", { user: "zed", role: "member", scope: org.id });
  } catch (e) {
    assert.ok(e instanceof AccessError);
  }
  stop();
  const created = events.filter((e) => e.action === "create" && e.model === "AccessMember");
  assert.equal(created.length, 1);
  assert.equal((created[0].actor as { id: string }).id, "adam");
});

test("custom roles and permissions are off unless configured", () => {
  const access = defineAccess({
    scopes: { org: {} },
    permissions: {},
    roles: { owner: { scope: "org", permissions: ["*"] } },
    owner: "owner",
  });
  const org = access.createTenant("a", { name: "A" });
  fails(() => access.definePermission("a", { tenant: org.id, name: "x", label: "x" }), "invalid", /not enabled/);
  fails(() => access.createRole("a", { tenant: org.id, name: "x", scopes: ["org"], permissions: [] }), "invalid", /not enabled/);
});

test("who may create tenants is configurable", () => {
  const access = defineAccess({
    scopes: { org: {} },
    permissions: {},
    roles: { owner: { scope: "org", permissions: ["*"] } },
    owner: "owner",
    canCreateTenant: (id) => id === "staff",
  });
  fails(() => access.createTenant("anyone", { name: "x" }), "forbidden");
  assert.ok(access.createTenant("staff", { name: "x" }));
  fails(() => access.createTenant("", { name: "x" }), "invalid");
  fails(() => access.createTenant("staff", { name: "" }), "invalid");
  fails(() => access.createTenant("staff", { name: "x".repeat(101) }), "invalid");
});

test("explain lists each role's permissions and what its holders can give", () => {
  const { access, org } = world();
  const report = access.explain();
  const role = (name: string) => report.roles.find((r) => r.role === name)!;
  assert.ok(role("owner").all);
  assert.ok(role("owner").permissions.includes("billing.manage"));
  assert.deepEqual(role("admin").permissions, [
    "access.members.manage",
    "access.members.read",
    "access.permissions.manage",
    "access.roles.manage",
    "access.scopes.manage",
    "project.edit",
    "project.read",
  ]);
  assert.deepEqual(role("owner").canGive.sort(), ["admin", "lead", "member", "owner", "viewer"]);
  assert.deepEqual(role("admin").canGive.sort(), ["admin", "lead", "member", "viewer"]);
  assert.deepEqual(role("lead").canGive.sort(), ["lead", "viewer"]);
  assert.deepEqual(role("member").canGive, []);
  access.assign("alice", { user: "a2", role: "admin", scope: org.id });
  fails(() => access.assign("adam", { user: "x", role: "owner", scope: org.id }), "forbidden");

  access.definePermission("alice", { tenant: org.id, name: "invoices.approve", label: "Approve invoices" });
  const approver = access.createRole("alice", { tenant: org.id, name: "Approver", scopes: ["org"], permissions: ["custom.invoices.approve"] });
  const t = access.explain(org.id);
  assert.equal(t.name, "Acme");
  assert.ok(t.permissions.some((p) => p.name === "custom.invoices.approve" && p.custom));
  assert.ok(t.roles.find((r) => r.role === "owner")!.permissions.includes("custom.invoices.approve"));
  assert.ok(t.roles.find((r) => r.role === "owner")!.canGive.includes(approver.role));
  assert.ok(!t.roles.find((r) => r.role === "admin")!.canGive.includes(approver.role));
  const text = explainText(t);
  assert.match(text, /^Access for tenant Acme/);
  assert.match(text, /Role Approver \[custom\], on org\n {2}can: custom\.invoices\.approve/);
  assert.match(text, /Role lead, on team, project\n {2}can: access\.members\.manage, access\.members\.read, project\.edit, project\.read\n {2}gives: lead, viewer/);
  fails(() => access.explain("nope"), "not-found");
});
