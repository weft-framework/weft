import {
  X509Certificate,
  constants,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  randomBytes,
  sign as rsaSign,
  verify as rsaVerify,
  type KeyObject,
} from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { SignInError, checkEndpoint, type Identity } from "./oauth.ts";
import { isSecret, type Secret } from "./secret.ts";

type Maybe<T> = T | Promise<T>;

export interface SamlConnection {
  id: string;
  tenant?: string | null;
  idpEntityId: string;
  ssoUrl: string;
  sloUrl?: string;
  sloResponseUrl?: string;
  certificates: string[];
  ignoreCertificateExpiry?: boolean;
  emailDomains?: string[];
  subjectAttribute?: string;
  nameIdFormat?: string;
  allowSha1?: boolean;
  signRequests?: boolean;
}

export interface SamlReplayStore {
  claim(key: string, untilMs: number): Maybe<boolean>;
}

export interface SamlSpKey {
  privateKey: Secret | string;
  certificate: string;
}

export interface SamlLogoutSubject {
  connection: string;
  tenant: string | null;
  nameId: string;
  sessionIndexes: string[];
}

export interface SamlOptions {
  connection(id: string): Maybe<SamlConnection | null | undefined>;
  sp?: { keys: SamlSpKey[] };
  userFor?(subject: SamlLogoutSubject): Maybe<string | null | undefined>;
  attributes?: { email?: string[]; name?: string[] };
  skewSeconds?: number;
  maxAgeSeconds?: number;
  replay?: SamlReplayStore;
  now?: () => number;
}

export interface SamlCert {
  readonly pem: string;
  readonly subject: string;
  readonly notBefore: number;
  readonly notAfter: number;
  readonly fingerprint256: string;
}

export interface CheckedSamlConnection
  extends Omit<SamlConnection, "certificates" | "emailDomains" | "sloUrl" | "sloResponseUrl"> {
  readonly certificates: readonly SamlCert[];
  readonly emailDomains: readonly string[];
  readonly sloUrl: string | null;
  readonly sloResponseUrl: string | null;
}

export interface SamlCertificateInfo {
  use: "idp-signing" | "sp";
  subject: string;
  fingerprint256: string;
  notBefore: Date;
  notAfter: Date;
  daysLeft: number;
  valid: boolean;
}

export interface SamlResult {
  identity: Identity;
  inResponseTo: string;
  assertionId: string;
  expires: number;
}

export interface SamlSessionRef {
  c: string;
  n: string;
  f: string | null;
  s: string | null;
  nq?: string;
  spnq?: string;
}

export type SamlLogoutMessage =
  | { kind: "request"; id: string; nameId: string; sessionIndexes: string[]; relay: string | null; expires: number }
  | { kind: "response"; inResponseTo: string | null; success: boolean };

export interface Saml {
  startPath(id: string, next?: string): string;
  logoutPath(): string;
  spEntityId(base: string, id: string): string;
  acsUrl(base: string, id: string): string;
  sloUrl(base: string, id: string): string;
  metadata(base: string, connection: CheckedSamlConnection): string;
  describeCertificates(connection: SamlConnection | CheckedSamlConnection): SamlCertificateInfo[];
  resolve(id: string): Promise<CheckedSamlConnection | null>;
  authorize(connection: CheckedSamlConnection, o: { requestId: string; base: string }): string;
  verify(connection: CheckedSamlConnection, response: string, o: { base: string }): SamlResult;
  logoutRequest(connection: CheckedSamlConnection, ref: SamlSessionRef, o: { requestId: string; base: string }): string | null;
  logoutResponse(connection: CheckedSamlConnection, o: { inResponseTo: string; base: string; relay: string | null }): string | null;
  readLogout(connection: CheckedSamlConnection, o: { search: string; form: URLSearchParams | null; base: string }): SamlLogoutMessage;
  userFor(subject: SamlLogoutSubject): Promise<string | null>;
  claim(key: string, untilMs: number): Promise<boolean>;
  newRequestId(): string;
}

const NS = {
  proto: "urn:oasis:names:tc:SAML:2.0:protocol",
  saml: "urn:oasis:names:tc:SAML:2.0:assertion",
  ds: "http://www.w3.org/2000/09/xmldsig#",
  md: "urn:oasis:names:tc:SAML:2.0:metadata",
  xenc: "http://www.w3.org/2001/04/xmlenc#",
  xenc11: "http://www.w3.org/2009/xmlenc11#",
};
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const POST_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const DENIED = new Set(["urn:oasis:names:tc:SAML:2.0:status:AuthnFailed", "urn:oasis:names:tc:SAML:2.0:status:RequestDenied"]);
const TRANSIENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";
const EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const UNSPECIFIED = "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified";

const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const RSA_SHA512 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512";
const RSA_SHA1 = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
const HASH_ALGS = ["http://www.w3.org/2001/04/xmlenc#sha256", "http://www.w3.org/2001/04/xmlenc#sha512"];
const HASH_SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1";
const C14N_ALGS = [
  "http://www.w3.org/2001/10/xml-exc-c14n#",
  "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
];
const REDIRECT_SIG: Record<string, string> = { [RSA_SHA256]: "sha256", [RSA_SHA512]: "sha512" };

const BLOCK: Record<string, [string, number, "cbc" | "gcm"]> = {
  [`${NS.xenc}aes128-cbc`]: ["aes-128-cbc", 16, "cbc"],
  [`${NS.xenc}aes192-cbc`]: ["aes-192-cbc", 24, "cbc"],
  [`${NS.xenc}aes256-cbc`]: ["aes-256-cbc", 32, "cbc"],
  [`${NS.xenc11}aes128-gcm`]: ["aes-128-gcm", 16, "gcm"],
  [`${NS.xenc11}aes192-gcm`]: ["aes-192-gcm", 24, "gcm"],
  [`${NS.xenc11}aes256-gcm`]: ["aes-256-gcm", 32, "gcm"],
};
const OAEP_DIGEST: Record<string, string> = {
  [HASH_SHA1]: "sha1",
  [`${NS.xenc}sha256`]: "sha256",
  [`${NS.xenc}sha512`]: "sha512",
};
const OAEP_MGF: Record<string, string> = {
  [`${NS.xenc11}mgf1sha1`]: "sha1",
  [`${NS.xenc11}mgf1sha256`]: "sha256",
  [`${NS.xenc11}mgf1sha512`]: "sha512",
};

