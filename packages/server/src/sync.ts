import { AsyncLocalStorage } from "node:async_hooks";
import { canSee, onRead, UNSCOPED, type Actor, type Change, type Model } from "@weft/data";
import { configureStores, type Store } from "@weft/runtime";

const MAX_ACTORS = 32;
const MAX_KEYS = 256;

export class DepsIndex<O> {
  private readonly models = new Map<string, Set<Deps<O>>>();
  private readonly storeReads = new Map<Store<unknown>, Set<Deps<O>>>();

  deps(owner: O | null = null): Deps<O> {
    return new Deps(this, owner);
  }

  readersOf(name: string): Set<O> {
    return owners(this.models.get(name));
  }

  readersOfStore(store: Store<unknown>): Set<O> {
    return owners(this.storeReads.get(store));
  }

  get size(): number {
    return this.models.size;
  }

  join(deps: Deps<O>, model: string | null, store: Store<unknown> | null): void {
    const [map, k] = model !== null ? [this.models, model] : [this.storeReads, store];
    let set = (map as Map<unknown, Set<Deps<O>>>).get(k);
    if (!set) {
      set = new Set();
      (map as Map<unknown, Set<Deps<O>>>).set(k, set);
    }
    set.add(deps);
  }

  leave(deps: Deps<O>): void {
    for (const name of deps.reads.keys()) {
      const set = this.models.get(name);
      set?.delete(deps);
      if (set?.size === 0) this.models.delete(name);
    }
    for (const store of deps.stores) {
      const set = this.storeReads.get(store);
      set?.delete(deps);
      if (set?.size === 0) this.storeReads.delete(store);
    }
  }
}

function owners<O>(set: Set<Deps<O>> | undefined): Set<O> {
  const out = new Set<O>();
  for (const d of set ?? []) {
    if (d.owner !== null) out.add(d.owner);
  }
  return out;
}

export class Deps<O = unknown> {
  readonly reads = new Map<string, { model: Model<unknown>; actors: Set<Actor | typeof UNSCOPED>; keys: Set<unknown> | null }>();
  readonly stores = new Set<Store<unknown>>();
  owner: O | null;
  private readonly index: DepsIndex<O> | null;
  private released = false;

  constructor(index: DepsIndex<O> | null = null, owner: O | null = null) {
    this.index = index;
    this.owner = null;
    if (owner !== null) this.adopt(owner);
  }

  renew(): Deps<O> {
    this.release();
    return new Deps(this.index, this.owner);
  }

  adopt(owner: O): void {
    this.owner = owner;
    if (this.released || !this.index) return;
    for (const name of this.reads.keys()) this.index.join(this, name, null);
    for (const store of this.stores) this.index.join(this, null, store);
  }

  release(): void {
    if (!this.released) {
      this.released = true;
      this.index?.leave(this);
    }
  }

  addStore(store: Store<unknown>): void {
    if (!this.stores.has(store)) {
      this.stores.add(store);
      if (this.owner !== null && !this.released) this.index?.join(this, null, store);
    }
  }

  add(model: Model<unknown>, actor: Actor | typeof UNSCOPED, key?: unknown): void {
    let r = this.reads.get(model.name);
    if (!r) {
      r = { model, actors: new Set(), keys: key === undefined ? null : new Set() };
      this.reads.set(model.name, r);
      if (this.owner !== null && !this.released) this.index?.join(this, model.name, null);
    }
    if (key === undefined || (typeof key !== "string" && typeof key !== "number")) r.keys = null;
    else if (r.keys !== null) {
      r.keys.add(key);
      if (r.keys.size > MAX_KEYS) r.keys = null;
    }
    if (r.actors.has(UNSCOPED)) {
      return;
    }
    if (r.actors.size >= MAX_ACTORS) {
      r.actors.clear();
      r.actors.add(UNSCOPED);
      return;
    }
    r.actors.add(actor);
  }

  concerns(change: Change): boolean {
    const r = this.reads.get(change.model);
    if (!r || (r.keys !== null && !r.keys.has(change.key))) {
      return false;
    }
    for (const actor of r.actors) {
      if (canSee(r.model, actor, change)) {
        return true;
      }
    }
    return false;
  }

  admits(change: Change): boolean {
    const r = this.reads.get(change.model);
    if (!r || (r.keys !== null && !r.keys.has(change.key))) return false;
    for (const actor of r.actors) {
      if (actor !== UNSCOPED && canSee(r.model, actor, change)) return true;
    }
    return false;
  }
}

const current = new AsyncLocalStorage<Deps>();
const session = new AsyncLocalStorage<string>();
const storeWatchers = new Set<(store: Store<unknown>, sid: string | undefined) => void>();

configureStores({
  session: () => session.getStore(),
  read: (store) => current.getStore()?.addStore(store),
  write: (store, sid) => {
    for (const w of storeWatchers) {
      w(store, sid);
    }
  },
});

export function withSession<R>(sid: string, fn: () => R): R {
  return session.run(sid, fn);
}

export function currentSession(): string | undefined {
  return session.getStore();
}

export function onStoreWrite(fn: (store: Store<unknown>, sid: string | undefined) => void): () => void {
  storeWatchers.add(fn);
  return () => {
    storeWatchers.delete(fn);
  };
}
let stopObserving: (() => void) | null = null;

export function track<R, O>(deps: Deps<O>, fn: () => R): R {
  stopObserving ??= onRead((model, actor, key) => current.getStore()?.add(model, actor, key));
  return current.run(deps as Deps<unknown>, fn);
}
