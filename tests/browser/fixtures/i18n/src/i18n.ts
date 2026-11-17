import { defineI18n } from "@weft-framework/i18n";
import en from "./locales/en.ts";

export const i18n = defineI18n({
  locales: ["en", "cs", "ar"],
  defaultLocale: "en",
  messages: en,
  catalogs: { cs: () => import("./locales/cs.ts"), ar: () => import("./locales/ar.ts") },
  routes: { "/intl": { cs: "/mezinarodni" } },
  onMissing: () => {},
});
