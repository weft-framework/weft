import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessError, defineNotifications, type Delivery, type DigestDelivery } from "../src/index.ts";

function setup(extra: { queue?: boolean } = {}) {
  let clock = Date.UTC(2026, 10, 14, 9);
  const sent: Delivery[] = [];
  const digests: DigestDelivery[] = [];
  const queued: { id: string; channel: string }[] = [];
  const errors: unknown[] = [];
  let failSend = 0;
  let failDigestFor: string | null = null;
  const notify = defineNotifications({
    types: {
      comment: { label: "Comments", channels: { inApp: "instant", email: "daily" } },
      billing: { label: "Billing", channels: { inApp: "instant", email: "instant" }, locked: ["email"] },
      mention: { label: "Mentions", channels: { inApp: "instant", push: "instant" } },
    },
    channels: {
      email: {
        label: "Email",
        send: (d) => {
          if (failSend > 0) {
            failSend--;
            throw new Error("smtp down");
          }
          sent.push(d);
        },
        digest: (d) => {
          if (d.user === failDigestFor) throw new Error(`digest to ${d.user} failed`);
          digests.push(d);
        },
      },
      push: { label: "Push", send: (d) => void sent.push(d) },
    },
    ...(extra.queue ? { queue: (t: { id: string; channel: string }) => void queued.push(t) } : {}),
    maxPerUser: 10,
    onError: (e) => errors.push(e),
    now: () => clock,
  });
  return {
    notify,
    sent,
    digests,
    queued,
    errors,
    tick: (ms: number) => (clock += ms),
    failSends: (n: number) => (failSend = n),
    failDigestFor: (u: string | null) => (failDigestFor = u),
  };
}

test("inbox and unread count per user; another user's ids change nothing", async () => {
  const { notify, tick } = setup();
  const a1 = (await notify.send("ada", "comment", { title: "Bob replied", body: "Nice", url: "/posts/1#c2", data: { post: 1 } }))!;
  tick(1000);
  const a2 = (await notify.send("ada", "mention", { title: "Eve mentioned you" }))!;
  const e1 = (await notify.send("eve", "comment", { title: "For Eve" }))!;
  assert.equal(notify.unread("ada"), 2);
  assert.equal(notify.unread("eve"), 1);
  const inbox = notify.inbox("ada");
  assert.deepEqual(inbox.map((n) => n.id), [a2, a1], "newest first");
  assert.deepEqual(inbox[1], {
    id: a1,
    type: "comment",
    title: "Bob replied",
    body: "Nice",
    url: "/posts/1#c2",
    data: { post: 1 },
    tenant: null,
    created: inbox[1]!.created,
    read: null,
  });
  assert.deepEqual(notify.inbox("ada", { before: a2 }).map((n) => n.id), [a1]);

  assert.equal(notify.markRead("ada", [e1]), 0, "Eve's notification is not Ada's to mark");
  assert.equal(notify.remove("ada", [e1]), 0);
  assert.equal(notify.unread("eve"), 1);
  assert.equal(notify.markRead("ada", [a1]), 1);
  assert.equal(notify.unread("ada"), 1);
  assert.deepEqual(notify.inbox("ada", { unread: true }).map((n) => n.id), [a2]);
  assert.equal(notify.markUnread("ada", [a1]), 1);
  assert.equal(notify.markRead("ada", "all"), 2);
  assert.equal(notify.unread("ada"), 0);
  assert.equal(notify.remove("ada", "all"), 2);
  assert.deepEqual(notify.inbox("ada"), []);
  assert.equal(notify.unread("eve"), 1);
});

