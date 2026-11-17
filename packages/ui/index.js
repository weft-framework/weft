// SPDX-License-Identifier: MIT
//
// @weft/ui: headless, accessible behaviour for Weft components.
//
// Every export that takes an element is a `use:` attachment: it is called
// with the real element (and the attachment's value), sets up behaviour,
// and returns a cleanup. Components keep their state in `client signal`s
// and their markup and ARIA in the view; these functions add what markup
// alone cannot: focus management, keyboard models, dismissal, positioning.
//
//   client import { modal, dismissable, roving } from "@weft/ui"
//
//   <dialog use:modal={{ open, onClose: close }}>...</dialog>
//   <div role="menu" use:roving={{ orientation: "vertical" }}>...</div>
//
// Stacking uses the browser's top layer (`<dialog>`, `popover`) instead of
// moving elements to the end of <body> ("portals"), so live patches keep
// working on content that sits on top of the page.

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "summary",
  "[contenteditable='']",
  "[contenteditable=true]",
  "[tabindex]",
].join(",");

/** The keyboard-focusable elements under `root`, in tab order of the DOM
 * (visible, not inert, not `tabindex="-1"`). */
export function focusable(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && !el.closest("[inert]") && el.getClientRects().length > 0,
  );
}

function disabled(el) {
  return el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
}

// --- dismiss layers -------------------------------------------------------
// Open layers (dialogs, popovers, menus), newest last. Escape and a press
// outside go to the topmost layer only, so closing a menu inside a dialog
// leaves the dialog open.

const layers = [];

function topLayer() {
  return layers[layers.length - 1];
}

function onLayerKey(e) {
  const top = topLayer();
  if (top && e.key === "Escape" && !e.defaultPrevented) {
    e.preventDefault();
    e.stopPropagation();
    top.dismiss("escape");
  }
}

function onLayerPointer(e) {
  const top = topLayer();
  if (!top || !(e.target instanceof Node)) return;
  if (top.el.contains(e.target) || top.inside(e.target)) return;
  top.dismiss("outside");
}

function pushLayer(layer) {
  if (layers.length === 0) {
    document.addEventListener("keydown", onLayerKey, true);
    document.addEventListener("pointerdown", onLayerPointer, true);
  }
  layers.push(layer);
  return () => {
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    if (layers.length === 0) {
      document.removeEventListener("keydown", onLayerKey, true);
      document.removeEventListener("pointerdown", onLayerPointer, true);
    }
  };
}

/** Elements counted as inside a layer: its trigger(s), found by
 * `aria-controls` / `popovertarget` / `commandfor` naming the layer's id,
 * and anything marked `data-weft-layer-part`. */
function partOfLayer(el, target) {
  const owner = target instanceof Element ? target.closest("[aria-controls],[popovertarget],[commandfor],[data-weft-layer-part]") : null;
  if (!owner) return false;
  if (owner.hasAttribute("data-weft-layer-part")) return true;
  const id = el.id;
  return (
    id !== "" &&
    [owner.getAttribute("aria-controls"), owner.getAttribute("popovertarget"), owner.getAttribute("commandfor")].some(
      (v) => v !== null && v.split(/\s+/).includes(id),
    )
  );
}

/**
 * `use:dismissable={onDismiss}`: while the value is a function, Escape or a
 * press outside the element (and outside its triggers) calls it with
 * "escape" or "outside". A falsy value leaves the element inactive.
 */
export function dismissable(el, onDismiss) {
  if (typeof onDismiss !== "function") return undefined;
  return pushLayer({ el, dismiss: (reason) => onDismiss(reason), inside: (t) => partOfLayer(el, t) });
}

// --- focus trap -----------------------------------------------------------

const traps = [];

/**
 * `use:focusTrap` / `use:focusTrap={active}`: keeps Tab and Shift+Tab inside
 * the element while active, moves focus in (to `[autofocus]`, else the first
 * focusable element, else the element itself), and gives focus back to
 * where it was on cleanup. Nested traps: the newest one is in charge.
 */
export function focusTrap(el, active = true) {
  if (active === false || active === null) return undefined;
  const previous = document.activeElement;
  const trap = { el };
  traps.push(trap);
  const first = el.querySelector("[autofocus]") ?? focusable(el)[0];
  if (first) first.focus();
  else {
    if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
    el.focus();
  }
  const onKey = (e) => {
    if (e.key !== "Tab" || traps[traps.length - 1] !== trap) return;
    const items = focusable(el);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const at = items.indexOf(document.activeElement);
    if (e.shiftKey && (at <= 0)) {
      e.preventDefault();
      items[items.length - 1].focus();
    } else if (!e.shiftKey && (at === -1 || at === items.length - 1)) {
      e.preventDefault();
      items[0].focus();
    }
  };
  const onFocusIn = (e) => {
    if (traps[traps.length - 1] !== trap || el.contains(e.target)) return;
    (focusable(el)[0] ?? el).focus();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", onFocusIn, true);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", onFocusIn, true);
    const i = traps.indexOf(trap);
    if (i >= 0) traps.splice(i, 1);
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  };
}

// --- roving tabindex and typeahead ------------------------------------------

const ITEMS = "[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=radio],[role=treeitem],[data-weft-item]";

/**
 * `use:roving` / `use:roving={{ orientation, loop, typeahead, items,
 * followFocus }}`: one Tab stop for a group (tabs, menu items, options,
 * toolbar buttons); arrow keys move between items (per `orientation`,
 * default from `aria-orientation`, else both), Home/End jump, typing a
 * prefix jumps to the matching item. `followFocus` clicks the item it moves
 * to (tabs with automatic activation).
 */
export function roving(el, options) {
  const opts = options ?? {};
  const selector = opts.items ?? ITEMS;
  const loop = opts.loop !== false;
  // Items inside a hidden part of the group (a collapsed submenu) are out.
  const items = () =>
    [...el.querySelectorAll(selector)].filter((i) => {
      const h = i.closest("[hidden]");
      return h === null || !el.contains(h);
    });
  const orientation = () => opts.orientation ?? el.getAttribute("aria-orientation") ?? "both";
  const settle = (current) => {
    for (const i of items()) i.tabIndex = i === current ? 0 : -1;
  };
  const initial = () => {
    const all = items();
    return (
      all.find((i) => i.getAttribute("aria-selected") === "true" || i.getAttribute("aria-checked") === "true") ??
      all.find((i) => !disabled(i)) ??
      all[0]
    );
  };
  settle(initial());
  const move = (to) => {
    if (!to) return;
    settle(to);
    to.focus();
    if (opts.followFocus) to.click();
  };
  let buffer = "";
  let bufferAt = 0;
  const onKey = (e) => {
    const all = items().filter((i) => !disabled(i));
    const at = all.indexOf(document.activeElement);
    if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    const o = orientation();
    const rtl = getComputedStyle(el).direction === "rtl";
    const next = (o !== "vertical" && e.key === (rtl ? "ArrowLeft" : "ArrowRight")) || (o !== "horizontal" && e.key === "ArrowDown");
    const prev = (o !== "vertical" && e.key === (rtl ? "ArrowRight" : "ArrowLeft")) || (o !== "horizontal" && e.key === "ArrowUp");
    if (next || prev) {
      e.preventDefault();
      let to = at + (next ? 1 : -1);
      if (to < 0) to = loop ? all.length - 1 : 0;
      if (to >= all.length) to = loop ? 0 : all.length - 1;
      move(all[to]);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      move(e.key === "Home" ? all[0] : all[all.length - 1]);
    } else if (opts.typeahead !== false && e.key.length === 1 && e.key !== " ") {
      const now = Date.now();
      buffer = now - bufferAt > 500 ? e.key.toLowerCase() : buffer + e.key.toLowerCase();
      bufferAt = now;
      // Search from the item after the current one, wrapping around.
      const order = [...all.slice(at + 1), ...all.slice(0, at + 1)];
      const hit = order.find((i) => (i.getAttribute("aria-label") ?? i.textContent ?? "").trim().toLowerCase().startsWith(buffer));
      if (hit) move(hit);
    }
  };
  const onFocusIn = (e) => {
    const item = e.target instanceof Element ? e.target.closest(selector) : null;
    if (item && el.contains(item)) settle(item);
  };
  el.addEventListener("keydown", onKey);
  el.addEventListener("focusin", onFocusIn);
  return () => {
    el.removeEventListener("keydown", onKey);
    el.removeEventListener("focusin", onFocusIn);
  };
}

// --- positioning ------------------------------------------------------------

/** Where `floating` goes next to `anchor` (both DOMRects) for `placement`
 * (`top|bottom|left|right` with `-start|-end`), flipped to the opposite
 * side when it would leave the viewport. Pure: exported for tests. */
export function place(anchor, floating, placement = "bottom", offset = 4, viewport = { width: innerWidth, height: innerHeight }) {
  let [side, align = "center"] = placement.split("-");
  const fits = (s) =>
    s === "bottom"
      ? anchor.bottom + offset + floating.height <= viewport.height
      : s === "top"
        ? anchor.top - offset - floating.height >= 0
        : s === "right"
          ? anchor.right + offset + floating.width <= viewport.width
          : anchor.left - offset - floating.width >= 0;
  const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" };
  if (!fits(side) && fits(opposite[side])) side = opposite[side];
  let x;
  let y;
  if (side === "top" || side === "bottom") {
    y = side === "bottom" ? anchor.bottom + offset : anchor.top - offset - floating.height;
    x = align === "start" ? anchor.left : align === "end" ? anchor.right - floating.width : anchor.left + (anchor.width - floating.width) / 2;
    x = Math.min(Math.max(0, x), Math.max(0, viewport.width - floating.width));
  } else {
    x = side === "right" ? anchor.right + offset : anchor.left - offset - floating.width;
    y = align === "start" ? anchor.top : align === "end" ? anchor.bottom - floating.height : anchor.top + (anchor.height - floating.height) / 2;
    y = Math.min(Math.max(0, y), Math.max(0, viewport.height - floating.height));
  }
  return { x: Math.round(x), y: Math.round(y), side, align };
}

