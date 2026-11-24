const REDACTED = "[secret]";
const values = new WeakMap<Secret, string>();

export class Secret {
  readonly name: string;

  constructor(name: string, value: string) {
    this.name = name;
    values.set(this, value);
    Object.freeze(this);
  }

  reveal(): string {
    return values.get(this)!;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): never {
    throw new TypeError(`secret ${this.name} cannot be serialised`);
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Secret(${this.name})`;
  }
}

export function isSecret(v: unknown): v is Secret {
  return v instanceof Secret;
}

export function secretEnv(
  name: string,
  opts: { minLength?: number; env?: Record<string, string | undefined> } = {},
): Secret {
  const processEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
  const env = opts.env ?? processEnv ?? {};
  const value = env[name];
  if (value === undefined || value === "") {
    if (processEnv?.WEFT_PHASE === "build") return new Secret(name, buildPlaceholder(opts.minLength ?? 1));
    throw new Error(`environment variable ${name} is not set`);
  }
  if (value.length < (opts.minLength ?? 1)) {
    throw new Error(`environment variable ${name} must be at least ${opts.minLength} characters`);
  }
  return new Secret(name, value);
}

function buildPlaceholder(minLength: number): string {
  const bytes = new Uint8Array(Math.max(32, Math.ceil(minLength / 2)));
  crypto.getRandomValues(bytes);
  return "weft-build-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function blankOrComment(s: string): boolean {
  let i = 0;
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i === s.length || s[i] === "#";
}

function envLine(raw: string): [string, string] | null {
  let i = 0;
  while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) i++;
  if (i === raw.length || raw[i] === "#") return ["", ""];
  if (raw.startsWith("export", i) && (raw[i + 6] === " " || raw[i + 6] === "\t")) {
    i += 6;
    while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) i++;
  }
  const start = i;
  const first = raw.charCodeAt(i);
  if (!(first === 95 || (first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return null;
  i++;
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    if (c === 95 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) i++;
    else break;
  }
  const key = raw.slice(start, i);
  while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) i++;
  if (raw[i] !== "=") return null;
  i++;
  while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) i++;
  return [key, raw.slice(i)];
}

export function parseEnv(text: string, file = ".env"): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const parsed = envLine(raw);
    if (parsed && parsed[0] === "") return;
    if (!parsed) throw new Error(`${file}:${i + 1}: expected KEY=value`);
    const m = parsed;
    let v = m[1].trimEnd();
    const q = v[0];
    if (q === '"' || q === "'") {
      const end = v.lastIndexOf(q);
      if (end === 0 || !blankOrComment(v.slice(end + 1))) throw new Error(`${file}:${i + 1}: unterminated quote`);
      v = v.slice(1, end);
      if (q === '"') {
        v = v.replace(/\\([nrt"\\])/g, (_s, c: string) => ({ n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" })[c]!);
      }
    } else {
      const hash = v.search(/\s#/);
      if (hash >= 0) v = v.slice(0, hash).trimEnd();
    }
    if (m[0] === "__proto__") throw new Error(`${file}:${i + 1}: __proto__ is not a variable name`);
    out[m[0]] = v;
  });
  return out;
}
