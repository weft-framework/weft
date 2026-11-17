type Json = Record<string, unknown>;

interface Credentials {
  create(o: { publicKey: unknown; signal?: AbortSignal }): Promise<unknown>;
  get(o: { publicKey: unknown; mediation?: string; signal?: AbortSignal }): Promise<unknown>;
}

interface PublicKeyCredentialStatic {
  isConditionalMediationAvailable?(): Promise<boolean>;
}

function b64urlToBytes(s: unknown): Uint8Array<ArrayBuffer> {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new TypeError("passkey: expected base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(buf: ArrayBuffer | ArrayBufferView | null | undefined): string | undefined {
  if (!buf) return undefined;
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function credentials(): Credentials {
  const c = (globalThis as { navigator?: { credentials?: Credentials } }).navigator?.credentials;
  if (!c || !passkeysSupported()) throw new Error("passkey: this browser does not support passkeys");
  return c;
}

export function passkeysSupported(): boolean {
  return typeof (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential === "function";
}

export async function passkeyAutofillSupported(): Promise<boolean> {
  const P = (globalThis as { PublicKeyCredential?: PublicKeyCredentialStatic }).PublicKeyCredential;
  try {
    return typeof P?.isConditionalMediationAvailable === "function" && (await P.isConditionalMediationAvailable());
  } catch {
    return false;
  }
}

function descriptors(list: unknown): unknown[] {
  return Array.isArray(list) ? list.map((d: Json) => ({ ...d, id: b64urlToBytes(d.id) })) : [];
}

function credentialJson(cred: unknown): string {
  const c = cred as {
    id: string;
    rawId: ArrayBuffer;
    type: string;
    authenticatorAttachment?: string | null;
    response: {
      clientDataJSON: ArrayBuffer;
      attestationObject?: ArrayBuffer;
      authenticatorData?: ArrayBuffer;
      signature?: ArrayBuffer;
      userHandle?: ArrayBuffer | null;
      getTransports?(): string[];
    };
  };
  const r = c.response;
  return JSON.stringify({
    id: c.id,
    rawId: bytesToB64url(c.rawId),
    type: c.type,
    authenticatorAttachment: c.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: bytesToB64url(r.clientDataJSON),
      attestationObject: bytesToB64url(r.attestationObject),
      authenticatorData: bytesToB64url(r.authenticatorData),
      signature: bytesToB64url(r.signature),
      userHandle: bytesToB64url(r.userHandle),
      transports: typeof r.getTransports === "function" ? r.getTransports() : undefined,
    },
  });
}

export async function createPasskey(publicKey: Json, opts: { signal?: AbortSignal } = {}): Promise<string> {
  const user = publicKey.user as Json;
  const cred = await credentials().create({
    publicKey: {
      ...publicKey,
      challenge: b64urlToBytes(publicKey.challenge),
      user: { ...user, id: b64urlToBytes(user.id) },
      excludeCredentials: descriptors(publicKey.excludeCredentials),
    },
    signal: opts.signal,
  });
  if (!cred) throw new Error("passkey: no credential was made");
  return credentialJson(cred);
}

export async function getPasskey(publicKey: Json, opts: { signal?: AbortSignal; autofill?: boolean } = {}): Promise<string> {
  const cred = await credentials().get({
    publicKey: { ...publicKey, challenge: b64urlToBytes(publicKey.challenge), allowCredentials: descriptors(publicKey.allowCredentials) },
    mediation: opts.autofill ? "conditional" : undefined,
    signal: opts.signal,
  });
  if (!cred) throw new Error("passkey: no credential was chosen");
  return credentialJson(cred);
}
