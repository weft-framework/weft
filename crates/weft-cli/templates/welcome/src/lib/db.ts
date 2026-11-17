import { openSqlite } from "@weft-framework/data/sqlite";
import { mkdirSync } from "node:fs";

type Db = ReturnType<typeof openSqlite>;
const KEY = Symbol.for("app.db");
const slot = globalThis as { [KEY]?: Db };

if (!slot[KEY]) mkdirSync("data", { recursive: true });
export const db: Db = (slot[KEY] ??= openSqlite("data/app.db"));
