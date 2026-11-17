import { randomUUID } from "node:crypto";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { eraseData, personalData, type ErasePlan, type Model, type PersonalData } from "@weft/data";
import { CompileError, findCompiler, type Compiler } from "./compiler.ts";
import { ConfigError } from "./config.ts";
import { ProjectError, loadProject } from "./project.ts";
import { ModelStorage } from "./storage.ts";

export class PersonalDataError extends Error {}

export interface PersonalDataCommand {
  compiler: Compiler;
  command: "export" | "erase";
  key: string;
  model?: string;
  plan?: Record<string, ErasePlan>;
  dryRun?: boolean;
}

export interface PersonalDataResult {
  data: Omit<PersonalData, "steps">;
  erased?: { removed: Record<string, number>; unlinked: Record<string, number> };
  summary: string[];
}

export function parsePlan(text: string | undefined): Record<string, ErasePlan> {
  const plan: Record<string, ErasePlan> = {};
  if (!text) return plan;
  for (const part of text.split(",")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(delete|unlink|keep)\s*$/.exec(part);
    if (!m) throw new PersonalDataError(`--plan: expected Model=delete|unlink|keep, got ${JSON.stringify(part)}`);
    plan[m[1]!] = m[2] as ErasePlan;
  }
  return plan;
}

export async function personalDataCommand(root: string, opts: PersonalDataCommand): Promise<PersonalDataResult> {
  root = resolve(root);
  if (typeof opts.key !== "string" || opts.key === "") throw new PersonalDataError("--key <id> is required: the person's key");
  const outDir = join(root, ".weft", "data", randomUUID());
  const storage = new ModelStorage();
  try {
    const project = await loadProject(root, { compiler: opts.compiler, outDir, browserAssets: false, cacheKey: outDir });
    const database = project.database;
    if (database === undefined || database === ":memory:") {
      throw new PersonalDataError("no `database` file in weft.config.ts");
    }
    const models = Object.values(project.models) as Model<unknown>[];
    const name = opts.model ?? "User";
    const subject = project.models[name] as Model<unknown> | undefined;
    if (!subject) throw new PersonalDataError(`no model ${name}; name the model people are rows of with --model`);
    await storage.attach(models, { database });
    const keyField = subject.fields.find((f) => f.name === subject.key);
    const key = keyField && keyField.type === "number" && /^-?\d+$/.test(opts.key) ? Number(opts.key) : opts.key;
    let data: PersonalData;
    try {
      data = personalData(models, subject, key, { plan: opts.plan ?? {} });
    } catch (err) {
      throw new PersonalDataError(err instanceof Error ? err.message.replace(/^personalData: /, "") : String(err));
    }
    const summary = describe(data);
    const { steps: _steps, ...visible } = data;
    if (opts.command === "export" || opts.dryRun) return { data: visible, summary };
    return { data: visible, erased: eraseData(data), summary };
  } finally {
    storage.close();
    rmSync(outDir, { recursive: true, force: true });
  }
}

function describe(data: PersonalData): string[] {
  const lines: string[] = [];
  for (const s of data.steps) {
    const what = s.action === "delete" ? "delete" : `clear ${s.fields.join(", ")} on`;
    lines.push(`${what} ${s.keys.length} ${s.model.name}`);
  }
  if (data.files.length) lines.push(`${data.files.length} file(s) held by these rows: delete them from storage`);
  if (data.missing.length) lines.push(`not searched (no such model): ${data.missing.join(", ")}`);
  return lines;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      command: { type: "string" },
      key: { type: "string" },
      model: { type: "string" },
      out: { type: "string" },
      plan: { type: "string" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
  const root = resolve(positionals[0] ?? ".");
  const command = values.command;
  try {
    if (command !== "export" && command !== "erase") throw new PersonalDataError("expected `export` or `erase`");
    if (command === "erase" && values.yes !== true && values["dry-run"] !== true) {
      throw new PersonalDataError("`weft data erase` deletes data for good; check with --dry-run, then run it with --yes");
    }
    const result = await personalDataCommand(root, {
      compiler: findCompiler(root),
      command,
      key: values.key ?? "",
      ...(values.model ? { model: values.model } : {}),
      plan: parsePlan(values.plan),
      dryRun: values["dry-run"] === true,
    });
    if (command === "export") {
      const json = JSON.stringify(result.data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
      if (values.out) {
        writeFileSync(resolve(values.out), json, { flag: "wx", mode: 0o600 });
        console.error(`[weft] wrote ${Object.values(result.data.rows).flat().length} rows to ${values.out}`);
      } else {
        process.stdout.write(json);
      }
      for (const line of result.summary.filter((l) => l.startsWith("not searched"))) console.error(`[weft] ${line}`);
      return;
    }
    for (const line of result.summary) console.log(`[weft] ${result.erased ? "" : "would "}${line}`);
    if (result.erased) console.log("[weft] erased");
  } catch (err) {
    if (err instanceof CompileError) {
      console.error(err.diagnostics);
    } else if (err instanceof PersonalDataError || err instanceof ProjectError || err instanceof ConfigError) {
      console.error(`[weft] ${err.message}`);
    } else if (err && typeof err === "object" && (err as { code?: string }).code === "EEXIST") {
      console.error(`[weft] ${values.out} exists; choose another --out`);
    } else {
      console.error("[weft] data:", err instanceof Error ? (err.stack ?? err.message) : err);
    }
    process.exit(1);
  }
}

function isEntry(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  await main();
}
