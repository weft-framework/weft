import { test } from "node:test";
import assert from "node:assert/strict";
import { createPasskey, getPasskey, passkeyAutofillSupported, passkeysSupported } from "../src/passkey.ts";

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64url");

function fakeBrowser(t: { after(fn: () => void): void }) {
  const g = globalThis as Record<string, unknown>;
  const saved = { PublicKeyCredential: g.PublicKeyCredential, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  const calls: { create?: any; get?: any } = {};
  const buf = (bytes: number[]) => new Uint8Array(bytes).buffer;
  g.PublicKeyCredential = Object.assign(function PublicKeyCredential() {}, { isConditionalMediationAvailable: async () => true });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      credentials: {
        async create(o: unknown) {
          calls.create = o;
          return {
            id: b64([9, 9]),
            rawId: buf([9, 9]),
            type: "public-key",
            authenticatorAttachment: "platform",
            response: { clientDataJSON: buf([1]), attestationObject: buf([2, 255]), getTransports: () => ["internal", "hybrid"] },
          };
        },
        async get(o: unknown) {
          calls.get = o;
          return {
            id: b64([9, 9]),
            rawId: buf([9, 9]),
            type: "public-key",
            response: { clientDataJSON: buf([1]), authenticatorData: buf([3]), signature: buf([4, 250]), userHandle: buf([5]) },
          };
        },
      },
    },
  });
  t.after(() => {
    g.PublicKeyCredential = saved.PublicKeyCredential;
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
  });
  return calls;
}

test("options are decoded for the browser and credentials encoded for the server", async (t) => {
  const calls = fakeBrowser(t);
  assert.equal(passkeysSupported(), true);
  assert.equal(await passkeyAutofillSupported(), true);

  const made = JSON.parse(
    await createPasskey({
      challenge: b64([1, 2, 3]),
      user: { id: b64([7, 7]), name: "ada", displayName: "Ada" },
      excludeCredentials: [{ type: "public-key", id: b64([8]) }],
      rp: { id: "app.example", name: "Acme" },
    }),
  );
  const pk = calls.create.publicKey;
  assert.deepEqual([...pk.challenge], [1, 2, 3]);
  assert.deepEqual([...pk.user.id], [7, 7]);
  assert.deepEqual([...pk.excludeCredentials[0].id], [8]);
  assert.deepEqual(made, {
    id: b64([9, 9]),
    rawId: b64([9, 9]),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: { clientDataJSON: b64([1]), attestationObject: b64([2, 255]), transports: ["internal", "hybrid"] },
  });

  const used = JSON.parse(await getPasskey({ challenge: b64([4]), rpId: "app.example", allowCredentials: [] }, { autofill: true }));
  assert.equal(calls.get.mediation, "conditional");
  assert.deepEqual([...calls.get.publicKey.challenge], [4]);
  assert.deepEqual(used.response, { clientDataJSON: b64([1]), authenticatorData: b64([3]), signature: b64([4, 250]), userHandle: b64([5]) });
});

test("without WebAuthn the helpers say so", async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = g.PublicKeyCredential;
  delete g.PublicKeyCredential;
  try {
    assert.equal(passkeysSupported(), false);
    assert.equal(await passkeyAutofillSupported(), false);
    await assert.rejects(getPasskey({ challenge: "" }), /does not support passkeys/);
  } finally {
    g.PublicKeyCredential = saved;
  }
});
