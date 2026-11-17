import type { SqlDatabase } from "@weft/data";
import { login } from "./auth.ts";
import type { PageContext } from "./context.ts";
import { seal, unseal } from "./seal.ts";
import { base64url, fromBase64url } from "./security.ts";

type Maybe<T> = T | Promise<T>;

export interface PasskeyCredential {
  id: string;
  user: string;
  handle: string;
  publicKey: JsonWebKey;
  alg: number;
  signCount: number;
  transports: string[];
  backedUp: boolean;
  name: string;
  created: number;
  lastUsed: number | null;
}

export interface PasskeyStore {
  add(c: PasskeyCredential): Maybe<void>;
  get(id: string): Maybe<PasskeyCredential | null | undefined>;
  list(user: string): Maybe<PasskeyCredential[]>;
  update(id: string, patch: Partial<Pick<PasskeyCredential, "signCount" | "lastUsed" | "backedUp" | "name">>): Maybe<void>;
  remove(id: string): Maybe<boolean>;
}

export class MemoryPasskeyStore implements PasskeyStore {
  readonly #creds = new Map<string, PasskeyCredential>();
  add(c: PasskeyCredential): void {
    this.#creds.set(c.id, structuredClone(c));
  }
  get(id: string): PasskeyCredential | null {
    const c = this.#creds.get(id);
    return c ? structuredClone(c) : null;
  }
  list(user: string): PasskeyCredential[] {
    return [...this.#creds.values()].filter((c) => c.user === user).map((c) => structuredClone(c));
  }
  update(id: string, patch: Partial<PasskeyCredential>): void {
    const c = this.#creds.get(id);
    if (c) Object.assign(c, patch);
  }
  remove(id: string): boolean {
    return this.#creds.delete(id);
  }
}

export class SqlPasskeyStore implements PasskeyStore {
  private readonly db: SqlDatabase;
  private readonly table: string;

  constructor(db: SqlDatabase, table = "weft_passkeys") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(`SqlPasskeyStore: bad table name ${table}`);
    }
    this.db = db;
    this.table = table;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, handle TEXT NOT NULL, ` +
        `public_key TEXT NOT NULL, alg INTEGER NOT NULL, sign_count INTEGER NOT NULL, transports TEXT NOT NULL, ` +
        `backed_up INTEGER NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER)`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_user ON ${table} (user_id)`);
  }

  private row(r: unknown): PasskeyCredential | null {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    return {
      id: String(o.id),
      user: String(o.user_id),
      handle: String(o.handle),
      publicKey: JSON.parse(String(o.public_key)) as JsonWebKey,
      alg: Number(o.alg),
      signCount: Number(o.sign_count),
      transports: JSON.parse(String(o.transports)) as string[],
      backedUp: Number(o.backed_up) === 1,
      name: String(o.name),
      created: Number(o.created),
      lastUsed: o.last_used === null || o.last_used === undefined ? null : Number(o.last_used),
    };
  }
  add(c: PasskeyCredential): void {
    this.db
      .prepare(
        `INSERT INTO ${this.table} (id, user_id, handle, public_key, alg, sign_count, transports, backed_up, name, created, last_used) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, c.user, c.handle, JSON.stringify(c.publicKey), c.alg, c.signCount, JSON.stringify(c.transports), c.backedUp ? 1 : 0, c.name, c.created, c.lastUsed);
  }
  get(id: string): PasskeyCredential | null {
    return this.row(this.db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).all(id)[0]);
  }
  list(user: string): PasskeyCredential[] {
    return this.db
      .prepare(`SELECT * FROM ${this.table} WHERE user_id = ? ORDER BY created`)
      .all(user)
      .map((r) => this.row(r)!);
  }
  update(id: string, patch: Partial<PasskeyCredential>): void {
    const cols: Record<string, string> = { signCount: "sign_count", lastUsed: "last_used", backedUp: "backed_up", name: "name" };
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) continue;
      const value = typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null);
      this.db.prepare(`UPDATE ${this.table} SET ${col} = ? WHERE id = ?`).run(value, id);
    }
  }
  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM ${this.table} WHERE id = ? RETURNING id`).all(id).length > 0;
  }
}

export class PasskeyError extends Error {
  readonly code: "signed-out" | "invalid" | "expired" | "conflict" | "limit" | "not-found";
  constructor(code: PasskeyError["code"], message: string, opts?: ErrorOptions) {
    super(message, opts);
    this.name = "PasskeyError";
    this.code = code;
  }
}

type Cbor = number | bigint | string | boolean | null | undefined | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

