import { withRenderContext, type Component, type ComponentDef, type RenderContext } from "@weft/runtime";
import { defineJob, JobError, type Job, type Jobs } from "./jobs.ts";
import type { PageContext } from "./context.ts";
import { isSecret, type Secret } from "./secret.ts";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type AddressInput = string | { name?: string; email: string };

export interface Address {
  name: string;
  email: string;
}

export interface AttachmentInput {
  filename: string;
  content: Uint8Array | string;
  contentType?: string;
}

export interface MailMessage {
  from?: AddressInput;
  to: AddressInput | AddressInput[];
  cc?: AddressInput | AddressInput[];
  bcc?: AddressInput | AddressInput[];
  replyTo?: AddressInput | AddressInput[];
  subject: string;
  text?: string;
  html?: string | { toString(): string };
  headers?: Record<string, string>;
  attachments?: AttachmentInput[];
  tags?: Record<string, string>;
}

export interface Attachment {
  filename: string;
  content: Uint8Array;
  contentType: string;
}

export interface OutgoingMail {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject: string;
  text: string;
  html: string | null;
  headers: [string, string][];
  attachments: Attachment[];
  tags: [string, string][];
  messageId: string;
  date: Date;
}

export type MailErrorCode = "invalid" | "rejected" | "unavailable";

export class MailError extends Error {
  readonly code: MailErrorCode;
  readonly permanent: boolean;
  constructor(code: MailErrorCode, message: string, opts: { permanent?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "MailError";
    this.code = code;
    this.permanent = opts.permanent ?? code === "invalid";
  }
}

const invalid = (msg: string): MailError => new MailError("invalid", msg);

const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$|^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@localhost$/;
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;

export function parseAddress(input: AddressInput): Address {
  let name: string;
  let email: string;
  if (typeof input === "string") {
    if (CONTROL_RE.test(input)) throw invalid("an address is one line");
    const m = /^\s*(?:(.*?)\s*<([^<>]*)>|([^<>\s]+))\s*$/s.exec(input);
    if (!m) throw invalid(`not an address: ${JSON.stringify(input.slice(0, 80))}`);
    name = (m[1] ?? "").replace(/^"(.*)"$/s, "$1");
    email = m[2] ?? m[3]!;
  } else if (input && typeof input === "object" && typeof input.email === "string") {
    name = input.name ?? "";
    email = input.email;
  } else {
    throw invalid("an address is a string or { name?, email }");
  }
  if (typeof name !== "string" || CONTROL_RE.test(name) || /[<>]/.test(name) || name.length > 200) {
    throw invalid("a display name is one line of at most 200 characters, without < or >");
  }
  if (CONTROL_RE.test(email) || email.length > 254 || !EMAIL_RE.test(email) || email.indexOf("@") > 64) {
    throw invalid(`not an address: ${JSON.stringify(email.slice(0, 80))}`);
  }
  return { name: name.trim(), email };
}

function addressList(v: AddressInput | AddressInput[] | undefined): Address[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map(parseAddress);
}

const RESERVED_HEADERS = new Set([
  "from", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id", "mime-version", "sender",
  "content-type", "content-transfer-encoding", "content-disposition", "return-path", "received",
]);
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,76}$/;
const TAG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONTENT_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/;
const MAX_RECIPIENTS = 50;

const utf8 = new TextEncoder();

