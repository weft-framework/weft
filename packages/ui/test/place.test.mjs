// SPDX-License-Identifier: MIT
//
// The pure parts of @weft/ui. Behaviour on real elements (keyboard, focus,
// popovers, dialogs) is covered by the browser suite: tests/browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as ui from "../index.js";

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const viewport = { width: 800, height: 600 };

test("the module loads without a DOM (server renders import it)", () => {
  for (const name of ["dialog", "tabs", "menu", "select", "calendar", "sidebar", "toast", "place"]) {
    assert.equal(typeof ui[name], "function", name);
  }
});

test("place: below the anchor, centred, offset", () => {
  const p = ui.place(rect(100, 100, 80, 20), rect(0, 0, 40, 30), "bottom", 4, viewport);
  assert.deepEqual(p, { x: 120, y: 124, side: "bottom", align: "center" });
});

test("place: start and end alignment", () => {
  const anchor = rect(100, 100, 80, 20);
  const floating = rect(0, 0, 40, 30);
  assert.equal(ui.place(anchor, floating, "bottom-start", 4, viewport).x, 100);
  assert.equal(ui.place(anchor, floating, "bottom-end", 4, viewport).x, 140);
  assert.equal(ui.place(anchor, floating, "right-start", 4, viewport).y, 100);
  assert.equal(ui.place(anchor, floating, "right-end", 4, viewport).y, 90);
});

test("place: flips to the opposite side when it would leave the viewport", () => {
  const nearBottom = rect(100, 560, 80, 20);
  const p = ui.place(nearBottom, rect(0, 0, 40, 100), "bottom", 4, viewport);
  assert.equal(p.side, "top");
  assert.equal(p.y, 456);
  const nearRight = rect(760, 100, 30, 20);
  assert.equal(ui.place(nearRight, rect(0, 0, 100, 30), "right", 4, viewport).side, "left");
});

test("place: stays put when neither side fits, and is clamped into the viewport", () => {
  const tall = rect(0, 0, 900, 900);
  const p = ui.place(rect(10, 290, 20, 20), tall, "bottom", 4, viewport);
  assert.equal(p.side, "bottom");
  assert.equal(p.x, 0, "never off the left edge");
  const edge = ui.place(rect(780, 100, 20, 20), rect(0, 0, 100, 30), "bottom", 4, viewport);
  assert.equal(edge.x, 700, "never off the right edge");
});
