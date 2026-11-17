import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { defineComponent, escapeHtml } from "@weft-framework/runtime";
import { createApp } from "../src/app.ts";
import { loadEnvFile } from "../src/env.ts";
import { isSecret, parseEnv, Secret, secretEnv } from "../src/secret.ts";

const VALUE = "sk_live_0123456789";

test("a secret shows only through reveal()", () => {
  const s = secretEnv("API_KEY", { env: { API_KEY: VALUE } });
  assert.ok(isSecret(s));
  assert.equal(s.reveal(), VALUE);
  assert.equal(String(s), "[secret]");
  assert.equal(`${s}`, "[secret]");
  assert.equal("k=" + s, "k=[secret]");
  assert.equal(inspect(s), "Secret(API_KEY)");
  assert.equal(inspect({ s }).includes(VALUE), false);
  assert.throws(() => JSON.stringify({ nested: [s] }), /API_KEY cannot be serialised/);
  assert.equal(inspect(structuredClone(s)).includes(VALUE), false, "a clone has no value");
  assert.equal(Object.keys(s).includes("value"), false);
  assert.throws(() => secretEnv("MISSING", { env: {} }), /MISSING is not set/);
  assert.throws(() => secretEnv("SHORT", { env: { SHORT: "abc" }, minLength: 8 }), /at least 8/);
  assert.ok(new Secret("X", "y") instanceof Secret);
});

test("a secret that reaches a response fails the request without leaking", async () => {
  const s = secretEnv("API_KEY", { env: { API_KEY: VALUE } });
  const Show = defineComponent("Show", (props: { k: unknown }) => ({ render: () => `<p>${escapeHtml(String(props.k))}</p>` }));
  const errors: unknown[] = [];
  const app = createApp({
    secret: "test-secret-test-secret-test-secret!",
    sync: false,
    transports: [],
    onError: (e) => errors.push(e),
    routes: { "/": { component: Show as never, load: () => ({ k: s }) } },
    api: { "/api/k": { GET: () => Response.json({ k: s }) } },
  });
  const page = await (await app.fetch(new Request("http://app.test/")))!.text();
  assert.ok(page.includes("<p>[secret]</p>") && !page.includes(VALUE));
  const res = (await app.fetch(new Request("http://app.test/api/k")))!;
  assert.equal(res.status, 500);
  assert.ok(!(await res.text()).includes(VALUE));
});

test(".env files parse like a shell would read them", () => {
  assert.deepEqual(
    parseEnv(
      [
        "# comment",
        "",
        "PLAIN=hello world # trailing",
        "export EXPORTED=1",
        "EMPTY=",
        "SINGLE='a # not a comment \\n'",
        'DOUBLE="line\\nnext \\"q\\""  # c',
        "HASH=a#b",
        "  SPACED  =  v  ",
      ].join("\r\n"),
    ),
    {
      PLAIN: "hello world",
      EXPORTED: "1",
      EMPTY: "",
      SINGLE: "a # not a comment \\n",
      DOUBLE: 'line\nnext "q"',
      HASH: "a#b",
      SPACED: "v",
    },
  );
  assert.throws(() => parseEnv("OK=1\nnot a line"), /\.env:2: expected KEY=value/);
  assert.throws(() => parseEnv('Q="open'), /unterminated quote/);
  assert.throws(() => parseEnv("1BAD=x"), /expected KEY=value/);
});

test("loading .env never overrides the real environment", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), ".weft", "env");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, ".env");
  writeFileSync(file, "A=from-file\nB=from-file\n");
  const env: Record<string, string | undefined> = { A: "real" };
  assert.deepEqual(loadEnvFile(file, env), ["B"]);
  assert.deepEqual(env, { A: "real", B: "from-file" });
  assert.deepEqual(loadEnvFile(join(dir, "missing.env"), env), []);
});
