import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, type Model } from "@weft-framework/data";
import { openSqlite } from "@weft-framework/data/sqlite";
import { defineAccess } from "../src/index.ts";
import { defineScim, type ScimPerson } from "../src/scim.ts";

const BASE = "/api/scim/v2";
let n = 0;

function make(driver: "memory" | "sqlite", o: { rateLimit?: number } = {}) {
  const access = defineAccess({
    scopes: { org: {}, project: { parent: "org" } },
    permissions: { "project.read": "See projects" },
    roles: {
      owner: { scope: "org", permissions: ["*"] },
      admin: { scope: "org", permissions: ["access.members.manage", "access.members.read", "project.read"] },
      member: { scope: "org", permissions: ["project.read"] },
      viewer: { scope: ["org", "project"], permissions: ["project.read"] },
    },
    owner: "owner",
    settings: { seats: { type: "number", default: 10, min: 1, integer: true } },
    seats: "seats",
  });
  const calls: string[] = [];
  let next = 0;
  const scim = defineScim({
    access,
    base: BASE,
    defaultRole: "member",
    groups: { Admins: "admin", Readers: "viewer", Owners: "owner", Everyone: "member" },
    prefix: `Scim${++n}`,
    ...(o.rateLimit ? { rateLimit: o.rateLimit } : {}),
    users: {
      create: (p: ScimPerson, tenant: string) => {
        calls.push(`create ${p.userName} in ${tenant}`);
        return `u${++next}`;
      },
      update: (id: string, p: ScimPerson) => void calls.push(`update ${id} ${p.displayName}`),
      deactivate: (id: string, tenant: string) => void calls.push(`deactivate ${id} in ${tenant}`),
    },
  });
  if (driver === "sqlite") {
    const db = openSqlite(":memory:");
    useDatabase(db, [...Object.values(access.models), ...Object.values(scim.models)] as Model<never>[]);
  }
  const org = access.createTenant("alice", { name: "Acme" });
  access.assign("alice", { user: "adam", role: "admin", scope: org.id });
  const other = access.createTenant("olga", { name: "Other" });
  const call = async (token: string | null, method: string, path: string, body?: unknown) => {
    const res = await scim.handle(
      new Request(`https://app.test${BASE}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/scim+json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const text = await res.text();
    return { status: res.status, type: res.headers.get("content-type"), body: text ? JSON.parse(text) : null };
  };
  return { access, scim, org, other, calls, call };
}

const roles = (access: ReturnType<typeof make>["access"], tenant: string, user: string) =>
  access.members("alice", tenant).filter((m) => m.user === user).map((m) => m.role).sort();

const patch = (...ops: object[]) => ({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: ops });

for (const driver of ["memory", "sqlite"] as const) {
  test(`${driver}: tokens are per tenant, hashed, and act as the admin who made them`, async () => {
    const { access, scim, org, other, call } = make(driver);
    await assert.rejects(scim.createToken("bob", org.id, { name: "x" }), /may not manage/, "not a member");
    access.assign("alice", { user: "mia", role: "member", scope: org.id });
    await assert.rejects(scim.createToken("mia", org.id, { name: "x" }), /may not manage/, "a member without manage");
    const { id, token } = await scim.createToken("adam", org.id, { name: "Okta" });
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(scim.tokens("adam", org.id).map((t) => [t.id, t.name, t.by]), [[id, "Okta", "adam"]]);
    assert.ok(!JSON.stringify(scim.models.ScimToken.publicUnscoped()).includes(token), "only the hash is stored");

    assert.equal((await call(null, "GET", "/Users")).status, 401);
    assert.equal((await call("x".repeat(43), "GET", "/Users")).status, 401);
    const cfg = await call(token, "GET", "/ServiceProviderConfig");
    assert.equal(cfg.status, 200);
    assert.equal(cfg.type, "application/scim+json");
    assert.equal(cfg.body.patch.supported, true);

    const { token: theirs } = await scim.createToken("olga", other.id, { name: "Entra" });
    const made = await call(token, "POST", "/Users", { userName: "ann@acme.test" });
    assert.equal((await call(theirs, "GET", `/Users/${made.body.id}`)).status, 404);
    assert.equal((await call(theirs, "GET", "/Users")).body.totalResults, 0);

    access.assign("alice", { user: "adam", role: "member", scope: org.id });
    access.revoke("alice", { user: "adam", role: "admin", scope: org.id });
    assert.equal(access.memberOf("adam", org.id), true);
    assert.equal((await call(token, "GET", "/Users")).status, 401);
    access.removeFromTenant("alice", { user: "adam", tenant: org.id });
    assert.equal((await call(token, "GET", "/Users")).status, 401);
    access.assign("alice", { user: "adam", role: "admin", scope: org.id });
    assert.equal((await call(token, "GET", "/Users")).status, 200);
    scim.revokeToken("adam", org.id, id);
    assert.equal((await call(token, "GET", "/Users")).status, 401);
    assert.throws(() => scim.revokeToken("adam", org.id, id), /no such token/);
  });

  test(`${driver}: users are created, found, changed, deactivated and deleted`, async () => {
    const { access, scim, org, calls, call } = make(driver);
    const { token } = await scim.createToken("adam", org.id, { name: "Okta" });
    const ann = await call(token, "POST", "/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "Ann@Acme.test",
      externalId: "00u1",
      name: { givenName: "Ann", familyName: "Lee" },
      emails: [{ value: "home@x.test" }, { value: "ann@acme.test", primary: true }],
      active: true,
      title: "ignored",
    });
    assert.equal(ann.status, 201);
    const id = ann.body.id;
    assert.equal(ann.body.userName, "Ann@Acme.test");
    assert.equal(ann.body.emails[0].value, "ann@acme.test");
    assert.equal(ann.body.name.formatted, "Ann Lee");
    assert.equal(ann.body.meta.location, `${BASE}/Users/${id}`);
    assert.deepEqual(roles(access, org.id, id), ["member"]);
    assert.deepEqual(calls, [`create Ann@Acme.test in ${org.id}`]);

    const found = await call(token, "GET", `/Users?filter=${encodeURIComponent('userName eq "ann@acme.TEST"')}`);
    assert.deepEqual([found.body.totalResults, found.body.Resources[0].id], [1, id]);
    await call(token, "POST", "/Users", { userName: "zed@acme.test", externalId: "00u2" });
    const byExt = await call(token, "GET", `/Users?filter=${encodeURIComponent('externalId eq "00u2"')}`);
    assert.deepEqual([byExt.body.totalResults, byExt.body.Resources[0].userName], [1, "zed@acme.test"]);
    await call(token, "DELETE", `/Users/${byExt.body.Resources[0].id}`);
    const dup = await call(token, "POST", "/Users", { userName: "ANN@acme.test" });
    assert.deepEqual([dup.status, dup.body.scimType], [409, "uniqueness"]);
    assert.equal((await call(token, "GET", `/Users?filter=${encodeURIComponent("title co \"x\"")}`)).body.scimType, "invalidFilter");
    assert.equal((await call(token, "POST", "/Users", { name: {} })).status, 400, "userName is required");
    assert.equal((await call(token, "POST", "/Users", { userName: "x".repeat(300) })).status, 400);

    const off = await call(token, "PATCH", `/Users/${id}`, patch({ op: "Replace", path: "active", value: "False" }));
    assert.equal(off.body.active, false);
    assert.deepEqual(roles(access, org.id, id), [], "every role in the tenant goes");
    assert.ok(calls.includes(`deactivate ${id} in ${org.id}`));
    const on = await call(token, "PATCH", `/Users/${id}`, patch({ op: "replace", value: { active: true, displayName: "Ann L." } }));
    assert.deepEqual([on.body.active, on.body.displayName], [true, "Ann L."]);
    assert.deepEqual(roles(access, org.id, id), ["member"]);
    assert.ok(calls.includes(`update ${id} Ann L.`));

    const put = await call(token, "PUT", `/Users/${id}`, { userName: "ann@acme.test", displayName: "Ann" });
    assert.deepEqual([put.status, put.body.displayName, put.body.externalId], [200, "Ann", undefined]);

    assert.equal((await call(token, "GET", "/Users/alice")).status, 404);
    assert.equal((await call(token, "PATCH", "/Users/adam", patch({ op: "replace", path: "active", value: false }))).status, 404);
    assert.deepEqual(roles(access, org.id, "adam"), ["admin"]);

    access.assign("adam", { user: id, role: "viewer", scope: access.createScope("alice", { type: "project", parent: org.id, name: "P" }).id });
    assert.equal((await call(token, "DELETE", `/Users/${id}`)).status, 204);
    assert.equal(access.memberOf(id, org.id), false);
    assert.equal((await call(token, "GET", `/Users/${id}`)).status, 404);
    assert.equal((await call(token, "GET", "/Users")).body.totalResults, 0);

    for (const u of ["a", "b", "c"]) await call(token, "POST", "/Users", { userName: `${u}@acme.test` });
    const p2 = await call(token, "GET", "/Users?startIndex=2&count=1");
    assert.deepEqual([p2.body.totalResults, p2.body.startIndex, p2.body.itemsPerPage, p2.body.Resources[0].userName], [3, 2, 1, "b@acme.test"]);
  });

  test(`${driver}: groups are the app's roles, under the admin's own limits`, async () => {
    const { access, scim, org, call } = make(driver);
    const { token } = await scim.createToken("adam", org.id, { name: "Okta" });
    const a = (await call(token, "POST", "/Users", { userName: "a@acme.test" })).body.id;
    const b = (await call(token, "POST", "/Users", { userName: "b@acme.test" })).body.id;

    const list = await call(token, "GET", `/Groups?filter=${encodeURIComponent('displayName eq "admins"')}`);
    assert.deepEqual([list.body.totalResults, list.body.Resources[0].id], [1, "admin"]);
    const made = await call(token, "POST", "/Groups", { displayName: "Admins", members: [{ value: a }] });
    assert.deepEqual([made.status, made.body.members.map((m: { value: string }) => m.value)], [201, [a]]);
    assert.deepEqual(roles(access, org.id, a), ["admin", "member"]);
    assert.equal((await call(token, "POST", "/Groups", { displayName: "Finance" })).status, 400, "no role mapped");

    await call(token, "PATCH", "/Groups/admin", patch({ op: "add", path: "members", value: [{ value: b }] }));
    assert.deepEqual(roles(access, org.id, b), ["admin", "member"]);
    await call(token, "PATCH", "/Groups/admin", patch({ op: "remove", path: `members[value eq "${a}"]` }));
    assert.deepEqual(roles(access, org.id, a), ["member"]);
    await call(token, "PUT", "/Groups/admin", { displayName: "Admins", members: [{ value: a }] });
    assert.deepEqual([roles(access, org.id, a), roles(access, org.id, b), roles(access, org.id, "adam")], [["admin", "member"], ["member"], ["admin"]]);
    const g = await call(token, "GET", "/Groups/admin");
    assert.deepEqual(g.body.members.map((m: { value: string }) => m.value), [a], "only provisioned people are listed");
    assert.equal((await call(token, "GET", "/Groups?excludedAttributes=members")).body.Resources[0].members, undefined);

    assert.equal((await call(token, "PATCH", "/Groups/admin", patch({ op: "add", path: "members", value: [{ value: "alice" }] }))).status, 404);
    assert.equal((await call(token, "PATCH", "/Groups/admin", patch({ op: "replace", path: "displayName", value: "Root" }))).status, 403);
    assert.equal((await call(token, "DELETE", "/Groups/admin")).status, 403);
    assert.equal((await call(token, "GET", "/Groups/project")).status, 404, "unmapped roles are not groups");
    const owners = await call(token, "PATCH", "/Groups/owner", patch({ op: "add", path: "members", value: [{ value: b }] }));
    assert.equal(owners.status, 403, "an admin's token cannot make owners");
    assert.deepEqual(roles(access, org.id, b), ["member"]);
    await call(token, "PATCH", `/Users/${b}`, patch({ op: "replace", path: "active", value: false }));
    assert.equal((await call(token, "PATCH", "/Groups/viewer", patch({ op: "add", path: "members", value: [{ value: b }] }))).status, 400);
    await call(token, "PATCH", "/Groups/member", patch({ op: "remove", path: `members[value eq "${a}"]` }));
    await call(token, "PUT", "/Groups/member", { members: [] });
    assert.deepEqual(roles(access, org.id, a), ["admin", "member"]);
    assert.deepEqual((await call(token, "GET", `/Users/${a}`)).body.groups, [
      { value: "admin", display: "Admins" },
      { value: "member", display: "Everyone" },
    ]);
  });
}

test("seats, rate limits and malformed requests", async () => {
  const { access, scim, org, call } = make("memory", { rateLimit: 30 });
  access.configureTenant(org.id, { seats: 3 });
  const { token } = await scim.createToken("adam", org.id, { name: "Okta" });
  assert.equal((await call(token, "POST", "/Users", { userName: "a@acme.test" })).status, 201);
  const full = await call(token, "POST", "/Users", { userName: "b@acme.test" });
  assert.equal(full.status, 403, "alice, adam and a fill the three seats");
  assert.match(full.body.detail, /seat/);
  assert.equal((await call(token, "GET", "/Users?filter=" + encodeURIComponent('userName eq "b@acme.test"'))).body.totalResults, 0, "nothing half-made");
  assert.equal((await call(token, "PATCH", "/Users/x", { Operations: "no" })).status, 404);
  const a = (await call(token, "GET", "/Users")).body.Resources[0].id;
  assert.equal((await call(token, "PATCH", `/Users/${a}`, { Operations: [{ op: "move" }] })).body.scimType, "invalidSyntax");
  assert.equal((await scim.handle(new Request(`https://app.test${BASE}/Users`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{" }))).status, 400);
  assert.equal((await call(token, "GET", "/Nope")).status, 404);
  assert.equal((await call(token, "DELETE", "/Users")).status, 405);
  for (let i = 0; i < 30; i++) await call(token, "GET", "/ServiceProviderConfig");
  assert.equal((await call(token, "GET", "/Users")).status, 429);
  assert.throws(() => defineScim({ access, base: "api", defaultRole: "member", users: { create: () => "x" } }), /base/);
  assert.throws(() => defineScim({ access, base: BASE, defaultRole: "member", groups: { A: "admin", B: "admin" }, users: { create: () => "x" } }), /same role/);
});
