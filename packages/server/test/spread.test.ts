import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { restProps, spreadAttrs, type Component } from "@weft/runtime";
import { createApp } from "../src/app.ts";
import { compileFile, findCompiler } from "../src/compiler.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://app.test";
const SECRET = "spread-test-secret-0123456789abcdef";

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SOURCE = `
export function cls(...parts: unknown[]): string {
  return parts.filter((p) => typeof p === "string" && p !== "").join(" ")
}

component Button(variant?: "default" | "outline", children: Html, ...attrs: Attrs) {
  view {
    <button type="button" class={cls("btn", variant ?? "default", attrs.class)} {...attrs}>{children}</button>
  }
}

component Page(evil: Record<string, string>) {
  view {
    <main>
      <Button id="save" aria-label="Save it" disabled data-x="1" class="wide" variant="outline">Save</Button>
      <Button {...evil}>Evil</Button>
      <a {...evil}>link</a>
    </main>
  }
}
`;

test("rest props pass through; spreads render only safe attributes", { skip: !hasCargo() }, async () => {
  const dir = join(here, ".weft", "spread");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Spread.wx"), SOURCE);
  const ts = join(dir, "Spread.ts");
  writeFileSync(ts, compileFile(findCompiler(here), join(dir, "Spread.wx")));
  const { Page } = (await import(pathToFileURL(ts).href)) as { Page: Component<object> };
  const app = createApp({
    secret: SECRET,
    sync: false,
    transports: [],
    routes: { "/": { component: Page as never, load: (ctx) => ({ evil: Object.fromEntries(ctx.query) }) } },
  });
  const render = async (query: Record<string, string>) => {
    const res = (await app.fetch(new Request(`${ORIGIN}/?${new URLSearchParams(query)}`)))!;
    assert.equal(res.status, 200);
    const html = await res.text();
    return html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
  };

  const ok = await render({});
  assert.ok(
    ok.includes(
      '<button type="button" class="btn outline wide" id="save" aria-label="Save it" disabled data-x="1">Save</button>',
    ),
    ok,
  );
  assert.ok(!/variant=|children=/.test(ok), "named props are not attributes");

  const main = await render({
    onclick: "alert(1)",
    OnMouseOver: "alert(2)",
    href: "javascript:alert(3)",
    srcdoc: "<script>alert(4)</script>",
    "data-weft-on-click": "remove",
    'x" onfocus="alert(5)': "1",
    "a b": "1",
    title: '"><script>alert(6)</script>',
    type: "submit",
    class: "injected",
  });
  assert.ok(!/\son\w+=/i.test(main), main);
  assert.ok(!main.includes("javascript:"), main);
  assert.ok(!main.includes("srcdoc"), main);
  assert.ok(!main.includes("data-weft-on-click"), main);
  assert.ok(!main.includes("<script>"), main);
  assert.ok(main.includes('href="about:invalid#weft-blocked"'), "URL attributes go through safeUrl");
  assert.ok(main.includes('title="&quot;&gt;&lt;script&gt;alert(6)&lt;/script&gt;"'), main);
  assert.ok(main.includes('<button type="button" class="btn default injected"'), main);
  const evilButton = /<button[^>]*>Evil/.exec(main)?.[0] ?? "";
  assert.equal((evilButton.match(/type=/g) ?? []).length, 1, evilButton);
});

test("spreadAttrs and restProps", () => {
  assert.equal(spreadAttrs({ a: 1, b: true, c: false, d: null, e: undefined, f: () => 1 }), ' a="1" b');
  assert.equal(spreadAttrs({ id: "x", ID: "y" }, ["id"]), "", "written names are skipped, any case");
  assert.equal(spreadAttrs(null), "");
  assert.equal(spreadAttrs({ "data-weft-message": "m" }), ' data-weft-message="m"');
  assert.equal(spreadAttrs({ src: "data:image/png;base64,AA" }), ' src="data:image/png;base64,AA"');

  const props: Record<string, unknown> = { variant: "a", children: "c", id: "one" };
  const rest = restProps<Record<string, unknown>>(props, ["variant"]);
  assert.deepEqual({ ...rest }, { id: "one" });
  assert.equal(rest.variant, undefined);
  props.title = "later";
  delete props.id;
  assert.deepEqual(Object.keys(rest), ["title"], "a live view of the props");
  assert.ok("title" in rest && !("children" in rest));
});