function anchorOf(el, anchor) {
  if (anchor instanceof Element) return anchor;
  if (typeof anchor === "string") return document.getElementById(anchor);
  const id = el.id;
  return id ? document.querySelector(`[popovertarget="${CSS.escape(id)}"],[aria-controls~="${CSS.escape(id)}"]`) : null;
}

/**
 * `use:position={{ anchor, placement, offset }}`: keeps a floating element
 * (fixed, usually a popover in the top layer) next to its anchor (an
 * element, an id, or by default the element whose `popovertarget` /
 * `aria-controls` names it), following scroll, resize and size changes, and
 * sets `data-side` / `data-align` for styling.
 */
export function position(el, options) {
  const opts = options ?? {};
  let frame = 0;
  const update = () => {
    frame = 0;
    const anchor = anchorOf(el, opts.anchor);
    if (!anchor || el.getClientRects().length === 0) return;
    const p = place(anchor.getBoundingClientRect(), el.getBoundingClientRect(), opts.placement ?? "bottom-start", opts.offset ?? 4);
    Object.assign(el.style, { position: "fixed", inset: "auto", margin: "0", left: `${p.x}px`, top: `${p.y}px` });
    el.dataset.side = p.side;
    el.dataset.align = p.align;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  update();
  addEventListener("scroll", schedule, true);
  addEventListener("resize", schedule);
  el.addEventListener("toggle", schedule);
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  ro?.observe(el);
  const anchor = anchorOf(el, opts.anchor);
  if (anchor) ro?.observe(anchor);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    removeEventListener("scroll", schedule, true);
    removeEventListener("resize", schedule);
    el.removeEventListener("toggle", schedule);
    ro?.disconnect();
  };
}

// --- dialog -----------------------------------------------------------------

/**
 * `use:modal={open}` or `use:modal={{ open, onClose, dismissable }}` on a
 * `<dialog>`: shown as a modal (top layer, page inert, focus moved in and
 * restored by the browser) while `open` is true, closed when false. A close
 * the visitor makes (Escape, a click on the backdrop unless `dismissable` is
 * false, a `<form method="dialog">` button) calls `onClose`, so the
 * component's state follows.
 */
export function modal(el, state) {
  const s = typeof state === "object" && state !== null ? state : { open: Boolean(state) };
  if (!(el instanceof HTMLDialogElement)) throw new Error("modal: attach to a <dialog>");
  const onClose = () => {
    if (s.open) s.onClose?.(el.returnValue);
  };
  const onCancel = (e) => {
    if (s.dismissable === false) e.preventDefault();
  };
  const onClick = (e) => {
    if (s.dismissable === false || e.target !== el) return;
    const r = el.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (outside) el.close();
  };
  el.addEventListener("close", onClose);
  el.addEventListener("cancel", onCancel);
  el.addEventListener("click", onClick);
  if (s.open && !el.open) {
    el.returnValue = "";
    el.showModal();
  } else if (!s.open && el.open) {
    el.close();
  }
  return () => {
    el.removeEventListener("close", onClose);
    el.removeEventListener("cancel", onCancel);
    el.removeEventListener("click", onClick);
  };
}

// --- popover ----------------------------------------------------------------

/**
 * `use:popover={open}` or `use:popover={{ open, onToggle }}` on a `popover`
 * element: shown or hidden to match `open`; a toggle the browser makes
 * (light dismiss, Escape, a `popovertarget` button) calls `onToggle(open)`.
 * Without a value it only reports nothing: use `popovertarget` alone.
 */
export function popover(el, state) {
  const s = typeof state === "object" && state !== null ? state : state === undefined ? {} : { open: Boolean(state) };
  const onToggle = (e) => {
    const open = e.newState === "open";
    if (s.open !== undefined && open !== s.open) s.onToggle?.(open);
  };
  el.addEventListener("toggle", onToggle);
  if (s.open !== undefined && typeof el.showPopover === "function") {
    const shown = el.matches(":popover-open");
    if (s.open && !shown) el.showPopover();
    else if (!s.open && shown) el.hidePopover();
  }
  return () => el.removeEventListener("toggle", onToggle);
}

// --- tabs -------------------------------------------------------------------

/**
 * `use:tabs` on the element holding a `role="tablist"` of `role="tab"`
 * buttons whose `aria-controls` name `role="tabpanel"` elements: clicking or
 * arrowing to a tab selects it (`aria-selected`, one Tab stop, the other
 * panels `hidden`) and dispatches `weft:change` (detail: the tab's id).
 * `{ activation: "manual" }` selects on Enter/Space/click only.
 */
let tabsSeq = 0;
export function tabs(el, options) {
  const opts = options ?? {};
  const list = el.querySelector("[role=tablist]") ?? el;
  const all = () => [...list.querySelectorAll("[role=tab]")];
  // Tabs and panels may be paired by `data-value` instead of ids: give
  // them ids and the ARIA links. Selection is client state from here on,
  // so live patches leave it alone (`data-weft-own`).
  const base = el.id || `weft-tabs-${(tabsSeq += 1)}`;
  for (const t of all()) {
    const v = t.dataset.value;
    if (v === undefined) continue;
    const panel = [...el.querySelectorAll("[role=tabpanel]")].find((p) => p.dataset.value === v);
    if (!t.id) t.id = `${base}-tab-${v}`;
    if (panel) {
      if (!panel.id) panel.id = `${base}-panel-${v}`;
      t.setAttribute("aria-controls", panel.id);
      panel.setAttribute("aria-labelledby", t.id);
      panel.setAttribute("data-weft-own", "hidden data-state");
    }
    t.setAttribute("data-weft-own", "aria-selected tabindex data-state");
  }
  const select = (tab, notify) => {
    for (const t of all()) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      t.dataset.state = on ? "active" : "inactive";
      const panel = document.getElementById(t.getAttribute("aria-controls") ?? "");
      if (panel) {
        panel.hidden = !on;
        panel.dataset.state = on ? "active" : "inactive";
      }
    }
    if (notify) el.dispatchEvent(new CustomEvent("weft:change", { detail: tab.id, bubbles: true }));
  };
  const start = all().find((t) => t.getAttribute("aria-selected") === "true") ?? all().find((t) => !disabled(t));
  if (start) select(start, false);
  const onClick = (e) => {
    const tab = e.target instanceof Element ? e.target.closest("[role=tab]") : null;
    if (tab && list.contains(tab) && !disabled(tab) && tab.getAttribute("aria-selected") !== "true") select(tab, true);
  };
  list.addEventListener("click", onClick);
  const stopRoving = roving(list, {
    items: "[role=tab]",
    orientation: list.getAttribute("aria-orientation") ?? "horizontal",
    followFocus: opts.activation !== "manual",
    typeahead: false,
  });
  return () => {
    list.removeEventListener("click", onClick);
    stopRoving();
  };
}

// --- menu -------------------------------------------------------------------

/**
 * `use:menu` on a `popover` element with `role="menu"` (opened by a
 * `popovertarget` button): when it opens, focus goes to the first item;
 * arrows, Home/End and typeahead move between `menuitem`s; Enter/Space or a
 * click activates one and closes the menu; closing returns focus to the
 * button that opened it.
 */
export function menu(el) {
  let opener = null;
  const items = () => [...el.querySelectorAll("[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio]")].filter((i) => !disabled(i));
  const onToggle = (e) => {
    if (e.newState === "open") {
      opener = document.activeElement;
      requestAnimationFrame(() => items()[0]?.focus());
    } else if (opener instanceof HTMLElement) {
      // Closed with focus inside (Escape) or lost: back to the button. A
      // click elsewhere keeps the focus it gave.
      const at = document.activeElement;
      if (!at || at === document.body || el.contains(at)) opener.focus();
    }
  };
  const close = () => {
    if (typeof el.hidePopover === "function" && el.matches(":popover-open")) el.hidePopover();
    if (opener instanceof HTMLElement) opener.focus();
  };
  const onClick = (e) => {
    const item = e.target instanceof Element ? e.target.closest("[role^=menuitem]") : null;
    if (!item || disabled(item)) return;
    const role = item.getAttribute("role");
    if (role === "menuitemcheckbox") {
      own(item, "aria-checked", "data-state");
      const on = item.getAttribute("aria-checked") !== "true";
      item.setAttribute("aria-checked", String(on));
      item.dataset.state = on ? "checked" : "unchecked";
      emit(item, on);
    } else if (role === "menuitemradio") {
      const group = item.closest("[role=group]") ?? el;
      for (const r of group.querySelectorAll("[role=menuitemradio]")) {
        own(r, "aria-checked", "data-state");
        r.setAttribute("aria-checked", String(r === item));
        r.dataset.state = r === item ? "checked" : "unchecked";
      }
      emit(group, item.dataset.value ?? item.textContent.trim());
    }
    if (item.dataset.keepOpen === undefined) close();
  };
  const onKey = (e) => {
    const item = e.target instanceof Element ? e.target.closest("[role^=menuitem]") : null;
    if (item && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      item.click();
    } else if (e.key === "Tab") {
      close();
    }
  };
  el.addEventListener("toggle", onToggle);
  el.addEventListener("click", onClick);
  el.addEventListener("keydown", onKey);
  const stopRoving = roving(el, { orientation: "vertical", items: "[role^=menuitem]" });
  return () => {
    el.removeEventListener("toggle", onToggle);
    el.removeEventListener("click", onClick);
    el.removeEventListener("keydown", onKey);
    stopRoving();
  };
}

