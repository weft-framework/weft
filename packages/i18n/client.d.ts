export interface SetLocaleOptions {
  cookie?: string;
  href?: string;
  reload?: boolean;
}

export function setLocale(locale: string, options?: SetLocaleOptions): void;

export function currentLocale(): { lang: string; dir: "ltr" | "rtl" };
