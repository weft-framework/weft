import { test } from "node:test";
import assert from "node:assert/strict";
import { bindArgs, defineComponent, escapeAttr, escapeHtml, keyed, signal, type EventMessage } from "@weft/runtime";
import { LivePage, redirect } from "../src/live.ts";

const Counter = defineComponent("Counter", (props: { label: string }) => {
  const count = signal(0);
  function inc() {
    count.value = count.value + 1;
  }
  return {
    handlers: { inc },
    render: () =>
      `<button data-weft-on-click="inc">${escapeHtml(props.label)} ${escapeHtml(count.value)}</button>`,
  };
});

const Board = defineComponent("Board", (_props: Record<string, never>) => {
  const items = signal(["a", "b", "c"]);
  const show = signal(true);
  const title = signal("Board");
  function remove(id: string) {
    items.value = items.value.filter((x) => x !== id);
  }
  function toggle() {
    show.value = !show.value;
  }
  function rename(ev: { value?: string }) {
    title.value = ev.value ?? "";
  }
  async function slow() {
    await new Promise((r) => setTimeout(r, 5));
    title.value = title.value + "!";
  }
  function fail() {
    throw new Error("secret detail");
  }
  function leave() {
    return redirect("/bye");
  }
  return {
    handlers: { remove, toggle, rename, slow, fail, leave },
    render: () =>
      `<h1>${escapeHtml(title.value)}</h1>` +
      `${items.value.map((id) => `<i data-weft-on-click="remove" data-weft-args-click="${escapeAttr(bindArgs([id]))}">${escapeHtml(id)}</i>`).join("")}` +
      `${show.value ? `${Counter({ label: title.value })}` : ``}`,
  };
});

let seq = 0;
const ev = (id: string, handler: string, extra: Partial<EventMessage> = {}): EventMessage => ({
  t: "event",
  id,
  handler,
  event: { type: "click" },
  seq: ++seq,
  ...extra,
});

function childId(html: string): string {
  return /<weft-c data-weft-c="(r\.\d+)">/.exec(html)![1];
}

test("first render wraps every instance", () => {
  const page = new LivePage(Board, {});
  const html = page.render();
  assert.match(html, /^<weft-c data-weft-c="r"><h1>Board<\/h1>/);
  assert.match(html, /<weft-c data-weft-c="r\.\d+"><button data-weft-on-click="inc">Board 0<\/button><\/weft-c><\/weft-c>$/);
  assert.match(html, /data-weft-args-click="0">a<\/i>/);
  assert.equal(page.size, 2);
  assert.ok(!html.includes("\u0000"), "no placeholders leak");
});

test("inert children are drawn inline: no wrapper, styles kept, their reads tracked", async () => {
  const tick = signal(0);
  const Row = defineComponent(
    "Row",
    (props: { name: string }) => ({
      handlers: {},
      render: () => `<tr><td>${escapeHtml(props.name)} ${escapeHtml(tick.value)}</td></tr>`,
    }),
    { inert: true, css: ".row{}" },
  );
  const Grid = defineComponent("Grid", (_props: Record<string, never>) => {
    const rows = signal(["a", "b"]);
    function add() {
      rows.value = [...rows.value, "c"];
    }
    return {
      handlers: { add },
      render: () => `<table><tbody>${rows.value.map((name) => Row({ name })).join("")}</tbody></table>`,
    };
  });
  const page = new LivePage(Grid, {});
  const html = page.render();
  assert.equal(html, '<weft-c data-weft-c="r"><table><tbody><tr><td>a 0</td></tr><tr><td>b 0</td></tr></tbody></table></weft-c>');
  assert.equal(page.size, 1);
  assert.ok(page.styles().some((s) => s.includes(".row{}")), "the inline child's stylesheet is still critical CSS");
  const out = await page.dispatch(ev("r", "add"));
  assert.ok(out[0].t === "patch" && out[0].html.includes("<tr><td>c 0</td></tr>"));
  tick.value = 1;
  const again = await page.refresh();
  assert.ok(again[0].t === "patch" && again[0].id === "r" && again[0].html.includes("<td>a 1</td>"), JSON.stringify(again));
});

