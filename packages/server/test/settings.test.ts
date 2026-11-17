import { test } from "node:test";
import assert from "node:assert/strict";
import type { PageContext } from "../src/context.ts";
import { defineSettings, type SettingsSchema } from "../src/settings.ts";

const schema = {
  "digest.enabled": { type: "boolean", default: true, label: "Weekly digest", editable: true },
  "digest.day": { type: "string", default: "monday", options: ["monday", "friday"], editable: true },
  "page.size": { type: "number", default: 20, min: 5, max: 100, integer: true, editable: true, description: "Rows per page" },
  signature: { type: "string", default: "", maxLength: 10, editable: true },
  "exports.limit": { type: "number", default: 10, label: "Export limit" },
} satisfies SettingsSchema;

class Refused extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg);
    this.code = code;
  }
}

const ctxOf = (id: string | null) => ({ user: id === null ? null : { id } }) as unknown as PageContext;

function setup() {
  const store = new Map<string, Record<string, unknown>>([["ada", { "digest.day": "friday", "exports.limit": 50, bogus: 1 }], ["bob", { "page.size": 3 }]]);
  const saved: Record<string, unknown>[] = [];
  let refuse: Refused | null = null;
  const s = defineSettings({
    schema,
    groups: [{ label: "Email", description: "What we send you", keys: ["digest.enabled", "digest.day"] }],
    load: (ctx) => {
      const id = (ctx.user as { id?: string } | null)?.id;
      return id ? store.get(id) : undefined;
    },
    save: (ctx, patch) => {
      if (refuse) throw refuse;
      const id = (ctx.user as { id: string }).id;
      saved.push(patch);
      store.set(id, { ...store.get(id), ...patch });
    },
    canEdit: (ctx, key) => !((ctx.user as { id?: string }).id === "bob" && key === "page.size"),
  });
  return { s, store, saved, refuseWith: (r: Refused | null) => void (refuse = r) };
}

test("only users `load` answers for see or save", async () => {
  const { s, saved } = setup();
  assert.equal(await s.view(ctxOf(null)), null);
  assert.deepEqual(await s.save(ctxOf(null), { signature: "x" }), { ok: false, reason: "not found", error: "Not found" });
  assert.deepEqual(saved, []);
});

test("the view: sections, values with defaults, editable per user", async () => {
  const { s } = setup();
  const v = (await s.view(ctxOf("ada")))!;
  assert.deepEqual(v.sections.map((x) => [x.label, x.description, x.settings.map((y) => y.key)]), [
    ["Email", "What we send you", ["digest.enabled", "digest.day"]],
    ["", null, ["page.size", "signature", "exports.limit"]],
  ]);
  const byKey = Object.fromEntries(v.sections.flatMap((x) => x.settings).map((y) => [y.key, y]));
  assert.deepEqual(byKey["digest.day"], {
    key: "digest.day", label: "Digest day", description: null, type: "string", value: "friday", editable: true, fixed: false,
    options: ["monday", "friday"], min: null, max: null, integer: false, maxLength: 1000,
  });
  assert.deepEqual([byKey["page.size"]!.min, byKey["page.size"]!.max, byKey["page.size"]!.integer, byKey["page.size"]!.description], [5, 100, true, "Rows per page"]);
  assert.equal(byKey["exports.limit"]!.value, 50);
  assert.equal(byKey["exports.limit"]!.editable, false);
  assert.equal(byKey["exports.limit"]!.fixed, true);
  assert.ok(!("bogus" in byKey));
  assert.deepEqual(v.shown, { "digest.enabled": true, "digest.day": "friday", "page.size": 20, signature: "" });
  const b = (await s.view(ctxOf("bob")))!;
  const pb = b.sections[1]!.settings[0]!;
  assert.deepEqual([pb.key, pb.value, pb.editable, pb.fixed], ["page.size", 20, false, false], "bob's 3 is below the minimum; canEdit refused");
  assert.ok(!("page.size" in b.shown));
});

