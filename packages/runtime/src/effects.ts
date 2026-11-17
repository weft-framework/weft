export type Capability = "db" | "net" | "fs" | "auth";

export type EffectOf<M, K extends string> = M extends { readonly [P in `__weftEffects_${K}`]: infer E } ? E : never;

export type WeftWithin<Allowed extends Capability, E extends Allowed> = E;
