import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AnyDriver, Model, SqlDatabase } from "@weft-framework/data";
import { useDatabase } from "@weft-framework/data";
import type { ClosablePgPool } from "@weft-framework/data/postgres";

type Db = SqlDatabase & { close(): void };

export interface StorageOptions {
  /** SQLite file, ":memory:", `postgres://…` or `pglite:<dir>`. */
  database?: string;
  onWarning?(message: string): void;
}

function signature(m: Model<unknown>): string {
  return JSON.stringify([m.key, m.fields]);
}

function isPg(database: string): boolean {
  return /^postgres(ql)?:\/\//i.test(database) || database.startsWith("pglite:");
}

export class ModelStorage {
  private db: Db | null = null;
  private pool: ClosablePgPool | null = null;
  private dbPath: string | null = null;
  /** Postgres: the global change feed is bridged across instances over LISTEN/NOTIFY. */
  private unbridge: (() => Promise<void>) | null = null;
  private memory = new Map<string, { sig: string; driver: AnyDriver<unknown> }>();

  async attach(models: readonly Model<unknown>[], opts: StorageOptions = {}): Promise<void> {
    if (opts.database !== undefined && isPg(opts.database)) {
      const pg = await import("@weft-framework/data/postgres");
      if (this.dbPath !== opts.database || this.pool === null) {
        const next = await pg.openPostgres(opts.database);
        await this.closeDb();
        this.pool = next;
        this.dbPath = opts.database;
        if (!opts.database.startsWith("pglite:")) {
          const { bridgeChanges, changes } = await import("@weft-framework/data");
          const channel = pg.pgBroadcast(next);
          const off = bridgeChanges(changes, channel);
          this.unbridge = async () => {
            off();
            await channel.close();
          };
        }
      }
      this.memory.clear();
      await pg.usePostgres(this.pool!, models as unknown as Model<never>[], { onWarning: opts.onWarning });
      return;
    }
    if (opts.database !== undefined) {
      if (this.dbPath !== opts.database || this.db === null) {
        const { openSqlite } = await import("@weft-framework/data/sqlite");
        if (opts.database !== ":memory:") {
          mkdirSync(dirname(opts.database), { recursive: true });
        }
        const next = openSqlite(opts.database);
        await this.closeDb();
        this.db = next;
        this.dbPath = opts.database;
      }
      this.memory.clear();
      useDatabase(this.db!, models as unknown as Model<never>[], { onWarning: opts.onWarning });
      return;
    }
    await this.closeDb();
    const seen = new Set<string>();
    for (const m of models) {
      const sig = signature(m);
      const prev = this.memory.get(m.name);
      if (prev && prev.sig === sig) {
        m.use(prev.driver);
      } else {
        this.memory.set(m.name, { sig, driver: m.attached });
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
    void this.closeDb();
    this.memory.clear();
  }

  private async closeDb(): Promise<void> {
    this.db?.close();
    this.db = null;
    const pool = this.pool;
    const unbridge = this.unbridge;
    this.pool = null;
    this.unbridge = null;
    this.dbPath = null;
    if (unbridge) await unbridge();
    if (pool) await pool.end();
  }
}
