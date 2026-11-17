type Cleanup = (() => void) | undefined;

export function focusable(root: ParentNode): HTMLElement[];

export function dismissable(el: HTMLElement, onDismiss?: ((reason: "escape" | "outside") => void) | null | false): Cleanup;

export function focusTrap(el: HTMLElement, active?: boolean | null): Cleanup;

export interface RovingOptions {
  orientation?: "horizontal" | "vertical" | "both";
  loop?: boolean;
  typeahead?: boolean;
  items?: string;
  followFocus?: boolean;
}
export function roving(el: HTMLElement, options?: RovingOptions | null): Cleanup;

export type Side = "top" | "bottom" | "left" | "right";
export type Placement = Side | `${Side}-start` | `${Side}-end`;
export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}
export function place(
  anchor: Rect,
  floating: Rect,
  placement?: Placement,
  offset?: number,
  viewport?: { width: number; height: number },
): { x: number; y: number; side: Side; align: "start" | "center" | "end" };

export interface PositionOptions {
  anchor?: Element | string;
  placement?: Placement;
  offset?: number;
}
export function position(el: HTMLElement, options?: PositionOptions | null): Cleanup;

export interface ModalState {
  open: boolean;
  onClose?: (returnValue: string) => void;
  dismissable?: boolean;
}
export function modal(el: HTMLDialogElement, state: boolean | ModalState): Cleanup;

export interface PopoverState {
  open?: boolean;
  onToggle?: (open: boolean) => void;
}
export function popover(el: HTMLElement, state?: boolean | PopoverState): Cleanup;

export function tabs(el: HTMLElement, options?: { activation?: "automatic" | "manual" } | null): Cleanup;

export function menu(el: HTMLElement): Cleanup;

export interface TooltipOptions {
  text: string | number | null | undefined;
  placement?: Placement;
  offset?: number;
  delay?: number;
  class?: string;
}
export function tooltip(el: HTMLElement, value: string | number | null | undefined | TooltipOptions): Cleanup;

export function combobox(el: HTMLElement, options?: { filter?: boolean } | null): Cleanup;

export interface ToastOptions {
  description?: string;
  variant?: "default" | "success" | "error" | "warning" | (string & {});
  duration?: number;
  closeLabel?: string;
}
export function toast(title: string, options?: ToastOptions): () => void;

export function dialog(el: HTMLDialogElement): Cleanup;
export function copy(el: HTMLElement, text: string | null | undefined): Cleanup;
export function toggle(el: HTMLElement): Cleanup;
export function toggleGroup(el: HTMLElement, options?: { type?: "single" | "multiple" } | null): Cleanup;
export function contextMenu(el: HTMLElement, id: string): Cleanup;
export interface HoverCardOptions {
  id: string;
  placement?: Placement;
  offset?: number;
  openDelay?: number;
  closeDelay?: number;
}
export function hoverCard(el: HTMLElement, value: string | HoverCardOptions): Cleanup;
export function menubar(el: HTMLElement): Cleanup;
export function navigationMenu(el: HTMLElement): Cleanup;
export function carousel(el: HTMLElement): Cleanup;
export function resizable(el: HTMLElement): Cleanup;
export function select(el: HTMLElement): Cleanup;
export function inputOtp(el: HTMLElement): Cleanup;
export function calendar(el: HTMLElement): Cleanup;
export function sidebar(el: HTMLElement): Cleanup;
export function richText(el: HTMLElement): Cleanup;
export function mentionQuery(before: string): string | null;
export function mentionMatches(query: string, label: string): boolean;
export function safeHref(href: string): string | null;
