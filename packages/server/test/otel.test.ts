import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { otlpExporter } from "../src/otel.ts";
import { Secret } from "../src/secret.ts";
import { defineComponent } from "@weft-framework/runtime";
import { defineModel } from "@weft-framework/data";
import { createJobs, defineJob, JobError } from "../src/jobs.ts";

const ORIGIN = "http://app.test";

type Sent = { url: string; headers: Record<string, string>; body: any };

function collector(status = 200) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(null, { status });
  };
  return { sent, fetch };
}

const spansOf = (sent: Sent[]) => sent.filter((s) => s.url.endsWith("/v1/traces")).flatMap((s) => s.body.resourceSpans[0].scopeSpans[0].spans);
const logsOf = (sent: Sent[]) => sent.filter((s) => s.url.endsWith("/v1/logs")).flatMap((s) => s.body.resourceLogs[0].scopeLogs[0].logRecords);
const attr = (item: any, key: string) => {
  const v = item.attributes.find((a: any) => a.key === key)?.value;
  return v && (v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue);
};

test("spans per request with the route pattern, errors linked to their trace", async () => {
  const c = collector();
  const otel = otlpExporter({
    endpoint: "https://otlp.example/base",
    headers: { "x-api-key": new Secret("OTLP_KEY", "k-123") },
    service: "web",
    resource: { "service.version": "1.2.0" },
    fetch: c.fetch,
    onError: (e) => assert.fail(String(e)),
  });
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: {},
    api: {
      "/api/items/[id]": { GET: () => new Response("ok") },
      "/api/fail": { GET: () => { throw new Error("api failed"); } },
    },
    onError: () => undefined,
    telemetry: otel,
  });
  const parent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  await app.fetch(new Request(`${ORIGIN}/api/items/7?token=secret`, { headers: { traceparent: parent } }));
  await app.fetch(new Request(`${ORIGIN}/api/fail`, { headers: { traceparent: "00-" + "0".repeat(32) + "-b7ad6b7169203331-01" } }));
  await app.fetch(new Request(`${ORIGIN}/nowhere`, { headers: { traceparent: "garbage" } }));
  await otel.flush();

  assert.ok(c.sent.every((s) => s.url.startsWith("https://otlp.example/base/v1/") && s.headers["x-api-key"] === "k-123"));
  const resource = c.sent[0]!.body.resourceSpans[0].resource;
  assert.equal(attr(resource, "service.name"), "web");
  assert.equal(attr(resource, "service.version"), "1.2.0");

  const [ok, failed, missing] = spansOf(c.sent);
  assert.equal(ok.name, "GET /api/items/[id]");
  assert.equal(ok.traceId, "0af7651916cd43dd8448eb211c80319c", "continues the incoming trace");
  assert.equal(ok.parentSpanId, "b7ad6b7169203331");
  assert.equal(attr(ok, "url.path"), "/api/items/7", "no query string");
  assert.equal(attr(ok, "http.response.status_code"), "200");
  assert.equal(ok.kind, 2);
  assert.deepEqual(ok.status, { code: 0 });
  assert.ok(BigInt(ok.endTimeUnixNano) >= BigInt(ok.startTimeUnixNano));
  assert.doesNotMatch(JSON.stringify(c.sent), /token=secret/);

  assert.notEqual(failed.traceId, "0".repeat(32), "an all-zero trace id starts a new trace");
  assert.equal(failed.parentSpanId, undefined);
  assert.deepEqual(failed.status, { code: 2 });
  assert.equal(missing.name, "GET", "no route matched");
  assert.match(missing.traceId, /^[0-9a-f]{32}$/);

  const [log] = logsOf(c.sent);
  assert.equal(log.severityText, "ERROR");
  assert.equal(log.body.stringValue, "api failed");
  assert.deepEqual([log.traceId, log.spanId], [failed.traceId, failed.spanId]);
  assert.equal(attr(log, "http.route"), "/api/fail");
  assert.equal(attr(log, "weft.kind"), "api");
  assert.equal(attr(log, "exception.type"), "Error");
  assert.match(attr(log, "exception.stacktrace"), /api failed/);
});

