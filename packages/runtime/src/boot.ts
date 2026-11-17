import { browserClient, type IslandState, type WeftClient } from "./client.ts";
import { endpointsFor, LiveConnection, type ConnectionOptions, type Status } from "./connection.ts";
import { SHARED_ATTR, SharedField, type SharedElement } from "./shared.ts";
import { POINT_ATTR, PointerArea, type PointElement } from "./pointers.ts";
import { isElement, type MElement, type MEventTarget, type MParent } from "./dom.ts";
import type { ClientMessage } from "./protocol.ts";
import { browserFocus, captureFocus, restoreFocus } from "./focus.ts";
import { configureActions, enhanceForms, type ActionTransport } from "./forms.ts";
import type { IslandRegistry } from "./island.ts";
import { morphChildren } from "./morph.ts";
import { installNavigation, parseLikely, sanitizeTree, type HistoryApi, type NavClick, type Navigation } from "./nav.ts";

const RESUME_FIRST_MS = 1_000;
const RESUME_MAX_MS = 30_000;
const RESUME_LOOP_MS = 10_000;
const HIDDEN_SUSPEND_MS = 10_000;

export interface BootOptions {
  path?: string;
  onStatus?(status: Status): void;
  onError?(message: string): void;
  islands?: IslandRegistry;
}

interface BootDocument {
  body: unknown;
  querySelector(sel: string): { getAttribute(name: string): string | null } | null;
  visibilityState?: string;
  addEventListener?(type: string, fn: () => void): void;
}

function meta(doc: BootDocument, name: string): string | null {
  return doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null;
}

