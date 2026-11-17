export type ClientFn = (...args: never[]) => unknown;

export type Attachment<E extends Element = HTMLElement, V = unknown> = (el: E, value: V) => unknown;

export interface IslandInstance {
  fns: Record<string, ClientFn>;
  binds: (() => unknown)[];
  uses?: [(el: never, value: never) => unknown, (() => unknown)?][];
  mount?: (() => unknown)[];
  destroy?: (() => unknown)[];
  snapshot(): unknown[];
  restore(values: unknown[]): void;
}

export interface IslandDef {
  readonly name: string;
  readonly setup: () => IslandInstance;
}

export type IslandRegistry = Record<string, IslandDef>;

export function defineIsland(name: string, setup: () => IslandInstance): IslandDef {
  return Object.freeze({ name, setup });
}
