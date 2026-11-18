import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Model } from "@weft-framework/data";
import { pgliteAsPool, usePostgres } from "@weft-framework/data/postgres";
import { defineAccess, isAccessError } from "../src/index.ts";

// The same access API on Postgres: writes return Promises, permission checks stay synchronous
// (they read the in-memory replicas that usePostgres sets up for the access models).

async function make() {
  const access = defineAccess({
    scopes: { org: {}, project: { parent: "org" } },
    permissions: { "project.read": "See projects", "project.edit": "Change projects" },
    roles: {
      owner: { scope: "org", permissions: ["*"] },
      member: { scope: "org", permissions: ["project.read", "access.members.read"] },
      lead: { scope: "project", permissions: ["project.read", "project.edit"] },
    },
    owner: "owner",
    custom: { roles: { max: 3 }, permissions: { max: 3 } },
    invites: { max: 3 },
    settings: { plan: { type: "string", default: "free", editable: true } },
  });
  await usePostgres(pgliteAsPool(new PGlite()), Object.values(access.models) as Model<never>[], { onWarning: () => {} });
  return access;
}

test("access on Postgres: tenants, scopes and roles; checks are synchronous", async () => {
  const access = await make();
  const org = await access.createTenant("alice", { name: "Acme" });
  const project = await access.createScope("alice", { type: "project", parent: org.id, name: "Site" });
  await access.assign("alice", { user: "mia", role: "member", scope: org.id });
  await access.assign("alice", { user: "lea", role: "lead", scope: project.id });

  assert.equal(access.allows("alice", "project.edit", project.id), true);
  assert.equal(access.allows("mia", "project.read", project.id), true, "inherited from the org");
  assert.equal(access.allows("mia", "project.edit", project.id), false);
  assert.equal(access.allows("lea", "project.edit", project.id), true);
  assert.equal(access.allows("lea", "project.read", org.id), false, "not upwards");
  assert.deepEqual(
    access.members("alice", org.id).map((m) => m.user).sort(),
    ["alice", "mia"],
  );
  assert.deepEqual(access.tenantsOf("mia").map((t) => t.name), ["Acme"]);

  await access.revoke("alice", { user: "mia", role: "member", scope: org.id });
  assert.equal(access.allows("mia", "project.read", project.id), false, "revocation is visible at once");
});

test("access on Postgres: a failed write rolls back and changes nothing", async () => {
  const access = await make();
  const org = await access.createTenant("alice", { name: "Acme" });
  await assert.rejects(
    async () => access.revoke("alice", { user: "alice", role: "owner", scope: org.id }),
    (e: unknown) => isAccessError(e) && e.code === "last-owner",
  );
  assert.equal(access.allows("alice", "access.tenant.manage", org.id), true);
});

test("access on Postgres: custom roles, settings and invites", async () => {
  const access = await make();
  const org = await access.createTenant("alice", { name: "Acme" });
  const role = await access.createRole("alice", { tenant: org.id, name: "Support", scopes: ["org"], permissions: ["project.read"] });
  await access.assign("alice", { user: "sam", role: role.role, scope: org.id });
  assert.equal(access.allows("sam", "project.read", org.id), true);
  await access.deleteRole("alice", role.role);
  assert.equal(access.allows("sam", "project.read", org.id), false);

  const settings = await access.updateSettings("alice", org.id, { plan: "pro" });
  assert.equal(settings.plan, "pro");
  assert.equal(access.settingValue(org.id, "plan"), "pro");

  const { token } = await access.createInvite("alice", { scope: org.id, role: "member" });
  assert.equal(access.invites("alice", org.id).length, 1);
  const joined = await access.acceptInvite(token, "nina");
  assert.equal(joined.role, "member");
  assert.equal(access.allows("nina", "project.read", org.id), true);
  assert.equal(access.invites("alice", org.id).length, 0, "used invites are not pending");
});