test("batches, a bounded queue and a failing collector", async () => {
  const c = collector(503);
  const errors: unknown[] = [];
  let clock = 1_000;
  const otel = otlpExporter({ endpoint: "http://localhost:4318", service: "w", maxBatch: 2, maxQueue: 3, fetch: c.fetch, onError: (e) => errors.push(e), now: () => clock++ });
  const t = otel.startRequest(new Request(ORIGIN));
  otel.endRequest(t, { method: "GET", path: "/", status: 200 });
  assert.equal(c.sent.length, 0, "waits for the batch");
  otel.endRequest(t, { method: "GET", path: "/", status: 200 });
  await otel.flush();
  assert.equal(spansOf(c.sent).length, 2, "a full batch leaves at once");
  assert.equal(errors.length, 2, "each failed export is reported, not retried");
  assert.equal(c.sent.length, 2);
  assert.match(String(errors[0]), /HTTP 503/);
  assert.equal(otel.dropped, 0);

  const slow = collector();
  const q = otlpExporter({ endpoint: "http://127.0.0.1:4318/", service: "w", maxBatch: 100, maxQueue: 3, fetch: slow.fetch });
  for (const status of [201, 202, 203, 204]) q.endRequest(t, { method: "GET", path: "/", status });
  assert.equal(q.dropped, 1);
  await q.flush();
  assert.deepEqual(spansOf(slow.sent).map((s: any) => attr(s, "http.response.status_code")), ["202", "203", "204"]);

  assert.throws(() => otlpExporter({ endpoint: "http://otlp.example", service: "w" }), /https/);
  assert.throws(() => otlpExporter({ endpoint: "not a url", service: "w" }), /URL/);
  assert.throws(() => otlpExporter({ endpoint: "https://otlp.example", service: "" }), /service/);
  assert.throws(() => otlpExporter({ endpoint: "https://otlp.example", service: "w", maxBatch: 0 }), /maxBatch/);
});

test("telemetry that throws never fails a request", async () => {
  const errors: unknown[] = [];
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: {},
    api: { "/api/x": { GET: () => new Response("fine") } },
    onError: (e) => errors.push(e),
    telemetry: {
      startRequest: () => { throw new Error("start broke"); },
      endRequest: () => { throw new Error("end broke"); },
      error: () => undefined,
    },
  });
  const res = (await app.fetch(new Request(`${ORIGIN}/api/x`)))!;
  assert.equal(await res.text(), "fine");
  assert.deepEqual(errors.map(String), ["Error: start broke"]);
});

const metricsOf = (sent: Sent[]) =>
  sent.filter((s) => s.url.endsWith("/v1/metrics")).flatMap((s) => s.body.resourceMetrics[0].scopeMetrics[0].metrics);
const ready = () => new Promise((r) => setTimeout(r, 0));

