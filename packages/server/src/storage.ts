import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Driver, Model, SqlDatabase } from "@weft-framework/data";
import { useDatabase } from "@weft-framework/data";

type Db = SqlDatabase & { close(): void };

export interface StorageOptions {
  database?: string;
  onWarning?(message: string): void;
}

function signature(m: Model<unknown>): string {
  return JSON.stringify([m.key, m.fields]);
}

export class ModelStorage {
  private db: Db | null = null;
  private dbPath: string | null = null;
  private memory = new Map<string, { sig: string; driver: Driver<unknown> }>();

  async attach(models: readonly Model<unknown>[], opts: StorageOptions = {}): Promise<void> {
    if (opts.database !== undefined) {
      if (this.dbPath !== opts.database) {
        const { openSqlite } = await import("@weft-framework/data/sqlite");
        if (opts.database !== ":memory:") {
          mkdirSync(dirname(opts.database), { recursive: true });
        }
        const next = openSqlite(opts.database);
        this.closeDb();
        this.db = next;
        this.dbPath = opts.database;
      }
      this.memory.clear();
      useDatabase(this.db!, models as unknown as Model<never>[], { onWarning: opts.onWarning });
      return;
    }
    this.closeDb();
    const seen = new Set<string>();
    for (const m of models) {
      const sig = signature(m);
      const prev = this.memory.get(m.name);
      if (prev && prev.sig === sig) {
        m.use(prev.driver);
      } else {
        this.memory.set(m.name, { sig, driver: m.driver });
      }
      seen.add(m.name);
    }
    for (const name of [...this.memory.keys()]) {
      if (!seen.has(name)) {
        this.memory.delete(name);
      }
    }
  }

  close(): void {
    this.closeDb();
    this.memory.clear();
  }

  private closeDb(): void {
    this.db?.close();
    this.db = null;
    this.dbPath = null;
  }
}
