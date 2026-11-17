export function setLocale(locale, options = {}) {
  if (!/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(locale)) throw new Error(`setLocale: "${locale}" is not a locale tag`);
  const name = options.cookie ?? "weft-locale";
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  if (options.reload !== false) location.assign(options.href ?? location.href);
}

export function currentLocale() {
  return { lang: document.documentElement.lang, dir: document.documentElement.dir === "rtl" ? "rtl" : "ltr" };
}