export function decodeCbor(buf: Uint8Array, pos = 0, depth = 0): { value: Cbor; end: number } {
  if (depth > 16) throw new Error("CBOR nested too deeply");
  const need = (n: number) => {
    if (pos + n > buf.length) throw new Error("CBOR truncated");
  };
  need(1);
  const head = buf[pos++];
  const major = head >> 5;
  const info = head & 31;
  let arg: number | bigint;
  if (info < 24) arg = info;
  else if (info === 24) {
    need(1);
    arg = buf[pos++];
  } else if (info === 25) {
    need(2);
    arg = (buf[pos] << 8) | buf[pos + 1];
    pos += 2;
  } else if (info === 26) {
    need(4);
    arg = ((buf[pos] << 24) >>> 0) + (buf[pos + 1] << 16) + (buf[pos + 2] << 8) + buf[pos + 3];
    pos += 4;
  } else if (info === 27) {
    need(8);
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(buf[pos + i]);
    pos += 8;
    arg = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  } else throw new Error("CBOR indefinite lengths are not supported");
  const len = (): number => {
    if (typeof arg !== "number" || arg > buf.length) throw new Error("CBOR length too large");
    return arg;
  };
  switch (major) {
    case 0:
      return { value: arg, end: pos };
    case 1:
      return { value: typeof arg === "number" ? -1 - arg : -1n - arg, end: pos };
    case 2: {
      const n = len();
      need(n);
      return { value: buf.slice(pos, pos + n), end: pos + n };
    }
    case 3: {
      const n = len();
      need(n);
      return { value: new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(pos, pos + n)), end: pos + n };
    }
    case 4: {
      const n = len();
      const out: Cbor[] = [];
      for (let i = 0; i < n; i++) {
        const r = decodeCbor(buf, pos, depth + 1);
        out.push(r.value);
        pos = r.end;
      }
      return { value: out, end: pos };
    }
    case 5: {
      const n = len();
      const out = new Map<Cbor, Cbor>();
      for (let i = 0; i < n; i++) {
        const k = decodeCbor(buf, pos, depth + 1);
        const v = decodeCbor(buf, k.end, depth + 1);
        if (out.has(k.value)) throw new Error("CBOR duplicate map key");
        out.set(k.value, v.value);
        pos = v.end;
      }
      return { value: out, end: pos };
    }
    case 6:
      return decodeCbor(buf, pos, depth + 1);
    default:
      if (info === 20) return { value: false, end: pos };
      if (info === 21) return { value: true, end: pos };
      if (info === 22) return { value: null, end: pos };
      if (info === 23) return { value: undefined, end: pos };
      throw new Error("CBOR floats and simple values are not supported");
  }
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credential?: { id: Uint8Array; publicKey: JsonWebKey; alg: number };
}

export function coseToJwk(key: Cbor): { jwk: JsonWebKey; alg: number } {
  if (!(key instanceof Map)) throw new Error("credential key is not a COSE key");
  const kty = key.get(1);
  const alg = key.get(3);
  const bytes = (label: number, size?: number): string => {
    const v = key.get(label);
    if (!(v instanceof Uint8Array) || (size !== undefined && v.length !== size)) throw new Error("credential key is malformed");
    return base64url(v);
  };
  if (kty === 2 && alg === -7 && key.get(-1) === 1) {
    return { jwk: { kty: "EC", crv: "P-256", x: bytes(-2, 32), y: bytes(-3, 32) }, alg };
  }
  if (kty === 1 && alg === -8 && key.get(-1) === 6) {
    return { jwk: { kty: "OKP", crv: "Ed25519", x: bytes(-2, 32) }, alg };
  }
  if (kty === 3 && alg === -257) {
    const n = key.get(-1);
    if (!(n instanceof Uint8Array) || (n[0] === 0 ? n.length - 1 : n.length) < 256) throw new Error("RSA credential keys must be 2048 bits or more");
    return { jwk: { kty: "RSA", n: bytes(-1), e: bytes(-2) }, alg };
  }
  throw new Error("credential key algorithm is not supported");
}

export function parseAuthData(buf: Uint8Array): AuthData {
  if (buf.length < 37) throw new Error("authenticator data is too short");
  const flags = buf[32];
  const signCount = ((buf[33] << 24) >>> 0) + (buf[34] << 16) + (buf[35] << 8) + buf[36];
  const out: AuthData = { rpIdHash: buf.slice(0, 32), flags, signCount };
  if (flags & FLAG_AT) {
    if (buf.length < 55) throw new Error("attested credential data is too short");
    const idLen = (buf[53] << 8) | buf[54];
    if (idLen < 16 || idLen > 1023 || 55 + idLen > buf.length) throw new Error("credential id has a bad length");
    const id = buf.slice(55, 55 + idLen);
    const { value } = decodeCbor(buf, 55 + idLen);
    out.credential = { id, ...(({ jwk, alg }) => ({ publicKey: jwk, alg }))(coseToJwk(value)) };
  }
  return out;
}