test("live events: a span under the POST that carried them, and a duration metric", async () => {
  const c = collector();
  const otel = otlpExporter({ endpoint: "https://otlp.example", service: "web", fetch: c.fetch, onError: (e) => assert.fail(String(e)) });
  const Clicky = defineComponent("Clicky", () => ({
    handlers: { ok() {}, boom() { throw new Error("handler failed"); } },
    render: () => `<button data-weft-on-click="ok">x</button>`,
  }));
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: { "/": { component: Clicky as never } },
    onError: () => undefined,
    telemetry: otel,
  });
  const res = (await app.fetch(new Request(`${ORIGIN}/`)))!;
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const html = await res.text();
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)![1];
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)![1]!;
  const sse = (await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } })))!;
  const reader = sse.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const session = String((JSON.parse(/data: (.*)\n\n/.exec(first)![1]!) as { session: string }).session);
  const send = (id: string, handler: string, seq: number) =>
    app.fetch(
      new Request(`${ORIGIN}/_weft/live/event`, {
        method: "POST",
        headers: {
          cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": session,
          traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        },
        body: JSON.stringify({ t: "event", id, handler, event: { type: "click" }, seq }),
      }),
    );
  await send("r", "ok", 1);
  await send("r", "boom", 2);
  await send("nope", "boom", 3);
  await reader.cancel();
  await otel.flush();

  const spans = spansOf(c.sent);
  const events = spans.filter((s: any) => s.name.startsWith("event "));
  assert.deepEqual(events.map((s: any) => s.name), ["event Clicky.ok", "event Clicky.boom", "event unknown.unknown"]);
  const post = spans.find((s: any) => s.name === "POST" && s.spanId === events[0].parentSpanId);
  assert.ok(post, "a child of the POST's span");
  assert.equal(events[0].traceId, "0af7651916cd43dd8448eb211c80319c");
  assert.equal(events[0].kind, 1);
  assert.equal(attr(events[0], "http.route"), "/");
  assert.deepEqual(events[0].status, { code: 0 });
  assert.deepEqual(events[1].status, { code: 2 });
  assert.equal(attr(events[1], "error.type"), "Error");
  assert.doesNotMatch(JSON.stringify(spans), /handler failed|nope/, "no messages or browser-chosen names");

  const metrics = metricsOf(c.sent);
  const ev = metrics.find((m: any) => m.name === "weft.live.event.duration");
  assert.equal(ev.unit, "s");
  assert.equal(ev.histogram.aggregationTemporality, 2);
  const points = ev.histogram.dataPoints;
  assert.equal(points.length, 3);
  const boom = points.find((p: any) => attr(p, "weft.handler") === "boom");
  assert.equal(attr(boom, "error.type"), "Error");
  assert.equal(boom.count, "1");
  assert.equal(boom.bucketCounts.length, boom.explicitBounds.length + 1);
  const http = metrics.find((m: any) => m.name === "http.server.request.duration");
  const page = http.histogram.dataPoints.find((p: any) => attr(p, "http.route") === "/");
  assert.equal(attr(page, "http.response.status_code"), "200");
  assert.doesNotMatch(JSON.stringify(metrics), /url\.path|enduser/, "no paths or actors in metrics");
});

test("metrics are cumulative, bounded and sent on their own timer", async () => {
  const c = collector();
  let t = 1000;
  const otel = otlpExporter({ endpoint: "https://otlp.example", service: "w", fetch: c.fetch, maxSeries: 2, now: () => t });
  const run = (route: string, ms: number) => {
    const trace = otel.startRequest(new Request(`${ORIGIN}${route}`));
    t += ms;
    otel.endRequest(trace, { method: "GET", route, path: route, status: 200 });
  };
  run("/a", 5);
  run("/a", 2000);
  run("/b", 20_000);
  run("/c", 1);
  run("/d", 1);
  await otel.flush();
  let [m] = metricsOf(c.sent).filter((x: any) => x.name === "http.server.request.duration");
  let byRoute = (r: string) => m.histogram.dataPoints.find((p: any) => attr(p, "http.route") === r);
  const a = byRoute("/a");
  assert.equal(a.count, "2");
  assert.equal(a.sum, 2.005);
  assert.equal(a.min, 0.005);
  assert.equal(a.max, 2);
  assert.equal(a.bucketCounts[0], "1");
  assert.equal(a.bucketCounts[a.explicitBounds.indexOf(2.5)], "1");
  assert.equal(byRoute("/b").bucketCounts.at(-1), "1");
  const overflow = m.histogram.dataPoints.find((p: any) => attr(p, "otel.metric.overflow") === true);
  assert.equal(overflow.count, "2", "series past maxSeries share one point");
  assert.equal(m.histogram.dataPoints.length, 3);

  run("/a", 1);
  c.sent.length = 0;
  await otel.flush();
  [m] = metricsOf(c.sent).filter((x: any) => x.name === "http.server.request.duration");
  byRoute = (r: string) => m.histogram.dataPoints.find((p: any) => attr(p, "http.route") === r);
  assert.equal(byRoute("/a").count, "3", "cumulative");
  assert.equal(byRoute("/a").startTimeUnixNano, "1000000000");

  const parent = otel.startRequest(new Request(ORIGIN));
  t += 10;
  const early = otel.span!("read X", { parent, elapsedMs: 50 });
  const fine = otel.span!("read Y", { parent, elapsedMs: 4 });
  assert.equal(early.context.start, parent.start, "clamped to the parent's start");
  assert.equal(fine.context.start, t - 4);
  assert.equal(otel.span!("root", { elapsedMs: 50 }).context.start, t - 50, "no parent, no clamp");

  assert.throws(() => otlpExporter({ endpoint: "https://otlp.example", service: "w", metricsMs: 10 }), /metricsMs/);
  assert.throws(() => otlpExporter({ endpoint: "https://otlp.example", service: "w", maxSeries: 0 }), /maxSeries/);
});