// --- tooltip ----------------------------------------------------------------

let tooltipSeq = 0;

/**
 * `use:tooltip={text}` or `use:tooltip={{ text, placement, delay, class }}`:
 * a `role="tooltip"` bubble (a manual popover, so it sits in the top layer)
 * shown after `delay` ms (default 400) on hover or focus, hidden on leave,
 * blur or Escape, and named by the element's `aria-describedby`.
 */
export function tooltip(el, value) {
  const o = typeof value === "object" && value !== null ? value : { text: value };
  if (o.text === undefined || o.text === null || o.text === "") return undefined;
  const tip = document.createElement("div");
  tip.id = `weft-tooltip-${++tooltipSeq}`;
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("popover", "manual");
  tip.className = o.class ?? "weft-tooltip";
  tip.textContent = String(o.text);
  document.body.append(tip);
  const described = el.getAttribute("aria-describedby");
  el.setAttribute("aria-describedby", described ? `${described} ${tip.id}` : tip.id);
  let timer = 0;
  let stopPosition = null;
  const show = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!tip.isConnected || tip.matches(":popover-open")) return;
      tip.showPopover();
      stopPosition = position(tip, { anchor: el, placement: o.placement ?? "top", offset: o.offset ?? 6 });
    }, o.delay ?? 400);
  };
  const hide = () => {
    clearTimeout(timer);
    stopPosition?.();
    stopPosition = null;
    if (tip.matches(":popover-open")) tip.hidePopover();
  };
  const onKey = (e) => {
    if (e.key === "Escape") hide();
  };
  el.addEventListener("pointerenter", show);
  el.addEventListener("pointerleave", hide);
  el.addEventListener("focus", show);
  el.addEventListener("blur", hide);
  el.addEventListener("keydown", onKey);
  return () => {
    hide();
    el.removeEventListener("pointerenter", show);
    el.removeEventListener("pointerleave", hide);
    el.removeEventListener("focus", show);
    el.removeEventListener("blur", hide);
    el.removeEventListener("keydown", onKey);
    const rest = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== tip.id);
    if (rest.length) el.setAttribute("aria-describedby", rest.join(" "));
    else el.removeAttribute("aria-describedby");
    tip.remove();
  };
}

// --- combobox ---------------------------------------------------------------

/**
 * `use:combobox` on a wrapper holding an `<input role="combobox">` and a
 * `role="listbox"` of `role="option"` elements: typing filters the options
 * (by text, or `data-value`), arrows move the active option
 * (`aria-activedescendant`, focus stays in the input), Enter picks it
 * (`aria-selected`, the input's value, a `weft:change` event with the
 * option's `data-value`), Escape closes. The listbox is shown while the
 * input has focus and something matches.
 */