test("the models admit only this module: an application actor reads and writes nothing", async () => {
  const { notify } = setup();
  await notify.send("ada", "comment", { title: "Secret" });
  const { Notification, NotificationPreference } = notify.models;
  for (const actor of [{ id: "ada", user: "ada" }, { id: "x", all: true }, { user: "ada", all: true }, null]) {
    assert.deepEqual(Notification.as(actor as never).all(), [], JSON.stringify(actor));
    assert.equal(Notification.as(actor as never).update(() => true, { read: 1 }), 0);
    assert.equal(Notification.as(actor as never).delete(() => true), 0);
    assert.equal(
      NotificationPreference.as(actor as never).create({ id: "p", user: "ada", type: "comment", modes: "{}", updated: 0 }),
      undefined,
    );
  }
  assert.equal(notify.unread("ada"), 1);
});

test("input checks: titles, bodies, links, data, users, types", async () => {
  const { notify } = setup();
  const bad = async (n: Record<string, unknown>, user = "ada", type = "comment") =>
    assert.rejects(notify.send(user, type as never, n as never), (e: unknown) => e instanceof AccessError && e.code === "invalid");
  await bad({ title: "" });
  await bad({ title: "two\nlines" });
  await bad({ title: "x".repeat(201) });
  await bad({ title: "ok", body: "x".repeat(2001) });
  for (const url of ["javascript:alert(1)", "//evil.example/x", "http://acme.example/", "https://u:p@acme.example/", "/a b", "/a\\b", "data:text/html,x"]) {
    await bad({ title: "ok", url });
  }
  await bad({ title: "ok", data: { big: "x".repeat(5000) } });
  await bad({ title: "ok", data: [1] as never });
  await bad({ title: "ok" }, "");
  await bad({ title: "ok" }, "ada", "nope");
  const id = (await notify.send("ada", "comment", { title: "ok", url: "https://acme.example/a?b=1" }))!;
  assert.equal(notify.inbox("ada")[0]!.url, "https://acme.example/a?b=1");
  assert.ok(id);
});

test("preferences: defaults, choices per type and channel, locked channels, digest only where supported", async () => {
  const { notify, sent } = setup();
  const prefs = notify.preferences("ada");
  const billing = prefs.find((p) => p.type === "billing")!;
  assert.deepEqual(
    billing.channels.map((c) => [c.channel, c.mode, c.locked, c.modes.join("|")]),
    [["inApp", "instant", false, "off|instant"], ["email", "instant", true, "instant|daily|weekly"], ["push", "off", false, "off|instant"]],
  );
  assert.throws(() => notify.setPreference("ada", "billing", "email", "off"), /cannot be turned off/);
  assert.throws(() => notify.setPreference("ada", "comment", "push", "daily"), /no digest/);
  assert.throws(() => notify.setPreference("ada", "comment", "inApp", "weekly"), /no digest/);
  assert.throws(() => notify.setPreference("ada", "comment", "sms" as never, "instant"), /no channel/);
  assert.throws(() => notify.setPreference("ada", "comment", "email", "loud" as never), /mode is/);

  notify.setPreference("ada", "comment", "inApp", "off");
  notify.setPreference("ada", "comment", "email", "off");
  assert.equal(await notify.send("ada", "comment", { title: "nobody wants this" }), null, "every channel off: nothing stored");
  assert.equal(notify.unread("ada"), 0);
  assert.equal(notify.unread("eve") + (await notify.send("eve", "comment", { title: "Eve still gets it" }) ? 1 : 0), 1, "per user");

  notify.setPreference("ada", "mention", "push", "off");
  await notify.send("ada", "mention", { title: "m" });
  assert.equal(sent.length, 0, "push turned off");
  notify.setPreference("ada", "mention", "inApp", "off");
  notify.setPreference("ada", "mention", "push", "instant");
  await notify.send("ada", "mention", { title: "push only" });
  assert.deepEqual(sent.map((d) => [d.channel, d.notification.title]), [["push", "push only"]]);
  assert.equal(notify.inbox("ada").filter((n) => n.title === "push only").length, 0, "not in the inbox");
  assert.deepEqual(notify.models.Notification.publicUnscoped().filter((r) => r.title === "push only"), [], "delivered and not kept");
});

