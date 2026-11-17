import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { openSqlite } from "@weft/data/sqlite";
import { presignS3, type S3Options } from "./uploads.ts";
import type { Secret } from "./secret.ts";

export interface BackupFile {
  name: string;
  size: number;
  time: number;
}

export interface BackupTarget {
  put(name: string, data: Uint8Array): Promise<void>;
  get(name: string): Promise<Uint8Array | null>;
  list(): Promise<{ name: string; size: number }[]>;
  remove(name: string): Promise<void>;
}

const NAME_RE = /^([a-z][a-z0-9-]{0,39})-(\d{8}T\d{6}(?:\d{3})?Z)\.(sqlite|pgdump)$/;

const isOurs = (name: string, prefix: string, ext: "sqlite" | "pgdump") => {
  const m = NAME_RE.exec(name);
  return !!m && m[1] === prefix && m[3] === ext;
};

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
}

function timeOf(name: string): number | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const s = m[2]!;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}.${s.length > 16 ? s.slice(15, 18) : "000"}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function dirBackups(dir: string): BackupTarget {
  if (typeof dir !== "string" || dir === "") throw new Error("dirBackups: needs a directory");
  return {
    async put(name, data) {
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${name}.${randomUUID()}.tmp`);
      writeFileSync(tmp, data);
      renameSync(tmp, join(dir, name));
    },
    async get(name) {
      const file = join(dir, name);
      return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
    },
    async list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((n) => NAME_RE.test(n))
        .map((name) => ({ name, size: statSync(join(dir, name)).size }));
    },
    async remove(name) {
      rmSync(join(dir, name), { force: true });
    },
  };
}

const reveal = (v: string | Secret | undefined) => (v === undefined ? undefined : typeof v === "string" ? v : v.reveal());

export function s3Backups(o: S3Options): BackupTarget {
  let base: URL;
  try {
    base = new URL(o.endpoint);
  } catch {
    throw new Error("s3Backups: endpoint is a URL");
  }
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
    throw new Error("s3Backups: endpoint must be https (http only for a local MinIO)");
  }
  if (typeof o.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(o.bucket)) throw new Error("s3Backups: bucket is an S3 bucket name");
  const prefix = o.prefix ?? "";
  if (!/^[A-Za-z0-9._/-]{0,200}$/.test(prefix) || prefix.includes("..")) throw new Error("s3Backups: prefix is a plain key prefix");
  const doFetch = o.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const root = o.pathStyle ? `${base.origin}/${o.bucket}` : `${base.protocol}//${o.bucket}.${base.host}`;
  const sign = (method: string, url: string) =>
    presignS3({
      method,
      url,
      region: o.region,
      accessKeyId: o.accessKeyId,
      secretAccessKey: reveal(o.secretAccessKey)!,
      ...(o.sessionToken ? { sessionToken: reveal(o.sessionToken)! } : {}),
      expiresSeconds: 300,
      ...(o.now ? { now: o.now() } : {}),
    });
  const objectUrl = (name: string) => `${root}/${prefix}${name}`;
  const check = async (res: Response, what: string) => {
    if (!res.ok) throw new Error(`s3Backups: ${what} failed with HTTP ${res.status}`);
    return res;
  };
  return {
    async put(name, data) {
      await check(await doFetch(await sign("PUT", objectUrl(name)), { method: "PUT", body: data as BodyInit }), `upload of ${name}`);
    },
    async get(name) {
      const res = await doFetch(await sign("GET", objectUrl(name)), { method: "GET" });
      if (res.status === 404) return null;
      return new Uint8Array(await (await check(res, `download of ${name}`)).arrayBuffer());
    },
    async list() {
      const out: { name: string; size: number }[] = [];
      let token: string | null = null;
      for (let page = 0; page < 100; page++) {
        const u = new URL(`${root}/`);
        u.searchParams.set("list-type", "2");
        u.searchParams.set("prefix", prefix);
        if (token) u.searchParams.set("continuation-token", token);
        const xml = await (await check(await doFetch(await sign("GET", u.href), { method: "GET" }), "listing")).text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = /<Key>([^<]*)<\/Key>/.exec(m[1]!)?.[1] ?? "";
          const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1] ?? NaN);
          const name = key.startsWith(prefix) ? key.slice(prefix.length) : "";
          if (NAME_RE.test(name) && Number.isFinite(size)) out.push({ name, size });
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null) : null;
        if (!token) break;
      }
      return out;
    },
    async remove(name) {
      const res = await doFetch(await sign("DELETE", objectUrl(name)), { method: "DELETE" });
      if (res.status !== 404) await check(res, `removal of ${name}`);
    },
  };
}

