import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { X509Certificate, constants, createCipheriv, publicEncrypt, randomBytes, sign as rsaSign, verify as rsaVerify } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";
import { defineComponent, escapeHtml } from "@weft/runtime";
import { createApp, type App } from "../src/app.ts";
import type { Identity } from "../src/oauth.ts";
import { checkSamlConnection, defineSaml, parseIdpMetadata, type CheckedSamlConnection, type SamlConnection } from "../src/saml.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(join(here, "fixtures", n), "utf8");
const IDP_KEY = fixture("saml-idp.key");
const IDP_CERT = fixture("saml-idp.crt");
const OTHER_KEY = fixture("saml-other.key");
const OTHER_CERT = fixture("saml-other.crt");
const SP_KEY = fixture("saml-sp.key");
const SP_CERT = fixture("saml-sp.crt");
const SP_OLD_KEY = fixture("saml-sp-old.key");
const SP_OLD_CERT = fixture("saml-sp-old.crt");
const XENC = "http://www.w3.org/2001/04/xmlenc#";
const XENC11 = "http://www.w3.org/2009/xmlenc11#";
const SLO_IDP = "https://idp.example/slo/acme";
const SLO = `${"http://app.test"}/_weft/auth/saml/acme/slo`;

const SECRET = "test-secret-test-secret-test-secret!";
const ORIGIN = "http://app.test";
const IDP = "https://idp.example/acme";
const SSO = "https://idp.example/sso/acme";
const ACS = `${ORIGIN}/_weft/auth/saml/acme/acs`;
const SP = `${ORIGIN}/_weft/auth/saml/acme`;
const P = "urn:oasis:names:tc:SAML:2.0:protocol";
const A = "urn:oasis:names:tc:SAML:2.0:assertion";
const EXC = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

const connection: SamlConnection = {
  id: "acme",
  tenant: "t-acme",
  idpEntityId: IDP,
  ssoUrl: SSO,
  certificates: [IDP_CERT],
  emailDomains: ["acme.example"],
};

const iso = (ms: number) => new Date(ms).toISOString();

interface Make {
  inResponseTo: string;
  recipient?: string;
  audience?: string;
  issuer?: string;
  nameId?: string;
  nameIdFormat?: string;
  email?: string;
  issued?: number;
  until?: number;
  status?: string;
  subStatus?: string;
  sign?: "assertion" | "response" | "both" | "none";
  encrypt?: Encrypt;
  bareNs?: boolean;
  key?: string;
  keyInfoCert?: string;
  sigAlg?: string;
  digest?: string;
}

let n = 0;
function makeResponse(m: Make, after?: (xml: string) => string): string {
  const now = m.issued ?? Date.now();
  const until = m.until ?? now + 5 * 60_000;
  const id = `_a${++n}${"0".repeat(8)}`;
  const status = m.status ?? "urn:oasis:names:tc:SAML:2.0:status:Success";
  const assertion =
    `<saml:Assertion${m.bareNs ? "" : ` xmlns:saml="${A}"`} ID="${id}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${m.issuer ?? IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${m.nameIdFormat ?? "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"}">${m.nameId ?? "00u-ada"}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData InResponseTo="${m.inResponseTo}" Recipient="${m.recipient ?? ACS}" NotOnOrAfter="${iso(until)}"/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(now - 1000)}" NotOnOrAfter="${iso(until)}">` +
    `<saml:AudienceRestriction><saml:Audience>${m.audience ?? SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="s-1"><saml:AuthnContext>` +
    `<saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>` +
    `</saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="email"><saml:AttributeValue>${m.email ?? "Ada@ACME.example"}</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="displayName"><saml:AttributeValue>Ada Lovelace</saml:AttributeValue></saml:Attribute>` +
    `</saml:AttributeStatement></saml:Assertion>`;
  let xml =
    `<samlp:Response xmlns:samlp="${P}" xmlns:saml="${A}" ID="_r${n}" Version="2.0" IssueInstant="${iso(now)}" ` +
    `Destination="${m.recipient ?? ACS}" InResponseTo="${m.inResponseTo}">` +
    `<saml:Issuer>${m.issuer ?? IDP}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${status}">${m.subStatus ? `<samlp:StatusCode Value="${m.subStatus}"/>` : ""}</samlp:StatusCode></samlp:Status>` +
    (status.endsWith(":Success") ? assertion : "") +
    `</samlp:Response>`;
  const sign = m.sign ?? "assertion";
  const ok = status.endsWith(":Success");
  if (ok && (sign === "assertion" || sign === "both")) xml = signXml(xml, "Assertion", m);
  if (ok && m.encrypt) {
    const start = xml.indexOf("<saml:Assertion");
    const end = xml.indexOf("</saml:Assertion>") + "</saml:Assertion>".length;
    xml = xml.slice(0, start) + encrypted(xml.slice(start, end), m.encrypt) + xml.slice(end);
  }
  if (ok && (sign === "response" || sign === "both")) xml = signXml(xml, "Response", m);
  if (after) xml = after(xml);
  return Buffer.from(xml, "utf8").toString("base64");
}

