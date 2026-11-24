import type { Model, ScopedModel } from "./model.ts";
import { Query } from "./query.ts";
import { flow, out, type Flow, type Out } from "./flow.ts";
import { quoteIdent, SqlTable, type SqlDatabase } from "./sql.ts";
import { changes } from "./changes.ts";

export interface SearchSpec<T> {
  fields: { [K in keyof T & string]?: number };
  maxTerms?: number;
  maxMatches?: number;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  match?: "all" | "any";
}

export interface SearchHit<R> {
  row: R;
  score: number;
}

export interface SearchResult<R> {
  hits: SearchHit<R>[];
  total: number;
  terms: string[];
  truncated: boolean;
}

export interface Highlight {
  text: string;
  match: boolean;
}

const WORD_RE = /[\p{L}\p{N}]+/gu;
const MAX_WORD = 64;
const K1 = 1.2;
const B = 0.75;
const IN_CHUNK = 500;

function fold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export function searchWords(text: string): string[] {
  return fold(text).match(WORD_RE) ?? [];
}

export class Search<T> {
  readonly model: Model<T, any>;
  readonly #weights: [string, number][];
  readonly #maxTerms: number;
  readonly #maxMatches: number;
  #db: SqlDatabase | null = null;
  #index = "";
  #pg: PgIndex | null = null;

