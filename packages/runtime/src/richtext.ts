import { escapeAttr, escapeHtml, trustHtml, type Html } from "./escape.ts";

export type RichMark = "bold" | "italic" | "underline" | "strike" | "code";

export type RichInline =
  | { type: "text"; text: string; marks?: RichMark[]; href?: string }
  | { type: "mention"; id: string; label: string }
  | { type: "break" };

export type RichBlock =
  | { type: "paragraph"; content: RichInline[] }
  | { type: "heading"; level: 1 | 2 | 3; content: RichInline[] }
  | { type: "quote"; content: RichBlock[] }
  | { type: "list"; ordered: boolean; items: RichBlock[][] }
  | { type: "code"; text: string }
  | { type: "image"; src: string; alt: string }
  | { type: "rule" };

export interface RichDoc {
  type: "doc";
  content: RichBlock[];
}

export interface RichTextLimits {
  maxBlocks?: number;
  maxText?: number;
  maxDepth?: number;
  maxMentions?: number;
  allow?: {
    headings?: boolean;
    lists?: boolean;
    quotes?: boolean;
    code?: boolean;
    images?: boolean;
    links?: boolean;
    mentions?: boolean;
    marks?: readonly RichMark[];
  };
}

export type RichTextResult = { ok: true; doc: RichDoc } | { ok: false; error: string };

const MARKS: readonly RichMark[] = ["bold", "italic", "underline", "strike", "code"];
const MENTION_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const STRIP = /[\u0000-\u0008\u000b-\u001f\u007f\ufdd0-\ufdef\ufffe\uffff]/g;

export function richLink(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const s = href.trim();
  if (s === "" || s.length > 2048 || /[\u0000- \u007f]/.test(s)) return null;
  if (s.startsWith("#")) return s;
  if (s.startsWith("/")) return s.startsWith("//") || s.startsWith("/\\") ? null : s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:" ? s : null;
}

class Invalid extends Error {}

