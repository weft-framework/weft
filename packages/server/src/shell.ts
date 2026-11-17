import { escapeAttr } from "@weft-framework/runtime";

export const DEFAULT_SHELL = `<!doctype html>
<html lang="%lang%">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <!--weft:head-->
  </head>
  <body>
    <!--weft:body-->
  </body>
</html>
`;

const HEAD = "<!--weft:head-->";
const BODY = "<!--weft:body-->";
const NONCE = "\u0000weft-nonce\u0000";

export interface Shell {
  render(parts: { lang: string; head: string; body: string; nonce: string; html?: string }): string;
}

export function htmlAttributeMarkup(attrs: Record<string, string | boolean | null | undefined> | undefined): string {
  let out = "";
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || name.startsWith("on")) {
      throw new Error(`htmlAttributes: refused attribute name ${JSON.stringify(name)}`);
    }
    if (name === "lang") continue;
    if (value === true) out += ` ${name}`;
    else if (typeof value === "string") out += ` ${name}="${escapeAttr(value)}"`;
  }
  return out;
}

export function parseShell(source: string = DEFAULT_SHELL): Shell {
  for (const marker of [HEAD, BODY]) {
    const first = source.indexOf(marker);
    if (first < 0) {
      throw new Error(`index.html: missing ${marker}`);
    }
    if (source.indexOf(marker, first + 1) >= 0) {
      throw new Error(`index.html: ${marker} appears more than once`);
    }
  }
  if (source.indexOf(HEAD) > source.indexOf(BODY)) {
    throw new Error(`index.html: ${HEAD} must come before ${BODY}`);
  }
  if (tagHeads(source).some(hasInlineHandler)) {
    throw new Error("index.html: inline event handler attributes are blocked by the CSP; use a <script>");
  }
  if (tagHeads(source).some(hasNonce)) {
    throw new Error("index.html: nonces are added per response; remove the nonce attribute");
  }
  const withNonce = source.replace(/<(script|style)\b/gi, (m) => `${m} nonce="${NONCE}"`);
  const [beforeHead, rest] = splitOnce(withNonce, HEAD);
  const [between, afterBody] = splitOnce(rest, BODY);
  const htmlTag = /<html\b/i.exec(beforeHead);
  const at = htmlTag ? htmlTag.index + htmlTag[0].length : -1;
  return {
    render({ lang, head, body, nonce, html = "" }) {
      const fill = (s: string) => s.split(NONCE).join(escapeAttr(nonce)).split("%lang%").join(escapeAttr(lang));
      const before = html && at >= 0 ? beforeHead.slice(0, at) + html + beforeHead.slice(at) : beforeHead;
      return fill(before) + head + fill(between) + body + fill(afterBody);
    },
  };
}

function tagHeads(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;
    const gt = source.indexOf(">", lt + 1);
    if (gt < 0) {
      out.push(source.slice(lt + 1).toLowerCase());
      break;
    }
    out.push(source.slice(lt + 1, gt).toLowerCase());
    i = gt + 1;
  }
  return out;
}

function hasInlineHandler(head: string): boolean {
  let p = 0;
  while (p < head.length) {
    const on = head.indexOf(" on", p);
    if (on < 0) return false;
    let n = on + 3;
    if (n >= head.length || head.charCodeAt(n) < 97 || head.charCodeAt(n) > 122) {
      p = n;
      continue;
    }
    while (n < head.length && head.charCodeAt(n) >= 97 && head.charCodeAt(n) <= 122) n++;
    while (n < head.length && head[n] === " ") n++;
    if (head[n] === "=") return true;
    p = n;
  }
  return false;
}

function hasNonce(head: string): boolean {
  const nameEnd = head.search(/[\s/]/);
  const name = (nameEnd < 0 ? head : head.slice(0, nameEnd)).trim();
  if (name !== "script" && name !== "style") return false;
  const nonce = head.indexOf(" nonce");
  if (nonce < 0) return false;
  let n = nonce + 6;
  while (n < head.length && head[n] === " ") n++;
  return head[n] === "=";
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return [s.slice(0, i), s.slice(i + sep.length)];
}
