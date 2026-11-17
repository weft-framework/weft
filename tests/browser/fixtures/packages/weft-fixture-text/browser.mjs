import impl from "./impl.cjs";

export const shout = (s) => impl.upper(s);
export const count = (s) => `${s.length} chars`;
