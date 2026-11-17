import { isElement, type MElement, type MNode, type MParent } from "./dom.ts";

export interface FocusHost {
  active(): MElement | null;
  focus(el: MElement): void;
}

export function browserFocus(): FocusHost | undefined {
  const doc = (globalThis as { document?: { activeElement: unknown } }).document;
  if (!doc) {
    return undefined;
  }
  return {
    active: () => (isElement(doc.activeElement) ? doc.activeElement : null),
    focus: (el) => (el as unknown as { focus?(o: object): void }).focus?.({ preventScroll: true }),
  };
}

interface Selection {
  start: number;
  end: number;
  direction: string;
}

export interface FocusMark {
  el: MElement;
  tag: string;
  id: string | null;
  key: string | null;
  name: string | null;
  path: number[];
  selection: Selection | null;
  scrollTop: number | null;
  scrollLeft: number | null;
}

interface Editable {
  value?: unknown;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  selectionDirection?: string | null;
  setSelectionRange?(start: number, end: number, direction?: string): void;
  scrollTop?: number;
  scrollLeft?: number;
}

function within(node: MNode | null, root: MNode): boolean {
  for (let n = node; n; n = n.parentNode) {
    if (n === root) {
      return true;
    }
  }
  return false;
}

function pathOf(el: MNode, root: MNode): number[] {
  const path: number[] = [];
  for (let n: MNode = el; n !== root && n.parentNode; n = n.parentNode) {
    path.unshift(Array.prototype.indexOf.call((n.parentNode as MParent).childNodes, n));
  }
  return path;
}

function readSelection(el: MElement): Selection | null {
  try {
    const e = el as unknown as Editable;
    if (typeof e.selectionStart !== "number" || typeof e.selectionEnd !== "number") {
      return null;
    }
    return { start: e.selectionStart, end: e.selectionEnd, direction: e.selectionDirection ?? "none" };
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

export function captureFocus(host: FocusHost, root: MParent): FocusMark | null {
  const el = host.active();
  if (!el || el === (root as unknown) || !within(el, root)) {
    return null;
  }
  const e = el as unknown as Editable;
  return {
    el,
    tag: el.nodeName.toUpperCase(),
    id: el.getAttribute("id"),
    key: el.getAttribute("data-weft-key"),
    name: el.getAttribute("name"),
    path: pathOf(el, root),
    selection: readSelection(el),
    scrollTop: num(e.scrollTop),
    scrollLeft: num(e.scrollLeft),
  };
}

function find(root: MParent, pred: (el: MElement) => boolean): MElement | null {
  for (const child of Array.from(root.childNodes)) {
    if (isElement(child)) {
      if (pred(child)) {
        return child;
      }
      const hit = find(child, pred);
      if (hit) {
        return hit;
      }
    }
  }
  return null;
}

function atPath(root: MParent, path: number[]): MElement | null {
  let n: MNode | undefined = root;
  for (const i of path) {
    n = (n as MParent).childNodes?.[i];
    if (!n) {
      return null;
    }
  }
  return isElement(n) ? n : null;
}

function successor(root: MParent, mark: FocusMark): MElement | null {
  if (within(mark.el, root)) {
    return mark.el;
  }
  const same = (el: MElement) => el.nodeName.toUpperCase() === mark.tag;
  const by = (attr: string, value: string | null) =>
    value === null ? null : find(root, (el) => same(el) && el.getAttribute(attr) === value);
  const byPath = atPath(root, mark.path);
  return (
    by("id", mark.id) ??
    by("data-weft-key", mark.key) ??
    by("name", mark.name) ??
    (byPath && same(byPath) ? byPath : null)
  );
}

export function restoreFocus(host: FocusHost, root: MParent, mark: FocusMark): void {
  const now = host.active();
  if (now === mark.el && within(mark.el, root)) {
    return;
  }
  if (now && now !== mark.el && !["BODY", "HTML"].includes(now.nodeName.toUpperCase())) {
    return;
  }
  const el = successor(root, mark);
  if (!el) {
    return;
  }
  host.focus(el);
  const e = el as unknown as Editable;
  if (mark.selection && typeof e.setSelectionRange === "function") {
    const len = typeof e.value === "string" ? e.value.length : Infinity;
    const s = mark.selection;
    try {
      e.setSelectionRange(Math.min(s.start, len), Math.min(s.end, len), s.direction);
    } catch {
    }
  }
  if (mark.scrollTop !== null) {
    e.scrollTop = mark.scrollTop;
  }
  if (mark.scrollLeft !== null) {
    e.scrollLeft = mark.scrollLeft;
  }
}