export function combobox(el, options) {
  const opts = options ?? {};
  const input = el.querySelector("[role=combobox]");
  const list = el.querySelector("[role=listbox]");
  if (!input || !list) throw new Error("combobox: needs [role=combobox] and [role=listbox] inside");
  if (!list.id) list.id = `weft-listbox-${++tooltipSeq}`;
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-autocomplete", "list");
  const all = () => [...list.querySelectorAll("[role=option]")];
  const visible = () => all().filter((o) => !o.hidden && !disabled(o));
  let active = null;
  all().forEach((o, i) => {
    if (!o.id) o.id = `${list.id}-${i}`;
  });
  const inline = el.hasAttribute("data-inline");
  const setOpen = (open) => {
    open = open || inline;
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    if (!open) setActive(null);
  };
  const setActive = (o) => {
    active = o;
    for (const x of all()) x.toggleAttribute("data-active", x === o);
    if (o) {
      input.setAttribute("aria-activedescendant", o.id);
      o.scrollIntoView?.({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    for (const o of all()) {
      const text = `${o.dataset.value ?? ""} ${o.textContent ?? ""}`.toLowerCase();
      o.hidden = q !== "" && opts.filter !== false && !text.includes(q);
    }
    const empty = el.querySelector("[data-weft-empty]");
    if (empty) empty.hidden = visible().length > 0;
    setOpen(true);
    if (active && active.hidden) setActive(visible()[0] ?? null);
  };
  const pick = (o) => {
    for (const x of all()) x.setAttribute("aria-selected", String(x === o));
    input.value = (o.dataset.label ?? o.textContent ?? "").trim();
    setOpen(false);
    el.dispatchEvent(new CustomEvent("weft:change", { detail: o.dataset.value ?? input.value, bubbles: true }));
  };
  const onKey = (e) => {
    const vis = visible();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) setOpen(true);
      const at = active ? vis.indexOf(active) : -1;
      const to = e.key === "ArrowDown" ? (at + 1) % vis.length : (at - 1 + vis.length) % vis.length;
      setActive(vis[to] ?? null);
    } else if (e.key === "Enter" && active && !list.hidden) {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape" && !list.hidden) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };
  const onDown = (e) => {
    const o = e.target instanceof Element ? e.target.closest("[role=option]") : null;
    if (o && list.contains(o) && !disabled(o)) {
      e.preventDefault(); // keep focus in the input
      pick(o);
    }
  };
  const onBlur = () => setOpen(false);
  input.addEventListener("input", filter);
  input.addEventListener("focus", filter);
  input.addEventListener("keydown", onKey);
  input.addEventListener("blur", onBlur);
  list.addEventListener("pointerdown", onDown);
  setOpen(false);
  return () => {
    input.removeEventListener("input", filter);
    input.removeEventListener("focus", filter);
    input.removeEventListener("keydown", onKey);
    input.removeEventListener("blur", onBlur);
    list.removeEventListener("pointerdown", onDown);
  };
}

// --- toast ------------------------------------------------------------------

/**
 * `toast(title, { description, variant, duration })`: a notification in the
 * page's toast region (an element with `data-weft-toaster`, e.g. the shadcn
 * `<Toaster />`; created on demand otherwise), announced politely to screen
 * readers, removed after `duration` ms (default 4000; 0 keeps it) or by its
 * close button. Item classes come from the region's `data-item-class`
 * (and `data-<variant>-class`). Returns a function that dismisses it.
 */
export function toast(title, options = {}) {
  let region = document.querySelector("[data-weft-toaster]");
  if (!region) {
    region = document.createElement("ol");
    region.setAttribute("data-weft-toaster", "");
    region.className = "weft-toaster";
    document.body.append(region);
  }
  if (!region.hasAttribute("aria-live")) {
    region.setAttribute("aria-live", "polite");
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", region.getAttribute("aria-label") ?? "Notifications");
  }
  const variant = options.variant ?? "default";
  const item = document.createElement("li");
  item.setAttribute("role", "status");
  item.dataset.variant = variant;
  item.className = [region.dataset.itemClass ?? "weft-toast", region.dataset[`${variant}Class`] ?? ""].join(" ").trim();
  const head = document.createElement("div");
  head.dataset.title = "";
  head.textContent = String(title);
  item.append(head);
  if (options.description) {
    const body = document.createElement("div");
    body.dataset.description = "";
    body.textContent = String(options.description);
    item.append(body);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.dataset.close = "";
  close.setAttribute("aria-label", options.closeLabel ?? "Close");
  close.textContent = "×";
  item.append(close);
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    item.remove();
  };
  close.addEventListener("click", dismiss);
  region.append(item);
  const duration = options.duration ?? 4000;
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return dismiss;
}

// --- shared helpers for markup-driven widgets ------------------------------

/** Add attribute names to `data-weft-own`: client state patches keep. */
function own(el, ...names) {
  const set = new Set((el.getAttribute("data-weft-own") ?? "").split(/\s+/).filter(Boolean));
  for (const n of names) set.add(n);
  el.setAttribute("data-weft-own", [...set].join(" "));
}

function emit(el, detail) {
  el.dispatchEvent(new CustomEvent("weft:change", { detail, bubbles: true }));
}

function isOpen(pop) {
  return typeof pop.matches === "function" && pop.matches(":popover-open");
}

function showPop(pop) {
  if (pop && typeof pop.showPopover === "function" && !isOpen(pop)) pop.showPopover();
}

function hidePop(pop) {
  if (pop && typeof pop.hidePopover === "function" && isOpen(pop)) pop.hidePopover();
}

// --- uncontrolled dialogs ----------------------------------------------------

const nativeCommands = typeof HTMLButtonElement !== "undefined" && "command" in HTMLButtonElement.prototype;

/**
 * `use:dialog` on a `<dialog id>`: opened and closed by markup alone, no
 * client state. Buttons with `commandfor="<id>"` and `command="show-modal"
 * | "close" | "request-close"` drive it (natively where the browser has
 * invoker commands, by this attachment where not); `<form method="dialog">`
 * closes it; a backdrop click or Escape closes it unless the dialog has
 * `data-dismissable="false"`. `data-state` is "open" / "closed" for
 * styling, and focus goes back to the opener on close.
 */
export function dialog(el) {
  if (!(el instanceof HTMLDialogElement)) throw new Error("dialog: attach to a <dialog>");
  let opener = null;
  const sticky = () => el.dataset.dismissable === "false";
  const state = () => {
    el.dataset.state = el.open ? "open" : "closed";
  };
  own(el, "data-state");
  state();
  const onDoc = (e) => {
    const button = e.target instanceof Element ? e.target.closest("[commandfor]") : null;
    if (!button || button.getAttribute("commandfor") !== el.id || disabled(button)) return;
    const command = button.getAttribute("command");
    if (command === "show-modal") opener = button;
    if (nativeCommands) return;
    if (command === "show-modal" && !el.open) {
      el.returnValue = "";
      el.showModal();
    } else if (command === "close" && el.open) {
      el.close(button.getAttribute("value") ?? undefined);
    } else if (command === "request-close" && el.open) {
      if (typeof el.requestClose === "function") el.requestClose();
      else el.close();
    }
  };
  const onCancel = (e) => {
    if (sticky()) e.preventDefault();
  };
  const onClose = () => {
    state();
    // `close` is a queued event: the browser has usually given focus back
    // already, and the user may have moved it on since. Only take focus
    // that was lost (or is still in the closed dialog).
    const at = document.activeElement;
    const lost = !at || at === document.body || el.contains(at);
    if (lost && opener instanceof HTMLElement && opener.isConnected) opener.focus();
    opener = null;
  };
  const onClick = (e) => {
    if (sticky() || e.target !== el) return;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) el.close();
  };
  // `open` also changes through native invokers: mirror it.
  const watch = new MutationObserver(state);
  watch.observe(el, { attributes: true, attributeFilter: ["open"] });
  document.addEventListener("click", onDoc, true);
  el.addEventListener("cancel", onCancel);
  el.addEventListener("close", onClose);
  el.addEventListener("click", onClick);
  return () => {
    watch.disconnect();
    document.removeEventListener("click", onDoc, true);
    el.removeEventListener("cancel", onCancel);
    el.removeEventListener("close", onClose);
    el.removeEventListener("click", onClick);
  };
}

// --- clipboard ---------------------------------------------------------------

/**
 * `use:copy={text}` on a button: a click writes `text` to the clipboard and
 * sets `data-state="copied"` for two seconds ("failed" when the browser
 * refuses, e.g. on an insecure origin). Dispatches `weft:change` (detail:
 * true on success).
 */
export function copy(el, text) {
  own(el, "data-state");
  const value = text ?? "";
  let timer = null;
  const mark = (state) => {
    el.dataset.state = state;
    clearTimeout(timer);
    timer = setTimeout(() => {
      el.dataset.state = "idle";
    }, 2000);
  };
  el.dataset.state = "idle";
  const onClick = async () => {
    if (disabled(el)) return;
    try {
      await navigator.clipboard.writeText(value);
      mark("copied");
      emit(el, true);
    } catch {
      mark("failed");
      emit(el, false);
    }
  };
  el.addEventListener("click", onClick);
  return () => {
    clearTimeout(timer);
    el.removeEventListener("click", onClick);
  };
}

// --- toggles -----------------------------------------------------------------

/**
 * `use:toggle` on a `<button aria-pressed>`: a click flips `aria-pressed`
 * and `data-state` ("on" / "off") and dispatches `weft:change` (detail:
 * the new pressed state).
 */
export function toggle(el) {
  own(el, "aria-pressed", "data-state");
  const sync = () => {
    el.dataset.state = el.getAttribute("aria-pressed") === "true" ? "on" : "off";
  };
  sync();
  const onClick = () => {
    if (disabled(el)) return;
    const on = el.getAttribute("aria-pressed") !== "true";
    el.setAttribute("aria-pressed", String(on));
    sync();
    emit(el, on);
  };
  el.addEventListener("click", onClick);
  return () => el.removeEventListener("click", onClick);
}

/**
 * `use:toggleGroup={{ type: "single" | "multiple" }}` on a group of
 * `<button data-value aria-pressed>`: one Tab stop with arrow keys; in a
 * single group pressing one releases the others. `weft:change` carries the
 * pressed value (single, "" for none) or values (multiple). A hidden
 * `<input name>` in the group gets them, comma-joined, for forms.
 */
export function toggleGroup(el, options) {
  const multiple = (options ?? {}).type === "multiple";
  const items = () => [...el.querySelectorAll("[data-value]")].filter((b) => b.tagName === "BUTTON");
  const field = el.querySelector("input[type=hidden]");
  const sync = () => {
    const on = [];
    for (const b of items()) {
      own(b, "aria-pressed", "data-state");
      const pressed = b.getAttribute("aria-pressed") === "true";
      b.dataset.state = pressed ? "on" : "off";
      if (pressed) on.push(b.dataset.value);
    }
    if (field) field.value = on.join(",");
    return multiple ? on : (on[0] ?? "");
  };
  sync();
  const onClick = (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-value]") : null;
    if (!b || !el.contains(b) || disabled(b)) return;
    const next = b.getAttribute("aria-pressed") !== "true";
    if (!multiple) for (const o of items()) o.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-pressed", String(next));
    emit(el, sync());
  };
  el.addEventListener("click", onClick);
  const stopRoving = roving(el, { items: "button[data-value]", orientation: el.getAttribute("aria-orientation") ?? "horizontal", typeahead: false });
  return () => {
    el.removeEventListener("click", onClick);
    stopRoving();
  };
}

// --- context menu ------------------------------------------------------------

/**
 * `use:contextMenu={"menu-id"}` on the area: a right click (or the context
 * menu key / Shift+F10) opens the `popover` menu with that id at the
 * pointer. Give the menu `use:menu` for its keyboard model.
 */
export function contextMenu(el, id) {
  const onMenu = (e) => {
    const pop = document.getElementById(String(id ?? ""));
    if (!pop) return;
    e.preventDefault();
    let x = e.clientX;
    let y = e.clientY;
    if (!x && !y) {
      const r = el.getBoundingClientRect();
      x = r.left + 8;
      y = r.top + 8;
    }
    hidePop(pop);
    showPop(pop);
    const box = pop.getBoundingClientRect();
    x = Math.max(4, Math.min(x, innerWidth - box.width - 4));
    y = Math.max(4, Math.min(y, innerHeight - box.height - 4));
    Object.assign(pop.style, { position: "fixed", inset: "auto", margin: "0", left: `${x}px`, top: `${y}px` });
  };
  el.addEventListener("contextmenu", onMenu);
  return () => el.removeEventListener("contextmenu", onMenu);
}

// --- hover card --------------------------------------------------------------

/**
 * `use:hoverCard={"card-id"}` (or `{ id, placement, openDelay, closeDelay }`)
 * on a trigger: hovering or focusing it shows the `popover="manual"` card
 * with that id next to it; leaving both trigger and card hides it.
 */
export function hoverCard(el, value) {
  const o = typeof value === "object" && value !== null ? value : { id: value };
  let timer = 0;
  let stopPosition = null;
  const card = () => document.getElementById(String(o.id ?? ""));
  const show = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const c = card();
      if (!c || isOpen(c)) return;
      showPop(c);
      stopPosition = position(c, { anchor: el, placement: o.placement ?? "bottom", offset: o.offset ?? 6 });
    }, o.openDelay ?? 500);
  };
  const hide = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stopPosition?.();
      stopPosition = null;
      hidePop(card());
    }, o.closeDelay ?? 200);
  };
  const keep = () => clearTimeout(timer);
  const onKey = (e) => {
    if (e.key === "Escape") hidePop(card());
  };
  const c0 = card();
  c0?.addEventListener("pointerenter", keep);
  c0?.addEventListener("pointerleave", hide);
  el.addEventListener("pointerenter", show);
  el.addEventListener("pointerleave", hide);
  el.addEventListener("focus", show);
  el.addEventListener("blur", hide);
  el.addEventListener("keydown", onKey);
  return () => {
    clearTimeout(timer);
    stopPosition?.();
    c0?.removeEventListener("pointerenter", keep);
    c0?.removeEventListener("pointerleave", hide);
    el.removeEventListener("pointerenter", show);
    el.removeEventListener("pointerleave", hide);
    el.removeEventListener("focus", show);
    el.removeEventListener("blur", hide);
    el.removeEventListener("keydown", onKey);
  };
}

// --- menubar and navigation menu --------------------------------------------

function popOf(trigger) {
  return document.getElementById(trigger.getAttribute("popovertarget") ?? "");
}

/**
 * `use:menubar` on a `role="menubar"` of `role="menuitem"` buttons, each
 * with `popovertarget` naming a `use:menu` popover: one Tab stop, Left /
 * Right move along the bar, and while a menu is open moving (or hovering)
 * opens the neighbour's menu instead. Down opens the focused one.
 */
