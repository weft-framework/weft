// SPDX-License-Identifier: MIT
//
// @weft/i18n in the browser: remember a visitor's language choice.
//
//   client import { setLocale } from "@weft/i18n/client";
//   <button @click={() => setLocale("cs")}>Čeština</button>
//
// With URL prefixes, a plain link to `i18n.href(path, "cs")` (or one of
// `i18n.alternates(path)`) switches language; setLocale also stores the
// choice so the next visit to a bare URL picks it.

/**
 * Store `locale` in the locale cookie (a year, whole site, SameSite=Lax)
 * and, unless `reload` is false, open `href` (default: this page again)
 * so the server renders it in the new language.
 */
export function setLocale(locale, options = {}) {
  if (!/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(locale)) throw new Error(`setLocale: "${locale}" is not a locale tag`);
  const name = options.cookie ?? "weft-locale";
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  if (options.reload !== false) location.assign(options.href ?? location.href);
}

/** The page's language and direction, as the server rendered them. */
export function currentLocale() {
  return { lang: document.documentElement.lang, dir: document.documentElement.dir === "rtl" ? "rtl" : "ltr" };
}
