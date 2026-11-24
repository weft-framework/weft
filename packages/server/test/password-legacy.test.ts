import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, needsRehash, verifyPassword } from "../src/password.ts";
import { isBcryptHash, verifyBcrypt } from "../src/bcrypt.ts";

const VECTORS: [string, string][] = [
  ["U*U", "$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW"],
  ["secret", "$2y$04$bPfZLEmD0/5nb71OeBVBieMcqArF4mLbgLNtw9KDgVhix0MJA1QQi"],
  ["U*U", "$2y$05$afW9vWRcQSf87J/qt.PycOgHAFA2oqWRu7D.ZEFozM0DnQpxZ0l7i"],
  ["pässwörd ✓", "$2y$06$RKOFbyfT/zxBFkl2smEFYeGuFFpNKZLr/nF9319zcANiZ99qWxgUW"],
  ["x".repeat(72), "$2y$04$x2DtcmRXr0l1x5x7wOfkJuXNtD.0Q/PdHviHQWx6OCQIYfJOycfp6"],
  ["a", "$2y$10$0RD7PA50KjnSnVDVd76phemq/P9GaMESUplSBFiTLcjSB4EubIxtG"],
];

test("bcrypt hashes from Pterodactyl (PHP $2y$) and OpenBSD verify", () => {
  for (const [pw, hash] of VECTORS) {
    assert.equal(verifyBcrypt(pw, hash), true, hash);
    if (pw.length < 72) assert.equal(verifyBcrypt(`${pw}!`, hash), false, hash);
  }
  assert.equal(verifyBcrypt("x".repeat(90), VECTORS[4]![1]), true);
  assert.equal(verifyBcrypt("", VECTORS[1]![1]), false);
  assert.equal(verifyBcrypt("secret", "$2y$04$bPfZLEmD0/5nb71OeBVBieMcqArF4mLbgLNtw9KDgVhix0MJA1QQ"), false);
  assert.equal(verifyBcrypt("secret", "$2y$31$bPfZLEmD0/5nb71OeBVBieMcqArF4mLbgLNtw9KDgVhix0MJA1QQi"), false);
  assert.equal(isBcryptHash("$scrypt$ln=15,r=8,p=1$x$y"), false);
});


test("verifyPassword reads bcrypt only when the caller opts in, and the hash then needs a rehash", async () => {
  const [pw, hash] = VECTORS[1]!;
  assert.equal(await verifyPassword(pw, hash), false, "scrypt only by default");
  assert.equal(await verifyPassword(pw, hash, { legacy: ["bcrypt"] }), true);
  assert.equal(await verifyPassword(`${pw}x`, hash, { legacy: ["bcrypt"] }), false);
  assert.equal(await verifyPassword("", hash, { legacy: ["bcrypt"] }), false);
  assert.equal(needsRehash(hash), true);
  const fresh = await hashPassword(pw, { ln: 10 });
  assert.equal(await verifyPassword(pw, fresh, { legacy: ["bcrypt"] }), true);
  assert.equal(await verifyPassword(pw, "$1$md5$nope", { legacy: ["bcrypt"] }), false);
});