export function boot(
  opts: BootOptions = {},
): { client: WeftClient; connection: LiveConnection | null; navigation: Navigation | null } | null {
  const g = globalThis as {
    document?: BootDocument;
    location?: {
      protocol: string;
      host: string;
      pathname: string;
      search?: string;
      hash?: string;
      href?: string;
      assign(to: string): void;
    };
    setTimeout?(fn: () => void, ms: number): unknown;
    clearTimeout?(handle: unknown): void;
    WebSocket?: ConnectionOptions["WebSocket"];
    EventSource?: ConnectionOptions["EventSource"];
    fetch?: unknown;
    FormData?: new (form: unknown, submitter: unknown) => unknown;
    navigator?: { sendBeacon?(url: string): boolean; onLine?: boolean };
    addEventListener?(type: string, fn: () => void): void;
    CustomEvent?: new (type: string, init: { detail: unknown }) => unknown;
  };
  const doc = g.document;
  const loc = g.location;
  if (!doc || !loc) {
    return null;
  }
  const lid = meta(doc, "weft-live") || null;
  if (!lid && meta(doc, "weft-csrf") === null) {
    return null;
  }
  let csrf = meta(doc, "weft-csrf") ?? "";
  const body = doc.body as MElement & MEventTarget;
  let client: WeftClient | null = null;
  let connection: LiveConnection | null = null;
  let stopForms: (() => void) | null = null;
  let navigation: Navigation | null = null;
  let resume: { at: string; states: IslandState[]; handoff?: string } | null = null;
  let recovering = false;
  let connects = 0;
  let resumedAt = -Infinity;
  let liveId: string | null = null;
  const leave = (id: string | null) => {
    if (!id || !g.navigator?.sendBeacon) {
      return;
    }
    try {
      g.navigator.sendBeacon(`${opts.path ?? "/_weft/live"}/leave?lid=${encodeURIComponent(id)}`);
    } catch {
    }
  };

  const here = () => loc.pathname + (loc.search ?? "");

  const recover = (handoff?: string) => {
    if (recovering) {
      return;
    }
    if (Date.now() - resumedAt < RESUME_LOOP_MS) {
      opts.onStatus?.("closed");
      opts.onError?.("the live page expired again right after resuming; reload the page");
      return;
    }
    const nav = navigation;
    if (!nav) {
      loc.assign(loc.href ?? here());
      return;
    }
    recovering = true;
    opts.onStatus?.("reconnecting");
    const states = client?.islandStates() ?? [];
    const started = connects;
    let delay = RESUME_FIRST_MS;
    const attempt = async () => {
      if (connects !== started) {
        recovering = false;
        return;
      }
      resume = { at: here(), states, ...(handoff ? { handoff } : {}) };
      const ok = await nav.go(here() + (loc.hash ?? ""), "refresh");
      if (ok) {
        recovering = false;
        resumedAt = Date.now();
        return;
      }
      resume = null;
      if (connects !== started) {
        recovering = false;
        return;
      }
      const wait = delay;
      delay = Math.min(delay * 2, RESUME_MAX_MS);
      (g.setTimeout ?? setTimeout)(() => void attempt(), wait);
    };
    void attempt();
  };

  const actions: ActionTransport = {
    csrf,
    path: () => loc.pathname,
    fetch: (url, init) => (g.fetch as ActionTransport["fetch"])(url, init),
    navigate: (to) => {
      if (navigation) {
        void navigation.go(to);
      } else {
        loc.assign(to);
      }
    },
  };

  let fields = new Map<string, SharedField>();
  let areas = new Map<string, PointerArea>();
  const attachFields = (root: MElement, send: (m: ClientMessage) => void, live: boolean) => {
    const seen = new Set<SharedField | PointerArea>();
    const visit = (el: MElement) => {
      const area = el.getAttribute(POINT_ATTR);
      if (area) {
        let p = areas.get(area);
        if (p && p.el !== (el as unknown as PointElement)) {
          p.stop();
          p = undefined;
        }
        if (!p) {
          p = new PointerArea(el as unknown as PointElement, {
            send,
            document: g.document as never,
            window: typeof (g as { scrollTo?: unknown }).scrollTo === "function" ? (g as never) : undefined,
            navigate: (to) => actions.navigate(to),
            storage: {
              getItem: (k) => (g as { sessionStorage?: Storage }).sessionStorage?.getItem(k) ?? null,
              setItem: (k, v) => (g as { sessionStorage?: Storage }).sessionStorage?.setItem(k, v),
            },
            event: (type, detail) => (g.CustomEvent ? new g.CustomEvent(type, { detail }) : undefined),
          });
          areas.set(area, p);
          if (live) p.join();
        }
        seen.add(p);
      }
      const doc = el.getAttribute(SHARED_ATTR);
      if (doc) {
        let f = fields.get(doc);
        if (f && f.el !== (el as unknown as SharedElement)) {
          f.stop();
          f = undefined;
        }
        if (!f) {
          f = new SharedField(el as unknown as SharedElement, {
            send,
            event: (type, detail) => (g.CustomEvent ? new g.CustomEvent(type, { detail }) : undefined),
          });
          fields.set(doc, f);
          if (live) f.join();
        }
        seen.add(f);
      }
      for (const c of Array.from(el.childNodes)) if (isElement(c)) visit(c);
    };
    visit(root);
    return seen;
  };

  const connect = (nextLid: string | null, token: string, transport: string | null) => {
    client?.stop();
    for (const f of fields.values()) f.stop();
    fields = new Map();
    for (const p of areas.values()) p.stop();
    areas = new Map();
    connection?.close();
    stopForms?.();
    connects += 1;
    if (liveId !== nextLid) {
      leave(liveId);
    }
    liveId = nextLid;
    const carried = resume && resume.at === here() ? resume.states : undefined;
    resume = null;
    csrf = token;
    actions.csrf = token;
    writeMeta(doc, "weft-live", nextLid);
    writeMeta(doc, "weft-csrf", token);
    writeMeta(doc, "weft-transport", transport);
    connection = nextLid
      ? new LiveConnection({
          ...endpointsFor(loc, { lid: nextLid, path: opts.path }),
          headers: () => ({ "x-weft-csrf": token }),
          WebSocket: transport === "sse" ? undefined : g.WebSocket,
          EventSource: g.EventSource,
          onMessage: (msg) => client?.apply(msg),
          onStatus: opts.onStatus,
        })
      : null;
    const current = connection;
    const send = current
      ? (m: ClientMessage) => current.send(m)
      : () => opts.onError?.("this page is not live: its host runs no server event handlers");
    client = browserClient(body, send, {
      onError: opts.onError,
      islands: opts.islands,
      navigate: (to) => actions.navigate(to),
      setHead: (metaHtml, title, lang) => void (doc && setMeta(doc as NavDocument, metaHtml, lang, title)),
      onExpired: recover,
      resume: carried,
      onNotice: (notice) => {
        const target = doc as { dispatchEvent?(e: unknown): boolean };
        if (g.CustomEvent && target.dispatchEvent) target.dispatchEvent(new g.CustomEvent("weft:notice", { detail: notice }));
      },
      onText: (msg) => fields.get(msg.doc)?.receive(msg),
      onConflict: (conflict) => {
        const target = doc as { dispatchEvent?(e: unknown): boolean };
        if (g.CustomEvent && target.dispatchEvent) target.dispatchEvent(new g.CustomEvent("weft:conflict", { detail: conflict }));
      },
      onPoint: (msg) => areas.get(msg.area)?.receive(msg.list),
      onIncompatible: () => loc.assign(loc.href ?? here()),
      onHello: () => {
        for (const f of fields.values()) f.join();
        for (const p of areas.values()) p.join();
      },
      onPatched: () => {
        const kept = attachFields(body, send, current !== null);
        for (const [doc, f] of fields) {
          if (!kept.has(f)) {
            f.stop();
            fields.delete(doc);
          }
        }
        for (const [name, p] of areas) {
          if (!kept.has(p)) {
            p.stop();
            areas.delete(name);
          }
        }
      },
    });
    attachFields(body, send, false);
    configureActions(actions);
    if (g.fetch && g.FormData) {
      const FormDataCtor = g.FormData;
      stopForms = enhanceForms(body, actions, {
        formData: (form, submitter) => new FormDataCtor(form, submitter),
        onError: opts.onError,
      });
    }
    client.start();
    current?.start();
    if (g.navigator?.onLine === false) current?.offline();
  };

  const navDoc = doc as NavDocument;
  const history = (g as { history?: HistoryApi }).history;
  const Parser = (g as { DOMParser?: new () => { parseFromString(html: string, type: string): unknown } }).DOMParser;
  if (history && Parser && g.fetch && navDoc.head && navDoc.createElement) {
    const scroll = () => {
      const w = g as { scrollX?: number; scrollY?: number };
      return { x: w.scrollX ?? 0, y: w.scrollY ?? 0 };
    };
    navigation = installNavigation({
      current: () => new URL(loc.pathname + (loc.search ?? "") + (loc.hash ?? ""), `${loc.protocol}//${loc.host}`),
      fetch: (url, init) =>
        (g.fetch as (input: string, init: RequestInit) => Promise<Response>)(url, {
          method: "GET",
          headers: init.headers,
          credentials: "same-origin",
          redirect: "follow",
          cache: "no-store",
          signal: init.signal,
        }),
      parse: (html) => {
        const template = navDoc.createElement!("template") as { innerHTML: string; content: MParent };
        template.innerHTML = html;
        return template.content;
      },
      morph: (fragment) => {
        const focus = browserFocus();
        const mark = focus ? captureFocus(focus, body) : null;
        morphChildren(body, fragment);
        if (focus && mark) {
          restoreFocus(focus, body, mark);
        }
      },
      setMeta: (metaHtml, lang, title) => setMeta(navDoc, metaHtml, lang, title),
      refreshHeaders: (): Record<string, string> =>
        resume?.handoff && resume.at === here() ? { "x-weft-handoff": resume.handoff } : {},
      onPage: (page) => connect(page.live, page.csrf, page.transport),
      reload: (url) => loc.assign(url),
      scroll,
      scrollTo: (pos) => (g as { scrollTo?(x: number, y: number): void }).scrollTo?.(pos.x, pos.y),
      scrollToHash: (hash) => scrollToHash(navDoc, hash),
      history,
      listen: (type, fn) => listen(type, fn),
      saveData: () =>
        Boolean((g as { navigator?: { connection?: { saveData?: boolean } } }).navigator?.connection?.saveData),
    });
  }

  connect(lid, csrf, meta(doc, "weft-transport"));
  navigation?.likely(parseLikely(meta(doc, "weft-likely")));

  let hiddenTimer: unknown = null;
  const onVisibility = () => {
    if (hiddenTimer !== null) {
      (g.clearTimeout ?? clearTimeout)(hiddenTimer as never);
      hiddenTimer = null;
    }
    if (doc.visibilityState === "hidden") {
      hiddenTimer = (g.setTimeout ?? setTimeout)(() => {
        hiddenTimer = null;
        connection?.suspend();
      }, HIDDEN_SUSPEND_MS);
    } else {
      connection?.resume();
    }
  };
  doc.addEventListener?.("visibilitychange", onVisibility);
  g.addEventListener?.("pagehide", () => {
    leave(liveId);
    connection?.suspend();
  });
  g.addEventListener?.("pageshow", () => connection?.resume());
  g.addEventListener?.("offline", () => connection?.offline());
  g.addEventListener?.("online", () => connection?.online());
  if (doc.visibilityState === "hidden") {
    onVisibility();
  }

  return { client: client!, connection, navigation };
}