export function menubar(el) {
  const triggers = () => [...el.querySelectorAll(":scope > [role=menuitem], :scope > * > [role=menuitem]")];
  const openOne = () => triggers().find((t) => isOpen(popOf(t) ?? el));
  const move = (from, step) => {
    const all = triggers();
    const next = all[(all.indexOf(from) + step + all.length) % all.length];
    const wasOpen = openOne();
    if (wasOpen) hidePop(popOf(wasOpen));
    next.focus();
    if (wasOpen) showPop(popOf(next));
  };
  const onKey = (e) => {
    const t = e.target instanceof Element ? e.target.closest("[role=menuitem]") : null;
    const inBar = t && triggers().includes(t);
    const owner = inBar ? t : triggers().find((x) => popOf(x)?.contains(e.target));
    if (!owner) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      if (!inBar && e.target.closest("[aria-haspopup]")) return; // a submenu
      e.preventDefault();
      move(owner, e.key === "ArrowRight" ? 1 : -1);
    } else if (inBar && e.key === "ArrowDown") {
      e.preventDefault();
      showPop(popOf(t));
    }
  };
  const onEnter = (e) => {
    const t = e.target instanceof Element ? e.target.closest("[role=menuitem]") : null;
    const wasOpen = openOne();
    if (!t || !wasOpen || wasOpen === t || !triggers().includes(t)) return;
    hidePop(popOf(wasOpen));
    showPop(popOf(t));
  };
  for (const [i, t] of triggers().entries()) t.tabIndex = i === 0 ? 0 : -1;
  const onFocus = (e) => {
    const t = e.target;
    if (!triggers().includes(t)) return;
    for (const o of triggers()) o.tabIndex = o === t ? 0 : -1;
  };
  document.addEventListener("keydown", onKey);
  el.addEventListener("pointerover", onEnter);
  el.addEventListener("focusin", onFocus);
  return () => {
    document.removeEventListener("keydown", onKey);
    el.removeEventListener("pointerover", onEnter);
    el.removeEventListener("focusin", onFocus);
  };
}

/**
 * `use:navigationMenu` on a `<nav>` whose triggers carry `popovertarget`:
 * hovering a trigger opens its panel (clicks still toggle it), moving to
 * another trigger switches panels, and leaving trigger and panel closes it.
 * Panels are positioned under the nav.
 */
export function navigationMenu(el) {
  let timer = 0;
  let current = null;
  let stopPosition = null;
  const close = () => {
    stopPosition?.();
    stopPosition = null;
    if (current) hidePop(popOf(current));
    current = null;
  };
  const open = (t) => {
    clearTimeout(timer);
    if (current === t) return;
    close();
    const pop = popOf(t);
    if (!pop) return;
    current = t;
    showPop(pop);
    stopPosition = position(pop, { anchor: t, placement: "bottom-start", offset: 6 });
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(close, 250);
  };
  const onOver = (e) => {
    const t = e.target instanceof Element ? e.target.closest("[popovertarget]") : null;
    if (t && el.contains(t)) open(t);
    else if (current && popOf(current)?.contains(e.target)) clearTimeout(timer);
  };
  const onToggle = (e) => {
    if (e.newState === "closed" && current && e.target === popOf(current)) {
      stopPosition?.();
      stopPosition = null;
      current = null;
    } else if (e.newState === "open") {
      const t = [...el.querySelectorAll("[popovertarget]")].find((x) => popOf(x) === e.target);
      if (t && t !== current) {
        stopPosition?.();
        current = t;
        stopPosition = position(e.target, { anchor: t, placement: "bottom-start", offset: 6 });
      }
    }
  };
  el.addEventListener("pointerover", onOver);
  el.addEventListener("pointerleave", later);
  document.addEventListener("pointerover", onOver);
  document.addEventListener("toggle", onToggle, true);
  const panels = [...el.querySelectorAll("[popovertarget]")].map(popOf).filter(Boolean);
  for (const p of panels) p.addEventListener("pointerleave", later);
  return () => {
    clearTimeout(timer);
    close();
    el.removeEventListener("pointerover", onOver);
    el.removeEventListener("pointerleave", later);
    document.removeEventListener("pointerover", onOver);
    document.removeEventListener("toggle", onToggle, true);
    for (const p of panels) p.removeEventListener("pointerleave", later);
  };
}

// --- carousel ----------------------------------------------------------------

/**
 * `use:carousel` on a region holding a scroll-snapping
 * `[data-slot=carousel-content]` track of `[data-slot=carousel-item]`s and
 * `[data-carousel=prev|next]` buttons: the buttons and Left / Right (Up /
 * Down when `data-orientation="vertical"`) move one item; the buttons are
 * disabled at the ends. `weft:change` carries the first visible index.
 */
export function carousel(el) {
  const track = el.querySelector("[data-slot=carousel-content]");
  if (!track) return undefined;
  const vertical = el.dataset.orientation === "vertical";
  const items = () => [...track.querySelectorAll("[data-slot=carousel-item]")];
  const prev = el.querySelector("[data-carousel=prev]");
  const next = el.querySelector("[data-carousel=next]");
  let last = -1;
  const index = () => {
    const start = vertical ? track.scrollTop : track.scrollLeft;
    let best = 0;
    let dist = Infinity;
    for (const [i, it] of items().entries()) {
      const d = Math.abs((vertical ? it.offsetTop : it.offsetLeft) - (vertical ? track.offsetTop : track.offsetLeft) - start);
      if (d < dist) [best, dist] = [i, d];
    }
    return best;
  };
  const sync = () => {
    const max = vertical ? track.scrollHeight - track.clientHeight : track.scrollWidth - track.clientWidth;
    const at = vertical ? track.scrollTop : track.scrollLeft;
    if (prev) prev.disabled = at <= 1;
    if (next) next.disabled = at >= max - 1;
    const i = index();
    if (i !== last) {
      last = i;
      emit(el, i);
    }
  };
  const go = (step) => {
    const target = items()[Math.max(0, Math.min(items().length - 1, index() + step))];
    if (target) target.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
  };
  const onPrev = () => go(-1);
  const onNext = () => go(1);
  const onKey = (e) => {
    const back = vertical ? "ArrowUp" : "ArrowLeft";
    const fwd = vertical ? "ArrowDown" : "ArrowRight";
    if (e.key === back || e.key === fwd) {
      e.preventDefault();
      go(e.key === fwd ? 1 : -1);
    }
  };
  own(el, "data-orientation");
  prev?.addEventListener("click", onPrev);
  next?.addEventListener("click", onNext);
  el.addEventListener("keydown", onKey);
  track.addEventListener("scroll", sync, { passive: true });
  addEventListener("resize", sync);
  sync();
  return () => {
    prev?.removeEventListener("click", onPrev);
    next?.removeEventListener("click", onNext);
    el.removeEventListener("keydown", onKey);
    track.removeEventListener("scroll", sync);
    removeEventListener("resize", sync);
  };
}

// --- resizable panels --------------------------------------------------------

/**
 * `use:resizable` on a flex group of `[data-slot=resizable-panel]`s with a
 * `[data-slot=resizable-handle]` between each pair (`role="separator"`,
 * `tabindex="0"`): dragging a handle, or arrowing on it (Home / End for the
 * limits), moves space between its two neighbours. Panels take their start
 * size from `data-size` (percent) and their limits from `data-min-size` /
 * `data-max-size`. `data-direction="vertical"` stacks them.
 */
export function resizable(el) {
  const vertical = el.dataset.direction === "vertical";
  const panels = () => [...el.children].filter((c) => c.dataset.slot === "resizable-panel");
  const sizes = new Map();
  const ps = panels();
  const given = ps.reduce((s, p) => s + (Number(p.dataset.size) || 0), 0);
  const unsized = ps.filter((p) => !Number(p.dataset.size)).length;
  for (const p of ps) {
    const size = Number(p.dataset.size) || (unsized ? Math.max(0, 100 - given) / unsized : 100 / ps.length);
    sizes.set(p, size);
  }
  const apply = () => {
    for (const [p, s] of sizes) p.style.flex = `${s} 1 0px`;
    for (const h of el.querySelectorAll(":scope > [data-slot=resizable-handle]")) {
      const before = h.previousElementSibling;
      if (sizes.has(before)) h.setAttribute("aria-valuenow", String(Math.round(sizes.get(before))));
    }
  };
  const limit = (p, s) => Math.max(Number(p.dataset.minSize) || 0, Math.min(Number(p.dataset.maxSize) || 100, s));
  const shift = (h, delta) => {
    const a = h.previousElementSibling;
    const b = h.nextElementSibling;
    if (!sizes.has(a) || !sizes.has(b)) return;
    const total = sizes.get(a) + sizes.get(b);
    const na = Math.min(limit(a, sizes.get(a) + delta), total - (Number(b.dataset.minSize) || 0));
    const nb = limit(b, total - na);
    sizes.set(a, total - nb);
    sizes.set(b, nb);
    apply();
  };
  const handles = [...el.querySelectorAll(":scope > [data-slot=resizable-handle]")];
  for (const h of handles) {
    h.setAttribute("role", "separator");
    h.setAttribute("aria-orientation", vertical ? "horizontal" : "vertical");
    h.setAttribute("aria-valuemin", "0");
    h.setAttribute("aria-valuemax", "100");
    if (!h.hasAttribute("tabindex")) h.tabIndex = 0;
    own(h, "aria-valuenow");
  }
  let drag = null;
  const onDown = (e) => {
    const h = e.target instanceof Element ? e.target.closest("[data-slot=resizable-handle]") : null;
    if (!h || h.parentElement !== el) return;
    e.preventDefault();
    h.setPointerCapture?.(e.pointerId);
    drag = { h, at: vertical ? e.clientY : e.clientX };
    h.dataset.dragging = "";
  };
  const onMove = (e) => {
    if (!drag) return;
    const r = el.getBoundingClientRect();
    const now = vertical ? e.clientY : e.clientX;
    const px = vertical ? r.height : r.width;
    if (px > 0) shift(drag.h, ((now - drag.at) / px) * 100);
    drag.at = now;
  };
  const onUp = () => {
    if (drag) delete drag.h.dataset.dragging;
    drag = null;
  };
  const onKey = (e) => {
    const h = e.target;
    if (!handles.includes(h)) return;
    const back = vertical ? "ArrowUp" : "ArrowLeft";
    const fwd = vertical ? "ArrowDown" : "ArrowRight";
    const step = e.shiftKey ? 10 : 2;
    if (e.key === back) shift(h, -step);
    else if (e.key === fwd) shift(h, step);
    else if (e.key === "Home") shift(h, -100);
    else if (e.key === "End") shift(h, 100);
    else return;
    e.preventDefault();
  };
  apply();
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("keydown", onKey);
  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.removeEventListener("keydown", onKey);
  };
}