export interface BackupOptions {
  database: string;
  target: BackupTarget;
  keep?: number;
  prefix?: string;
  now?(): number;
}

export interface Backups {
  run(): Promise<BackupFile>;
  list(): Promise<BackupFile[]>;
  restore(name: string): Promise<{ previous: string | null }>;
}

function checkCopy(file: string): void {
  const db = openSqlite(file, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA quick_check").all() as Record<string, unknown>[];
    const result = rows.map((r) => String(Object.values(r)[0])).join("; ");
    if (result !== "ok") throw new Error(`backup: the copy failed its check: ${result.slice(0, 200)}`);
  } finally {
    db.close();
  }
}

export function defineBackups(o: BackupOptions): Backups {
  if (typeof o.database !== "string" || o.database === "" || o.database === ":memory:") throw new Error("defineBackups: database is a SQLite file");
  if (!o.target || typeof o.target.put !== "function") throw new Error("defineBackups: needs a target (dirBackups, s3Backups)");
  const keep = o.keep ?? 7;
  if (!Number.isInteger(keep) || keep < 1 || keep > 1000) throw new Error("defineBackups: keep is 1 to 1000");
  const prefix = o.prefix ?? "backup";
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(prefix)) throw new Error("defineBackups: prefix is lowercase letters, digits and dashes");
  const now = o.now ?? Date.now;
  const tmpDir = dirname(o.database);

  const list = async (): Promise<BackupFile[]> =>
    (await o.target.list())
      .filter((f) => isOurs(f.name, prefix, "sqlite"))
      .map((f) => ({ name: f.name, size: f.size, time: timeOf(f.name)! }))
      .sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1));

  return {
    list,
    async run() {
      if (!existsSync(o.database)) throw new Error(`backup: no database at ${o.database}`);
      const time = now();
      const name = `${prefix}-${stamp(time)}.sqlite`;
      const tmp = join(tmpDir, `.weft-backup-${randomUUID()}.sqlite`);
      try {
        const db = openSqlite(o.database);
        try {
          db.prepare("VACUUM INTO ?").run(tmp);
        } finally {
          db.close();
        }
        checkCopy(tmp);
        const data = new Uint8Array(readFileSync(tmp));
        await o.target.put(name, data);
        const all = await list();
        for (const old of all.slice(keep)) {
          await o.target.remove(old.name);
        }
        return { name, size: data.byteLength, time };
      } finally {
        rmSync(tmp, { force: true });
      }
    },
    async restore(name) {
      if (typeof name !== "string" || !isOurs(name, prefix, "sqlite")) {
        throw new Error(`restore: ${JSON.stringify(String(name).slice(0, 80))} is not a backup name such as ${prefix}-20261114T020000Z.sqlite`);
      }
      const data = await o.target.get(name);
      if (!data) throw new Error(`restore: no backup ${name}`);
      mkdirSync(tmpDir, { recursive: true });
      const tmp = join(tmpDir, `.weft-restore-${randomUUID()}.sqlite`);
      try {
        writeFileSync(tmp, data);
        checkCopy(tmp);
        let previous: string | null = null;
        if (existsSync(o.database)) {
          previous = `${o.database}.before-restore-${stamp(now())}`;
          renameSync(o.database, previous);
          for (const suffix of ["-wal", "-shm"]) {
            if (existsSync(o.database + suffix)) renameSync(o.database + suffix, previous + suffix);
          }
        }
        renameSync(tmp, o.database);
        return { previous };
      } finally {
        rmSync(tmp, { force: true });
      }
    },
  };
}

export interface PgBackupOptions {
  url: string | Secret;
  target: BackupTarget;
  keep?: number;
  prefix?: string;
  pgDump?: string;
  pgRestore?: string;
  timeoutMs?: number;
  tmpDir?: string;
  now?(): number;
}

const PG_PARAMS: Record<string, string> = {
  sslmode: "PGSSLMODE",
  sslrootcert: "PGSSLROOTCERT",
  sslcert: "PGSSLCERT",
  sslkey: "PGSSLKEY",
  application_name: "PGAPPNAME",
  connect_timeout: "PGCONNECT_TIMEOUT",
};

