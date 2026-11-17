import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";
import { createLogger, redact, requestIdOf, type LogLevel } from "../src/log.ts";
import { Secret } from "../src/secret.ts";

function capture(level: LogLevel = "debug") {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const log = createLogger({
    level,
    now: () => Date.UTC(2026, 10, 14, 12),
    write: (line) => {
      raw.push(line);
      lines.push(JSON.parse(line));
    },
  });
  return { log, lines, raw };
}

test("lines: time, level and msg first; levels; child fields", () => {
  const { log, lines, raw } = capture("info");
  log.debug("hidden");
  log.info("sent", { tenant: "acme", n: 2 });
  log.child({ job: "invoice" }).child({ attempt: 1 }).warn("retrying", { attempt: 2 });
  log.error("boom", { time: "not mine", msg: "nor this", level: "debug" });
  assert.equal(lines.length, 3);
  assert.equal(raw[0], '{"time":"2026-11-14T12:00:00.000Z","level":"info","msg":"sent","tenant":"acme","n":2}');
  assert.deepEqual(lines[1], { time: "2026-11-14T12:00:00.000Z", level: "warn", msg: "retrying", job: "invoice", attempt: 2 });
  assert.deepEqual([lines[2]!.level, lines[2]!.msg, lines[2]!.time], ["error", "boom", "2026-11-14T12:00:00.000Z"]);
  assert.deepEqual(lines[2]!.fields, { time: "not mine", msg: "nor this", level: "debug" });
  assert.throws(() => createLogger({ level: "loud" as never }), /level/);
});

test("secrets by type, credentials by name, nothing that throws", () => {
  const key = new Secret("STRIPE_KEY", "sk_live_abc");
  const cyclic: Record<string, unknown> = { name: "a" };
  cyclic.self = cyclic;
  const err = Object.assign(new Error("failed", { cause: new Error("inner") }), { code: "E_X" });
  const out = redact({
    key,
    nested: { list: [key, 1, undefined, () => 1], deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } },
    password: "hunter2",
    Authorization: "Bearer x",
    apiKey: "k",
    sessionToken: "t",
    cookie: "weft_sid=1",
    user: { id: "ada", email: "ada@example.com" },
    when: new Date(Date.UTC(2026, 0, 1)),
    bytes: new Uint8Array(3),
    big: 10n,
    nan: Number.NaN,
    long: "x".repeat(5000),
    cyclic,
    err,
    map: new Map([["k", key]]),
    getter: Object.defineProperty({}, "boom", { enumerable: true, get: () => { throw new Error("no"); } }),
  }) as Record<string, any>;
  assert.equal(out.key, "[secret]");
  assert.deepEqual(out.nested.list, ["[secret]", 1, null, null]);
  assert.equal(out.nested.deep.a.b.c.d, "[object]", "depth is bounded");
  for (const k of ["password", "Authorization", "apiKey", "sessionToken", "cookie"]) assert.equal(out[k], "[redacted]", k);
  assert.deepEqual(out.user, { id: "ada", email: "ada@example.com" });
  assert.deepEqual([out.when, out.bytes, out.big, out.nan], ["2026-01-01T00:00:00.000Z", "[3 bytes]", "10", "NaN"]);
  assert.equal(out.long.length, 4096 + "...[904 more]".length);
  assert.deepEqual(out.cyclic, { name: "a", self: "[circular]" });
  assert.deepEqual([out.err.name, out.err.message, out.err.code, out.err.cause.message], ["Error", "failed", "E_X", "inner"]);
  assert.match(out.err.stack, /failed/);
  assert.deepEqual(out.map, { k: "[secret]" });
  assert.deepEqual(out.getter, { boom: "[unreadable]" });
  assert.doesNotMatch(JSON.stringify(out), /sk_live|hunter2|Bearer/);

  const custom = redact({ ssn: "1", password: "p" }, /ssn/);
  assert.deepEqual(custom, { ssn: "[redacted]", password: "p" });

  const log = createLogger({ write: () => { throw new Error("disk full"); } });
  log.info("x", { key });
});

test("the app writes a line per request with its id; errors carry it", async () => {
  const { log, lines } = capture();
  const Boom = defineComponent("Boom", () => ({ render: () => { throw new Error("render failed"); } })) as never;
  let seen: string | null = null;
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: { "/": { component: defineComponent("H", () => ({ render: () => "<p>h</p>" })) as never }, "/boom": { component: Boom } },
    api: { "/api/id": { GET: (ctx) => ((seen = requestIdOf(ctx.request)), new Response("ok")) } },
    logger: log,
  });
  const res = (await app.fetch(new Request("http://app.test/api/id?token=abc123", { headers: { "x-request-id": "client-chosen-id" } })))!;
  const id = res.headers.get("x-request-id")!;
  assert.match(id, /^[0-9a-f]{24}$/, "random: the incoming id is not trusted by default");
  assert.equal(seen, id, "handlers can read it");
  const line = lines.find((l) => l.msg === "request")!;
  assert.deepEqual({ ...line, ms: 0 }, { time: line.time, level: "info", msg: "request", requestId: id, method: "GET", path: "/api/id", status: 200, ms: 0 });
  assert.doesNotMatch(JSON.stringify(lines), /abc123/, "no query string");

  lines.length = 0;
  const boom = (await app.fetch(new Request("http://app.test/boom")))!;
  assert.equal(boom.status, 500);
  const error = lines.find((l) => l.level === "error")!;
  assert.equal(error.msg, "unhandled error");
  assert.match(JSON.stringify(error), /render failed/);
  assert.equal(lines.find((l) => l.msg === "request")!.status, 500);

  const trusting = createApp({ secret: "test-secret-test-secret-test-secret!", routes: {}, logger: log, trustRequestId: true });
  const t = (await trusting.fetch(new Request("http://app.test/x", { headers: { "x-request-id": "lb-1234abcd" } })))!;
  assert.equal(t.headers.get("x-request-id"), "lb-1234abcd");
  const bad = (await trusting.fetch(new Request("http://app.test/x", { headers: { "x-request-id": "bad id\" injected" } })))!;
  assert.match(bad.headers.get("x-request-id")!, /^[0-9a-f]{24}$/, "malformed ids are replaced");
  assert.equal(requestIdOf(new Request("http://app.test/")), null);
});
