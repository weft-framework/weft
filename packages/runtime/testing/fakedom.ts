import type { MEvent } from "../src/dom.ts";

export class FNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  parentNode: FElement | null = null;

  constructor(nodeType: number, nodeName: string, nodeValue: string | null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.nodeValue = nodeValue;
  }
}

export class FElement extends FNode {
  childNodes: FNode[] = [];
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Set<(ev: MEvent) => void>>();
  value?: string;
  checked?: boolean;
  type?: string;

  constructor(tag: string) {
    super(1, tag.toUpperCase(), null);
  }

  get attributes(): { name: string; value: string }[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  insertBefore(node: FNode, ref: FNode | null): FNode {
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    const at = ref === null ? this.childNodes.length : this.childNodes.indexOf(ref);
    if (at < 0) {
      throw new Error("insertBefore: reference is not a child");
    }
    this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }

  appendChild(node: FNode): FNode {
    return this.insertBefore(node, null);
  }

  removeChild(node: FNode): FNode {
    const at = this.childNodes.indexOf(node);
    if (at < 0) {
      throw new Error("removeChild: not a child");
    }
    this.childNodes.splice(at, 1);
    node.parentNode = null;
    return node;
  }

  addEventListener(type: string, fn: (ev: MEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: (ev: MEvent) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatch(type: string, target: FNode, extra: Partial<MEvent> = {}): { prevented: boolean } {
    const state = { prevented: false };
    const ev: MEvent = {
      type,
      target,
      ...extra,
      preventDefault() {
        state.prevented = true;
      },
    };
    for (const fn of this.listeners.get(type) ?? []) {
      fn(ev);
    }
    return state;
  }
}

export function text(value: string): FNode {
  return new FNode(3, "#text", value);
}

type Child = FNode | string;

export function h(tag: string, attrs: Record<string, string> = {}, ...kids: Child[]): FElement {
  const el = new FElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  for (const kid of kids) {
    el.appendChild(typeof kid === "string" ? text(kid) : kid);
  }
  return el;
}

export function frag(...kids: Child[]): FElement {
  const f = h("#fragment", {}, ...kids);
  f.nodeName = "#document-fragment";
  return f;
}

export function serialize(node: FNode): string {
  if (!(node instanceof FElement)) {
    return node.nodeValue ?? "";
  }
  const inner = node.childNodes.map(serialize).join("");
  if (node.nodeName === "#document-fragment") {
    return inner;
  }
  const tag = node.nodeName.toLowerCase();
  const attrs = node.attributes.map((a) => ` ${a.name}="${a.value}"`).join("");
  return `<${tag}${attrs}>${inner}</${tag}>`;
}
