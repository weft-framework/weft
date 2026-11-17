import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, diffText, isEdit, moveIndex, transform, type Edit } from "../src/ot.ts";

function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEdit(rand: () => number, text: string): Edit {
  const out: Edit = [];
  let len = text.length;
  const steps = 1 + Math.floor(rand() * 3);
  for (let k = 0; k < steps; k++) {
    if (len > 0 && rand() < 0.5) {
      const d = Math.floor(rand() * len);
      const n = 1 + Math.floor(rand() * Math.min(4, len - d));
      out.push({ d, n });
      len -= n;
    } else {
      const i = Math.floor(rand() * (len + 1));
      const s = "xyz".slice(0, 1 + Math.floor(rand() * 3)) + String(k);
      out.push({ i, s });
      len += s.length;
    }
  }
  return out;
}

test("transform: two edits converge in either order", () => {
  const rand = random(7);
  for (let run = 0; run < 3000; run++) {
    const text = "abcdefghij".slice(0, Math.floor(rand() * 11));
    const a = randomEdit(rand, text);
    const b = randomEdit(rand, text);
    const aFirst = rand() < 0.5;
    const [a2, b2] = transform(a, b, aFirst);
    const one = applyEdit(applyEdit(text, b), a2);
    const two = applyEdit(applyEdit(text, a), b2);
    assert.equal(one, two, `text ${JSON.stringify(text)} a ${JSON.stringify(a)} b ${JSON.stringify(b)} aFirst ${aFirst}`);
  }
});

test("transform: a server ordering several edits matches each client", () => {
  const rand = random(11);
  for (let run = 0; run < 1000; run++) {
    const text = "the quick brown fox".slice(0, Math.floor(rand() * 20));
    const y = randomEdit(rand, text);
    const afterY = applyEdit(text, y);
    const z = randomEdit(rand, afterY);
    const x = randomEdit(rand, text);
    let xs = x;
    xs = transform(xs, y, false)[0];
    xs = transform(xs, z, false)[0];
    const server = applyEdit(applyEdit(afterY, z), xs);
    let pending = x;
    let local = applyEdit(text, x);
    for (const remote of [y, z]) {
      const [p2, r2] = transform(pending, remote, false);
      local = applyEdit(local, r2);
      pending = p2;
    }
    assert.equal(local, server, `text ${JSON.stringify(text)} x ${JSON.stringify(x)} y ${JSON.stringify(y)} z ${JSON.stringify(z)}`);
  }
});

test("transform keeps text typed inside a range someone deletes", () => {
  const text = "hello world";
  const del: Edit = [{ d: 2, n: 6 }];
  const ins: Edit = [{ i: 5, s: "!!" }];
  const [d2, i2] = transform(del, ins, false);
  assert.equal(applyEdit(applyEdit(text, ins), d2), "he!!rld");
  assert.equal(applyEdit(applyEdit(text, del), i2), "he!!rld");
  const [a2, b2] = transform([{ i: 0, s: "A" }], [{ i: 0, s: "B" }], true);
  assert.equal(applyEdit(applyEdit("", [{ i: 0, s: "B" }]), a2), "AB");
  assert.equal(applyEdit(applyEdit("", [{ i: 0, s: "A" }]), b2), "AB");
});

test("diffText, moveIndex and isEdit", () => {
  const rand = random(3);
  for (let run = 0; run < 500; run++) {
    const from = "abcab😀ca".slice(0, Math.floor(rand() * 9));
    const to = applyEdit(from, randomEdit(rand, from).filter((s) => !("d" in s)));
    assert.equal(applyEdit(from, diffText(from, to)), to);
    assert.equal(applyEdit(to, diffText(to, from)), from);
  }
  assert.deepEqual(diffText("a😀b", "a😁b"), [{ d: 1, n: 2 }, { i: 1, s: "😁" }], "never half a surrogate pair");
  assert.deepEqual(diffText("same", "same"), []);

  assert.equal(moveIndex(5, [{ i: 2, s: "xx" }]), 7);
  assert.equal(moveIndex(5, [{ i: 5, s: "xx" }]), 7, "someone typing at the cursor pushes it");
  assert.equal(moveIndex(5, [{ i: 5, s: "xx" }], true), 5);
  assert.equal(moveIndex(5, [{ d: 3, n: 4 }]), 3);
  assert.equal(moveIndex(9, [{ d: 3, n: 4 }]), 5);

  assert.equal(isEdit([{ i: 0, s: "a" }, { d: 0, n: 1 }]), true);
  for (const bad of [null, {}, [{ i: -1, s: "a" }], [{ i: 0, s: "" }], [{ d: 0, n: 0 }], [{ i: 0, s: "a", x: 1 }], [{ i: 1.5, s: "a" }], [{ d: "0", n: 1 }]]) {
    assert.equal(isEdit(bad), false, JSON.stringify(bad));
  }
  assert.equal(isEdit(Array.from({ length: 65 }, () => ({ i: 0, s: "a" }))), false, "too many steps");
  assert.equal(isEdit([{ i: 0, s: "a".repeat(16 * 1024 + 1) }]), false, "too much text");
  assert.throws(() => applyEdit("ab", [{ d: 1, n: 5 }]), RangeError);
});
