import { realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { EventPayload, ServerMessage } from "@weft/runtime";

export class ReplayError extends Error {}

export interface RecordedStep {
  at: number;
  id: string;
  handler: string;
  event: EventPayload;
  args?: string;
  outcome: string[];
}

export interface Recording {
  weft: "recording";
  v: 1;
  path: string;
  actor: string;
  at: number;
  steps: RecordedStep[];
}

export const RECORDING_MAX = 500;
const VALUE_MAX = 256;
const SECRET_NAME = /pass|secret|token|code|key|sig|otp|csrf|auth|session/i;

const blank = (v: string) => "x".repeat(Math.min(v.length, VALUE_MAX));

export function redactPayload(ev: EventPayload): EventPayload {
  const out: EventPayload = { type: ev.type };
  if (ev.value !== undefined) out.value = blank(ev.value);
  if (ev.checked !== undefined) out.checked = ev.checked;
  if (ev.key !== undefined) out.key = ev.key.length > 1 && /^[A-Z][A-Za-z0-9]*$/.test(ev.key) ? ev.key : "x";
  if (ev.form !== undefined) {
    out.form = {};
    for (const [name, value] of Object.entries(ev.form)) out.form[name] = blank(value);
  }
  return out;
}

export function redactPath(url: URL): string {
  const q = new URLSearchParams();
  for (const [k, v] of url.searchParams) q.append(k, SECRET_NAME.test(k) ? "redacted" : v);
  const s = q.toString();
  return url.pathname + (s ? "?" + s : "");
}

export function outcomeOf(msgs: ServerMessage[]): string[] {
  const out: string[] = [];
  for (const m of msgs) {
    if (m.t === "patch") out.push(`patch ${m.id}`);
    else if (m.t === "redirect") out.push(`redirect ${m.to}`);
    else if (m.t === "error") out.push("error");
    else if (m.t === "conflict") out.push("conflict");
    else if (m.t === "ack") out.push("ack");
  }
  return [...new Set(out)];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

export function parseRecording(text: string): Recording {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ReplayError("not a recording: the file is not JSON");
  }
  if (!isObj(v) || v.weft !== "recording" || v.v !== 1) throw new ReplayError("not a recording (weft: \"recording\", v: 1)");
  if (!isStr(v.path, 4096) || !v.path.startsWith("/") || v.path.startsWith("//")) throw new ReplayError("recording: path must be a same-site path");
  if (!isStr(v.actor, 256) || typeof v.at !== "number") throw new ReplayError("recording: actor and at are required");
  if (!Array.isArray(v.steps) || v.steps.length > RECORDING_MAX) throw new ReplayError(`recording: at most ${RECORDING_MAX} steps`);
  const steps: RecordedStep[] = [];
  for (const [i, s] of v.steps.entries()) {
    const bad = () => new ReplayError(`recording: step ${i + 1} is malformed`);
    if (!isObj(s) || typeof s.at !== "number" || !isStr(s.id, 128) || !isStr(s.handler, 128) || !isObj(s.event)) throw bad();
    if (!isStr(s.event.type, 64) || (s.args !== undefined && !isStr(s.args, 8192))) throw bad();
    if (!Array.isArray(s.outcome) || !s.outcome.every((o) => isStr(o, 4096))) throw bad();
    const ev = s.event;
    const event: EventPayload = { type: ev.type as string };
    if (ev.value !== undefined) event.value = isStr(ev.value, VALUE_MAX) ? ev.value : (() => { throw bad(); })();
    if (ev.checked !== undefined) event.checked = typeof ev.checked === "boolean" ? ev.checked : (() => { throw bad(); })();
    if (ev.key !== undefined) event.key = isStr(ev.key, 32) ? ev.key : (() => { throw bad(); })();
    if (ev.form !== undefined) {
      if (!isObj(ev.form) || !Object.values(ev.form).every((x) => isStr(x, VALUE_MAX))) throw bad();
      event.form = { ...(ev.form as Record<string, string>) };
    }
    steps.push({ at: s.at, id: s.id, handler: s.handler, event, ...(s.args !== undefined ? { args: s.args as string } : {}), outcome: s.outcome as string[] });
  }
  return { weft: "recording", v: 1, path: v.path, actor: v.actor, at: v.at, steps };
}

export interface ReplayStep {
  n: number;
  what: string;
  expected: string[];
  got: string[];
  same: boolean;
}

export interface ReplayResult {
  steps: ReplayStep[];
  ok: boolean;
}

export interface ReplayOptions {
  url: string;
  cookie?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  onStep?(step: ReplayStep): void;
}

export async function replay(rec: Recording, opts: ReplayOptions): Promise<ReplayResult> {
  const f = opts.fetch ?? fetch;
  const origin = new URL(opts.url).origin;
  const wait = opts.timeoutMs ?? 5000;
  let cookie = opts.cookie ?? "";
  const page = await f(origin + rec.path, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  if (page.status !== 200) throw new ReplayError(`GET ${rec.path} answered ${page.status}`);
  const html = await page.text();
  const set = page.headers.get("set-cookie");
  if (set && !cookie) cookie = set.split(";")[0];
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)?.[1];
  const csrf = /name="weft-csrf" content="([^"]+)"/.exec(html)?.[1] ?? "";
  if (!lid) throw new ReplayError(`${rec.path} is not a live page here: nothing to replay`);
  const ac = new AbortController();
  const sse = await f(`${origin}/_weft/live/sse?lid=${encodeURIComponent(lid)}`, { headers: { cookie }, signal: ac.signal });
  if (sse.status !== 200 || !sse.body) throw new ReplayError(`the live stream answered ${sse.status}`);
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const next = async (ms: number): Promise<ServerMessage | null> => {
    const end = Date.now() + ms;
    for (;;) {
      const m = /data: (.*)\n\n/.exec(buf);
      if (m) {
        buf = buf.slice(m.index + m[0].length);
        return JSON.parse(m[1]) as ServerMessage;
      }
      pending ??= reader.read();
      const got = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, end - Date.now())))]);
      if (got === null) return null;
      pending = null;
      if (got.done) return null;
      buf += dec.decode(got.value, { stream: true });
    }
  };
  try {
    const hello = await next(wait);
    if (!hello || hello.t !== "hello") throw new ReplayError("the live stream sent no hello");
    const headers = {
      cookie,
      origin,
      "content-type": "application/json",
      "x-weft-csrf": csrf,
      "x-weft-session": hello.session,
    };
    const steps: ReplayStep[] = [];
    for (const [i, s] of rec.steps.entries()) {
      const seq = i + 1;
      const body = { t: "event", id: s.id, handler: s.handler, event: s.event, seq, ...(s.args ? { args: s.args } : {}) };
      const res = await f(`${origin}/_weft/live/event`, { method: "POST", headers, body: JSON.stringify(body) });
      const answer: ServerMessage[] = [];
      if (res.status !== 204) {
        answer.push({ t: "error", message: `HTTP ${res.status}` });
      } else {
        let deadline = wait;
        for (;;) {
          const m = await next(deadline);
          if (!m) break;
          if (m.t === "expired") {
            answer.push({ t: "error", message: "expired" });
            break;
          }
          if (m.t === "redirect" || ("ack" in m && m.ack === seq)) {
            answer.push(m);
            deadline = 50;
          }
        }
      }
      const got = outcomeOf(answer);
      const same = got.length === s.outcome.length && got.every((o, k) => o === s.outcome[k]);
      const step = { n: seq, what: `${s.event.type} -> ${s.handler} on ${s.id}`, expected: s.outcome, got, same };
      steps.push(step);
      opts.onStep?.(step);
      if (answer.some((m) => m.t === "redirect")) break;
    }
    return { steps, ok: steps.length === rec.steps.length && steps.every((s) => s.same) };
  } finally {
    ac.abort();
    await reader.cancel().catch(() => {});
  }
}

