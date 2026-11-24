export interface ThemeDef {
  scheme: "light" | "dark";
  tokens: Record<string, string>;
}

export interface ThemeConfig<N extends string> {
  themes: Record<N, ThemeDef>;
  light: NoInfer<N>;
  dark: NoInfer<N>;
  default?: NoInfer<N> | "system";
  shared?: Record<string, string>;
  cookie?: string;
}

export interface ThemeOverrides<N extends string = string> {
  shared?: Record<string, string>;
  themes?: Partial<Record<N, Record<string, string>>>;
}

export interface Theme<N extends string = string> {
  readonly names: readonly N[];
  readonly tokens: readonly string[];
  readonly cookie: string;
  readonly default: N | "system";
  css(): string;
  tailwind(): string;
  fromRequest(req: Request): N | "system";
  htmlAttributes(req: Request): Record<string, string>;
  overrides(o: ThemeOverrides<N> | null | undefined): string;
}

export class ThemeError extends Error {}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const UNSAFE_VALUE = /[;{}<>\\]|\/\*|^\s*$/;
const RADIUS = "radius";
const PREFIXED: [string, string][] = [
  ["font-", "font"],
  ["shadow-", "shadow"],
  ["spacing", "spacing"],
];

function checkTokens(where: string, tokens: Record<string, string>): void {
  for (const [name, value] of Object.entries(tokens)) {
    if (!NAME.test(name)) throw new ThemeError(`${where}: token name ${JSON.stringify(name)} is not a-z, 0-9 and -`);
    if (typeof value !== "string" || UNSAFE_VALUE.test(value)) {
      throw new ThemeError(`${where}: token ${name} must be one CSS value (no ; { } < > \\ or comments)`);
    }
  }
}

