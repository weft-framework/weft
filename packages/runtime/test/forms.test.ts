import { test } from "node:test";
import assert from "node:assert/strict";
import { actionAttr } from "../src/escape.ts";
import {
  ActionFailed,
  clientAction,
  configureActions,
  enhanceForms,
  postAction,
  resetStandaloneActions,
  standaloneAction,
  type ActionTransport,
} from "../src/forms.ts";
import { h, text } from "../testing/fakedom.ts";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function transport(reply: (s: Sent) => unknown) {
  const sent: Sent[] = [];
  const went: string[] = [];
  let release: (() => void) | null = null;
  const t: ActionTransport & { hold: boolean } = {
    csrf: "tok",
    hold: false,
    path: () => "/list/a",
    fetch: async (url, init) => {
      const s = { url, headers: init.headers, body: init.body };
      sent.push(s);
      if (t.hold) {
        await new Promise<void>((r) => (release = r));
      }
      const out = reply(s);
      if (out instanceof Error) {
        throw out;
      }
      return { json: async () => out };
    },
    navigate: (to) => went.push(to),
  };
  return { t, sent, went, release: () => release?.() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("actionAttr renders actions as POSTs to ?/name and escapes anything else", () => {
  const save = { [Symbol.for("weft.action")]: true, name: "save" };
  assert.equal(actionAttr("action", save), ' action="?/save" method="post" data-weft-action="save"');
  assert.equal(actionAttr("formaction", save), ' formaction="?/save" formmethod="post" data-weft-action="save"');
  assert.equal(actionAttr("action", '/search?q="x"'), ' action="/search?q=&quot;x&quot;"');
  assert.equal(actionAttr("action", { name: "fake" }), ' action="[object Object]"');
});

test("postAction sends the CSRF token and validates the reply", async () => {
  const { t, sent } = transport(() => ({ ok: true, value: 3 }));
  assert.deepEqual(await postAction(t, "add", { a: 1 }, true), { ok: true, value: 3 });
  assert.equal(sent[0].url, "/list/a?/add");
  assert.equal(sent[0].headers["x-weft-csrf"], "tok");
  assert.equal(sent[0].headers["x-weft-enhanced"], "1");
  assert.equal(sent[0].headers["content-type"], "application/json");
  assert.equal(sent[0].body, '{"a":1}');

  const bad = transport(() => ({ ok: true, redirect: "https://evil.test/" }));
  assert.equal((await postAction(bad.t, "add", {}, true)).ok, false, "unsafe redirect refused");
  const junk = transport(() => "<html>");
  assert.deepEqual(await postAction(junk.t, "add", {}, true), { ok: false, error: "Unexpected response" });
  const down = transport(() => new Error("offline"));
  assert.equal((await postAction(down.t, "add", {}, true)).error, "Network error; try again");
});

test("enhanced forms post in place: busy while in flight, reset on success", async () => {
  const { t, sent, release } = transport(() => ({ ok: true }));
  t.hold = true;
  const button = h("button", {});
  const message = { textContent: "old error" as string | null };
  const form = Object.assign(h("form", { "data-weft-action": "add" }, button), {
    resets: 0,
    reset() {
      this.resets += 1;
    },
    querySelector: (sel: string) => (sel === "[data-weft-message]" ? message : null),
  });
  const root = h("body", {}, form);
  enhanceForms(root, t, { formData: (_f, sub) => (sub?.hasAttribute("disabled") ? "NO SUBMITTER" : "FIELDS") });

  const ev = root.dispatch("submit", form, { submitter: button } as never);
  assert.ok(ev.prevented, "the browser's own post is replaced");
  assert.equal(form.getAttribute("aria-busy"), "true");
  assert.equal(button.getAttribute("disabled"), "");
  root.dispatch("submit", form, { submitter: button } as never);
  assert.equal(sent.length, 1, "a double submit is ignored");
  assert.equal(sent[0].body, "FIELDS");
  assert.equal(sent[0].headers["content-type"], undefined, "form data keeps its own type");

  release();
  await tick();
  await tick();
  assert.equal(form.getAttribute("aria-busy"), null);
  assert.equal(button.getAttribute("disabled"), null);
  assert.equal(form.resets, 1);
  assert.equal(message.textContent, "");
});

test("refusals show in [data-weft-message]; redirects navigate; formaction picks the action", async () => {
  const { t, sent, went } = transport((s) =>
    s.url.endsWith("?/remove") ? { ok: true, redirect: "/done" } : { ok: false, error: "Title <required>" },
  );
  const message = { textContent: null as string | null };
  const other = h("button", { "data-weft-action": "remove", disabled: "" });
  const form = Object.assign(h("form", { "data-weft-action": "add" }, other), {
    querySelector: () => message,
  });
  const errors: string[] = [];
  const root = h("body", {}, form, h("form", {}, text("plain")));
  const stop = enhanceForms(root, t, { formData: () => null, onError: (m) => errors.push(m) });

  root.dispatch("submit", form);
  await tick();
  await tick();
  assert.equal(message.textContent, "Title <required>", "set as text, never markup");

  root.dispatch("submit", form, { submitter: other } as never);
  await tick();
  await tick();
  assert.equal(sent[1].url, "/list/a?/remove");
  assert.deepEqual(went, ["/done"]);
  assert.equal(other.getAttribute("disabled"), "", "a button disabled by the page stays disabled");

  const plain = root.childNodes[1];
  assert.equal(root.dispatch("submit", plain).prevented, false);

  stop();
  root.dispatch("submit", form);
  assert.equal(sent.length, 2);
  assert.deepEqual(errors, []);
});

test("island action calls send named JSON arguments", async () => {
  const add = clientAction("add", ["title", "qty", "note"]);
  configureActions(null);
  await assert.rejects(add("x", 1), ActionFailed);

  const { t, sent, went } = transport((s) => {
    const body = JSON.parse(String(s.body));
    if (body.title === "go") {
      return { ok: true, redirect: "/next" };
    }
    return body.title === "" ? { ok: false, error: "A title is required" } : { ok: true, value: { n: body.qty } };
  });
  configureActions(t);
  assert.deepEqual(await add("Milk", 2), { n: 2 });
  assert.equal(sent[0].body, '{"title":"Milk","qty":2}', "undefined arguments are left out");
  await assert.rejects(add("", 1), (e: Error) => e instanceof ActionFailed && e.message === "A title is required");
  assert.equal(await add("go", 1), undefined);
  assert.deepEqual(went, ["/next"]);
  configureActions(null);
});

test("without a booted page actions fetch a token once and use the fixed endpoint", async () => {
  resetStandaloneActions();
  const calls: { url: string; method: string; csrf?: string; body?: string }[] = [];
  let tokens = 0;
  let valid = "t1";
  const f = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, csrf: init.headers["x-weft-csrf"], body: init.body });
    if (url === "/_weft/session") {
      tokens += 1;
      return { status: 200, json: async () => ({ csrf: valid }) };
    }
    if (init.headers["x-weft-csrf"] !== valid) {
      return { status: 403, json: async () => ({ ok: false, error: "Session expired; reload the page" }) };
    }
    return { status: 200, json: async () => ({ ok: true, value: JSON.parse(init.body ?? "null") }) };
  };
  assert.deepEqual(await standaloneAction("add", { n: 1 }, f), { ok: true, value: { n: 1 } });
  assert.deepEqual(await standaloneAction("add", { n: 2 }, f), { ok: true, value: { n: 2 } });
  assert.equal(tokens, 1, "the token is cached");
  assert.equal(calls[1].url, "/_weft/action/add");
  assert.equal(calls[1].csrf, "t1");
  valid = "t2";
  assert.deepEqual(await standaloneAction("add", { n: 3 }, f), { ok: true, value: { n: 3 } });
  assert.equal(tokens, 2);
  valid = "never";
  const stuck = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
    url === "/_weft/session" ? { status: 200, json: async () => ({ csrf: "stale" }) } : f(url, init);
  assert.equal((await standaloneAction("add", {}, stuck)).ok, false);
  resetStandaloneActions();
  const down = async () => {
    throw new Error("offline");
  };
  assert.deepEqual(await standaloneAction("add", {}, down), { ok: false, error: "Network error; try again" });
  resetStandaloneActions();
});

test("a bound action's held token goes with the post, from the form or the button pressed", async () => {
  const { t, sent } = transport(() => ({ ok: true }));
  const button = h("button", { "data-weft-action": "remove", "data-weft-held": "B.sig" });
  const plainButton = h("button", { "data-weft-action": "archive" });
  const form = h("form", { "data-weft-action": "rename", "data-weft-held": "A.sig" }, button, plainButton);
  const root = h("body", {}, form);
  enhanceForms(root, t, { formData: () => null });
  for (const submitter of [null, button, plainButton]) {
    root.dispatch("submit", form, (submitter ? { submitter } : {}) as never);
    await tick();
    await tick();
  }
  assert.deepEqual(
    sent.map((s) => s.url),
    ["/list/a?/rename&_weft_held=A.sig", "/list/a?/remove&_weft_held=B.sig", "/list/a?/archive"],
    "a button's own action never borrows the form's held values",
  );
});
