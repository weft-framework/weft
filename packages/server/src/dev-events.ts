import { DEV_PANEL_JS } from "./devtools-client.ts";

const enc = new TextEncoder();

export function overlayText(text: string): string {
  const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return plain.length > 20_000 ? plain.slice(0, 20_000) + "\n..." : plain;
}

export class DevEvents {
  private streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private error: string | null = null;
  private builds = 0;

  reload(): void {
    this.error = null;
    this.builds += 1;
    this.send("data: reload\n\n");
  }

  fail(text: string): void {
    this.error = overlayText(text);
    this.send(this.errorMessage());
  }

  get current(): string | null {
    return this.error;
  }

  response(): Response {
    let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctl = c;
        this.streams.add(c);
        c.enqueue(enc.encode(`: dev\n\nevent: weft-build\ndata: ${this.builds}\n\n`));
        if (this.error !== null) {
          c.enqueue(enc.encode(this.errorMessage()));
        }
      },
      cancel: () => {
        if (ctl) {
          this.streams.delete(ctl);
        }
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  }

  close(): void {
    for (const c of this.streams) {
      try {
        c.close();
      } catch {
      }
    }
    this.streams.clear();
  }

  private errorMessage(): string {
    return `event: weft-error\ndata: ${JSON.stringify(this.error)}\n\n`;
  }

  private send(message: string): void {
    const bytes = enc.encode(message);
    for (const c of this.streams) {
      try {
        c.enqueue(bytes);
      } catch {
        this.streams.delete(c);
      }
    }
  }
}

const BUILD_OVERLAY_JS = `const ID = "weft-dev-overlay";
let es = null;
let build = null;
function listen() {
  es = new EventSource("/_weft/dev/events");
  es.onmessage = () => location.reload();
  es.addEventListener("weft-build", (e) => {
    if (build !== null && build !== e.data) location.reload();
    build = e.data;
  });
  es.addEventListener("weft-error", (e) => {
    let text = "";
    try { text = String(JSON.parse(e.data)); } catch { text = "Build failed"; }
    show(text);
  });
}
listen();
let hidden = null;
document.addEventListener?.("visibilitychange", () => {
  clearTimeout(hidden);
  hidden = null;
  if (document.visibilityState === "hidden") {
    hidden = setTimeout(() => { es?.close(); es = null; }, 10000);
  } else if (!es) {
    listen();
  }
});

function css(el, props) {
  for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v);
  return el;
}

function show(text) {
  document.getElementById(ID)?.remove();
  const root = css(document.createElement("div"), {
    position: "fixed", inset: "0", "z-index": "2147483647", overflow: "auto",
    background: "rgba(255,255,255,0.97)", color: "#1a1a1a",
    font: "13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    padding: "24px",
  });
  root.id = ID;
  root.setAttribute("role", "alertdialog");
  root.setAttribute("aria-label", "Build failed");
  const head = css(document.createElement("div"), {
    display: "flex", "justify-content": "space-between", "align-items": "baseline",
    "border-bottom": "1px solid #d0d0d0", "padding-bottom": "8px", "margin-bottom": "16px",
  });
  const title = css(document.createElement("strong"), { color: "#b00020", "font-size": "14px" });
  title.textContent = "Build failed - the last good build is still being served";
  const close = css(document.createElement("button"), {
    font: "inherit", background: "none", border: "1px solid #b0b0b0", padding: "2px 10px", cursor: "pointer",
  });
  close.type = "button";
  close.textContent = "Dismiss";
  close.addEventListener("click", () => root.remove());
  head.append(title, close);
  const pre = css(document.createElement("pre"), { margin: "0", "white-space": "pre-wrap", "word-break": "break-word" });
  pre.textContent = text;
  const foot = css(document.createElement("p"), { color: "#666", "margin-top": "16px" });
  foot.textContent = "Fix the error and save: the page reloads when the build succeeds.";
  root.append(head, pre, foot);
  document.body.append(root);
  close.focus();
}
`;

export const DEV_CLIENT_JS = BUILD_OVERLAY_JS + DEV_PANEL_JS;
