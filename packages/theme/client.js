const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const COOKIE = /^[A-Za-z0-9_-]{1,64}$/;

export function getTheme() {
  return document.documentElement.getAttribute("data-theme") ?? "system";
}

export function isDark() {
  return getComputedStyle(document.documentElement).colorScheme.includes("dark");
}

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

export function cycleTheme(names, options = {}) {
  const at = names.indexOf(getTheme());
  return setTheme(names[(at + 1) % names.length], options);
}
