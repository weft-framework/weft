import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptLanguage,
  argumentsOf,
  compareCatalogs,
  defineI18n,
  direction,
  format,
  match,
  messages,
  MessageSyntaxError,
  translation,
} from "../src/index.ts";

test("plain arguments, numbers and dates follow the locale", () => {
  assert.equal(format("Hello {name}!", { name: "Ada" }), "Hello Ada!");
  assert.equal(format("{n, number}", { n: 1234.5 }, "en"), "1,234.5");
  assert.equal(format("{n, number}", { n: 1234.5 }, "cs"), "1 234,5");
  assert.equal(format("{n, number, percent}", { n: 0.25 }, "en"), "25%");
  assert.equal(format("{n, number, integer}", { n: 2.7 }, "en"), "3");
  assert.equal(format("{p, number, currency/EUR}", { p: 5 }, "en"), "€5.00");
  const d = new Date(Date.UTC(2026, 10, 14, 12));
  assert.match(format("{d, date, long}", { d }, "en"), /November 1[34], 2026/);
  assert.equal(format("Hi {name}", {}), "Hi {name}", "a missing parameter stays visible");
});

test("plural: exact matches, CLDR categories per locale, # and offset", () => {
  const m = "{count, plural, =0 {No items} one {# item} other {# items}}";
  assert.equal(format(m, { count: 0 }), "No items");
  assert.equal(format(m, { count: 1 }), "1 item");
  assert.equal(format(m, { count: 1200 }), "1,200 items");
  const cs = "{n, plural, one {# soubor} few {# soubory} other {# souborů}}";
  assert.equal(format(cs, { n: 1 }, "cs"), "1 soubor");
  assert.equal(format(cs, { n: 3 }, "cs"), "3 soubory");
  assert.equal(format(cs, { n: 5 }, "cs"), "5 souborů");
  const off = "{n, plural, offset:1 =0 {Nobody} =1 {{who}} one {{who} and # other} other {{who} and # others}}";
  assert.equal(format(off, { n: 1, who: "Ada" }), "Ada");
  assert.equal(format(off, { n: 2, who: "Ada" }), "Ada and 1 other");
  assert.equal(format(off, { n: 4, who: "Ada" }), "Ada and 3 others");
  const ord = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
  assert.deepEqual([1, 2, 3, 4, 11, 22].map((n) => format(ord, { n })), ["1st", "2nd", "3rd", "4th", "11th", "22nd"]);
});

test("select, nesting, and apostrophe quoting", () => {
  const m = "{role, select, admin {Admin {name}} other {Member}}";
  assert.equal(format(m, { role: "admin", name: "Ada" }), "Admin Ada");
  assert.equal(format(m, { role: "guest" }), "Member");
  assert.equal(format("It''s '{name}' and don't", { name: "x" }), "It's {name} and don't");
  assert.equal(format("{n, plural, other {'#' is #}}", { n: 2 }), "# is 2");
});

test("syntax errors carry an offset; parameters and their kinds are known", () => {
  assert.throws(() => format("Hello {name"), MessageSyntaxError);
  assert.throws(() => format("{n, plural, one {x}}"), /"other" option is required/);
  assert.throws(() => format("{n, plural, lots {x} other {y}}"), /bad plural option "lots"/);
  assert.throws(() => format("{n, frob}"), /unknown argument type/);
  assert.throws(() => format("oops }"), (e: unknown) => e instanceof MessageSyntaxError && e.offset === 5);
  assert.deepEqual(
    Object.fromEntries(argumentsOf("{a} {n, plural, other {# {b}}} {d, date} {s, select, x {} other {}} {a, number}")),
    { a: "number", n: "number", b: "any", d: "date", s: "select" },
  );
});

