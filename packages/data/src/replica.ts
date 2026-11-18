import type { Change, ChangeFeed } from "./changes.ts";
import { MemoryDriver, isAsyncDriver, type AsyncDriver, type Model, type Scope } from "./model.ts";
import type { DriverQuery } from "./query.ts";
import { afterCommit } from "./tx.ts";

export interface Replica<T> extends AsyncDriver<T> {
  readonly local: MemoryDriver<T>;
  apply(change: Change<T>): Promise<void>;
  follow(feed: ChangeFeed): () => void;
  reload(): Promise<void>;
}

export async function replicate<T>(model: Model<T>): Promise<Replica<T>> {
  const inner = model.attached;
  if (!isAsyncDriver(inner)) {
    throw new Error(`${model.name}: replicate() is for models on an async driver (Postgres); sync drivers are read directly`);
  }
  if ((inner as Partial<Replica<T>>).follow !== undefined) return inner as Replica<T>;
  const key = model.key;
  let local = new MemoryDriver<T>(key);
  const keyOf = (row: T) => (row as Record<string, unknown>)[key];
  const upsert = (row: T) => {
    const k = keyOf(row);
    if (local.select([], k).length > 0) local.update(k, row);
    else local.insert(row);
  };
  const load = async () => {
    const next = new MemoryDriver<T>(key);
    for (const row of await inner.select([])) next.insert(row);
    local = next;
  };
  await load();

  const replica: Replica<T> = {
    async: true,
    get local() {
      return local;
    },
    select: (scopes: Scope[], k?: unknown) => inner.select(scopes, k),
    ...(inner.query ? { query: (scopes: Scope[], q: DriverQuery) => inner.query!(scopes, q) } : {}),
    async insert(row: T) {
      await inner.insert(row);
      afterCommit(() => upsert(row));
    },
    async update(k: unknown, row: T) {
      await inner.update(k, row);
      afterCommit(() => upsert(row));
    },
    async delete(k: unknown) {
      await inner.delete(k);
      afterCommit(() => local.delete(k));
    },
    async apply(change: Change<T>) {
      if (change.model !== model.name) return;
      if (change.op === "delete") {
        local.delete(change.key);
        return;
      }
      if (change.after !== undefined && !change.redacted) {
        upsert(change.after);
        return;
      }
      if (change.key === undefined) {
        await load();
        return;
      }
      const [row] = await inner.select([], change.key);
      if (row === undefined) local.delete(change.key);
      else upsert(row);
    },
    follow(feed: ChangeFeed) {
      const fail = (err: unknown) => console.error(`[weft/data] replica ${model.name}:`, err);
      const off = feed.subscribe((c) => {
        if (c.model === model.name) replica.apply(c as Change<T>).catch(fail);
      });
      const offGap = feed.onGap(() => {
        load().catch(fail);
      });
      return () => {
        off();
        offGap();
      };
    },
    reload: load,
  };
  model.use(replica);
  return replica;
}
