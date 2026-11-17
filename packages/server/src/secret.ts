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
  const env = opts.env ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`environment variable ${name} is not set`);
  }
  if (value.length < (opts.minLength ?? 1)) {
    throw new Error(`environment variable ${name} must be at least ${opts.minLength} characters`);
  }
  return new Secret(name, value);
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function parseEnv(text: string, file = ".env"): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (/^\s*(#.*)?$/.test(raw)) return;
    const m = LINE.exec(raw);
    if (!m) throw new Error(`${file}:${i + 1}: expected KEY=value`);
    let v = m[2].trimEnd();
    const q = v[0];
    if (q === '"' || q === "'") {
      const end = v.lastIndexOf(q);
      if (end === 0 || !/^\s*(#.*)?$/.test(v.slice(end + 1))) throw new Error(`${file}:${i + 1}: unterminated quote`);
      v = v.slice(1, end);
      if (q === '"') {
        v = v.replace(/\\([nrt"\\])/g, (_s, c: string) => ({ n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" })[c]!);
      }
    } else {
      const hash = v.search(/\s#/);
      if (hash >= 0) v = v.slice(0, hash).trimEnd();
    }
    if (m[1] === "__proto__") throw new Error(`${file}:${i + 1}: __proto__ is not a variable name`);
    out[m[1]] = v;
  });
  return out;
}
