import type { Model } from "@weft/data";
import type { Action, ParamSpec } from "./action.ts";
import type { ApiHandlers, ApiMethod } from "./api.ts";
import { parsePattern } from "./router.ts";

export interface ContractSource {
  actions?: Record<string, Action>;
  api?: Record<string, ApiHandlers>;
  models?: Record<string, Model<unknown>>;
}

export interface ContractInfo {
  title: string;
  version: string;
  description?: string;
}

type Schema = Record<string, unknown>;

const PARAM_TYPE: Record<ParamSpec["type"], string> = { string: "string", number: "number", boolean: "boolean" };

function paramSchema(p: ParamSpec): Schema {
  const item: Schema = { type: PARAM_TYPE[p.type] };
  return p.list ? { type: "array", items: item } : item;
}

export function actionSchema(params: readonly ParamSpec[]): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.name] = p.optional ? { anyOf: [paramSchema(p), { type: "null" }] } : paramSchema(p);
    if (!p.optional) {
      required.push(p.name);
    }
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

const KIND: Record<string, Schema> = {
  text: { type: "string" },
  real: { type: "number" },
  integer: { type: "integer" },
  bool: { type: "boolean" },
  date: { type: "string", format: "date-time" },
  json: {},
};

export function modelSchema(model: Model<unknown>): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const f of model.fields) {
    let s: Schema = { ...KIND[f.kind] };
    if (f.nullable && f.kind !== "json") {
      s = { anyOf: [s, { type: "null" }] };
    }
    if (f.ref !== undefined) {
      s["x-weft-ref"] = f.ref;
    }
    if (f.unique) {
      s["x-weft-unique"] = true;
    }
    s["x-weft-type"] = f.type;
    properties[f.name] = s;
    if (!f.optional && !f.nullable) {
      required.push(f.name);
    }
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    "x-weft-key": model.key,
    "x-weft-authorization": "rows are read and written through the model's @read/@write rules",
  };
}

function openApiPaths(pattern: string): { path: string; params: string[] }[] {
  const segs = parsePattern(pattern);
  const out: string[] = [];
  const params: string[] = [];
  let optionalRest = false;
  for (const s of segs) {
    if (s.kind === "static") {
      out.push(s.value);
    } else {
      out.push(`{${s.name}}`);
      params.push(s.name);
      optionalRest = s.kind === "rest" && s.optional;
    }
  }
  const full = { path: "/" + out.join("/"), params };
  if (!optionalRest) {
    return [full];
  }
  return [{ path: "/" + out.slice(0, -1).join("/"), params: params.slice(0, -1) }, full];
}

const SECURED = [{ session: [], csrf: [] }];
const METHODS: ApiMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export function openApi(src: ContractSource, info: ContractInfo): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  paths["/_weft/session"] = {
    get: {
      operationId: "weftSession",
      summary: "Session cookie and CSRF token for code without a rendered page",
      responses: {
        "200": {
          description: "The session's CSRF token (a session cookie is set if there was none)",
          content: {
            "application/json": {
              schema: { type: "object", properties: { csrf: { type: "string" } }, required: ["csrf"] },
            },
          },
        },
        "403": { description: "Cross-origin request" },
      },
    },
  };
  for (const name of Object.keys(src.actions ?? {}).sort()) {
    const action = src.actions![name];
    if (action.params.some((p) => p.held)) continue;
    paths[`/_weft/action/${name}`] = {
      post: {
        operationId: name,
        summary: `Action ${name}`,
        security: SECURED,
        requestBody: {
          required: true,
          content: { "application/json": { schema: actionSchema(action.params) } },
        },
        responses: {
          "200": { description: "Done", content: { "application/json": { schema: { $ref: "#/components/schemas/ActionResult" } } } },
          default: {
            description: "Refused (400 bad arguments or the action's own failure, 403 session/CSRF, 404, 413, 429, 500)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ActionFailure" } } },
          },
        },
      },
    };
  }
  for (const pattern of Object.keys(src.api ?? {}).sort()) {
    const handlers = src.api![pattern];
    for (const { path, params } of openApiPaths(pattern)) {
      const item: Record<string, unknown> = {};
      if (params.length) {
        item.parameters = params.map((p) => ({ name: p, in: "path", required: true, schema: { type: "string" } }));
      }
      for (const m of METHODS) {
        if (typeof handlers[m] !== "function") {
          continue;
        }
        const unsafe = m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
        item[m.toLowerCase()] = {
          summary: `${m} ${pattern}`,
          ...(unsafe ? { security: SECURED } : {}),
          responses: { default: { description: "The handler's response" } },
        };
      }
      paths[path] = item;
    }
  }
  const schemas: Record<string, Schema> = {
    ActionResult: {
      type: "object",
      properties: {
        ok: { const: true },
        value: { description: "The action's return value" },
        redirect: { type: "string", description: "A same-origin path to navigate to" },
      },
      required: ["ok"],
    },
    ActionFailure: {
      type: "object",
      properties: { ok: { const: false }, error: { type: "string" } },
      required: ["ok", "error"],
    },
  };
  for (const name of Object.keys(src.models ?? {}).sort()) {
    schemas[name] = modelSchema(src.models![name]);
  }
  return {
    openapi: "3.1.0",
    info,
    paths,
    components: {
      schemas,
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "weft_sid", description: "Signed session id (HttpOnly)" },
        csrf: { type: "apiKey", in: "header", name: "x-weft-csrf", description: "The session's CSRF token" },
      },
    },
  };
}
