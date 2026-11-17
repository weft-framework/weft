import { defineModel, transaction, type Model, type PolicyExpr } from "@weft-framework/data";
import { AccessError } from "./errors.ts";

export type DeliveryMode = "off" | "instant" | "daily" | "weekly";
export type DigestPeriod = "daily" | "weekly";

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  url: string | null;
  data: Record<string, unknown>;
  tenant: string | null;
  created: number;
  read: number | null;
}

export interface Delivery {
  user: string;
  channel: string;
  notification: NotificationView;
}

export interface DigestDelivery {
  user: string;
  channel: string;
  period: DigestPeriod;
  notifications: NotificationView[];
}

export interface ChannelConfig {
  label: string;
  send(d: Delivery): unknown;
  digest?(d: DigestDelivery): unknown;
}

export interface TypeConfig<C extends string> {
  label: string;
  description?: string;
  channels: Partial<Record<"inApp" | C, DeliveryMode>>;
  locked?: readonly ("inApp" | C)[];
}

export interface NotificationsConfig<T extends string, C extends string> {
  types: Record<T, TypeConfig<NoInfer<C>>>;
  channels?: Record<C, ChannelConfig>;
  queue?: (task: { id: string; channel: NoInfer<C> }) => unknown;
  prefix?: string;
  maxPerUser?: number;
  keepReadMs?: number;
  onError?: (err: unknown) => void;
  now?: () => number;
}

export interface NotificationRow {
  id: string;
  user: string;
  tenant: string | null;
  type: string;
  title: string;
  body: string;
  url: string | null;
  data: string;
  created: number;
  read: number | null;
  inbox: boolean;
  pending: string[];
}

export interface PreferenceRow {
  id: string;
  user: string;
  type: string;
  modes: string;
  updated: number;
}

export interface NotificationModels {
  Notification: Model<NotificationRow>;
  NotificationPreference: Model<PreferenceRow>;
}

export interface ChannelPreference {
  channel: string;
  label: string;
  mode: DeliveryMode;
  modes: DeliveryMode[];
  locked: boolean;
}

export interface TypePreference {
  type: string;
  label: string;
  description: string;
  channels: ChannelPreference[];
}

class Inbox {
  readonly id: string;
  readonly user?: string;
  readonly all?: true;
  constructor(of: { user: string } | { all: true }) {
    if ("user" in of) {
      this.id = of.user;
      this.user = of.user;
    } else {
      this.id = "notifications:system";
      this.all = true;
    }
    Object.freeze(this);
  }
}

const SYSTEM = new Inbox({ all: true });

const allowed = (a: unknown, row: { user: string }): boolean =>
  a instanceof Inbox && (a.all === true || (a.user !== undefined && row.user === a.user));
const where: PolicyExpr = { or: [{ cmp: "==", l: { field: ["user"] }, r: { actor: ["user"] } }, { truthy: { actor: ["all"] } }] };

const IN_APP = "inApp";
const TYPE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const CHANNEL_RE = /^[a-z][A-Za-z0-9_]{0,31}$/;
const PREFIX_RE = /^[A-Z][A-Za-z0-9]{0,31}$/;
const MODES: readonly DeliveryMode[] = ["off", "instant", "daily", "weekly"];
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/;
const invalid = (msg: string): AccessError => new AccessError("invalid", msg);

function checkUser(user: unknown): string {
  if (typeof user !== "string" || user === "" || user.length > 200) throw invalid("a user id is a non-empty string of at most 200 characters");
  return user;
}

function safeUrl(url: unknown): string | null {
  if (url === undefined || url === null) return null;
  if (typeof url !== "string" || url.length > 2000 || CONTROL_RE.test(url) || /[\s\\]/.test(url)) throw invalid("url is a path or an https URL");
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw invalid("url is a path or an https URL");
  }
  if (u.protocol !== "https:" || u.username || u.password) throw invalid("url is a path or an https URL");
  return u.href;
}

export class Notifications<T extends string = string, C extends string = string> {
  readonly models: NotificationModels;
  readonly #types: Map<string, { label: string; description: string; defaults: Map<string, DeliveryMode>; locked: Set<string> }>;
  readonly #channels: Map<string, ChannelConfig>;
  readonly #queue?: (task: { id: string; channel: C }) => unknown;
  readonly #max: number;
  readonly #keepReadMs: number;
  readonly #onError: (err: unknown) => void;
  readonly #now: () => number;

