// `@ts-expect-error` must be an error, or tsc fails.

import { defineI18n, messages, translation, type MessageParams } from "../src/index.ts";

const en = messages({
  nav: { home: "Home" },
  cart: { items: "{count, plural, =0 {Empty} one {# item} other {# items for {who}}}" },
  greet: "Hello {name}, you have {n, number} points since {d, date, short}",
  role: "{r, select, admin {Admin} other {Member}}",
  quiet: "{g, select, male {he} female {she} other {they}}",
});

const i18n = defineI18n({ locales: ["en", "cs"], defaultLocale: "en", messages: en });
const t = await i18n.translator("cs");

t("nav.home");
t("cart.items", { count: 2, who: "Ada" });
t("greet", { name: "Ada", n: 3, d: new Date() });
t("greet", { name: 7, n: 3, d: 0 });
t("role", { r: "admin" });
t("quiet", { g: "x" });

// @ts-expect-error unknown key
t("nav.missing");
// @ts-expect-error a group is not a message
t("nav");
// @ts-expect-error parameters required
t("cart.items");
// @ts-expect-error count must be a number
t("cart.items", { count: "2", who: "Ada" });
// @ts-expect-error who is missing (an argument inside an option body)
t("cart.items", { count: 2 });
// @ts-expect-error a message without arguments takes none
t("nav.home", { x: 1 });
// @ts-expect-error a date, not a string
t("greet", { name: "Ada", n: 3, d: "today" });

translation<typeof en>()({ nav: { home: "Domů" } });
// @ts-expect-error unknown key in a translation
translation<typeof en>()({ nav: { hom: "Domů" } });

// @ts-expect-error a defaultLocale outside locales
defineI18n({ locales: ["en"], defaultLocale: "de", messages: en });

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const ok: Same<MessageParams<"{a} and {b, plural, other {#}}">, { a: string | number; b: number }> = true;
const none: Same<MessageParams<"plain">, {}> = true;
void ok;
void none;
