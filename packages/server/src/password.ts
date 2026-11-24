import * as nodeCrypto from "node:crypto";
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { isBcryptHash, verifyBcrypt } from "./bcrypt.ts";

export type LegacyPasswordFormat = "bcrypt";

export interface VerifyPasswordOptions {
  legacy?: readonly LegacyPasswordFormat[];
}

export type PasswordAlgorithm = "scrypt" | "argon2id";

export interface PasswordOptions {
  algorithm?: PasswordAlgorithm;
  ln?: number;
  r?: number;
  p?: number;
  m?: number;
  t?: number;
}

const DEFAULT = { ln: 15, r: 8, p: 1 };
const ARGON = { m: 19456, t: 2, p: 1 };
const ARGON_LIMITS = { m: [1024, 1 << 20], t: [1, 10], p: [1, 16] } as const;

type Argon2Fn = (
  algorithm: "argon2id",
  params: { message: Uint8Array; nonce: Uint8Array; parallelism: number; tagLength: number; memory: number; passes: number },
  cb: (err: Error | null, key: Buffer) => void,
) => void;

function argon2id(password: Uint8Array, salt: Uint8Array, len: number, o: { m: number; t: number; p: number }): Promise<Buffer> {
  const fn = (nodeCrypto as unknown as { argon2?: Argon2Fn }).argon2;
  if (typeof fn !== "function") {
    return Promise.reject(new Error("@weft-framework/server: argon2id needs Node 24.7 or newer (crypto.argon2)"));
  }
  return new Promise((resolve, reject) =>
    fn("argon2id", { message: password, nonce: salt, parallelism: o.p, tagLength: len, memory: o.m, passes: o.t }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

function argonParams(o: PasswordOptions): { m: number; t: number; p: number } {
  const v = { m: o.m ?? ARGON.m, t: o.t ?? ARGON.t, p: o.p ?? ARGON.p };
  for (const k of ["m", "t", "p"] as const) {
    const [lo, hi] = ARGON_LIMITS[k];
    if (!Number.isInteger(v[k]) || v[k] < lo || v[k] > hi) throw new RangeError(`@weft-framework/server: argon2id ${k} is ${lo} to ${hi}`);
  }
  if (v.m < 8 * v.p) throw new RangeError("@weft-framework/server: argon2id m must be at least 8 × p");
  return v;
}

const ARGON_FORMAT = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{11,64})\$([A-Za-z0-9+/]{22,86})$/;

function parseArgon(stored: string): { m: number; t: number; p: number; salt: Buffer; key: Buffer } | null {
  const x = typeof stored === "string" ? ARGON_FORMAT.exec(stored) : null;
  if (!x) return null;
  try {
    const params = argonParams({ m: Number(x[1]), t: Number(x[2]), p: Number(x[3]) });
    const salt = Buffer.from(x[4]!, "base64");
    const key = Buffer.from(x[5]!, "base64");
    return salt.length >= 8 && key.length >= 16 ? { ...params, salt, key } : null;
  } catch {
    return null;
  }
}
const MAX_LN = 20;
const MAX_PASSWORD_BYTES = 1024;
const enc = new TextEncoder();

function scrypt(password: Uint8Array, salt: Uint8Array, len: number, o: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, len, o, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "");
}

function passwordBytes(password: string): Uint8Array {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("@weft-framework/server: a password must be a non-empty string");
  }
  const bytes = enc.encode(password.normalize("NFC"));
  if (bytes.length > MAX_PASSWORD_BYTES) {
    throw new RangeError(`@weft-framework/server: passwords are limited to ${MAX_PASSWORD_BYTES} bytes`);
  }
  return bytes;
}

function scryptOptions(ln: number, r: number, p: number): ScryptOptions {
  return { N: 2 ** ln, r, p, maxmem: 256 * 2 ** ln * r + 1024 * 1024 };
}

export async function hashPassword(password: string, opts: PasswordOptions = {}): Promise<string> {
  if (opts.algorithm !== undefined && opts.algorithm !== "scrypt" && opts.algorithm !== "argon2id") {
    throw new RangeError("@weft-framework/server: algorithm is \"scrypt\" or \"argon2id\"");
  }
  if (opts.algorithm === "argon2id") {
    const a = argonParams(opts);
    const salt = randomBytes(16);
    const key = await argon2id(passwordBytes(password), salt, 32, a);
    return `$argon2id$v=19$m=${a.m},t=${a.t},p=${a.p}$${b64(salt)}$${b64(key)}`;
  }
  const { ln, r, p } = { ...DEFAULT, ...opts };
  if (!Number.isInteger(ln) || ln < 10 || ln > MAX_LN || !Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) {
    throw new RangeError("@weft-framework/server: bad scrypt parameters");
  }
  const salt = randomBytes(16);
  const key = await scrypt(passwordBytes(password), salt, 32, scryptOptions(ln, r, p));
  return `$scrypt$ln=${ln},r=${r},p=${p}$${b64(salt)}$${b64(key)}`;
}

interface Parsed {
  ln: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

const FORMAT = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

function parse(stored: string): Parsed | null {
  const m = typeof stored === "string" ? FORMAT.exec(stored) : null;
  if (!m) {
    return null;
  }
  const [ln, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (ln < 10 || ln > MAX_LN || r < 1 || p < 1) {
    return null;
  }
  return { ln, r, p, salt: Buffer.from(m[4], "base64"), key: Buffer.from(m[5], "base64") };
}

let dummy: Promise<string> | null = null;

export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
  opts: VerifyPasswordOptions = {},
): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = passwordBytes(password);
  } catch {
    return false;
  }
  if (opts.legacy?.includes("bcrypt") && isBcryptHash(stored)) {
    return verifyBcrypt(password, stored!);
  }
  const argon = stored ? parseArgon(stored) : null;
  if (argon) {
    const key = await argon2id(bytes, argon.salt, argon.key.length, argon);
    return key.length === argon.key.length && timingSafeEqual(key, argon.key);
  }
  const real = stored ? parse(stored) : null;
  dummy ??= hashPassword("weft-dummy-password");
  const target = real ?? parse(await dummy)!;
  const key = await scrypt(bytes, target.salt, target.key.length, scryptOptions(target.ln, target.r, target.p));
  return real !== null && key.length === real.key.length && timingSafeEqual(key, real.key);
}

export function needsRehash(stored: string, opts: PasswordOptions = {}): boolean {
  if (opts.algorithm === "argon2id") {
    const want = argonParams(opts);
    const got = parseArgon(stored);
    return !got || got.m < want.m || got.t < want.t || got.p < want.p;
  }
  const want = { ...DEFAULT, ...opts };
  const got = parse(stored);
  return !got || got.ln < want.ln || got.r < want.r || got.p < want.p;
}