test("Accept-Language and matching: q order, region fallbacks, junk ignored", () => {
  assert.deepEqual(acceptLanguage("cs;q=0.8, en-GB, de;q=0, x y, fr;q=0.9"), ["en-GB", "fr", "cs"]);
  assert.equal(match(["en-GB"], ["en", "cs"]), "en");
  assert.equal(match(["pt"], ["en", "pt-BR"]), "pt-BR");
  assert.equal(match(["de", "cs-CZ"], ["en", "cs"]), "cs");
  assert.equal(match(["de"], ["en", "cs"]), null);
  assert.equal(direction("ar"), "rtl");
  assert.equal(direction("he-IL"), "rtl");
  assert.equal(direction("cs"), "ltr");
  assert.equal(direction("az-Arab"), "rtl");
});

const en = messages({
  nav: { home: "Home", about: "About" },
  cart: { items: "{count, plural, =0 {Your cart is empty} one {# item} other {# items}}" },
  greet: "Hello {name}",
});
const cs = translation<typeof en>()({
  nav: { home: "Domů" },
  cart: { items: "{count, plural, =0 {Košík je prázdný} one {# položka} few {# položky} other {# položek}}" },
});

function app(extra: Record<string, unknown> = {}) {
  const missing: string[] = [];
  const i18n = defineI18n({
    locales: ["en", "cs", "ar"],
    defaultLocale: "en",
    messages: en,
    catalogs: { cs: async () => ({ default: cs }), ar: { nav: { home: "الرئيسية" } } },
    routes: { "/about": { cs: "/o-nas" }, "/blog/[slug]": { cs: "/clanky/[slug]" }, "/help": { cs: "/nápověda" } },
    onMissing: (key, locale) => missing.push(`${locale}:${key}`),
    ...extra,
  });
  return { i18n, missing };
}

const req = (path: string, headers: Record<string, string> = {}) => new Request(`http://app.test${path}`, { headers });

test("translators: own text, fallback to the default locale, Intl helpers", async () => {
  const { i18n, missing } = app();
  const t = await i18n.translator("cs-CZ");
  assert.equal(t.locale, "cs");
  assert.equal(t("nav.home"), "Domů");
  assert.equal(t("cart.items", { count: 3 }), "3 položky");
  assert.equal(t("nav.about"), "About", "untranslated: the default locale's text");
  assert.equal(t.has("nav.about"), false);
  assert.deepEqual(missing, ["cs:nav.about"]);
  t("nav.about");
  assert.equal(missing.length, 1, "reported once");
  assert.deepEqual(i18n.missing(), { cs: ["nav.about"] });
  assert.equal(t.number(1234.5), "1 234,5");
  assert.equal(t.list(["a", "b", "c"]).replace(/ /g, " "), "a, b a c");
  assert.equal(t.relative(-1, "day"), "včera");
  const now = Date.UTC(2026, 0, 10);
  assert.equal(t.relative(now + 3 * 24 * 3600e3, { now }), "za 3 dny");
  const ar = await i18n.translator("ar");
  assert.equal(ar.dir, "rtl");
  assert.equal(ar("nav.home"), "الرئيسية");
  const unknown = await i18n.translator("de");
  assert.equal(unknown.locale, "en", "an unsupported locale gets the default");
  assert.equal(unknown("greet", { name: "<b>" }), "Hello <b>", "plain text: the view escapes it");
});

test("route catalogs load only when asked for, per locale", async () => {
  const { i18n } = app();
  let loads = 0;
  const checkout = i18n.catalog("checkout", {
    en: async () => {
      loads += 1;
      return messages({ pay: "Pay {amount, number, currency/EUR}" });
    },
    cs: { pay: "Zaplatit {amount, number, currency/EUR}" },
  });
  assert.equal(loads, 0);
  const t = await i18n.translator("cs", checkout);
  assert.equal(t("pay", { amount: 5 }), "Zaplatit 5,00 €");
  assert.equal(t("nav.home"), "Domů", "the main catalog is still there");
  await i18n.translator("en", checkout);
  assert.equal(loads, 1, "loaded once");
});