const DEFAULT_EMAIL = [
  "email",
  "mail",
  "emailAddress",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
];
const DEFAULT_NAME = [
  "displayName",
  "name",
  "http://schemas.microsoft.com/identity/claims/displayname",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  "urn:oid:2.16.840.1.113730.3.1.241",
];

export const SAML_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH = "/_weft/auth/saml/";
const DAY = 86_400_000;
export const MAX_SAML_RESPONSE = 512 * 1024;
const MAX_VALUE = 2048;
const MAX_ATTRIBUTES = 100;
const MAX_VALUES = 50;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@<>"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function fail(message: string): never {
  throw new SignInError("failed", `saml: ${message}`);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function base64(raw: string, what: string): Buffer {
  const b = raw.replace(/\s+/g, "");
  if (b === "" || !B64.test(b)) fail(`${what} is not base64`);
  return Buffer.from(b, "base64");
}

function instant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseXml(xml: string, what: string): Element {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail(`${what} has a document type declaration`);
  let doc: Document | undefined;
  try {
    const parser = new DOMParser({
      errorHandler: {
        warning: () => {},
        error: (m: string) => {
          throw new Error(m);
        },
        fatalError: (m: string) => {
          throw new Error(m);
        },
      },
    });
    doc = parser.parseFromString(xml, "text/xml") as unknown as Document;
  } catch {
    fail(`${what} is not well-formed XML`);
  }
  const root = doc?.documentElement;
  if (!root) fail(`${what} is not well-formed XML`);
  return root;
}

function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as Element);
  return out;
}

const is = (el: Element, ns: string, name: string) => el.namespaceURI === ns && el.localName === name;

function kids(el: Element, ns: string, name: string): Element[] {
  return elementChildren(el).filter((c) => is(c, ns, name));
}

function kid(el: Element, ns: string, name: string): Element | null {
  const k = kids(el, ns, name);
  if (k.length > 1) fail(`more than one <${name}> in <${el.localName}>`);
  return k[0] ?? null;
}

function descendants(root: Element, ns: string, name: string): Element[] {
  const out: Element[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const el = stack.pop()!;
    if (is(el, ns, name)) out.push(el);
    stack.push(...elementChildren(el));
  }
  return out;
}

function text(el: Element, max = MAX_VALUE): string {
  let s = "";
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 3 && n.nodeType !== 4) fail(`unexpected content in <${el.localName}>`);
    s += n.nodeValue ?? "";
  }
  s = s.trim();
  if (s.length > max) fail(`<${el.localName}> is too long`);
  return s;
}

function attr(el: Element, name: string): string | null {
  return el.hasAttribute(name) ? el.getAttribute(name) : null;
}

function time(raw: string | null, what: string): number | null {
  if (raw === null) return null;
  const t = DATE.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t)) fail(`${what} is not a date`);
  return t;
}

function namespacesAt(el: Element): string {
  const seen = new Map<string, string>();
  for (let n: Node | null = el; n && n.nodeType === 1; n = n.parentNode) {
    const attrs = (n as Element).attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs.item(i)!;
      if ((a.name === "xmlns" || a.name.startsWith("xmlns:")) && !seen.has(a.name)) seen.set(a.name, a.value);
    }
  }
  return [...seen].map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join("");
}

function readCert(raw: string): SamlCert {
  if (typeof raw !== "string") throw new TypeError("saml: a certificate must be a string");
  const body = raw.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----/g, "").replace(/\s+/g, "");
  if (!B64.test(body)) throw new TypeError("saml: a certificate is not PEM or base64");
  const pem = `-----BEGIN CERTIFICATE-----\n${body.replace(/.{1,64}/g, "$&\n")}-----END CERTIFICATE-----\n`;
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw new TypeError("saml: a certificate is not PEM or base64 of an X.509 certificate");
  }
  if (cert.publicKey.asymmetricKeyType !== "rsa") throw new TypeError("saml: only RSA certificates are supported");
  return {
    pem,
    subject: cert.subject,
    notBefore: Date.parse(cert.validFrom),
    notAfter: Date.parse(cert.validTo),
    fingerprint256: cert.fingerprint256,
  };
}

interface SpKey {
  key: KeyObject;
  cert: SamlCert;
}

function readSpKey(k: SamlSpKey): SpKey {
  const pem = isSecret(k?.privateKey) ? k.privateKey.reveal() : k?.privateKey;
  if (typeof pem !== "string") throw new TypeError("defineSaml: sp.keys[].privateKey must be PEM");
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new TypeError("defineSaml: an sp private key is not a PEM private key");
  }
  if (key.asymmetricKeyType !== "rsa") throw new TypeError("defineSaml: sp keys must be RSA");
  const cert = readCert(k.certificate);
  const mine = createPublicKey(key).export({ type: "spki", format: "der" });
  const theirs = new X509Certificate(cert.pem).publicKey.export({ type: "spki", format: "der" });
  if (!mine.equals(theirs)) throw new TypeError("defineSaml: an sp certificate does not match its private key");
  return { key, cert };
}

