import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSqlite } from "@weft/data/sqlite";
import { defineBackups, dirBackups, s3Backups, type BackupTarget } from "../src/backup.ts";
import { backupProject } from "../src/db-backup.ts";
import { findCompiler } from "../src/compiler.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const work = join(here, ".weft", "backup");

function fresh(name: string) {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const database = join(dir, "app.db");
  const db = openSqlite(database);
  db.exec("CREATE TABLE note (id TEXT PRIMARY KEY, title TEXT)");
  return { dir, database, db };
}

const titles = (file: string) => {
  const db = openSqlite(file, { readOnly: true });
  try {
    return (db.prepare("SELECT title FROM note ORDER BY id").all() as { title: string }[]).map((r) => r.title);
  } finally {
    db.close();
  }
};

test("snapshots of a database in use, pruned to keep, restored with the old file kept", async () => {
  const { dir, database, db } = fresh("local");
  db.prepare("INSERT INTO note VALUES (?, ?)").run("1", "first");
  let clock = Date.UTC(2026, 10, 14, 2, 0, 0);
  const store = join(dir, "backups");
  const backups = defineBackups({ database, target: dirBackups(store), keep: 2, now: () => clock });

  const a = await backups.run();
  assert.deepEqual([a.name, a.time], ["backup-20261114T020000000Z.sqlite", clock]);
  assert.ok(a.size > 0);
  db.prepare("INSERT INTO note VALUES (?, ?)").run("2", "second");
  clock += 86_400_000;
  await backups.run();
  db.prepare("INSERT INTO note VALUES (?, ?)").run("3", "third");
  clock += 86_400_000;
  const c = await backups.run();
  const list = await backups.list();
  assert.deepEqual(list.map((f) => f.name), [c.name, "backup-20261115T020000000Z.sqlite"], "newest first, the oldest pruned");
  assert.deepEqual(titles(join(store, c.name)), ["first", "second", "third"]);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith(".weft-")), [], "no temporary files left");
  writeFileSync(join(store, "notes.txt"), "x");
  writeFileSync(join(store, "other-20200101T000000Z.sqlite"), "x");
  await backups.run();
  assert.ok(existsSync(join(store, "notes.txt")) && existsSync(join(store, "other-20200101T000000Z.sqlite")));
  db.close();

  const older = (await backups.list())[1]!;
  clock += 1000;
  const r = await backups.restore("backup-20261115T020000000Z.sqlite");
  assert.equal(older.name, "backup-20261115T020000000Z.sqlite");
  assert.match(r.previous!, /app\.db\.before-restore-20261116T020001000Z$/);
  assert.deepEqual(titles(database), ["first", "second"]);
  assert.deepEqual(titles(r.previous!), ["first", "second", "third"], "the replaced database is kept");

  for (const bad of ["../app.db", "backup-x.sqlite", "other-20200101T000000Z.sqlite", "backup-20261115T020000000Z.sqlite/../../x"]) {
    await assert.rejects(backups.restore(bad), /not a backup name/, bad);
  }
  await assert.rejects(backups.restore("backup-20200101T000000Z.sqlite"), /no backup/);
  writeFileSync(join(store, "backup-20300101T000000Z.sqlite"), "not a database at all, just text padding".repeat(200));
  await assert.rejects(backups.restore("backup-20300101T000000Z.sqlite"));
  assert.deepEqual(titles(database), ["first", "second"]);

  assert.throws(() => defineBackups({ database: ":memory:", target: dirBackups(store) }), /SQLite file/);
  assert.throws(() => defineBackups({ database, target: dirBackups(store), keep: 0 }), /keep/);
  assert.throws(() => defineBackups({ database, target: dirBackups(store), prefix: "../x" }), /prefix/);
  await assert.rejects(defineBackups({ database: join(dir, "none.db"), target: dirBackups(store) }).run(), /no database/);
});

