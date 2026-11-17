import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel, diffRules, fuzzRules, type PolicyExpr } from "../src/index.ts";
import { openSqlite } from "../src/sqlite.ts";

interface Doc {
  id: string;
  owner: string;
  team: string;
  status: "draft" | "public";
  trashed: number | null;
}

const OWN: PolicyExpr = { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } };
const PUBLIC: PolicyExpr = { cmp: "==", l: { field: ["status"] }, r: { value: "public" } };
const fields = { id: "string", owner: "string", team: "string", status: '"draft" | "public"', trashed: "number | null" };
const database = () => openSqlite(":memory:");

test("fuzzRules: a sound model has no findings, on memory and SQL", () => {
  const Doc = defineModel<Doc>("FuzzSound", {
    fields,
    attrs: { team: { tenant: true }, trashed: { softDelete: true }, owner: { ref: "User" } },
    read: (a, r) => r.owner === a?.id || r.status === "public",
    write: (a, r) => r.owner === a?.id,
    readWhere: { or: [OWN, PUBLIC] },
    writeWhere: OWN,
  });
  const report = fuzzRules(Doc, { runs: 30, seed: 7, database });
  assert.deepEqual(report.findings, []);
  assert.ok(report.passed.read > 0 && report.passed.write > 0, "both rules were exercised");
  assert.ok(report.checks > 0);
  assert.equal(Doc.as({ id: "a", tenant: "t1" }).all().length, 0, "the model itself is left untouched");
});

test("fuzzRules: a readWhere narrower than read is reported as missing rows on SQL", () => {
  const Doc = defineModel<Doc>("FuzzNarrow", {
    fields,
    read: (a, r) => r.owner === a?.id || r.status === "public",
    write: (a, r) => r.owner === a?.id,
    readWhere: OWN,
    writeWhere: { and: [OWN, PUBLIC] },
  });
  const report = fuzzRules(Doc, { runs: 30, database });
  const kinds = report.findings.map((f) => `${f.kind}:${f.rule}:${f.store}`).sort();
  assert.deepEqual(kinds, ["missing:read:sql", "missing:write:sql"]);
  const read = report.findings.find((f) => f.rule === "read")!;
  assert.equal((read.row as Doc).status, "public", "the example is a row only the closure allows");
});

test("fuzzRules: rules that throw, and rules nobody passes", () => {
  const Doc = defineModel<Doc>("FuzzOdd", {
    fields,
    read: (a, r) => (a.roles as string[]).includes("admin") || r.owner === a?.id,
    write: (a) => (a as { id: string } | null)?.id === "nobody-has-this-id",
  });
  const report = fuzzRules(Doc, { runs: 20 });
  const kinds = report.findings.map((f) => `${f.kind}:${f.rule}`).sort();
  assert.deepEqual(kinds, ["throws:read", "unreachable:write"]);
  assert.ok(report.findings.find((f) => f.kind === "throws")!.actor !== null, "an actor without roles made it throw");
  Doc.driver.insert({ id: "d1", owner: "a", team: "t1", status: "public", trashed: null });
  assert.deepEqual(Doc.as(null).all(), [], "the data layer refuses, never fails, when a rule throws");
  assert.equal(Doc.as({ id: "a", roles: [] }).all().length, 1);

  const given = fuzzRules(Doc, { runs: 5, actors: [{ id: "nobody-has-this-id" }] });
  assert.ok(!given.findings.some((f) => f.kind === "unreachable" && f.rule === "write"));
  assert.throws(() => fuzzRules(Doc, { runs: 0 }), /whole numbers/);
});

test("diffRules: widened and narrowed access, with examples; added, removed and same models", () => {
  const make = (read: (a: any, r: Doc) => boolean, extra: Record<string, string> = {}) =>
    defineModel<Doc>("FuzzDiff", { fields: { ...fields, ...extra }, read, write: (a, r) => r.owner === a?.id });
  const before = make((a, r) => r.owner === a?.id);
  const wider = make((a, r) => r.owner === a?.id || r.status === "public");
  const narrower = make((a, r) => r.owner === a?.id && r.status === "draft", { title: "string" });

  const w = diffRules(before, wider, { runs: 20 });
  assert.equal(w.status, "changed");
  assert.deepEqual(w.changes.map((c) => `${c.rule}:${c.change}`), ["read:widened"]);
  const ex = w.changes[0]!;
  assert.equal((ex.row as Doc).status, "public");
  assert.notEqual((ex.row as Doc).owner, (ex.actor as { id?: string } | null)?.id, "the example is a pair only the new rule admits");
  assert.ok(ex.pairs > 0 && ex.pairs <= w.checks);

  const n = diffRules(before, narrower, { runs: 20 });
  assert.deepEqual(n.changes.map((c) => `${c.rule}:${c.change}`), ["read:narrowed"]);
  assert.deepEqual(n.fields, { added: ["title"], removed: [] });

  const same = diffRules(before, make((a, r) => a?.id === r.owner), { runs: 20 });
  assert.equal(same.status, "same");
  assert.deepEqual(same.changes, []);

  const added = diffRules(undefined, wider, { runs: 20 });
  assert.equal(added.status, "added");
  assert.equal(added.passed.before, null);
  assert.ok(added.passed.after!.read > 0);
  assert.equal(diffRules(before, undefined, { runs: 5 }).status, "removed");
  assert.throws(() => diffRules(undefined, undefined), /before, after/);
});
