import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel } from "@weft-framework/data";
import { defineComponent } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";
import { defineAction } from "../src/action.ts";
import { login } from "../src/auth.ts";
import type { PageContext } from "../src/context.ts";
import { defineAdmin } from "../src/admin.ts";

const ORIGIN = "http://app.test";

interface Task {
  id: string;
  owner: string;
  title: string;
  status: "open" | "done";
  points: number;
  urgent: boolean;
  due: Date | null;
  secret: string;
}

const ctxOf = (id: string | null, url = `${ORIGIN}/`) => ({ user: id === null ? null : { id }, url: new URL(url) }) as unknown as PageContext;

let seq = 0;
function setup(o: { lockStatus?: boolean } = {}) {
  const Task = defineModel<Task>("Task", {
    fields: { id: "string", owner: "string", title: "string", status: '"open" | "done"', points: "number", urgent: "boolean", due: "Date | null", secret: "string" },
    attrs: { id: { default: () => `t${++seq}` }, title: { unique: true } },
    read: (a: { id?: string }, r) => a?.id === "ada" || a?.id === r.owner,
    write: (a: { id?: string }, r) => a?.id === r.owner,
  });
  const add = (id: string, owner: string, title: string, x: Partial<Task> = {}) =>
    Task.as({ id: owner }).create({ id, owner, title, status: "open", points: 1, urgent: false, due: null, secret: `s3cr3t-${id}`, ...x });
  add("a1", "ada", "Write the report", { points: 5 });
  add("a2", "ada", "Review <script>", { status: "done", urgent: true });
  add("b1", "bob", "Bob's report", { points: 3, due: new Date("2026-12-01T10:00:00Z") });
  for (let i = 0; i < 30; i++) add(`n${String(i).padStart(2, "0")}`, "bob", `Filler ${i}`, { points: i });
  if (o.lockStatus) Task.lock("status", "open", "the Task workflow");
  const admin = defineAdmin({
    allow: (ctx) => (ctx.user as { id?: string } | null)?.id === "ada",
    models: [
      {
        model: Task,
        label: "Tasks",
        list: ["id", "title", "status", "points", "urgent", "due"],
        search: ["title"],
        filters: ["status", "urgent", "points"],
        pageSize: 10,
        fields: { secret: { hidden: true }, id: { label: "Code" }, title: { help: "What needs doing" } },
      },
    ],
  });
  return { Task, admin };
}

test("only `allow`ed users get anything", async () => {
  const { admin, Task } = setup();
  for (const who of [ctxOf(null), ctxOf("bob")]) {
    assert.equal(await admin.overview(who), null);
    assert.equal(await admin.list(who, "Task"), null);
    assert.equal(await admin.row(who, "Task", "b1"), null);
    assert.deepEqual(await admin.update(who, "Task", "b1", { title: "pwned" }), { ok: false, reason: "not found", error: "Not found" });
    assert.equal((await admin.delete(who, "Task", "b1")).ok, false);
    assert.equal((await admin.create(who, "Task", { title: "x" })).ok, false);
  }
  assert.equal(Task.as({ id: "bob" }).get("b1")!.title, "Bob's report");
  const ada = ctxOf("ada");
  assert.equal(await admin.list(ada, "Nope"), null);
  assert.equal(await admin.row(ada, "Task", "zzz"), null);
  assert.equal(await admin.row(ada, "Task", { id: "a1" }), null, "a key is text or a number");
  const throwing = defineAdmin({ allow: () => { throw new Error("x"); }, models: [Task] });
  assert.equal(await throwing.overview(ada), null);
});

