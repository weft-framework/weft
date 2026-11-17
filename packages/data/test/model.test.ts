import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel } from "../src/index.ts";

interface Invoice {
  id: string;
  owner: string;
  amount: number;
}

function invoices() {
  const model = defineModel<Invoice>("Invoice", {
    fields: { id: "string", owner: "string", amount: "number" },
    read: (actor, row) => actor === row.owner,
    write: (actor, row) => actor === row.owner,
  });
  model.as("alice").create({ id: "a1", owner: "alice", amount: 100 });
  model.as("bob").create({ id: "b1", owner: "bob", amount: 200 });
  return model;
}

test("a scoped read returns only the actor's rows", () => {
  const model = invoices();
  const seen = model.as("alice").all();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, "a1");
});

test("looking up another actor's row by id yields nothing (IDOR)", () => {
  const model = invoices();
  const stolen = model.as("alice").find((r) => r.id === "b1");
  assert.equal(stolen, undefined);
});

test("a model with no policy denies all access (closed by default)", () => {
  const locked = defineModel<Invoice>("Locked", {
    fields: { id: "string", owner: "string", amount: "number" },
  });
  locked.as("alice").create({ id: "x", owner: "alice", amount: 1 });
  assert.equal(locked.publicUnscoped().length, 0);
  assert.equal(locked.as("alice").all().length, 0);
});

test("create is refused when the write policy denies it", () => {
  const model = invoices();
  const forged = model.as("alice").create({
    id: "a2",
    owner: "bob",
    amount: 999,
  });
  assert.equal(forged, undefined);
  assert.equal(model.publicUnscoped().length, 2);
});

test("update is scoped and cannot move a row out of authority", () => {
  const model = invoices();
  assert.equal(
    model.as("alice").update((r) => r.id === "b1", { amount: 0 }),
    0,
  );
  assert.equal(
    model.as("alice").update((r) => r.id === "a1", { amount: 150 }),
    1,
  );
  assert.equal(model.as("alice").find((r) => r.id === "a1")?.amount, 150);
  assert.equal(
    model.as("alice").update((r) => r.id === "a1", { owner: "bob" }),
    0,
  );
  assert.equal(model.as("alice").find((r) => r.id === "a1")?.owner, "alice");
});

test("delete only removes the actor's own rows", () => {
  const model = invoices();
  assert.equal(model.as("alice").delete((r) => r.id === "b1"), 0);
  assert.equal(model.as("alice").delete((r) => r.id === "a1"), 1);
  assert.equal(model.publicUnscoped().length, 1);
});

test("publicUnscoped is the only path to unscoped rows", () => {
  const model = invoices();
  assert.equal(model.publicUnscoped().length, 2);
});
