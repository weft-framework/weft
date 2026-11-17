import { test } from "node:test";
import assert from "node:assert/strict";
import { allStyles, applyCssVars, cssVars, defineComponent } from "../src/index.ts";
import { h } from "../testing/fakedom.ts";

test("defining a styled component adds its stylesheet to the bundle once", () => {
  const css = ".a:where(.w-x){color:red}";
  const A = defineComponent("A", () => ({ handlers: {}, render: () => "" }), { css });
  defineComponent("A2", () => ({ handlers: {}, render: () => "" }), { css });
  assert.equal(A.def.css, css);
  assert.equal(allStyles().split(css).length - 1, 1, "deduplicated by content");
  const B = defineComponent("B", () => ({ handlers: {}, render: () => "" }));
  assert.equal(B.def.css, undefined);
});

test("cssVars renders set values as escaped JSON custom properties", () => {
  assert.equal(
    cssVars("w-x", ["red", 0, null, undefined, false, `"><x>`]),
    ` data-weft-vars="{&quot;--w-x-0&quot;:&quot;red&quot;,&quot;--w-x-1&quot;:&quot;0&quot;,&quot;--w-x-5&quot;:&quot;\\&quot;&gt;&lt;x&gt;&quot;}"`,
  );
});

test("applyCssVars sets custom properties through the CSSOM only", () => {
  const set: [string, string][] = [];
  const el = h("div", { "data-weft-vars": JSON.stringify({ "--w-x-0": "red", color: "blue", "--w-x-1": 3 }) });
  const broken = h("p", { "data-weft-vars": "{not json" });
  Object.assign(el, { style: { setProperty: (k: string, v: string) => set.push([k, v]) } });
  Object.assign(broken, { style: { setProperty: () => assert.fail("not applied") } });
  const root = h("main", {}, el, broken);
  applyCssVars(root as never);
  assert.deepEqual(set, [["--w-x-0", "red"]], "only string custom properties");
});