interface HeadNode {
  nodeType: number;
  nodeValue: string | null;
  nextSibling: HeadNode | null;
  parentNode: { removeChild(node: HeadNode): void; insertBefore(node: unknown, ref: HeadNode | null): unknown } | null;
}

interface NavDocument extends BootDocument {
  head?: { firstChild: HeadNode | null };
  title?: string;
  documentElement?: { setAttribute(name: string, value: string): void };
  createElement?(tag: string): { innerHTML: string; content: MParent };
  getElementById?(id: string): { scrollIntoView?(): void } | null;
}

function writeMeta(doc: BootDocument, name: string, content: string | null): void {
  const existing = doc.querySelector(`meta[name="${name}"]`) as {
    setAttribute?(attr: string, value: string): void;
    remove?(): void;
  } | null;
  if (!content) {
    existing?.remove?.();
    return;
  }
  existing?.setAttribute?.("content", content);
}

function setMeta(doc: NavDocument, metaHtml: string, lang: string | null, title: string): boolean {
  const head = doc.head;
  if (!head || !doc.createElement) {
    return false;
  }
  let start: HeadNode | null = null;
  let end: HeadNode | null = null;
  for (let node = head.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 8) {
      continue;
    }
    const value = node.nodeValue?.trim();
    if (value === "weft:meta") {
      start = node;
    } else if (value === "/weft:meta") {
      end = node;
    }
  }
  if (!start?.parentNode || !end) {
    return false;
  }
  while (start.nextSibling && start.nextSibling !== end) {
    start.parentNode.removeChild(start.nextSibling);
  }
  const template = doc.createElement("template");
  template.innerHTML = metaHtml;
  sanitizeTree(template.content);
  end.parentNode?.insertBefore(template.content, end);
  doc.title = title;
  if (lang) {
    doc.documentElement?.setAttribute("lang", lang);
  }
  return true;
}