export function derToRaw(der: Uint8Array, size: number): Uint8Array {
  let p = 0;
  const fail = (): never => {
    throw new Error("signature is not DER");
  };
  if (der[p++] !== 0x30) fail();
  let total = der[p++];
  if (total & 0x80) {
    if (total !== 0x81) fail();
    total = der[p++];
  }
  if (p + total !== der.length) fail();
  const int = (): Uint8Array => {
    if (der[p++] !== 0x02) fail();
    const n = der[p++];
    if (n === 0 || n > size + 1 || p + n > der.length) fail();
    let v = der.subarray(p, p + n);
    p += n;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) fail();
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = int();
  const s = int();
  if (p !== der.length) fail();
  const raw = new Uint8Array(size * 2);
  raw.set(r, 0);
  raw.set(s, size);
  return raw;
}

async function verifySignature(alg: number, jwk: JsonWebKey, sig: Uint8Array, signed: Uint8Array): Promise<boolean> {
  const data = new Uint8Array(signed);
  try {
    if (alg === -7) {
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(derToRaw(sig, 32)), data);
    }
    if (alg === -8) {
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "Ed25519" }, key, new Uint8Array(sig), data);
    }
    if (alg === -257) {
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, new Uint8Array(sig), data);
    }
  } catch {
    return false;
  }
  return false;
}

export interface PasskeyOptions {
  url: string;
  name: string;
  rpId?: string;
  store?: PasskeyStore;
  userVerification?: boolean;
  maxPerUser?: number;
  now?(): number;
}

export interface PasskeyChallenge {
  publicKey: Record<string, unknown>;
  state: string;
}

const TTL_MS = 5 * 60_000;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