function block(selector: string, tokens: Record<string, string>, scheme?: string): string {
  const decls = Object.entries(tokens).map(([k, v]) => `  --${k}: ${v};`);
  if (scheme) decls.push(`  color-scheme: ${scheme};`);
  return `${selector} {\n${decls.join("\n")}\n}\n`;
}

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function defineTheme<N extends string>(config: ThemeConfig<N>): Theme<N> {
  const names = Object.keys(config.themes) as N[];
  if (names.length === 0) throw new ThemeError("defineTheme: no themes");
  for (const n of names) {
    if (!NAME.test(n) || n === "system") {
      throw new ThemeError(`defineTheme: theme name ${JSON.stringify(n)} must be a-z, 0-9 and - (and not "system")`);
    }
    const def = config.themes[n];
    if (def.scheme !== "light" && def.scheme !== "dark") {
      throw new ThemeError(`defineTheme: theme ${n} needs scheme "light" or "dark"`);
    }
    checkTokens(`theme ${n}`, def.tokens);
  }
  checkTokens("shared", config.shared ?? {});
  for (const key of ["light", "dark"] as const) {
    if (!names.includes(config[key])) throw new ThemeError(`defineTheme: ${key} must name a theme`);
  }
  const fallback = config.default ?? "system";
  if (fallback !== "system" && !names.includes(fallback)) {
    throw new ThemeError("defineTheme: default must name a theme or be \"system\"");
  }
  const cookie = config.cookie ?? "weft-theme";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cookie)) throw new ThemeError("defineTheme: cookie is not a valid cookie name");

  const shared = config.shared ?? {};
  const all = (n: N) => ({ ...shared, ...config.themes[n].tokens });
  const tokenNames = [...new Set([...Object.keys(shared), ...names.flatMap((n) => Object.keys(config.themes[n].tokens))])];
  const darkNames = names.filter((n) => config.themes[n].scheme === "dark");

  const known = new Set(tokenNames);
  const checkKnown = (where: string, tokens: Record<string, string>) => {
    checkTokens(where, tokens);
    for (const name of Object.keys(tokens)) {
      if (!known.has(name)) throw new ThemeError(`${where}: ${JSON.stringify(name)} is not a token of this theme`);
    }
  };

  return Object.freeze({
    names,
    tokens: Object.freeze([...tokenNames]),
    cookie,
    default: fallback,
    css() {
      const light = config.light;
      const dark = config.dark;
      let out = block(":root", all(light), "light");
      for (const n of names) out += block(`:root[data-theme="${n}"]`, all(n), config.themes[n].scheme);
      out += `@media (prefers-color-scheme: dark) {\n${block(
        ':root:not([data-theme]), :root[data-theme="system"]',
        all(dark),
        "dark",
      )}}\n`;
      return out;
    },
    tailwind() {
      const sel = darkNames.flatMap((n) => [`[data-theme="${n}"]`, `[data-theme="${n}"] *`]).join(", ");
      let out = "@custom-variant dark {\n";
      if (sel) out += `  &:where(${sel}) {\n    @slot;\n  }\n`;
      out +=
        "  @media (prefers-color-scheme: dark) {\n" +
        '    &:where(:root:not([data-theme]), :root:not([data-theme]) *, [data-theme="system"], [data-theme="system"] *) {\n' +
        "      @slot;\n    }\n  }\n}\n";
      const lines: string[] = [];
      for (const t of tokenNames) {
        if (t === RADIUS) {
          lines.push(
            "  --radius-sm: calc(var(--radius) - 4px);",
            "  --radius-md: calc(var(--radius) - 2px);",
            "  --radius-lg: var(--radius);",
            "  --radius-xl: calc(var(--radius) + 4px);",
          );
          continue;
        }
        const prefixed = PREFIXED.find(([p]) => t.startsWith(p));
        lines.push(prefixed ? `  --${t}: var(--${t});` : `  --color-${t}: var(--${t});`);
      }
      out += `@theme inline {\n${lines.join("\n")}\n}\n`;
      return out;
    },
    fromRequest(req: Request): N | "system" {
      const v = cookieValue(req.headers.get("cookie"), cookie);
      return v === "system" || (v !== undefined && (names as string[]).includes(v)) ? (v as N | "system") : fallback;
    },
    htmlAttributes(req: Request): Record<string, string> {
      return { "data-theme": this.fromRequest(req) };
    },
    overrides(o: ThemeOverrides<N> | null | undefined): string {
      if (o === null || o === undefined) return "";
      if (typeof o !== "object") throw new ThemeError("theme overrides: an object of shared and per-theme tokens");
      const sharedOver = o.shared ?? {};
      checkKnown("overrides.shared", sharedOver);
      const per = (o.themes ?? {}) as Partial<Record<string, Record<string, string>>>;
      for (const [n, tokens] of Object.entries(per)) {
        if (!(names as string[]).includes(n)) throw new ThemeError(`overrides.themes: ${JSON.stringify(n)} is not a theme`);
        checkKnown(`overrides.themes.${n}`, tokens ?? {});
      }
      const of = (n: N) => ({ ...sharedOver, ...(per[n] ?? {}) });
      const blocks: string[] = [];
      const add = (selector: string, tokens: Record<string, string>) => {
        if (Object.keys(tokens).length > 0) blocks.push(block(selector, tokens));
      };
      add(":root:root", of(config.light));
      for (const n of names) add(`:root:root[data-theme="${n}"]`, of(n));
      const dark = of(config.dark);
      if (Object.keys(dark).length > 0) {
        blocks.push(`@media (prefers-color-scheme: dark) {\n${block(':root:root:not([data-theme]), :root:root[data-theme="system"]', dark)}}\n`);
      }
      return blocks.join("");
    },
  });
}

export function isTheme(value: unknown): value is Theme {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Theme).css === "function" &&
    typeof (value as Theme).tailwind === "function" &&
    typeof (value as Theme).htmlAttributes === "function"
  );
}

