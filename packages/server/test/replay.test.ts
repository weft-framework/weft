import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent, escapeHtml, signal, type EventPayload } from "@weft-framework/runtime";
import { createApp, type AppOptions } from "../src/app.ts";
import { outcomeOf, parseRecording, recordingTest, redactPath, redactPayload, replay, ReplayError, type Recording } from "../src/replay.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";

const Form = defineComponent("Form", (_props: Record<string, never>) => {
  const said = signal("");
  const n = signal(0);
  return {
    handlers: {
      say(ev: EventPayload) {
        said.value = ev.form?.text ?? "";
      },
      inc() {
        n.value += 1;
      },
      boom() {
        if (n.value > 0) throw new Error("broken after a click");
      },
    },
    render: () =>
      `<p>${escapeHtml(said.value)} ${n.value}</p><form data-weft-on-submit="say"><input name="text"></form>` +
      `<button data-weft-on-click="inc">+</button><button data-weft-on-click="boom">!</button>`,
  };
});

function makeApp(extra: Partial<AppOptions> = {}) {
  return createApp({
    secret: SECRET,
    devtools: true,
    onError: () => {},
    routes: { "/": { component: Form as never, load: () => ({}) } },
    ...extra,
  });
}

type App = ReturnType<typeof createApp>;
const fetchOf = (app: App) => (async (url: string | URL | Request, init?: RequestInit) =>
  (await app.fetch(new Request(url, init)))!) as typeof fetch;

async function record(app: App, events: Record<string, unknown>[]): Promise<Recording> {
  const res = await app.fetch(new Request(ORIGIN + "/?q=1&token=hunter2"));
  const html = await res!.text();
  const cookie = (res!.headers.get("set-cookie") ?? "").split(";")[0];
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)![1];
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)![1];
  const sse = await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } }));
  const reader = sse!.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const session = JSON.parse(/data: (.*)\n\n/.exec(first)![1]).session;
  for (const [i, e] of events.entries()) {
    const r = await app.fetch(
      new Request(`${ORIGIN}/_weft/live/event`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "x-weft-csrf": csrf, "x-weft-session": session },
        body: JSON.stringify({ t: "event", id: "r", seq: i + 1, ...e }),
      }),
    );
    assert.equal(r!.status, 204);
  }
  const got = await app.fetch(new Request(`${ORIGIN}/_weft/dev/recording?lid=${lid}`, { headers: { cookie } }));
  assert.equal(got!.status, 200);
  assert.match(got!.headers.get("content-disposition") ?? "", /attachment/);
  const other = await app.fetch(new Request(`${ORIGIN}/_weft/dev/recording?lid=${lid}`));
  assert.equal(other!.status, 404, "another session cannot download it");
  await reader.cancel();
  return parseRecording(await got!.text());
}

test("a recording keeps the events, never the values, and replays as recorded", async () => {
  const app = makeApp();
  const rec = await record(app, [
    { handler: "say", event: { type: "submit", form: { text: "my password is hunter2" } } },
    { handler: "inc", event: { type: "click" } },
  ]);
  assert.equal(rec.path, "/?q=1&token=redacted");
  assert.equal(rec.actor, "anonymous");
  assert.deepEqual(rec.steps.map((s) => [s.handler, s.event, s.outcome]), [
    ["say", { type: "submit", form: { text: "x".repeat(22) } }, ["patch r"]],
    ["inc", { type: "click" }, ["patch r"]],
  ]);
  assert.equal(JSON.stringify(rec).includes("hunter2"), false);

  const seen: string[] = [];
  const result = await replay(rec, { url: ORIGIN, fetch: fetchOf(app), onStep: (s) => seen.push(s.what) });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(seen, ["submit -> say on r", "click -> inc on r"]);
  app.close();
});

test("a step answered differently fails the replay", async () => {
  const app = makeApp();
  const rec = await record(app, [{ handler: "boom", event: { type: "click" } }]);
  assert.deepEqual(rec.steps[0].outcome, ["ack"]);
  const changed: Recording = { ...rec, steps: [{ ...rec.steps[0], handler: "inc", outcome: ["patch r"] }, rec.steps[0]] };
  const result = await replay(changed, { url: ORIGIN, fetch: fetchOf(app) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.steps[1].got, ["error"]);
  app.close();
});

test("recordings are off without devtools, and files are checked strictly", async () => {
  const app = makeApp({ devtools: false });
  const res = await app.fetch(new Request(ORIGIN + "/"));
  const cookie = (res!.headers.get("set-cookie") ?? "").split(";")[0];
  const lid = /name="weft-live" content="([^"]+)"/.exec(await res!.text())![1];
  assert.equal((await app.fetch(new Request(`${ORIGIN}/_weft/dev/recording?lid=${lid}`, { headers: { cookie } })))!.status, 404);
  app.close();

  const ok = { weft: "recording", v: 1, path: "/", actor: "anonymous", at: 0, steps: [] };
  assert.throws(() => parseRecording("nope"), ReplayError);
  assert.throws(() => parseRecording(JSON.stringify({ ...ok, path: "//evil.example/" })), /same-site/);
  assert.throws(() => parseRecording(JSON.stringify({ ...ok, path: "https://evil.example/" })), /same-site/);
  assert.throws(() => parseRecording(JSON.stringify({ ...ok, steps: [{ at: 0, id: "r", handler: "h", event: { type: "click", form: { a: 1 } }, outcome: [] }] })), /step 1/);
  assert.deepEqual(parseRecording(JSON.stringify({ ...ok, extra: 1 })), ok, "unknown fields are dropped");
});

test("redaction: values, single keys and secret-looking query values", () => {
  assert.deepEqual(redactPayload({ type: "keydown", key: "a" }), { type: "keydown", key: "x" });
  assert.deepEqual(redactPayload({ type: "keydown", key: "Enter" }), { type: "keydown", key: "Enter" });
  assert.deepEqual(redactPayload({ type: "input", value: "abc", checked: true }), { type: "input", value: "xxx", checked: true });
  assert.deepEqual(redactPayload({ type: "submit", form: { a: "secret" }, stale: true, queued: true }), { type: "submit", form: { a: "xxxxxx" } });
  assert.equal(redactPath(new URL("http://h/reset?code=123&page=2&api_key=z")), "/reset?code=redacted&page=2&api_key=redacted");
  assert.deepEqual(outcomeOf([{ t: "patch", id: "r", html: "", ack: 1 }, { t: "patch", id: "r", html: "", ack: 1 }, { t: "ack", ack: 1 }]), ["patch r", "ack"]);
});

test("--test writes a node:test file that embeds the recording", () => {
  const rec: Recording = { weft: "recording", v: 1, path: "/", actor: "id 7", at: 0, steps: [] };
  const src = recordingTest(rec, "replays / (0 steps)", "http://127.0.0.1:3000");
  assert.match(src, /import \{ parseRecording, replay \} from "@weft-framework\/server\/replay";/);
  assert.match(src, /test\("replays \/ \(0 steps\)"/);
  assert.match(src, /process\.env\.WEFT_URL \?\? "http:\/\/127\.0\.0\.1:3000"/);
  assert.ok(src.includes('"actor": "id 7"'));
});
