import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { db } from "./db.ts";

export const production = process.env.NODE_ENV === "production";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name} in the environment (see README.md)`);
  return v;
}

export const appUrl: string = production ? required("APP_URL") : (process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? 3000}`);

function devKey(): string {
  void db;
  const file = "data/dev-key";
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

export const appKey: string = production ? required("APP_KEY") : (process.env.APP_KEY ?? devKey());

export const appName = "{{name}}";
