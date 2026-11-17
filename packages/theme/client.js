// SPDX-License-Identifier: MIT
//
// @weft/theme in the browser: read and swap the theme.
//
//   client import { setTheme, getTheme } from "@weft/theme/client"
//
// `setTheme(name)` sets `<html data-theme>` (the CSS switches at once) and
// the theme cookie, so the next server render (a reload, another tab)
// starts with the same theme. A `weft:theme` event is dispatched on
// `document` with the new name.

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const COOKIE = /^[A-Za-z0-9_-]{1,64}$/;

/** The theme on the page: a configured name or "system". */
export function getTheme() {
  return document.documentElement.getAttribute("data-theme") ?? "system";
}

/** Whether the page currently shows a dark scheme. */
export function isDark() {
  return getComputedStyle(document.documentElement).colorScheme.includes("dark");
}

/** Switch to `name` (a configured theme or "system") and remember it. */
export function setTheme(name, options = {}) {
  const cookie = options.cookie ?? "weft-theme";
  if (!NAME.test(name)) throw new Error(`setTheme: ${JSON.stringify(name)} is not a theme name`);
  if (!COOKIE.test(cookie)) throw new Error("setTheme: invalid cookie name");
  document.documentElement.setAttribute("data-theme", name);
  const maxAge = options.maxAge ?? 60 * 60 * 24 * 365;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${cookie}=${name}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
  document.dispatchEvent(new CustomEvent("weft:theme", { detail: name }));
  return name;
}

/** Step through `names` in order from the current theme. */
export function cycleTheme(names, options = {}) {
  const at = names.indexOf(getTheme());
  return setTheme(names[(at + 1) % names.length], options);
}