test("overview, model info, lists: search, filters, sort, paging, hidden fields", async () => {
  const { admin } = setup();
  const ada = ctxOf("ada");
  assert.deepEqual(await admin.overview(ada), [{ name: "Task", label: "Tasks", count: 33 }]);
  const m = admin.model("Task")!;
  assert.equal(admin.model("Nope"), null);
  assert.deepEqual(m.fields.map((f) => f.name), ["id", "owner", "title", "status", "points", "urgent", "due"], "hidden fields left out");
  const byName = Object.fromEntries(m.fields.map((f) => [f.name, f]));
  assert.deepEqual([byName.id!.label, byName.id!.isKey, byName.id!.onCreate, byName.id!.onEdit], ["Code", true, false, false]);
  assert.deepEqual([byName.status!.options, byName.status!.filter], [["open", "done"], { options: ["open", "done"] }]);
  assert.deepEqual([byName.title!.help, byName.title!.searchable, byName.points!.required, byName.due!.nullable], ["What needs doing", true, true, true]);
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.fields[0]));

  let v = (await admin.list(ada, "Task"))!;
  assert.deepEqual([v.total, v.pages, v.rows.length], [33, 4, 10]);
  assert.ok(v.rows.every((r) => !("secret" in r)), "hidden fields never given");
  const at = (q: string) => admin.list(ada, "Task", new URL(`${ORIGIN}/x?${q}`)).then((x) => x!);
  assert.equal((await at("q=report")).total, 2);
  assert.equal((await at("f.status=done")).total, 1);
  assert.equal((await at("f.urgent=true")).total, 1);
  assert.equal((await at("f.points.min=28")).total, 2);
  v = await at("sort=points&dir=desc");
  assert.equal(v.rows[0]!.title, "Filler 29");
  assert.equal((await at("page=4")).page, 4);
  assert.equal((await at("q=s3cr3t")).total, 0, "a hidden field is not searchable");
  assert.equal((await at("sort=secret&f.secret=s3cr3t-a1")).total, 33, "nor filterable");
  v = (await admin.list(ctxOf("ada", `${ORIGIN}/admin?q=Filler`), "Task"))!;
  assert.equal(v.total, 30, "the request's URL by default");
});

test("rows: values, form text and whether the admin may write them", async () => {
  const { admin } = setup();
  const ada = ctxOf("ada");
  const a1 = (await admin.row(ada, "Task", "a1"))!;
  assert.equal(a1.title, "Write the report");
  assert.equal(a1.writable, true);
  assert.ok(!("secret" in a1.row) && !("secret" in a1.text));
  assert.equal(a1.text.points, "5");
  const b1 = (await admin.row(ada, "Task", "b1"))!;
  assert.equal(b1.writable, false);
  assert.equal(b1.text.due, "2026-12-01T10:00:00.000Z");
  assert.deepEqual(await admin.update(ada, "Task", "b1", { title: "Taken over" }), { ok: false, reason: "forbidden", error: "You may not make this change" });
  assert.deepEqual(await admin.delete(ada, "Task", "b1"), { ok: false, reason: "forbidden", error: "You may not delete this row" });
});

