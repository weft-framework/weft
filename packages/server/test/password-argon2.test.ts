import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { hashPassword, needsRehash, verifyPassword } from "../src/password.ts";

const skip = typeof (nodeCrypto as unknown as { argon2?: unknown }).argon2 !== "function" ? "needs crypto.argon2 (Node 24.7+)" : false;
const fast = { algorithm: "argon2id", m: 1024, t: 1, p: 1 } as const;
const unpadded = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

test("argon2id hashes in PHC format and verifies", { skip }, async () => {
  const h = await hashPassword("correct horse battery", fast);
  assert.match(h, /^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.notEqual(await hashPassword("correct horse battery", fast), h, "salted");
  assert.equal(await verifyPassword("correct horse battery", h), true);
  assert.equal(await verifyPassword("correct horse batterY", h), false);
  assert.equal(await verifyPassword("", h), false);
});

test("argon2id hashes made with other parameters verify", { skip }, async () => {
  const salt = Buffer.from("somesaltsomesalt");
  const argon2 = (nodeCrypto as unknown as { argon2: (...a: unknown[]) => void }).argon2;
  const key = await new Promise<Buffer>((res, rej) =>
    argon2(
      "argon2id",
      { message: Buffer.from("hunter2hunter2"), nonce: salt, parallelism: 2, tagLength: 16, memory: 2048, passes: 3 },
      (e: Error | null, k: Buffer) => (e ? rej(e) : res(k)),
    ),
  );
  const phc = ["", "argon2id", "v=19", "m=2048,t=3,p=2", unpadded(salt), unpadded(key)].join("$");
  assert.equal(await verifyPassword("hunter2hunter2", phc), true, "other parameters and a 16-byte tag");
  assert.equal(await verifyPassword("hunter2hunter3", phc), false);
});

test("needsRehash follows the configured algorithm and its parameters", { skip }, async () => {
  const argon = await hashPassword("correct horse battery", fast);
  const scrypt = await hashPassword("correct horse battery", { ln: 10 });
  assert.equal(needsRehash(argon, fast), false);
  assert.equal(needsRehash(argon, { ...fast, m: 2048 }), true, "more memory wanted");
  assert.equal(needsRehash(scrypt, fast), true, "scrypt moves to argon2id");
  assert.equal(needsRehash(argon, { ln: 10 }), true, "and back, when scrypt is configured");
  assert.equal(needsRehash(scrypt, { ln: 10 }), false);
});

test("argon2id parameters are bounded, also when read from a stored hash", async () => {
  await assert.rejects(hashPassword("x", { algorithm: "argon2id", m: 512 }), /m is 1024/);
  await assert.rejects(hashPassword("x", { algorithm: "argon2id", t: 0 }), /t is 1/);
  await assert.rejects(hashPassword("x", { algorithm: "argon2id", p: 64 }), /p is 1/);
  await assert.rejects(hashPassword("x", { algorithm: "md5" as never }), /scrypt" or "argon2id/);
  const zeros = unpadded(Buffer.alloc(32));
  const salt = unpadded(Buffer.from("somesaltsomesalt"));
  const huge = ["", "argon2id", "v=19", "m=9999999,t=1,p=1", salt, zeros].join("$");
  assert.equal(await verifyPassword("x", huge), false, "never run with gigabytes of memory");
  const other = ["", "argon2i", "v=19", "m=1024,t=1,p=1", salt, zeros].join("$");
  assert.equal(await verifyPassword("x", other), false);
});