test("S3 target: signed requests, paged listing, missing objects", async () => {
  const bucket = new Map<string, Uint8Array>();
  const seen: string[] = [];
  const fakeFetch = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    seen.push(`${init.method} ${u.pathname}`);
    assert.ok(u.searchParams.get("X-Amz-Signature"), "presigned");
    assert.equal(u.host, "backups.s3.eu-central-1.amazonaws.com");
    const key = decodeURIComponent(u.pathname.slice(1));
    if (init.method === "PUT") {
      bucket.set(key, new Uint8Array(init.body as Uint8Array));
      return new Response(null, { status: 200 });
    }
    if (init.method === "DELETE") {
      bucket.delete(key);
      return new Response(null, { status: 204 });
    }
    if (u.searchParams.get("list-type") === "2") {
      const keys = [...bucket.keys()].filter((k) => k.startsWith(u.searchParams.get("prefix")!)).sort();
      const start = Number(u.searchParams.get("continuation-token") ?? 0);
      const pageKeys = keys.slice(start, start + 2);
      const more = start + 2 < keys.length;
      const xml =
        `<ListBucketResult>${pageKeys.map((k) => `<Contents><Key>${k}</Key><Size>${bucket.get(k)!.byteLength}</Size></Contents>`).join("")}` +
        `<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}</ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    const v = bucket.get(key);
    return v ? new Response(v as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  };
  const target: BackupTarget = s3Backups({
    endpoint: "https://s3.eu-central-1.amazonaws.com",
    region: "eu-central-1",
    bucket: "backups",
    accessKeyId: "AKID",
    secretAccessKey: "secret",
    prefix: "db/",
    fetch: fakeFetch,
  });
  const { database, db } = fresh("s3");
  db.prepare("INSERT INTO note VALUES (?, ?)").run("1", "one");
  db.close();
  let clock = Date.UTC(2026, 0, 1);
  const backups = defineBackups({ database, target, keep: 3, now: () => (clock += 60_000) });
  for (let i = 0; i < 5; i++) await backups.run();
  bucket.set("db/unrelated.txt", new Uint8Array(1));
  const list = await backups.list();
  assert.equal(list.length, 3, "listing across pages, pruned to 3");
  assert.ok([...bucket.keys()].every((k) => k.startsWith("db/")));
  assert.equal(await target.get("backup-20990101T000000Z.sqlite"), null);
  await backups.restore(list[0]!.name);
  assert.deepEqual(titles(database), ["one"]);
  assert.ok(seen.some((s) => s.startsWith("DELETE /db/backup-")));

  assert.throws(() => s3Backups({ endpoint: "http://s3.example", region: "x", bucket: "b-1", accessKeyId: "a", secretAccessKey: "s" }), /https/);
  assert.throws(() => s3Backups({ endpoint: "https://s3.example", region: "x", bucket: "B", accessKeyId: "a", secretAccessKey: "s" }), /bucket/);
  assert.throws(() => s3Backups({ endpoint: "https://s3.example", region: "x", bucket: "b-1", accessKeyId: "a", secretAccessKey: "s", prefix: "../" }), /prefix/);
});

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("the project command backs up, lists and restores", { skip: !hasCargo() }, async () => {
  const root = join(work, "project");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "new", root, "--minimal"], { cwd: repo, stdio: "pipe" });
  const compiler = findCompiler(repo);
  await assert.rejects(backupProject(root, compiler, { command: "backup" }), /no `database`/);
  writeFileSync(join(root, "weft.config.ts"), `export default { database: "data/app.db" }\n`);
  mkdirSync(join(root, "data"), { recursive: true });
  const db = openSqlite(join(root, "data", "app.db"));
  db.exec("CREATE TABLE note (id TEXT PRIMARY KEY, title TEXT)");
  db.prepare("INSERT INTO note VALUES ('1', 'kept')").run();
  db.close();
  await assert.rejects(backupProject(root, compiler, { command: "backup" }), /no src\/backup\.ts/);
  writeFileSync(join(root, "src", "backup.ts"), `import { dirBackups } from "@weft/server/backup"\nexport const target = dirBackups("${join(root, "backups").replace(/\\/g, "/")}")\nexport const keep = 2\n`);
  const made = await backupProject(root, compiler, { command: "backup" });
  assert.equal(made.command, "backup");
  const listed = await backupProject(root, compiler, { command: "list" });
  assert.equal(listed.command === "list" && listed.files.length, 1);
  const name = made.command === "backup" ? made.file.name : "";
  await assert.rejects(backupProject(root, compiler, { command: "restore", name, env: { NODE_ENV: "production" } }), /production/);
  const restored = await backupProject(root, compiler, { command: "restore", name, env: {} });
  assert.equal(restored.command === "restore" && existsSync(restored.previous!), true);
  assert.deepEqual(titles(join(root, "data", "app.db")), ["kept"]);
  rmSync(root, { recursive: true, force: true });
});