test("job runs: a consumer span with the outcome, and a duration by job", async () => {
  const c = collector();
  const otel = otlpExporter({ endpoint: "https://otlp.example", service: "worker", fetch: c.fetch });
  let tries = 0;
  const flaky = defineJob("flaky", [], () => {
    if (++tries < 2) throw new Error("try again");
  }, { attempts: 2, backoff: () => 0 });
  const doomed = defineJob("doomed", [], () => {
    throw new JobError("bad input", { retry: false });
  });
  const jobs = createJobs({ jobs: [flaky, doomed], telemetry: otel, onError: () => undefined });
  await jobs.enqueue(null, flaky);
  await jobs.enqueue(null, doomed);
  await jobs.drain();
  await ready();
  await otel.flush();

  const runs = spansOf(c.sent).filter((s: any) => s.name.startsWith("job "));
  const of = (name: string) => runs.filter((s: any) => s.name === name).map((s: any) => [attr(s, "weft.job.outcome"), attr(s, "weft.job.attempt"), s.status.code]);
  assert.deepEqual(of("job flaky"), [["retry", "1", 2], ["done", "2", 0]]);
  assert.deepEqual(of("job doomed"), [["dead", "1", 2]]);
  assert.ok(runs.every((s: any) => s.kind === 5 && /^[0-9a-f]{32}$/.test(s.traceId)));
  assert.equal(attr(runs.find((s: any) => s.name === "job doomed"), "error.type"), "JobError");

  const m = metricsOf(c.sent).find((x: any) => x.name === "weft.job.duration");
  const points = m.histogram.dataPoints.map((p: any) => [attr(p, "weft.job.name"), attr(p, "error.type") ?? null, p.count]);
  assert.deepEqual(points.sort(), [["doomed", "JobError", "1"], ["flaky", "Error", "1"], ["flaky", null, "1"]].sort());
});

