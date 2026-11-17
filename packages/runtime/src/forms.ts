import type { MElement, MEvent, MEventTarget } from "./dom.ts";
import { HELD_FIELD } from "./escape.ts";
import { isSafePath } from "./protocol.ts";

export interface ActionResult {
  ok: boolean;
  value?: unknown;
  redirect?: string;
  error?: string;
}

interface FetchResponse {
  json(): Promise<unknown>;
}

export interface ActionTransport {
  csrf: string;
  path(): string;
  fetch(
    url: string,
    init: { method: "POST"; headers: Record<string, string>; body: unknown; credentials: "same-origin" },
  ): Promise<FetchResponse>;
  navigate(to: string): void;
}

let transport: ActionTransport | null = null;

export function configureActions(t: ActionTransport | null): void {
  transport = t;
}

export async function postAction(
  t: ActionTransport,
  name: string,
  body: unknown,
  json: boolean,
  held: string | null = null,
): Promise<ActionResult> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-weft-csrf": t.csrf,
    "x-weft-enhanced": "1",
  };
  if (json) {
    headers["content-type"] = "application/json";
  }
  try {
    const query = held ? `&${HELD_FIELD}=${encodeURIComponent(held)}` : "";
    const res = await t.fetch(`${t.path()}?/${encodeURIComponent(name)}${query}`, {
      method: "POST",
      headers,
      body: json ? JSON.stringify(body) : body,
      credentials: "same-origin",
    });
    const data = (await res.json()) as ActionResult;
    if (
      typeof data !== "object" ||
      data === null ||
      typeof data.ok !== "boolean" ||
      (data.redirect !== undefined && (typeof data.redirect !== "string" || !isSafePath(data.redirect)))
    ) {
      return { ok: false, error: "Unexpected response" };
    }
    return data;
  } catch {
    return { ok: false, error: "Network error; try again" };
  }
}

type StandaloneFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; credentials: "same-origin" },
) => Promise<{ status: number; headers?: { get(name: string): string | null }; json(): Promise<unknown> }>;

let standaloneToken: Promise<string | null> | null = null;

export function resetStandaloneActions(): void {
  standaloneToken = null;
}

async function fetchToken(f: StandaloneFetch): Promise<string | null> {
  try {
    const res = await f("/_weft/session", { method: "GET", headers: { accept: "application/json" }, credentials: "same-origin" });
    const data = (await res.json()) as { csrf?: unknown };
    return res.status === 200 && typeof data?.csrf === "string" ? data.csrf : null;
  } catch {
    return null;
  }
}

export async function standaloneAction(name: string, body: unknown, f?: StandaloneFetch): Promise<ActionResult> {
  const fetchFn = f ?? ((globalThis as { fetch?: unknown }).fetch as StandaloneFetch | undefined);
  if (!fetchFn) {
    return { ok: false, error: "Network error; try again" };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    standaloneToken ??= fetchToken(fetchFn);
    const token = await standaloneToken;
    if (token === null) {
      standaloneToken = null;
      return { ok: false, error: "Network error; try again" };
    }
    try {
      const res = await fetchFn(`/_weft/action/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "x-weft-csrf": token },
        body: JSON.stringify(body),
        credentials: "same-origin",
      });
      if (res.status === 403 && attempt === 0) {
        standaloneToken = null;
        continue;
      }
      const rotated = res.headers?.get("x-weft-csrf");
      if (rotated) {
        standaloneToken = Promise.resolve(rotated);
      }
      const data = (await res.json()) as ActionResult;
      if (
        typeof data !== "object" ||
        data === null ||
        typeof data.ok !== "boolean" ||
        (data.redirect !== undefined && (typeof data.redirect !== "string" || !isSafePath(data.redirect)))
      ) {
        return { ok: false, error: "Unexpected response" };
      }
      return data;
    } catch {
      return { ok: false, error: "Network error; try again" };
    }
  }
  return { ok: false, error: "Session expired; reload the page" };
}

export class ActionFailed extends Error {}

export function clientAction(name: string, params: readonly string[]): (...args: unknown[]) => Promise<unknown> {
  return async (...args) => {
    const body: Record<string, unknown> = {};
    params.forEach((p, i) => {
      if (args[i] !== undefined) {
        body[p] = args[i];
      }
    });
    const t = transport;
    const r = t ? await postAction(t, name, body, true) : await standaloneAction(name, body);
    if (!r.ok) {
      throw new ActionFailed(r.error ?? "Action failed");
    }
    if (r.redirect !== undefined) {
      if (t) {
        t.navigate(r.redirect);
      } else {
        const loc = (globalThis as { location?: { assign(url: string): void } }).location;
        loc?.assign(r.redirect);
      }
      return undefined;
    }
    return r.value;
  };
}

interface FormElement extends MElement {
  reset?(): void;
  querySelector?(sel: string): { textContent: string | null } | null;
}

interface SubmitEvent extends MEvent {
  readonly submitter?: MElement | null;
}

export interface EnhanceOptions {
  formData(form: MElement, submitter: MElement | null): unknown;
  onError?(message: string): void;
}

export function enhanceForms(root: MEventTarget, t: ActionTransport, opts: EnhanceOptions): () => void {
  const busy = new Set<MElement>();
  const listener = (ev: MEvent) => {
    const form = ev.target as FormElement | null;
    const submitter = (ev as SubmitEvent).submitter ?? null;
    const by = submitter?.getAttribute("data-weft-action") ? submitter : form;
    const name = by?.getAttribute("data-weft-action");
    const held = by?.getAttribute("data-weft-held") ?? null;
    if (!form || !name) {
      return;
    }
    ev.preventDefault?.();
    if (busy.has(form)) {
      return;
    }
    busy.add(form);
    form.setAttribute("aria-busy", "true");
    const data = opts.formData(form, submitter);
    const disable = submitter !== null && !submitter.hasAttribute("disabled");
    if (disable) {
      submitter.setAttribute("disabled", "");
    }
    const message = form.querySelector?.("[data-weft-message]") ?? null;
    void postAction(t, name, data, false, held).then((r) => {
      busy.delete(form);
      form.removeAttribute("aria-busy");
      if (disable) {
        submitter.removeAttribute("disabled");
      }
      if (r.ok) {
        if (message) {
          message.textContent = "";
        }
        if (r.redirect !== undefined) {
          t.navigate(r.redirect);
        } else {
          form.reset?.();
        }
        return;
      }
      const text = r.error ?? "Action failed";
      if (message) {
        message.textContent = text;
      } else {
        opts.onError?.(text);
      }
    });
  };
  root.addEventListener("submit", listener);
  return () => root.removeEventListener("submit", listener);
}
