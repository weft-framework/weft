import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { createJobs, MemoryJobStore } from "../src/jobs.ts";
import {
  defineWebhooks,
  isPublicAddress,
  MemoryWebhookStore,
  nodeTransport,
  signWebhook,
  SqlWebhookStore,
  verifyWebhook,
  WebhookError,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookStore,
} from "../src/webhooks.ts";

const KEY = "webhook-key-webhook-key-webhook-key!";
const PUBLIC = async () => [{ address: "93.184.215.14", family: 4 }];

test("which addresses are public", () => {
  for (const ip of ["93.184.215.14", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:82a::200e", "::ffff:8.8.8.8", "::ffff:808:808", "172.32.0.1", "100.128.0.1"]) {
    assert.ok(isPublicAddress(ip), ip);
  }
  for (const ip of [
    "127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "240.0.0.1", "192.0.2.1", "198.51.100.7", "203.0.113.9", "198.18.0.1", "192.0.0.8",
    "::", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::127.0.0.1", "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456::1",
    "ff02::1", "2001:db8::1", "2002:7f00:1::1", "2001::1", "64:ff9b::7f00:1", "100::1", "3fff::1",
    "256.1.1.1", "1.2.3", "01.2.3.4x", "::ffff:1.2.3.256", "1:2:3:4:5:6:7:8:9", "2606:4700::1111::1", "gggg::1", "2606:4700:4700::1111%eth0", "2606:4700:4700:1:2:3:4::1111", "", "localhost",
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

function harness(o: { store?: WebhookStore; transport?: (r: WebhookRequest) => Promise<WebhookResponse>; disableAfter?: number; lookup?: typeof PUBLIC } = {}) {
  let clock = Date.UTC(2026, 10, 14, 12, 0, 0);
  const sent: WebhookRequest[] = [];
  const errors: unknown[] = [];
  let answer: (r: WebhookRequest) => Promise<WebhookResponse> = async () => ({ status: 204, body: "" });
  const hooks = defineWebhooks({
    events: ["invoice.paid", "member.added", "member.removed"],
    key: KEY,
    store: o.store ?? new MemoryWebhookStore(),
    jobs: () => jobs,
    lookup: o.lookup ?? PUBLIC,
    transport: o.transport ?? (async (r) => (sent.push(r), answer(r))),
    retrySchedule: [5_000, 60_000],
    disableAfter: o.disableAfter ?? 3,
    onError: (e) => errors.push(e),
    now: () => clock,
  });
  const jobs = createJobs({ jobs: [hooks.job], store: new MemoryJobStore(), now: () => clock, random: () => 0.5, onError: () => {} });
  return {
    hooks,
    jobs,
    sent,
    errors,
    answer: (f: typeof answer) => void (answer = f),
    tick: (ms: number) => void (clock += ms),
    now: () => clock,
  };
}

test("configuration mistakes are refused at startup", () => {
  const ok = { events: ["a.b"], key: KEY, jobs: () => null as never };
  assert.ok(defineWebhooks(ok));
  assert.throws(() => defineWebhooks({ ...ok, events: [] }), /events/);
  assert.throws(() => defineWebhooks({ ...ok, events: ["A.b"] }), /event type/);
  assert.throws(() => defineWebhooks({ ...ok, events: ["a.b", "a.b"] }), /twice/);
  assert.throws(() => defineWebhooks({ ...ok, key: "short" }), /key/);
  assert.throws(() => defineWebhooks({ ...ok, jobs: undefined as never }), /jobs/);
  assert.throws(() => defineWebhooks({ ...ok, retrySchedule: [-1] }), /retrySchedule/);
  assert.throws(() => defineWebhooks({ ...ok, timeoutMs: 10 }), /timeoutMs/);
  assert.throws(() => defineWebhooks({ ...ok, disableAfter: 0 }), /disableAfter/);
});

test("endpoint URLs: https, public hosts only, checked against DNS", async () => {
  const resolves = new Map<string, string[]>([
    ["hooks.acme.example", ["93.184.215.14", "2606:4700:4700::1111"]],
    ["rebind.evil.example", ["93.184.215.14", "127.0.0.1"]],
    ["meta.evil.example", ["169.254.169.254"]],
    ["v6.evil.example", ["::ffff:10.0.0.1"]],
  ]);
  const { hooks } = harness({
    lookup: async (h) => {
      const a = resolves.get(h);
      if (!a) throw new Error("ENOTFOUND");
      return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
  });
  const make = (url: string) => hooks.createEndpoint("acme", { url, events: ["*"] });
  const { endpoint, secret } = await make("https://hooks.acme.example/in?x=1");
  assert.equal(endpoint.url, "https://hooks.acme.example/in?x=1");
  assert.match(secret, /^whsec_[A-Za-z0-9+/]{32}$/);
  assert.ok((await make("https://93.184.215.14:8443/in")).endpoint);
  for (const [url, why] of [
    ["http://hooks.acme.example/in", /https/],
    ["ftp://hooks.acme.example/in", /https/],
    ["https://u:p@hooks.acme.example/in", /password/],
    ["https://hooks.acme.example/in#x", /fragment/],
    ["https://hooks.acme.example/in\n", /https/],
    ["https://localhost/in", /public host/],
    ["https://intranet/in", /public host/],
    ["https://db.internal/in", /public host/],
    ["https://printer.local/in", /public host/],
    ["https://127.0.0.1/in", /public address/],
    ["https://[::1]/in", /public address/],
    ["https://[::ffff:7f00:1]/in", /public address/],
    ["https://169.254.169.254/latest/meta-data/", /public address/],
    ["https://0x7f000001/in", /public address/],
    ["https://2130706433/in", /public address/],
    ["https://rebind.evil.example/in", /resolves to 127\.0\.0\.1/],
    ["https://meta.evil.example/in", /resolves to 169\.254/],
    ["https://v6.evil.example/in", /resolves to ::ffff:10/],
    ["https://nxdomain.example/in", /does not resolve/],
    [`https://hooks.acme.example/${"a".repeat(2100)}`, /https/],
  ] as const) {
    await assert.rejects(make(url), (e: unknown) => e instanceof WebhookError && why.test(e.message), url);
  }
  await assert.rejects(hooks.createEndpoint("acme", { url: "https://hooks.acme.example/", events: ["invoice.void" as never] }), /not an event type/);
  await assert.rejects(hooks.createEndpoint("acme", { url: "https://hooks.acme.example/", events: ["*", "invoice.paid"] }), /stands alone/);
  await assert.rejects(hooks.createEndpoint("acme", { url: "https://hooks.acme.example/", events: [] }), /events/);
  await assert.rejects(hooks.createEndpoint("", { url: "https://hooks.acme.example/", events: ["*"] }), /owner/);
});

test("a delivery is signed so a Standard Webhooks receiver accepts it, and only subscribed endpoints get it", async () => {
  const h = harness();
  const a = await h.hooks.createEndpoint("acme", { url: "https://a.acme.example/", events: ["invoice.paid"] });
  const b = await h.hooks.createEndpoint("acme", { url: "https://b.acme.example/", events: ["*"] });
  await h.hooks.createEndpoint("globex", { url: "https://g.globex.example/", events: ["*"] });

  const id = await h.hooks.emit("acme", "invoice.paid", { invoice: "in_1", amount: 1200 });
  assert.match(id!, /^msg_[0-9a-f]{32}$/);
  await h.jobs.drain();
  assert.deepEqual(h.sent.map((r) => r.url).sort(), ["https://a.acme.example/", "https://b.acme.example/"], "not the other owner's");
  for (const r of h.sent) {
    const secret = r.url.startsWith("https://a.") ? a.secret : b.secret;
    const body = await verifyWebhook(secret, r.headers, r.body, { now: h.now() });
    assert.deepEqual(body, { type: "invoice.paid", timestamp: "2026-11-14T12:00:00.000Z", data: { invoice: "in_1", amount: 1200 } });
    assert.equal(r.headers["webhook-id"], id);
    assert.equal(r.headers["content-type"], "application/json");
    await assert.rejects(verifyWebhook(secret, r.headers, r.body.replace("1200", "9999"), { now: h.now() }), /does not match/);
    await assert.rejects(verifyWebhook(secret === a.secret ? b.secret : a.secret, r.headers, r.body, { now: h.now() }), /does not match/);
    await assert.rejects(verifyWebhook(secret, r.headers, r.body, { now: h.now() + 301_000 }), /too far/);
    await assert.rejects(verifyWebhook(secret, { ...r.headers, "webhook-signature": undefined }, r.body), /missing/);
    const full = atob(r.headers["webhook-signature"]!.slice(3));
    for (const cut of [1, 16, 31]) {
      const short = { ...r.headers, "webhook-signature": `v1,${btoa(full.slice(0, cut))}` };
      await assert.rejects(verifyWebhook(secret, short, r.body, { now: h.now() }), /does not match/, `a ${cut}-byte prefix of the signature`);
    }
  }

  h.sent.length = 0;
  await h.hooks.emit("acme", "member.added", { user: "u1" });
  await h.jobs.drain();
  assert.deepEqual(h.sent.map((r) => r.url), ["https://b.acme.example/"], "a is subscribed to invoice.paid only");

  await h.hooks.updateEndpoint("acme", b.endpoint.id, { enabled: false });
  assert.equal(await h.hooks.emit("acme", "member.added", { user: "u2" }), null, "no enabled endpoint wants it: nothing stored");
  await assert.rejects(h.hooks.emit("acme", "member.banned" as never, {}), /not an event type/);
  await assert.rejects(h.hooks.emit("acme", "invoice.paid", { big: "x".repeat(300 * 1024) }), /over/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assert.rejects(h.hooks.emit("acme", "invoice.paid", cyclic), /not JSON/);

  const log = await h.hooks.deliveries("acme");
  assert.equal(log.length, 3);
  assert.ok(log.every((d) => d.status === "succeeded" && d.attempts.length === 1 && d.attempts[0]!.status === 204));
  assert.equal(log[0]!.event, "member.added", "newest first");
});

test("owners are kept apart", async () => {
  const h = harness();
  const a = await h.hooks.createEndpoint("acme", { url: "https://a.acme.example/", events: ["*"] });
  await h.hooks.emit("acme", "invoice.paid", {});
  await h.jobs.drain();
  const [d] = await h.hooks.deliveries("acme");
  assert.equal(await h.hooks.endpoint("globex", a.endpoint.id), null);
  assert.deepEqual(await h.hooks.endpoints("globex"), []);
  assert.deepEqual(await h.hooks.deliveries("globex"), []);
  assert.equal(await h.hooks.delivery("globex", d!.id), null);
  assert.equal(await h.hooks.replay("globex", d!.id), false);
  assert.equal(await h.hooks.removeEndpoint("globex", a.endpoint.id), false);
  await assert.rejects(h.hooks.updateEndpoint("globex", a.endpoint.id, { url: "https://evil.example/" }), /no such endpoint/);
  await assert.rejects(h.hooks.revealSecret("globex", a.endpoint.id), /no such endpoint/);
  await assert.rejects(h.hooks.rotateSecret("globex", a.endpoint.id), /no such endpoint/);
  assert.equal((await h.hooks.endpoint("acme", a.endpoint.id))!.url, "https://a.acme.example/");
  assert.equal(await h.hooks.revealSecret("acme", a.endpoint.id), a.secret);
  assert.equal("secret" in (await h.hooks.endpoints("acme"))[0]!, false, "listings never carry the secret");
  for (let i = 1; i < 20; i++) await h.hooks.createEndpoint("acme", { url: `https://a${i}.acme.example/`, events: ["*"] });
  await assert.rejects(h.hooks.createEndpoint("acme", { url: "https://more.acme.example/", events: ["*"] }), /at most 20/);
  assert.ok(await h.hooks.createEndpoint("globex", { url: "https://g.globex.example/", events: ["*"] }), "per owner");
});

test("failed attempts are retried on schedule, logged, and disable the endpoint after enough failures", async () => {
  const h = harness({ disableAfter: 2 });
  const ep = await h.hooks.createEndpoint("acme", { url: "https://a.acme.example/", events: ["*"] });
  let status = 302;
  h.answer(async () => ({ status, body: `down ${"!".repeat(5000)}` }));

  await h.hooks.emit("acme", "invoice.paid", { n: 1 });
  await h.jobs.drain();
  let [d] = await h.hooks.deliveries("acme");
  assert.equal(d!.status, "pending");
  assert.equal(d!.attempts.length, 1);
  assert.equal(d!.attempts[0]!.error, "HTTP 302", "a redirect is a failed attempt");
  status = 503;
  assert.equal(d!.attempts[0]!.response.length, 2048, "response excerpt capped");
  h.tick(4_000);
  await h.jobs.drain();
  assert.equal((await h.hooks.deliveries("acme"))[0]!.attempts.length, 1, "not before the first wait");
  h.tick(1_000);
  await h.jobs.drain();
  assert.equal((await h.hooks.deliveries("acme"))[0]!.attempts.length, 2);
  status = 200;
  h.tick(60_000);
  await h.jobs.drain();
  [d] = await h.hooks.deliveries("acme");
  assert.equal(d!.status, "succeeded");
  assert.deepEqual(d!.attempts.map((x) => x.status), [302, 503, 200]);
  assert.equal(new Set(h.sent.map((r) => r.headers["webhook-id"])).size, 1, "the same message id on every retry");

  status = 500;
  for (let i = 0; i < 2; i++) {
    await h.hooks.emit("acme", "invoice.paid", { n: i + 2 });
    for (let k = 0; k < 3; k++) {
      await h.jobs.drain();
      h.tick(61_000);
    }
  }
  assert.equal((await h.hooks.deliveries("acme", { status: "failed" })).length, 2, "3 attempts each, then failed");
  assert.equal((await h.jobs.counts()).dead, 0, "a delivery that failed for good is in the webhook log, not the dead-letter list");
  const off = (await h.hooks.endpoint("acme", ep.endpoint.id))!;
  assert.equal(off.enabled, false);
  assert.match(off.disabledReason!, /2 deliveries in a row failed/);
  assert.equal(await h.hooks.emit("acme", "invoice.paid", {}), null, "disabled endpoints get nothing");

  const on = await h.hooks.updateEndpoint("acme", ep.endpoint.id, { enabled: true });
  assert.deepEqual([on.enabled, on.disabledReason, on.failures], [true, null, 0]);

  status = 200;
  const failed = (await h.hooks.deliveries("acme", { status: "failed" }))[0]!;
  const before = h.sent.length;
  assert.equal(await h.hooks.replay("acme", failed.id), true);
  assert.equal(await h.hooks.replay("acme", failed.id), false, "already pending");
  await h.jobs.drain();
  const replayed = (await h.hooks.delivery("acme", failed.id))!;
  assert.equal(replayed.status, "succeeded");
  assert.equal(replayed.attempts.length, 4, "the log keeps earlier attempts");
  assert.equal(h.sent[before]!.headers["webhook-id"], failed.message, "a replay keeps the message id");
  assert.match(replayed.body!, /"n":/);
});

test("a delivery whose endpoint went away or was disabled stops without contacting it", async () => {
  const h = harness();
  const ep = await h.hooks.createEndpoint("acme", { url: "https://a.acme.example/", events: ["*"] });
  await h.hooks.emit("acme", "invoice.paid", {});
  await h.hooks.updateEndpoint("acme", ep.endpoint.id, { enabled: false });
  await h.jobs.drain();
  const [d] = await h.hooks.deliveries("acme");
  assert.equal(d!.status, "failed");
  assert.equal(d!.attempts[0]!.error, "endpoint disabled");
  assert.equal(h.sent.length, 0);
  assert.equal(await h.hooks.replay("acme", d!.id), false, "no replay to a disabled endpoint");

  await h.hooks.updateEndpoint("acme", ep.endpoint.id, { enabled: true, url: "https://b.acme.example/" });
  await h.hooks.emit("acme", "invoice.paid", {});
  assert.equal(await h.hooks.removeEndpoint("acme", ep.endpoint.id), true);
  await h.jobs.drain();
  assert.equal(h.sent.length, 0);
  assert.deepEqual(await h.hooks.deliveries("acme"), [], "the log went with the endpoint");
});

test("a host that resolves to a private address after it was saved is not contacted", async () => {
  let target = "93.184.215.14";
  const h = harness({ lookup: async () => [{ address: target, family: 4 }] });
  await h.hooks.createEndpoint("acme", { url: "https://a.acme.example/", events: ["*"] });
  target = "10.0.0.7";
  await h.hooks.emit("acme", "invoice.paid", {});
  await h.jobs.drain();
  assert.equal(h.sent.length, 0);
  assert.match((await h.hooks.deliveries("acme"))[0]!.attempts[0]!.error!, /resolves to 10\.0\.0\.7/);
});

test("rotating the secret: both sign until the old one expires", async () => {
  const h = harness();
  const { endpoint, secret: old } = await h.hooks.createEndpoint("acme", { url: "https://a.acme.example/", events: ["*"] });
  const fresh = await h.hooks.rotateSecret("acme", endpoint.id, { keepOldMs: 3600_000 });
  assert.notEqual(fresh, old);
  assert.equal(await h.hooks.revealSecret("acme", endpoint.id), fresh);
  await h.hooks.emit("acme", "invoice.paid", {});
  await h.jobs.drain();
  const r1 = h.sent.at(-1)!;
  assert.equal(r1.headers["webhook-signature"]!.split(" ").length, 2);
  await verifyWebhook(old, r1.headers, r1.body, { now: h.now() });
  await verifyWebhook(fresh, r1.headers, r1.body, { now: h.now() });
  h.tick(3600_001);
  await h.hooks.emit("acme", "invoice.paid", {});
  await h.jobs.drain();
  const r2 = h.sent.at(-1)!;
  assert.equal(r2.headers["webhook-signature"]!.split(" ").length, 1);
  await assert.rejects(verifyWebhook(old, r2.headers, r2.body, { now: h.now() }), /does not match/);
  await verifyWebhook(fresh, r2.headers, r2.body, { now: h.now() });
  await assert.rejects(h.hooks.rotateSecret("acme", endpoint.id, { keepOldMs: -1 }), /keepOldMs/);
});

test("signatures match the Standard Webhooks example", async () => {
  const sig = await signWebhook(["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"], "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}');
  assert.equal(sig, "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});

test("on SQLite, with secrets encrypted at rest; prune and forget", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const store = new SqlWebhookStore(db as never);
  const h = harness({ store });
  const { endpoint, secret } = await h.hooks.createEndpoint("acme", { url: "https://a.acme.example/", events: ["*"], description: "Billing sync" });
  const raw = JSON.stringify(db.prepare("SELECT * FROM weft_webhooks").all());
  assert.ok(!raw.includes(secret.slice(6)), "the secret is not stored in the clear");
  const sealed = JSON.parse(store.get("endpoint", endpoint.id)!) as { secret: string };
  store.put("endpoint", "ep_other", "acme", null, 0, JSON.stringify({ ...JSON.parse(store.get("endpoint", endpoint.id)!), id: "ep_other", secret: sealed.secret }));
  await h.hooks.emit("acme", "invoice.paid", { n: 1 });
  await h.jobs.drain();
  const [good] = await h.hooks.deliveries("acme", { endpoint: endpoint.id });
  assert.equal(good!.status, "succeeded");
  const [moved] = await h.hooks.deliveries("acme", { endpoint: "ep_other" });
  assert.equal(moved!.status, "failed", "a sealed secret is bound to its endpoint id");
  assert.match(moved!.attempts[0]!.error!, /cannot be read/);
  assert.equal(h.sent.length, 1);
  assert.equal(h.errors.length, 1);
  await store.remove("endpoint", "ep_other");
  assert.equal((await h.hooks.endpoints("acme"))[0]!.description, "Billing sync");

  h.tick(31 * 24 * 3600_000);
  await h.hooks.emit("acme", "invoice.paid", { n: 2 });
  await h.jobs.drain();
  assert.equal(await h.hooks.prune(), 3, "the old message and its two deliveries");
  assert.equal((await h.hooks.deliveries("acme")).length, 1);
  assert.equal(await h.hooks.forget("acme"), 1);
  assert.deepEqual(db.prepare("SELECT * FROM weft_webhooks WHERE owner = 'acme'").all(), []);
});

test("the default transport: a real POST, no redirects followed, and the address checked at connect time", async () => {
  const hits: { req: IncomingMessage; body: string }[] = [];
  let streamClosed = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ req, body });
      if (req.url === "/stream") {
        res.writeHead(200);
        res.write("z".repeat(5000));
        req.socket.on("close", () => (streamClosed = true));
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/elsewhere" }).end();
      } else {
        res.writeHead(200, { "content-type": "text/plain" }).end("y".repeat(10_000));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const loose = nodeTransport({ allowPrivateNetworks: true });
    const res = await loose({ url: `http://127.0.0.1:${port}/in`, headers: { "webhook-id": "msg_1" }, body: '{"a":1}', timeoutMs: 5000 });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2048);
    assert.equal(hits[0]!.body, '{"a":1}');
    assert.equal(hits[0]!.req.headers["webhook-id"], "msg_1");

    const endless = await loose({ url: `http://127.0.0.1:${port}/stream`, headers: {}, body: "{}", timeoutMs: 5000 });
    assert.equal(endless.body.length, 2048);
    for (let i = 0; i < 50 && !streamClosed; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(streamClosed, "a response that never ends is cut off after the excerpt");
    hits.pop();
    const r = await loose({ url: `http://127.0.0.1:${port}/redirect`, headers: {}, body: "{}", timeoutMs: 5000 });
    assert.equal(r.status, 302);
    assert.equal(hits.length, 2, "the redirect was not followed");

    const strict = nodeTransport({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
    await assert.rejects(strict({ url: `http://rebind.example:${port}/in`, headers: {}, body: "{}", timeoutMs: 5000 }), /not a public address/);
    await assert.rejects(nodeTransport()({ url: `http://127.0.0.1:${port}/in`, headers: {}, body: "{}", timeoutMs: 5000 }), /not a public address/);
    assert.equal(hits.length, 2, "refused before connecting");

    const h = harness({ transport: nodeTransport({ allowPrivateNetworks: true }) });
    const dev = defineWebhooks({ events: ["a.b"], key: KEY, jobs: () => h.jobs, allowInsecure: true, allowPrivateNetworks: true });
    assert.ok(await dev.checkUrl(`http://127.0.0.1:${port}/in`), "development settings allow a local receiver");
    await assert.rejects(h.hooks.checkUrl(`http://127.0.0.1:${port}/in`), /https/);
  } finally {
    server.close();
  }
});