function scrollToHash(doc: NavDocument, hash: string): void {
  const scroll = (globalThis as { scrollTo?(x: number, y: number): void }).scrollTo;
  if (!hash || hash === "#") {
    scroll?.(0, 0);
    return;
  }
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return;
  }
  doc.getElementById?.(id)?.scrollIntoView?.();
}

function listen(type: string, fn: (ev: NavClick) => void): () => void {
  const target: EventTarget | undefined =
    type === "popstate" ? (globalThis as unknown as EventTarget) : (globalThis as { document?: EventTarget }).document;
  if (!target?.addEventListener) {
    return () => undefined;
  }
  const wrapped = (ev: Event) => {
    if (type === "popstate") {
      fn({ target: null, preventDefault() {} });
      return;
    }
    const mouse = ev as MouseEvent;
    fn({
      target: mouse.target,
      button: mouse.button,
      metaKey: mouse.metaKey,
      ctrlKey: mouse.ctrlKey,
      shiftKey: mouse.shiftKey,
      altKey: mouse.altKey,
      defaultPrevented: mouse.defaultPrevented,
      preventDefault() {
        mouse.preventDefault();
      },
    });
  };
  const capture = type === "click";
  target.addEventListener(type, wrapped, capture);
  return () => target.removeEventListener(type, wrapped, capture);
}
