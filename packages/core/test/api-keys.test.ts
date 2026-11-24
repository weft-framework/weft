import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { useDatabase, type Model } from "@weft-framework/data";
import { pgliteAsPool, usePostgres } from "@weft-framework/data/postgres";
import { openSqlite } from "@weft-framework/data/sqlite";
import { defineApiKeys, ipAllowed, parseCidr } from "../src/api-keys.ts";
import { isAccessError, type AccessErrorCode } from "../src/index.ts";

async function rejects(p: Promise<unknown>, code: AccessErrorCode, msg?: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(isAccessError(e), `expected an AccessError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (msg) assert.match(e.message, msg);
    return true;
  });
}

async function make(driver: "memory" | "sqlite" | "postgres", extra: { max?: number } = {}) {
  let clock = Date.UTC(2026, 10, 24);
  const keys = defineApiKeys({
    prefix: "acme_app_",
    accept: ["ptla_"],
    scopes: ["servers.read", "servers.write", "users.read"],
    now: () => clock,
    ...extra,
  });
  const models = Object.values(keys.models) as unknown as Model<never>[];
  if (driver === "sqlite") useDatabase(openSqlite(":memory:"), models);
  if (driver === "postgres") await usePostgres(pgliteAsPool(new PGlite()), models, { onWarning: () => {} });
  return { keys, tick: (ms: number) => (clock += ms), now: () => clock };
}

for (const driver of ["memory", "sqlite", "postgres"] as const) {
  test(`API keys: shown once, stored hashed, verified with scopes, expiry and IP ranges (${driver})`, async () => {
    const { keys, tick, now } = await make(driver);
    const { key, secret } = await keys.create("ada", { name: " CI deploy ", scopes: ["servers.write", "servers.read", "servers.read"], expiresDays: 30, ips: ["10.0.0.0/8", " ", "2001:db8::/32"] });
    assert.match(secret, /^acme_app_[A-Za-z0-9_-]{43}$/);
    assert.equal(key.prefix, secret.slice(0, 15));
    assert.equal(key.name, "CI deploy");
    assert.deepEqual(key.scopes, ["servers.read", "servers.write"]);
    assert.deepEqual(key.ips, ["10.0.0.0/8", "2001:db8::/32"]);
    assert.equal(key.expires, now() + 30 * 86_400_000);
    const stored = (await keys.all())[0]!;
    assert.ok(!JSON.stringify(stored).includes(secret.slice(9)), "the secret itself is never listed");

    assert.deepEqual(await keys.verify(secret, "10.1.2.3"), { id: key.id, owner: "ada", tenant: null, scopes: ["servers.read", "servers.write"] });
    assert.equal(await keys.verify(secret, "192.168.1.1"), null, "outside the allowed ranges");
    assert.equal(await keys.verify(secret, null), null, "no address, no match when ranges are set");
    assert.ok(await keys.verify(secret, "2001:db8::1"));
    assert.equal(await keys.verify(secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A"), "10.1.2.3"), null);
    assert.equal(await keys.verify("other_" + secret.slice(9), "10.1.2.3"), null);
    const used = (await keys.list("ada"))[0]!;
    assert.equal(used.lastIp, "2001:db8::1");
    assert.equal(used.lastUsed, now());

    tick(30 * 86_400_000);
    assert.equal(await keys.verify(secret, "10.1.2.3"), null, "expired");
  });

  test(`API keys: owners list and revoke only their own; limits and checks (${driver})`, async () => {
    const { keys } = await make(driver, { max: 2 });
    const a = await keys.create("ada", { name: "one", scopes: ["users.read"], tenant: "acme" });
    await keys.create("ada", { name: "two", scopes: ["users.read"] });
    await rejects(keys.create("ada", { name: "three", scopes: ["users.read"] }), "limit");
    const b = await keys.create("bob", { name: "bob", scopes: ["users.read"] });
    assert.deepEqual((await keys.list("ada")).map((k) => k.name).sort(), ["one", "two"]);
    assert.deepEqual((await keys.all({ tenant: "acme" })).map((k) => k.name), ["one"]);
    assert.equal(await keys.revoke("bob", a.key.id), false, "not bob's key");
    assert.ok(await keys.verify(a.secret));
    assert.equal(await keys.revoke("ada", a.key.id), true);
    assert.equal(await keys.verify(a.secret), null);
    assert.equal(await keys.revoke(null, b.key.id), true, "an admin revokes any key");
    assert.equal(await keys.revokeOwner("ada"), 1);
    assert.deepEqual(await keys.all(), []);

    await rejects(keys.create("ada", { name: "", scopes: ["users.read"] }), "invalid", /name/);
    await rejects(keys.create("ada", { name: "x", scopes: [] }), "invalid", /at least one scope/);
    await rejects(keys.create("ada", { name: "x", scopes: ["admin" as never] }), "invalid", /no scope/);
    await rejects(keys.create("ada", { name: "x", scopes: ["users.read"], ips: ["10.0.0.0/33"] }), "invalid", /CIDR/);
    await rejects(keys.create("ada", { name: "x", scopes: ["users.read"], expiresDays: 0 }), "invalid", /expiry/);
  });

  test(`API keys: keys from another system are imported and keep working (${driver})`, async () => {
    const { keys } = await make(driver);
    const old = "ptla_" + "x".repeat(43);
    const info = await keys.importKey("ada", old, { name: "Pterodactyl key", scopes: ["servers.read"] });
    assert.equal(info.prefix, "ptla_xxxxxx");
    assert.equal((await keys.verify(old))?.id, info.id);
    await rejects(keys.importKey("ada", old, { name: "again", scopes: ["servers.read"] }), "conflict");
    await rejects(keys.importKey("ada", "nope_" + "x".repeat(43), { name: "x", scopes: ["servers.read"] }), "invalid", /starts with/);
    await rejects(keys.importKey("ada", "ptla_short", { name: "x", scopes: ["servers.read"] }), "invalid", /24-200/);
  });
}

test("API key configuration, bearer tokens and address ranges", () => {
  assert.throws(() => defineApiKeys({ prefix: "Acme", scopes: ["a"] }), /prefix/);
  assert.throws(() => defineApiKeys({ prefix: "acme_", scopes: [] }), /at least one scope/);
  assert.throws(() => defineApiKeys({ prefix: "acme_", scopes: ["a", "a"] }), /distinct/);
  assert.throws(() => defineApiKeys({ prefix: "acme_", scopes: ["Not Valid"] }), /scope/);
  assert.throws(() => defineApiKeys({ prefix: "acme_", scopes: ["a"], max: 0 }), /max/);
  const keys = defineApiKeys({ prefix: "acme_", scopes: ["a"], model: "AcmeKey" });
  assert.equal(keys.models.ApiKey.name, "AcmeKey");
  assert.equal(keys.bearer(new Request("http://x", { headers: { authorization: "Bearer acme_abc" } })), "acme_abc");
  assert.equal(keys.bearer(new Request("http://x", { headers: { authorization: "Basic abc" } })), null);
  assert.equal(keys.bearer(new Request("http://x")), null);
  assert.deepEqual(parseCidr("10.0.0.0/8"), { address: "10.0.0.0", prefix: 8, type: "ipv4" });
  assert.equal(parseCidr("10.0.0.0/8/1"), null);
  assert.equal(parseCidr("10.0.0.0/x"), null);
  assert.equal(parseCidr("host.example"), null);
  assert.equal(ipAllowed("1.2.3.4", []), true);
  assert.equal(ipAllowed("1.2.3.4", ["1.2.3.4"]), true);
  assert.equal(ipAllowed("1.2.3.5", ["1.2.3.4"]), false);
});