export function prepareMail(m: MailMessage, o: { from: Address; maxBytes: number; messageId?: string; date?: Date }): OutgoingMail {
  if (!m || typeof m !== "object") throw invalid("a message is an object");
  const from = m.from === undefined ? o.from : parseAddress(m.from);
  const to = addressList(m.to);
  const cc = addressList(m.cc);
  const bcc = addressList(m.bcc);
  const replyTo = addressList(m.replyTo);
  if (to.length + cc.length + bcc.length === 0) throw invalid("a message needs a recipient");
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw invalid(`at most ${MAX_RECIPIENTS} recipients per message`);
  if (typeof m.subject !== "string" || m.subject.trim() === "") throw invalid("a message needs a subject");
  if (CONTROL_RE.test(m.subject) || m.subject.length > 900) throw invalid("a subject is one line of at most 900 characters");
  const html = m.html === undefined || m.html === null ? null : String(m.html);
  if (m.text !== undefined && typeof m.text !== "string") throw invalid("text is a string");
  if (html === null && (m.text === undefined || m.text === "")) throw invalid("a message needs text or html");
  const text = m.text !== undefined && m.text !== "" ? m.text : htmlToText(html!);
  const headers: [string, string][] = [];
  for (const [k, v] of Object.entries(m.headers ?? {})) {
    if (!HEADER_NAME_RE.test(k) || RESERVED_HEADERS.has(k.toLowerCase())) throw invalid(`header ${JSON.stringify(k)} cannot be set`);
    if (typeof v !== "string" || CONTROL_RE.test(v) || v.length > 900 || /[^\x20-\x7e]/.test(v)) {
      throw invalid(`header ${k}: one line of printable ASCII, at most 900 characters`);
    }
    headers.push([k, v]);
  }
  const tags: [string, string][] = [];
  for (const [k, v] of Object.entries(m.tags ?? {})) {
    if (!TAG_RE.test(k) || typeof v !== "string" || !TAG_RE.test(v)) throw invalid(`tag ${JSON.stringify(k)}: names and values are [A-Za-z0-9_-]{1,64}`);
    tags.push([k, v]);
  }
  const attachments: Attachment[] = [];
  for (const a of m.attachments ?? []) {
    if (!a || typeof a.filename !== "string" || a.filename === "" || CONTROL_RE.test(a.filename) || a.filename.length > 200) {
      throw invalid("an attachment needs a one-line filename of at most 200 characters");
    }
    const content = typeof a.content === "string" ? utf8.encode(a.content) : a.content;
    if (!(content instanceof Uint8Array)) throw invalid(`attachment ${a.filename}: content is bytes or a string`);
    const contentType = a.contentType ?? "application/octet-stream";
    if (!CONTENT_TYPE_RE.test(contentType)) throw invalid(`attachment ${a.filename}: not a media type: ${contentType}`);
    attachments.push({ filename: a.filename.replace(/^.*[\\/]/, "") || "attachment", content, contentType: contentType.toLowerCase() });
  }
  let size = utf8.encode(m.subject).length + utf8.encode(text).length + (html ? utf8.encode(html).length : 0);
  for (const a of attachments) size += Math.ceil(a.content.length / 3) * 4;
  if (size > o.maxBytes) throw invalid(`the message is ${size} bytes; the limit is ${o.maxBytes}`);
  const domain = from.email.slice(from.email.indexOf("@") + 1);
  return {
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject: m.subject,
    text,
    html,
    headers,
    attachments,
    tags,
    messageId: o.messageId ?? `<${randomId()}@${domain}>`,
    date: o.date ?? new Date(),
  };
}

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, d?: string, q?: string, inner?: string) => {
    const href = decodeEntities(d ?? q ?? "").trim();
    const label = decodeEntities((inner ?? "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (!href || href.startsWith("#") || /^(javascript|data|vbscript):/i.test(href)) return label;
    return label === "" || label === href || `mailto:${label}` === href ? href.replace(/^mailto:/i, "") : `${label} (${href})`;
  });
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(p|div|h[1-6]|ul|ol|table|tr|blockquote|section|article|header|footer|hr|pre)\b[^>]*>/gi, "\n\n")
    .replace(/<\/(td|th)\s*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(s)
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function wrap76(s: string): string {
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 76) lines.push(s.slice(i, i + 76));
  return lines.join("\r\n");
}

export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n|\r|\n/g, "\n").split("\n")) {
    const bytes = utf8.encode(line);
    let cur = "";
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const last = i === bytes.length - 1;
      const tok =
        (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last)
          ? String.fromCharCode(b)
          : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
      if (cur.length + tok.length > 75) {
        parts.push(`${cur}=`);
        cur = "";
      }
      cur += tok;
    }
    parts.push(cur);
    out.push(parts.join("\r\n"));
  }
  return out.join("\r\n");
}

function encodeWords(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = [];
  let chunk: number[] = [];
  for (const ch of s) {
    const bytes = utf8.encode(ch);
    if (chunk.length + bytes.length > 36) {
      words.push(`=?UTF-8?B?${b64(Uint8Array.from(chunk))}?=`);
      chunk = [];
    }
    chunk.push(...bytes);
  }
  if (chunk.length) words.push(`=?UTF-8?B?${b64(Uint8Array.from(chunk))}?=`);
  return words.join("\r\n ");
}

function formatAddress(a: Address): string {
  if (a.name === "") return a.email;
  const name = /^[\x20-\x7e]*$/.test(a.name)
    ? /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]*$/.test(a.name)
      ? a.name
      : `"${a.name.replace(/[\\"]/g, "\\$&")}"`
    : encodeWords(a.name);
  return `${name} <${a.email}>`;
}

function addressHeader(name: string, list: Address[]): string {
  return `${name}: ${list.map(formatAddress).join(",\r\n ")}`;
}