// --- select --------------------------------------------------------------------

/**
 * `use:select` on a wrapper holding a trigger button (`popovertarget` → a
 * `popover` `role="listbox"`), `[data-slot=select-value]` inside the
 * trigger, `role="option"` items with `data-value`, and a hidden
 * `<input name>`: picking an option (click, Enter, Space) sets the input,
 * shows the option's text in the trigger, marks it `aria-selected`, closes
 * the list and dispatches `weft:change` (detail: the value). Arrows, Home /
 * End and typeahead move in the open list; the list opens on the selected
 * option. Typing on the closed trigger opens it.
 */
export function select(el) {
  const trigger = el.querySelector("[popovertarget]");
  const list = trigger ? popOf(trigger) : null;
  if (!trigger || !list) return undefined;
  const field = el.querySelector("input[type=hidden]");
  const label = trigger.querySelector("[data-slot=select-value]");
  const placeholder = label?.textContent ?? "";
  const options = () => [...list.querySelectorAll("[role=option]")];
  trigger.setAttribute("aria-haspopup", "listbox");
  if (!list.id) list.id = `weft-select-${(selectSeq += 1)}`;
  trigger.setAttribute("aria-controls", list.id);
  own(trigger, "aria-expanded");
  const pick = (opt, notify) => {
    for (const o of options()) {
      own(o, "aria-selected", "data-state");
      const on = o === opt;
      o.setAttribute("aria-selected", String(on));
      o.dataset.state = on ? "checked" : "unchecked";
    }
    const value = opt?.dataset.value ?? "";
    if (field) field.value = value;
    if (label) {
      label.textContent = opt ? (opt.dataset.label ?? opt.textContent.trim()) : placeholder;
      label.dataset.placeholder = opt ? "false" : "true";
      own(label, "data-placeholder");
    }
    if (notify) emit(el, value);
  };
  const start = options().find((o) => o.getAttribute("aria-selected") === "true") ?? options().find((o) => field && o.dataset.value === field.value && field.value !== "");
  pick(start ?? null, false);
  const onToggle = (e) => {
    const open = e.newState === "open";
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      const sel = options().find((o) => o.getAttribute("aria-selected") === "true") ?? options().find((o) => !disabled(o));
      requestAnimationFrame(() => sel?.focus());
    } else if (!document.activeElement || document.activeElement === document.body || list.contains(document.activeElement)) {
      trigger.focus();
    }
  };
  const onClick = (e) => {
    const o = e.target instanceof Element ? e.target.closest("[role=option]") : null;
    if (!o || disabled(o)) return;
    pick(o, true);
    hidePop(list);
  };
  const onKey = (e) => {
    const o = e.target instanceof Element ? e.target.closest("[role=option]") : null;
    if (o && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      o.click();
    } else if (e.key === "Tab") {
      hidePop(list);
    }
  };
  const onTriggerKey = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      showPop(list);
    }
  };
  for (const o of options()) if (!o.hasAttribute("tabindex")) o.tabIndex = -1;
  trigger.setAttribute("aria-expanded", "false");
  list.addEventListener("toggle", onToggle);
  list.addEventListener("click", onClick);
  list.addEventListener("keydown", onKey);
  trigger.addEventListener("keydown", onTriggerKey);
  const stopRoving = roving(list, { orientation: "vertical", items: "[role=option]", loop: false });
  const stopPosition = position(list, { anchor: trigger, placement: "bottom-start", offset: 4 });
  return () => {
    list.removeEventListener("toggle", onToggle);
    list.removeEventListener("click", onClick);
    list.removeEventListener("keydown", onKey);
    trigger.removeEventListener("keydown", onTriggerKey);
    stopRoving();
    stopPosition?.();
  };
}
let selectSeq = 0;

// --- one-time code -------------------------------------------------------------

/**
 * `use:inputOtp` on a wrapper holding one real `<input maxlength>` (laid
 * over the boxes, transparent) and `[data-slot=input-otp-slot]` boxes:
 * the boxes show the typed characters, `data-active` marks the box the
 * caret is in, and `data-complete` is set on the wrapper when every box is
 * filled (`weft:change` then carries the code). The input keeps paste,
 * autofill (`autocomplete="one-time-code"`) and screen readers working.
 */
export function inputOtp(el) {
  const input = el.querySelector("input");
  if (!input) return undefined;
  const slots = () => [...el.querySelectorAll("[data-slot=input-otp-slot]")];
  const pattern = input.dataset.pattern ? new RegExp(input.dataset.pattern) : null;
  const sync = () => {
    const all = slots();
    let v = input.value;
    if (pattern) v = [...v].filter((c) => pattern.test(c)).join("");
    v = v.slice(0, all.length);
    if (v !== input.value) input.value = v;
    const focused = document.activeElement === input;
    const caret = Math.min(input.selectionStart ?? v.length, all.length - 1);
    for (const [i, s] of all.entries()) {
      own(s, "data-active", "data-filled");
      const ch = s.querySelector("[data-slot=input-otp-char]") ?? s;
      ch.textContent = v[i] ?? "";
      s.toggleAttribute("data-filled", i < v.length);
      s.toggleAttribute("data-active", focused && i === caret);
    }
    const done = v.length === all.length;
    own(el, "data-complete");
    if (done && !el.hasAttribute("data-complete")) emit(el, v);
    el.toggleAttribute("data-complete", done);
  };
  const events = ["input", "focus", "blur", "keyup", "select", "click"];
  for (const ev of events) input.addEventListener(ev, sync);
  document.addEventListener("selectionchange", sync);
  sync();
  return () => {
    for (const ev of events) input.removeEventListener(ev, sync);
    document.removeEventListener("selectionchange", sync);
  };
}

// --- calendar ------------------------------------------------------------------

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromIso = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

/**
 * `use:calendar` on an element holding a hidden `<input name>` (its value
 * an ISO date, the selection) and `[data-slot=calendar-grid]`: builds an
 * accessible month grid (`role="grid"`, one Tab stop; arrows move by day /
 * week, Page Up / Down by month, Home / End to the week's ends), with
 * `[data-calendar=prev|next]` buttons and a `[data-slot=calendar-caption]`.
 * `data-min` / `data-max` (ISO) limit it, `data-locale` names the locale
 * (default: the page's `lang`), `data-week-start` the first weekday (0-6,
 * default 1, Monday). Picking a day sets the input and dispatches
 * `weft:change` (detail: the ISO date). Classes for the generated buttons
 * come from `data-day-class` and `data-weekday-class`.
 */
