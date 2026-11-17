import { DatabaseSync } from "node:sqlite";
import type { SqlDatabase } from "./sql.ts";

export interface OpenOptions {
  readOnly?: boolean;
}

export function openSqlite(path: string, opts: OpenOptions = {}): SqlDatabase & { close(): void } {
  const db = new DatabaseSync(path, { readOnly: opts.readOnly ?? false });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:" && !opts.readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
  }
  return db as unknown as SqlDatabase & { close(): void };
}
