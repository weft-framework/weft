export type FieldKind = "text" | "real" | "integer" | "bool" | "date" | "json";

export interface FieldAttrs {
  id?: boolean;
  unique?: boolean;
  index?: boolean;
  default?: () => unknown;
  ref?: string;
  renamed?: string;
  tenant?: boolean;
  softDelete?: boolean;
  retain?: number;
  read?: (actor: any, row: any) => boolean;
  consent?: string | { purpose: string; subject?: string };
}

export interface FieldSpec {
  name: string;
  type: string;
  kind: FieldKind;
  file: boolean;
  nullable: boolean;
  optional: boolean;
  unique: boolean;
  index: boolean;
  ref?: string;
  renamed?: string;
  default?: () => unknown;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isIdentifier(name: string): boolean {
  return IDENT.test(name) && !name.toLowerCase().startsWith("sqlite_");
}

function unionMembers(type: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if ("<({[".includes(c)) {
      depth++;
    } else if (">)}]".includes(c)) {
      depth--;
    } else if (c === "|" && depth === 0) {
      out.push(type.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(type.slice(start).trim());
  return out.filter((m) => m !== "");
}

export function fieldSpec(name: string, type: string): FieldSpec {
  let t = type.trim();
  let optional = false;
  if (t.endsWith("?")) {
    optional = true;
    t = t.slice(0, -1).trim();
  }
  const members = unionMembers(t);
  const nullish = members.filter((m) => m === "null" || m === "undefined");
  optional ||= nullish.includes("undefined");
  const rest = members.filter((m) => m !== "null" && m !== "undefined");
  const base = rest.length === 1 ? rest[0] : null;
  const file = base === "File" || base === "FileRef";
  if (!file && /\bFile(Ref)?\b/.test(t)) {
    throw new Error(`\`${name}\`: a field holds one file: \`File\` or \`File | null\``);
  }
  const kind: FieldKind = file
    ? "text"
    : base === "string"
      ? "text"
      : base === "number"
        ? "real"
        : base === "bigint"
          ? "integer"
          : base === "boolean"
            ? "bool"
            : base === "Date"
              ? "date"
              : rest.length > 0 && rest.every((m) => /^(["']).*\1$/.test(m))
                ? "text"
                : "json";
  return { name, type, kind, file, nullable: nullish.length > 0 || optional, optional, unique: false, index: false };
}

export function fieldSpecs(fields: Record<string, string>, attrs: Record<string, FieldAttrs> = {}): FieldSpec[] {
  for (const name of Object.keys(attrs)) {
    if (!Object.hasOwn(fields, name)) {
      throw new Error(`attributes for unknown field \`${name}\``);
    }
  }
  return Object.entries(fields).map(([name, type]) => {
    const spec = fieldSpec(name, type);
    const a = Object.hasOwn(attrs, name) ? attrs[name] : undefined;
    if (a) {
      spec.unique = a.unique === true;
      spec.index = a.index === true;
      if (a.ref !== undefined) spec.ref = a.ref;
      if (a.renamed !== undefined) {
        if (!isIdentifier(a.renamed) || a.renamed === name) {
          throw new Error(`\`${name}\`: @renamed needs the former field name`);
        }
        spec.renamed = a.renamed;
      }
      if (a.default !== undefined) spec.default = a.default;
    }
    return spec;
  });
}
