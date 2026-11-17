import { test } from "node:test";
import assert from "node:assert/strict";
import { changes, defineConsent, defineModel, defineSearch, readOnlyActor } from "../src/index.ts";

const uniq = () => Math.random().toString(36).slice(2, 8);

type Visit = { id: string; owner: string; page: string; device: string | null; city: string | null };

function setup() {
  const n = uniq();
  const consent = defineConsent({ purposes: [`analytics${n}`, `location${n}`], name: `Consent${n}`, now: () => 1000 });
  const Visit = defineModel<Visit>(`Visit${n}`, {
    fields: { id: "string", owner: "string", page: "string", device: "string | null", city: "string | null" },
    attrs: {
      device: { consent: `analytics${n}` },
      city: { consent: { purpose: `location${n}`, subject: "owner" }, read: (a: { staff?: boolean }) => a?.staff === true },
    },
    read: () => true,
    write: (a: { id: string }, r) => r.owner === a.id,
  });
  Visit.driver.insert({ id: "v1", owner: "ada", page: "/", device: "phone", city: "Prague" });
  Visit.driver.insert({ id: "v2", owner: "bob", page: "/x", device: "laptop", city: "Brno" });
  return { consent, Visit, a: `analytics${n}`, l: `location${n}` };
}

test("consent: a field shows only once its person agreed", () => {
  const { consent, Visit, a, l } = setup();
  const ada = { id: "ada" };
  const staff = { id: "sam", staff: true };
  assert.deepEqual(Visit.as(ada).all().map((v) => v.device), [null, null], "nobody agreed yet");
  assert.deepEqual(consent.of(ada), { [a]: false, [l]: false });

  consent.agree(ada, a);
  assert.equal(consent.has("ada", a), true);
  assert.deepEqual(Visit.as(ada).all().map((v) => v.device), ["phone", "laptop"], "the reader's own consent");
  assert.deepEqual(Visit.as({ id: "bob" }).all().map((v) => v.device), [null, null]);

  assert.deepEqual(Visit.as(staff).all().map((v) => v.city), [null, null]);
  consent.agree({ id: "bob" }, l);
  assert.deepEqual(Visit.as(staff).all().map((v) => v.city), [null, "Brno"], "the owner's consent, plus the field's rule");
  assert.deepEqual(Visit.as(ada).all().map((v) => v.city), [null, null], "the field's own rule still applies");
  assert.deepEqual(Visit.as(staff).query().where({ city: "Prague" }).all(), [], "a filter cannot find a hidden value");

  consent.withdraw(ada, a);
  assert.deepEqual(consent.of(ada), { [a]: false, [l]: false });
  assert.deepEqual(Visit.as(ada).all().map((v) => v.device), [null, null]);
  assert.equal(consent.has("ada", "nope"), false);
});

test("consent answers are the person's own, checked writes", () => {
  const { consent, a } = setup();
  assert.throws(() => consent.agree(null, a), /signed-in/);
  assert.throws(() => consent.agree({ id: "ada" }, "other"), /not one of/);
  assert.throws(() => consent.agree(readOnlyActor({ id: "ada" }), a), /refused/);
  consent.agree({ id: "ada" }, a);
  assert.deepEqual(consent.model.as({ id: "bob" }).all(), [], "nobody else reads an answer");
  assert.equal(consent.model.as({ id: "bob" }).create({ id: `${a}:ada`, subject: "ada", purpose: a, agreed: false, at: 0 }), undefined);
  assert.equal(consent.model.as({ id: "bob" }).create({ id: `${a}:ada`, subject: "bob", purpose: a, agreed: true, at: 0 }), undefined, "the key must be the purpose and the subject");
  assert.equal(consent.has("ada", a), true);
  const row = consent.model.as({ id: "ada" }).get(`${a}:ada`)!;
  assert.deepEqual([row.agreed, row.at], [true, 1000]);
});

test("consent: withdrawal tells every reader of the models it covers", () => {
  const { consent, Visit, a } = setup();
  const seen: unknown[] = [];
  const stop = changes.subscribe((c) => {
    if (c.model === Visit.name) seen.push(c);
  });
  try {
    consent.agree({ id: "ada" }, a);
    consent.agree({ id: "ada" }, a);
    consent.withdraw({ id: "ada" }, a);
    assert.deepEqual(seen, [
      { model: Visit.name, op: "update", key: undefined, redacted: true },
      { model: Visit.name, op: "update", key: undefined, redacted: true },
    ]);
  } finally {
    stop();
  }
});

test("consent is checked when the model is defined, and fails closed", () => {
  const n = uniq();
  assert.throws(() => defineModel(`Bad${n}`, { fields: { id: "string", x: "string" }, attrs: { x: { consent: "Not A Purpose" } } }), /purpose/);
  assert.throws(() => defineModel(`Bad${n}`, { fields: { id: "string", x: "string" }, attrs: { x: { consent: { purpose: "p", subject: "who" } } } }), /not a field/);
  assert.throws(() => defineModel(`Bad${n}`, { fields: { id: "string", x: "string" }, attrs: { id: { consent: "p" } } }), /key/);
  assert.throws(() => defineConsent({ purposes: [] }), /at least one/);
  const M = defineModel<{ id: string; x: string | null }>(`Undefined${n}`, {
    fields: { id: "string", x: "string | null" },
    attrs: { x: { consent: `never-defined-${n}` } },
    read: () => true,
  });
  M.driver.insert({ id: "1", x: "secret" });
  assert.equal(M.as({ id: "ada" }).get("1")!.x, null, "a purpose nobody defined hides the field");
  assert.throws(() => defineSearch(M, { fields: { x: 1 } }), /own read rule/);
});
