import { defineModel, transaction, type Model, type PolicyExpr } from "@weft/data";
import { AccessError } from "./errors.ts";

export interface ConversationRow {
  id: string;
  kind: string;
  key: string;
  title: string;
  owner: string;
  created: number;
  updated: number;
  seq: number;
}

export interface MemberRow {
  id: string;
  conversation: string;
  user: string;
  joined: number;
  lastRead: number;
  since: number;
  left: number | null;
  typingUntil: number;
}

export interface MessageRow {
  id: string;
  conversation: string;
  seq: number;
  author: string;
  body: string;
  created: number;
  edited: number | null;
  deleted: boolean;
}

export interface ChatModels {
  Conversation: Model<ConversationRow, never>;
  ConversationMember: Model<MemberRow, never>;
  Message: Model<MessageRow, never>;
}

export interface ChatConfig {
  allow(from: string, to: string): boolean;
  prefix?: string;
  maxBody?: number;
  maxMembers?: number;
  maxTitle?: number;
  editMinutes?: number;
  typingMs?: number;
  now?(): number;
}

export interface MessageView {
  id: string;
  seq: number;
  author: string;
  body: string;
  created: number;
  edited: number | null;
  deleted: boolean;
  mine: boolean;
}

export interface ConversationView {
  id: string;
  kind: "direct" | "group";
  title: string;
  members: string[];
  owner: string;
  updated: number;
  unread: number;
  last: MessageView | null;
}

class Reader {
  readonly id: string;
  readonly conversation?: string;
  readonly user?: string;
  readonly all?: true;
  constructor(of: { conversation: string } | { user: string } | { all: true }) {
    if ("conversation" in of) {
      this.id = `chat:${of.conversation}`;
      this.conversation = of.conversation;
    } else if ("user" in of) {
      this.id = of.user;
      this.user = of.user;
    } else {
      this.id = "chat:system";
      this.all = true;
    }
    Object.freeze(this);
  }
}
const SYSTEM = new Reader({ all: true });

const ofConversation = (field: "id" | "conversation") => ({
  read: (a: unknown, row: object) => a instanceof Reader && (a.all === true || (a.conversation !== undefined && (row as Record<string, unknown>)[field] === a.conversation)),
  where: { or: [{ cmp: "==", l: { field: [field] }, r: { actor: ["conversation"] } }, { truthy: { actor: ["all"] } }] } as PolicyExpr,
});
const memberRule = {
  read: (a: unknown, row: MemberRow) =>
    a instanceof Reader && (a.all === true || (a.conversation !== undefined && row.conversation === a.conversation) || (a.user !== undefined && row.user === a.user)),
  where: {
    or: [
      { cmp: "==", l: { field: ["conversation"] }, r: { actor: ["conversation"] } },
      { cmp: "==", l: { field: ["user"] }, r: { actor: ["user"] } },
      { truthy: { actor: ["all"] } },
    ],
  } as PolicyExpr,
};

const PREFIX_RE = /^[A-Z][A-Za-z0-9]{0,31}$/;
const ID_RE = /^[cm]_[0-9a-f]{32}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g;
const invalid = (msg: string) => new AccessError("invalid", msg);
const notFound = () => new AccessError("not-found", "no such conversation or message");

function checkUser(user: unknown): string {
  if (typeof user !== "string" || user === "" || user.length > 200) throw invalid("a user id is a non-empty string of at most 200 characters");
  return user;
}

const newId = (p: "c" | "m") => `${p}_${crypto.randomUUID().replace(/-/g, "")}`;
const memberId = (conversation: string, user: string) => `${conversation}:${user}`;