export function calendar(el) {
  const field = el.querySelector("input[type=hidden]");
  const grid = el.querySelector("[data-slot=calendar-grid]");
  const caption = el.querySelector("[data-slot=calendar-caption]");
  if (!grid) return undefined;
  const locale = el.dataset.locale || document.documentElement.lang || undefined;
  const weekStart = Number(el.dataset.weekStart ?? 1) % 7;
  const min = fromIso(el.dataset.min);
  const max = fromIso(el.dataset.max);
  const today = new Date();
  let selected = fromIso(field?.value);
  let focus = selected ?? new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let view = new Date(focus.getFullYear(), focus.getMonth(), 1);
  const outside = (d) => (min && d < min) || (max && d > max);
  const render = (moveFocus) => {
    if (caption) caption.textContent = view.toLocaleDateString(locale, { month: "long", year: "numeric" });
    grid.setAttribute("role", "grid");
    if (caption?.id) grid.setAttribute("aria-labelledby", caption.id);
    grid.replaceChildren();
    const head = document.createElement("div");
    head.setAttribute("role", "row");
    head.className = el.dataset.headClass ?? "";
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(2024, 0, 1 + ((weekStart + i + 6) % 7)); // 2024-01-01 is a Monday
      const th = document.createElement("div");
      th.setAttribute("role", "columnheader");
      th.setAttribute("aria-label", d.toLocaleDateString(locale, { weekday: "long" }));
      th.className = el.dataset.weekdayClass ?? "";
      th.textContent = d.toLocaleDateString(locale, { weekday: "narrow" });
      head.append(th);
    }
    grid.append(head);
    const first = new Date(view);
    first.setDate(1 - ((first.getDay() - weekStart + 7) % 7));
    let target = null;
    for (let w = 0; w < 6; w += 1) {
      const row = document.createElement("div");
      row.setAttribute("role", "row");
      row.className = el.dataset.rowClass ?? "";
      for (let i = 0; i < 7; i += 1) {
        const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + w * 7 + i);
        const cell = document.createElement("div");
        cell.setAttribute("role", "gridcell");
        const b = document.createElement("button");
        b.type = "button";
        b.className = el.dataset.dayClass ?? "";
        b.textContent = String(d.getDate());
        b.dataset.date = iso(d);
        b.setAttribute("aria-label", d.toLocaleDateString(locale, { dateStyle: "full" }));
        b.tabIndex = iso(d) === iso(focus) ? 0 : -1;
        if (d.getMonth() !== view.getMonth()) b.dataset.outside = "";
        if (iso(d) === iso(today)) b.dataset.today = "";
        if (selected && iso(d) === iso(selected)) {
          b.dataset.selected = "";
          cell.setAttribute("aria-selected", "true");
        }
        if (outside(d)) b.disabled = true;
        if (iso(d) === iso(focus)) target = b;
        cell.append(b);
        row.append(cell);
      }
      grid.append(row);
    }
    if (moveFocus) target?.focus();
  };
  const moveTo = (d) => {
    if (outside(d)) return;
    focus = d;
    if (d.getMonth() !== view.getMonth() || d.getFullYear() !== view.getFullYear()) view = new Date(d.getFullYear(), d.getMonth(), 1);
    render(true);
  };
  const shiftMonth = (n) => {
    view = new Date(view.getFullYear(), view.getMonth() + n, 1);
    const day = Math.min(focus.getDate(), new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate());
    focus = new Date(view.getFullYear(), view.getMonth(), day);
    render(false);
  };
  const onClick = (e) => {
    const nav = e.target instanceof Element ? e.target.closest("[data-calendar]") : null;
    if (nav && el.contains(nav)) {
      shiftMonth(nav.dataset.calendar === "prev" ? -1 : 1);
      return;
    }
    const b = e.target instanceof Element ? e.target.closest("button[data-date]") : null;
    if (!b || b.disabled) return;
    selected = fromIso(b.dataset.date);
    focus = selected;
    view = new Date(selected.getFullYear(), selected.getMonth(), 1);
    if (field) field.value = b.dataset.date;
    render(true);
    emit(el, b.dataset.date);
    const out = el.dataset.output ? document.getElementById(el.dataset.output) : null;
    if (out) {
      out.textContent = selected.toLocaleDateString(locale, { dateStyle: el.dataset.dateStyle ?? "long" });
      out.removeAttribute("data-placeholder");
    }
    const pop = el.closest("[popover]");
    if (pop) hidePop(pop);
  };
  const onKey = (e) => {
    if (!(e.target instanceof Element) || !e.target.closest("button[data-date]")) return;
    const d = new Date(focus);
    const k = e.key;
    if (k === "ArrowLeft") d.setDate(d.getDate() - 1);
    else if (k === "ArrowRight") d.setDate(d.getDate() + 1);
    else if (k === "ArrowUp") d.setDate(d.getDate() - 7);
    else if (k === "ArrowDown") d.setDate(d.getDate() + 7);
    else if (k === "PageUp") d.setMonth(d.getMonth() - (e.shiftKey ? 12 : 1));
    else if (k === "PageDown") d.setMonth(d.getMonth() + (e.shiftKey ? 12 : 1));
    else if (k === "Home") d.setDate(d.getDate() - ((d.getDay() - weekStart + 7) % 7));
    else if (k === "End") d.setDate(d.getDate() + 6 - ((d.getDay() - weekStart + 7) % 7));
    else return;
    e.preventDefault();
    moveTo(d);
  };
  own(grid, "role", "aria-labelledby");
  grid.setAttribute("data-weft-ignore", "");
  render(false);
  el.addEventListener("click", onClick);
  el.addEventListener("keydown", onKey);
  return () => {
    el.removeEventListener("click", onClick);
    el.removeEventListener("keydown", onKey);
  };
}

// --- sidebar -------------------------------------------------------------------

/**
 * `use:sidebar` on the sidebar's wrapper: buttons with
 * `data-sidebar-trigger` (anywhere on the page) and Ctrl/Cmd+B toggle
 * `data-state` between "expanded" and "collapsed" on it, remembered in a
 * `sidebar_state` cookie so the server renders it the same next time.
 * Below 768px wide the toggle opens it as an overlay instead
 * (`data-mobile="open"`), closed again by Escape or a press outside.
 */
