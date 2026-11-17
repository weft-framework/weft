import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, copyFileSync, openSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export class PreviewError extends Error {}

export interface PreviewState {
  name: string;
  branch: string;
  commit: string;
  port: number;
  url: string;
  pid: number;
  started: number;
}

export function previewName(branch: string): string {
  const chars: string[] = [];
  let dash = true;
  for (let k = 0; k < branch.length; k++) {
    const c = branch.charCodeAt(k);
    const lower = c >= 65 && c <= 90 ? c + 32 : c;
    const alnum = (lower >= 97 && lower <= 122) || (lower >= 48 && lower <= 57);
    if (alnum) {
      chars.push(String.fromCharCode(lower));
      dash = false;
    } else if (!dash) {
      chars.push("-");
      dash = true;
    }
  }
  if (chars.length && chars[chars.length - 1] === "-") chars.pop();
  let plain = chars.join("");
  if (plain.length > 32) {
    plain = plain.slice(0, 32);
    while (plain.endsWith("-")) plain = plain.slice(0, -1);
  }
  if (plain === branch && plain.length > 0) return plain;
  const tag = createHash("sha256").update(branch).digest("hex").slice(0, 6);
  return plain ? `${plain}-${tag}` : `branch-${tag}`;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.error) throw new PreviewError(`git: ${r.error.message}`);
  if (r.status !== 0) throw new PreviewError(`git ${args[0]}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

const dirOf = (root: string, name: string) => join(root, ".weft", "previews", name);
const stateFile = (dir: string) => join(dir, ".weft", "preview.json");

function readState(dir: string): PreviewState | null {
  try {
    return JSON.parse(readFileSync(stateFile(dir), "utf8")) as PreviewState;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function stop(state: PreviewState | null): Promise<void> {
  if (!state || !alive(state.pid)) return;
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 100 && alive(state.pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (alive(state.pid)) process.kill(state.pid, "SIGKILL");
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen(port, "127.0.0.1", () => s.close(() => done(true)));
  });
}

async function pickPort(name: string, asked: number | undefined, had: number | undefined): Promise<number> {
  if (asked !== undefined) {
    if (!Number.isInteger(asked) || asked < 1024 || asked > 65535) throw new PreviewError("--port is 1024 to 65535");
    if (!(await portFree(asked))) throw new PreviewError(`port ${asked} is in use`);
    return asked;
  }
  if (had !== undefined && (await portFree(had))) return had;
  const start = 4100 + (parseInt(createHash("sha256").update(name).digest("hex").slice(0, 4), 16) % 800);
  for (let i = 0; i < 900; i++) {
    const p = 4100 + ((start - 4100 + i) % 900);
    if (await portFree(p)) return p;
  }
  throw new PreviewError("no free port from 4100 to 4999");
}

function readDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

export interface UpOptions {
  branch: string;
  url?: string;
  port?: number;
  reset?: boolean;
  wait?: number;
  log?: (line: string) => void;
}

export async function previewUp(root: string, o: UpOptions): Promise<PreviewState> {
  root = resolve(root);
  const log = o.log ?? ((s: string) => console.log(`[weft] ${s}`));
  if (typeof o.branch !== "string" || o.branch === "" || o.branch.startsWith("-")) throw new PreviewError("--branch names a branch");
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(top) !== realpathSync(root)) throw new PreviewError("run it from the project's top directory (the git repository root)");
  const commit = git(root, ["rev-parse", "--verify", "--end-of-options", `${o.branch}^{commit}`]);
  const name = previewName(o.branch);
  const dir = dirOf(root, name);
  const before = readState(dir);
  await stop(before);

  if (!existsSync(dir)) {
    mkdirSync(join(root, ".weft", "previews"), { recursive: true });
    log(`checking out ${o.branch} (${commit.slice(0, 8)}) into .weft/previews/${name}`);
    git(root, ["worktree", "add", "--detach", "--", dir, commit]);
  } else {
    log(`updating ${name} to ${commit.slice(0, 8)}`);
    git(dir, ["checkout", "--detach", "--force", commit]);
  }

  const lock = (d: string) => (existsSync(join(d, "package-lock.json")) ? readFileSync(join(d, "package-lock.json"), "utf8") : null);
  const nm = join(dir, "node_modules");
  if (lock(dir) === lock(root)) {
    if (!existsSync(nm) && existsSync(join(root, "node_modules"))) symlinkSync(join(root, "node_modules"), nm, "junction");
  } else if (existsSync(join(dir, "package.json"))) {
    rmSync(nm, { recursive: true, force: true });
    log("installing dependencies (npm ci)");
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", [lock(dir) ? "ci" : "install", "--no-audit", "--no-fund"], {
      cwd: dir,
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    if (r.status !== 0) throw new PreviewError("installing dependencies failed");
  }

  mkdirSync(join(dir, ".weft"), { recursive: true });
  const secretFile = join(dir, ".weft", "preview-secret");
  if (!existsSync(secretFile)) {
    writeFileSync(secretFile, randomBytes(36).toString("base64url"), { mode: 0o600 });
    try {
      chmodSync(secretFile, 0o600);
    } catch {
    }
  }
  const secret = readFileSync(secretFile, "utf8").trim();
  const port = await pickPort(name, o.port, before?.port);
  const url = o.url ? o.url.replaceAll("{name}", name) : `http://127.0.0.1:${port}`;
  try {
    new URL(url);
  } catch {
    throw new PreviewError("--url is a URL, with {name} for the preview's name");
  }
  if (existsSync(join(root, ".env.preview"))) copyFileSync(join(root, ".env.preview"), join(dir, ".env"));
  const fromFile = readDotenv(join(dir, ".env"));
  const { loadConfig } = await import("./load-config.ts");
  const config = await loadConfig(dir);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...fromFile,
    NODE_ENV: "production",
    WEFT_PREVIEW: name,
    APP_URL: url,
    PORT: String(port),
    HOST: "127.0.0.1",
    WEFT_SECRET: secret,
  };
  if (config.secret) env[config.secret.env] = secret;

  const self = fileURLToPath(import.meta.url);
  const step = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", self, "--command=step", dir, ...args], {
      stdio: "inherit",
      env,
      windowsHide: true,
    });
    if (r.status !== 0) throw new PreviewError(`${args[0]} failed`);
  };
  log("building");
  step(["build"]);
  const fresh = !before;
  if (existsSync(join(dir, "src", "seed.ts")) && (o.reset || fresh)) {
    log(o.reset ? "resetting and seeding the preview database" : "seeding the preview database");
    step(["seed"]);
  } else {
    log("migrating the preview database");
    step(["migrate"]);
  }

  const out = openSync(join(dir, ".weft", "preview.log"), "a");
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(dir, "dist", "server.mjs")], {
    cwd: dir,
    env,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  const state: PreviewState = { name, branch: o.branch, commit, port, url, pid: child.pid ?? 0, started: Date.now() };
  writeFileSync(stateFile(dir), JSON.stringify(state, null, 2));
  const until = Date.now() + (o.wait ?? 60) * 1000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/_weft/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
    }
    if (!alive(state.pid)) throw new PreviewError(`the preview stopped while starting; see .weft/previews/${name}/.weft/preview.log`);
    if (Date.now() > until) throw new PreviewError(`the preview did not answer /_weft/health; see .weft/previews/${name}/.weft/preview.log`);
    await new Promise((r) => setTimeout(r, 300));
  }
  log(`${name} is up at ${url} (port ${port})`);
  return state;
}