interface Encrypt {
  cert?: string;
  mode?: "gcm" | "cbc";
  transport?: "mgf1p" | "oaep-sha256" | "rsa15";
  sibling?: boolean;
}

function encrypted(plain: string, e: Encrypt): string {
  const cek = randomBytes(32);
  let bytes: Buffer;
  if ((e.mode ?? "gcm") === "gcm") {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", cek, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    bytes = Buffer.concat([iv, ct, c.getAuthTag()]);
  } else {
    const iv = randomBytes(16);
    const c = createCipheriv("aes-256-cbc", cek, iv);
    bytes = Buffer.concat([iv, c.update(plain, "utf8"), c.final()]);
  }
  const pub = new X509Certificate(e.cert ?? SP_CERT).publicKey;
  const t = e.transport ?? "mgf1p";
  const wrapped =
    t === "rsa15"
      ? publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_PADDING }, cek)
      : publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: t === "mgf1p" ? "sha1" : "sha256" }, cek);
  const method =
    t === "mgf1p"
      ? `<xenc:EncryptionMethod Algorithm="${XENC}rsa-oaep-mgf1p"/>`
      : t === "rsa15"
        ? `<xenc:EncryptionMethod Algorithm="${XENC}rsa-1_5"/>`
        : `<xenc:EncryptionMethod Algorithm="${XENC11}rsa-oaep"><ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="${XENC}sha256"/>` +
          `<xenc11:MGF xmlns:xenc11="${XENC11}" Algorithm="${XENC11}mgf1sha256"/></xenc:EncryptionMethod>`;
  const key = `<xenc:EncryptedKey xmlns:xenc="${XENC}">${method}<xenc:CipherData><xenc:CipherValue>${wrapped.toString("base64")}</xenc:CipherValue></xenc:CipherData></xenc:EncryptedKey>`;
  const alg = (e.mode ?? "gcm") === "gcm" ? `${XENC11}aes256-gcm` : `${XENC}aes256-cbc`;
  const data =
    `<xenc:EncryptedData xmlns:xenc="${XENC}" Type="${XENC}Element"><xenc:EncryptionMethod Algorithm="${alg}"/>` +
    (e.sibling ? "" : `<ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${key}</ds:KeyInfo>`) +
    `<xenc:CipherData><xenc:CipherValue>${bytes.toString("base64")}</xenc:CipherValue></xenc:CipherData></xenc:EncryptedData>`;
  return `<saml:EncryptedAssertion>${data}${e.sibling ? key : ""}</saml:EncryptedAssertion>`;
}

function signXml(xml: string, target: string, m: { key?: string; keyInfoCert?: string; sigAlg?: string; digest?: string } = {}): string {
  {
    const s = new SignedXml({
      privateKey: m.key ?? IDP_KEY,
      ...(m.keyInfoCert ? { publicCert: m.keyInfoCert } : {}),
      signatureAlgorithm: m.sigAlg ?? "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: EXC,
    });
    s.addReference({
      xpath: `//*[local-name(.)='${target}']`,
      transforms: [ENVELOPED, EXC],
      digestAlgorithm: m.digest ?? "http://www.w3.org/2001/04/xmlenc#sha256",
    });
    s.computeSignature(xml, { location: { reference: `//*[local-name(.)='${target}']/*[local-name(.)='Issuer']`, action: "after" } });
    return s.getSignedXml();
  }
}