export function checkSamlConnection(c: SamlConnection): CheckedSamlConnection {
  if (typeof c?.id !== "string" || !SAML_ID.test(c.id) || c.id === "logout") {
    throw new TypeError("saml: a connection id is 1-64 lowercase letters, digits or - (not `logout`)");
  }
  if (typeof c.idpEntityId !== "string" || c.idpEntityId === "" || c.idpEntityId.length > 1024) {
    throw new TypeError(`saml: connection ${c.id} has no idpEntityId`);
  }
  const ssoUrl = checkEndpoint(c.ssoUrl, `connection ${c.id} ssoUrl`);
  const sloUrl = c.sloUrl ? checkEndpoint(c.sloUrl, `connection ${c.id} sloUrl`) : null;
  const sloResponseUrl = c.sloResponseUrl ? checkEndpoint(c.sloResponseUrl, `connection ${c.id} sloResponseUrl`) : null;
  if (!Array.isArray(c.certificates) || c.certificates.length === 0 || c.certificates.length > 4) {
    throw new TypeError(`saml: connection ${c.id} needs 1-4 certificates`);
  }
  const domains = (c.emailDomains ?? []).map((d) => {
    if (typeof d !== "string" || !/^[a-z0-9.-]{1,253}$/i.test(d)) throw new TypeError(`saml: connection ${c.id} has a bad email domain`);
    return d.toLowerCase();
  });
  return { ...c, ssoUrl, sloUrl, sloResponseUrl, certificates: c.certificates.map(readCert), emailDomains: domains };
}

function usableCerts(c: CheckedSamlConnection, now: number): readonly SamlCert[] {
  if (c.ignoreCertificateExpiry) return c.certificates;
  const ok = c.certificates.filter((x) => x.notBefore <= now && now < x.notAfter);
  if (ok.length === 0) fail(`connection ${c.id}: its certificates have expired or are not valid yet`);
  return ok;
}

function only<T>(map: Record<string, T>, keys: string[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of keys) if (k in map) out[k] = map[k];
  return out;
}

function verifiedCopy(xml: string, sig: Element, c: CheckedSamlConnection, now: number): Element | null {
  const host = sig.parentNode as Element;
  const sigAlgs = c.allowSha1 ? [RSA_SHA256, RSA_SHA512, RSA_SHA1] : [RSA_SHA256, RSA_SHA512];
  for (const cert of usableCerts(c, now)) {
    const v = new SignedXml({ publicCert: cert.pem, getCertFromKeyInfo: () => null });
    v.SignatureAlgorithms = only(v.SignatureAlgorithms, sigAlgs) as typeof v.SignatureAlgorithms;
    v.HashAlgorithms = only(v.HashAlgorithms, c.allowSha1 ? [...HASH_ALGS, HASH_SHA1] : HASH_ALGS) as typeof v.HashAlgorithms;
    v.CanonicalizationAlgorithms = only(v.CanonicalizationAlgorithms, C14N_ALGS) as typeof v.CanonicalizationAlgorithms;
    let ok = false;
    try {
      v.loadSignature(sig as never);
      ok = v.checkSignature(xml) === true;
    } catch {
      ok = false;
    }
    if (!ok) continue;
    const refs = v.getSignedReferences();
    if (refs.length !== 1) fail("a signature must cover exactly one element");
    const copy = parseXml(refs[0]!, "the signed element");
    if (copy.namespaceURI !== host.namespaceURI || copy.localName !== host.localName || attr(copy, "ID") !== attr(host, "ID")) {
      fail("the signature covers another element");
    }
    return copy;
  }
  return null;
}

function redirectUrl(target: string, param: "SAMLRequest" | "SAMLResponse", xml: string, relay: string | null, key: KeyObject | null): string {
  let q = `${param}=${encodeURIComponent(deflateRawSync(Buffer.from(xml, "utf8")).toString("base64"))}`;
  if (relay !== null) q += `&RelayState=${encodeURIComponent(relay)}`;
  if (key) {
    q += `&SigAlg=${encodeURIComponent(RSA_SHA256)}`;
    q += `&Signature=${encodeURIComponent(rsaSign("sha256", Buffer.from(q, "utf8"), key).toString("base64"))}`;
  }
  return `${target}${target.includes("?") ? "&" : "?"}${q}`;
}

const formDecode = (v: string) => {
  try {
    return decodeURIComponent(v.replace(/\+/g, " "));
  } catch {
    return fail("a query value is not URL-encoded");
  }
};

function readRedirect(search: string, c: CheckedSamlConnection, now: number): { param: string; xml: string; relay: string | null } {
  const raw = new Map<string, string>();
  for (const part of search.replace(/^\?/, "").split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const name = eq < 0 ? part : part.slice(0, eq);
    if (raw.has(name)) fail(`${name} is given twice`);
    raw.set(name, eq < 0 ? "" : part.slice(eq + 1));
  }
  const param = raw.has("SAMLRequest") ? "SAMLRequest" : raw.has("SAMLResponse") ? "SAMLResponse" : null;
  if (param === null || (raw.has("SAMLRequest") && raw.has("SAMLResponse"))) fail("no SAML message");
  const sigAlg = raw.get("SigAlg");
  const signature = raw.get("Signature");
  if (sigAlg === undefined || signature === undefined) fail("the message is not signed");
  const hash = REDIRECT_SIG[formDecode(sigAlg)] ?? (c.allowSha1 && formDecode(sigAlg) === RSA_SHA1 ? "sha1" : undefined);
  if (!hash) fail("the message's signature algorithm is not accepted");
  let signed = `${param}=${raw.get(param)}`;
  if (raw.has("RelayState")) signed += `&RelayState=${raw.get("RelayState")}`;
  signed += `&SigAlg=${sigAlg}`;
  const sig = base64(formDecode(signature), "the signature");
  if (!usableCerts(c, now).some((cert) => rsaVerify(hash, Buffer.from(signed, "utf8"), cert.pem, sig))) {
    fail("the message's signature does not verify");
  }
  const packed = base64(formDecode(raw.get(param)!), "the message");
  let xml: string;
  try {
    xml = utf8.decode(inflateRawSync(packed, { maxOutputLength: 1 << 20 }));
  } catch {
    fail("the message cannot be inflated");
  }
  return { param, xml, relay: raw.has("RelayState") ? formDecode(raw.get("RelayState")!) : null };
}