export const shadcnTokens = {
  shared: { radius: "0.625rem" },
  light: {
    background: "oklch(1 0 0)",
    foreground: "oklch(0.145 0 0)",
    card: "oklch(1 0 0)",
    "card-foreground": "oklch(0.145 0 0)",
    popover: "oklch(1 0 0)",
    "popover-foreground": "oklch(0.145 0 0)",
    primary: "oklch(0.205 0 0)",
    "primary-foreground": "oklch(0.985 0 0)",
    secondary: "oklch(0.97 0 0)",
    "secondary-foreground": "oklch(0.205 0 0)",
    muted: "oklch(0.97 0 0)",
    "muted-foreground": "oklch(0.556 0 0)",
    accent: "oklch(0.97 0 0)",
    "accent-foreground": "oklch(0.205 0 0)",
    destructive: "oklch(0.577 0.245 27.325)",
    "destructive-foreground": "oklch(0.985 0 0)",
    border: "oklch(0.922 0 0)",
    input: "oklch(0.922 0 0)",
    ring: "oklch(0.708 0 0)",
    "chart-1": "oklch(0.646 0.222 41.116)",
    "chart-2": "oklch(0.6 0.118 184.704)",
    "chart-3": "oklch(0.398 0.07 227.392)",
    "chart-4": "oklch(0.828 0.189 84.429)",
    "chart-5": "oklch(0.769 0.188 70.08)",
    sidebar: "oklch(0.985 0 0)",
    "sidebar-foreground": "oklch(0.145 0 0)",
    "sidebar-primary": "oklch(0.205 0 0)",
    "sidebar-primary-foreground": "oklch(0.985 0 0)",
    "sidebar-accent": "oklch(0.97 0 0)",
    "sidebar-accent-foreground": "oklch(0.205 0 0)",
    "sidebar-border": "oklch(0.922 0 0)",
    "sidebar-ring": "oklch(0.708 0 0)",
  },
  dark: {
    background: "oklch(0.145 0 0)",
    foreground: "oklch(0.985 0 0)",
    card: "oklch(0.205 0 0)",
    "card-foreground": "oklch(0.985 0 0)",
    popover: "oklch(0.205 0 0)",
    "popover-foreground": "oklch(0.985 0 0)",
    primary: "oklch(0.922 0 0)",
    "primary-foreground": "oklch(0.205 0 0)",
    secondary: "oklch(0.269 0 0)",
    "secondary-foreground": "oklch(0.985 0 0)",
    muted: "oklch(0.269 0 0)",
    "muted-foreground": "oklch(0.708 0 0)",
    accent: "oklch(0.269 0 0)",
    "accent-foreground": "oklch(0.985 0 0)",
    destructive: "oklch(0.704 0.191 22.216)",
    "destructive-foreground": "oklch(0.985 0 0)",
    border: "oklch(1 0 0 / 10%)",
    input: "oklch(1 0 0 / 15%)",
    ring: "oklch(0.556 0 0)",
    "chart-1": "oklch(0.488 0.243 264.376)",
    "chart-2": "oklch(0.696 0.17 162.48)",
    "chart-3": "oklch(0.769 0.188 70.08)",
    "chart-4": "oklch(0.627 0.265 303.9)",
    "chart-5": "oklch(0.645 0.246 16.439)",
    sidebar: "oklch(0.205 0 0)",
    "sidebar-foreground": "oklch(0.985 0 0)",
    "sidebar-primary": "oklch(0.488 0.243 264.376)",
    "sidebar-primary-foreground": "oklch(0.985 0 0)",
    "sidebar-accent": "oklch(0.269 0 0)",
    "sidebar-accent-foreground": "oklch(0.985 0 0)",
    "sidebar-border": "oklch(1 0 0 / 10%)",
    "sidebar-ring": "oklch(0.556 0 0)",
  },
} as const;

export function shadcnTheme(overrides: Partial<ThemeConfig<"light" | "dark">> = {}): Theme<"light" | "dark"> {
  return defineTheme<"light" | "dark">({
    shared: { ...shadcnTokens.shared },
    themes: {
      light: { scheme: "light", tokens: { ...shadcnTokens.light } },
      dark: { scheme: "dark", tokens: { ...shadcnTokens.dark } },
    },
    light: "light",
    dark: "dark",
    ...overrides,
  });
}