async function checked(c: SamlConnection = connection): Promise<CheckedSamlConnection> {
  return (await defineSaml({ connection: () => c }).resolve(c.id))!;
}

function verifier(c: SamlConnection = connection) {
  const saml = defineSaml({ connection: () => c });
  return async (b64: string) => saml.verify((await saml.resolve(c.id))!, b64, { base: ORIGIN });
}

test("a signed assertion is read: subject, address, name, tenant", async () => {
  const verify = verifier();
  const r = await verify(makeResponse({ inResponseTo: "_req1" }));
  assert.equal(r.inResponseTo, "_req1");
  assert.equal(r.identity.provider, "saml:acme");
  assert.equal(r.identity.subject, "00u-ada");
  assert.equal(r.identity.email, "Ada@acme.example");
  assert.equal(r.identity.emailVerified, true, "acme.example is the organisation's domain");
  assert.equal(r.identity.name, "Ada Lovelace");
  assert.equal(r.identity.claims.tenant, "t-acme");
  assert.equal(r.identity.claims.sessionIndex, "s-1");
  assert.equal((await verify(makeResponse({ inResponseTo: "_req2", sign: "response" }))).identity.subject, "00u-ada");
  assert.equal((await verify(makeResponse({ inResponseTo: "_r", email: "ada@gmail.example" }))).identity.emailVerified, false);
});

