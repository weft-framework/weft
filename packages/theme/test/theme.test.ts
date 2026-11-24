import { test } from "node:test";
import assert from "node:assert/strict";
import { ThemeError, defineTheme, isTheme, shadcnTheme, shadcnTokens } from "../src/index.ts";

const config = {
  shared: { radius: "0.5rem", "font-sans": "Inter, sans-serif" },
  themes: {
    light: { scheme: "light" as const, tokens: { background: "#fff", foreground: "#111" } },
    dark: { scheme: "dark" as const, tokens: { background: "#111", foreground: "#eee" } },
    ocean: { scheme: "dark" as const, tokens: { background: "#012", foreground: "#cef", radius: "1rem" } },
  },
  light: "light" as const,
  dark: "dark" as const,
};

const req = (cookie?: string) => new Request("http://x.test/", cookie ? { headers: { cookie } } : {});

test("css: the light theme on :root, each theme by name, dark for system", () => {
  const css = defineTheme(config).css();
  assert.match(css, /^:root \{\n {2}--radius: 0\.5rem;\n {2}--font-sans: Inter, sans-serif;\n {2}--background: #fff;\n {2}--foreground: #111;\n {2}color-scheme: light;\n\}/);
  assert.match(css, /:root\[data-theme="ocean"\] \{[^}]*--radius: 1rem;[^}]*--background: #012;[^}]*color-scheme: dark;/);
  assert.match(
    css,
    /@media \(prefers-color-scheme: dark\) \{\n:root:not\(\[data-theme\]\), :root\[data-theme="system"\] \{[^}]*--background: #111;/,
  );
});

test("tailwind: tokens become utilities, dark follows the chosen theme", () => {
  const tw = defineTheme(config).tailwind();
  assert.ok(tw.includes("  --color-background: var(--background);"), tw);
  assert.ok(tw.includes("  --font-sans: var(--font-sans);"), "font tokens keep their namespace");
  assert.ok(tw.includes("  --radius-lg: var(--radius);") && tw.includes("--radius-sm: calc(var(--radius) - 4px);"));
  assert.ok(!tw.includes("--color-radius"), tw);
  assert.ok(tw.includes('&:where([data-theme="dark"], [data-theme="dark"] *, [data-theme="ocean"], [data-theme="ocean"] *)'), tw);
  assert.ok(tw.includes("@media (prefers-color-scheme: dark)"), "system follows the OS");
});

test("the cookie picks a configured theme; anything else is the default", () => {
  const theme = defineTheme({ ...config, default: "light" });
  assert.equal(theme.fromRequest(req()), "light");
  assert.equal(theme.fromRequest(req("a=1; weft-theme=ocean")), "ocean");
  assert.equal(theme.fromRequest(req("weft-theme=system")), "system");
  assert.equal(theme.fromRequest(req('weft-theme="><script>')), "light");
  assert.equal(theme.fromRequest(req("weft-theme=constructor")), "light");
  assert.deepEqual(theme.htmlAttributes(req("weft-theme=dark")), { "data-theme": "dark" });
  const custom = defineTheme({ ...config, cookie: "look" });
  assert.equal(custom.fromRequest(req("weft-theme=dark; look=ocean")), "ocean");
  assert.equal(custom.default, "system");
});

test("a config cannot write CSS beyond its token values", () => {
  const bad = (patch: object, msg: RegExp) =>
    assert.throws(() => defineTheme({ ...config, ...patch } as typeof config), (e: unknown) => e instanceof ThemeError && msg.test(String(e)));
  const withLight = (tokens: Record<string, string>) => ({
    themes: { ...config.themes, light: { scheme: "light" as const, tokens } },
  });
  bad(withLight({ background: "red; } body { display: none" }), /one CSS value/);
  bad(withLight({ background: "red</style><script>" }), /one CSS value/);
  bad(withLight({ background: "/* x */ red" }), /one CSS value/);
  bad(withLight({ "Back ground": "red" }), /token name/);
  bad({ themes: { ...config.themes, 'x"]{}': config.themes.light } }, /theme name/);
  bad({ themes: { ...config.themes, system: config.themes.light } }, /theme name/);
  bad({ light: "nope" }, /light must name a theme/);
  bad({ default: "nope" }, /default must name/);
  bad({ cookie: "a b" }, /cookie/);
});

test("the shadcn theme carries shadcn's token names", () => {
  const theme = shadcnTheme({ default: "dark" });
  assert.ok(isTheme(theme) && !isTheme({ css: 1 }));
  assert.deepEqual([...theme.names], ["light", "dark"]);
  const tw = theme.tailwind();
  for (const name of Object.keys(shadcnTokens.light)) {
    assert.ok(tw.includes(`--color-${name}: var(--${name});`), name);
  }
  assert.ok(theme.css().includes("--destructive: oklch(0.704 0.191 22.216);"));
  assert.equal(theme.fromRequest(req()), "dark");
});

test("per-request overrides outrank the base theme and stay within known tokens", () => {
  const theme = defineTheme(config);
  assert.equal(theme.overrides(null), "");
  assert.equal(theme.overrides({}), "");
  const css = theme.overrides({ shared: { radius: "0" }, themes: { dark: { background: "#000" } } });
  assert.equal(
    css,
    ":root:root {\n  --radius: 0;\n}\n" +
      ':root:root[data-theme="light"] {\n  --radius: 0;\n}\n' +
      ':root:root[data-theme="dark"] {\n  --radius: 0;\n  --background: #000;\n}\n' +
      ':root:root[data-theme="ocean"] {\n  --radius: 0;\n}\n' +
      '@media (prefers-color-scheme: dark) {\n:root:root:not([data-theme]), :root:root[data-theme="system"] {\n  --radius: 0;\n  --background: #000;\n}\n}\n',
  );
  assert.deepEqual([...theme.tokens].sort(), ["background", "font-sans", "foreground", "radius"]);
  assert.throws(() => theme.overrides({ shared: { primary: "red" } }), /not a token of this theme/);
  assert.throws(() => theme.overrides({ themes: { nope: { background: "#000" } } as never }), /not a theme/);
  assert.throws(() => theme.overrides({ shared: { background: "red;}body{display:none" } }), ThemeError);
  assert.throws(() => theme.overrides({ shared: { background: "</style><script>" } }), ThemeError);
});
