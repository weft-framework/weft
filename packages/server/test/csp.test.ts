import { test } from "node:test";
import assert from "node:assert/strict";
import { defineComponent } from "@weft-framework/runtime";
import { createApp, type CspViolation } from "../src/app.ts";
import { parseCspReports } from "../src/app.ts";
import { checkCspSources, securityHeaders } from "../src/security.ts";
import { parseConfig } from "../src/config.ts";

const ORIGIN = "http://app.test";
const Plain = defineComponent("Plain", () => ({ render: () => `<p>page</p>` }));

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(name + " ")) ?? null;

test("each route's policy adds only what it and the app list", async () => {
  const seen: CspViolation[] = [];
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    csp: { img: ["https://img.example.com"] },
    cspReport: (v) => seen.push(v),
    routes: {
      "/": { component: Plain as never },
      "/map": {
        component: Plain as never,
        csp: { connect: ["https://tiles.example.com", "wss://live.example.com"], frame: ["https://www.youtube-nocookie.com"] },
      },
    },
  });
  const csp = async (path: string) => (await app.fetch(new Request(`${ORIGIN}${path}`)))!.headers.get("content-security-policy")!;
  const home = await csp("/");
  assert.equal(directive(home, "connect-src"), "connect-src 'self'");
  assert.equal(directive(home, "img-src"), "img-src 'self' data: https://img.example.com");
  assert.equal(directive(home, "frame-src"), "frame-src 'none'");
  assert.match(home, /script-src 'nonce-[^']+' 'self'(;|$)/, "scripts: the app's own only, never widened");
  assert.match(home, /report-uri \/_weft\/csp/);

  const map = await csp("/map");
  assert.equal(directive(map, "connect-src"), "connect-src 'self' https://tiles.example.com wss://live.example.com");
  assert.equal(directive(map, "frame-src"), "frame-src https://www.youtube-nocookie.com");
  assert.equal(directive(map, "img-src"), "img-src 'self' data: https://img.example.com");

  const r = await app.fetch(
    new Request(`${ORIGIN}/_weft/csp`, {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: JSON.stringify({
        "csp-report": {
          "document-uri": `${ORIGIN}/map?token=secret`,
          "effective-directive": "connect-src",
          "blocked-uri": "https://tracker.example.net/collect?id=42",
          "source-file": `${ORIGIN}/_weft/npm/chart@1.0.0/index.js`,
        },
      }),
    }),
  );
  assert.equal(r!.status, 204);
  assert.deepEqual(seen, [
    { route: "/map", directive: "connect-src", blocked: "https://tracker.example.net", source: "/_weft/npm/chart@1.0.0/index.js" },
  ]);
  const big = await app.fetch(new Request(`${ORIGIN}/_weft/csp`, { method: "POST", body: "x".repeat(9000) }));
  assert.equal(big!.status, 204);
  assert.equal(seen.length, 1, "an oversized report is dropped");
  app.close();
});

test("without a handler or devtools, no report endpoint and no report-uri", async () => {
  const app = createApp({ secret: "test-secret-test-secret-test-secret!", routes: { "/": { component: Plain as never } } });
  const res = (await app.fetch(new Request(`${ORIGIN}/`)))!;
  assert.equal(/report-uri/.test(res.headers.get("content-security-policy")!), false);
  assert.equal(res.headers.get("reporting-endpoints"), null);
  const post = await app.fetch(new Request(`${ORIGIN}/_weft/csp`, { method: "POST", body: "{}" }));
  assert.notEqual(post?.status, 204);
  app.close();
});

test("only narrow sources are accepted", () => {
  assert.deepEqual(checkCspSources({ connect: ["https://api.example.com", "https://api.example.com"] }, "t"), {
    connect: ["https://api.example.com"],
  });
  for (const ok of ["https://*.example.com", "wss://x.example.com:8443/ws", "http://localhost:5173", "https://a.example.com/path/"]) {
    assert.doesNotThrow(() => checkCspSources({ connect: [ok] }, "t"), ok);
  }
  assert.doesNotThrow(() => checkCspSources({ img: ["data:", "blob:"], font: ["data:"] }, "t"));
  for (const bad of ["*", "https:", "'unsafe-inline'", "http://example.com", "https://a.com; script-src *", "https://a.com b.com", "data:"]) {
    assert.throws(() => checkCspSources({ connect: [bad] }, "t"), /csp\.connect entry/, bad);
  }
  assert.throws(() => checkCspSources({ script: ["https://cdn.example.com"] }, "t"), /csp\.script is not one of/);
  assert.throws(() => parseConfig({ csp: { frame: ["*"] } }), /weft\.config\.ts: csp\.frame/);
  assert.deepEqual(parseConfig({ csp: { media: ["https://cdn.example.com"] } }).csp, { media: ["https://cdn.example.com"] });
  assert.throws(
    () => createApp({ secret: "test-secret-test-secret-test-secret!", routes: { "/": { component: Plain as never, csp: { connect: ["*"] } } } }),
    /route \/: csp\.connect/,
  );
  const h = securityHeaders({ nonce: "n", secure: false, sources: { form: ["https://checkout.example.com"], worker: ["blob:"] } });
  assert.match(h["content-security-policy"]!, /form-action 'self' https:\/\/checkout\.example\.com/);
  assert.match(h["content-security-policy"]!, /worker-src 'self' blob:/);
});

