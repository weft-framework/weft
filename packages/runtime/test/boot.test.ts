import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "../src/boot.ts";
import { h } from "../testing/fakedom.ts";

test("boot is inert without a DOM or on a non-live page", () => {
  assert.equal(boot(), null);
  const g = globalThis as Record<string, unknown>;
  g.document = { body: h("body"), querySelector: () => null };
  g.location = { protocol: "http:", host: "h" };
  try {
    assert.equal(boot(), null);
  } finally {
    delete g.document;
    delete g.location;
  }
});

test("boot connects to the live page id from the meta tag", () => {
  const g = globalThis as Record<string, unknown>;
  const metas: Record<string, string> = { "weft-live": "L1", "weft-csrf": "tok" };
  const sockets: string[] = [];
  g.document = {
    body: h("body"),
    querySelector: (sel: string) => {
      const name = /name="([^"]+)"/.exec(sel)?.[1] ?? "";
      return name in metas ? { getAttribute: () => metas[name] } : null;
    },
  };
  g.location = { protocol: "https:", host: "app" };
  g.WebSocket = class {
    constructor(url: string) {
      sockets.push(url);
    }
    send() {}
    close() {}
  };
  try {
    const live = boot();
    assert.ok(live);
    assert.deepEqual(sockets, ["wss://app/_weft/live?lid=L1"]);
    live.connection.close();
    live.client.stop();
  } finally {
    delete g.document;
    delete g.location;
    delete g.WebSocket;
  }
});

test("without client navigation an expired page reloads itself", () => {
  const g = globalThis as Record<string, unknown>;
  const metas: Record<string, string> = { "weft-live": "L1", "weft-csrf": "tok" };
  const sockets: { onmessage: ((ev: { data: unknown }) => void) | null; onopen: (() => void) | null }[] = [];
  const assigned: string[] = [];
  g.document = {
    body: h("body"),
    querySelector: (sel: string) => {
      const name = /name="([^"]+)"/.exec(sel)?.[1] ?? "";
      return name in metas ? { getAttribute: () => metas[name] } : null;
    },
  };
  g.location = { protocol: "https:", host: "app", pathname: "/todo", search: "?q=1", assign: (to: string) => assigned.push(to) };
  g.WebSocket = class {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onopen: (() => void) | null = null;
    constructor() {
      sockets.push(this);
    }
    send() {}
    close() {}
  };
  try {
    const live = boot();
    assert.ok(live);
    sockets[0].onopen?.();
    sockets[0].onmessage?.({ data: '{"t":"expired"}' });
    assert.deepEqual(assigned, ["/todo?q=1"]);
    live.client.stop();
  } finally {
    delete g.document;
    delete g.location;
    delete g.WebSocket;
  }
});

test("a page from a stateless host boots without a live connection", () => {
  const g = globalThis as Record<string, unknown>;
  const metas: Record<string, string> = { "weft-csrf": "tok" };
  const sockets: string[] = [];
  g.document = {
    body: h("body"),
    querySelector: (sel: string) => {
      const name = /name="([^"]+)"/.exec(sel)?.[1] ?? "";
      return name in metas ? { getAttribute: () => metas[name] } : null;
    },
  };
  g.location = { protocol: "https:", host: "app" };
  g.WebSocket = class {
    constructor(url: string) {
      sockets.push(url);
    }
    send() {}
    close() {}
  };
  try {
    const page = boot();
    assert.ok(page, "islands, forms and actions still need the client");
    assert.equal(page.connection, null);
    assert.deepEqual(sockets, []);
    page.client.stop();
  } finally {
    delete g.document;
    delete g.location;
    delete g.WebSocket;
  }
});