test("a child event patches only the child, and its state persists", async () => {
  const page = new LivePage(Board, {});
  const cid = childId(page.render());
  const out1 = await page.dispatch(ev(cid, "inc"));
  assert.deepEqual(out1, [
    { t: "patch", id: cid, html: '<button data-weft-on-click="inc">Board 1</button>', ack: seq },
  ]);
  const out2 = await page.dispatch(ev(cid, "inc"));
  assert.equal(out2[0].t === "patch" && out2[0].html.includes("Board 2"), true);
});

test("a parent change patches the parent and keeps the child instance", async () => {
  const page = new LivePage(Board, {});
  const cid = childId(page.render());
  await page.dispatch(ev(cid, "inc"));
  const out = await page.dispatch(ev("r", "rename", { event: { type: "input", value: "New" } }));
  assert.equal(out.length, 1);
  const p = out[0];
  assert.ok(p.t === "patch" && p.id === "r");
  assert.match(p.html, /<h1>New<\/h1>/);
  assert.ok(p.html.includes(`<weft-c data-weft-c="${cid}"><button data-weft-on-click="inc">New 1</button></weft-c>`));
});

test("bound arguments come from the server's table, not the client", async () => {
  const page = new LivePage(Board, {});
  page.render();
  const out = await page.dispatch(ev("r", "remove", { args: "1" }));
  assert.ok(out[0].t === "patch");
  assert.ok(!out[0].html.includes(">b</i>"), "item b removed");
  assert.ok(out[0].html.includes(">a</i>") && out[0].html.includes(">c</i>"));

  const stale = await page.dispatch(ev("r", "remove", { args: "7" }));
  assert.deepEqual(stale, [{ t: "error", message: "Stale event", ack: seq }]);
});

test("a token names its arguments, so an event racing a re-render hits the item the user saw", async () => {
  const page = new LivePage(Board, {});
  const html = page.render();
  const tokenOf = (s: string, id: string) => new RegExp(`data-weft-args-click="(\\d+)">${id}</i>`).exec(s)?.[1];
  const [a, b, c] = ["a", "b", "c"].map((id) => tokenOf(html, id));
  const first = await page.dispatch(ev("r", "remove", { args: a }));
  assert.ok(first[0].t === "patch");
  assert.equal(tokenOf(first[0].html, "b"), b, "b keeps its token");
  assert.equal(tokenOf(first[0].html, "c"), c, "c keeps its token");
  const second = await page.dispatch(ev("r", "remove", { args: b }));
  assert.ok(second[0].t === "patch");
  assert.ok(second[0].html.includes(">c</i>"), "c is not removed in b's place");
  assert.ok(!second[0].html.includes(">b</i>"));

  for (let i = 0; i < 8; i++) {
    await page.dispatch(ev("r", "toggle"));
  }
  assert.deepEqual(await page.dispatch(ev("r", "remove", { args: a })), [
    { t: "error", message: "Stale event", ack: seq },
  ]);
  const still = await page.dispatch(ev("r", "remove", { args: c }));
  assert.ok(still[0].t === "patch" && !still[0].html.includes(">c</i>"), "a token in use stays valid");
});

test("only own handlers resolve; inherited names do not", async () => {
  const page = new LivePage(Board, {});
  page.render();
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "nope"]) {
    assert.deepEqual(await page.dispatch(ev("r", name)), [{ t: "error", message: "Unknown handler", ack: seq }]);
  }
  assert.deepEqual(await page.dispatch(ev("r.999", "inc")), [{ t: "error", message: "Unknown handler", ack: seq }]);
});

test("handler failures are reported generically and logged", async () => {
  const errors: unknown[] = [];
  const page = new LivePage(Board, {}, { onError: (e) => errors.push(e) });
  page.render();
  const out = await page.dispatch(ev("r", "fail"));
  assert.deepEqual(out, [{ t: "error", message: "Handler failed", ack: seq }]);
  assert.equal((errors[0] as Error).message, "secret detail");
});

test("a handler can redirect", async () => {
  const page = new LivePage(Board, {});
  page.render();
  assert.deepEqual(await page.dispatch(ev("r", "leave")), [{ t: "redirect", to: "/bye" }]);
});