export function recordingTest(rec: Recording, name: string, url: string): string {
  const json = JSON.stringify(rec, null, 2).replace(/<\/script/gi, "<\\/script");
  return `// Made by \`weft replay --test\` from a recording of ${rec.path} (as ${rec.actor}).
// It replays the recorded events on a running server (\`weft dev\`, or
// WEFT_URL) and checks each is answered as it was when recorded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRecording, replay } from "@weft/server/replay";

const recording = parseRecording(JSON.stringify(${json}));

test(${JSON.stringify(name)}, async () => {
  const result = await replay(recording, { url: process.env.WEFT_URL ?? ${JSON.stringify(url)}, cookie: process.env.WEFT_REPLAY_COOKIE });
  for (const s of result.steps) assert.deepEqual(s.got, s.expected, \`step \${s.n}: \${s.what}\`);
  assert.equal(result.steps.length, recording.steps.length, "every step ran");
});
`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { url: { type: "string" }, cookie: { type: "string" }, test: { type: "string" }, file: { type: "string" } },
  });
  const file = values.file ?? positionals[1] ?? positionals[0];
  const url = values.url ?? process.env.WEFT_URL ?? "http://127.0.0.1:3000";
  try {
    if (!file) throw new ReplayError("which recording? weft replay <file>");
    const rec = parseRecording(await readFile(resolve(file), "utf8"));
    if (values.test) {
      const name = `replays ${rec.path} (${rec.steps.length} steps)`;
      writeFileSync(resolve(values.test), recordingTest(rec, name, url), { flag: "wx" });
      console.log(`[weft] wrote ${values.test}`);
      return;
    }
    console.log(`[weft] replaying ${rec.steps.length} step(s) of ${rec.path}, recorded as ${rec.actor}, on ${url}`);
    const cookie = values.cookie ?? process.env.WEFT_REPLAY_COOKIE;
    const result = await replay(rec, {
      url,
      ...(cookie ? { cookie } : {}),
      onStep: (s) =>
        console.log(`${s.same ? "  ok  " : "  DIFF"} ${s.n}. ${s.what}: ${s.got.join(", ") || "no answer"}` +
          (s.same ? "" : ` (recorded: ${s.expected.join(", ") || "no answer"})`)),
    });
    if (!result.ok) {
      console.error("[weft] the replay differs from the recording");
      process.exit(1);
    }
    console.log("[weft] every step answered as recorded");
  } catch (err) {
    if (err instanceof ReplayError) console.error(`[weft] ${err.message}`);
    else if (err && typeof err === "object" && (err as { code?: string }).code === "EEXIST") console.error(`[weft] ${values.test} exists; choose another --test`);
    else if (err && typeof err === "object" && (err as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") console.error(`[weft] nothing answers on ${url}: start \`weft dev\` first`);
    else console.error("[weft] replay:", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  }
}

function isEntry(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  void main();
}
