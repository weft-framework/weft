import {
  ELEMENT_NODE,
  isElement,
  type MElement,
  type MNode,
  type MParent,
} from "./dom.ts";

const KEY_ATTR = "data-weft-key";
const OWN_ATTR = "data-weft-own";
const IGNORE_ATTR = "data-weft-ignore";
const LOOKAHEAD = 8;

const served = new WeakMap<MElement, Set<string>>();

export function noteServed(el: MElement): void {
  if (!served.has(el)) served.set(el, new Set(Array.from(el.attributes, (a) => a.name)));
}

function keyOf(n: MNode): string | null {
  if (!isElement(n)) {
    return null;
  }
  const inst = n.nodeName.toUpperCase() === "WEFT-C" ? n.getAttribute("data-weft-c") : null;
  return n.getAttribute(KEY_ATTR) ?? n.getAttribute("id") ?? (inst === null ? null : `weft-c ${inst}`);
}

function sameKind(a: MNode, b: MNode): boolean {
  if (a.nodeType !== b.nodeType) {
    return false;
  }
  return (
    a.nodeType !== ELEMENT_NODE ||
    a.nodeName.toUpperCase() === b.nodeName.toUpperCase()
  );
}

function reusable(a: MNode, b: MNode): boolean {
  if (keyOf(a) !== null || !sameKind(a, b)) {
    return false;
  }
  if (isElement(a) && isElement(b)) {
    const x = a.getAttribute("name");
    const y = b.getAttribute("name");
    return x === null || y === null || x === y;
  }
  return true;
}

function ownedAttributes(el: MElement): Set<string> {
  const owned = new Set((el.getAttribute(OWN_ATTR) ?? "").toLowerCase().split(/\s+/).filter(Boolean));
  const tag = el.nodeName.toUpperCase();
  if (tag === "DIALOG" || tag === "DETAILS") owned.add("open");
  return owned;
}

function syncAttributes(from: MElement, to: MElement): void {
  const owned = ownedAttributes(from);
  for (const { name, value } of Array.from(to.attributes)) {
    if (!owned.has(name) && from.getAttribute(name) !== value) {
      from.setAttribute(name, value);
    }
  }
  const prior = served.get(from);
  for (const { name } of Array.from(from.attributes)) {
    if (!owned.has(name) && !to.hasAttribute(name) && (prior === undefined || prior.has(name))) {
      from.removeAttribute(name);
    }
  }
  if (prior !== undefined) served.set(from, new Set(Array.from(to.attributes, (a) => a.name)));
}

export function morphNode(from: MNode, to: MNode): void {
  if (isElement(from) && isElement(to)) {
    if (from.hasAttribute(IGNORE_ATTR)) {
      return;
    }
    syncAttributes(from, to);
    morphChildren(from, to);
  } else if (from.nodeValue !== to.nodeValue) {
    from.nodeValue = to.nodeValue;
  }
}

export function morphChildren(target: MParent, next: MParent): void {
  const keyed = new Map<string, MNode>();
  for (const child of Array.from(target.childNodes)) {
    const key = keyOf(child);
    if (key !== null) {
      keyed.set(key, child);
    }
  }

  const wanted = Array.from(next.childNodes);
  let i = 0;
  for (const want of wanted) {
    const current = target.childNodes[i] ?? null;
    const key = keyOf(want);
    let match: MNode | null = null;
    if (key !== null) {
      const candidate = keyed.get(key);
      if (candidate && sameKind(candidate, want)) {
        match = candidate;
        keyed.delete(key);
      }
    } else if (current && reusable(current, want)) {
      match = current;
    } else if (isElement(want)) {
      const end = Math.min(target.childNodes.length, i + 1 + LOOKAHEAD);
      for (let j = i + 1; j < end; j++) {
        const later = target.childNodes[j];
        if (reusable(later, want)) {
          match = later;
          break;
        }
      }
    }

    if (match) {
      if (match !== current) {
        target.insertBefore(match, current);
      }
      morphNode(match, want);
    } else {
      target.insertBefore(want, current);
    }
    i += 1;
  }

  while (target.childNodes.length > i) {
    target.removeChild(target.childNodes[i]);
  }
}