export function previewList(root: string): (PreviewState & { running: boolean })[] {
  const base = join(resolve(root), ".weft", "previews");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((n) => readState(join(base, n)))
    .filter((s): s is PreviewState => s !== null)
    .map((s) => ({ ...s, running: alive(s.pid) }));
}

export async function previewDown(root: string, branch: string): Promise<boolean> {
  root = resolve(root);
  const name = previewName(branch);
  const dir = dirOf(root, name);
  if (!existsSync(dir)) return false;
  await stop(readState(dir));
  const nm = join(dir, "node_modules");
  try {
    if (realpathSync(nm) === realpathSync(join(root, "node_modules"))) rmSync(nm, { force: true, recursive: false });
  } catch {
  }
  git(root, ["worktree", "remove", "--force", "--", dir]);
  rmSync(dir, { recursive: true, force: true });
  return true;
}

async function runStep(dir: string, what: string): Promise<void> {
  const { findCompiler } = await import("./compiler.ts");
  const compiler = findCompiler(dir);
  if (what === "build") {
    const { build } = await import("./build.ts");
    await build(dir, { compiler });
  } else if (what === "migrate") {
    const { migrateProject } = await import("./migrate.ts");
    await migrateProject(dir, { compiler });
  } else if (what === "seed") {
    const { seedProject } = await import("./seed.ts");
    await seedProject(dir, { compiler, reset: true });
  } else throw new PreviewError(`unknown step ${what}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      command: { type: "string" },
      branch: { type: "string" },
      url: { type: "string" },
      port: { type: "string" },
      reset: { type: "boolean" },
    },
  });
  const root = resolve(positionals[0] ?? ".");
  try {
    switch (values.command) {
      case "step":
        await runStep(root, positionals[1] ?? "");
        break;
      case "up":
        await previewUp(root, {
          branch: values.branch ?? "",
          ...(values.url !== undefined ? { url: values.url } : {}),
          ...(values.port !== undefined ? { port: Number(values.port) } : {}),
          reset: values.reset === true,
        });
        break;
      case "list": {
        const all = previewList(root);
        if (all.length === 0) console.log("[weft] no previews");
        for (const p of all) console.log(`${p.running ? "up  " : "down"}  ${p.name}  ${p.branch}@${p.commit.slice(0, 8)}  ${p.url}`);
        break;
      }
      case "down":
        if (!values.branch) throw new PreviewError("--branch names the preview's branch");
        console.log((await previewDown(root, values.branch)) ? `[weft] removed ${previewName(values.branch)}` : "[weft] no such preview");
        break;
      default:
        throw new PreviewError("expected up, list or down");
    }
  } catch (err) {
    if (err instanceof PreviewError) console.error(`[weft] preview: ${err.message}`);
    else console.error("[weft] preview:", err instanceof Error ? (err.stack ?? err.message) : err);
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
