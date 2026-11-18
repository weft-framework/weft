import { defineModel, type Model } from "./model.ts";

const PURPOSE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

export interface ConsentRow {
  id: string;
  subject: string;
  purpose: string;
  agreed: boolean;
  at: number;
}

export interface ConsentOptions {
  purposes: readonly string[];
  name?: string;
  now?: () => number;
}

export interface Consents {
  readonly model: Model<ConsentRow>;
  readonly purposes: readonly string[];
  has(subject: string, purpose: string): boolean;
  agree(actor: unknown, purpose: string): void;
  withdraw(actor: unknown, purpose: string): void;
  of(actor: unknown): Record<string, boolean>;
}

export type FieldConsent = string | { purpose: string; subject?: string };

const checkers = new Map<string, (subject: string) => boolean>();
const watching = new Map<string, Set<WeakRef<Model<any, any>>>>();

const idOf = (actor: unknown): string | null => {
  const id = typeof actor === "object" && actor !== null ? (actor as { id?: unknown }).id : undefined;
  return typeof id === "string" && id !== "" ? id : null;
};

export function consentRule(model: string, field: string, c: FieldConsent): (actor: unknown, row: unknown) => boolean {
  const purpose = typeof c === "string" ? c : c?.purpose;
  const subject = typeof c === "string" ? undefined : c?.subject;
  if (typeof purpose !== "string" || !PURPOSE.test(purpose)) {
    throw new Error(`model ${model}: the consent of \`${field}\` names a purpose (\`analytics\`)`);
  }
  if (subject !== undefined && typeof subject !== "string") {
    throw new Error(`model ${model}: the consent subject of \`${field}\` is a field name`);
  }
  return (actor, row) => {
    const who = subject === undefined ? idOf(actor) : (row as Record<string, unknown>)[subject];
    if (typeof who !== "string" || who === "") return false;
    const has = checkers.get(purpose);
    return has !== undefined && has(who);
  };
}

export function watchConsent(purpose: string, model: Model<any, any>): void {
  let set = watching.get(purpose);
  if (!set) watching.set(purpose, (set = new Set()));
  set.add(new WeakRef(model));
}

export function defineConsent(opts: ConsentOptions): Consents {
  const purposes = [...new Set(opts.purposes)];
  if (purposes.length === 0) throw new Error("defineConsent: give at least one purpose");
  for (const p of purposes) {
    if (typeof p !== "string" || !PURPOSE.test(p)) throw new Error(`defineConsent: \`${String(p)}\` is not a purpose name (\`analytics\`)`);
  }
  const now = opts.now ?? Date.now;
  const self = (a: unknown, r: ConsentRow) => idOf(a) === r.subject;
  const model = defineModel<ConsentRow>(opts.name ?? "Consent", {
    fields: { id: "string", subject: "string", purpose: "string", agreed: "boolean", at: "number" },
    attrs: { subject: { index: true } },
    read: self,
    write: (a, r) => self(a, r) && purposes.includes(r.purpose) && r.id === `${r.purpose}:${r.subject}`,
  });
  const has = (subject: string, purpose: string): boolean => {
    if (!purposes.includes(purpose) || typeof subject !== "string" || subject === "") return false;
    const row = model.syncDriver().select([], `${purpose}:${subject}`)[0];
    return row !== undefined && row.subject === subject && row.agreed === true;
  };
  for (const p of purposes) checkers.set(p, (s) => has(s, p));

  const answer = (actor: unknown, purpose: string, agreed: boolean): void => {
    if (!purposes.includes(purpose)) throw new Error(`consent: \`${purpose}\` is not one of ${purposes.join(", ")}`);
    const subject = idOf(actor);
    if (subject === null) throw new Error("consent: only a signed-in person can answer");
    const id = `${purpose}:${subject}`;
    const handle = model.as(actor);
    const was = handle.get(id);
    if (was?.agreed === agreed) return;
    const ok = was
      ? handle.update((r) => r.id === id, { agreed, at: now() }) === 1
      : handle.create({ id, subject, purpose, agreed, at: now() }) !== undefined;
    if (!ok) throw new Error("consent: the answer was refused (a read-only view?)");
    const set = watching.get(purpose);
    for (const ref of set ?? []) {
      const m = ref.deref();
      if (m) m.publishAll();
      else set!.delete(ref);
    }
  };
  return {
    model,
    purposes,
    has,
    agree: (actor, purpose) => answer(actor, purpose, true),
    withdraw: (actor, purpose) => answer(actor, purpose, false),
    of(actor) {
      const mine = new Map(model.as(actor).all().map((r) => [r.purpose, r.agreed] as const));
      return Object.fromEntries(purposes.map((p) => [p, mine.get(p) === true]));
    },
  };
}