test("removed children are disposed and their ids are never reused", async () => {
  const page = new LivePage(Board, {});
  const first = childId(page.render());
  await page.dispatch(ev("r", "toggle"));
  assert.equal(page.size, 1);
  assert.deepEqual(await page.dispatch(ev(first, "inc")), [{ t: "error", message: "Unknown handler", ack: seq }]);
  const out = await page.dispatch(ev("r", "toggle"));
  assert.ok(out[0].t === "patch");
  const second = childId(out[0].html);
  assert.notEqual(second, first);
  assert.match(out[0].html, /Board 0/, "fresh state");
});

test("events on one page run strictly one after another", async () => {
  const page = new LivePage(Board, {});
  page.render();
  const a = page.dispatch(ev("r", "slow"));
  const b = page.dispatch(ev("r", "slow"));
  const [ra, rb] = await Promise.all([a, b]);
  assert.ok(ra[0].t === "patch" && ra[0].html.includes("<h1>Board!</h1>"));
  assert.ok(rb[0].t === "patch" && rb[0].html.includes("<h1>Board!!</h1>"));
});

test("no change, no patch - just an ack", async () => {
  const Static = defineComponent("Static", (_p: Record<string, never>) => ({
    handlers: { noop() {} },
    render: () => "<p>same</p>",
  }));
  const page = new LivePage(Static, {});
  page.render();
  const msg = ev("r", "noop");
  assert.deepEqual(await page.dispatch(msg), [{ t: "ack", ack: msg.seq }]);
});