test("model reads: child spans of their request or event, capped, never another app's", async () => {
  interface Note { id: string; owner: string; body: string }
  const Notes = defineModel<Note>("OtelNote", {
    fields: { id: "string", owner: "string", body: "string" },
    read: (actor: unknown, row: Note) => (actor as { id: string }).id === row.owner,
    write: () => true,
  });
  Notes.as({ id: "ada" }).create({ id: "1", owner: "ada", body: "secret text" });
  Notes.as({ id: "ada" }).create({ id: "2", owner: "ada", body: "secret text" });
  Notes.as({ id: "bob" }).create({ id: "3", owner: "bob", body: "secret text" });

  const a = collector();
  const b = collector();
  const otelA = otlpExporter({ endpoint: "https://otlp.example", service: "a", fetch: a.fetch });
  const otelB = otlpExporter({ endpoint: "https://otlp.example", service: "b", fetch: b.fetch });
  let late: Promise<void> = Promise.resolve();
  const Reader = defineComponent("Reader", () => ({
    handlers: { look() { Notes.as({ id: "bob" }).all(); } },
    render: () => `<button data-weft-on-click="look">x</button>`,
  }));
  const appA = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: { "/": { component: Reader as never } },
    api: {
      "/api/mine": {
        GET: () => {
          late = new Promise((r) => setTimeout(() => (Notes.as({ id: "ada" }).all(), r()), 5));
          return new Response(String(Notes.as({ id: "ada" }).all().length));
        },
      },
      "/api/loop": {
        GET: () => {
          for (let i = 0; i < 150; i++) Notes.as({ id: "ada" }).get("1");
          return new Response("ok");
        },
      },
    },
    onError: () => undefined,
    telemetry: otelA,
  });
  const appB = createApp({
    secret: "test-secret-test-secret-test-secret!",
    routes: {},
    api: { "/api/b": { GET: async () => { await ready(); Notes.publicUnscoped(); return new Response("b"); } } },
    telemetry: otelB,
  });
  await Promise.all([
    appA.fetch(new Request(`${ORIGIN}/api/mine`)),
    appB.fetch(new Request(`${ORIGIN}/api/b`)),
  ]);
  await late;
  await appA.fetch(new Request(`${ORIGIN}/api/loop`));

  const res = (await appA.fetch(new Request(`${ORIGIN}/`)))!;
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const html = await res.text();
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)![1];
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)![1]!;
  const sse = (await appA.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } })))!;
  const reader = sse.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const session = String((JSON.parse(/data: (.*)\n\n/.exec(first)![1]!) as { session: string }).session);
  await appA.fetch(
    new Request(`${ORIGIN}/_weft/live/event`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": session },
      body: JSON.stringify({ t: "event", id: "r", handler: "look", event: { type: "click" }, seq: 1 }),
    }),
  );
  await reader.cancel();
  await otelA.flush();
  await otelB.flush();
  appA.close();
  appB.close();

  const spansA = spansOf(a.sent);
  const byName = (n: string) => spansA.filter((s: any) => s.name === n);
  const mine = byName("GET /api/mine")[0];
  const loop = byName("GET /api/loop")[0];
  const event = byName("event Reader.look")[0];
  const reads = byName("read OtelNote");
  const under = (p: any) => reads.filter((s: any) => s.parentSpanId === p.spanId && s.traceId === p.traceId);

  const [one] = under(mine);
  assert.equal(attr(one, "weft.data.rows"), "2", "rows after the rules");
  assert.equal(attr(one, "weft.data.scoped"), true);
  assert.equal(attr(one, "weft.model"), "OtelNote");
  assert.ok(BigInt(one.startTimeUnixNano) >= BigInt(mine.startTimeUnixNano));
  assert.ok(BigInt(one.endTimeUnixNano) >= BigInt(one.startTimeUnixNano));
  assert.equal(under(loop).length, 100, "capped per request");
  assert.equal(under(event).length, 1, "an event's reads are its own");
  assert.equal(attr(under(event)[0], "weft.data.rows"), "1");
  assert.equal(reads.length, 1 + 100 + 1, "nothing after a request ended, nothing from app B");
  assert.doesNotMatch(JSON.stringify(a.sent), /secret text/, "never the rows");

  const spansB = spansOf(b.sent);
  const bReads = spansB.filter((s: any) => s.name === "read OtelNote");
  assert.equal(bReads.length, 1);
  assert.equal(attr(bReads[0], "weft.data.scoped"), false, "publicUnscoped is marked");
  assert.equal(attr(bReads[0], "weft.data.rows"), "3");
  assert.equal(bReads[0].parentSpanId, spansB.find((s: any) => s.name === "GET /api/b").spanId);
});