test("forged, altered and misdirected responses are refused", async () => {
  const verify = verifier();
  const refused = async (b64: string, why: RegExp) => assert.rejects(verify(b64), why);
  await refused(makeResponse({ inResponseTo: "_x", sign: "none" }), /not signed/);
  await refused(makeResponse({ inResponseTo: "_x", key: OTHER_KEY }), /does not verify/);
  await refused(makeResponse({ inResponseTo: "_x", key: OTHER_KEY, keyInfoCert: OTHER_CERT }), /does not verify/);
  await refused(
    makeResponse({ inResponseTo: "_x" }, (x) => x.replace("Ada@ACME.example", "boss@acme.example")),
    /does not verify/,
  );
  await refused(makeResponse({ inResponseTo: "_x", issuer: "https://evil.example" }), /another identity provider/);
  await refused(makeResponse({ inResponseTo: "_x", audience: `${ORIGIN}/_weft/auth/saml/other` }), /another service/);
  await refused(makeResponse({ inResponseTo: "_x", recipient: "https://evil.example/acs" }), /another address/);
  await refused(makeResponse({ inResponseTo: "_x", issued: Date.now() - 60 * 60_000 }), /not fresh|expired/);
  await refused(makeResponse({ inResponseTo: "_x", until: Date.now() - 5 * 60_000 }), /expired/);
  await refused(makeResponse({ inResponseTo: "_x", sigAlg: "http://www.w3.org/2000/09/xmldsig#rsa-sha1", digest: "http://www.w3.org/2000/09/xmldsig#sha1" }), /does not verify/);
  const sha1 = verifier({ ...connection, allowSha1: true });
  assert.ok(await sha1(makeResponse({ inResponseTo: "_x", sigAlg: "http://www.w3.org/2000/09/xmldsig#rsa-sha1", digest: "http://www.w3.org/2000/09/xmldsig#sha1" })));
  await refused(makeResponse({ inResponseTo: "_x", nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient" }), /transient/);
  const responder = "urn:oasis:names:tc:SAML:2.0:status:Responder";
  await assert.rejects(
    verify(makeResponse({ inResponseTo: "_x", status: responder, subStatus: "urn:oasis:names:tc:SAML:2.0:status:AuthnFailed" })),
    (e: Error & { code?: string }) => e.code === "denied",
  );
  await assert.rejects(verify(makeResponse({ inResponseTo: "_x", status: responder })), (e: Error & { code?: string }) => e.code === "failed");
  await refused(Buffer.from(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>`).toString("base64"), /document type/);
  await refused("not base64 !", /base64/);
});

test("signature wrapping: a second assertion is refused, comments do not cut values", async () => {
  const verify = verifier();
  const evil =
    `<saml:Assertion xmlns:saml="${A}" ID="_evil" Version="2.0" IssueInstant="${iso(Date.now())}"><saml:Issuer>${IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID>admin</saml:NameID></saml:Subject></saml:Assertion>`;
  await assert.rejects(verify(makeResponse({ inResponseTo: "_w" }, (x) => x.replace("<saml:Assertion ", `${evil}<saml:Assertion `))), /exactly one assertion/);
  await assert.rejects(
    verify(
      makeResponse({ inResponseTo: "_w" }, (x) => {
        const start = x.indexOf("<saml:Assertion ");
        const end = x.indexOf("</saml:Assertion>") + "</saml:Assertion>".length;
        return x.slice(0, start) + `<samlp:Extensions>${x.slice(start, end)}</samlp:Extensions>` + evil + x.slice(end);
      }),
    ),
    /exactly one assertion/,
  );
  const r = await verify(
    makeResponse({ inResponseTo: "_w", nameId: "ada@acme.example.evil.example" }, (x) => x.replace("ada@acme.example.evil", "ada@acme.example<!---->.evil")),
  );
  assert.equal(r.identity.subject, "ada@acme.example.evil.example");
});

function browser(app: App) {
  const jar = new Map<string, { value: string; path: string }>();
  const cookieFor = (path: string) =>
    [...jar].filter(([, c]) => path.startsWith(c.path)).map(([k, c]) => `${k}=${c.value}`).join("; ");
  return {
    async get(url: string) {
      const u = new URL(url, ORIGIN);
      const cookie = cookieFor(u.pathname);
      const res = (await app.fetch(new Request(u.href, { headers: cookie ? { cookie } : {} })))!;
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split("; ");
        const eq = pair!.indexOf("=");
        const name = pair!.slice(0, eq);
        const value = pair!.slice(eq + 1);
        const path = attrs.find((a) => a.startsWith("Path="))?.slice(5) ?? "/";
        if (attrs.includes("Max-Age=0") || value === "") jar.delete(name);
        else jar.set(name, { value, path });
      }
      return res;
    },
    async who() {
      const html = await (await this.get("/")).text();
      return /<p id="who">([^<]*)<\/p>/.exec(html)?.[1];
    },
  };
}

function idpPost(app: App, b64: string) {
  return app.fetch(
    new Request(ACS, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://idp.example", "sec-fetch-site": "cross-site" },
      body: new URLSearchParams({ SAMLResponse: b64, RelayState: "" }).toString(),
    }),
  ) as Promise<Response>;
}

function samlApp() {
  const seen: Identity[] = [];
  const Who = defineComponent("SamlWho", (props: { who: string }) => ({ render: () => `<p id="who">${escapeHtml(props.who)}</p>` }));
  const app = createApp({
    secret: SECRET,
    routes: { "/": { component: Who as never, load: (ctx) => ({ who: (ctx.user as { id: string } | null)?.id ?? "nobody" }) } },
    onError: () => {},
    auth: {
      saml: defineSaml({ connection: (id) => (id === "acme" ? connection : null) }),
      signIn: (i) => {
        seen.push(i);
        return `u:${i.provider}:${i.subject}`;
      },
      signInError: "/signin",
    },
  });
  return { app, seen };
}

async function start(b: ReturnType<typeof browser>, next = "/after") {
  const res = await b.get(`/_weft/auth/saml/acme?next=${encodeURIComponent(next)}`);
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("location")!);
  assert.equal(`${to.origin}${to.pathname}`, SSO);
  const req = inflateRawSync(Buffer.from(to.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
  assert.ok(req.includes(`AssertionConsumerServiceURL="${ACS}"`));
  assert.ok(req.includes(`<saml:Issuer>${SP}</saml:Issuer>`));
  return /ID="([^"]+)"/.exec(req)![1]!;
}

test("the sign-in flow: started here, posted by the IdP, finished in the same browser", async () => {
  const { app, seen } = samlApp();
  const b = browser(app);
  const id = await start(b);
  const b64 = makeResponse({ inResponseTo: id });
  const acs = await idpPost(app, b64);
  assert.equal(acs.status, 303);
  const finish = acs.headers.get("location")!;
  assert.match(finish, /^\/_weft\/auth\/saml\/acme\/finish\?r=/);
  assert.ok(!finish.includes("acme.example") && !finish.includes("Ada"), "the result is encrypted in the link");
  const done = await b.get(finish);
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("location"), "/after");
  assert.equal(await b.who(), "u:saml:acme:00u-ada");
  assert.equal(seen[0]!.emailVerified, true);

  const again = await idpPost(app, b64);
  assert.match(again.headers.get("location")!, /\/signin\?error=failed/);
  assert.match((await b.get(finish)).headers.get("location")!, /error=failed/);

  const victim = browser(app);
  await start(victim);
  const attacker = browser(app);
  const theirs = await start(attacker);
  const link = (await idpPost(app, makeResponse({ inResponseTo: theirs }))).headers.get("location")!;
  assert.match((await victim.get(link)).headers.get("location")!, /error=failed/);
  assert.equal(await victim.who(), "nobody");
  const unsolicited = (await idpPost(app, makeResponse({ inResponseTo: "_never-asked" }))).headers.get("location")!;
  const fresh = browser(app);
  await start(fresh);
  assert.match((await fresh.get(unsolicited)).headers.get("location")!, /error=failed/);
});

test("metadata, unknown connections, and configuration", async () => {
  const { app } = samlApp();
  const meta = await (await app.fetch(new Request(`${ORIGIN}/_weft/auth/saml/acme/metadata`)))!.text();
  assert.ok(meta.includes(`entityID="${SP}"`));
  assert.ok(meta.includes(`Location="${ACS}"`));
  assert.equal((await app.fetch(new Request(`${ORIGIN}/_weft/auth/saml/nobody`)))!.status, 404);
  assert.equal((await app.fetch(new Request(`${ORIGIN}/_weft/auth/saml/acme/acs`)))!.status, 405);
  assert.equal((await app.fetch(new Request(`${ORIGIN}/_weft/auth/saml/acme`, { headers: { "sec-fetch-site": "cross-site" } })))!.status, 403);

  assert.throws(() => createApp({ secret: SECRET, routes: {}, auth: { saml: defineSaml({ connection: () => null }) } }), /auth\.signIn/);
  await assert.rejects(checked({ ...connection, certificates: ["not a cert"] }), /PEM or base64/);
  await assert.rejects(checked({ ...connection, ssoUrl: "http://idp.example/sso" }), /https/);
  assert.throws(() => checkSamlConnection({ ...connection, id: "Bad Id" }), /connection id/);

  const body = IDP_CERT.replace(/-----[^-]+-----|\s/g, "");
  const parsed = parseIdpMetadata(
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP}">` +
      `<md:IDPSSODescriptor protocolSupportEnumeration="${P}"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data>` +
      `<ds:X509Certificate>${body}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
      `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/post"/>` +
      `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${SSO}"/>` +
      `</md:IDPSSODescriptor></md:EntityDescriptor>`,
  );
  assert.equal(parsed.entityId, IDP);
  assert.equal(parsed.ssoUrl, SSO);
  assert.equal(parsed.certificates.length, 1);
  assert.throws(() => parseIdpMetadata(`<!DOCTYPE x><x/>`), /document type/);
});

const spKeys = { keys: [{ privateKey: SP_KEY, certificate: SP_CERT }] };

function keyed(c: SamlConnection = connection, extra: Partial<Parameters<typeof defineSaml>[0]> = {}) {
  const saml = defineSaml({ connection: () => c, sp: spKeys, ...extra });
  return async (b64: string) => saml.verify((await saml.resolve(c.id))!, b64, { base: ORIGIN });
}

test("encrypted assertions: GCM, CBC only under a signed response, RSA-OAEP only", async () => {
  const verify = keyed();
  assert.equal((await verify(makeResponse({ inResponseTo: "_e1", encrypt: {} }))).identity.subject, "00u-ada");
  const r = await verify(makeResponse({ inResponseTo: "_e2", bareNs: true, encrypt: { sibling: true, transport: "oaep-sha256" } }));
  assert.equal(r.identity.email, "Ada@acme.example");
  await assert.rejects(verify(makeResponse({ inResponseTo: "_e3", encrypt: { mode: "cbc" } })), /AES-CBC is accepted only/);
  assert.ok(await verify(makeResponse({ inResponseTo: "_e4", sign: "response", encrypt: { mode: "cbc" } })));
  assert.ok(await verify(makeResponse({ inResponseTo: "_e5", sign: "both", encrypt: { mode: "cbc" } })));
  const flip = (x: string) => x.replace(/(<xenc:CipherValue>)([A-Za-z])/g, (_m, a: string, ch: string) => a + (ch === "A" ? "B" : "A"));
  await assert.rejects(verify(makeResponse({ inResponseTo: "_e6", sign: "response", encrypt: { mode: "cbc" } }, flip)), /does not verify/);
  await assert.rejects(verify(makeResponse({ inResponseTo: "_e7", encrypt: { transport: "rsa15" } })), /cannot be decrypted/);
  await assert.rejects(verify(makeResponse({ inResponseTo: "_e8", encrypt: { cert: SP_OLD_CERT } })), /cannot be decrypted/);
  const rotating = keyed(connection, { sp: { keys: [...spKeys.keys, { privateKey: SP_OLD_KEY, certificate: SP_OLD_CERT }] } });
  assert.ok(await rotating(makeResponse({ inResponseTo: "_e9", encrypt: { cert: SP_OLD_CERT } })));
  await assert.rejects(verifier()(makeResponse({ inResponseTo: "_e10", encrypt: {} })), /no sp keys/);
  await assert.rejects(verify(makeResponse({ inResponseTo: "_e11", sign: "none", encrypt: {} })), /not signed/);
  assert.throws(() => defineSaml({ connection: () => null, sp: { keys: [{ privateKey: SP_KEY, certificate: SP_OLD_CERT }] } }), /does not match/);
});

test("certificates are used only while valid, and their dates are shown", async () => {
  const later = Date.UTC(2200, 0, 1);
  const verifyLater = keyed(connection, { now: () => later });
  await assert.rejects(verifyLater(makeResponse({ inResponseTo: "_c1", issued: later })), /expired or are not valid yet/);
  const lenient = keyed({ ...connection, ignoreCertificateExpiry: true }, { now: () => later });
  assert.ok(await lenient(makeResponse({ inResponseTo: "_c2", issued: later })));
  const earlier = Date.UTC(2000, 0, 1);
  await assert.rejects(keyed(connection, { now: () => earlier })(makeResponse({ inResponseTo: "_c3", issued: earlier })), /not valid yet/);
  const info = defineSaml({ connection: () => connection, sp: spKeys }).describeCertificates(connection);
  assert.deepEqual(info.map((i) => i.use), ["idp-signing", "sp"]);
  assert.ok(info.every((i) => i.valid && i.daysLeft > 365));
  assert.match(info[0]!.subject, /weft-test-idp/);
});

function client(app: App) {
  const jar = new Map<string, { value: string; path: string }>();
  const cookieFor = (path: string) =>
    [...jar].filter(([, c]) => path.startsWith(c.path)).map(([k, c]) => `${k}=${c.value}`).join("; ");
  const send = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url, ORIGIN);
    const cookie = cookieFor(u.pathname);
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    const res = (await app.fetch(new Request(u.href, { ...init, headers })))!;
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split("; ");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      const path = attrs.find((a) => a.startsWith("Path="))?.slice(5) ?? "/";
      if (attrs.includes("Max-Age=0") || value === "") jar.delete(name);
      else jar.set(name, { value, path });
    }
    return res;
  };
  return {
    get: (url: string) => send(url),
    post: (url: string, body: Record<string, string>) =>
      send(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams(body).toString(),
      }),
    async who() {
      const html = await (await send("/")).text();
      return /<p id="who">([^<]*)<\/p>/.exec(html)?.[1];
    },
  };
}

function sloApp(o: { userFor?: boolean } = {}) {
  const Who = defineComponent("SamlWho2", (props: { who: string }) => ({ render: () => `<p id="who">${escapeHtml(props.who)}</p>` }));
  const conn = { ...connection, sloUrl: SLO_IDP };
  return createApp({
    secret: SECRET,
    routes: { "/": { component: Who as never, load: (ctx) => ({ who: (ctx.user as { id: string } | null)?.id ?? "nobody" }) } },
    onError: () => {},
    auth: {
      saml: defineSaml({
        connection: (id) => (id === "acme" ? conn : null),
        sp: spKeys,
        ...(o.userFor ? { userFor: ({ connection: c, nameId }) => `u:saml:${c}:${nameId}` } : {}),
      }),
      signIn: (i) => `u:${i.provider}:${i.subject}`,
      signInError: "/signin",
    },
  });
}

async function signInVia(app: App, c: ReturnType<typeof client>) {
  const start = await c.get("/_weft/auth/saml/acme?next=/");
  const req = inflateRawSync(Buffer.from(new URL(start.headers.get("location")!).searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
  const id = /ID="([^"]+)"/.exec(req)![1]!;
  const link = (await idpPost(app, makeResponse({ inResponseTo: id, encrypt: {} }))).headers.get("location")!;
  await c.get(link);
  assert.equal(await c.who(), "u:saml:acme:00u-ada");
}

function idpRedirect(param: "SAMLRequest" | "SAMLResponse", xml: string, key: string | null = IDP_KEY): string {
  let q = `${param}=${encodeURIComponent(deflateRawSync(Buffer.from(xml)).toString("base64"))}`;
  if (key) {
    q += `&SigAlg=${encodeURIComponent("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256")}`;
    q += `&Signature=${encodeURIComponent(rsaSign("sha256", Buffer.from(q), key).toString("base64"))}`;
  }
  return `/_weft/auth/saml/acme/slo?${q}`;
}

function appRedirect(location: string, target: string, param: string): string {
  assert.ok(location.startsWith(`${target}?`), location);
  const q = location.slice(target.length + 1);
  const at = q.indexOf("&Signature=");
  const sig = Buffer.from(decodeURIComponent(q.slice(at + "&Signature=".length)), "base64");
  assert.ok(rsaVerify("sha256", Buffer.from(q.slice(0, at)), SP_CERT, sig), "signed by the app's key");
  return inflateRawSync(Buffer.from(new URL(location).searchParams.get(param)!, "base64")).toString("utf8");
}

const logoutRequest = (id: string, o: { sessionIndex?: string } = {}) =>
  `<samlp:LogoutRequest xmlns:samlp="${P}" xmlns:saml="${A}" ID="${id}" Version="2.0" IssueInstant="${iso(Date.now())}" Destination="${SLO}">` +
  `<saml:Issuer>${IDP}</saml:Issuer><saml:NameID>00u-ada</saml:NameID>` +
  (o.sessionIndex ? `<samlp:SessionIndex>${o.sessionIndex}</samlp:SessionIndex>` : "") +
  `</samlp:LogoutRequest>`;

const logoutResponse = (id: string, inResponseTo: string) =>
  `<samlp:LogoutResponse xmlns:samlp="${P}" xmlns:saml="${A}" ID="${id}" Version="2.0" IssueInstant="${iso(Date.now())}" ` +
  `Destination="${SLO}" InResponseTo="${inResponseTo}"><saml:Issuer>${IDP}</saml:Issuer>` +
  `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status></samlp:LogoutResponse>`;

test("signed sign-in requests and metadata with the app's keys", async () => {
  const app = sloApp();
  const c = client(app);
  const start = await c.get("/_weft/auth/saml/acme?next=/");
  const xml = appRedirect(start.headers.get("location")!, SSO, "SAMLRequest");
  assert.match(xml, /<samlp:AuthnRequest /);
  const meta = await (await app.fetch(new Request(`${ORIGIN}/_weft/auth/saml/acme/metadata`)))!.text();
  assert.match(meta, /AuthnRequestsSigned="true"/);
  assert.match(meta, /<md:KeyDescriptor use="signing">/);
  assert.match(meta, /<md:KeyDescriptor use="encryption">.*aes256-gcm/);
  assert.ok(meta.includes(`<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${SLO}"/>`));
});

test("single logout started by the app: out here, then at the IdP, then back", async () => {
  const app = sloApp();
  const c = client(app);
  await signInVia(app, c);
  const out = await c.post("/_weft/auth/saml/logout", { next: "/bye" });
  assert.equal(out.status, 303);
  const xml = appRedirect(out.headers.get("location")!, SLO_IDP, "SAMLRequest");
  assert.match(xml, /<saml:NameID Format="[^"]+">00u-ada<\/saml:NameID>/);
  assert.match(xml, /<samlp:SessionIndex>s-1<\/samlp:SessionIndex>/);
  assert.equal(await c.who(), "nobody", "signed out here at once");
  const id = /ID="([^"]+)"/.exec(xml)![1]!;
  assert.equal((await c.get(idpRedirect("SAMLResponse", logoutResponse("_lr1", id), OTHER_KEY))).headers.get("location"), "/");

  await signInVia(app, c);
  const out2 = await c.post("/_weft/auth/saml/logout", { next: "/bye" });
  const id2 = /ID="([^"]+)"/.exec(appRedirect(out2.headers.get("location")!, SLO_IDP, "SAMLRequest"))![1]!;
  assert.equal((await c.get(idpRedirect("SAMLResponse", logoutResponse("_lr2", id2)))).headers.get("location"), "/bye");
  const cross = await app.fetch(
    new Request(`${ORIGIN}/_weft/auth/saml/logout`, { method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }),
  );
  assert.equal(cross!.status, 403);
});