test("instant delivery: failures retried, a delivered channel never again; through a queue", async () => {
  const { notify, sent, errors, failSends } = setup();
  failSends(1);
  const id = (await notify.send("ada", "billing", { title: "Invoice paid" }))!;
  assert.equal(sent.length, 0);
  assert.match(String(errors[0]), /smtp down/, "reported, the inbox copy is kept");
  assert.equal(notify.unread("ada"), 1);
  assert.equal(await notify.deliver(id, "email"), true, "the retry delivers");
  assert.equal(await notify.deliver(id, "email"), false, "and only once");
  assert.equal(await notify.deliver(id, "push"), false, "not due on push");
  assert.equal(await notify.deliver("no-such-id", "email"), false);
  await assert.rejects(notify.deliver(id, "sms"), /no channel/);
  assert.equal(sent.length, 1);

  const q = setup({ queue: true });
  const qid = (await q.notify.send("ada", "billing", { title: "Queued" }))!;
  assert.deepEqual(q.queued, [{ id: qid, channel: "email" }]);
  assert.equal(q.sent.length, 0, "the job delivers, not send");
  assert.equal(await q.notify.deliver(qid, "email"), true);
  assert.equal(q.sent[0]!.user, "ada");
});

test("digests: one per user and channel, oldest first, not resent after another user's failure", async () => {
  const { notify, digests, tick, failDigestFor } = setup();
  await notify.send("ada", "comment", { title: "c1" });
  tick(1);
  await notify.send("ada", "comment", { title: "c2" });
  await notify.send("eve", "comment", { title: "e1" });
  await notify.send("bob", "comment", { title: "b1" });
  notify.setPreference("bob", "comment", "email", "off");
  failDigestFor("eve");
  await assert.rejects(notify.digest("daily"), /digest to eve failed/);
  assert.deepEqual(digests.map((d) => [d.user, d.notifications.map((n) => n.title)]), [["ada", ["c1", "c2"]]], "Bob turned it off meanwhile");
  failDigestFor(null);
  assert.equal(await notify.digest("daily"), 1);
  assert.deepEqual(digests.map((d) => d.user), ["ada", "eve"], "Ada not twice");
  assert.equal(await notify.digest("daily"), 0);
  assert.equal(await notify.digest("weekly"), 0);
  await assert.rejects(notify.digest("hourly" as never), /period/);
  assert.equal(notify.unread("ada"), 2, "the inbox is untouched by digests");
});

test("limits: at most maxPerUser (oldest read first), prune of old read ones, forget", async () => {
  const { notify, tick } = setup();
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    ids.push((await notify.send("ada", "mention", { title: `n${i}` }))!);
    tick(1);
  }
  notify.markRead("ada", [ids[5]!]);
  await notify.send("ada", "mention", { title: "n10" });
  const titles = notify.inbox("ada").map((n) => n.title);
  assert.equal(titles.length, 10);
  assert.ok(!titles.includes("n5"), "the read one went first");
  await notify.send("ada", "mention", { title: "n11" });
  assert.ok(!notify.inbox("ada").some((n) => n.title === "n0"), "then the oldest");

  notify.markRead("ada", "all");
  tick(91 * 86_400_000);
  await notify.send("ada", "mention", { title: "fresh" });
  assert.equal(notify.prune(), 9, "the cap already made room for the new one");
  assert.deepEqual(notify.inbox("ada").map((n) => n.title), ["fresh"]);

  notify.setPreference("ada", "comment", "email", "weekly");
  assert.equal(notify.forget("ada"), 1);
  assert.equal(notify.models.NotificationPreference.publicUnscoped().length, 0);
});