function decrypt(holder: Element, keys: readonly SpKey[], cbcAllowed: boolean): string {
  const unable = () => fail("the encrypted part cannot be decrypted");
  if (keys.length === 0) fail("the IdP encrypts, and the app has no sp keys");
  const data = kids(holder, NS.xenc, "EncryptedData");
  if (data.length !== 1) fail("expected one EncryptedData");
  const d = data[0]!;
  const type = attr(d, "Type");
  if (type !== null && type !== `${NS.xenc}Element`) fail("only encrypted elements are supported");
  const method = kid(d, NS.xenc, "EncryptionMethod");
  const block = method ? BLOCK[attr(method, "Algorithm") ?? ""] : undefined;
  if (!block) fail("the content encryption algorithm is not accepted");
  const [cipherName, keyLength, mode] = block;
  if (mode === "cbc" && !cbcAllowed) {
    fail("AES-CBC is accepted only when the whole response is signed; have the IdP sign the response or use AES-GCM");
  }
  const keyInfo = kid(d, NS.ds, "KeyInfo");
  const wrapped = [...(keyInfo ? kids(keyInfo, NS.xenc, "EncryptedKey") : []), ...kids(holder, NS.xenc, "EncryptedKey")];
  if (wrapped.length === 0 || wrapped.length > 8) fail("expected an EncryptedKey");
  let cek: Buffer | null = null;
  outer: for (const ek of wrapped) {
    const m = kid(ek, NS.xenc, "EncryptionMethod");
    const alg = m ? attr(m, "Algorithm") : null;
    const dm = m ? kid(m, NS.ds, "DigestMethod") : null;
    const digest = OAEP_DIGEST[(dm && attr(dm, "Algorithm")) ?? HASH_SHA1];
    let mgf: string | undefined;
    if (alg === `${NS.xenc}rsa-oaep-mgf1p`) mgf = "sha1";
    else if (alg === `${NS.xenc11}rsa-oaep`) {
      const g = kid(m!, NS.xenc11, "MGF");
      mgf = OAEP_MGF[(g && attr(g, "Algorithm")) ?? `${NS.xenc11}mgf1sha1`];
    } else continue;
    if (!digest || digest !== mgf || kid(m!, NS.xenc, "OAEPparams")) continue;
    const cd = kid(ek, NS.xenc, "CipherData");
    const cv = cd ? kid(cd, NS.xenc, "CipherValue") : null;
    if (!cv) continue;
    const enc = base64(text(cv, 8192), "an encrypted key");
    for (const k of keys) {
      try {
        const out = privateDecrypt({ key: k.key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: digest }, enc);
        if (out.length === keyLength) {
          cek = out;
          break outer;
        }
      } catch {
      }
    }
  }
  if (!cek) return unable();
  const cd = kid(d, NS.xenc, "CipherData");
  const cv = cd ? kid(cd, NS.xenc, "CipherValue") : null;
  if (!cv) fail("the encrypted part has no cipher value");
  const bytes = base64(text(cv, 4 * MAX_SAML_RESPONSE), "the encrypted part");
  let plain: Buffer;
  try {
    if (mode === "gcm") {
      if (bytes.length < 12 + 16) unable();
      const dec = createDecipheriv(cipherName, cek, bytes.subarray(0, 12)) as ReturnType<typeof createDecipheriv> & { setAuthTag(t: Buffer): void };
      dec.setAuthTag(bytes.subarray(bytes.length - 16));
      plain = Buffer.concat([dec.update(bytes.subarray(12, bytes.length - 16)), dec.final()]);
    } else {
      if (bytes.length < 32 || bytes.length % 16 !== 0) unable();
      const dec = createDecipheriv(cipherName, cek, bytes.subarray(0, 16));
      dec.setAutoPadding(false);
      const p = Buffer.concat([dec.update(bytes.subarray(16)), dec.final()]);
      const pad = p[p.length - 1]!;
      if (pad < 1 || pad > 16) unable();
      plain = p.subarray(0, p.length - pad);
    }
  } catch (err) {
    if (err instanceof SignInError) throw err;
    return unable();
  }
  let out: string;
  try {
    out = utf8.decode(plain);
  } catch {
    return unable();
  }
  return out.replace(/^\s*<\?xml[^>]*\?>/, "");
}

function decryptedElement(holder: Element, keys: readonly SpKey[], cbcAllowed: boolean): { xml: string; el: Element } {
  const plain = decrypt(holder, keys, cbcAllowed);
  const xml = `<Decrypted${namespacesAt(holder.parentNode as Element)}>${plain}</Decrypted>`;
  const box = parseXml(xml, "the decrypted part");
  const inner = elementChildren(box);
  if (inner.length !== 1) fail("the decrypted part must be one element");
  return { xml, el: inner[0]! };
}

interface VerifyOptions {
  acsUrl: string;
  spEntityId: string;
  now: number;
  skewMs: number;
  maxAgeMs: number;
  emailNames: string[];
  nameNames: string[];
  keys: readonly SpKey[];
}

function decodeResponse(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_SAML_RESPONSE) fail("no response, or too large");
  try {
    return utf8.decode(base64(raw, "the response"));
  } catch (err) {
    if (err instanceof SignInError) throw err;
    return fail("the response is not UTF-8");
  }
}