export class Chat {
  readonly models: ChatModels;
  readonly #allow: (from: string, to: string) => boolean;
  readonly #maxBody: number;
  readonly #maxMembers: number;
  readonly #maxTitle: number;
  readonly #editMs: number;
  readonly #typingMs: number;
  readonly #now: () => number;
  readonly #typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(cfg: ChatConfig) {
    if (!cfg || typeof cfg.allow !== "function") throw invalid("defineChat: allow(from, to) is required");
    this.#allow = cfg.allow;
    const whole = (v: number | undefined, d: number, lo: number, hi: number, what: string) => {
      const x = v ?? d;
      if (!Number.isInteger(x) || x < lo || x > hi) throw invalid(`defineChat: ${what} is ${lo}-${hi}`);
      return x;
    };
    this.#maxBody = whole(cfg.maxBody, 4000, 1, 100_000, "maxBody");
    this.#maxMembers = whole(cfg.maxMembers, 100, 2, 10_000, "maxMembers");
    this.#maxTitle = whole(cfg.maxTitle, 100, 1, 1000, "maxTitle");
    this.#editMs = whole(cfg.editMinutes, 15, 0, 60 * 24 * 365, "editMinutes") * 60_000;
    this.#typingMs = whole(cfg.typingMs, 6000, 1000, 60_000, "typingMs");
    this.#now = cfg.now ?? Date.now;
    const prefix = cfg.prefix ?? "";
    if (prefix !== "" && !PREFIX_RE.test(prefix)) throw invalid("prefix is a model name");
    const conv = ofConversation("id");
    const msg = ofConversation("conversation");
    this.models = {
      Conversation: defineModel<ConversationRow>(`${prefix}Conversation`, {
        fields: { id: "string", kind: "string", key: "string", title: "string", owner: "string", created: "number", updated: "number", seq: "number" },
        attrs: { key: { unique: true } },
        read: conv.read,
        write: conv.read,
        readWhere: conv.where,
        writeWhere: conv.where,
      }),
      ConversationMember: defineModel<MemberRow>(`${prefix}ConversationMember`, {
        fields: {
          id: "string",
          conversation: "string",
          user: "string",
          joined: "number",
          lastRead: "number",
          since: "number",
          left: "number | null",
          typingUntil: "number",
        },
        attrs: { conversation: { index: true }, user: { index: true } },
        read: memberRule.read,
        write: memberRule.read,
        readWhere: memberRule.where,
        writeWhere: memberRule.where,
      }),
      Message: defineModel<MessageRow>(`${prefix}Message`, {
        fields: { id: "string", conversation: "string", seq: "number", author: "string", body: "string", created: "number", edited: "number | null", deleted: "boolean" },
        attrs: { conversation: { index: true } },
        read: msg.read,
        write: msg.read,
        readWhere: msg.where,
        writeWhere: msg.where,
      }),
    } as ChatModels;
  }

  #member(user: string, conversation: unknown): MemberRow {
    checkUser(user);
    if (typeof conversation !== "string" || !ID_RE.test(conversation) || !conversation.startsWith("c_")) throw notFound();
    const m = this.models.ConversationMember.as(new Reader({ user })).get(memberId(conversation, user));
    if (!m || m.left !== null) throw notFound();
    return m;
  }

  #in(conversation: string) {
    const r = new Reader({ conversation });
    return { conv: this.models.Conversation.as(r), members: this.models.ConversationMember.as(r), messages: this.models.Message.as(r) };
  }

  #current(conversation: string): MemberRow[] {
    return this.#in(conversation).members.where((m) => m.left === null);
  }

  #title(title: unknown): string {
    if (typeof title !== "string") throw invalid("a title is text");
    const t = title.replace(CONTROL_RE, "").replace(/\s+/g, " ").trim();
    if (t === "" || [...t].length > this.#maxTitle) throw invalid(`a title is 1-${this.#maxTitle} characters`);
    return t;
  }

  #body(body: unknown): string {
    if (typeof body !== "string") throw invalid("a message is text");
    const b = body.replace(/\r\n?/g, "\n").replace(CONTROL_RE, "").trim();
    if (b === "") throw invalid("a message is not empty");
    if ([...b].length > this.#maxBody) throw invalid(`a message is at most ${this.#maxBody} characters`);
    return b;
  }

  #join(conversation: string, user: string, now: number): void {
    const { members } = this.#in(conversation);
    const id = memberId(conversation, user);
    const seq = this.#in(conversation).conv.get(conversation)?.seq ?? 0;
    if (members.get(id)) members.update((m) => m.id === id, { left: null, joined: now, lastRead: seq, since: seq, typingUntil: 0 });
    else members.create({ id, conversation, user, joined: now, lastRead: seq, since: seq, left: null, typingUntil: 0 });
  }

  startDirect(from: string, to: string): string {
    checkUser(from);
    checkUser(to);
    if (from === to) throw invalid("a direct conversation is with someone else");
    const key = JSON.stringify([from, to].sort());
    const existing = this.models.Conversation.as(SYSTEM).query().where({ key, kind: "direct" }).first() as ConversationRow | undefined;
    if (existing) {
      const mine = this.models.ConversationMember.as(new Reader({ user: from })).get(memberId(existing.id, from));
      if (mine && mine.left === null) return existing.id;
      if (!this.#allow(from, to)) throw new AccessError("forbidden", "not allowed to message this user");
      transaction(() => this.#join(existing.id, from, this.#now()));
      return existing.id;
    }
    if (!this.#allow(from, to)) throw new AccessError("forbidden", "not allowed to message this user");
    const id = newId("c");
    const now = this.#now();
    transaction(() => {
      this.#in(id).conv.create({ id, kind: "direct", key, title: "", owner: from, created: now, updated: now, seq: 0 });
      this.#join(id, from, now);
      this.#join(id, to, now);
    });
    return id;
  }

  createGroup(owner: string, o: { title: string; members: readonly string[] }): string {
    checkUser(owner);
    const title = this.#title(o.title);
    const others = [...new Set((o.members ?? []).map(checkUser))].filter((u) => u !== owner);
    if (others.length + 1 > this.#maxMembers) throw new AccessError("limit", `at most ${this.#maxMembers} members`);
    for (const u of others) if (!this.#allow(owner, u)) throw new AccessError("forbidden", "not allowed to add one of these users");
    const id = newId("c");
    const now = this.#now();
    transaction(() => {
      this.#in(id).conv.create({ id, kind: "group", key: id, title, owner, created: now, updated: now, seq: 0 });
      for (const u of [owner, ...others]) this.#join(id, u, now);
    });
    return id;
  }

  addMembers(user: string, conversation: string, users: readonly string[]): void {
    this.#member(user, conversation);
    const { conv } = this.#in(conversation);
    const c = conv.get(conversation)!;
    if (c.kind !== "group" || c.owner !== user) throw new AccessError("forbidden", "only the group's owner adds members");
    const current = new Set(this.#current(conversation).map((m) => m.user));
    const add = [...new Set(users.map(checkUser))].filter((u) => !current.has(u));
    if (current.size + add.length > this.#maxMembers) throw new AccessError("limit", `at most ${this.#maxMembers} members`);
    for (const u of add) if (!this.#allow(user, u)) throw new AccessError("forbidden", "not allowed to add one of these users");
    const now = this.#now();
    transaction(() => add.forEach((u) => this.#join(conversation, u, now)));
  }

  leave(user: string, conversation: string): void {
    const me = this.#member(user, conversation);
    const { conv, members } = this.#in(conversation);
    transaction(() => {
      members.update((m) => m.id === me.id, { left: this.#now(), typingUntil: 0 });
      const c = conv.get(conversation)!;
      if (c.kind === "group" && c.owner === user) {
        const next = this.#current(conversation).sort((a, b) => a.joined - b.joined)[0];
        if (next) conv.update((x) => x.id === conversation, { owner: next.user });
      }
    });
  }

  rename(user: string, conversation: string, title: string): void {
    this.#member(user, conversation);
    const { conv } = this.#in(conversation);
    if (conv.get(conversation)!.kind !== "group") throw invalid("only a group has a title");
    conv.update((c) => c.id === conversation, { title: this.#title(title) });
  }

  #view(m: MessageRow, user: string): MessageView {
    return { id: m.id, seq: m.seq, author: m.author, body: m.deleted ? "" : m.body, created: m.created, edited: m.edited, deleted: m.deleted, mine: m.author === user };
  }

  send(user: string, conversation: string, body: string): MessageView {
    const me = this.#member(user, conversation);
    const text = this.#body(body);
    const { conv, members, messages } = this.#in(conversation);
    const now = this.#now();
    let row!: MessageRow;
    transaction(() => {
      const c = conv.get(conversation)!;
      const seq = c.seq + 1;
      row = { id: newId("m"), conversation, seq, author: user, body: text, created: now, edited: null, deleted: false };
      messages.create(row);
      conv.update((x) => x.id === conversation, { seq, updated: now });
      members.update((m) => m.id === me.id, { lastRead: seq, typingUntil: 0 });
    });
    return this.#view(row, user);
  }

  messages(user: string, conversation: string, o: { before?: number; limit?: number } = {}): MessageView[] {
    const me = this.#member(user, conversation);
    const limit = Math.max(1, Math.min(500, Math.floor(o.limit ?? 50)));
    let q = this.#in(conversation).messages.query().where({ seq: { gt: me.since } });
    if (o.before !== undefined) q = q.where({ seq: { lt: Math.floor(o.before) } });
    return q
      .orderBy("seq", "desc")
      .limit(limit)
      .all()
      .reverse()
      .map((m) => this.#view(m as MessageRow, user));
  }

  #own(user: string, message: unknown): { row: MessageRow; conversation: string } {
    checkUser(user);
    if (typeof message !== "string" || !ID_RE.test(message) || !message.startsWith("m_")) throw notFound();
    const row = this.models.Message.as(SYSTEM).get(message);
    if (!row) throw notFound();
    const me = this.#member(user, row.conversation);
    if (row.seq <= me.since) throw notFound();
    return { row, conversation: row.conversation };
  }

  edit(user: string, message: string, body: string): MessageView {
    const { row, conversation } = this.#own(user, message);
    if (row.author !== user || row.deleted) throw new AccessError("forbidden", "only the author edits a message");
    if (this.#now() - row.created > this.#editMs) throw new AccessError("forbidden", "too late to edit this message");
    const text = this.#body(body);
    const edited = this.#now();
    this.#in(conversation).messages.update((m) => m.id === row.id, { body: text, edited });
    return this.#view({ ...row, body: text, edited }, user);
  }

  delete(user: string, message: string): void {
    const { row, conversation } = this.#own(user, message);
    if (row.author !== user) throw new AccessError("forbidden", "only the author deletes a message");
    this.#in(conversation).messages.update((m) => m.id === row.id, { body: "", deleted: true });
  }

  inbox(user: string, o: { limit?: number } = {}): ConversationView[] {
    checkUser(user);
    const limit = Math.max(1, Math.min(500, Math.floor(o.limit ?? 50)));
    const mine = this.models.ConversationMember.as(new Reader({ user })).where((m) => m.user === user && m.left === null);
    const views = mine.map((me) => this.#conversation(user, me));
    return views.sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : 1)).slice(0, limit);
  }

  conversation(user: string, conversation: string): ConversationView {
    return this.#conversation(user, this.#member(user, conversation));
  }

  #conversation(user: string, me: MemberRow): ConversationView {
    const { conv, messages } = this.#in(me.conversation);
    const c = conv.get(me.conversation)!;
    const floor = me.since;
    const last = c.seq > floor ? messages.query().where({ seq: c.seq }).first() : undefined;
    const unread = c.seq > me.lastRead ? messages.query().where({ seq: { gt: Math.max(me.lastRead, floor) } }).filter((m) => m.author !== user && !m.deleted).count() : 0;
    return {
      id: c.id,
      kind: c.kind === "group" ? "group" : "direct",
      title: c.title,
      members: this.#current(c.id).map((m) => m.user).sort(),
      owner: c.owner,
      updated: c.updated,
      unread,
      last: last ? this.#view(last as MessageRow, user) : null,
    };
  }

  unreadTotal(user: string): number {
    return this.inbox(user, { limit: 500 }).reduce((n, c) => n + c.unread, 0);
  }

  markRead(user: string, conversation: string, seq?: number): void {
    const me = this.#member(user, conversation);
    const { conv, members } = this.#in(conversation);
    const newest = conv.get(conversation)!.seq;
    const to = Math.min(newest, seq === undefined ? newest : Math.floor(seq));
    if (to > me.lastRead) members.update((m) => m.id === me.id, { lastRead: to });
  }

  readBy(user: string, conversation: string): { user: string; lastRead: number }[] {
    this.#member(user, conversation);
    return this.#current(conversation)
      .filter((m) => m.user !== user)
      .map((m) => ({ user: m.user, lastRead: m.lastRead }))
      .sort((a, b) => (a.user < b.user ? -1 : 1));
  }

  typing(user: string, conversation: string): void {
    const me = this.#member(user, conversation);
    const now = this.#now();
    if (me.typingUntil - now > this.#typingMs / 2) return;
    const until = now + this.#typingMs;
    this.#in(conversation).members.update((m) => m.id === me.id, { typingUntil: until });
    const key = me.id;
    clearTimeout(this.#typingTimers.get(key));
    const t = setTimeout(() => {
      this.#typingTimers.delete(key);
      const m = this.#in(conversation).members.get(key);
      if (m && m.typingUntil !== 0 && m.typingUntil <= this.#now()) this.#in(conversation).members.update((x) => x.id === key, { typingUntil: 0 });
    }, this.#typingMs + 50);
    (t as { unref?: () => void }).unref?.();
    this.#typingTimers.set(key, t);
  }

  typingIn(user: string, conversation: string): string[] {
    this.#member(user, conversation);
    const now = this.#now();
    return this.#current(conversation)
      .filter((m) => m.user !== user && m.typingUntil > now)
      .map((m) => m.user)
      .sort();
  }

  forget(user: string): number {
    checkUser(user);
    let n = 0;
    transaction(() => {
      n = this.models.Message.as(SYSTEM).update((m) => m.author === user && !m.deleted, { body: "", deleted: true });
      this.models.ConversationMember.as(SYSTEM).delete((m) => m.user === user);
    });
    return n;
  }

  close(): void {
    for (const t of this.#typingTimers.values()) clearTimeout(t);
    this.#typingTimers.clear();
  }
}

export function defineChat(cfg: ChatConfig): Chat {
  return new Chat(cfg);
}
