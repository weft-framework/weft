import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel, type PolicyExpr } from "@weft-framework/data";
import { constant, explainModel, words } from "../src/explain.ts";

let n = 0;
const fields = { id: "string", owner: "string", public: "boolean" };
const OWN: PolicyExpr = { cmp: "==", l: { field: ["owner"] }, r: { actor: ["id"] } };

test("public and dead rules are flagged, ordinary rules are not", () => {
  const open = defineModel(`Ex${++n}`, { fields, read: () => true, write: (a: any, r: any) => r.owner === a?.id, writeWhere: OWN });
  const text = explainModel(open as never);
  assert.match(text, /warning: the read rule passes with no actor, on a row with every field empty \(every row may be public\)/);
  assert.doesNotMatch(text, /write rule/, "an owner check is not flagged");

  const anyoneWrites = defineModel(`Ex${++n}`, { fields, read: (a: any, r: any) => r.public === true, write: () => true });
  assert.match(explainModel(anyoneWrites as never), /the write rule passes .*\(anyone may write\)/);
  assert.doesNotMatch(explainModel(anyoneWrites as never), /read rule/, "a row-dependent rule says no on an empty row");

  const dead = defineModel(`Ex${++n}`, {
    fields,
    read: () => false,
    readWhere: { and: [OWN, { truthy: { value: false } }] },
  });
  assert.match(explainModel(dead as never), /warning: the read rule can never pass \(dead rule\)/);

  const throws = defineModel(`Ex${++n}`, { fields, read: (a: any) => a.id.length > 0, write: (a: any) => a !== null && a.id !== undefined });
  assert.doesNotMatch(explainModel(throws as never), /warning/);

  const widened = defineModel(`Ex${++n}`, { fields, read: (a: any, r: any) => r.owner === a?.id, readWhere: { truthy: { value: true } } });
  assert.doesNotMatch(explainModel(widened as never), /warning/);
});

test("rules in plain words, or as code when they have no SQL form", () => {
  const m = defineModel(`Ex${++n}`, {
    fields,
    read: (a: any, r: any) => r.public || r.owner === a.id,
    readWhere: { or: [{ truthy: { field: ["public"] } }, OWN] },
    write: (a: any, r: any) => r.owner === a?.id && Date.now() > 0,
  });
  const text = explainModel(m as never);
  assert.match(text, /\n {4}in words: the row's public is set, or the row's owner is the actor's id\n/);
  assert.match(text, /\n {4}as code: \(a\s*, r\s*\) => r\.owner === a\?\.id && Date\.now\(\) > 0/);
  assert.equal(
    words({ and: [{ not: { cmp: "<", l: { field: ["n"] }, r: { value: 3 } } }, { or: [OWN, { cmp: "!=", l: { actor: [] }, r: { value: null } }] }] }),
    "not the row's n is less than 3, and (the row's owner is the actor's id, or the actor is not empty)",
  );
  assert.equal(words({ truthy: { value: false } }), "never");
});

test("constant folding of policy expressions", () => {
  const v = (x: string | number | boolean | null) => ({ value: x });
  assert.equal(constant({ truthy: v(true) }), true);
  assert.equal(constant({ truthy: v(0) }), false);
  assert.equal(constant({ not: { truthy: v(1) } }), false);
  assert.equal(constant({ or: [OWN, { truthy: v(1) }] }), true);
  assert.equal(constant({ or: [OWN, { truthy: v(0) }] }), null);
  assert.equal(constant({ or: [{ truthy: v(0) }, { truthy: v(null) }] }), false);
  assert.equal(constant({ and: [OWN, { truthy: v(0) }] }), false);
  assert.equal(constant({ and: [{ truthy: v(1) }, { truthy: v("x") }] }), true);
  assert.equal(constant({ and: [OWN, { truthy: v(1) }] }), null);
  assert.equal(constant({ cmp: "==", l: v(1), r: v(1) }), true);
  assert.equal(constant({ cmp: "!=", l: v("a"), r: v("a") }), false);
  assert.equal(constant({ cmp: "<", l: v(1), r: v(2) }), true);
  assert.equal(constant({ cmp: ">=", l: v(1), r: v(2) }), false);
  assert.equal(constant({ cmp: "<", l: v(null), r: v(2) }), false);
  assert.equal(constant(OWN), null);
  assert.equal(constant({ truthy: { actor: ["id"] } }), null);
});
