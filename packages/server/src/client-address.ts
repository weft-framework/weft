import { BlockList, isIP } from "node:net";

export type TrustedProxies = number | readonly string[];

const peers = new WeakMap<Request, string | null>();

export function normalizeAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let a = raw.trim();
  if (a.startsWith("[")) {
    const end = a.indexOf("]");
    if (end < 0) return null;
    a = a.slice(1, end);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(a)) {
    a = a.slice(0, a.lastIndexOf(":"));
  }
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (mapped) a = mapped[1]!;
  return isIP(a) === 0 ? null : a.toLowerCase();
}

export function checkTrustedProxies(t: TrustedProxies | undefined, where = "trustedProxies"): TrustedProxies | undefined {
  if (t === undefined) return undefined;
  if (typeof t === "number") {
    if (!Number.isInteger(t) || t < 0 || t > 10) throw new TypeError(`${where}: a hop count is 0 to 10`);
    return t;
  }
  if (!Array.isArray(t)) throw new TypeError(`${where}: a hop count or a list of addresses/CIDR ranges`);
  for (const c of t) {
    if (!cidr(c)) throw new TypeError(`${where}: \`${String(c)}\` is not an address or CIDR range`);
  }
  return Object.freeze([...t]);
}

export function parseTrustedProxies(raw: string | undefined): TrustedProxies | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const t = raw.trim();
  return checkTrustedProxies(/^\d+$/.test(t) ? Number(t) : t.split(",").map((s) => s.trim()).filter((s) => s !== ""), "WEFT_TRUSTED_PROXIES");
}

function cidr(raw: unknown): { address: string; prefix: number; type: "ipv4" | "ipv6" } | null {
  if (typeof raw !== "string") return null;
  const [address, bits, extra] = raw.trim().split("/");
  if (!address || extra !== undefined) return null;
  const v = isIP(address);
  if (v === 0) return null;
  const max = v === 4 ? 32 : 128;
  if (bits !== undefined && !/^\d{1,3}$/.test(bits)) return null;
  const prefix = bits === undefined ? max : Number(bits);
  return prefix > max ? null : { address, prefix, type: v === 4 ? "ipv4" : "ipv6" };
}

function trustList(ranges: readonly string[]): (ip: string) => boolean {
  const list = new BlockList();
  for (const r of ranges) {
    const c = cidr(r)!;
    list.addSubnet(c.address, c.prefix, c.type);
  }
  return (ip) => list.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
}

export function resolveClientAddress(peer: string | null, forwardedFor: string | null, trusted: TrustedProxies | undefined): string | null {
  const socket = normalizeAddress(peer);
  if (trusted === undefined || trusted === 0 || (Array.isArray(trusted) && trusted.length === 0)) return socket;
  const hops = (forwardedFor ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
  if (typeof trusted === "number") {
    if (hops.length < trusted) return null;
    return normalizeAddress(hops[hops.length - trusted]);
  }
  const isTrusted = trustList(trusted as readonly string[]);
  if (socket === null || !isTrusted(socket)) return socket;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeAddress(hops[i]);
    if (hop === null) return null;
    if (!isTrusted(hop)) return hop;
  }
  return null;
}

export function peerTrusted(peer: string | null, trusted: TrustedProxies | undefined): boolean {
  if (trusted === undefined) return false;
  if (typeof trusted === "number") return trusted > 0;
  const socket = normalizeAddress(peer);
  return socket !== null && trusted.length > 0 && trustList(trusted)(socket);
}

export function attachClientAddress(req: Request, address: string | null): Request {
  peers.set(req, address);
  return req;
}

export function clientAddress(req: Request): string | null {
  return peers.get(req) ?? null;
}
