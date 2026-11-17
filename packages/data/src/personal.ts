import type { Model } from "./model.ts";
import { transaction } from "./tx.ts";

export type ErasePlan = "delete" | "unlink" | "keep";

export interface PersonalDataOptions {
  plan?: Record<string, ErasePlan>;
  maxRows?: number;
}

export interface PersonalData {
  subject: { model: string; key: unknown };
  rows: Record<string, unknown[]>;
  files: string[];
  missing: string[];
  readonly steps: readonly EraseStep[];
}

interface EraseStep {
  model: Model<unknown>;
  action: "delete" | "unlink";
  keys: unknown[];
  fields: string[];
}

const DEPTH = 16;

export function personalData(
  models: readonly Model<any, any>[],
  subject: Model<any, any>,
  key: unknown,
  opts: PersonalDataOptions = {},
): PersonalData {
  const all = models as readonly Model<unknown>[];
  if (!all.includes(subject as Model<unknown>)) throw new Error("personalData: the subject's model must be among the models");
  const byName = new Map(all.map((m) => [m.name, m]));
  if (byName.size !== all.length) throw new Error("personalData: two models share a name");
  const plan = opts.plan ?? {};
  for (const [name, p] of Object.entries(plan)) {
    if (!byName.has(name)) throw new Error(`personalData: plan names no given model ${JSON.stringify(name)}`);
    if (p !== "delete" && p !== "unlink" && p !== "keep") throw new Error(`personalData: plan for ${name} is delete, unlink or keep`);
  }
  const maxRows = opts.maxRows ?? 100_000;
  if (!Number.isInteger(maxRows) || maxRows < 1) throw new Error("personalData: maxRows is a positive whole number");
  const me = (subject as Model<unknown>).publicUnscoped().find((r) => keyOf(subject as Model<unknown>, r) === key);
  if (me === undefined) throw new Error(`personalData: no ${subject.name} with that key`);

  const missing = new Set<string>();
  const refs = new Map<string, { model: Model<unknown>; field: string; nullable: boolean }[]>();
  for (const m of all) {
    for (const f of m.fields) {
      if (!f.ref) continue;
      if (!byName.has(f.ref)) {
        missing.add(f.ref);
        continue;
      }
      const list = refs.get(f.ref) ?? [];
      list.push({ model: m, field: f.name, nullable: f.nullable });
      refs.set(f.ref, list);
    }
  }

  const cache = new Map<Model<unknown>, unknown[]>();
  const rowsOf = (m: Model<unknown>) => {
    let r = cache.get(m);
    if (!r) cache.set(m, (r = m.publicUnscoped()));
    return r;
  };

  const owned = new Map<Model<unknown>, Map<unknown, unknown>>([[subject as Model<unknown>, new Map([[key, me]])]]);
  const linked = new Map<Model<unknown>, Map<unknown, { row: unknown; fields: Set<string> }>>();
  const depthOf = new Map<Model<unknown>, number>([[subject as Model<unknown>, 0]]);
  let total = 1;
  const count = () => {
    if (++total > maxRows) throw new Error(`personalData: more than ${maxRows} rows; raise maxRows`);
  };
  let frontier: [Model<unknown>, unknown][] = [[subject as Model<unknown>, key]];
  for (let depth = 1; frontier.length > 0; depth++) {
    if (depth > DEPTH) throw new Error(`personalData: references nest deeper than ${DEPTH}`);
    const next: [Model<unknown>, unknown][] = [];
    for (const [target, k] of frontier) {
      for (const ref of refs.get(target.name) ?? []) {
        const choice = plan[ref.model.name] ?? (ref.nullable ? "unlink" : "delete");
        if (choice === "unlink" && !ref.nullable) {
          throw new Error(`personalData: ${ref.model.name}.${ref.field} cannot be unlinked (not nullable); plan delete or keep`);
        }
        for (const row of rowsOf(ref.model)) {
          if ((row as Record<string, unknown>)[ref.field] !== k) continue;
          const rk = keyOf(ref.model, row);
          if (ref.model === subject && rk === key) continue;
          const own = owned.get(ref.model);
          if (own?.has(rk)) continue;
          if (choice === "delete" || choice === "keep") {
            if (!own) owned.set(ref.model, new Map());
            owned.get(ref.model)!.set(rk, row);
            if (linked.get(ref.model)?.delete(rk)) total--;
            depthOf.set(ref.model, Math.max(depthOf.get(ref.model) ?? 0, depth));
            count();
            if (choice === "delete") next.push([ref.model, rk]);
          } else {
            let l = linked.get(ref.model);
            if (!l) linked.set(ref.model, (l = new Map()));
            const had = l.get(rk);
            if (had) had.fields.add(ref.field);
            else {
              l.set(rk, { row, fields: new Set([ref.field]) });
              count();
            }
          }
        }
      }
    }
    frontier = next;
  }

  const rows: Record<string, unknown[]> = {};
  const files = new Set<string>();
  const add = (m: Model<unknown>, row: unknown) => {
    (rows[m.name] ??= []).push(row);
    for (const f of m.fileFields) {
      const v = (row as Record<string, unknown>)[f];
      if (typeof v === "string" && v !== "") files.add(v);
    }
  };
  for (const [m, map] of owned) for (const row of map.values()) add(m, row);
  for (const [m, map] of linked) for (const { row } of map.values()) add(m, row);

  const steps: EraseStep[] = [];
  for (const [m, map] of linked) {
    const byField = new Map<string, unknown[]>();
    for (const [k, { fields }] of map) for (const f of fields) (byField.get(f) ?? byField.set(f, []).get(f)!).push(k);
    for (const [f, keys] of byField) steps.push({ model: m, action: "unlink", keys, fields: [f] });
  }
  const deleting = [...owned].filter(([m]) => m === subject || (plan[m.name] ?? "delete") !== "keep");
  const gone = new Map(deleting.map(([m, map]) => [m.name, map]));
  for (const [m, map] of owned) {
    if (gone.has(m.name)) continue;
    for (const f of m.fields) {
      if (!f.ref || f.nullable || !gone.has(f.ref)) continue;
      for (const row of map.values()) {
        if (gone.get(f.ref)!.has((row as Record<string, unknown>)[f.name])) {
          throw new Error(`personalData: a kept ${m.name} refers through ${f.name} to a ${f.ref} being erased; plan ${m.name} delete`);
        }
      }
    }
  }
  deleting.sort(([a], [b]) => (depthOf.get(b) ?? 0) - (depthOf.get(a) ?? 0));
  for (const [m, map] of deleting) {
    const keys = [...map.keys()];
    if (m === subject) {
      const others = keys.filter((k) => k !== key);
      if (others.length) steps.push({ model: m, action: "delete", keys: others, fields: [] });
      continue;
    }
    steps.push({ model: m, action: "delete", keys, fields: [] });
  }
  steps.push({ model: subject as Model<unknown>, action: "delete", keys: [key], fields: [] });

  return {
    subject: { model: subject.name, key },
    rows,
    files: [...files].sort(),
    missing: [...missing].sort(),
    steps,
  };
}

export function eraseData(data: PersonalData): { removed: Record<string, number>; unlinked: Record<string, number> } {
  const removed: Record<string, number> = {};
  const unlinked: Record<string, number> = {};
  transaction(() => {
    for (const s of data.steps) {
      if (s.action === "unlink") {
        for (const f of s.fields) unlinked[s.model.name] = (unlinked[s.model.name] ?? 0) + s.model.unlinkUnscoped(s.keys, f, "erasure");
      } else {
        removed[s.model.name] = (removed[s.model.name] ?? 0) + s.model.removeUnscoped(s.keys, "erasure");
      }
    }
  });
  return { removed, unlinked };
}

function keyOf(m: Model<unknown>, row: unknown): unknown {
  return (row as Record<string, unknown>)[m.key];
}