test("reports in the Reporting API format; other sites and junk are dropped", () => {
  const at = (p: string) => (p.startsWith("/map") ? "/map" : undefined);
  const list = JSON.stringify([
    { type: "csp-violation", body: { documentURL: `${ORIGIN}/map`, effectiveDirective: "img-src", blockedURL: "data:image/png;base64,AAAA" } },
    { type: "csp-violation", body: { documentURL: "https://other.test/map", effectiveDirective: "img-src", blockedURL: "https://x.test/" } },
    { type: "deprecation", body: {} },
    { type: "csp-violation", body: { documentURL: `${ORIGIN}/x`, effectiveDirective: "script-src-elem", blockedURL: "inline" } },
  ]);
  assert.deepEqual(parseCspReports(list, ORIGIN, at), [
    { route: "/map", directive: "img-src", blocked: "data", source: null },
    { route: null, directive: "script-src-elem", blocked: "inline", source: null },
  ]);
  assert.deepEqual(parseCspReports("not json", ORIGIN, at), []);
});

test("a route's csp() adds per-request origins from its data, validated, never edge-cached", async () => {
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    csp: { img: ["https://img.example.com"] },
    routes: {
      "/nodes/[region]": {
        component: Plain as never,
        load: (ctx) => ({ probe: `https://${ctx.params.region}.nodes.example.com` }),
        csp: { connect: ["https://api.example.com"] },
        cspFor: (_ctx, data: { probe: string }) => ({ connect: [data.probe, "https://api.example.com"] }),
      },
      "/none": { component: Plain as never, cspFor: () => undefined },
      "/bad": { component: Plain as never, load: () => ({}), cspFor: () => ({ script: ["https://evil.example"] }) as never },
      "/wide": { component: Plain as never, load: () => ({}), cspFor: () => ({ connect: ["*"] }) },
    },
    onError: () => {},
  });
  const res = async (path: string) => (await app.fetch(new Request(`${ORIGIN}${path}`)))!;
  const eu = (await res("/nodes/eu")).headers.get("content-security-policy")!;
  assert.equal(directive(eu, "connect-src"), "connect-src 'self' https://api.example.com https://eu.nodes.example.com");
  assert.equal(directive(eu, "img-src"), "img-src 'self' data: https://img.example.com");
  const us = (await res("/nodes/us")).headers.get("content-security-policy")!;
  assert.equal(directive(us, "connect-src"), "connect-src 'self' https://api.example.com https://us.nodes.example.com");
  const none = await res("/none");
  assert.equal(none.status, 200);
  assert.equal(none.headers.get("cache-control"), "no-store");
  assert.equal(directive(none.headers.get("content-security-policy")!, "connect-src"), "connect-src 'self'");
  assert.equal((await res("/bad")).status, 500);
  assert.equal((await res("/wide")).status, 500);
});

test("frame ancestors: denied by default, 'self' or listed origins when a route allows embedding", () => {
  const base = securityHeaders({ nonce: "n", secure: true });
  assert.match(base["content-security-policy"]!, /frame-ancestors 'none'/);
  assert.equal(base["x-frame-options"], "DENY");

  const self = securityHeaders({ nonce: "n", secure: true, sources: checkCspSources({ ancestors: ["'self'"] }, "t") });
  assert.match(self["content-security-policy"]!, /frame-ancestors 'self'(;|$)/);
  assert.equal(self["x-frame-options"], "SAMEORIGIN");

  const partners = securityHeaders({
    nonce: "n",
    secure: true,
    sources: checkCspSources({ ancestors: ["'self'", "https://*.partner.example"] }, "t"),
  });
  assert.match(partners["content-security-policy"]!, /frame-ancestors 'self' https:\/\/\*\.partner\.example/);
  assert.equal(partners["x-frame-options"], undefined, "the CSP decides when other origins may embed");

  assert.throws(() => checkCspSources({ frame: ["'self'"] }, "t"), /not an origin/);
  assert.throws(() => checkCspSources({ ancestors: ["*"] }, "t"), /not an origin/);
  assert.throws(() => checkCspSources({ ancestors: ["http://evil.example"] }, "t"), /not an origin/);
});
