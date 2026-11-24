import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { checkTrustedProxies, clientAddress, normalizeAddress, parseTrustedProxies, resolveClientAddress } from "../src/client-address.ts";
import { serveNode } from "../src/node.ts";

test("addresses are normalised and validated", () => {
  assert.equal(normalizeAddress("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeAddress("[2001:DB8::1]:443"), "2001:db8::1");
  assert.equal(normalizeAddress("203.0.113.7:5000"), "203.0.113.7");
  assert.equal(normalizeAddress("fe80::1%eth0"), "fe80::1");
  assert.equal(normalizeAddress("not-an-ip"), null);
  assert.equal(normalizeAddress(undefined), null);
});

test("X-Forwarded-For is read from the right, only through trusted proxies", () => {
  const xff = "6.6.6.6, 198.51.100.4, 10.0.0.2";
  assert.equal(resolveClientAddress("10.0.0.1", xff, undefined), "10.0.0.1", "no proxies trusted: the socket peer");
  assert.equal(resolveClientAddress("10.0.0.1", xff, 1), "10.0.0.2", "one hop: what the proxy appended");
  assert.equal(resolveClientAddress("10.0.0.1", xff, 2), "198.51.100.4");
  assert.equal(resolveClientAddress("10.0.0.1", "1.1.1.1", 2), null, "fewer hops than proxies fails closed");
  assert.equal(resolveClientAddress("10.0.0.1", null, 1), null);
  assert.equal(resolveClientAddress("10.0.0.1", xff, ["10.0.0.0/8"]), "198.51.100.4", "skips every trusted hop");
  assert.equal(resolveClientAddress("203.0.113.9", xff, ["10.0.0.0/8"]), "203.0.113.9", "an untrusted peer's header is ignored");
  assert.equal(resolveClientAddress("10.0.0.1", "garbage, 10.0.0.2", ["10.0.0.0/8"]), null);
  assert.equal(resolveClientAddress("::ffff:10.0.0.1", "2001:db8::5", ["10.0.0.0/8"]), "2001:db8::5");
  assert.equal(parseTrustedProxies("2"), 2);
  assert.deepEqual(parseTrustedProxies(" 10.0.0.0/8, 192.168.1.1 "), ["10.0.0.0/8", "192.168.1.1"]);
  assert.equal(parseTrustedProxies(""), undefined);
  assert.throws(() => parseTrustedProxies("10.0.0.0/33"), /not an address or CIDR/);
  assert.throws(() => checkTrustedProxies(11), /0 to 10/);
});

test("pages, actions and api routes see the resolved address", async () => {
  const seen: (string | null | undefined)[] = [];
  const app = createApp({
    secret: "client-address-secret-0123456789abcdef",
    routes: {},
    api: { "/api/ip": { GET: (ctx) => (seen.push(ctx.clientAddress), new Response(String(ctx.clientAddress))) } },
    onError: () => {},
  } as never);
  const direct = await serveNode(app, { port: 0 });
  const proxied = await serveNode(app, { port: 0, trustedProxies: ["127.0.0.1", "::1"] });
  const hop = await serveNode(app, { port: 0, trustProxy: true });
  try {
    const xff = { "x-forwarded-for": "6.6.6.6, 198.51.100.4" };
    assert.match(await (await fetch(`${direct.url}/api/ip`, { headers: xff })).text(), /^(127\.0\.0\.1|::1)$/);
    assert.equal(await (await fetch(`${proxied.url}/api/ip`, { headers: xff })).text(), "198.51.100.4");
    assert.equal(await (await fetch(`${hop.url}/api/ip`, { headers: xff })).text(), "198.51.100.4");
    assert.equal(await (await fetch(`${hop.url}/api/ip`)).text(), "null", "a proxy that adds nothing fails closed");
  } finally {
    await direct.close();
    await proxied.close();
    await hop.close();
  }
  assert.equal(clientAddress(new Request("http://x/")), null);
  assert.equal(seen.length, 4);
});
