export const DEV_PANEL_JS = `
const PANEL = "weft-dev-panel";
const INK = "#1a1a1a", MUTED = "#6b6b6b", RULE = "#d4d4d4", BG = "#fbfbf9", WARN = "#b00020", OK = "#1d6b3a";
let panel = null, view = "tree", timer = null, last = null, viewForm = null, viewNote = "";
// Time travel: the step shown in place of the page (null: live).
let shown = null, shownBox = null, shownRoot = null, shownLid = "", shownNote = "";

function el(tag, props, text) {
  const n = css(document.createElement(tag), props || {});
  if (text !== undefined) n.textContent = text;
  return n;
}
function lid() {
  return document.querySelector('meta[name="weft-live"]')?.getAttribute("content") || "";
}

let toggle = null;
if (typeof document.querySelector === "function" && document.body) installPanel();
function installPanel() {
toggle = el("button", {
  position: "fixed", right: "8px", bottom: "8px", "z-index": "2147483646",
  font: "11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  background: BG, color: MUTED, border: "1px solid " + RULE, padding: "4px 6px", cursor: "pointer", opacity: "0.8",
}, "weft");
toggle.type = "button";
toggle.title = "Weft dev overlay (Alt+Shift+D)";
toggle.setAttribute("aria-expanded", "false");
toggle.addEventListener("click", () => (panel ? closePanel() : openPanel()));
document.body.append(toggle);
document.addEventListener("keydown", (e) => {
  if (e.altKey && e.shiftKey && (e.key === "D" || e.key === "d" || e.code === "KeyD")) {
    e.preventDefault();
    panel ? closePanel() : openPanel();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!panel) return;
  if (document.visibilityState === "hidden") stop(); else poll();
});
}

function openPanel() {
  panel = el("section", {
    position: "fixed", left: "0", right: "0", bottom: "0", height: "38vh", "z-index": "2147483646",
    display: "flex", "flex-direction": "column", background: BG, color: INK, "border-top": "1px solid " + RULE,
    font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  });
  panel.id = PANEL;
  panel.setAttribute("aria-label", "Weft dev overlay");
  const bar = el("div", { display: "flex", gap: "16px", "align-items": "baseline", padding: "6px 12px", "border-bottom": "1px solid " + RULE });
  bar.append(el("strong", {}, "weft dev"));
  for (const [key, label] of [["tree", "Tree"], ["messages", "Messages"], ["data", "Data"], ["access", "Access"], ["time", "Time"], ["viewas", "View as"]]) {
    const b = el("button", { font: "inherit", background: "none", border: "0", padding: "0", cursor: "pointer", color: MUTED }, label);
    b.type = "button";
    b.dataset.view = key;
    b.addEventListener("click", () => { view = key; draw(); });
    bar.append(b);
  }
  const status = el("span", { "margin-left": "auto", color: MUTED });
  status.dataset.role = "status";
  const close = el("button", { font: "inherit", background: "none", border: "1px solid " + RULE, padding: "0 8px", cursor: "pointer" }, "Close");
  close.type = "button";
  close.addEventListener("click", closePanel);
  bar.append(status, close);
  const body = el("div", { flex: "1", overflow: "auto", padding: "8px 12px" });
  body.dataset.role = "body";
  panel.append(bar, body);
  document.body.append(panel);
  toggle.setAttribute("aria-expanded", "true");
  toggle.style.setProperty("display", "none");
  poll();
}

function closePanel() {
  stop();
  live();
  panel?.remove();
  panel = null;
  toggle.setAttribute("aria-expanded", "false");
  toggle.style.removeProperty("display");
  toggle.focus();
}

function stop() {
  clearTimeout(timer);
  timer = null;
}

async function poll() {
  stop();
  if (!panel) return;
  const id = lid();
  // Another page now (client navigation): its own states, from live.
  if (shown !== null && (id !== shownLid || !document.contains(shownRoot))) live();
  if (!id) {
    last = null;
    draw("This page is inert: it sends no live page, so there is nothing to inspect.");
    return;
  }
  try {
    const res = await fetch("/_weft/dev/inspect?lid=" + encodeURIComponent(id), { credentials: "same-origin", cache: "no-store" });
    if (res.ok) { last = await res.json(); draw(); }
    else { last = null; draw(res.status === 404 ? "The live page expired or belongs to another session." : "Inspect failed: HTTP " + res.status); }
  } catch {
    last = null;
    draw("The dev server is not answering.");
  }
  if (panel) timer = setTimeout(poll, 1000);
}

function table(head, rows) {
  const t = el("table", { "border-collapse": "collapse", width: "100%" });
  const tr = el("tr", {});
  for (const h of head) tr.append(el("th", { "text-align": "left", color: MUTED, "font-weight": "normal", "border-bottom": "1px solid " + RULE, padding: "2px 12px 2px 0" }, h));
  t.append(tr);
  for (const row of rows) {
    const r = el("tr", {});
    for (const cell of row) {
      const td = el("td", { padding: "2px 12px 2px 0", "vertical-align": "top", "border-bottom": "1px solid #ececea" });
      if (cell && typeof cell === "object") { td.textContent = cell.text; css(td, { color: cell.color }); }
      else td.textContent = String(cell);
      r.append(td);
    }
    t.append(r);
  }
  return t;
}
function empty(text) {
  return el("p", { color: MUTED, margin: "0" }, text);
}
function clock(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

// The "View as" form, built once so a refresh keeps what is typed in it.
function viewAsForm() {
  if (viewForm) return viewForm;
  viewForm = el("form", { display: "flex", "flex-wrap": "wrap", gap: "8px", "align-items": "baseline", margin: "0 0 8px" });
  const field = (label, name) => {
    const l = el("label", { display: "flex", gap: "4px", "align-items": "baseline" }, label);
    const i = el("input", { font: "inherit", border: "1px solid " + RULE, padding: "1px 4px", background: "#fff", color: INK });
    i.name = name;
    i.autocomplete = "off";
    i.spellcheck = false;
    l.append(i);
    return l;
  };
  const go = el("button", { font: "inherit", border: "1px solid " + RULE, background: "#fff", padding: "0 8px", cursor: "pointer" }, "View as");
  go.type = "submit";
  const back = el("button", { font: "inherit", border: "1px solid " + RULE, background: "#fff", padding: "0 8px", cursor: "pointer" }, "Back to me");
  back.type = "button";
  back.dataset.role = "stop";
  const said = el("p", { margin: "0", width: "100%", color: MUTED });
  said.dataset.role = "viewing";
  viewForm.append(field("User id", "user"), field("Tenant (optional)", "tenant"), go, back, said);
  viewForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const user = viewForm.elements.user.value.trim();
    const tenant = viewForm.elements.tenant.value.trim();
    sendViewAs(tenant ? { user, tenant } : { user });
  });
  back.addEventListener("click", () => sendViewAs({ user: null }));
  return viewForm;
}
async function sendViewAs(body) {
  viewNote = "...";
  draw();
  try {
    const res = await fetch("/_weft/dev/view-as", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    viewNote = out.ok ? (out.viewing ? "Now viewing as " + out.viewing.user + "." : "Back to your own view.")
      : (out.reason || "View as failed: HTTP " + res.status);
  } catch {
    viewNote = "The dev server is not answering.";
  }
  poll();
}
function drawViewAs(body) {
  const form = viewAsForm();
  if (!body.contains(form)) {
    body.append(form, empty("Pages load and render as that user, read-only: every write rule refuses, and the reads are "
      + "audited as that user via you. It lasts an hour or until Back to me. Sign in first."));
  }
  const v = last && last.viewing;
  form.querySelector('[data-role="viewing"]').textContent = (viewNote ? viewNote + " " : "")
    + (v ? "This session sees the app as id " + v.user + (v.tenant ? " in " + v.tenant : "") + " until " + clock(v.until) + "."
      : "This session sees the app as you.");
  form.querySelector('[data-role="stop"]').disabled = !v;
}

// The live page's root instance (the body's first data-weft-c).
function liveRoot() {
  return document.querySelector("body [data-weft-c]");
}
// Show step n in place of the page: its HTML with every runtime hook
// (data-weft-* attributes, scripts, inline handlers) taken out, inert, after the live
// root, which is hidden and keeps receiving its patches.
async function showStep(n) {
  const id = lid();
  try {
    const res = await fetch("/_weft/dev/frame?lid=" + encodeURIComponent(id) + "&n=" + n, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) { shownNote = res.status === 404 ? "That step is no longer kept." : "HTTP " + res.status; draw(); return; }
    const f = await res.json();
    const doc = new DOMParser().parseFromString("<body>" + f.html + "</body>", "text/html");
    for (const s of doc.querySelectorAll("script")) s.remove();
    for (const node of doc.body.querySelectorAll("*")) {
      for (const a of [...node.attributes]) {
        if (a.name.startsWith("data-weft-") || a.name.startsWith("on")) node.removeAttribute(a.name);
      }
    }
    const rootEl = liveRoot();
    if (!rootEl) return;
    if (!shownBox) {
      shownBox = document.createElement("div");
      shownBox.id = "weft-dev-step";
      shownBox.inert = true;
      shownBox.setAttribute("aria-label", "An earlier state of this page (read-only)");
      rootEl.after(shownBox);
    }
    shownBox.replaceChildren(...doc.body.childNodes);
    rootEl.style.setProperty("display", "none", "important");
    shownRoot = rootEl;
    shownLid = id;
    shown = f.n;
    shownNote = "";
  } catch {
    shownNote = "The dev server is not answering.";
  }
  draw();
}
// Save the page's events (values redacted) as a file for weft replay.
async function download() {
  try {
    const res = await fetch("/_weft/dev/recording?lid=" + encodeURIComponent(lid()), { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) { shownNote = "Recording failed: HTTP " + res.status; draw(); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = (location.pathname.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "index") + ".weft-recording.json";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    shownNote = "Saved. Replay it with: weft replay " + a.download;
  } catch {
    shownNote = "The dev server is not answering.";
  }
  draw();
}
// Back to the live page.
function live() {
  shownBox?.remove();
  shownRoot?.style.removeProperty("display");
  shownBox = null;
  shownRoot = null;
  shown = null;
}
function button(label, onClick, disabled) {
  const b = el("button", { font: "inherit", border: "1px solid " + RULE, background: "#fff", padding: "0 8px", cursor: disabled ? "default" : "pointer" }, label);
  b.type = "button";
  b.disabled = !!disabled;
  b.addEventListener("click", onClick);
  return b;
}
function drawTime(body) {
  const frames = last.frames || [];
  if (frames.length === 0) { body.append(empty("No states kept yet.")); return; }
  const at = shown === null ? frames.length - 1 : frames.findIndex((f) => f.n === shown);
  const bar = el("div", { display: "flex", gap: "8px", "align-items": "baseline", margin: "0 0 8px" });
  bar.dataset.role = "time";
  bar.append(
    button("Back", () => showStep(frames[Math.max(0, at - 1)].n), at <= 0),
    button("Forward", () => (at + 1 >= frames.length - 1 && shown !== null ? (live(), draw()) : showStep(frames[at + 1].n)), shown === null),
    button("Live", () => { live(); draw(); }, shown === null),
    button("Download recording", download),
    el("span", { color: shown === null ? MUTED : WARN },
      shown === null ? "Showing the live page." : "Showing step " + shown + ", read-only: the live page goes on behind it."),
  );
  body.append(bar);
  if (shownNote) body.append(empty(shownNote));
  body.append(table(["Step", "Time", "After", "Size"], frames.slice().reverse().map((f) => [
    { text: (f.n === shown || (shown === null && f === frames[frames.length - 1]) ? "> " : "  ") + f.n, color: f.n === shown ? WARN : INK },
    clock(f.at), f.what, (f.bytes / 1024).toFixed(1) + " KB",
  ])));
  for (const [i, row] of [...body.querySelectorAll("tr")].slice(1).entries()) {
    const f = frames[frames.length - 1 - i];
    css(row, { cursor: "pointer" });
    row.addEventListener("click", () => (f === frames[frames.length - 1] ? (live(), draw()) : showStep(f.n)));
  }
  body.append(empty("The page's HTML after each event and refresh (the last " + frames.length + " kept). Island and client-drawn state is not part of it."));
}

function draw(notice) {
  if (!panel) return;
  for (const b of panel.querySelectorAll("button[data-view]")) {
    const on = b.dataset.view === view;
    css(b, { color: on ? INK : MUTED, "text-decoration": on ? "underline" : "none" });
    b.setAttribute("aria-pressed", String(on));
  }
  if (view === "viewas") {
    const status = panel.querySelector('[data-role="status"]');
    const body = panel.querySelector('[data-role="body"]');
    status.textContent = last ? last.path + "  page " + last.lid.slice(0, 8) : "";
    if (!body.contains(viewForm)) body.replaceChildren();
    drawViewAs(body);
    return;
  }
  const status = panel.querySelector('[data-role="status"]');
  const body = panel.querySelector('[data-role="body"]');
  const top = body.scrollTop;
  body.replaceChildren();
  if (!last) {
    status.textContent = "";
    body.append(empty(notice || "Loading..."));
    return;
  }
  status.textContent = last.path + "  page " + last.lid.slice(0, 8);
  if (view === "tree") {
    const rows = [];
    const walk = (n, depth) => {
      rows.push(["  ".repeat(depth) + n.name + (n.island ? " (island)" : ""), n.id, n.renders, n.ms.toFixed(2) + " ms"]);
      for (const c of n.children) walk(c, depth + 1);
    };
    walk(last.tree, 0);
    body.append(table(["Component", "Instance", "Renders", "Last render"], rows));
    body.append(empty("Inert components are drawn inline into their parent and do not appear as instances."));
  } else if (view === "messages") {
    if (last.messages.length === 0) body.append(empty("No live messages yet. Interact with the page."));
    else body.append(table(["Time", "", "Message", "Handled in", "Sent"], last.messages.slice().reverse().map((m) => [
      clock(m.at), m.dir === "in" ? "event" : m.dir === "warn" ? "warning" : "push", m.what, m.ms === undefined ? "" : m.ms.toFixed(1) + " ms", m.out.join(", ") || "nothing",
    ])));
  } else if (view === "data") {
    const rows = [];
    for (const [pass, list] of [["load", last.reads.load], ["render", last.reads.render]]) {
      for (const r of list) rows.push([pass, r.model, r.scope.join(", ")]);
    }
    if (rows.length === 0) body.append(empty("The last load and render read no models."));
    else body.append(table(["Pass", "Model", "Read as"], rows));
    body.append(empty("Built-in sync refreshes this page when a change to one of these models is visible to one of these actors."
      + (last.stores ? " Its load also read " + last.stores + " store(s)." : "")));
    const k = last.cost;
    body.append(empty("Since it opened, this page handled " + k.events + " event(s) and " + k.refreshes + " refresh(es) in "
      + k.ms.toFixed(1) + " ms of server time, and was sent " + (k.bytes / 1024).toFixed(1) + " KB."));
    const cap = last.capacity;
    body.append(empty("It holds about " + (k.heldBytes / 1024).toFixed(1) + " KB (estimate: its HTML and load data)."
      + (cap ? " At " + (cap.perPage / 1024).toFixed(1) + " KB a page, about " + cap.pages + " more pages of " + cap.route
        + " fit in the " + ((cap.heapLimit - cap.heapUsed) / 1048576).toFixed(0) + " MB of heap left (estimate)." : "")));
  } else if (view === "time") {
    drawTime(body);
  } else {
    if (last.decisions.length === 0) body.append(empty("No data-rule decisions recorded for this session yet."));
    else body.append(table(["Time", "Model", "Action", "Outcome", "Rows", "Actor", "Reason"], last.decisions.slice().reverse().map((d) => [
      clock(d.at), d.model, d.action, { text: d.outcome, color: d.outcome === "denied" ? WARN : OK }, d.count, d.actor, d.reason || "",
    ])));
  }
  body.scrollTop = top;
}
`;
