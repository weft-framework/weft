import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

export interface PasswordOptions {
  ln?: number;
  r?: number;
  p?: number;
}

const DEFAULT = { ln: 15, r: 8, p: 1 };
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

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = passwordBytes(password);
  } catch {
    return false;
  }
  const real = stored ? parse(stored) : null;
  dummy ??= hashPassword("weft-dummy-password");
  const target = real ?? parse(await dummy)!;
  const key = await scrypt(bytes, target.salt, target.key.length, scryptOptions(target.ln, target.r, target.p));
  return real !== null && key.length === real.key.length && timingSafeEqual(key, real.key);
}

export function needsRehash(stored: string, opts: PasswordOptions = {}): boolean {
  const want = { ...DEFAULT, ...opts };
  const got = parse(stored);
  return !got || got.ln < want.ln || got.r < want.r || got.p < want.p;
}