export function parseRichText(input: unknown, limits: RichTextLimits = {}): RichTextResult {
  const maxBlocks = limits.maxBlocks ?? 2000;
  const maxText = limits.maxText ?? 100_000;
  const maxDepth = limits.maxDepth ?? 4;
  const maxMentions = limits.maxMentions ?? 100;
  const allow = limits.allow ?? {};
  const on = (k: Exclude<keyof NonNullable<RichTextLimits["allow"]>, "marks">) => allow[k] !== false;
  const marksAllowed = new Set(allow.marks ?? MARKS);
  let blocks = 0;
  let chars = 0;
  let mentions = 0;

  const fail = (msg: string): never => {
    throw new Invalid(msg);
  };
  const obj = (v: unknown, what: string): Record<string, unknown> => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) fail(`${what} is not an object`);
    return v as Record<string, unknown>;
  };
  const keys = (o: Record<string, unknown>, allowed: string[], what: string) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${what}: unknown property ${JSON.stringify(k).slice(0, 40)}`);
  };
  const arr = (v: unknown, what: string): unknown[] => {
    if (!Array.isArray(v)) fail(`${what} is not a list`);
    return v as unknown[];
  };
  const text = (v: unknown, what: string): string => {
    if (typeof v !== "string") fail(`${what} is not text`);
    const s = (v as string).replace(STRIP, "");
    chars += s.length;
    if (chars > maxText) fail(`more than ${maxText} characters`);
    return s;
  };

  const inlines = (v: unknown): RichInline[] => {
    const out: RichInline[] = [];
    for (const raw of arr(v, "content")) {
      const n = obj(raw, "inline");
      switch (n.type) {
        case "text": {
          keys(n, ["type", "text", "marks", "href"], "text");
          const marks = n.marks === undefined ? [] : arr(n.marks, "marks");
          for (const m of marks) if (!MARKS.includes(m as RichMark) || !marksAllowed.has(m as RichMark)) fail(`mark ${String(m)} not allowed`);
          const sorted = MARKS.filter((m) => marks.includes(m));
          let href: string | undefined;
          if (n.href !== undefined) {
            if (!on("links")) fail("links not allowed");
            href = richLink(n.href) ?? fail("a link is not http(s), mailto or a path on this site");
          }
          const parts = text(n.text, "text").split(/\r\n?|\n/);
          parts.forEach((p, i) => {
            if (i > 0) out.push({ type: "break" });
            if (p !== "") out.push({ type: "text", text: p, ...(sorted.length ? { marks: sorted } : {}), ...(href ? { href } : {}) });
          });
          break;
        }
        case "mention": {
          if (!on("mentions")) fail("mentions not allowed");
          keys(n, ["type", "id", "label"], "mention");
          if (typeof n.id !== "string" || !MENTION_ID.test(n.id)) fail("a mention has no valid id");
          if (++mentions > maxMentions) fail(`more than ${maxMentions} mentions`);
          const label = text(n.label, "label").replace(/\s+/g, " ").trim().slice(0, 100);
          out.push({ type: "mention", id: n.id as string, label: label || (n.id as string) });
          break;
        }
        case "break":
          keys(n, ["type"], "break");
          out.push({ type: "break" });
          break;
        default:
          fail(`unknown inline ${JSON.stringify(n.type)?.slice(0, 40)}`);
      }
    }
    const merged: RichInline[] = [];
    for (const n of out) {
      const last = merged.at(-1);
      if (n.type === "text" && last?.type === "text" && last.href === n.href && (last.marks ?? []).join() === (n.marks ?? []).join()) {
        merged[merged.length - 1] = { ...last, text: last.text + n.text };
      } else {
        merged.push(n);
      }
    }
    while (merged.at(-1)?.type === "break") merged.pop();
    return merged;
  };

  const blockList = (v: unknown, depth: number): RichBlock[] => {
    if (depth > maxDepth) fail(`nested more than ${maxDepth} deep`);
    const out: RichBlock[] = [];
    for (const raw of arr(v, "content")) {
      if (++blocks > maxBlocks) fail(`more than ${maxBlocks} blocks`);
      const n = obj(raw, "block");
      switch (n.type) {
        case "paragraph":
          keys(n, ["type", "content"], "paragraph");
          out.push({ type: "paragraph", content: inlines(n.content ?? []) });
          break;
        case "heading": {
          if (!on("headings")) fail("headings not allowed");
          keys(n, ["type", "level", "content"], "heading");
          if (n.level !== 1 && n.level !== 2 && n.level !== 3) fail("a heading level is 1, 2 or 3");
          out.push({ type: "heading", level: n.level as 1 | 2 | 3, content: inlines(n.content ?? []) });
          break;
        }
        case "quote":
          if (!on("quotes")) fail("quotes not allowed");
          keys(n, ["type", "content"], "quote");
          out.push({ type: "quote", content: blockList(n.content, depth + 1) });
          break;
        case "list": {
          if (!on("lists")) fail("lists not allowed");
          keys(n, ["type", "ordered", "items"], "list");
          if (typeof n.ordered !== "boolean") fail("a list is ordered or not");
          const items = arr(n.items, "items").map((item) => blockList(item, depth + 1));
          if (items.length === 0) fail("a list has items");
          out.push({ type: "list", ordered: n.ordered as boolean, items });
          break;
        }
        case "code":
          if (!on("code")) fail("code blocks not allowed");
          keys(n, ["type", "text"], "code");
          out.push({ type: "code", text: text(n.text, "code").replace(/\r\n?/g, "\n") });
          break;
        case "image": {
          if (!on("images")) fail("images not allowed");
          keys(n, ["type", "src", "alt"], "image");
          if (typeof n.src !== "string" || n.src === "" || n.src.length > 2048 || /[\u0000- \u007f]/.test(n.src)) fail("an image has no valid src");
          out.push({ type: "image", src: n.src as string, alt: n.alt === undefined ? "" : text(n.alt, "alt").slice(0, 500) });
          break;
        }
        case "rule":
          keys(n, ["type"], "rule");
          out.push({ type: "rule" });
          break;
        default:
          fail(`unknown block ${JSON.stringify(n.type)?.slice(0, 40)}`);
      }
    }
    return out;
  };

  try {
    let v = input;
    if (typeof v === "string") {
      if (v.length > maxText * 8 + 10_000) fail("the document is too large");
      try {
        v = JSON.parse(v);
      } catch {
        fail("not a document");
      }
    }
    const d = obj(v, "the document");
    keys(d, ["type", "content"], "doc");
    if (d.type !== "doc") fail("not a document");
    return { ok: true, doc: { type: "doc", content: blockList(d.content, 0) } };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    if (err instanceof RangeError) return { ok: false, error: "nested too deep" };
    throw err;
  }
}

export function emptyRichText(): RichDoc {
  return { type: "doc", content: [] };
}

function walkInlines(blocks: RichBlock[], fn: (n: RichInline) => void): void {
  for (const b of blocks) {
    if (b.type === "paragraph" || b.type === "heading") b.content.forEach(fn);
    else if (b.type === "quote") walkInlines(b.content, fn);
    else if (b.type === "list") b.items.forEach((i) => walkInlines(i, fn));
  }
}

export function mentionsIn(doc: RichDoc): string[] {
  const ids = new Set<string>();
  walkInlines(doc.content, (n) => n.type === "mention" && ids.add(n.id));
  return [...ids];
}

export function richTextToPlain(doc: RichDoc): string {
  const lines: string[] = [];
  const inl = (c: RichInline[]) => c.map((n) => (n.type === "text" ? n.text : n.type === "mention" ? `@${n.label}` : "\n")).join("");
  const walk = (blocks: RichBlock[], prefix: string) => {
    for (const b of blocks) {
      if (b.type === "paragraph" || b.type === "heading") lines.push(prefix + inl(b.content));
      else if (b.type === "code") lines.push(prefix + b.text);
      else if (b.type === "image" && b.alt) lines.push(prefix + b.alt);
      else if (b.type === "quote") walk(b.content, prefix + "> ");
      else if (b.type === "list") b.items.forEach((item, i) => walk(item, `${prefix}${b.ordered ? `${i + 1}.` : "-"} `));
    }
  };
  walk(doc.content, "");
  return lines.join("\n").trim();
}

export function isEmptyRichText(doc: RichDoc): boolean {
  return richTextToPlain(doc) === "" && !doc.content.some((b) => b.type === "image" || b.type === "rule");
}

export interface RenderRichTextOptions {
  mention?(id: string, label: string): { label?: string; href?: string } | null | undefined;
  image?(src: string): string | null | undefined;
  headingOffset?: number;
  origin?: string;
}

export function renderRichText(input: RichDoc | string | null | undefined, o: RenderRichTextOptions = {}): Html {
  if (input === null || input === undefined || input === "") return trustHtml("");
  const parsed = parseRichText(input);
  if (!parsed.ok) return trustHtml("");
  const doc = parsed.doc;
  const offset = Math.max(0, Math.min(3, Math.floor(o.headingOffset ?? 0)));
  const image = o.image ?? ((src: string) => (/^https:\/\//i.test(src) ? src : null));

  const link = (href: string, body: string) => {
    const safe = richLink(href);
    if (!safe) return body;
    let external = !safe.startsWith("/") && !safe.startsWith("#");
    if (external && o.origin) {
      try {
        external = new URL(safe).origin !== o.origin;
      } catch {
      }
    }
    return `<a href="${escapeAttr(safe)}"${external ? ` rel="noopener noreferrer nofollow ugc"` : ""}>${body}</a>`;
  };
  const inl = (c: RichInline[]) =>
    c
      .map((n) => {
        if (n.type === "break") return "<br>";
        if (n.type === "mention") {
          const who = o.mention?.(n.id, n.label) ?? null;
          const label = escapeHtml(`@${who?.label ?? n.label}`);
          const attrs = `data-mention="${escapeAttr(n.id)}" data-label="${escapeAttr(n.label)}"`;
          const href = who?.href ? richLink(who.href) : null;
          return href ? `<a href="${escapeAttr(href)}" ${attrs}>${label}</a>` : `<span ${attrs}>${label}</span>`;
        }
        let s = escapeHtml(n.text);
        for (const m of [...(n.marks ?? [])].reverse()) {
          const tag = m === "bold" ? "strong" : m === "italic" ? "em" : m === "underline" ? "u" : m === "strike" ? "s" : "code";
          s = `<${tag}>${s}</${tag}>`;
        }
        return n.href ? link(n.href, s) : s;
      })
      .join("");
  const blocks = (list: RichBlock[]): string =>
    list
      .map((b) => {
        switch (b.type) {
          case "paragraph":
            return `<p>${inl(b.content)}</p>`;
          case "heading": {
            const h = Math.min(6, b.level + offset);
            return `<h${h}>${inl(b.content)}</h${h}>`;
          }
          case "quote":
            return `<blockquote>${blocks(b.content)}</blockquote>`;
          case "list": {
            const tag = b.ordered ? "ol" : "ul";
            return `<${tag}>${b.items.map((i) => `<li>${blocks(i)}</li>`).join("")}</${tag}>`;
          }
          case "code":
            return `<pre><code>${escapeHtml(b.text)}</code></pre>`;
          case "image": {
            const url = image(b.src);
            if (!url || !/^(https?:\/\/|\/(?![/\\]))/i.test(url)) return "";
            return `<img src="${escapeAttr(url)}" alt="${escapeAttr(b.alt)}" data-src="${escapeAttr(b.src)}" loading="lazy">`;
          }
          case "rule":
            return "<hr>";
        }
      })
      .join("");
  return trustHtml(blocks(doc.content));
}

export interface RichDomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly childNodes: ArrayLike<RichDomNode>;
  readonly textContent: string | null;
  getAttribute?(name: string): string | null;
}

const BLOCK_TAGS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "UL", "OL", "LI", "PRE", "HR", "IMG", "TABLE", "SECTION", "ARTICLE", "HEADER", "FOOTER"]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "IFRAME", "OBJECT", "svg", "SVG", "HEAD", "META", "LINK", "TITLE"]);
const MARK_TAGS: Record<string, RichMark> = { B: "bold", STRONG: "bold", I: "italic", EM: "italic", U: "underline", S: "strike", STRIKE: "strike", DEL: "strike", CODE: "code" };

export function fromDom(root: RichDomNode): RichDoc {
  const attr = (n: RichDomNode, a: string) => n.getAttribute?.(a) ?? null;
  const tag = (n: RichDomNode) => n.nodeName.toUpperCase();

  const inline = (n: RichDomNode, marks: RichMark[], href: string | undefined, out: RichInline[]) => {
    if (n.nodeType === 3) {
      const text = (n.textContent ?? "").replace(/[\t\n\r ]+/g, " ");
      if (text) out.push({ type: "text", text, ...(marks.length ? { marks: [...marks] } : {}), ...(href ? { href } : {}) });
      return;
    }
    if (n.nodeType !== 1 || SKIP_TAGS.has(n.nodeName)) return;
    const t = tag(n);
    if (t === "BR") {
      out.push({ type: "break" });
      return;
    }
    const id = attr(n, "data-mention");
    if (id !== null && MENTION_ID.test(id)) {
      out.push({ type: "mention", id, label: attr(n, "data-label") ?? (n.textContent ?? "").replace(/^@/, "") });
      return;
    }
    const m = MARK_TAGS[t];
    const nextMarks = m && !marks.includes(m) ? [...marks, m] : marks;
    const nextHref = t === "A" ? (richLink(attr(n, "href")) ?? href) : href;
    for (const c of Array.from(n.childNodes)) inline(c, nextMarks, nextHref, out);
  };

  const tidy = (c: RichInline[]): RichInline[] => {
    const out = c.map((n) => ({ ...n }));
    const first = out[0];
    if (first?.type === "text") first.text = first.text.replace(/^ +/, "");
    const last = out.at(-1);
    if (last?.type === "text") last.text = last.text.replace(/ +$/, "");
    return out.filter((n) => n.type !== "text" || n.text !== "");
  };

  const blocks = (n: RichDomNode): RichBlock[] => {
    const out: RichBlock[] = [];
    let loose: RichInline[] = [];
    const flush = () => {
      const c = tidy(loose);
      if (c.length && !c.every((x) => x.type === "break")) out.push({ type: "paragraph", content: c });
      loose = [];
    };
    for (const c of Array.from(n.childNodes)) {
      const t = c.nodeType === 1 ? tag(c) : "";
      if (c.nodeType !== 1 || !BLOCK_TAGS.has(t)) {
        inline(c, [], undefined, loose);
        continue;
      }
      flush();
      if (SKIP_TAGS.has(c.nodeName)) continue;
      if (/^H[1-6]$/.test(t)) {
        const content = tidy(collect(c));
        if (content.length) out.push({ type: "heading", level: Math.min(3, Number(t[1])) as 1 | 2 | 3, content });
      } else if (t === "BLOCKQUOTE") {
        const inner = blocks(c);
        if (inner.length) out.push({ type: "quote", content: inner });
      } else if (t === "UL" || t === "OL") {
        const items = Array.from(c.childNodes)
          .filter((li) => li.nodeType === 1 && tag(li) === "LI")
          .map((li) => blocks(li))
          .filter((b) => b.length);
        if (items.length) out.push({ type: "list", ordered: t === "OL", items });
      } else if (t === "PRE") {
        out.push({ type: "code", text: (c.textContent ?? "").replace(/\r\n?/g, "\n").replace(/\n$/, "") });
      } else if (t === "HR") {
        out.push({ type: "rule" });
      } else if (t === "IMG") {
        const src = attr(c, "data-src") ?? attr(c, "src");
        if (src && src.trim().length <= 2048 && !/[\u0000-\u0020\u007f]/.test(src.trim()) && !/^(data|blob|javascript):/i.test(src.trim())) out.push({ type: "image", src: src.trim(), alt: attr(c, "alt") ?? "" });
      } else {
        out.push(...blocks(c));
      }
    }
    flush();
    return out;
  };
  const collect = (n: RichDomNode) => {
    const out: RichInline[] = [];
    for (const c of Array.from(n.childNodes)) inline(c, [], undefined, out);
    return out;
  };

  const r = parseRichText({ type: "doc", content: blocks(root) }, { maxBlocks: Infinity, maxText: Infinity, maxMentions: Infinity, maxDepth: Infinity });
  return r.ok ? r.doc : emptyRichText();
}