test("single logout started by the IdP: signed, fresh, once; every device with userFor", async () => {
  const app = sloApp();
  const c = client(app);
  await signInVia(app, c);
  assert.equal((await c.get(idpRedirect("SAMLRequest", logoutRequest("_q0"), null))).status, 400);
  assert.equal((await c.get(idpRedirect("SAMLRequest", logoutRequest("_q0"), OTHER_KEY))).status, 400);
  await c.get(idpRedirect("SAMLRequest", logoutRequest("_q1", { sessionIndex: "s-other" })));
  assert.equal(await c.who(), "u:saml:acme:00u-ada");
  const url = idpRedirect("SAMLRequest", logoutRequest("_q2", { sessionIndex: "s-1" }));
  const res = await c.get(url);
  assert.equal(res.status, 303);
  const xml = appRedirect(res.headers.get("location")!, SLO_IDP, "SAMLResponse");
  assert.match(xml, /InResponseTo="_q2"/);
  assert.match(xml, /status:Success/);
  assert.equal(await c.who(), "nobody");
  assert.equal((await c.get(url)).status, 400, "accepted once");

  const app2 = sloApp({ userFor: true });
  const phone = client(app2);
  const laptop = client(app2);
  await signInVia(app2, phone);
  await signInVia(app2, laptop);
  const signed = signXml(logoutRequest("_q3"), "LogoutRequest");
  const posted = await app2.fetch(
    new Request(`${ORIGIN}/_weft/auth/saml/acme/slo`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://idp.example", "sec-fetch-site": "cross-site" },
      body: new URLSearchParams({ SAMLRequest: Buffer.from(signed).toString("base64"), RelayState: "abc" }).toString(),
    }),
  );
  assert.equal(posted!.status, 303);
  assert.match(posted!.headers.get("location")!, /RelayState=abc/);
  assert.equal(await phone.who(), "nobody");
  assert.equal(await laptop.who(), "nobody");
});
