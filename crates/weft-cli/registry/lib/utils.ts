export type ClassValue = string | number | null | undefined | false | ClassValue[] | Record<string, unknown>;

function flatten(input: unknown, out: string[]): void {
  if (!input && input !== 0) return;
  if (typeof input === "string" || typeof input === "number") {
    for (const c of String(input).split(/\s+/)) if (c) out.push(c);
  } else if (Array.isArray(input)) {
    for (const i of input) flatten(i, out);
  } else if (typeof input === "object") {
    for (const [k, v] of Object.entries(input)) if (v) flatten(k, out);
  }
}

const SPACE = String.raw`(?:\d+(?:\.\d+)?|\d+\/\d+|px|auto|full|\[.+\]|\(.+\))$`;
const GROUPS: [RegExp, string | ((m: RegExpExecArray) => string)][] = [
  [/^(block|inline-block|inline|flex|inline-flex|grid|inline-grid|hidden|contents|table|table-row|table-cell|flow-root|list-item)$/, "display"],
  [/^(static|fixed|absolute|relative|sticky)$/, "position"],
  [/^(visible|invisible|collapse)$/, "visibility"],
  [new RegExp(`^-?p([xytrblse]?)-${SPACE}`), (m) => `p${m[1]}`],
  [new RegExp(`^-?m([xytrblse]?)-${SPACE}`), (m) => `m${m[1]}`],
  [new RegExp(`^gap(-[xy])?-${SPACE}`), (m) => `gap${m[1] ?? ""}`],
  [new RegExp(`^-?space-([xy])-${SPACE}`), (m) => `space-${m[1]}`],
  [/^(min-w|max-w|min-h|max-h|w|h|size|basis)-/, (m) => m[1]],
  [new RegExp(`^-?(inset-x|inset-y|inset|top|right|bottom|left|start|end)-${SPACE}`), (m) => m[1]],
  [/^-?z-/, "z"],
  [/^text-(xs|sm|base|lg|\d?xl)$/, "text-size"],
  [/^text-\[(\d|length:)/, "text-size"],
  [/^text-(left|center|right|justify|start|end)$/, "text-align"],
  [/^text-(ellipsis|clip)$/, "text-overflow"],
  [/^text-/, "text-color"],
  [/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/, "font-weight"],
  [/^font-/, "font-family"],
  [/^leading-/, "leading"],
  [/^tracking-/, "tracking"],
  [/^(uppercase|lowercase|capitalize|normal-case)$/, "case"],
  [/^(underline|overline|line-through|no-underline)$/, "decoration"],
  [/^(italic|not-italic)$/, "font-style"],
  [/^whitespace-/, "whitespace"],
  [/^(truncate|line-clamp-)/, "clamp"],
  [/^bg-(fixed|local|scroll)$/, "bg-attachment"],
  [/^bg-(cover|contain|auto)$/, "bg-size"],
  [/^bg-(none|linear|radial|conic|gradient)/, "bg-image"],
  [/^bg-/, "bg-color"],
  [/^(from|via|to)-/, (m) => `gradient-${m[1]}`],
  [/^rounded(-(t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee))?(-|$)/, (m) => `rounded${m[1] ?? ""}`],
  [/^border(-[xytrblse])?(-\d+)?$/, (m) => `border-w${m[1] ?? ""}`],
  [/^border(-[xytrblse])?-\[\d/, (m) => `border-w${m[1] ?? ""}`],
  [/^border-(solid|dashed|dotted|double|hidden|none)$/, "border-style"],
  [/^border(-[xytrblse])?-/, (m) => `border-color${m[1] ?? ""}`],
  [/^outline(-\d+)?$/, "outline-w"],
  [/^outline-(solid|dashed|dotted|double|none|hidden)$/, "outline-style"],
  [/^outline-offset-/, "outline-offset"],
  [/^outline-/, "outline-color"],
  [/^ring(-\d+)?$/, "ring-w"],
  [/^ring-offset-\d/, "ring-offset-w"],
  [/^ring-offset-/, "ring-offset-color"],
  [/^ring-/, "ring-color"],
  [/^shadow(-(2xs|xs|sm|md|lg|xl|2xl|none|inner))?$/, "shadow"],
  [/^shadow-/, "shadow-color"],
  [/^opacity-/, "opacity"],
  [/^cursor-/, "cursor"],
  [/^overflow(-[xy])?-/, (m) => `overflow${m[1] ?? ""}`],
  [/^items-/, "items"],
  [/^justify-(items|self)-/, (m) => `justify-${m[1]}`],
  [/^justify-/, "justify"],
  [/^self-/, "self"],
  [/^content-/, "content"],
  [/^flex-(row|row-reverse|col|col-reverse)$/, "flex-direction"],
  [/^flex-(wrap|wrap-reverse|nowrap)$/, "flex-wrap"],
  [/^flex-/, "flex"],
  [/^(grow|shrink)(-|$)/, (m) => m[1]],
  [/^order-/, "order"],
  [/^grid-cols-/, "grid-cols"],
  [/^grid-rows-/, "grid-rows"],
  [/^col-/, "col"],
  [/^row-/, "row"],
  [/^(transition|duration|ease|delay|animate)(-|$)/, (m) => m[1]],
  [/^-?(translate-[xy]|scale|rotate|skew-[xy])-/, (m) => m[1]],
  [/^object-(contain|cover|fill|none|scale-down)$/, "object-fit"],
  [/^aspect-/, "aspect"],
  [/^pointer-events-/, "pointer-events"],
  [/^select-/, "select"],
  [/^fill-/, "fill"],
  [/^stroke-\d/, "stroke-w"],
  [/^stroke-/, "stroke"],
];

const OVERRIDES: Record<string, string[]> = {
  p: ["px", "py", "pt", "pr", "pb", "pl", "ps", "pe"],
  px: ["pl", "pr", "ps", "pe"],
  py: ["pt", "pb"],
  m: ["mx", "my", "mt", "mr", "mb", "ml", "ms", "me"],
  mx: ["ml", "mr", "ms", "me"],
  my: ["mt", "mb"],
  gap: ["gap-x", "gap-y"],
  size: ["w", "h"],
  inset: ["inset-x", "inset-y", "top", "right", "bottom", "left", "start", "end"],
  "inset-x": ["left", "right", "start", "end"],
  "inset-y": ["top", "bottom"],
  rounded: ["rounded-t", "rounded-b", "rounded-l", "rounded-r", "rounded-s", "rounded-e", "rounded-tl", "rounded-tr", "rounded-bl", "rounded-br"],
  "border-w": ["border-w-x", "border-w-y", "border-w-t", "border-w-r", "border-w-b", "border-w-l", "border-w-s", "border-w-e"],
  "border-color": ["border-color-x", "border-color-y", "border-color-t", "border-color-r", "border-color-b", "border-color-l"],
  overflow: ["overflow-x", "overflow-y"],
};

function group(utility: string): string {
  for (const [re, g] of GROUPS) {
    const m = re.exec(utility);
    if (m) return typeof g === "string" ? g : g(m);
  }
  return utility;
}

function parse(cls: string): { variants: string; utility: string } {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < cls.length; i += 1) {
    const ch = cls[i];
    if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth -= 1;
    else if (ch === ":" && depth === 0) cut = i;
  }
  const variants = cut >= 0 ? cls.slice(0, cut + 1) : "";
  let utility = cut >= 0 ? cls.slice(cut + 1) : cls;
  let important = "";
  if (utility.startsWith("!")) {
    important = "!";
    utility = utility.slice(1);
  } else if (utility.endsWith("!")) {
    important = "!";
    utility = utility.slice(0, -1);
  }
  return { variants: variants + important, utility };
}

export function cn(...inputs: unknown[]): string {
  const classes: string[] = [];
  flatten(inputs, classes);
  const kept: { cls: string; key: string; variants: string; group: string }[] = [];
  for (const cls of classes) {
    const { variants, utility } = parse(cls);
    const g = group(utility);
    const narrower = OVERRIDES[g] ?? [];
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      const k = kept[i];
      if (k.variants === variants && (k.group === g || narrower.includes(k.group))) kept.splice(i, 1);
    }
    kept.push({ cls, key: variants + g, variants, group: g });
  }
  return kept.map((k) => k.cls).join(" ");
}

type VariantTable = Record<string, Record<string, ClassValue>>;
type Choice<V extends VariantTable> = { [K in keyof V]?: keyof V[K] | null };

export function variants<V extends VariantTable>(base: ClassValue, table: V, defaults: Choice<V> = {}) {
  return (choice: Choice<V> = {}, ...extra: unknown[]): string => {
    const picked: unknown[] = [];
    for (const key of Object.keys(table) as (keyof V)[]) {
      const value = choice[key] === undefined ? defaults[key] : choice[key];
      if (value !== null && value !== undefined) picked.push(table[key][value as string]);
    }
    return cn(base, picked, extra);
  };
}