export function verifySamlResponse(c: CheckedSamlConnection, response: string, o: VerifyOptions): SamlResult {
  const xml = decodeResponse(response);
  const root = parseXml(xml, "the response");
  if (!is(root, NS.proto, "Response")) fail("not a SAML response");

  const status = kid(root, NS.proto, "Status");
  const code = status ? kid(status, NS.proto, "StatusCode") : null;
  const value = code ? attr(code, "Value") : null;
  if (value !== SUCCESS) {
    const sub = code ? kid(code, NS.proto, "StatusCode") : null;
    const why = sub ? attr(sub, "Value") : null;
    if (why !== null && DENIED.has(why)) throw new SignInError("denied", "saml: the identity provider refused the sign-in");
    fail(`the identity provider answered ${value ?? "no status"}`);
  }
  const plainAll = descendants(root, NS.saml, "Assertion");
  const encryptedAll = descendants(root, NS.saml, "EncryptedAssertion");
  if (plainAll.length + encryptedAll.length !== 1) fail("a response must hold exactly one assertion");
  const held = plainAll[0] ?? encryptedAll[0]!;
  if (held.parentNode !== root) fail("the assertion is not where a response keeps it");

  const rSig = kid(root, NS.ds, "Signature");
  const signedResponse = rSig ? verifiedCopy(xml, rSig, c, o.now) : null;
  if (rSig && !signedResponse) fail("the response's signature does not verify");

  let assertionXml = xml;
  let assertion: Element;
  if (encryptedAll.length === 1) {
    const holder = signedResponse ? kids(signedResponse, NS.saml, "EncryptedAssertion") : [held];
    if (holder.length !== 1) fail("a response must hold exactly one assertion");
    const out = decryptedElement(holder[0]!, o.keys, signedResponse !== null);
    if (!is(out.el, NS.saml, "Assertion")) fail("the encrypted part is not an assertion");
    if (descendants(out.el, NS.saml, "Assertion").length !== 1) fail("a response must hold exactly one assertion");
    assertionXml = out.xml;
    assertion = out.el;
  } else {
    assertion = held;
  }
  const aSig = kid(assertion, NS.ds, "Signature");
  let a: Element;
  if (aSig) {
    const copy = verifiedCopy(assertionXml, aSig, c, o.now);
    if (!copy) fail("the assertion's signature does not verify");
    a = copy;
  } else if (signedResponse) {
    if (encryptedAll.length === 1) {
      a = assertion;
    } else {
      const inner = kids(signedResponse, NS.saml, "Assertion");
      if (inner.length !== 1) fail("a response must hold exactly one assertion");
      a = inner[0]!;
    }
  } else {
    fail("the response is not signed");
  }
  const envelope = signedResponse ?? root;
  const issuerOf = (el: Element) => {
    const i = kid(el, NS.saml, "Issuer");
    return i ? text(i) : null;
  };
  const rIssuer = issuerOf(envelope);
  if (rIssuer !== null && rIssuer !== c.idpEntityId) fail("the response comes from another identity provider");
  const destination = attr(envelope, "Destination");
  if (destination !== null && destination !== o.acsUrl) fail("the response was sent to another address");

  if (attr(a, "Version") !== "2.0") fail("not a SAML 2.0 assertion");
  const assertionId = attr(a, "ID");
  if (!assertionId || assertionId.length > 256) fail("the assertion has no id");
  if (issuerOf(a) !== c.idpEntityId) fail("the assertion comes from another identity provider");
  const now = o.now;
  const issued = time(attr(a, "IssueInstant"), "IssueInstant");
  if (issued === null || issued > now + o.skewMs || issued < now - o.maxAgeMs - o.skewMs) fail("the assertion is not fresh");

  const conditions = kid(a, NS.saml, "Conditions");
  if (!conditions) fail("the assertion has no conditions");
  const notBefore = time(attr(conditions, "NotBefore"), "NotBefore");
  const notOnOrAfter = time(attr(conditions, "NotOnOrAfter"), "NotOnOrAfter");
  if (notBefore !== null && notBefore > now + o.skewMs) fail("the assertion is not valid yet");
  if (notOnOrAfter !== null && notOnOrAfter <= now - o.skewMs) fail("the assertion has expired");
  const restrictions = kids(conditions, NS.saml, "AudienceRestriction");
  if (restrictions.length === 0) fail("the assertion names no audience");
  for (const r of restrictions) {
    if (!kids(r, NS.saml, "Audience").some((x) => text(x) === o.spEntityId)) fail("the assertion is meant for another service");
  }

  const subject = kid(a, NS.saml, "Subject");
  if (!subject) fail("the assertion has no subject");
  let nameIdEl = kid(subject, NS.saml, "NameID");
  const encId = kid(subject, NS.saml, "EncryptedID");
  if (encId) {
    if (nameIdEl) fail("both a NameID and an EncryptedID");
    const out = decryptedElement(encId, o.keys, true);
    if (!is(out.el, NS.saml, "NameID")) fail("the EncryptedID is not a NameID");
    nameIdEl = out.el;
  }
  const nameId = nameIdEl ? text(nameIdEl) : null;
  const nameIdFormat = nameIdEl ? (attr(nameIdEl, "Format") ?? UNSPECIFIED) : null;
  let inResponseTo: string | null = null;
  let expires = 0;
  for (const sc of kids(subject, NS.saml, "SubjectConfirmation")) {
    if (attr(sc, "Method") !== BEARER) continue;
    const d = kid(sc, NS.saml, "SubjectConfirmationData");
    if (!d || attr(d, "Recipient") !== o.acsUrl) continue;
    const until = time(attr(d, "NotOnOrAfter"), "NotOnOrAfter");
    const from = time(attr(d, "NotBefore"), "NotBefore");
    const answers = attr(d, "InResponseTo");
    if (until === null || until <= now - o.skewMs || from !== null || !answers) continue;
    inResponseTo = answers;
    expires = until + o.skewMs;
    break;
  }
  if (inResponseTo === null) fail("no bearer confirmation for this service and a sign-in it started");
  const rAnswers = attr(envelope, "InResponseTo");
  if (rAnswers !== null && rAnswers !== inResponseTo) fail("the response answers another request");
  const authn = kid(a, NS.saml, "AuthnStatement");
  if (!authn) fail("the assertion does not say the person signed in");

  const attributes: Record<string, string[]> = {};
  let count = 0;
  for (const st of kids(a, NS.saml, "AttributeStatement")) {
    for (const at of kids(st, NS.saml, "Attribute")) {
      const name = attr(at, "Name");
      if (!name || name.length > 256) continue;
      if (++count > MAX_ATTRIBUTES) fail("too many attributes");
      const values = kids(at, NS.saml, "AttributeValue").map((v) => text(v));
      if (values.length > MAX_VALUES) fail("too many attribute values");
      attributes[name] = [...(attributes[name] ?? []), ...values];
    }
  }
  const first = (names: string[]) => {
    for (const n of names) {
      const v = attributes[n]?.find((x) => x !== "");
      if (v !== undefined) return v;
    }
    return null;
  };

  let subjectValue: string | null;
  if (c.subjectAttribute) {
    const v = attributes[c.subjectAttribute] ?? [];
    if (v.length !== 1) fail(`the attribute ${c.subjectAttribute} must have exactly one value`);
    subjectValue = v[0]!;
  } else {
    if (nameIdFormat === TRANSIENT) fail("a transient NameID changes every sign-in; set subjectAttribute");
    subjectValue = nameId;
  }
  if (!subjectValue) fail("the assertion has no subject value");

  let email = first(o.emailNames) ?? (nameIdFormat === EMAIL_FORMAT ? nameId : null);
  if (email !== null && (email.length > 254 || !EMAIL.test(email))) email = null;
  const domain = email ? email.slice(email.lastIndexOf("@") + 1).toLowerCase() : null;
  if (email !== null) email = `${email.slice(0, email.lastIndexOf("@"))}@${domain}`;
  const emailVerified = domain !== null && c.emailDomains.includes(domain);
  const given = first(["givenName", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname", "urn:oid:2.5.4.42"]);
  const family = first(["sn", "surname", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname", "urn:oid:2.5.4.4"]);
  const name = first(o.nameNames) ?? (given || family ? [given, family].filter(Boolean).join(" ") : null);

  const identity: Identity = {
    provider: `saml:${c.id}`,
    subject: subjectValue,
    email,
    emailVerified,
    name,
    picture: null,
    claims: {
      connection: c.id,
      tenant: c.tenant ?? null,
      issuer: c.idpEntityId,
      nameId,
      nameIdFormat,
      nameQualifier: nameIdEl ? attr(nameIdEl, "NameQualifier") : null,
      spNameQualifier: nameIdEl ? attr(nameIdEl, "SPNameQualifier") : null,
      sessionIndex: attr(authn, "SessionIndex"),
      attributes,
    },
  };
  return { identity, inResponseTo, assertionId, expires };
}

export function samlSessionRef(identity: Identity): SamlSessionRef | null {
  const k = identity.claims as Record<string, unknown>;
  if (typeof k.connection !== "string" || typeof k.nameId !== "string") return null;
  const ref: SamlSessionRef = {
    c: k.connection,
    n: k.nameId,
    f: typeof k.nameIdFormat === "string" ? k.nameIdFormat : null,
    s: typeof k.sessionIndex === "string" ? k.sessionIndex : null,
  };
  if (typeof k.nameQualifier === "string") ref.nq = k.nameQualifier;
  if (typeof k.spNameQualifier === "string") ref.spnq = k.spNameQualifier;
  return ref;
}

export interface IdpMetadata {
  entityId: string;
  ssoUrl: string;
  sloUrl: string | null;
  sloResponseUrl: string | null;
  certificates: string[];
}

export function parseIdpMetadata(xml: string, o: { entityId?: string } = {}): IdpMetadata {
  if (typeof xml !== "string" || xml.length > 1 << 20) throw new TypeError("saml: metadata must be a string under 1 MiB");
  let root: Element;
  try {
    root = parseXml(xml, "the metadata");
  } catch (err) {
    throw new TypeError(err instanceof Error ? err.message : String(err));
  }
  const entities = is(root, NS.md, "EntityDescriptor") ? [root] : descendants(root, NS.md, "EntityDescriptor");
  const idps = entities.filter((e) => kids(e, NS.md, "IDPSSODescriptor").length > 0 && (!o.entityId || attr(e, "entityID") === o.entityId));
  if (idps.length !== 1) throw new TypeError(idps.length === 0 ? "saml: no identity provider in the metadata" : "saml: several identity providers; pass entityId");
  const e = idps[0]!;
  const entityId = attr(e, "entityID");
  if (!entityId) throw new TypeError("saml: the metadata has no entityID");
  const idp = kids(e, NS.md, "IDPSSODescriptor")[0]!;
  const redirect = (name: string) => kids(idp, NS.md, name).find((s) => attr(s, "Binding") === REDIRECT_BINDING) ?? null;
  const sso = redirect("SingleSignOnService");
  const ssoUrl = sso ? attr(sso, "Location") : null;
  if (!ssoUrl) throw new TypeError("saml: the identity provider offers no HTTP-Redirect sign-on");
  const slo = redirect("SingleLogoutService");
  const certificates: string[] = [];
  for (const kd of kids(idp, NS.md, "KeyDescriptor")) {
    const use = attr(kd, "use");
    if (use !== null && use !== "signing") continue;
    for (const c of descendants(kd, NS.ds, "X509Certificate")) certificates.push(readCert(c.textContent ?? "").pem);
  }
  if (certificates.length === 0) throw new TypeError("saml: the metadata has no signing certificate");
  const sloLocation = slo ? attr(slo, "Location") : null;
  const sloResponse = slo ? attr(slo, "ResponseLocation") : null;
  return {
    entityId,
    ssoUrl: checkEndpoint(ssoUrl, "the metadata's sign-on URL"),
    sloUrl: sloLocation ? checkEndpoint(sloLocation, "the metadata's logout URL") : null,
    sloResponseUrl: sloResponse ? checkEndpoint(sloResponse, "the metadata's logout response URL") : null,
    certificates,
  };
}

export function defineSaml(o: SamlOptions): Saml {
  if (typeof o?.connection !== "function") throw new TypeError("defineSaml: connection(id) is required");
  const skew = o.skewSeconds ?? 60;
  if (!Number.isFinite(skew) || skew < 0 || skew > 600) throw new TypeError("defineSaml: skewSeconds is 0-600");
  const maxAge = o.maxAgeSeconds ?? 300;
  if (!Number.isFinite(maxAge) || maxAge <= 0 || maxAge > 3600) throw new TypeError("defineSaml: maxAgeSeconds is 1-3600");
  if (o.sp !== undefined && (!Array.isArray(o.sp.keys) || o.sp.keys.length === 0 || o.sp.keys.length > 4)) {
    throw new TypeError("defineSaml: sp.keys is 1-4 key pairs, the current one first");
  }
  if (o.userFor !== undefined && typeof o.userFor !== "function") throw new TypeError("defineSaml: userFor must be a function");
  const keys: readonly SpKey[] = (o.sp?.keys ?? []).map(readSpKey);
  const current = keys[0] ?? null;
  const emailNames = o.attributes?.email ?? DEFAULT_EMAIL;
  const nameNames = o.attributes?.name ?? DEFAULT_NAME;
  const now = o.now ?? Date.now;

  const seen = new Map<string, number>();
  const memory: SamlReplayStore = {
    claim(key, until) {
      const t = now();
      if (seen.size > 10_000) for (const [k, u] of seen) if (u <= t) seen.delete(k);
      if (seen.size > 200_000) return false;
      const was = seen.get(key);
      if (was !== undefined && was > t) return false;
      seen.set(key, until);
      return true;
    },
  };
  const replay = o.replay ?? memory;
  const origin = (base: string) => new URL(base).origin;
  const signsRequests = (c: CheckedSamlConnection) => current !== null && c.signRequests !== false;
  const certInfo = (use: SamlCertificateInfo["use"], x: SamlCert, t: number): SamlCertificateInfo => ({
    use,
    subject: x.subject,
    fingerprint256: x.fingerprint256,
    notBefore: new Date(x.notBefore),
    notAfter: new Date(x.notAfter),
    daysLeft: Math.floor((x.notAfter - t) / DAY),
    valid: x.notBefore <= t && t < x.notAfter,
  });
  const keyDescriptor = (use: "signing" | "encryption", x: SamlCert) =>
    `    <md:KeyDescriptor use="${use}"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>` +
    x.pem.replace(/-----[^-]+-----|\s/g, "") +
    `</ds:X509Certificate></ds:X509Data></ds:KeyInfo>` +
    (use === "encryption"
      ? `<md:EncryptionMethod Algorithm="${NS.xenc11}aes256-gcm"/><md:EncryptionMethod Algorithm="${NS.xenc11}aes128-gcm"/>` +
        `<md:EncryptionMethod Algorithm="${NS.xenc}rsa-oaep-mgf1p"/>`
      : "") +
    `</md:KeyDescriptor>\n`;

  function checkLogoutEnvelope(el: Element, c: CheckedSamlConnection, base: string): void {
    const t = now();
    if (attr(el, "Version") !== "2.0") fail("not a SAML 2.0 message");
    const id = attr(el, "ID");
    if (!id || id.length > 256) fail("the message has no id");
    const issuer = kid(el, NS.saml, "Issuer");
    if (!issuer || text(issuer) !== c.idpEntityId) fail("the message comes from another identity provider");
    const destination = attr(el, "Destination");
    if (destination !== null && destination !== saml.sloUrl(base, c.id)) fail("the message was sent to another address");
    const issued = time(attr(el, "IssueInstant"), "IssueInstant");
    if (issued === null || issued > t + skew * 1000 || issued < t - (maxAge + skew) * 1000) fail("the message is not fresh");
  }

  const saml: Saml = {
    startPath(id, next) {
      if (!SAML_ID.test(id)) throw new TypeError("saml: bad connection id");
      return `${PATH}${id}${next ? `?next=${encodeURIComponent(next)}` : ""}`;
    },
    logoutPath: () => `${PATH}logout`,
    spEntityId: (base, id) => `${origin(base)}${PATH}${id}`,
    acsUrl: (base, id) => `${origin(base)}${PATH}${id}/acs`,
    sloUrl: (base, id) => `${origin(base)}${PATH}${id}/slo`,
    metadata(base, c) {
      const slo = saml.sloUrl(base, c.id);
      return (
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<md:EntityDescriptor xmlns:md="${NS.md}" xmlns:ds="${NS.ds}" entityID="${escapeXml(saml.spEntityId(base, c.id))}">\n` +
        `  <md:SPSSODescriptor AuthnRequestsSigned="${signsRequests(c)}" WantAssertionsSigned="true" protocolSupportEnumeration="${NS.proto}">\n` +
        (current ? keyDescriptor("signing", current.cert) + keyDescriptor("encryption", current.cert) : "") +
        `    <md:SingleLogoutService Binding="${REDIRECT_BINDING}" Location="${escapeXml(slo)}"/>\n` +
        `    <md:SingleLogoutService Binding="${POST_BINDING}" Location="${escapeXml(slo)}"/>\n` +
        `    <md:NameIDFormat>${escapeXml(c.nameIdFormat ?? UNSPECIFIED)}</md:NameIDFormat>\n` +
        `    <md:AssertionConsumerService Binding="${POST_BINDING}" Location="${escapeXml(saml.acsUrl(base, c.id))}" index="0" isDefault="true"/>\n` +
        `  </md:SPSSODescriptor>\n` +
        `</md:EntityDescriptor>\n`
      );
    },
    describeCertificates(c) {
      const t = now();
      const idp = (c.certificates as readonly (string | SamlCert)[]).map((x) => (typeof x === "string" ? readCert(x) : x));
      return [...idp.map((x) => certInfo("idp-signing", x, t)), ...keys.map((k) => certInfo("sp", k.cert, t))];
    },
    async resolve(id) {
      if (!SAML_ID.test(id)) return null;
      const c = await o.connection(id);
      if (!c) return null;
      if (c.id !== id) throw new TypeError(`saml: connection(${id}) returned connection ${c.id}`);
      return checkSamlConnection(c);
    },
    authorize(c, { requestId, base }) {
      const xml =
        `<samlp:AuthnRequest xmlns:samlp="${NS.proto}" xmlns:saml="${NS.saml}" ID="${requestId}" Version="2.0" ` +
        `IssueInstant="${instant(now())}" Destination="${escapeXml(c.ssoUrl)}" ` +
        `AssertionConsumerServiceURL="${escapeXml(saml.acsUrl(base, c.id))}" ProtocolBinding="${POST_BINDING}">` +
        `<saml:Issuer>${escapeXml(saml.spEntityId(base, c.id))}</saml:Issuer>` +
        `<samlp:NameIDPolicy Format="${escapeXml(c.nameIdFormat ?? UNSPECIFIED)}" AllowCreate="true"/>` +
        `</samlp:AuthnRequest>`;
      return redirectUrl(c.ssoUrl, "SAMLRequest", xml, null, signsRequests(c) ? current!.key : null);
    },
    verify(c, response, { base }) {
      return verifySamlResponse(c, response, {
        acsUrl: saml.acsUrl(base, c.id),
        spEntityId: saml.spEntityId(base, c.id),
        now: now(),
        skewMs: skew * 1000,
        maxAgeMs: maxAge * 1000,
        emailNames,
        nameNames,
        keys,
      });
    },
    logoutRequest(c, ref, { requestId, base }) {
      if (!c.sloUrl) return null;
      const q = `${ref.nq ? ` NameQualifier="${escapeXml(ref.nq)}"` : ""}${ref.spnq ? ` SPNameQualifier="${escapeXml(ref.spnq)}"` : ""}`;
      const xml =
        `<samlp:LogoutRequest xmlns:samlp="${NS.proto}" xmlns:saml="${NS.saml}" ID="${requestId}" Version="2.0" ` +
        `IssueInstant="${instant(now())}" Destination="${escapeXml(c.sloUrl)}" NotOnOrAfter="${instant(now() + maxAge * 1000)}">` +
        `<saml:Issuer>${escapeXml(saml.spEntityId(base, c.id))}</saml:Issuer>` +
        `<saml:NameID${ref.f ? ` Format="${escapeXml(ref.f)}"` : ""}${q}>${escapeXml(ref.n)}</saml:NameID>` +
        (ref.s ? `<samlp:SessionIndex>${escapeXml(ref.s)}</samlp:SessionIndex>` : "") +
        `</samlp:LogoutRequest>`;
      return redirectUrl(c.sloUrl, "SAMLRequest", xml, null, current?.key ?? null);
    },
    logoutResponse(c, { inResponseTo, base, relay }) {
      const to = c.sloResponseUrl ?? c.sloUrl;
      if (!to) return null;
      const xml =
        `<samlp:LogoutResponse xmlns:samlp="${NS.proto}" xmlns:saml="${NS.saml}" ID="${saml.newRequestId()}" Version="2.0" ` +
        `IssueInstant="${instant(now())}" Destination="${escapeXml(to)}" InResponseTo="${escapeXml(inResponseTo)}">` +
        `<saml:Issuer>${escapeXml(saml.spEntityId(base, c.id))}</saml:Issuer>` +
        `<samlp:Status><samlp:StatusCode Value="${SUCCESS}"/></samlp:Status>` +
        `</samlp:LogoutResponse>`;
      return redirectUrl(to, "SAMLResponse", xml, relay !== null && relay.length <= 1024 ? relay : null, current?.key ?? null);
    },
    readLogout(c, { search, form, base }) {
      let el: Element;
      let relay: string | null;
      if (form) {
        const raw = form.get("SAMLRequest") ?? form.get("SAMLResponse");
        if (raw === null || raw.length > MAX_SAML_RESPONSE) fail("no SAML message");
        const xml = utf8.decode(base64(raw, "the message"));
        const root = parseXml(xml, "the message");
        const sig = kid(root, NS.ds, "Signature");
        if (!sig) fail("the message is not signed");
        const copy = verifiedCopy(xml, sig, c, now());
        if (!copy) fail("the message's signature does not verify");
        el = copy;
        relay = form.get("RelayState");
      } else {
        const r = readRedirect(search, c, now());
        el = parseXml(r.xml, "the message");
        relay = r.relay;
      }
      checkLogoutEnvelope(el, c, base);
      if (is(el, NS.proto, "LogoutRequest")) {
        const t = now();
        const until = time(attr(el, "NotOnOrAfter"), "NotOnOrAfter");
        if (until !== null && until <= t - skew * 1000) fail("the logout request has expired");
        let nameIdEl = kid(el, NS.saml, "NameID");
        const encId = kid(el, NS.saml, "EncryptedID");
        if (encId) {
          if (nameIdEl) fail("both a NameID and an EncryptedID");
          const out = decryptedElement(encId, keys, true);
          if (!is(out.el, NS.saml, "NameID")) fail("the EncryptedID is not a NameID");
          nameIdEl = out.el;
        }
        if (!nameIdEl) fail("the logout request names no one");
        const nameId = text(nameIdEl);
        if (nameId === "") fail("the logout request names no one");
        const sessionIndexes = kids(el, NS.proto, "SessionIndex").map((s) => text(s)).slice(0, 50);
        return { kind: "request", id: attr(el, "ID")!, nameId, sessionIndexes, relay, expires: t + (maxAge + skew) * 1000 };
      }
      if (is(el, NS.proto, "LogoutResponse")) {
        const status = kid(el, NS.proto, "Status");
        const code = status ? kid(status, NS.proto, "StatusCode") : null;
        return { kind: "response", inResponseTo: attr(el, "InResponseTo"), success: code !== null && attr(code, "Value") === SUCCESS };
      }
      fail("not a logout message");
    },
    async userFor(subject) {
      if (!o.userFor) return null;
      const u = await o.userFor(subject);
      return typeof u === "string" && u !== "" ? u : null;
    },
    async claim(key, until) {
      return (await replay.claim(key, until)) === true;
    },
    newRequestId: () => `_${randomBytes(20).toString("hex")}`,
  };
  return saml;
}
