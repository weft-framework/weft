import { test } from "node:test";
import assert from "node:assert/strict";
import { defineModel } from "@weft-framework/data";
import { defineAction } from "../src/action.ts";
import { actionSchema, openApi } from "../src/contract.ts";

const add = defineAction(
  "addItem",
  [
    { name: "title", type: "string" },
    { name: "qty", type: "number" },
    { name: "tags", type: "string", list: true },
    { name: "note", type: "string", optional: true },
  ],
  () => undefined,
);

const Item = defineModel<{ id: string; title: string; price: number; at: Date; owner: string | null; meta?: unknown }>("Item", {
  fields: { id: "string", title: "string", price: "number", at: "Date", owner: "string | null", meta: "unknown" },
  attrs: { title: { unique: true }, owner: { ref: "User" } },
  read: () => true,
  write: () => true,
});

test("action bodies are typed from their parameters", () => {
  assert.deepEqual(actionSchema(add.params), {
    type: "object",
    properties: {
      title: { type: "string" },
      qty: { type: "number" },
      tags: { type: "array", items: { type: "string" } },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["title", "qty", "tags"],
    additionalProperties: false,
  });
  assert.deepEqual(actionSchema([]), { type: "object", properties: {}, additionalProperties: false });
});

test("the document covers actions, API routes and models", () => {
  const doc = openApi(
    {
      actions: { addItem: add as never },
      api: {
        "/api/items/[id]": { GET: () => new Response(), DELETE: () => new Response() },
        "/api/files/[[...path]]": { GET: () => new Response() },
      },
      models: { Item: Item as never },
    },
    { title: "shop", version: "1.2.3" },
  ) as {
    openapi: string;
    info: unknown;
    paths: Record<string, Record<string, { operationId?: string; security?: unknown; parameters?: unknown }>>;
    components: { schemas: Record<string, Record<string, unknown>>; securitySchemes: Record<string, unknown> };
  };
  assert.equal(doc.openapi, "3.1.0");
  assert.deepEqual(doc.info, { title: "shop", version: "1.2.3" });
  assert.deepEqual(Object.keys(doc.paths).sort(), [
    "/_weft/action/addItem",
    "/_weft/session",
    "/api/files",
    "/api/files/{path}",
    "/api/items/{id}",
  ]);
  const action = doc.paths["/_weft/action/addItem"].post;
  assert.equal(action.operationId, "addItem");
  assert.deepEqual(action.security, [{ session: [], csrf: [] }]);
  const items = doc.paths["/api/items/{id}"];
  assert.deepEqual(items.parameters, [{ name: "id", in: "path", required: true, schema: { type: "string" } }]);
  assert.ok(items.get && !items.get.security, "safe methods need no CSRF token");
  assert.deepEqual(items.delete.security, [{ session: [], csrf: [] }]);
  assert.equal(items.post, undefined);

  const item = doc.components.schemas.Item as { properties: Record<string, Record<string, unknown>>; required: string[] };
  assert.equal(doc.components.schemas.Item["x-weft-key"], "id");
  assert.deepEqual(item.properties.at, { type: "string", format: "date-time", "x-weft-type": "Date" });
  assert.equal(item.properties.title["x-weft-unique"], true);
  assert.equal(item.properties.owner["x-weft-ref"], "User");
  assert.deepEqual(item.properties.owner.anyOf, [{ type: "string" }, { type: "null" }]);
  assert.deepEqual(item.required, ["id", "title", "price", "at", "meta"], "all but the nullable owner");
  assert.ok(doc.components.schemas.ActionResult && doc.components.schemas.ActionFailure);
  assert.deepEqual(Object.keys(doc.components.securitySchemes).sort(), ["csrf", "session"]);
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
});

test("actions with file parameters are documented as multipart uploads", () => {
  const up = defineAction("upload", [{ name: "doc", type: "file" }, { name: "more", type: "file", list: true }, { name: "title", type: "string" }], () => 1);
  assert.deepEqual(actionSchema(up.params).properties, {
    doc: { type: "string", format: "binary" },
    more: { type: "array", items: { type: "string", format: "binary" } },
    title: { type: "string" },
  });
  const doc = openApi({ actions: { upload: up } }, { title: "t", version: "1" }) as { paths: Record<string, { post: { requestBody: { content: Record<string, unknown> } } }> };
  assert.deepEqual(Object.keys(doc.paths["/_weft/action/upload"]!.post.requestBody.content), ["multipart/form-data"]);
});