test("configuration mistakes fail at startup", () => {
  const ch = { email: { label: "Email", send: () => {} } };
  assert.throws(() => defineNotifications({ types: {} }), /at least one type/);
  assert.throws(() => defineNotifications({ types: { Bad: { label: "x", channels: {} } } }), /lower-case/);
  assert.throws(() => defineNotifications({ types: { a: { label: "x", channels: { sms: "instant" } as never } } }), /no channel sms/);
  assert.throws(() => defineNotifications({ types: { a: { label: "x", channels: { email: "daily" } } }, channels: ch }), /no digest/);
  assert.throws(() => defineNotifications({ types: { a: { label: "x", channels: {}, locked: ["email"] } }, channels: ch }), /cannot default to off/);
  assert.throws(() => defineNotifications({ types: { a: { label: "x", channels: {} } }, channels: { inApp: ch.email } as never }), /built in/);
  assert.throws(() => defineNotifications({ types: { a: { label: "x", channels: {} } }, maxPerUser: 5 }), /maxPerUser/);
});

test("on SQLite: the same inbox, flags and pending lists survive the round trip", async () => {
  const { useDatabase } = await import("@weft-framework/data");
  const { openSqlite } = await import("@weft-framework/data/sqlite");
  const { notify, sent, tick } = setup();
  useDatabase(openSqlite(":memory:"), Object.values(notify.models) as never);
  const a = (await notify.send("ada", "comment", { title: "c", data: { n: 1 } }))!;
  tick(1);
  await notify.send("ada", "billing", { title: "b" });
  await notify.send("eve", "comment", { title: "e" });
  assert.equal(notify.unread("ada"), 2);
  assert.deepEqual(notify.inbox("ada").map((n) => n.title), ["b", "c"]);
  assert.deepEqual(notify.inbox("ada")[1]!.data, { n: 1 });
  assert.equal(sent.length, 1, "billing email sent at once");
  const row = notify.models.Notification.publicUnscoped().find((r) => r.id === a)!;
  assert.deepEqual([row.inbox, row.pending], [true, ["email:daily"]]);
  notify.setPreference("ada", "comment", "email", "weekly");
  assert.equal(notify.preferences("ada").find((p) => p.type === "comment")!.channels.find((c) => c.channel === "email")!.mode, "weekly");
  assert.equal(await notify.digest("daily"), 2, "a mode change applies to later notifications; only off drops");
  assert.equal(notify.markRead("ada", "all"), 2);
  assert.equal(notify.unread("ada"), 0);
});

test("a channel locked later wins over a stored choice; prune keeps recently read ones", async () => {
  const { useDatabase } = await import("@weft-framework/data");
  const { openSqlite } = await import("@weft-framework/data/sqlite");
  const db = openSqlite(":memory:");
  const sent: string[] = [];
  const email = { label: "Email", send: (d: Delivery) => void sent.push(d.notification.title) };
  const before = defineNotifications({ types: { security: { label: "Security", channels: { email: "instant" } } }, channels: { email } });
  useDatabase(db, Object.values(before.models) as never);
  before.setPreference("ada", "security", "email", "off");
  assert.equal(await before.send("ada", "security", { title: "quiet" }), null);

  const after = defineNotifications({
    types: { security: { label: "Security", channels: { email: "instant" }, locked: ["email"] } },
    channels: { email },
  });
  useDatabase(db, Object.values(after.models) as never);
  assert.equal(after.preferences("ada")[0]!.channels.find((c) => c.channel === "email")!.mode, "instant");
  await after.send("ada", "security", { title: "new sign-in" });
  assert.deepEqual(sent, ["new sign-in"], "the stored off no longer applies");

  let clock = 0;
  const n = defineNotifications({ types: { t: { label: "T", channels: { inApp: "instant" } } }, now: () => clock });
  const old = (await n.send("ada", "t", { title: "old" }))!;
  n.markRead("ada", [old]);
  clock += 89 * 86_400_000;
  const recent = (await n.send("ada", "t", { title: "recent" }))!;
  n.markRead("ada", [recent]);
  clock += 2 * 86_400_000;
  assert.equal(n.prune(), 1);
  assert.deepEqual(n.inbox("ada").map((x) => x.title), ["recent"]);
});