test("negotiation: URL prefix, then (without prefixes) cookie, header, default", () => {
  const { i18n } = app();
  assert.deepEqual(i18n.negotiate(req("/cs/o-nas")), { locale: "cs", from: "url", path: "/o-nas", canonical: "/about" });
  assert.equal(i18n.negotiate(req("/about", { "accept-language": "cs" })).locale, "en", "as-needed: a bare URL is the default's");
  const never = app({ prefix: "never" }).i18n;
  assert.equal(never.negotiate(req("/", { cookie: "a=1; weft-locale=ar" })).from, "cookie");
  assert.equal(never.locale(req("/", { cookie: "weft-locale=xx", "accept-language": "cs-CZ,en;q=0.5" })), "cs");
  assert.deepEqual(never.negotiate(req("/")).from, "default");
  assert.deepEqual(i18n.htmlAttributes(req("/ar/x")), { lang: "ar", dir: "rtl" });
});

test("hrefs and alternates: prefixes and localised segments", () => {
  const { i18n } = app();
  assert.equal(i18n.href("/about", "en"), "/about");
  assert.equal(i18n.href("/about?x=1#top", "cs"), "/cs/o-nas?x=1#top");
  assert.equal(i18n.href("/blog/hello", "cs"), "/cs/clanky/hello");
  assert.equal(i18n.href("/", "cs"), "/cs");
  assert.equal(i18n.href("/help", "cs"), "/cs/n%C3%A1pov%C4%9Bda");
  assert.equal(i18n.href("/other", "ar"), "/ar/other");
  assert.deepEqual(i18n.alternates("/cs/clanky/hello"), [
    { locale: "en", href: "/blog/hello" },
    { locale: "cs", href: "/cs/clanky/hello" },
    { locale: "ar", href: "/ar/blog/hello" },
    { locale: "x-default", href: "/blog/hello" },
  ]);
  const always = app({ prefix: "always" }).i18n;
  assert.equal(always.href("/about", "en"), "/en/about");
});

test("middleware: rewrites to the app's route, one URL per page", () => {
  const { i18n } = app();
  const run = (path: string, headers: Record<string, string> = {}) => {
    const r = req(path, headers);
    return i18n.middleware({ request: r, url: new URL(r.url) });
  };
  assert.deepEqual(run("/cs/o-nas"), { rewrite: "/about" });
  assert.deepEqual(run("/cs/clanky/hi"), { rewrite: "/blog/hi" });
  assert.deepEqual(run("/cs/n%C3%A1pov%C4%9Bda"), { rewrite: "/help" });
  assert.deepEqual(run("/cs"), { rewrite: "/" });
  assert.equal(run("/about"), undefined, "the default locale's own URL");
  const moved = run("/cs/about?x=1");
  assert.ok(moved instanceof Response && moved.status === 307);
  assert.equal(moved.headers.get("location"), "http://app.test/cs/o-nas?x=1");
  const unprefix = run("/en/about");
  assert.ok(unprefix instanceof Response && unprefix.headers.get("location") === "http://app.test/about");
  const always = app({ prefix: "always" }).i18n;
  const bare = new Request("http://app.test/about", { headers: { "accept-language": "cs" } });
  const sent = always.middleware({ request: bare, url: new URL(bare.url) });
  assert.ok(sent instanceof Response && sent.headers.get("location") === "http://app.test/cs/o-nas");
  assert.equal(run("/_weft/live"), undefined);
});

test("compareCatalogs: missing, stale and mismatched keys", () => {
  const report = compareCatalogs(en, { nav: { home: "x", old: "y" }, greet: "Ahoj" });
  assert.deepEqual(report, { missing: ["nav.about", "cart.items"], extra: ["nav.old"], mismatched: ["greet"] });
});

test("config mistakes are reported", () => {
  assert.throws(() => defineI18n({ locales: [], defaultLocale: "en" as never, messages: en }), /locales is empty/);
  assert.throws(() => defineI18n({ locales: ["en"], defaultLocale: "cs" as never, messages: en }), /not in locales/);
  assert.throws(() => defineI18n({ locales: ["en", "not a tag"], defaultLocale: "en", messages: en }), /not a locale tag/);
});
