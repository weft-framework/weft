export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;

export interface MAttr {
  readonly name: string;
  readonly value: string;
}

export interface MNode {
  readonly nodeType: number;
  readonly nodeName: string;
  nodeValue: string | null;
  readonly parentNode: MNode | null;
}

export interface MParent extends MNode {
  readonly childNodes: ArrayLike<MNode>;
  insertBefore(node: MNode, ref: MNode | null): MNode;
  removeChild(node: MNode): MNode;
}

export interface MElement extends MParent {
  readonly attributes: ArrayLike<MAttr>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
}

export interface MEvent {
  readonly type: string;
  readonly target: unknown;
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  preventDefault?(): void;
  stopPropagation?(): void;
}

export interface MEventTarget {
  addEventListener(type: string, listener: (ev: MEvent) => void): void;
  removeEventListener(type: string, listener: (ev: MEvent) => void): void;
}

export function isElement(n: unknown): n is MElement {
  return (
    typeof n === "object" &&
    n !== null &&
    (n as MNode).nodeType === ELEMENT_NODE
  );
}