test("keyed each: instance state follows its item across reorders", async () => {
  const List = defineComponent("List", (_props: Record<string, never>) => {
    const items = signal(["a", "b", "c", "b"]);
    function rotate() {
      items.value = [...items.value.slice(1), items.value[0]];
    }
    return {
      handlers: { rotate },
      render: () =>
        `<button data-weft-on-click="rotate">r</button>` +
        items.value
          .map((item) => {
            const __weftKey = String(item);
            return `${keyed(__weftKey, () => Counter({ label: item }))}`;
          })
          .join(""),
    };
  });
  const page = new LivePage(List, {});
  const html = page.render();
  const ids = [...html.matchAll(/data-weft-c="(r\.\d+)"( data-weft-key="([^"]*)")?/g)].map((m) => [m[1], m[3]]);
  assert.deepEqual(ids, [
    ["r.0", "a"],
    ["r.1", "b"],
    ["r.2", "c"],
    ["r.3", undefined],
  ]);

  const ev = (id: string, handler: string, seq: number): EventMessage => ({ t: "event", id, handler, event: { type: "click" }, seq });
  await page.dispatch(ev("r.2", "inc", 1));
  const out = await page.dispatch(ev("r", "rotate", 2));
  const patch = out.find((m) => m.t === "patch" && m.id === "r");
  assert.ok(patch && patch.t === "patch");
  const order = [...patch.html.matchAll(/<weft-c data-weft-c="(r\.\d+)" data-weft-keep><\/weft-c>/g)].map((m) => m[1]);
  assert.deepEqual(order, ["r.1", "r.2", "r.3", "r.0"], "a and c kept their instances");
  assert.ok(!patch.html.includes("<button data-weft-on-click=\"inc\">"), "no row markup resent");
  const full = page.current();
  assert.ok(full.t === "patch");
  assert.match(full.html, /data-weft-c="r\.2" data-weft-key="c"><button data-weft-on-click="inc">c 1<\/button>/);
  assert.equal(page.size, 5, "no instance created or lost by the reorder");
});

test("keyed each: keys are escaped into the wrapper", () => {
  const Wrap = defineComponent("Wrap", (_props: Record<string, never>) => ({
    handlers: {},
    render: () => keyed(`"><script>`, () => Counter({ label: "x" })),
  }));
  const html = new LivePage(Wrap, {}).render();
  assert.match(html, /data-weft-key="&quot;&gt;&lt;script&gt;"/);
  assert.ok(!html.includes("<script>"));
});

function lifecycleBoard(log: string[]) {
  const ticks: (() => void)[] = [];
  const Ticker = defineComponent("Ticker", (props: { name: string }) => {
    const n = signal(0);
    return {
      handlers: {},
      mount: [
        () => {
          log.push(`mount ${props.name}`);
          ticks.push(() => (n.value = n.value + 1));
          return () => log.push(`cleanup ${props.name}`);
        },
      ],
      destroy: [() => log.push(`destroy ${props.name}`)],
      render: () => `<b>${escapeHtml(n.value)}</b>`,
    };
  });
  const Host = defineComponent("Host", (_props: Record<string, never>) => {
    const show = signal(true);
    function hide() {
      show.value = false;
    }
    return {
      handlers: { hide },
      mount: [() => log.push("mount host")],
      render: () => `${show.value ? Ticker({ name: "a" }) : ""}`,
    };
  });
  return { Host, ticks };
}

test("onMount runs once after the first render, children first", async () => {
  const log: string[] = [];
  const { Host } = lifecycleBoard(log);
  const page = new LivePage(Host, {});
  page.render();
  assert.deepEqual(log, ["mount a", "mount host"]);
  await page.refresh();
  assert.deepEqual(log, ["mount a", "mount host"], "re-renders do not re-mount");
});

test("a removed instance runs its cleanup and onDestroy; close disposes all", async () => {
  const log: string[] = [];
  const { Host } = lifecycleBoard(log);
  const page = new LivePage(Host, {});
  page.render();
  await page.dispatch(ev("r", "hide"));
  assert.deepEqual(log.slice(2), ["cleanup a", "destroy a"]);

  const log2: string[] = [];
  const second = lifecycleBoard(log2);
  const other = new LivePage(second.Host, {});
  other.render();
  other.close();
  other.close();
  assert.deepEqual(log2.slice(2), ["cleanup a", "destroy a"], "close is idempotent");
});

test("a signal changed outside an event invalidates the page; events do not", async () => {
  const log: string[] = [];
  const { Host, ticks } = lifecycleBoard(log);
  let invalidations = 0;
  const page = new LivePage(Host, {}, { onInvalidate: () => invalidations++ });
  const cid = childId(page.render());
  ticks[0]();
  assert.equal(invalidations, 1);
  const out = await page.refresh();
  assert.deepEqual(out, [{ t: "patch", id: cid, html: "<b>1</b>" }]);
  await page.dispatch(ev("r", "hide"));
  assert.equal(invalidations, 1, "a handler's own changes are rendered, not invalidated");
  ticks[0]();
  assert.equal(invalidations, 1, "a disposed instance no longer tracks");
});

test("failing hooks are reported and do not stop the page", () => {
  const errors: unknown[] = [];
  const Bad = defineComponent("Bad", (_props: Record<string, never>) => ({
    handlers: {},
    mount: [
      () => {
        throw new Error("boom");
      },
    ],
    destroy: [
      () => {
        throw new Error("bang");
      },
    ],
    render: () => "<p>ok</p>",
  }));
  const page = new LivePage(Bad, {}, { onError: (err) => errors.push(err) });
  assert.match(page.render(), /<p>ok<\/p>/);
  page.close();
  assert.deepEqual(
    errors.map((e) => (e as Error).message),
    ["boom", "bang"],
  );
});

test("a static child renders once and is kept across parent patches", async () => {
  let renders = 0;
  const Logo = defineComponent(
    "Logo",
    (_props: Record<string, never>) => ({
      render: () => {
        renders += 1;
        return `<b>Weft</b>`;
      },
    }),
    { static: true },
  );
  const Shell = defineComponent("Shell", (_props: Record<string, never>) => {
    const n = signal(0);
    function bump() {
      n.value = n.value + 1;
    }
    return {
      handlers: { bump },
      render: () => `<p>${escapeHtml(n.value)}</p>${Logo({})}`,
    };
  });
  const page = new LivePage(Shell, {});
  const html = page.render();
  assert.match(html, /<weft-c data-weft-c="r\.\d+"><b>Weft<\/b><\/weft-c>/);
  for (let i = 0; i < 3; i++) {
    const out = await page.dispatch(ev("r", "bump"));
    assert.ok(out[0].t === "patch" && out[0].html.startsWith(`<p>${i + 1}</p>`));
    assert.match(out[0].html, /data-weft-keep><\/weft-c>$/, "logo goes as a keep marker");
  }
  assert.equal(renders, 1, "rendered once");
  const full = page.current();
  assert.ok(full.t === "patch" && full.html.includes("<b>Weft</b>"));
});
