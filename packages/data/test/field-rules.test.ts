import { test } from "node:test";
import assert from "node:assert/strict";
import { defineAggregate, defineHistory, defineModel, defineSearch, useDatabase, type Model, type PolicyExpr } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Person {
  id: string;
  team: string;
  name: string;
  email: string | null;
  salary: number | null;
}

const ANY: PolicyExpr = { truthy: { value: true } };

function people(driver: "memory" | "sqlite"): Model<Person> {
  const P = defineModel<Person>(driver === "memory" ? "FieldPersonMem" : "FieldPersonSql", {
    fields: { id: "string", team: "string", name: "string", email: "string | null", salary: "number | null" },
    attrs: {
      email: { read: (a, r) => a?.id === r.id || a?.role === "admin" },
      salary: { read: (a, r) => a?.id === r.id },
    },
    read: () => true,
    write: (a, r) => a?.id === r.id || a?.role === "admin",
    readWhere: ANY,
  });
  if (driver === "sqlite") useDatabase(openSqlite(":memory:"), [P] as Model<never>[]);
  for (const [id, email, salary] of [
    ["ada", "ada@example.test", 300],
    ["bob", "bob@example.test", 100],
    ["cy", "cy@example.test", 200],
  ] as const) {
    P.driver.insert({ id, team: "t", name: id.toUpperCase(), email, salary });
  }
  return P;
}

for (const driver of ["memory", "sqlite"] as const) {
  test(`field rules (${driver}): hidden fields read as null and cannot be probed`, () => {
    const P = people(driver);
    const bob = { id: "bob" };
    const admin = { id: "root", role: "admin" };

    const seen = P.as(bob).all().sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(
      seen.map((p) => [p.id, p.email, p.salary]),
      [
        ["ada", null, null],
        ["bob", "bob@example.test", 100],
        ["cy", null, null],
      ],
    );
    assert.equal(P.as(bob).get("ada")!.email, null);
    assert.equal(P.as(bob).get("ada")!.name, "ADA", "other fields are untouched");
    assert.equal(P.as(admin).get("ada")!.email, "ada@example.test");
    assert.equal(P.as(admin).get("ada")!.salary, null, "each field has its own rule");

    assert.equal(P.as(bob).query().where({ email: "ada@example.test" }).count(), 0);
    assert.equal(P.as(bob).query().where({ salary: { gt: 150 } }).count(), 0);
    assert.equal(P.as(bob).find((p) => p.email === "ada@example.test"), undefined);
    assert.equal(P.as(bob).query().filter((p) => p.salary === 300).count(), 0);
    const bySalary = P.as(bob).query().orderBy("salary", "desc").all().map((p) => p.id);
    assert.equal(bySalary.filter((id) => id !== "bob").sort().join(), "ada,cy", "hidden values sort as null");
    assert.deepEqual(P.as(admin).query().where({ email: "ada@example.test" }).all().map((p) => p.id), ["ada"]);
    assert.equal(P.as(admin).update((p) => p.salary === 300, { name: "x" }), 0);
    assert.equal(P.as(admin).query().where({ salary: 300 }).update({ name: "x" }), 0);

    assert.equal(P.as(admin).update((p) => p.id === "ada", { name: "Ada L." }), 1);
    assert.equal(P.as({ id: "ada" }).get("ada")!.salary, 300);
    assert.equal(P.as({ id: "ada" }).get("ada")!.name, "Ada L.");

    const made = P.as(admin).create({ id: "dee", team: "t", name: "DEE", email: "dee@example.test", salary: 50 })!;
    assert.deepEqual([made.email, made.salary], ["dee@example.test", null]);

    const teamName = driver === "memory" ? "FieldTeamMem" : "FieldTeamSql";
    const Team = defineModel<{ id: string }>(teamName, { fields: { id: "string" }, read: () => true });
    Team.driver.insert({ id: "t" });
    const team = Team.as(bob).query().withMany("members", P, "team").first()!;
    assert.equal(team.members.find((m) => m.id === "ada")!.email, null);
  });
}

test("field rules: search, aggregates and history do not reveal hidden fields", () => {
  const P = people("memory");
  assert.throws(() => defineSearch(P, { fields: { email: 1 } }), /own read rule/);
  assert.throws(() => defineAggregate(P, { by: (p) => p.team, of: () => "t", sum: ["salary"] }), /own read rule/);
  const h = defineHistory(P);
  P.as({ id: "bob" }).update((p) => p.id === "bob", { name: "Bobby" });
  const v = h.versions(P.as({ id: "ada" }), "bob")!;
  assert.equal(v.length, 1);
  assert.ok(!("salary" in (v[0]!.row as object)) && !("email" in (v[0]!.row as object)), "left out of history");
});

test("field rules: not on the key, tenant or trash field", () => {
  const read = () => true;
  assert.throws(() => defineModel("FieldBad", { fields: { id: "string" }, attrs: { id: { read } } }), /cannot have its own read rule/);
  assert.throws(
    () => defineModel("FieldBad2", { fields: { id: "string", t: "string" }, attrs: { t: { tenant: true, read } } }),
    /cannot have its own read rule/,
  );
});