const sha256 = async (data: Uint8Array | string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : new Uint8Array(data)));

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function actorId(ctx: PageContext): string | null {
  const id = (ctx.user as { id?: unknown } | null)?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

interface ParsedResponse {
  id: string;
  rawId: Uint8Array;
  clientData: Record<string, unknown>;
  clientDataBytes: Uint8Array;
  fields: Record<string, unknown>;
}

function bytesField(o: Record<string, unknown>, key: string): Uint8Array {
  const v = o[key];
  const b = typeof v === "string" && v.length <= 65_536 ? fromBase64url(v) : null;
  if (!b) throw new Error(`credential ${key} is missing`);
  return b;
}

function parseResponse(raw: unknown): ParsedResponse {
  if (typeof raw !== "string" || raw.length > 131_072) throw new Error("credential is missing or too large");
  let cred: unknown;
  try {
    cred = JSON.parse(raw);
  } catch {
    throw new Error("credential is not JSON");
  }
  if (typeof cred !== "object" || cred === null) throw new Error("credential is not an object");
  const c = cred as Record<string, unknown>;
  if (c.type !== "public-key" || typeof c.id !== "string") throw new Error("credential is not a public key credential");
  const rawId = bytesField(c, "rawId");
  if (base64url(rawId) !== c.id) throw new Error("credential id and rawId differ");
  const fields = c.response;
  if (typeof fields !== "object" || fields === null) throw new Error("credential has no response");
  const f = fields as Record<string, unknown>;
  const clientDataBytes = bytesField(f, "clientDataJSON");
  let clientData: unknown;
  try {
    clientData = JSON.parse(dec.decode(clientDataBytes));
  } catch {
    throw new Error("client data is not JSON");
  }
  if (typeof clientData !== "object" || clientData === null) throw new Error("client data is not an object");
  return { id: c.id, rawId, clientData: clientData as Record<string, unknown>, clientDataBytes, fields: f };
}

export class Passkeys {
  readonly #origin: string;
  readonly #rpId: string;
  readonly #name: string;
  readonly #store: PasskeyStore;
  readonly #uv: boolean;
  readonly #max: number;
  readonly #now: () => number;
  readonly #used = new Map<string, number>();

  constructor(o: PasskeyOptions) {
    let u: URL;
    try {
      u = new URL(o.url);
    } catch {
      throw new Error("definePasskeys: `url` is the app's public origin, such as https://app.example");
    }
    const local = u.hostname === "localhost";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
      throw new Error("definePasskeys: `url` must use https (http only for localhost, as browsers require)");
    }
    const rpId = o.rpId ?? u.hostname;
    if (rpId !== u.hostname && !u.hostname.endsWith(`.${rpId}`)) {
      throw new Error(`definePasskeys: rpId ${rpId} must be ${u.hostname} or a parent domain of it`);
    }
    if (typeof o.name !== "string" || o.name.trim() === "" || o.name.length > 64) {
      throw new Error("definePasskeys: `name` is the app's name, 1-64 characters");
    }
    const max = o.maxPerUser ?? 20;
    if (!Number.isInteger(max) || max < 1 || max > 100) throw new Error("definePasskeys: maxPerUser is 1 to 100");
    this.#origin = u.origin;
    this.#rpId = rpId;
    this.#name = o.name;
    this.#store = o.store ?? new MemoryPasskeyStore();
    this.#uv = o.userVerification ?? true;
    this.#max = max;
    this.#now = o.now ?? Date.now;
  }

  #fresh(): string {
    const now = this.#now();
    for (const [c, exp] of this.#used) if (exp <= now) this.#used.delete(c);
    return base64url(crypto.getRandomValues(new Uint8Array(32)));
  }

  async #challenge(ctx: PageContext, state: unknown, purpose: string): Promise<{ c: string; u?: string; h?: string } | null> {
    const v = (await unseal(ctx, typeof state === "string" ? state : null, { purpose, session: true })) as
      | { c?: unknown; u?: unknown; h?: unknown }
      | undefined;
    if (!v || typeof v.c !== "string") return null;
    if (this.#used.has(v.c)) return null;
    this.#used.set(v.c, this.#now() + TTL_MS);
    return { c: v.c, u: typeof v.u === "string" ? v.u : undefined, h: typeof v.h === "string" ? v.h : undefined };
  }

  #checkClient(p: ParsedResponse, type: string, challenge: string): void {
    const cd = p.clientData;
    if (cd.type !== type) throw new Error(`client data is not ${type}`);
    if (typeof cd.challenge !== "string" || cd.challenge !== challenge) throw new Error("challenge does not match");
    if (cd.origin !== this.#origin) throw new Error("origin does not match");
    if (cd.crossOrigin === true) throw new Error("cross-origin use is not allowed");
  }

  async #checkAuthData(ad: AuthData): Promise<void> {
    if (!equalBytes(ad.rpIdHash, await sha256(this.#rpId))) throw new Error("relying party id does not match");
    if (!(ad.flags & FLAG_UP)) throw new Error("user was not present");
    if (this.#uv && !(ad.flags & FLAG_UV)) throw new Error("user was not verified");
  }

  async registrationOptions(ctx: PageContext, opts: { userName?: string; displayName?: string } = {}): Promise<PasskeyChallenge> {
    const user = actorId(ctx);
    if (!user) throw new PasskeyError("signed-out", "Sign in to add a passkey");
    const existing = await this.#store.list(user);
    if (existing.length >= this.#max) throw new PasskeyError("limit", "You have too many passkeys; remove one first");
    const handle = existing[0]?.handle ?? base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = this.#fresh();
    const name = (opts.userName ?? user).slice(0, 64);
    return {
      state: await seal(ctx, { c: challenge, u: user, h: handle }, { purpose: "passkey-add", ttlMs: TTL_MS, session: true }),
      publicKey: {
        rp: { id: this.#rpId, name: this.#name },
        user: { id: handle, name, displayName: (opts.displayName ?? name).slice(0, 64) },
        challenge,
        pubKeyCredParams: [-8, -7, -257].map((alg) => ({ type: "public-key", alg })),
        timeout: TTL_MS,
        attestation: "none",
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: this.#uv ? "required" : "preferred" },
        excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.id, transports: c.transports })),
      },
    };
  }

  async register(ctx: PageContext, state: string, credential: string, opts: { name?: string } = {}): Promise<PasskeyCredential> {
    const user = actorId(ctx);
    if (!user) throw new PasskeyError("signed-out", "Sign in to add a passkey");
    const ch = await this.#challenge(ctx, state, "passkey-add");
    if (!ch || ch.u !== user || !ch.h) throw new PasskeyError("expired", "That took too long; try again");
    let cred: PasskeyCredential;
    try {
      const p = parseResponse(credential);
      this.#checkClient(p, "webauthn.create", ch.c);
      const att = decodeCbor(bytesField(p.fields, "attestationObject"));
      if (!(att.value instanceof Map)) throw new Error("attestation object is not a map");
      const authData = att.value.get("authData");
      if (!(authData instanceof Uint8Array)) throw new Error("attestation object has no authenticator data");
      const ad = parseAuthData(authData);
      await this.#checkAuthData(ad);
      if (!ad.credential) throw new Error("no credential was created");
      if (!equalBytes(ad.credential.id, p.rawId)) throw new Error("credential id differs from the authenticator's");
      const transports = Array.isArray(p.fields.transports)
        ? (p.fields.transports as unknown[]).filter((t): t is string => typeof t === "string" && /^[a-z-]{1,16}$/.test(t)).slice(0, 8)
        : [];
      cred = {
        id: p.id,
        user,
        handle: ch.h,
        publicKey: ad.credential.publicKey,
        alg: ad.credential.alg,
        signCount: ad.signCount,
        transports,
        backedUp: (ad.flags & FLAG_BS) !== 0,
        name: (opts.name ?? "Passkey").slice(0, 64),
        created: this.#now(),
        lastUsed: null,
      };
    } catch (err) {
      throw new PasskeyError("invalid", "That passkey could not be added", { cause: err });
    }
    if (await this.#store.get(cred.id)) throw new PasskeyError("conflict", "That passkey is already registered");
    if ((await this.#store.list(user)).length >= this.#max) throw new PasskeyError("limit", "You have too many passkeys; remove one first");
    await this.#store.add(cred);
    return cred;
  }

  async signInOptions(ctx: PageContext): Promise<PasskeyChallenge> {
    const challenge = this.#fresh();
    return {
      state: await seal(ctx, { c: challenge }, { purpose: "passkey-in", ttlMs: TTL_MS, session: true }),
      publicKey: { challenge, rpId: this.#rpId, timeout: TTL_MS, userVerification: this.#uv ? "required" : "preferred", allowCredentials: [] },
    };
  }

  async signIn(ctx: PageContext, state: string, credential: string, onReject?: (reason: Error) => void): Promise<boolean> {
    const user = await this.verify(ctx, state, credential, onReject);
    if (user === null) return false;
    await login(ctx, user, { multiFactor: this.#uv });
    return true;
  }

  async verify(ctx: PageContext, state: string, credential: string, onReject?: (reason: Error) => void): Promise<string | null> {
    const reject = (reason: string): null => {
      onReject?.(new Error(reason));
      return null;
    };
    const ch = await this.#challenge(ctx, state, "passkey-in");
    if (!ch) return reject("the challenge expired or was used");
    try {
      const p = parseResponse(credential);
      this.#checkClient(p, "webauthn.get", ch.c);
      const stored = await this.#store.get(p.id);
      if (!stored) return reject("unknown credential");
      const handle = p.fields.userHandle;
      if (handle !== undefined && handle !== null && handle !== stored.handle) return reject("user handle does not match");
      const authData = bytesField(p.fields, "authenticatorData");
      const ad = parseAuthData(authData);
      await this.#checkAuthData(ad);
      const signed = new Uint8Array(authData.length + 32);
      signed.set(authData, 0);
      signed.set(await sha256(p.clientDataBytes), authData.length);
      if (!(await verifySignature(stored.alg, stored.publicKey, bytesField(p.fields, "signature"), signed))) {
        return reject("bad signature");
      }
      if ((ad.signCount !== 0 || stored.signCount !== 0) && ad.signCount <= stored.signCount) {
        return reject("signature counter went back: a cloned authenticator?");
      }
      await this.#store.update(stored.id, { signCount: ad.signCount, lastUsed: this.#now(), backedUp: (ad.flags & FLAG_BS) !== 0 });
      return stored.user;
    } catch (err) {
      return reject((err as Error).message);
    }
  }

  async list(user: string): Promise<Omit<PasskeyCredential, "publicKey" | "handle">[]> {
    return (await this.#store.list(user)).map(({ publicKey: _k, handle: _h, ...rest }) => rest);
  }

  async rename(user: string, id: string, name: string): Promise<void> {
    const c = await this.#store.get(id);
    if (!c || c.user !== user) throw new PasskeyError("not-found", "No such passkey");
    if (typeof name !== "string" || name.trim() === "" || name.length > 64) throw new PasskeyError("invalid", "A name is 1-64 characters");
    await this.#store.update(id, { name: name.trim() });
  }

  async remove(user: string, id: string): Promise<void> {
    const c = await this.#store.get(id);
    if (!c || c.user !== user) throw new PasskeyError("not-found", "No such passkey");
    await this.#store.remove(id);
  }
}

export function definePasskeys(o: PasskeyOptions): Passkeys {
  return new Passkeys(o);
}