export function pgEnvironment(url: string, base: Record<string, string | undefined> = process.env): Record<string, string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("definePgBackups: url is a postgres:// URL");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new Error("definePgBackups: url is a postgres:// URL");
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!u.hostname || database === "" || database.includes("/")) throw new Error("definePgBackups: url names a host and a database");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !/^PG/i.test(k)) env[k] = v;
  env.PGHOST = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (u.port) env.PGPORT = u.port;
  env.PGDATABASE = database;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  for (const [k, v] of u.searchParams) {
    const name = PG_PARAMS[k];
    if (!name) throw new Error(`definePgBackups: unsupported url parameter ${JSON.stringify(k.slice(0, 40))}`);
    env[name] = v;
  }
  return env;
}

function runTool(program: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      const code = (err as { code?: unknown }).code;
      if (code === "ENOENT") return reject(new Error(`backup: ${program} was not found; install the Postgres client tools or set its path`));
      const why = String(stderr).trim().split("\n").slice(-3).join(" ").slice(0, 400) || err.message;
      reject(new Error(`backup: ${basename(program)} failed: ${why}`));
    });
  });
}

export function definePgBackups(o: PgBackupOptions): Backups {
  const url = typeof o.url === "string" ? o.url : o.url?.reveal?.();
  if (typeof url !== "string") throw new Error("definePgBackups: needs a url");
  const env = pgEnvironment(url);
  if (!o.target || typeof o.target.put !== "function") throw new Error("definePgBackups: needs a target (dirBackups, s3Backups)");
  const keep = o.keep ?? 7;
  if (!Number.isInteger(keep) || keep < 1 || keep > 1000) throw new Error("definePgBackups: keep is 1 to 1000");
  const prefix = o.prefix ?? "backup";
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(prefix)) throw new Error("definePgBackups: prefix is lowercase letters, digits and dashes");
  const timeoutMs = o.timeoutMs ?? 3_600_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error("definePgBackups: timeoutMs is at least 1000");
  const pgDump = o.pgDump ?? "pg_dump";
  const pgRestore = o.pgRestore ?? "pg_restore";
  const now = o.now ?? Date.now;
  const tmpRoot = o.tmpDir ?? tmpdir();

  const list = async (): Promise<BackupFile[]> =>
    (await o.target.list())
      .filter((f) => isOurs(f.name, prefix, "pgdump"))
      .map((f) => ({ name: f.name, size: f.size, time: timeOf(f.name)! }))
      .sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1));

  const check = async (file: string) => {
    const toc = await runTool(pgRestore, ["--list", file], env, timeoutMs);
    if (!/^;\s*Archive created at/m.test(toc)) throw new Error("backup: the dump failed its check: pg_restore --list read no archive");
  };

  const dump = async (time: number): Promise<BackupFile> => {
    const name = `${prefix}-${stamp(time)}.pgdump`;
    mkdirSync(tmpRoot, { recursive: true });
    const tmp = join(tmpRoot, `.weft-backup-${randomUUID()}.pgdump`);
    try {
      await runTool(pgDump, ["--format=custom", "--no-password", `--file=${tmp}`], env, timeoutMs);
      await check(tmp);
      const data = new Uint8Array(readFileSync(tmp));
      await o.target.put(name, data);
      return { name, size: data.byteLength, time };
    } finally {
      rmSync(tmp, { force: true });
    }
  };

  return {
    list,
    async run() {
      const file = await dump(now());
      for (const old of (await list()).slice(keep)) {
        await o.target.remove(old.name);
      }
      return file;
    },
    async restore(name) {
      if (typeof name !== "string" || !isOurs(name, prefix, "pgdump")) {
        throw new Error(`restore: ${JSON.stringify(String(name).slice(0, 80))} is not a backup name such as ${prefix}-20261114T020000Z.pgdump`);
      }
      const data = await o.target.get(name);
      if (!data) throw new Error(`restore: no backup ${name}`);
      mkdirSync(tmpRoot, { recursive: true });
      const tmp = join(tmpRoot, `.weft-restore-${randomUUID()}.pgdump`);
      try {
        writeFileSync(tmp, data);
        await check(tmp);
        let time = now();
        while ((await o.target.get(`${prefix}-${stamp(time)}.pgdump`)) !== null) time += 1;
        const previous = await dump(time);
        await runTool(
          pgRestore,
          ["--clean", "--if-exists", "--single-transaction", "--exit-on-error", "--no-owner", "--no-password", `--dbname=${env.PGDATABASE}`, tmp],
          env,
          timeoutMs,
        );
        return { previous: previous.name };
      } finally {
        rmSync(tmp, { force: true });
      }
    },
  };
}