export function sidebar(el) {
  own(el, "data-state", "data-mobile");
  const mobile = () => matchMedia("(max-width: 767px)").matches;
  let stopLayer = null;
  const set = (expanded) => {
    el.dataset.state = expanded ? "expanded" : "collapsed";
    document.cookie = `sidebar_state=${expanded}; path=/; max-age=${60 * 60 * 24 * 7}; SameSite=Lax`;
    for (const t of document.querySelectorAll("[data-sidebar-trigger]")) t.setAttribute("aria-expanded", String(expanded));
  };
  const setMobile = (open) => {
    el.dataset.mobile = open ? "open" : "closed";
    stopLayer?.();
    stopLayer = open ? pushLayer({ el, dismiss: () => setMobile(false), inside: (t) => t instanceof Element && t.closest("[data-sidebar-trigger]") !== null }) : null;
  };
  const flip = () => {
    if (mobile()) setMobile(el.dataset.mobile !== "open");
    else set(el.dataset.state === "collapsed");
  };
  const onClick = (e) => {
    const t = e.target instanceof Element ? e.target.closest("[data-sidebar-trigger]") : null;
    if (t) flip();
  };
  const onKey = (e) => {
    if (e.key.toLowerCase() === "b" && (e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault();
      flip();
    }
  };
  if (!el.dataset.state) el.dataset.state = "expanded";
  document.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  return () => {
    stopLayer?.();
    document.removeEventListener("click", onClick);
    document.removeEventListener("keydown", onKey);
  };
}

// --- rich text --------------------------------------------------------------

/** `href` as a link the editor may create: http(s), mailto, or a path on
 * this site. Anything else (javascript:, data:, //host) is refused. */
export function safeHref(href) {
  const h = String(href ?? "").trim();
  if (h === "" || h.length > 2000 || h.startsWith("//")) return null;
  if (h.startsWith("/")) return h.includes("\\") ? null : h;
  if (/^mailto:[^\s<>]+@[^\s<>]+$/i.test(h)) return h;
  try {
    const u = new URL(h.includes("://") ? h : "https://" + h);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The mention being typed just before the caret: the text after an `@`
 * that starts the text or follows a space or opening bracket or quote, up
 * to 32 characters with no spaces. Null when the caret is not in one.
 */
export function mentionQuery(before) {
  const m = /(?:^|[\s(\[{"'])@([^\s@]{0,32})$/u.exec(String(before));
  return m ? m[1] : null;
}

const fold = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Whether a candidate called `label` fits `query`: case- and accent-blind,
 * at the start of the label or of any word in it. */
export function mentionMatches(query, label) {
  const q = fold(query);
  if (q === "") return true;
  const l = fold(label);
  return l.startsWith(q) || l.split(/[\s._-]+/).some((w) => w.startsWith(q));
}

/** The ids `fromDom` and `parseRichText` accept for a mention. */
const MENTION_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

const RICH_BLOCKS = { h2: "h2", h3: "h3", p: "p", quote: "blockquote" };
const RICH_MARKS = { bold: "bold", italic: "italic", underline: "underline", strike: "strikeThrough" };

/**
 * `use:richText` on an editor: a `[data-rich-surface]` contenteditable and
 * buttons `[data-rich-command]`. Commands go through the browser's editing
 * commands, so undo (Ctrl/Cmd+Z) keeps working; each button's
 * `aria-pressed` follows the selection. `link` (or Ctrl/Cmd+K) shows the
 * `[data-rich-link]` input: Enter applies the address if `safeHref` allows
 * it, Escape goes back to the text. Pasted content arrives as plain text,
 * so no markup or styles come in from other pages. Read the result with
 * `fromDom` (@weft/runtime) and check it on the server with
 * `parseRichText`: the browser is never trusted with the document.
 *
 * Mentions: put a `[data-rich-mentions]` list in the editor holding one
 * `[data-mention-option]` element per person the app lets this actor
 * mention, each with `data-id` and `data-label` (markup and styles are the
 * app's). Typing `@` opens the list, filtered as the name is typed (see
 * `mentionMatches`); Up/Down choose, Enter or Tab inserts, Escape closes.
 * The list never fetches anyone: it offers only the people the page
 * rendered, and the server still checks the ids from `mentionsIn` before
 * it notifies or links anyone.
 */
export function richText(el) {
  const surface = el.querySelector("[data-rich-surface]");
  if (!surface) return () => {};
  const picker = el.querySelector("[data-rich-mentions]");
  let pick = null;
  const linkBox = el.querySelector("[data-rich-link]");
  const linkInput = linkBox ? (linkBox.matches("input") ? linkBox : linkBox.querySelector("input")) : null;
  const buttons = () => [...el.querySelectorAll("[data-rich-command]")];
  let saved = null;

  const inside = (node) => node !== null && (node === surface || surface.contains(node));
  const selection = () => {
    const s = document.getSelection();
    return s && s.rangeCount > 0 && inside(s.anchorNode) ? s : null;
  };
  const closest = (tag) => {
    const s = selection();
    let n = s ? s.anchorNode : null;
    while (n && n !== surface) {
      if (n.nodeType === 1 && n.nodeName === tag) return n;
      n = n.parentNode;
    }
    return null;
  };
  const changed = () => surface.dispatchEvent(new Event("input", { bubbles: true }));

  const state = (cmd) => {
    try {
      if (cmd in RICH_MARKS) return document.queryCommandState(RICH_MARKS[cmd]);
      if (cmd === "ul") return closest("UL") !== null;
      if (cmd === "ol") return closest("OL") !== null;
      if (cmd === "code") return closest("CODE") !== null;
      if (cmd === "link") return closest("A") !== null;
      if (cmd in RICH_BLOCKS) {
        const v = String(document.queryCommandValue("formatBlock")).toLowerCase().replace(/[<>]/g, "");
        return v === RICH_BLOCKS[cmd];
      }
    } catch {
      // queryCommand* can throw outside an editable selection.
    }
    return false;
  };
  const sync = () => {
    if (!selection()) return;
    for (const b of buttons()) {
      const cmd = b.dataset.richCommand;
      if (cmd === "clear" || cmd === "unlink") continue;
      b.setAttribute("aria-pressed", String(state(cmd)));
    }
  };

  const toggleCode = () => {
    const s = selection();
    if (!s) return;
    const code = closest("CODE");
    if (code) {
      const parent = code.parentNode;
      while (code.firstChild) parent.insertBefore(code.firstChild, code);
      parent.removeChild(code);
    } else {
      const range = s.getRangeAt(0);
      if (range.collapsed) return;
      const c = document.createElement("code");
      c.appendChild(range.extractContents());
      range.insertNode(c);
      s.removeAllRanges();
      const r = document.createRange();
      r.selectNodeContents(c);
      s.addRange(r);
    }
    changed();
  };

  const showLink = () => {
    const s = selection();
    if (!s || !linkBox || !linkInput) return;
    saved = s.getRangeAt(0).cloneRange();
    const a = closest("A");
    linkInput.value = a ? a.getAttribute("href") ?? "" : "";
    linkBox.hidden = false;
    linkInput.removeAttribute("aria-invalid");
    linkInput.focus();
    linkInput.select();
  };
  const hideLink = (restore) => {
    if (!linkBox) return;
    linkBox.hidden = true;
    surface.focus();
    if (restore && saved) {
      const s = document.getSelection();
      s.removeAllRanges();
      s.addRange(saved);
    }
  };
  const applyLink = () => {
    const raw = linkInput.value.trim();
    if (raw === "") {
      hideLink(true);
      document.execCommand("unlink");
      changed();
      return;
    }
    const href = safeHref(raw);
    if (!href) {
      linkInput.setAttribute("aria-invalid", "true");
      return;
    }
    hideLink(true);
    if (saved && saved.collapsed) document.execCommand("insertText", false, raw);
    document.execCommand("createLink", false, href);
    changed();
  };

  const options = () => (picker ? [...picker.querySelectorAll("[data-mention-option]")] : []);
  const shownOptions = () => options().filter((o) => !o.hidden);
  const chosen = () => shownOptions().find((o) => o.getAttribute("aria-selected") === "true") ?? null;
  const choose = (o) => {
    for (const x of options()) x.setAttribute("aria-selected", String(x === o));
    if (o) {
      surface.setAttribute("aria-activedescendant", o.id);
      o.scrollIntoView?.({ block: "nearest" });
    } else surface.removeAttribute("aria-activedescendant");
  };
  const hidePicker = () => {
    if (!picker) return;
    picker.hidden = true;
    surface.setAttribute("aria-expanded", "false");
    choose(null);
  };
  const closePicker = () => {
    pick = null;
    hidePicker();
  };
  // Open, filter or close the list from the text just before the caret.
  const updatePicker = () => {
    if (!picker) return;
    const s = selection();
    if (!s || !s.isCollapsed || s.anchorNode.nodeType !== 3 || closest("CODE") || closest("A")) return closePicker();
    const node = s.anchorNode;
    const end = s.anchorOffset;
    const q = mentionQuery(node.data.slice(0, end));
    if (q === null) return closePicker();
    pick = { node, start: end - q.length - 1, end };
    let first = null;
    for (const o of options()) {
      const fits = mentionMatches(q, o.dataset.label ?? o.textContent ?? "");
      o.hidden = !fits;
      if (fits && first === null) first = o;
    }
    if (first === null) return hidePicker();
    picker.hidden = false;
    surface.setAttribute("aria-expanded", "true");
    choose(chosen() ?? first);
  };
  // Replace the typed `@name` with a mention of `o`, then a space.
  const insertMention = (o) => {
    const id = o.dataset.id ?? "";
    const label = (o.dataset.label ?? o.textContent ?? "").trim().slice(0, 200);
    const at = pick;
    closePicker();
    if (!at || !MENTION_ID.test(id) || label === "" || !inside(at.node) || at.end > at.node.length) return;
    const range = document.createRange();
    range.setStart(at.node, at.start);
    range.setEnd(at.node, at.end);
    range.deleteContents();
    const span = document.createElement("span");
    span.setAttribute("data-mention", id);
    span.setAttribute("data-label", label);
    span.setAttribute("contenteditable", "false");
    span.textContent = "@" + label;
    const space = document.createTextNode(" ");
    range.insertNode(space);
    range.insertNode(span);
    const s = document.getSelection();
    const caret = document.createRange();
    caret.setStart(space, 1);
    caret.collapse(true);
    s.removeAllRanges();
    s.addRange(caret);
    surface.focus();
    changed();
  };
  // Picker keys come first while the list is open; true when handled.
  const pickerKey = (e) => {
    if (!picker || picker.hidden || e.altKey || e.metaKey || e.ctrlKey) return false;
    const list = shownOptions();
    const i = list.indexOf(chosen());
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      choose(list[(i + step + list.length) % list.length]);
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (i < 0) return false;
      insertMention(list[i]);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      hidePicker();
    } else return false;
    e.preventDefault();
    return true;
  };
  const onPickerDown = (e) => e.preventDefault();
  const onPickerClick = (e) => {
    const o = e.target instanceof Element ? e.target.closest("[data-mention-option]") : null;
    if (o && picker.contains(o) && !o.hidden) insertMention(o);
  };
  const onPickerKeyup = (e) => {
    // Moving through the list must not refilter it.
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Escape") updatePicker();
  };

  const run = (cmd) => {
    surface.focus();
    if (cmd in RICH_MARKS) document.execCommand(RICH_MARKS[cmd]);
    else if (cmd in RICH_BLOCKS) document.execCommand("formatBlock", false, state(cmd) && cmd !== "p" ? "p" : RICH_BLOCKS[cmd]);
    else if (cmd === "ul") document.execCommand("insertUnorderedList");
    else if (cmd === "ol") document.execCommand("insertOrderedList");
    else if (cmd === "code") return toggleCode();
    else if (cmd === "link") return showLink();
    else if (cmd === "unlink") document.execCommand("unlink");
    else if (cmd === "clear") {
      document.execCommand("removeFormat");
      document.execCommand("unlink");
    } else return;
    sync();
  };

  const onClick = (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-rich-command]") : null;
    if (!b || !el.contains(b) || disabled(b)) return;
    e.preventDefault();
    run(b.dataset.richCommand);
  };
  // Keep the selection in the text while a toolbar button is pressed.
  const onDown = (e) => {
    if (e.target instanceof Element && e.target.closest("[data-rich-command]")) e.preventDefault();
  };
  const onKey = (e) => {
    if (pickerKey(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "k") {
      e.preventDefault();
      showLink();
    } else if (e.shiftKey && (k === "7" || k === "&")) {
      e.preventDefault();
      run("ol");
    } else if (e.shiftKey && (k === "8" || k === "*")) {
      e.preventDefault();
      run("ul");
    } else if (k === "e") {
      e.preventDefault();
      run("code");
    }
  };
  const onPaste = (e) => {
    const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    e.preventDefault();
    if (text) document.execCommand("insertText", false, text);
  };
  const onDrop = (e) => {
    // Dropped HTML would bring its markup with it.
    e.preventDefault();
  };
  const onLinkKey = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyLink();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hideLink(true);
    }
  };

  try {
    document.execCommand("defaultParagraphSeparator", false, "p");
  } catch {
    // Older engines: paragraphs come out as <div>, which fromDom reads too.
  }
  if (linkBox) linkBox.hidden = true;
  surface.setAttribute("role", surface.getAttribute("role") ?? "textbox");
  surface.setAttribute("aria-multiline", "true");
  el.addEventListener("click", onClick);
  el.addEventListener("mousedown", onDown);
  surface.addEventListener("keydown", onKey);
  surface.addEventListener("paste", onPaste);
  surface.addEventListener("drop", onDrop);
  surface.addEventListener("keyup", sync);
  surface.addEventListener("mouseup", sync);
  linkInput?.addEventListener("keydown", onLinkKey);
  document.addEventListener("selectionchange", sync);
  if (picker) {
    if (!picker.id) picker.id = (surface.id || "rich") + "-mentions";
    picker.setAttribute("role", picker.getAttribute("role") ?? "listbox");
    options().forEach((o, i) => {
      if (!o.id) o.id = picker.id + "-" + i;
      o.setAttribute("role", o.getAttribute("role") ?? "option");
    });
    surface.setAttribute("aria-controls", picker.id);
    surface.setAttribute("aria-autocomplete", "list");
    hidePicker();
    surface.addEventListener("keyup", onPickerKeyup);
    surface.addEventListener("mouseup", updatePicker);
    surface.addEventListener("input", updatePicker);
    surface.addEventListener("blur", closePicker);
    picker.addEventListener("mousedown", onPickerDown);
    picker.addEventListener("click", onPickerClick);
  }
  return () => {
    if (picker) {
      surface.removeEventListener("keyup", onPickerKeyup);
      surface.removeEventListener("mouseup", updatePicker);
      surface.removeEventListener("input", updatePicker);
      surface.removeEventListener("blur", closePicker);
      picker.removeEventListener("mousedown", onPickerDown);
      picker.removeEventListener("click", onPickerClick);
    }
    el.removeEventListener("click", onClick);
    el.removeEventListener("mousedown", onDown);
    surface.removeEventListener("keydown", onKey);
    surface.removeEventListener("paste", onPaste);
    surface.removeEventListener("drop", onDrop);
    surface.removeEventListener("keyup", sync);
    surface.removeEventListener("mouseup", sync);
    linkInput?.removeEventListener("keydown", onLinkKey);
    document.removeEventListener("selectionchange", sync);
  };
}
