import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeFeed, defineConsent, defineModel } from "@weft-framework/data";
import { defineComponent, escapeHtml } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";

const ORIGIN = "http://app.test";

test("withdrawing consent re-renders the pages that showed the field", async () => {
  const n = Math.random().toString(36).slice(2, 8);
  const purpose = `analytics${n}`;
  const feed = new ChangeFeed();
  const consent = defineConsent({ purposes: [purpose], name: `LiveConsent${n}` });
  consent.model.publishTo(feed);
  const Visits = defineModel<{ id: string; device: string | null }>(`LiveVisit${n}`, {
    fields: { id: "string", device: "string | null" },
    attrs: { device: { consent: purpose } },
    read: () => true,
  }).publishTo(feed);
  Visits.driver.insert({ id: "v1", device: "phone" });
  consent.agree({ id: "ada" }, purpose);

  const Page = defineComponent("ConsentPage", (p: { devices: (string | null)[] }) => ({
    render: () => `<p id="d">${p.devices.map((d) => escapeHtml(d ?? "hidden")).join(",")}</p>`,
  }));
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    sync: feed,
    syncDelayMs: 0,
    routes: { "/": { component: Page as never, load: () => ({ devices: Visits.as({ id: "ada" }).all().map((v) => v.device) }) } },
  });

  const res = (await app.fetch(new Request(`${ORIGIN}/`)))!;
  const html = await res.text();
  assert.match(html, /<p id="d">phone<\/p>/);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const lid = /name="weft-live" content="([^"]+)"/.exec(html)![1]!;
  const sse = (await app.fetch(new Request(`${ORIGIN}/_weft/live/sse?lid=${lid}`, { headers: { cookie } })))!;
  const reader = sse.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const until = async (re: RegExp, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (!re.test(buf)) {
      const got = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now())))]);
      if (got === null || got.done) return false;
      buf += dec.decode(got.value);
    }
    return true;
  };
  try {
    assert.ok(await until(/"session"/), "connected");
    buf = "";
    consent.withdraw({ id: "ada" }, purpose);
    assert.ok(await until(/hidden/), `re-rendered without the value: ${buf}`);
    assert.doesNotMatch(buf, /phone/);
    buf = "";
    consent.agree({ id: "ada" }, purpose);
    assert.ok(await until(/phone/), "shown again once agreed");
  } finally {
    await reader.cancel();
  }
});