test("saving: values checked per setting, only changed and editable ones", async () => {
  const { s, saved, store } = setup();
  const ada = ctxOf("ada");
  const bad = async (input: object, msg: RegExp) => {
    const r = await s.save(ada, input);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, msg);
  };
  await bad({ "digest.enabled": "maybe" }, /Weekly digest: is yes or no/);
  await bad({ "digest.day": "sunday" }, /Digest day: is one of monday, friday/);
  await bad({ "page.size": "4" }, /Page size: is at least 5/);
  await bad({ "page.size": 101 }, /is at most 100/);
  await bad({ "page.size": "7.5" }, /is a whole number/);
  await bad({ "page.size": "0x10" }, /is a number/);
  await bad({ "page.size": "" }, /is a number/);
  await bad({ signature: "x".repeat(11) }, /at most 10 characters/);
  assert.deepEqual(saved, []);

  let r = await s.save(ada, { "digest.enabled": "false", "page.size": 50, "exports.limit": 999, signature: "Ada", "digest.day": "friday", bogus: 2 });
  assert.deepEqual(r, { ok: true, saved: { "digest.enabled": false, "page.size": 50, signature: "Ada" } });
  assert.equal(store.get("ada")!["exports.limit"], 50);

  const shown = (await s.view(ada))!.shown;
  store.set("ada", { ...store.get("ada"), "digest.day": "monday" });
  r = await s.save(ada, { "digest.day": "friday", signature: "A." }, shown);
  assert.deepEqual(saved.at(-1), { signature: "A." });
  assert.equal(store.get("ada")!["digest.day"], "monday");

  r = await s.save(ctxOf("bob"), { "page.size": "50", signature: "Bob" });
  assert.deepEqual(saved.at(-1), { signature: "Bob" }, "canEdit refused the page size");
  const n = saved.length;
  await s.save(ctxOf("bob"), { signature: "Bob" });
  await s.save(ada, { "page.size": "50.0" });
  assert.equal(saved.length, n, "nothing changed, nothing saved");
});

test("refusals from save", async () => {
  const { s, refuseWith } = setup();
  refuseWith(new Refused("invalid", "setting `signature` is taken"));
  assert.deepEqual(await s.save(ctxOf("ada"), { signature: "x" }), { ok: false, reason: "invalid", key: null, error: "setting `signature` is taken" });
  refuseWith(new Refused("forbidden", "secret detail"));
  assert.deepEqual(await s.save(ctxOf("ada"), { signature: "x" }), { ok: false, reason: "forbidden", error: "You may not change these settings" });
  refuseWith(new Refused("other", "boom"));
  await assert.rejects(s.save(ctxOf("ada"), { signature: "x" }), /boom/);
});

test("declarations are checked", () => {
  const ok = { schema, load: () => ({}), save: () => {} };
  assert.throws(() => defineSettings({ schema } as never), /load\(ctx\)/);
  assert.throws(() => defineSettings({ ...ok, schema: {} }), /no settings/);
  assert.throws(() => defineSettings({ ...ok, schema: { "Bad Key": { type: "boolean", default: true } } }), /lower case/);
  assert.throws(() => defineSettings({ ...ok, schema: { x: { type: "date", default: 1 } as never } }), /type is/);
  assert.throws(() => defineSettings({ ...ok, schema: { x: { type: "number", default: 0, min: 1 } } }), /default is at least 1/);
  assert.throws(() => defineSettings({ ...ok, schema: { x: { type: "number", default: 3, min: 5, max: 2 } } }), /min is above max/);
  assert.throws(() => defineSettings({ ...ok, schema: { x: { type: "string", default: "a", options: [] } } }), /options/);
  assert.throws(() => defineSettings({ ...ok, groups: [{ label: "A", keys: ["nope"] }] }), /no setting `nope`/);
  assert.throws(() => defineSettings({ ...ok, groups: [{ label: "A", keys: ["signature"] }, { label: "B", keys: ["signature"] }] }), /two groups/);
  assert.throws(() => defineSettings({ ...ok, canEdit: 1 as never }), /canEdit/);
});