function filenameParams(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  if (ascii === name) return `filename="${name}"`;
  const enc = Array.from(utf8.encode(name), (b) =>
    /[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");
  return `filename="${ascii}";\r\n filename*=UTF-8''${enc}`;
}

function rfc5322Date(d: Date): string {
  return d.toUTCString().replace(/GMT$/, "+0000");
}

export function buildMime(m: OutgoingMail): string {
  const boundary = (tag: string): string => `=_weft_${tag}_${randomId()}`;
  const head: string[] = [
    addressHeader("From", [m.from]),
    ...(m.to.length ? [addressHeader("To", m.to)] : []),
    ...(m.cc.length ? [addressHeader("Cc", m.cc)] : []),
    ...(m.replyTo.length ? [addressHeader("Reply-To", m.replyTo)] : []),
    `Subject: ${encodeWords(m.subject)}`,
    `Date: ${rfc5322Date(m.date)}`,
    `Message-ID: ${m.messageId}`,
    "MIME-Version: 1.0",
    ...m.headers.map(([k, v]) => `${k}: ${v}`),
  ];
  const textPart = (type: string, body: string): string =>
    `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(body)}`;
  let body = m.html === null
    ? textPart("text/plain", m.text)
    : (() => {
        const b = boundary("alt");
        return (
          `Content-Type: multipart/alternative;\r\n boundary="${b}"\r\n\r\n` +
          `--${b}\r\n${textPart("text/plain", m.text)}\r\n--${b}\r\n${textPart("text/html", m.html)}\r\n--${b}--`
        );
      })();
  if (m.attachments.length) {
    const b = boundary("mix");
    const parts = [body, ...m.attachments.map((a) =>
      `Content-Type: ${a.contentType}\r\nContent-Transfer-Encoding: base64\r\n` +
      `Content-Disposition: attachment;\r\n ${filenameParams(a.filename)}\r\n\r\n${wrap76(b64(a.content))}`,
    )];
    body = `Content-Type: multipart/mixed;\r\n boundary="${b}"\r\n\r\n${parts.map((p) => `--${b}\r\n${p}`).join("\r\n")}\r\n--${b}--`;
  }
  return `${head.join("\r\n")}\r\n${body}\r\n`;
}

export interface SendResult {
  id: string | null;
}

export interface MailTransport {
  readonly name: string;
  send(mail: OutgoingMail): Promise<SendResult>;
}

const reveal = (s: string | Secret): string => (isSecret(s) ? s.reveal() : s);

function needSecret(what: string, s: unknown): void {
  if (!isSecret(s) && (typeof s !== "string" || s === "")) throw new Error(`${what} is a string or a Secret`);
}

function httpFailure(provider: string, status: number, detail: string): MailError {
  const transient = status === 429 || status >= 500;
  return new MailError(transient ? "unavailable" : "rejected", `${provider}: HTTP ${status}${detail ? `: ${detail}` : ""}`, { permanent: !transient });
}

async function post(provider: string, f: Fetch, url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await f(url, { ...init, method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new MailError("unavailable", `${provider}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const raw = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = body && typeof body === "object" ? String((body as Record<string, unknown>).message ?? (body as Record<string, unknown>).Message ?? "") : "";
    throw httpFailure(provider, res.status, detail.slice(0, 200));
  }
  return { status: res.status, body };
}

interface HttpOptions {
  fetch?: Fetch;
  timeoutMs?: number;
}

const httpDefaults = (o: HttpOptions): { fetch: Fetch; timeoutMs: number } => ({
  fetch: o.fetch ?? ((i, init) => fetch(i, init)),
  timeoutMs: o.timeoutMs ?? 15_000,
});

export function resend(o: HttpOptions & { apiKey: string | Secret; endpoint?: string }): MailTransport {
  needSecret("resend: apiKey", o.apiKey);
  const { fetch: f, timeoutMs } = httpDefaults(o);
  const endpoint = o.endpoint ?? "https://api.resend.com/emails";
  return {
    name: "resend",
    async send(m) {
      const body = {
        from: formatAddress(m.from),
        to: m.to.map(formatAddress),
        ...(m.cc.length ? { cc: m.cc.map(formatAddress) } : {}),
        ...(m.bcc.length ? { bcc: m.bcc.map(formatAddress) } : {}),
        ...(m.replyTo.length ? { reply_to: m.replyTo.map(formatAddress) } : {}),
        subject: m.subject,
        text: m.text,
        ...(m.html !== null ? { html: m.html } : {}),
        headers: Object.fromEntries([["Message-ID", m.messageId], ...m.headers]),
        ...(m.attachments.length
          ? { attachments: m.attachments.map((a) => ({ filename: a.filename, content: b64(a.content), content_type: a.contentType })) }
          : {}),
        ...(m.tags.length ? { tags: m.tags.map(([name, value]) => ({ name, value })) } : {}),
      };
      const res = await post("resend", f, endpoint, {
        headers: {
          authorization: `Bearer ${reveal(o.apiKey)}`,
          "content-type": "application/json",
          "idempotency-key": m.messageId.slice(1, -1).slice(0, 256),
        },
        body: JSON.stringify(body),
      }, timeoutMs);
      const id = (res.body as { id?: unknown } | null)?.id;
      return { id: typeof id === "string" ? id : null };
    },
  };
}

export function postmark(o: HttpOptions & { serverToken: string | Secret; messageStream?: string; endpoint?: string }): MailTransport {
  needSecret("postmark: serverToken", o.serverToken);
  const { fetch: f, timeoutMs } = httpDefaults(o);
  const endpoint = o.endpoint ?? "https://api.postmarkapp.com/email";
  return {
    name: "postmark",
    async send(m) {
      const list = (l: Address[]): string => l.map(formatAddress).join(", ");
      const body = {
        From: formatAddress(m.from),
        To: list(m.to),
        ...(m.cc.length ? { Cc: list(m.cc) } : {}),
        ...(m.bcc.length ? { Bcc: list(m.bcc) } : {}),
        ...(m.replyTo.length ? { ReplyTo: list(m.replyTo) } : {}),
        Subject: m.subject,
        TextBody: m.text,
        ...(m.html !== null ? { HtmlBody: m.html } : {}),
        Headers: [["Message-ID", m.messageId], ...m.headers].map(([Name, Value]) => ({ Name, Value })),
        ...(m.attachments.length
          ? { Attachments: m.attachments.map((a) => ({ Name: a.filename, Content: b64(a.content), ContentType: a.contentType })) }
          : {}),
        ...(m.tags.length ? { Metadata: Object.fromEntries(m.tags) } : {}),
        ...(o.messageStream ? { MessageStream: o.messageStream } : {}),
      };
      const res = await post("postmark", f, endpoint, {
        headers: { "x-postmark-server-token": reveal(o.serverToken), "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      }, timeoutMs);
      const r = res.body as { MessageID?: unknown; ErrorCode?: unknown; Message?: unknown } | null;
      if (r && typeof r.ErrorCode === "number" && r.ErrorCode !== 0) {
        throw new MailError("rejected", `postmark: ${String(r.Message ?? r.ErrorCode).slice(0, 200)}`, { permanent: true });
      }
      return { id: typeof r?.MessageID === "string" ? r.MessageID : null };
    },
  };
}

const hex = (b: ArrayBuffer | Uint8Array): string =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? utf8.encode(data) : data));
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, utf8.encode(data)));
}

const awsEncode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string | Secret;
  sessionToken?: string | Secret;
}

export async function signAwsRequest(r: {
  method: string;
  url: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  headers?: Record<string, string>;
  body?: string;
  now?: Date;
}): Promise<Record<string, string>> {
  const url = new URL(r.url);
  const amzDate = (r.now ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = v;
  headers.host = url.host;
  headers["x-amz-date"] = amzDate;
  if (r.credentials.sessionToken !== undefined) headers["x-amz-security-token"] = reveal(r.credentials.sessionToken);
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const path = url.pathname.split("/").map((seg) => awsEncode(decodeURIComponent(seg))).join("/") || "/";
  const canonical = [r.method.toUpperCase(), path, query, canonicalHeaders, names.join(";"), await sha256Hex(r.body ?? "")].join("\n");
  const scope = `${day}/${r.region}/${r.service}/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonical)}`;
  let key = await hmac(utf8.encode(`AWS4${reveal(r.credentials.secretAccessKey)}`), day);
  key = await hmac(key, r.region);
  key = await hmac(key, r.service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, toSign));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${r.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return headers;
}

export function ses(o: HttpOptions & AwsCredentials & { region: string; configurationSet?: string; endpoint?: string }): MailTransport {
  if (typeof o.region !== "string" || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(o.region)) throw new Error("ses: region is an AWS region name");
  if (typeof o.accessKeyId !== "string" || o.accessKeyId === "") throw new Error("ses: accessKeyId is required");
  needSecret("ses: secretAccessKey", o.secretAccessKey);
  const { fetch: f, timeoutMs } = httpDefaults(o);
  const endpoint = o.endpoint ?? `https://email.${o.region}.amazonaws.com/v2/email/outbound-emails`;
  return {
    name: "ses",
    async send(m) {
      const body = JSON.stringify({
        FromEmailAddress: formatAddress(m.from),
        Destination: {
          ToAddresses: m.to.map(formatAddress),
          ...(m.cc.length ? { CcAddresses: m.cc.map(formatAddress) } : {}),
          ...(m.bcc.length ? { BccAddresses: m.bcc.map(formatAddress) } : {}),
        },
        Content: { Raw: { Data: b64(utf8.encode(buildMime(m))) } },
        ...(m.tags.length ? { EmailTags: m.tags.map(([Name, Value]) => ({ Name, Value })) } : {}),
        ...(o.configurationSet ? { ConfigurationSetName: o.configurationSet } : {}),
      });
      const headers = await signAwsRequest({
        method: "POST",
        url: endpoint,
        region: o.region,
        service: "ses",
        credentials: o,
        headers: { "content-type": "application/json" },
        body,
      });
      delete headers.host;
      const res = await post("ses", f, endpoint, { headers, body }, timeoutMs);
      const id = (res.body as { MessageId?: unknown } | null)?.MessageId;
      return { id: typeof id === "string" ? id : null };
    },
  };
}

export interface SmtpOptions {
  host: string;
  port?: number;
  tls?: "implicit" | "starttls" | "none";
  user?: string;
  pass?: string | Secret;
  name?: string;
  timeoutMs?: number;
  tlsOptions?: { ca?: string | string[]; servername?: string };
}

interface Reply {
  code: number;
  lines: string[];
}

interface Sock {
  write(s: string): void;
  on(ev: string, f: (arg?: unknown) => void): void;
  off(ev: string, f: (arg?: unknown) => void): void;
  destroy(): void;
}

class SmtpConnection {
  #buf = "";
  #lines: string[] = [];
  #replies: Reply[] = [];
  #waiting: { resolve: (r: Reply) => void; reject: (e: unknown) => void } | null = null;
  #failed: unknown = null;
  #sock: Sock;
  readonly #timeoutMs: number;

  constructor(sock: Sock, timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
    this.#sock = sock;
    this.#attach(sock);
  }

  readonly #onData = (chunk?: unknown): void => this.#data(String(chunk));
  readonly #onError = (e?: unknown): void => this.#fail(e ?? new Error("connection error"));
  readonly #onClose = (): void => this.#fail(new Error("connection closed"));

  #attach(sock: Sock): void {
    sock.on("data", this.#onData);
    sock.on("error", this.#onError);
    sock.on("close", this.#onClose);
  }

  detach(): void {
    this.#sock.off("data", this.#onData);
    this.#sock.off("error", this.#onError);
    this.#sock.off("close", this.#onClose);
  }

  upgrade(sock: Sock): void {
    this.#buf = "";
    this.#lines = [];
    this.#replies = [];
    this.#sock = sock;
    this.#attach(sock);
  }

  get socket(): Sock {
    return this.#sock;
  }

  #data(s: string): void {
    this.#buf += s;
    if (this.#buf.length > 1 << 20) {
      this.#fail(new Error("reply too long"));
      return;
    }
    let i: number;
    while ((i = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, i).replace(/\r$/, "");
      this.#buf = this.#buf.slice(i + 1);
      const m = /^(\d{3})([ -]|$)(.*)$/.exec(line);
      if (!m) {
        this.#fail(new Error(`not an SMTP reply: ${line.slice(0, 80)}`));
        return;
      }
      this.#lines.push(m[3]!);
      if (m[2] !== "-") {
        const reply = { code: Number(m[1]), lines: this.#lines };
        this.#lines = [];
        if (this.#waiting) {
          const w = this.#waiting;
          this.#waiting = null;
          w.resolve(reply);
        } else {
          this.#replies.push(reply);
        }
      }
    }
  }

  #fail(e: unknown): void {
    if (this.#failed === null) this.#failed = e;
    if (this.#waiting) {
      const w = this.#waiting;
      this.#waiting = null;
      w.reject(e);
    }
  }

  read(): Promise<Reply> {
    const queued = this.#replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#failed !== null) return Promise.reject(this.#failed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting = null;
        reject(new Error("timed out waiting for the server"));
      }, this.#timeoutMs);
      this.#waiting = {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
    });
  }

  async command(line: string | null, expect: number[], what: string): Promise<Reply> {
    if (line !== null) this.#sock.write(`${line}\r\n`);
    const r = await this.read();
    if (!expect.includes(r.code)) {
      const text = r.lines.join(" ").slice(0, 200);
      throw new MailError(r.code >= 500 ? "rejected" : "unavailable", `smtp ${what}: ${r.code} ${text}`, { permanent: r.code >= 500 });
    }
    return r;
  }

  close(): void {
    try {
      this.#sock.destroy();
    } catch {
    }
  }
}

const isLoopback = (host: string): boolean => host === "localhost" || /^127\./.test(host) || host === "::1" || host === "[::1]";

export function smtp(o: SmtpOptions): MailTransport {
  if (typeof o.host !== "string" || o.host === "" || /[\s/]/.test(o.host)) throw new Error("smtp: host is a host name");
  const tlsMode = o.tls ?? (o.port === 465 ? "implicit" : "starttls");
  if (!["implicit", "starttls", "none"].includes(tlsMode)) throw new Error(`smtp: tls is "implicit", "starttls" or "none"`);
  const port = o.port ?? (tlsMode === "implicit" ? 465 : 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("smtp: port is 1-65535");
  if ((o.user === undefined) !== (o.pass === undefined)) throw new Error("smtp: user and pass go together");
  if (o.user !== undefined) {
    if (typeof o.user !== "string" || o.user === "" || CONTROL_RE.test(o.user)) throw new Error("smtp: user is one line");
    needSecret("smtp: pass", o.pass);
    if (tlsMode === "none" && !isLoopback(o.host)) throw new Error("smtp: credentials are only sent over TLS (or to a loopback test server)");
  }
  const name = o.name ?? "localhost";
  if (!/^[A-Za-z0-9.-]{1,253}$|^\[[0-9a-fA-F:.]{2,45}\]$/.test(name)) throw new Error("smtp: name is a host name or address literal");
  const timeoutMs = o.timeoutMs ?? 30_000;
  const servername = o.tlsOptions?.servername ?? o.host;

  async function open(): Promise<SmtpConnection> {
    const net = await import("node:net");
    const tls = await import("node:tls");
    const sock: Sock = await new Promise((resolve, reject) => {
      const s = tlsMode === "implicit"
        ? tls.connect({ host: o.host, port, servername, ca: o.tlsOptions?.ca, rejectUnauthorized: true }, () => resolve(s as unknown as Sock))
        : net.connect({ host: o.host, port }, () => resolve(s as unknown as Sock));
      s.setTimeout(timeoutMs, () => s.destroy(new Error("connection timed out")));
      s.once("error", reject);
    });
    return new SmtpConnection(sock, timeoutMs);
  }

  async function starttls(conn: SmtpConnection): Promise<void> {
    const tls = await import("node:tls");
    const plain = conn.socket as unknown as import("node:net").Socket;
    conn.detach();
    const secure: Sock = await new Promise((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername, ca: o.tlsOptions?.ca, rejectUnauthorized: true }, () => resolve(s as unknown as Sock));
      s.once("error", reject);
    });
    conn.upgrade(secure);
  }

  return {
    name: "smtp",
    async send(m) {
      let conn: SmtpConnection | null = null;
      try {
        conn = await open();
        await conn.command(null, [220], "greeting");
        let ehlo = await conn.command(`EHLO ${name}`, [250], "EHLO");
        if (tlsMode === "starttls") {
          if (!ehlo.lines.slice(1).some((l) => /^STARTTLS\b/i.test(l))) {
            throw new MailError("unavailable", "smtp: the server does not offer STARTTLS; refusing to send in plain text");
          }
          await conn.command("STARTTLS", [220], "STARTTLS");
          await starttls(conn);
          ehlo = await conn.command(`EHLO ${name}`, [250], "EHLO");
        }
        if (o.user !== undefined) {
          const auth = ehlo.lines.slice(1).find((l) => /^AUTH[ =]/i.test(l))?.toUpperCase().split(/[ =]/).slice(1) ?? [];
          const pass = reveal(o.pass!);
          if (auth.includes("PLAIN")) {
            await conn.command(`AUTH PLAIN ${b64(utf8.encode(`\0${o.user}\0${pass}`))}`, [235], "AUTH");
          } else if (auth.includes("LOGIN")) {
            await conn.command("AUTH LOGIN", [334], "AUTH");
            await conn.command(b64(utf8.encode(o.user)), [334], "AUTH");
            await conn.command(b64(utf8.encode(pass)), [235], "AUTH");
          } else {
            throw new MailError("rejected", "smtp: the server offers no AUTH PLAIN or LOGIN", { permanent: true });
          }
        }
        await conn.command(`MAIL FROM:<${m.from.email}>`, [250], "MAIL FROM");
        for (const r of [...m.to, ...m.cc, ...m.bcc]) await conn.command(`RCPT TO:<${r.email}>`, [250, 251], "RCPT TO");
        await conn.command("DATA", [354], "DATA");
        const data = buildMime(m).replace(/^\./gm, "..");
        const done = await conn.command(`${data}.`, [250], "DATA");
        await conn.command("QUIT", [221], "QUIT").catch(() => {});
        const id = /\b(?:id=|queued as )\s*([A-Za-z0-9._@<>-]+)/i.exec(done.lines.join(" "))?.[1] ?? null;
        return { id };
      } catch (err) {
        if (err instanceof MailError) throw err;
        throw new MailError("unavailable", `smtp: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      } finally {
        conn?.close();
      }
    },
  };
}

export interface SentMail {
  mail: OutgoingMail;
  raw: string;
  at: Date;
}

const OUTBOXES = Symbol.for("weft.mail.outboxes");
const outboxes = ((globalThis as Record<symbol, unknown>)[OUTBOXES] ??= []) as Outbox[];
const order = new WeakMap<SentMail, number>();
let sends = 0;

export class Outbox implements MailTransport {
  readonly name = "outbox";
  readonly sent: SentMail[] = [];
  readonly #limit: number;
  #n = 0;

  constructor(opts: { limit?: number } = {}) {
    this.#limit = Math.max(1, opts.limit ?? 200);
    outboxes.push(this);
    if (outboxes.length > 8) outboxes.splice(0, outboxes.length - 8);
  }

  async send(mail: OutgoingMail): Promise<SendResult> {
    const sent: SentMail = { mail, raw: buildMime(mail), at: new Date() };
    order.set(sent, ++sends);
    this.sent.push(sent);
    if (this.sent.length > this.#limit) this.sent.splice(0, this.sent.length - this.#limit);
    return { id: `outbox-${++this.#n}` };
  }

  last(email?: string): SentMail | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const s = this.sent[i]!;
      if (email === undefined || [...s.mail.to, ...s.mail.cc, ...s.mail.bcc].some((a) => a.email.toLowerCase() === email.toLowerCase())) return s;
    }
    return undefined;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

const PREVIEW = "/_weft/dev/mail";

export function mailPreview(req: Request, templates: Record<string, EmailTemplate> = {}): Response | null {
  const path = new URL(req.url).pathname;
  if (path !== PREVIEW && !path.startsWith(`${PREVIEW}/`)) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const all = outboxes.flatMap((o) => o.sent).sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0));
  const base = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
  const sandboxed = "sandbox; default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:";
  const t = /^\/t\/([A-Za-z0-9_/-]{1,200})\/([A-Za-z0-9_-]{1,64})\.(html|txt)$/.exec(path.slice(PREVIEW.length));
  if (t) {
    const tpl = templates[t[1]!];
    const props = tpl?.previews[t[2]!];
    if (!tpl || !props) return new Response("no such template or sample", { status: 404, headers: base });
    let r: Rendered & { subject: string | null };
    try {
      r = renderTemplate(tpl as unknown as Template<object>, props);
    } catch (err) {
      const text = `${tpl.file}: ${err instanceof Error ? err.message : String(err)}`;
      return new Response(text, { status: 500, headers: { ...base, "content-type": "text/plain; charset=utf-8" } });
    }
    if (t[3] === "txt") {
      const head = r.subject === null ? "" : `Subject: ${r.subject}\n\n`;
      return new Response(head + r.text, { headers: { ...base, "content-type": "text/plain; charset=utf-8" } });
    }
    return new Response(r.html, { headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": sandboxed } });
  }
  const m = /^\/(\d{1,6})\.(html|txt|eml)$/.exec(path.slice(PREVIEW.length));
  if (m) {
    const s = all[Number(m[1])];
    if (!s) return new Response("no such message", { status: 404, headers: base });
    if (m[2] === "html") {
      return new Response(s.mail.html ?? `<pre>${escapeText(s.mail.text)}</pre>`, {
        headers: {
          ...base,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": sandboxed,
        },
      });
    }
    return new Response(m[2] === "txt" ? s.mail.text : s.raw, { headers: { ...base, "content-type": "text/plain; charset=utf-8" } });
  }
  if (path !== PREVIEW && path !== `${PREVIEW}/`) return new Response("not found", { status: 404, headers: base });
  const list = (l: Address[]): string => escapeText(l.map((a) => a.email).join(", "));
  const rows = all.map((s, i) =>
    `<li><a href="${PREVIEW}/${i}.html" target="view">${escapeText(s.mail.subject)}</a>` +
      `<small>to ${list([...s.mail.to, ...s.mail.cc])}${s.mail.bcc.length ? `, bcc ${list(s.mail.bcc)}` : ""}<br>` +
      `${s.at.toISOString().slice(11, 19)}, <a href="${PREVIEW}/${i}.txt" target="view">text</a>, ` +
      `<a href="${PREVIEW}/${i}.eml" target="view">source</a></small></li>`,
  ).join("");
  const names = Object.keys(templates).sort();
  const tplRows = names.map((name) => {
    const tpl = templates[name]!;
    const samples = Object.keys(tpl.previews);
    if (!samples.length) return `<li><b>${escapeText(name)}</b><small>no \`preview\` export in ${escapeText(tpl.file)}</small></li>`;
    const link = (s: string, ext: string, label: string) =>
      `<a href="${PREVIEW}/t/${escapeText(name)}/${escapeText(s)}.${ext}" target="view">${escapeText(label)}</a>`;
    return (
      `<li>${link(samples[0]!, "html", name)}<small>` +
      samples.map((s) => `${samples.length > 1 ? `${link(s, "html", s)}: ` : ""}${link(s, "txt", "text")}`).join(", ") +
      `</small></li>`
    );
  });
  const page =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sent mail</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><style>` +
    `body{margin:0;font:14px/1.45 system-ui,sans-serif;display:grid;grid-template-columns:minmax(16rem,24rem) 1fr;height:100vh;color:#1d1d1b;background:#fff}` +
    `ol{list-style:none;margin:0;padding:0;overflow:auto;border-right:1px solid #ddd}li{padding:.6rem 1rem;border-bottom:1px solid #eee}` +
    `li>a{display:block;color:inherit;font-weight:600;text-decoration:none}small{color:#666}small a{color:inherit}` +
    `h1{font-size:14px;margin:0;padding:.6rem 1rem;border-bottom:1px solid #ddd}p{padding:0 1rem;color:#666}` +
    `iframe{border:0;width:100%;height:100vh}@media (max-width:40rem){body{grid-template-columns:1fr;height:auto}iframe{height:70vh}}` +
    `</style></head><body><div><h1>Sent mail (${all.length})</h1>` +
    (all.length ? `<ol>${rows}</ol>` : "<p>Nothing sent yet. Messages sent through an <code>Outbox</code> transport appear here.</p>") +
    (names.length ? `<h1>Templates (${names.length})</h1><ol>${tplRows.join("")}</ol>` : "") +
    `</div><iframe name="view" title="Message"${all.length ? ` src="${PREVIEW}/0.html"` : ""}></iframe></body></html>`;
  return new Response(page, {
    headers: {
      ...base,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'",
    },
  });
}

export interface MailOptions {
  transport: MailTransport;
  from: AddressInput;
  jobs?: () => Jobs;
  maxBytes?: number;
  jobName?: string;
  attempts?: number;
}

export interface Rendered {
  html: string;
  text: string;
}

interface StoredMail {
  v: 1;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject: string;
  text: string;
  html: string | null;
  headers: [string, string][];
  attachments: { filename: string; content: string; contentType: string }[];
  tags: [string, string][];
  messageId: string;
}

export class Mail {
  readonly #o: { transport: MailTransport; from: Address; jobs?: () => Jobs; maxBytes: number };
  readonly job: Job<[string]>;

  constructor(o: MailOptions) {
    if (!o || typeof o.transport?.send !== "function") throw new Error("defineMail: transport is a MailTransport");
    const maxBytes = o.maxBytes ?? 10 * 1024 * 1024;
    if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 40 * 1024 * 1024) throw new Error("defineMail: maxBytes is 1 KiB-40 MiB");
    if (o.jobs !== undefined && typeof o.jobs !== "function") throw new Error("defineMail: jobs is a function returning the queue");
    this.#o = { transport: o.transport, from: parseAddress(o.from), jobs: o.jobs, maxBytes };
    this.job = defineJob(o.jobName ?? "weftMail", [{ name: "message", type: "string" }], async (_ctx, message: string) => {
      let mail: OutgoingMail;
      try {
        mail = this.#revive(message);
      } catch (err) {
        throw new JobError(`weftMail: ${err instanceof Error ? err.message : String(err)}`, { retry: false, cause: err });
      }
      try {
        await this.#o.transport.send(mail);
      } catch (err) {
        if (err instanceof MailError && err.permanent) throw new JobError(err.message, { retry: false, cause: err });
        throw err;
      }
    }, { attempts: o.attempts ?? 8, timeoutMs: 120_000 });
  }

  prepare(message: MailMessage): OutgoingMail {
    return prepareMail(message, { from: this.#o.from, maxBytes: this.#o.maxBytes });
  }

  async send(message: MailMessage): Promise<SendResult & { messageId: string }> {
    const mail = this.prepare(message);
    const r = await this.#o.transport.send(mail);
    return { id: r.id, messageId: mail.messageId };
  }

  async queue(ctx: PageContext | null, message: MailMessage, opts: { delayMs?: number; key?: string } = {}): Promise<string | false> {
    if (!this.#o.jobs) throw new Error("mail.queue: defineMail({ jobs }) names the queue");
    const mail = this.prepare(message);
    const stored: StoredMail = {
      v: 1,
      from: mail.from,
      to: mail.to,
      cc: mail.cc,
      bcc: mail.bcc,
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: mail.headers,
      attachments: mail.attachments.map((a) => ({ filename: a.filename, content: b64(a.content), contentType: a.contentType })),
      tags: mail.tags,
      messageId: mail.messageId,
    };
    return this.#o.jobs().enqueue(ctx, this.job, { message: JSON.stringify(stored) }, opts);
  }

  #revive(message: string): OutgoingMail {
    const s = JSON.parse(message) as StoredMail;
    if (!s || s.v !== 1) throw new Error("not a stored message");
    const back: MailMessage = {
      from: s.from,
      to: s.to,
      cc: s.cc,
      bcc: s.bcc,
      replyTo: s.replyTo,
      subject: s.subject,
      text: s.text,
      ...(s.html !== null ? { html: s.html } : {}),
      headers: Object.fromEntries(s.headers),
      attachments: s.attachments.map((a) => ({ filename: a.filename, content: fromB64(a.content), contentType: a.contentType })),
      tags: Object.fromEntries(s.tags),
    };
    if (typeof s.messageId !== "string" || !/^<[A-Za-z0-9._-]{1,128}@[A-Za-z0-9.-]{1,253}>$/.test(s.messageId)) throw new Error("bad Message-ID");
    return prepareMail(back, { from: this.#o.from, maxBytes: this.#o.maxBytes, messageId: s.messageId });
  }

  render<P extends object>(component: Component<P>, props: P, opts: { title?: string; lang?: string } = {}): Rendered {
    return renderMail(component, props, opts);
  }
}

const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderMail<P extends object>(component: Component<P>, props: P, opts: { title?: string; lang?: string } = {}): Rendered {
  if (typeof component !== "function" || !component.def) throw new Error("renderMail: not a component");
  const css = new Set<string>();
  const ctx: RenderContext = {
    child<Q extends object>(def: ComponentDef<Q>, p: Q): string {
      if (def.css) css.add(def.css);
      if (def.island) throw new Error(`email templates are inert: ${def.name} has browser code`);
      const inst = def.setup(p);
      if (Object.keys(inst.handlers ?? {}).length || inst.mount?.length) {
        throw new Error(`email templates are inert: ${def.name} has ${inst.mount?.length ? "mount hooks" : "event handlers"}`);
      }
      return withRenderContext(ctx, () => inst.render());
    },
    bindArgs: () => "",
  };
  const body = withRenderContext(ctx, () => component(props));
  const lang = opts.lang && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(opts.lang) ? opts.lang : "en";
  const style = css.size ? `<style>${[...css].join("\n").replace(/<\//g, "<\\/")}</style>` : "";
  const html =
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    (opts.title ? `<title>${escapeText(opts.title)}</title>` : "") +
    `${style}</head><body>${body}</body></html>`;
  return { html, text: htmlToText(body) };
}

export interface EmailTemplate<P extends object = never> extends Template<P> {
  previews: Record<string, object>;
  file: string;
}

export interface Template<P extends object> {
  component: Component<P>;
  subject?: string | ((props: P) => string);
}

export function renderTemplate<P extends object>(t: Template<P>, props: P): Rendered & { subject: string | null } {
  const raw = typeof t.subject === "function" ? (t.subject as (p: P) => unknown)(props) : t.subject;
  if (raw !== undefined && typeof raw !== "string") throw new Error("subject must be a string or return one");
  const subject = raw === undefined ? null : raw.replace(/\s*[\r\n]+\s*/g, " ").slice(0, 998);
  return { ...renderMail(t.component, props, subject === null ? {} : { title: subject }), subject };
}

export function defineMail(o: MailOptions): Mail {
  return new Mail(o);
}
