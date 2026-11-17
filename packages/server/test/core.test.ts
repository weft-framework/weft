import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApp } from "../src/app.ts";
import { findCompiler } from "../src/compiler.ts";
import { ExplainError, explainProject } from "../src/explain.ts";
import { ProjectError, loadProject } from "../src/project.ts";
import { ModelStorage } from "../src/storage.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const work = join(here, ".weft", "core");

function hasCargo(): boolean {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function scaffold(name: string): string {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "new", dir, "--minimal"], { cwd: repo, stdio: "pipe" });
  return dir;
}

const ACCESS = `import { defineAccess } from "@weft-framework/core"

export const access = defineAccess({
  scopes: { org: {}, project: { parent: "org" } },
  permissions: { "task.read": "See tasks", "task.edit": "Change tasks" },
  roles: {
    owner: { scope: "org", permissions: ["*"] },
    viewer: { scope: ["org", "project"], permissions: ["task.read"] },
  },
  owner: "owner",
})
`;

const TASK = `model Task {
  id: string
  org: string @tenant
  project: string
  title: string
  @read(actor.can("task.read", project))
  @write(actor.can("task.edit", project))
}
`;

function coreProject(name: string): string {
  const root = scaffold(name);
  writeFileSync(join(root, "src", "access.ts"), ACCESS);
  writeFileSync(join(root, "src", "auth.ts"), `import { access } from "./access.ts"\nexport function user(id: string) { return access.user(id) }\n`);
  mkdirSync(join(root, "src", "models"), { recursive: true });
  writeFileSync(
    join(root, "src", "models", "access.ts"),
    `import { access } from "../access.ts"\nexport const { Scope, Member, Role, Permission, Invite, Setting } = access.models\n`,
  );
  writeFileSync(join(root, "src", "models", "Task.wx"), TASK);
  return root;
}

test("weft explain reports the models' rules and the roles", { skip: !hasCargo() }, async () => {
  const root = coreProject("core-explain");
  writeFileSync(join(root, "weft.config.ts"), `export default { database: "data/app.db" }\n`);
  const text = await explainProject(root, { compiler: findCompiler(repo) });
  assert.match(text, /Model Task \(key id\)\n {2}tenant: org .*\n {2}read: a rule \(checked row by row\)\n {4}as code: \(actor, row\) => \(actor\.can\("task\.read", row\.project\)\)\n {2}write: a rule/);
  assert.ok(!text.includes("Model AccessMember"), "the access models are described as roles, not rules");
  assert.match(text, /Role owner \[owner, everything\], on org\n {2}can: access\.members\.manage, .*task\.edit, task\.read\n {2}gives: owner, viewer/);
  assert.match(text, /Role viewer, on org, project\n {2}can: task\.read\n/);

  const outDir = join(root, ".weft", "seed");
  const project = await loadProject(root, { compiler: findCompiler(repo), outDir });
  const storage = new ModelStorage();
  await storage.attach(Object.values(project.models), { database: project.database });
  const { access } = (await import(pathToFileURL(join(outDir, "access.ts")).href)) as {
    access: import("@weft-framework/core").AccessControl<string, string, string>;
  };
  const org = access.createTenant("alice", { name: "Acme" });
  storage.close();
  const cli = execFileSync("cargo", ["run", "-q", "-p", "weft-cli", "--", "explain", root, "--tenant", org.id], { cwd: repo, encoding: "utf8" });
  assert.match(cli, /^Model Task/);
  assert.match(cli, /Access for tenant Acme/);
  await assert.rejects(explainProject(root, { compiler: findCompiler(repo), tenant: "nope" }), ExplainError);
});

test("a project wires @weft-framework/core: models, src/auth.ts and tenant rules", { skip: !hasCargo() }, async () => {
  const root = scaffold("core-app");
  writeFileSync(join(root, "src", "access.ts"), ACCESS);
  writeFileSync(join(root, "src", "auth.ts"), `import { access } from "./access.ts"\nexport function user(id: string) { return access.user(id) }\n`);
  mkdirSync(join(root, "src", "models"), { recursive: true });
  writeFileSync(
    join(root, "src", "models", "access.ts"),
    `import { access } from "../access.ts"\nexport const { Scope, Member, Role, Permission, Invite, Setting } = access.models\n`,
  );
  writeFileSync(join(root, "src", "models", "Task.wx"), TASK);
  const outDir = join(root, ".weft", "build");
  const project = await loadProject(root, { compiler: findCompiler(repo), outDir });
  assert.deepEqual(Object.keys(project.models).sort(), [
    "AccessInvite",
    "AccessMember",
    "AccessPermission",
    "AccessRole",
    "AccessScope",
    "AccessSetting",
    "Task",
  ]);
  assert.equal(typeof project.auth?.user, "function");
  const storage = new ModelStorage();
  await storage.attach(Object.values(project.models), { database: ":memory:" });
  try {
    const { access } = (await import(pathToFileURL(join(outDir, "access.ts")).href)) as {
      access: import("@weft-framework/core").AccessControl<string, string, string>;
    };
    const org = access.createTenant("alice", { name: "Acme" });
    const p1 = access.createScope("alice", { type: "project", parent: org.id, name: "One" });
    const p2 = access.createScope("alice", { type: "project", parent: org.id, name: "Two" });
    access.assign("alice", { user: "bob", role: "viewer", scope: p1.id });
    const Task = project.models.Task;
    const alice = (project.auth!.user!("alice") as { in(t: string): unknown }).in(org.id)!;
    assert.ok(Task.as(alice).create({ id: "t1", project: p1.id, title: "a" }));
    assert.ok(Task.as(alice).create({ id: "t2", project: p2.id, title: "b" }));
    const bob = (project.auth!.user!("bob") as { in(t: string): unknown }).in(org.id)!;
    assert.deepEqual(Task.as(bob).all().map((t) => (t as { id: string }).id), ["t1"]);
    assert.equal(Task.as(bob).update(() => true, { title: "x" } as never), 0, "viewer cannot edit");
    access.revoke("alice", { user: "bob", role: "viewer", scope: p1.id });
    assert.deepEqual(Task.as(bob).all(), [], "a revoked role takes effect at once");
    const app = createApp({ secret: "core-test-secret-0123456789abcdef0123", ...project, onError: () => {} });
    app.close();
  } finally {
    storage.close();
  }
});

test("src/auth.ts must export user()", { skip: !hasCargo() }, async () => {
  const root = scaffold("core-bad-auth");
  writeFileSync(join(root, "src", "auth.ts"), `export const users = 1\n`);
  await assert.rejects(
    loadProject(root, { compiler: findCompiler(repo), outDir: join(root, ".weft", "build") }),
    (e: unknown) => e instanceof ProjectError && /src\/auth: export a function `user\(id\)`/.test(e.message),
  );
});