  constructor(cfg: NotificationsConfig<T, C>) {
    if (!cfg || typeof cfg.types !== "object" || cfg.types === null) throw invalid("defineNotifications: types is required");
    this.#channels = new Map();
    for (const [name, ch] of Object.entries<ChannelConfig>((cfg.channels ?? {}) as Record<string, ChannelConfig>)) {
      if (!CHANNEL_RE.test(name) || name === IN_APP) throw invalid(`channel ${JSON.stringify(name)}: a name like "email" (inApp is built in)`);
      if (!ch || typeof ch.send !== "function" || typeof ch.label !== "string") throw invalid(`channel ${name}: { label, send } is required`);
      if (ch.digest !== undefined && typeof ch.digest !== "function") throw invalid(`channel ${name}: digest is a function`);
      this.#channels.set(name, ch);
    }
    this.#types = new Map();
    for (const [type, t] of Object.entries<TypeConfig<C>>(cfg.types as Record<string, TypeConfig<C>>)) {
      if (!TYPE_RE.test(type)) throw invalid(`type ${JSON.stringify(type)}: lower-case letters, digits, . _ -`);
      if (!t || typeof t.label !== "string" || t.label === "") throw invalid(`type ${type}: a label is required`);
      const defaults = new Map<string, DeliveryMode>();
      for (const [ch, mode] of Object.entries(t.channels ?? {}) as [string, DeliveryMode][]) {
        this.#checkMode(type, ch, mode);
        defaults.set(ch, mode);
      }
      const locked = new Set<string>(t.locked ?? []);
      for (const ch of locked) {
        if (ch !== IN_APP && !this.#channels.has(ch)) throw invalid(`type ${type}: locked channel ${ch} is not configured`);
        if ((defaults.get(ch) ?? "off") === "off") throw invalid(`type ${type}: locked channel ${ch} cannot default to off`);
      }
      this.#types.set(type, { label: t.label, description: t.description ?? "", defaults, locked });
    }
    if (this.#types.size === 0) throw invalid("defineNotifications: at least one type");
    if (cfg.queue !== undefined && typeof cfg.queue !== "function") throw invalid("defineNotifications: queue is a function");
    this.#queue = cfg.queue;
    this.#max = cfg.maxPerUser ?? 200;
    if (!Number.isInteger(this.#max) || this.#max < 10 || this.#max > 10_000) throw invalid("maxPerUser is 10-10000");
    this.#keepReadMs = cfg.keepReadMs ?? 90 * 86_400_000;
    if (!Number.isFinite(this.#keepReadMs) || this.#keepReadMs < 3_600_000) throw invalid("keepReadMs is at least an hour");
    this.#onError = cfg.onError ?? ((e) => console.error("[weft] notification delivery:", e));
    this.#now = cfg.now ?? Date.now;
    const prefix = cfg.prefix ?? "Notification";
    if (!PREFIX_RE.test(prefix)) throw invalid("prefix is a model name");
    const rules = { read: allowed, write: allowed, readWhere: where, writeWhere: where };
    this.models = {
      Notification: defineModel<NotificationRow>(prefix, {
        fields: {
          id: "string",
          user: "string",
          tenant: "string | null",
          type: "string",
          title: "string",
          body: "string",
          url: "string | null",
          data: "string",
          created: "number",
          read: "number | null",
          inbox: "boolean",
          pending: "string[]",
        },
        attrs: { user: { index: true } },
        ...rules,
      }),
      NotificationPreference: defineModel<PreferenceRow>(`${prefix}Preference`, {
        fields: { id: "string", user: "string", type: "string", modes: "string", updated: "number" },
        attrs: { user: { index: true } },
        ...rules,
      }),
    };
  }

  #checkMode(type: string, ch: string, mode: unknown): asserts mode is DeliveryMode {
    if (ch !== IN_APP && !this.#channels.has(ch)) throw invalid(`type ${type}: no channel ${ch}`);
    if (!MODES.includes(mode as DeliveryMode)) throw invalid(`type ${type}, ${ch}: mode is off, instant, daily or weekly`);
    if ((mode === "daily" || mode === "weekly") && (ch === IN_APP || !this.#channels.get(ch)!.digest)) {
      throw invalid(`type ${type}, ${ch}: this channel has no digest`);
    }
  }

  #type(type: unknown) {
    const t = typeof type === "string" ? this.#types.get(type) : undefined;
    if (!t) throw invalid(`no notification type ${JSON.stringify(type)}`);
    return t;
  }

  #modes(user: string, type: string): Map<string, DeliveryMode> {
    const t = this.#type(type);
    const out = new Map<string, DeliveryMode>([[IN_APP, t.defaults.get(IN_APP) ?? "off"]]);
    for (const ch of this.#channels.keys()) out.set(ch, t.defaults.get(ch) ?? "off");
    const row = this.models.NotificationPreference.as(new Inbox({ user })).get(prefId(user, type));
    if (row) {
      let chosen: Record<string, unknown> = {};
      try {
        chosen = JSON.parse(row.modes) as Record<string, unknown>;
      } catch {
      }
      for (const [ch, mode] of Object.entries(chosen)) {
        if (!out.has(ch) || t.locked.has(ch)) continue;
        try {
          this.#checkMode(type, ch, mode);
          out.set(ch, mode);
        } catch {
        }
      }
    }
    return out;
  }

  async send(
    user: string,
    type: T,
    n: { title: string; body?: string; url?: string; data?: Record<string, unknown>; tenant?: string | null },
  ): Promise<string | null> {
    checkUser(user);
    if (!n || typeof n.title !== "string" || n.title.trim() === "" || n.title.length > 200 || CONTROL_RE.test(n.title) || /[\r\n]/.test(n.title)) {
      throw invalid("title is one line of 1-200 characters");
    }
    const body = n.body ?? "";
    if (typeof body !== "string" || body.length > 2000 || CONTROL_RE.test(body)) throw invalid("body is text of at most 2000 characters");
    const url = safeUrl(n.url);
    const data = JSON.stringify(n.data ?? {});
    if (n.data !== undefined && (typeof n.data !== "object" || n.data === null || Array.isArray(n.data))) throw invalid("data is an object");
    if (data.length > 4096) throw invalid("data is at most 4 KiB of JSON");
    const tenant = n.tenant ?? null;
    if (tenant !== null && (typeof tenant !== "string" || tenant === "")) throw invalid("tenant is a tenant id");
    const modes = this.#modes(user, type);
    const inbox = modes.get(IN_APP) === "instant";
    const pending = [...modes].filter(([ch, m]) => ch !== IN_APP && m !== "off").map(([ch, m]) => `${ch}:${m}`);
    if (!inbox && pending.length === 0) return null;
    const id = crypto.randomUUID();
    const me = this.models.Notification.as(new Inbox({ user }));
    transaction(() => {
      me.create({ id, user, tenant, type, title: n.title, body, url, data, created: this.#now(), read: null, inbox, pending });
      if (inbox) this.#cap(user);
    });
    for (const p of pending) {
      if (!p.endsWith(":instant")) continue;
      const channel = p.slice(0, -":instant".length) as C;
      if (this.#queue) {
        await this.#queue({ id, channel });
      } else {
        try {
          await this.deliver(id, channel);
        } catch (err) {
          this.#onError(err);
        }
      }
    }
    return id;
  }

  #cap(user: string): void {
    const me = this.models.Notification.as(new Inbox({ user }));
    const rows = me.where((r) => r.inbox);
    if (rows.length <= this.#max) return;
    const order = rows.sort((a, b) => (a.read === null ? 1 : 0) - (b.read === null ? 1 : 0) || a.created - b.created || (a.id < b.id ? -1 : 1));
    const drop = new Set(order.slice(0, rows.length - this.#max).map((r) => r.id));
    me.delete((r) => drop.has(r.id));
  }

  async deliver(id: string, channel: string): Promise<boolean> {
    const ch = this.#channels.get(channel);
    if (!ch) throw invalid(`no channel ${JSON.stringify(channel)}`);
    const all = this.models.Notification.as(SYSTEM);
    const row = typeof id === "string" ? all.get(id) : undefined;
    const mark = `${channel}:instant`;
    if (!row || !row.pending.includes(mark)) return false;
    await ch.send({ user: row.user, channel, notification: view(row) });
    this.#settle(row.id, [mark]);
    return true;
  }

  #settle(id: string, marks: string[]): void {
    const all = this.models.Notification.as(SYSTEM);
    transaction(() => {
      const now = all.get(id);
      if (!now) return;
      const pending = now.pending.filter((p) => !marks.includes(p));
      if (!now.inbox && pending.length === 0) all.delete((r) => r.id === id);
      else all.update((r) => r.id === id, { pending });
    });
  }

  async digest(period: DigestPeriod): Promise<number> {
    if (period !== "daily" && period !== "weekly") throw invalid('period is "daily" or "weekly"');
    const all = this.models.Notification.as(SYSTEM);
    let sent = 0;
    const failures: unknown[] = [];
    for (const [channel, ch] of this.#channels) {
      if (!ch.digest) continue;
      const mark = `${channel}:${period}`;
      const byUser = new Map<string, NotificationRow[]>();
      for (const r of all.where((r) => r.pending.includes(mark))) {
        const list = byUser.get(r.user) ?? [];
        list.push(r);
        byUser.set(r.user, list);
      }
      for (const [user, rows] of byUser) {
        const due: NotificationRow[] = [];
        const dropped: NotificationRow[] = [];
        for (const r of rows) {
          let mode: DeliveryMode = "off";
          try {
            mode = this.#modes(user, r.type).get(channel) ?? "off";
          } catch {
          }
          (mode === "off" ? dropped : due).push(r);
        }
        for (const r of dropped) this.#settle(r.id, [mark]);
        if (due.length === 0) continue;
        due.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
        try {
          await ch.digest({ user, channel, period, notifications: due.map(view) });
        } catch (err) {
          failures.push(err);
          continue;
        }
        for (const r of due) this.#settle(r.id, [mark]);
        sent++;
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `${failures.length} digests failed`);
    return sent;
  }

  inbox(user: string, opts: { limit?: number; before?: string; unread?: boolean } = {}): NotificationView[] {
    checkUser(user);
    const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 50)), 200);
    let rows = this.models.Notification.as(new Inbox({ user })).where((r) => r.inbox && (!opts.unread || r.read === null));
    rows.sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
    if (opts.before !== undefined) {
      const at = rows.findIndex((r) => r.id === opts.before);
      rows = at < 0 ? [] : rows.slice(at + 1);
    }
    return rows.slice(0, limit).map(view);
  }

  unread(user: string): number {
    checkUser(user);
    return this.models.Notification.as(new Inbox({ user })).where((r) => r.inbox && r.read === null).length;
  }

  markRead(user: string, ids: readonly string[] | "all"): number {
    checkUser(user);
    const pick = ids === "all" ? null : new Set(ids);
    return this.models.Notification.as(new Inbox({ user })).update(
      (r) => r.inbox && r.read === null && (pick === null || pick.has(r.id)),
      { read: this.#now() },
    );
  }

  markUnread(user: string, ids: readonly string[]): number {
    checkUser(user);
    const pick = new Set(ids);
    return this.models.Notification.as(new Inbox({ user })).update((r) => r.inbox && r.read !== null && pick.has(r.id), { read: null });
  }

  remove(user: string, ids: readonly string[] | "all"): number {
    checkUser(user);
    const pick = ids === "all" ? null : new Set(ids);
    return this.models.Notification.as(new Inbox({ user })).delete((r) => r.inbox && (pick === null || pick.has(r.id)));
  }

  preferences(user: string): TypePreference[] {
    checkUser(user);
    const out: TypePreference[] = [];
    for (const [type, t] of this.#types) {
      const modes = this.#modes(user, type);
      const channels: ChannelPreference[] = [];
      for (const [ch, mode] of modes) {
        const cfg = ch === IN_APP ? null : this.#channels.get(ch)!;
        const locked = t.locked.has(ch);
        const options: DeliveryMode[] = ch === IN_APP ? ["off", "instant"] : cfg!.digest ? [...MODES] : ["off", "instant"];
        channels.push({
          channel: ch,
          label: cfg ? cfg.label : "In the app",
          mode,
          modes: locked ? options.filter((m) => m !== "off") : options,
          locked,
        });
      }
      out.push({ type, label: t.label, description: t.description, channels });
    }
    return out;
  }

  setPreference(user: string, type: T, channel: "inApp" | C, mode: DeliveryMode): void {
    checkUser(user);
    const t = this.#type(type);
    if (typeof channel !== "string" || (channel !== IN_APP && !this.#channels.has(channel))) throw invalid(`no channel ${JSON.stringify(channel)}`);
    this.#checkMode(type, channel, mode);
    if (t.locked.has(channel) && mode === "off") throw invalid(`${type} notifications cannot be turned off for ${channel}`);
    const me = this.models.NotificationPreference.as(new Inbox({ user }));
    const id = prefId(user, type);
    transaction(() => {
      const row = me.get(id);
      let chosen: Record<string, unknown> = {};
      try {
        chosen = row ? (JSON.parse(row.modes) as Record<string, unknown>) : {};
      } catch {
        chosen = {};
      }
      const next = JSON.stringify({ ...chosen, [channel]: mode });
      if (row) me.update((r) => r.id === id, { modes: next, updated: this.#now() });
      else me.create({ id, user, type, modes: next, updated: this.#now() });
    });
  }

  prune(): number {
    const before = this.#now() - this.#keepReadMs;
    return this.models.Notification.as(SYSTEM).delete((r) => r.read !== null && r.read < before && r.pending.length === 0);
  }

  forget(user: string): number {
    checkUser(user);
    const n = this.models.Notification.as(new Inbox({ user })).delete(() => true);
    this.models.NotificationPreference.as(new Inbox({ user })).delete(() => true);
    return n;
  }
}

function prefId(user: string, type: string): string {
  return JSON.stringify([user, type]);
}

function view(r: NotificationRow): NotificationView {
  let data: Record<string, unknown> = {};
  try {
    const d = JSON.parse(r.data) as unknown;
    if (d && typeof d === "object" && !Array.isArray(d)) data = d as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { id: r.id, type: r.type, title: r.title, body: r.body, url: r.url, data, tenant: r.tenant, created: r.created, read: r.read };
}

export function defineNotifications<const T extends string, const C extends string = never>(
  config: NotificationsConfig<T, C>,
): Notifications<T, C> {
  return new Notifications<T, C>(config);
}
