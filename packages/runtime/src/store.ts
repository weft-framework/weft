import { signal, type Signal } from "./signal.ts";

export type StoreScope = "app" | "session";

export interface Store<T> {
  value: T;
  readonly name: string;
  readonly scope: StoreScope;
}

export interface StoreHooks {
  session(): string | undefined;
  read?(store: Store<unknown>, session: string | undefined): void;
  write?(store: Store<unknown>, session: string | undefined): void;
}

let hooks: StoreHooks = { session: () => undefined };

export function configureStores(h: StoreHooks): void {
  hooks = h;
}

export interface StoreOptions {
  maxSessions?: number;
}

const DEFAULT_MAX_SESSIONS = 10_000;

export function defineStore<T>(name: string, scope: StoreScope, init: () => T, opts: StoreOptions = {}): Store<T> {
  if (scope !== "app" && scope !== "session") {
    throw new Error(`@weft/runtime: store ${name}: unknown scope ${String(scope)}`);
  }
  const max = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  let app: Signal<T> | null = null;
  const sessions = new Map<string, Signal<T>>();

  const cell = (): { sig: Signal<T>; sid: string | undefined } => {
    if (scope === "app") {
      app ??= signal(init());
      return { sig: app, sid: undefined };
    }
    const sid = hooks.session();
    if (sid === undefined) {
      throw new Error(`@weft/runtime: session store ${name} used outside a request`);
    }
    let sig = sessions.get(sid);
    if (sig) {
      sessions.delete(sid);
    } else {
      sig = signal(init());
      if (sessions.size >= max) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined) sessions.delete(oldest);
      }
    }
    sessions.set(sid, sig);
    return { sig, sid };
  };

  const store: Store<T> = {
    name,
    scope,
    get value(): T {
      const { sig, sid } = cell();
      hooks.read?.(store as Store<unknown>, sid);
      return sig.value;
    },
    set value(next: T) {
      const { sig, sid } = cell();
      const before = sig.value;
      sig.value = next;
      if (!Object.is(before, next)) {
        hooks.write?.(store as Store<unknown>, sid);
      }
    },
  };
  return Object.freeze(store);
}

export interface Room<T> {
  readonly name: string;
  in(key: string): Store<T>;
  drop(key: string): void;
  readonly size: number;
}

export interface RoomOptions {
  maxRooms?: number;
}

const MAX_ROOM_KEY = 256;

export function defineRoom<T>(name: string, init: (key: string) => T, opts: RoomOptions = {}): Room<T> {
  const max = opts.maxRooms ?? DEFAULT_MAX_SESSIONS;
  const keys = new Map<string, Store<T>>();
  const room: Room<T> = {
    name,
    in(key: string): Store<T> {
      if (typeof key !== "string" || key === "" || key.length > MAX_ROOM_KEY) {
        throw new Error(`@weft/runtime: room ${name}: a key is a string of 1-${MAX_ROOM_KEY} characters`);
      }
      let store = keys.get(key);
      if (store) {
        keys.delete(key);
      } else {
        store = defineStore(`${name}[${JSON.stringify(key)}]`, "app", () => init(key));
        if (keys.size >= max) {
          const oldest = keys.keys().next().value;
          if (oldest !== undefined) keys.delete(oldest);
        }
      }
      keys.set(key, store);
      return store;
    },
    drop(key: string): void {
      keys.delete(key);
    },
    get size(): number {
      return keys.size;
    },
  };
  return Object.freeze(room);
}