test("saving: typed input, protected fields, only changed fields, unique values", async () => {
  const { admin, Task } = setup();
  const ada = ctxOf("ada");
  const bad = async (input: object, field: string, msg: RegExp) => {
    const r = await admin.update(ada, "Task", "a1", input);
    assert.equal(r.ok, false);
    assert.equal((r as { field?: string }).field, field);
    assert.match((r as { error: string }).error, msg);
  };
  await bad({ status: "deleted" }, "status", /Status: is one of open, done/);
  await bad({ points: "lots" }, "points", /Points: is a number/);
  await bad({ points: "" }, "points", /Points: is required/);
  await bad({ points: { n: 1 } }, "points", /not a value/);
  await bad({ urgent: "maybe" }, "urgent", /Urgent: is yes or no/);
  await bad({ due: "next week" }, "due", /Due: is a date/);
  await bad({ due: "2026-02-30T10:00Z" }, "due", /Due: is not a date/);
  await bad({ due: 5 }, "due", /Due: is a date/);
  assert.equal(Task.as({ id: "ada" }).get("a1")!.title, "Write the report", "nothing written");

  let r = await admin.update(ada, "Task", "a1", {
    title: "Write the final report",
    status: "done",
    points: 8,
    urgent: "true",
    due: "2026-11-20T09:30",
    id: "hijack",
    secret: "changed",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  let row = Task.as({ id: "ada" }).get("a1")!;
  assert.deepEqual([row.title, row.status, row.points, row.urgent, row.due!.toISOString(), row.secret], [
    "Write the final report", "done", 8, true, "2026-11-20T09:30:00.000Z", "s3cr3t-a1",
  ]);
  assert.equal(Task.as({ id: "ada" }).get("hijack"), undefined);
  assert.ok(!("secret" in (r as { row: object }).row));
  await admin.update(ada, "Task", "a1", { due: "" });
  assert.equal(Task.as({ id: "ada" }).get("a1")!.due, null, "cleared");
  await admin.update(ada, "Task", "a1", { due: new Date("2026-11-21T00:00:00Z") });
  assert.equal(Task.as({ id: "ada" }).get("a1")!.due!.toISOString(), "2026-11-21T00:00:00.000Z", "a typed value works too");

  const shown = (await admin.row(ada, "Task", "a1"))!.text;
  Task.as({ id: "ada" }).update((t) => t.id === "a1", { points: 13 });
  await admin.update(ada, "Task", "a1", { title: "Renamed", points: shown.points! }, shown);
  row = Task.as({ id: "ada" }).get("a1")!;
  assert.deepEqual([row.title, row.points], ["Renamed", 13]);

  r = await admin.update(ada, "Task", "a1", { owner: "bob" });
  assert.equal((r as { reason: string }).reason, "forbidden", "the write rule refuses moving it away");
  r = await admin.update(ada, "Task", "a1", { title: "Filler 3" });
  assert.deepEqual(r, { ok: false, reason: "conflict", error: "Title is already used by another row" });
});

test("a locked field (a workflow's state) is never written", async () => {
  const { admin, Task } = setup({ lockStatus: true });
  const ada = ctxOf("ada");
  const f = admin.model("Task")!.fields.find((x) => x.name === "status")!;
  assert.deepEqual([f.readonly, f.onCreate, f.onEdit], [true, false, false]);
  const r = await admin.update(ada, "Task", "a1", { status: "done", title: "Still saved" });
  assert.equal(r.ok, true);
  assert.deepEqual([Task.as({ id: "ada" }).get("a1")!.status, Task.as({ id: "ada" }).get("a1")!.title], ["open", "Still saved"]);
});

test("creating and deleting", async () => {
  const { admin, Task } = setup();
  const ada = ctxOf("ada");
  let r = await admin.create(ada, "Task", { title: "New one", owner: "ada", status: "open", urgent: "false" });
  assert.deepEqual(r, { ok: false, reason: "invalid", field: "points", error: "Points is required" });
  r = await admin.create(ada, "Task", { title: "New one", owner: "bob", status: "open", points: "2", urgent: "false" });
  assert.equal((r as { reason: string }).reason, "forbidden", "the write rule decides: not for Bob");
  r = await admin.create(ada, "Task", { title: "New one", owner: "ada", status: "open", points: "2", urgent: false, secret: "set" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const id = (r as { key: string }).key;
  assert.equal(Task.as({ id: "ada" }).get(id)!.secret, "", "hidden fields are not set");
  r = await admin.create(ada, "Task", { title: "New one", owner: "ada", status: "open", points: "2", urgent: false });
  assert.equal((r as { reason: string }).reason, "conflict");
  assert.equal((await admin.delete(ada, "Task", id)).ok, true);
  assert.equal(Task.as({ id: "ada" }).get(id), undefined);
  assert.equal(await admin.row(ada, "Task", id), null);

  const off = defineAdmin({ allow: () => true, models: [{ model: Task, create: false, edit: false, delete: false }] });
  assert.equal((await off.create(ada, "Task", {}) as { reason: string }).reason, "disabled");
  assert.equal((await off.update(ada, "Task", "a1", {}) as { reason: string }).reason, "disabled");
  assert.equal((await off.delete(ada, "Task", "a1") as { reason: string }).reason, "disabled");
});

test("the actions, through an app", async () => {
  const { admin, Task } = setup();
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: { "/": { component: defineComponent("Home", () => ({ render: () => `<p>home</p>` })) as never } },
    actions: { signIn: defineAction("signIn", [{ name: "id", type: "string" }], async (ctx, u: string) => void (await login(ctx, u))) as never, ...admin.actions },
    auth: { user: (u) => ({ id: u }) },
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const call = async (cookie: string, name: string, body: object) => {
    const html = await (await app.fetch(new Request(`${ORIGIN}/`, { headers: { cookie } })))!.text();
    const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";
    const res = (await app.fetch(
      new Request(`${ORIGIN}/?/${name}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-weft-csrf": csrf }, body: JSON.stringify(body) }),
    ))!;
    return { res, value: ((await res.json()) as { value?: { ok: boolean; reason?: string; key?: string } }).value };
  };
  const anon = cookieOf((await app.fetch(new Request(`${ORIGIN}/`)))!);
  const ada = cookieOf((await call(anon, "signIn", { id: "ada" })).res);
  assert.equal((await call(anon, "adminUpdate", { model: "Task", key: "a1", title: "x" })).value!.reason, "not found");
  let r = await call(ada, "adminUpdate", { model: "Task", key: "a1", title: "Via action", shown: JSON.stringify({ title: "Write the report" }) });
  assert.equal(r.value!.ok, true);
  assert.equal(Task.as({ id: "ada" }).get("a1")!.title, "Via action");
  r = await call(ada, "adminCreate", { model: "Task", title: "Made", owner: "ada", status: "open", points: "1", urgent: "false" });
  assert.equal(r.value!.ok, true);
  assert.equal((await call(ada, "adminDelete", { model: "Task", key: r.value!.key })).value!.ok, true);
});

test("admin declarations are checked at startup", () => {
  const M = defineModel<{ id: string; n: number; j: unknown }>("M", { fields: { id: "string", n: "number", j: "unknown" } });
  const allow = () => true;
  assert.throws(() => defineAdmin({ models: [M] } as never), /allow/);
  assert.throws(() => defineAdmin({ allow, models: [] }), /at least one model/);
  assert.throws(() => defineAdmin({ allow, models: [M, M] }), /twice/);
  assert.throws(() => defineAdmin({ allow, models: [{} as never] }), /defineModel/);
  assert.throws(() => defineAdmin({ allow, name: "Admin-x", models: [M] }), /name/);
  assert.throws(() => defineAdmin({ allow, models: [{ model: M, fields: { nope: {} } as never }] }), /no field `nope`/);
  assert.throws(() => defineAdmin({ allow, models: [{ model: M, list: ["nope" as never] }] }), /list/);
  assert.throws(() => defineAdmin({ allow, models: [{ model: M, search: ["n"] }] }), /search/);
  assert.throws(() => defineAdmin({ allow, models: [{ model: M, list: ["id"], filters: ["n"] }] }), /not listed/);
  assert.throws(() => defineAdmin({ allow, models: [{ model: M, list: ["id", "j"], filters: ["j"] }] }), /cannot be filtered/);
  assert.throws(() => defineAdmin({ allow, models: [{ model: M, fields: { id: { hidden: true } } }] }), /key cannot be hidden/);
  assert.throws(() => defineAdmin({ allow, models: [{ model: M, fields: { n: { widget: "slider" as never } } }] }), /widget/);
  assert.throws(() => defineAdmin({ allow, models: [{ model: M, fields: { n: { readonly: true } } }] }), /no default; give it one, or create: false/);
  assert.ok(defineAdmin({ allow, models: [{ model: M, fields: { n: { readonly: true } }, create: false }] }));
  assert.deepEqual(Object.keys(defineAdmin({ allow, name: "bo", models: [M] }).actions), ["boCreate", "boUpdate", "boDelete"]);
});
