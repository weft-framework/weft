import { isSecret, type Secret } from "./secret.ts";
import { CAPTCHA_ORIGINS, type CaptchaProvider } from "./security.ts";

export { CAPTCHA_ORIGINS, type CaptchaProvider };

export interface CaptchaResult {
  ok: boolean;
  codes: string[];
}

export interface CaptchaOptions {
  provider: CaptchaProvider;
  secret: Secret | string;
  siteKey: string;
  action?: string;
  hostname?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const PROVIDERS: Record<CaptchaProvider, { verify: string; script: string; field: string; widget: string }> = {
  turnstile: {
    verify: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    script: "https://challenges.cloudflare.com/turnstile/v0/api.js",
    field: "cf-turnstile-response",
    widget: "cf-turnstile",
  },
  hcaptcha: {
    verify: "https://api.hcaptcha.com/siteverify",
    script: "https://js.hcaptcha.com/1/api.js",
    field: "h-captcha-response",
    widget: "h-captcha",
  },
};

export interface Captcha {
  readonly provider: CaptchaProvider;
  readonly siteKey: string;
  readonly script: string;
  readonly field: string;
  readonly widgetClass: string;
  readonly csp: { captcha: CaptchaProvider };
  token(form: FormData | URLSearchParams | Record<string, unknown> | null | undefined): string | null;
  verify(token: string | null | undefined, ip?: string | null): Promise<CaptchaResult>;
}

export function defineCaptcha(o: CaptchaOptions): Captcha {
  if (!o || typeof o !== "object") throw new TypeError("defineCaptcha: options are required");
  const p = Object.hasOwn(PROVIDERS, o.provider) ? PROVIDERS[o.provider] : null;
  if (!p) throw new TypeError(`defineCaptcha: provider is one of ${Object.keys(PROVIDERS).join(", ")}`);
  const secret = isSecret(o.secret) ? o.secret.reveal() : o.secret;
  if (typeof secret !== "string" || secret.trim() === "") throw new TypeError("defineCaptcha: `secret` is the provider's secret key");
  if (typeof o.siteKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(o.siteKey)) throw new TypeError("defineCaptcha: `siteKey` is the provider's site key");
  const timeout = o.timeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 500 || timeout > 30_000) throw new TypeError("defineCaptcha: timeoutMs is 500 to 30000");
  const send = o.fetch ?? fetch;
  const provider = o.provider;
  const captcha: Captcha = {
    provider,
    siteKey: o.siteKey,
    script: p.script,
    field: p.field,
    widgetClass: p.widget,
    csp: Object.freeze({ captcha: provider }),
    token(form) {
      if (!form) return null;
      const v = form instanceof FormData || form instanceof URLSearchParams ? form.get(p.field) : (form as Record<string, unknown>)[p.field];
      return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
    },
    async verify(token, ip) {
      const t = typeof token === "string" ? token.trim() : "";
      if (t === "" || t.length > 4096) return { ok: false, codes: ["missing-input-response"] };
      const body = new URLSearchParams({ secret, response: t });
      if (typeof ip === "string" && ip !== "") body.set("remoteip", ip);
      if (provider === "hcaptcha") body.set("sitekey", o.siteKey);
      try {
        const res = await send(p.verify, { method: "POST", body, signal: AbortSignal.timeout(timeout) });
        if (!res.ok) return { ok: false, codes: [`http-${res.status}`] };
        const data = (await res.json()) as { success?: unknown; "error-codes"?: unknown; action?: unknown; hostname?: unknown };
        const codes = Array.isArray(data["error-codes"]) ? data["error-codes"].filter((c): c is string => typeof c === "string") : [];
        if (data.success !== true) return { ok: false, codes: codes.length ? codes : ["rejected"] };
        if (o.action !== undefined && data.action !== o.action) return { ok: false, codes: ["action-mismatch"] };
        if (o.hostname !== undefined && data.hostname !== o.hostname) return { ok: false, codes: ["hostname-mismatch"] };
        return { ok: true, codes };
      } catch {
        return { ok: false, codes: ["unreachable"] };
      }
    },
  };
  return Object.freeze(captcha);
}
