import { test } from "node:test";
import assert from "node:assert/strict";
import { qrCode, qrPath, qrViewBox } from "../src/qr.ts";

const KNOWN = [
  "#######.##.##.#######",
  "#.....#.#..##.#.....#",
  "#.###.#...#.#.#.###.#",
  "#.###.#.#.#...#.###.#",
  "#.###.#..##...#.###.#",
  "#.....#..#....#.....#",
  "#######.#.#.#.#######",
  "........#.#..........",
  "#.##.###.#....#..#.##",
  "###.##......#...###.#",
  "..#.#.###.#.##.#...##",
  ".#..#..##...#..###..#",
  ".#....#.#..#.##....#.",
  "........#..#.##.#..#.",
  "#######.###..#.##.#..",
  "#.....#.#......#.##..",
  "#.###.#..###...#..##.",
  "#.###.#.#####.##.#.#.",
  "#.###.#.##.####...#..",
  "#.....#..#...##.##..#",
  "#######.##....##..#..",
];

const rows = (m: boolean[][]) => m.map((r) => r.map((b) => (b ? "#" : ".")).join(""));

test("encodes a known symbol exactly", () => {
  const c = qrCode("weft.test/qr", { level: "M", mask: 3 });
  assert.equal(c.version, 1);
  assert.equal(c.size, 21);
  assert.deepEqual(rows(c.modules), KNOWN);
});

test("picks the smallest version, and a mask when none is given", () => {
  assert.equal(qrCode("a").version, 1);
  const uri = "otpauth://totp/Weft:ada%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Weft";
  const c = qrCode(uri);
  assert.ok(c.version > 1 && c.version < 10);
  assert.ok(c.mask >= 0 && c.mask <= 7);
  assert.equal(c.modules.length, c.version * 4 + 17);
  assert.ok(qrCode(uri, { level: "H" }).version > c.version);
  assert.equal(qrCode("z".repeat(367), { level: "L" }).version, 12);
  assert.equal(qrCode("z".repeat(368), { level: "L" }).version, 13);
});

test("text is UTF-8", () => {
  assert.notDeepEqual(rows(qrCode("é", { mask: 0 }).modules), rows(qrCode("e", { mask: 0 }).modules));
});

test("refuses what does not fit and bad options", () => {
  assert.throws(() => qrCode("x".repeat(3000)), RangeError);
  assert.throws(() => qrCode("x", { mask: 8 }), RangeError);
  assert.throws(() => qrCode("x", { minVersion: 0 }), RangeError);
  assert.throws(() => qrCode("x", { level: "X" as "L" }), TypeError);
  assert.equal(qrCode("x", { minVersion: 5 }).version, 5);
});

test("the SVG path covers exactly the dark modules", () => {
  const c = qrCode("weft.test/qr", { level: "M", mask: 3 });
  const d = qrPath(c);
  let dark = 0;
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    const [x, y, w] = [Number(m[1]) - 4, Number(m[2]) - 4, Number(m[3])];
    for (let i = 0; i < w; i++) assert.equal(c.modules[y]![x + i], true);
    dark += w;
  }
  assert.equal(dark, c.modules.flat().filter(Boolean).length);
  assert.equal(qrViewBox(c), "0 0 29 29");
  assert.equal(qrViewBox(c, 0), "0 0 21 21");
});
