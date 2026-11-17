import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface Compiler {
  cmd: string;
  args: string[];
  cwd?: string;
}

export function findCompiler(from: string): Compiler {
  if (process.env.WEFT_BIN) {
    return { cmd: process.env.WEFT_BIN, args: [] };
  }
  try {
    execFileSync("weft", ["version"], { stdio: "ignore" });
    return { cmd: "weft", args: [] };
  } catch {
  }
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "crates", "weft-cli", "Cargo.toml"))) {
      return { cmd: "cargo", args: ["run", "-q", "-p", "weft-cli", "--"], cwd: dir };
    }
    if (dirname(dir) === dir) {
      throw new Error("weft compiler not found: set WEFT_BIN or install `weft`");
    }
  }
}

export class CompileError extends Error {
  readonly diagnostics: string;
  constructor(diagnostics: string) {
    super(diagnostics || "compilation failed");
    this.diagnostics = diagnostics;
  }
}

function run(compiler: Compiler, args: string[]): string {
  try {
    return execFileSync(compiler.cmd, [...compiler.args, ...args], {
      cwd: compiler.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new CompileError((e.stderr ?? "").trim() || String(e.message));
  }
}

export function compileFile(compiler: Compiler, file: string): string {
  return run(compiler, ["emit", resolve(file)]);
}

export function compileClient(compiler: Compiler, file: string): string {
  return run(compiler, ["emit", "--client", resolve(file)]);
}

export function compileTree(compiler: Compiler, src: string, out: string): void {
  run(compiler, ["compile", resolve(src), "--out", resolve(out)]);
}