  constructor(model: Model<T, any>, spec: SearchSpec<T>) {
    const fail = (msg: string): never => {
      throw new Error(`search of ${model.name}: ${msg}`);
    };
    const fields = new Map(model.fields.map((f) => [f.name, f]));
    const weights = Object.entries(spec.fields ?? {}).filter(([, w]) => w !== undefined) as [string, number][];
    if (weights.length === 0) fail("name at least one field");
    for (const [name, w] of weights) {
      const f = fields.get(name) ?? fail(`no field \`${name}\``);
      if (f.kind !== "text" || f.file) fail(`\`${name}\` is not a text field`);
      if (model.fieldReads.some(([x]) => x === name)) fail(`\`${name}\` has its own read rule; a match would show what it hides`);
      if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) fail(`\`${name}\`: the weight is a positive number`);
    }
    const maxTerms = spec.maxTerms ?? 12;
    const maxMatches = spec.maxMatches ?? 10_000;
    if (!Number.isSafeInteger(maxTerms) || maxTerms < 1 || maxTerms > 64) fail("maxTerms is 1 to 64");
    if (!Number.isSafeInteger(maxMatches) || maxMatches < 1) fail("maxMatches is a positive integer");
    this.model = model;
    this.#weights = weights;
    this.#maxTerms = maxTerms;
    this.#maxMatches = maxMatches;
  }

  use(db: SqlDatabase): this {
    if (!(this.model.driver instanceof SqlTable)) {
      throw new Error(`search of ${this.model.name}: call useDatabase for the model first`);
    }
    const base = this.model.name;
    const index = `${base}__search`;
    const t = quoteIdent(base);
    const x = quoteIdent(index);
    const cols = this.#weights.map(([n]) => quoteIdent(n));
    const list = cols.join(", ");
    const newVals = cols.map((c) => `new.${c}`).join(", ");
    const oldVals = cols.map((c) => `old.${c}`).join(", ");
    const create =
      `CREATE VIRTUAL TABLE ${x} USING fts5(${list}, content=${t}, content_rowid='rowid', ` +
      `tokenize='unicode61 remove_diacritics 2')`;
    const triggers = [
      `CREATE TRIGGER ${quoteIdent(`${index}_ai`)} AFTER INSERT ON ${t} BEGIN ` +
        `INSERT INTO ${x}(rowid, ${list}) VALUES (new.rowid, ${newVals}); END`,
      `CREATE TRIGGER ${quoteIdent(`${index}_ad`)} AFTER DELETE ON ${t} BEGIN ` +
        `INSERT INTO ${x}(${x}, rowid, ${list}) VALUES ('delete', old.rowid, ${oldVals}); END`,
      `CREATE TRIGGER ${quoteIdent(`${index}_au`)} AFTER UPDATE ON ${t} BEGIN ` +
        `INSERT INTO ${x}(${x}, rowid, ${list}) VALUES ('delete', old.rowid, ${oldVals}); ` +
        `INSERT INTO ${x}(rowid, ${list}) VALUES (new.rowid, ${newVals}); END`,
    ];
    const existing = new Map(
      (
        db
          .prepare(`SELECT name, sql FROM sqlite_master WHERE name IN (?, ?, ?, ?)`)
          .all(index, `${index}_ai`, `${index}_ad`, `${index}_au`) as { name: string; sql: string }[]
      ).map((r) => [r.name, r.sql]),
    );
    const current =
      existing.get(index) === create &&
      triggers.every((sql, i) => existing.get(`${index}_${["ai", "ad", "au"][i]}`) === sql);
    if (!current) {
      db.exec("SAVEPOINT weft_search");
      try {
        for (const s of ["ai", "ad", "au"]) db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(`${index}_${s}`)}`);
        db.exec(`DROP TABLE IF EXISTS ${x}`);
        db.exec(create);
        for (const sql of triggers) db.exec(sql);
        db.exec(`INSERT INTO ${x}(${x}) VALUES ('rebuild')`);
        db.exec("RELEASE weft_search");
      } catch (err) {
        db.exec("ROLLBACK TO weft_search");
        db.exec("RELEASE weft_search");
        throw err;
      }
    }
    this.#db = db;
    this.#index = index;
    return this;
  }

  terms(q: string): string[] {
    if (typeof q !== "string") return [];
    const out: string[] = [];
    for (const w of searchWords(q.slice(0, this.#maxTerms * (MAX_WORD + 1) * 2))) {
      const word = w.slice(0, MAX_WORD);
      if (!out.includes(word)) out.push(word);
      if (out.length === this.#maxTerms) break;
    }
    return out;
  }

  search(source: ScopedModel<T, any> | Query<T, any, any, any>, q: string, o: SearchOptions = {}): Out<SearchResult<T>> {
    const base = source instanceof Query ? source : source.query();
    if ((base.model as unknown) !== this.model) throw new Error(`search of ${this.model.name}: the query is for another model`);
    const limit = o.limit ?? 20;
    const offset = o.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("search: limit is a non-negative integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("search: offset is a non-negative integer");
    if (o.match !== undefined && o.match !== "all" && o.match !== "any") throw new Error("search: match is \"all\" or \"any\"");
    const any = o.match === "any";
    const terms = this.terms(q);
    const self = this;
    return out(
      (function* (): Flow<SearchResult<T>> {
        if (terms.length === 0) return { hits: [], total: 0, terms, truncated: false };
        if (self.#db && self.model.driver instanceof SqlTable) {
          const keys = self.#candidates(terms, any);
          return yield* self.#rank(base, yield* self.#load(base, keys), terms, keys.length > self.#maxMatches, limit, offset, any);
        }
        return yield* self.#rank(base, (yield* base.rowsG()) as T[], terms, false, limit, offset, any);
      })(),
    );
  }

  async searchAsync(source: ScopedModel<T, any> | Query<T, any, any, any>, q: string, o: SearchOptions = {}): Promise<SearchResult<T>> {
    if (!this.#pg) return this.search(source, q, o);
    const base = source instanceof Query ? source : source.query();
    if ((base.model as unknown) !== this.model) throw new Error(`search of ${this.model.name}: the query is for another model`);
    const limit = o.limit ?? 20;
    const offset = o.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("search: limit is a non-negative integer");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("search: offset is a non-negative integer");
    if (o.match !== undefined && o.match !== "all" && o.match !== "any") throw new Error("search: match is \"all\" or \"any\"");
    const any = o.match === "any";
    const terms = this.terms(q);
    if (terms.length === 0) return { hits: [], total: 0, terms, truncated: false };
    const keys = await this.#pg.candidates(terms, this.#maxMatches + 1, any);
    const self = this;
    return await flow(
      (function* (): Flow<SearchResult<T>> {
        return yield* self.#rank(base, yield* self.#load(base, keys), terms, keys.length > self.#maxMatches, limit, offset, any);
      })(),
    );
  }

  async usePg(pool: PgQueryable, o: { table?: string } = {}): Promise<this> {
    if (!pool || typeof pool.query !== "function") throw new TypeError(`search of ${this.model.name}: usePg needs a Postgres pool (query(text, values))`);
    this.#pg?.stop();
    const keyField = this.model.fields.find((f) => f.name === this.model.key)!;
    const index = new PgIndex(pool, o.table ?? `${this.model.name}__search`, this.model, (row) => this.#text(row), keyField);
    await index.create();
    await index.rebuild();
    this.#pg = index;
    return this;
  }

  async reindex(): Promise<void> {
    if (!this.#pg) throw new Error(`search of ${this.model.name}: call usePg first`);
    await this.#pg.rebuild();
  }

  async flush(): Promise<void> {
    await this.#pg?.flush();
  }

  stopPg(): void {
    this.#pg?.stop();
    this.#pg = null;
  }

  #text(row: unknown): string {
    return this.#weights
      .flatMap(([n]) => {
        const v = (row as Record<string, unknown>)[n];
        return typeof v === "string" ? searchWords(v) : [];
      })
      .join(" ");
  }

  *#load(base: Query<T, any, any, any>, keys: unknown[]): Flow<T[]> {
    const key = this.model.key as keyof T & string;
    const rows: T[] = [];
    for (let i = 0; i < Math.min(keys.length, this.#maxMatches); i += IN_CHUNK) {
      const chunk = keys.slice(i, Math.min(i + IN_CHUNK, this.#maxMatches));
      rows.push(...((yield* base.where({ [key]: { in: chunk } } as never).rowsG()) as T[]));
    }
    return rows;
  }

  *#rank(base: Query<T, any, any, any>, rows: T[], terms: string[], truncated: boolean, limit: number, offset: number, any = false): Flow<SearchResult<T>> {
    const prefix = terms[terms.length - 1]!.length >= 2;
    const docs: { row: T; words: string[][] }[] = [];
    for (const row of rows) {
      const words = this.#weights.map(([n]) => {
        const v = (row as Record<string, unknown>)[n];
        return typeof v === "string" ? searchWords(v) : [];
      });
      const all = words.flat();
      const has = (t: string, i: number) => (i === terms.length - 1 && prefix ? all.some((w) => w.startsWith(t)) : all.includes(t));
      const ok = any ? terms.some(has) : terms.every(has);
      if (ok) docs.push({ row, words });
    }
    const avg = this.#weights.map((_, f) => docs.reduce((s, d) => s + d.words[f]!.length, 0) / Math.max(1, docs.length) || 1);
    const scored = docs.map((d) => {
      let score = 0;
      this.#weights.forEach(([, weight], f) => {
        const words = d.words[f]!;
        const norm = K1 * (1 - B + (B * words.length) / avg[f]!);
        terms.forEach((t, i) => {
          const isPrefix = i === terms.length - 1 && prefix;
          const tf = words.filter((w) => (isPrefix ? w.startsWith(t) : w === t)).length;
          if (tf > 0) score += (weight * (tf * (K1 + 1))) / (tf + norm);
        });
      });
      return { row: d.row, score };
    });
    const keyOf = (r: T) => (r as Record<string, unknown>)[this.model.key];
    scored.sort((a, b) => b.score - a.score || compareKeys(keyOf(a.row), keyOf(b.row)));
    const page = scored.slice(offset, offset + limit);
    const shown = yield* base.decorateG(page.map((h) => h.row));
    return {
      hits: shown.map((row, i) => ({ row: row as T, score: page[i]!.score })),
      total: scored.length,
      terms,
      truncated,
    };
  }

  highlight(text: string | null | undefined, q: string): Highlight[] {
    if (typeof text !== "string" || text === "") return [];
    const terms = this.terms(q);
    if (terms.length === 0) return [{ text, match: false }];
    const prefix = terms[terms.length - 1]!.length >= 2;
    const out: Highlight[] = [];
    let at = 0;
    for (const m of text.matchAll(WORD_RE)) {
      const w = fold(m[0]);
      const hit = terms.some((t, i) => (i === terms.length - 1 && prefix ? w.startsWith(t) : w === t));
      if (!hit) continue;
      if (m.index > at) out.push({ text: text.slice(at, m.index), match: false });
      out.push({ text: m[0], match: true });
      at = m.index + m[0].length;
    }
    if (at < text.length) out.push({ text: text.slice(at), match: false });
    return out;
  }

  #candidates(terms: string[], any = false): unknown[] {
    const last = terms.length - 1;
    const match = terms.map((t, i) => `"${t}"${i === last && t.length >= 2 ? "*" : ""}`).join(any ? " OR " : " ");
    const key = quoteIdent(this.model.key);
    const rows = this.#db!
      .prepare(
        `SELECT b.${key} AS k FROM ${quoteIdent(this.#index)} AS s JOIN ${quoteIdent(this.model.name)} AS b ` +
          `ON b.rowid = s.rowid WHERE ${quoteIdent(this.#index)} MATCH ? LIMIT ?`,
      )
      .all(match, this.#maxMatches + 1) as { k: unknown }[];
    return rows.map((r) => r.k);
  }
}

export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

class PgIndex {
  readonly #pool: PgQueryable;
  readonly #t: string;
  readonly #name: string;
  readonly #model: Model<any, any>;
  readonly #text: (row: unknown) => string;
  readonly #keyKind: (k: string) => unknown;
  #queue: Promise<void> = Promise.resolve();
  #unsubscribe: () => void;

  constructor(pool: PgQueryable, table: string, model: Model<any, any>, text: (row: unknown) => string, key: { kind: string; type: string }) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,50}$/.test(table)) throw new Error(`search of ${model.name}: not a valid table name: ${table}`);
    this.#pool = pool;
    this.#name = table;
    this.#t = `"${table}"`;
    this.#model = model;
    this.#text = text;
    this.#keyKind =
      key.kind === "real" ? Number : key.kind === "integer" ? (/\bbigint\b/.test(key.type) ? BigInt : Number) : (k: string) => k;
    this.#unsubscribe = changes.subscribe((c) => {
      if (c.model !== model.name) return;
      if (c.redacted) return void this.#enqueue(() => this.rebuild());
      const after = c.after;
      this.#enqueue(() =>
        c.op === "delete" || after === undefined
          ? this.#pool.query(`DELETE FROM ${this.#t} WHERE k = $1`, [String(c.key)]).then(() => {})
          : this.#pool
              .query(`INSERT INTO ${this.#t} (k, doc) VALUES ($1, to_tsvector('simple', $2)) ON CONFLICT (k) DO UPDATE SET doc = EXCLUDED.doc`, [
                String(c.key),
                this.#text(after),
              ])
              .then(() => {}),
      );
    });
  }

  #enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(fn).catch((err: unknown) => {
      const g = globalThis as { reportError?(e: unknown): void };
      if (typeof g.reportError === "function") g.reportError(err);
      else console.error("[weft/data] search index:", err);
    });
    this.#queue = next;
    return next;
  }

  async create(): Promise<void> {
    await this.#pool.query(`CREATE TABLE IF NOT EXISTS ${this.#t} (k TEXT PRIMARY KEY NOT NULL, doc TSVECTOR NOT NULL)`);
    await this.#pool.query(`CREATE INDEX IF NOT EXISTS "${this.#name}_doc" ON ${this.#t} USING GIN (doc)`);
  }

  rebuild(): Promise<void> {
    return this.#enqueue(async () => {
      const rows = (await this.#model.driver.select([])) as Record<string, unknown>[];
      const pool = this.#pool as PgQueryable & { connect?(): Promise<PgQueryable & { release(): void }> };
      const client = typeof pool.connect === "function" ? await pool.connect() : null;
      const db = client ?? this.#pool;
      try {
        await db.query("BEGIN");
        await db.query(`DELETE FROM ${this.#t}`);
        for (let i = 0; i < rows.length; i += 500) {
          const part = rows.slice(i, i + 500);
          await db.query(`INSERT INTO ${this.#t} (k, doc) SELECT k, to_tsvector('simple', d) FROM unnest($1::text[], $2::text[]) AS x(k, d)`, [
            part.map((r) => String(r[this.#model.key])),
            part.map((r) => this.#text(r)),
          ]);
        }
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client?.release();
      }
    });
  }

  flush(): Promise<void> {
    return this.#queue;
  }

  async candidates(terms: string[], max: number, any = false): Promise<unknown[]> {
    const last = terms.length - 1;
    const query = terms.map((t, i) => `'${t.replace(/'/g, "")}'${i === last && t.length >= 2 ? ":*" : ""}`).join(any ? " | " : " & ");
    const r = await this.#pool.query(`SELECT k FROM ${this.#t} WHERE doc @@ to_tsquery('simple', $1) LIMIT $2`, [query, max]);
    return r.rows.map((x) => this.#keyKind(String(x.k)));
  }

  stop(): void {
    this.#unsubscribe();
  }
}

function compareKeys(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export function defineSearch<T>(model: Model<T, any>, spec: SearchSpec<T>): Search<T> {
  return new Search<T>(model, spec);
}
