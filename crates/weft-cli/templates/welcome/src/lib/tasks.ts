import { defineComments, defineHistory, defineModel, defineTags, defineWorkflow, type Actor } from "@weft-framework/data";
import { access } from "../access.ts";
import { notify } from "./notify.ts";
import { nameOf } from "./users.ts";

export interface Task {
  id: string;
  workspace: string;
  title: string;
  notes: string;
  status: string;
  assignee: string | null;
  owner: string;
  due: string | null;
  created: number;
  deleted: number | null;
}

export const STATUSES = ["todo", "doing", "review", "done"] as const;
export const STATUS_LABEL: Record<string, string> = { todo: "To do", doing: "In progress", review: "In review", done: "Done" };

type Can = { id: string; can(permission: string, scope?: string): boolean };
const can = (a: Actor, permission: string, workspace: string) =>
  typeof (a as Can | null)?.can === "function" && (a as Can).can(permission, workspace);

export const Tasks = defineModel<Task>("Task", {
  fields: {
    id: "string",
    workspace: "string",
    title: "string",
    notes: "string",
    status: "string",
    assignee: "string | null",
    owner: "string",
    due: "string | null",
    created: "number",
    deleted: "number | null",
  },
  attrs: { workspace: { tenant: true, index: true }, deleted: { softDelete: true } },
  read: (a, t) => can(a, "tasks.read", t.workspace),
  write: (a, t) => can(a, "tasks.edit", t.workspace),
});

const reviewOn = (t: Task) => access.settingValue(t.workspace, "tasks.review") !== false;

export const review = defineWorkflow(Tasks, {
  field: "status",
  initial: "todo",
  transitions: {
    start: { from: "todo", to: "doing", note: "none" },
    submit: { from: ["todo", "doing"], to: "review", allow: (_a, t) => reviewOn(t) },
    finish: { from: ["todo", "doing"], to: "done", allow: (_a, t) => !reviewOn(t), note: "none" },
    approve: { from: "review", to: "done", allow: (a, t) => can(a, "tasks.approve", t.workspace) },
    sendBack: { from: "review", to: "doing", note: "required", allow: (a, t) => can(a, "tasks.approve", t.workspace) },
    reopen: { from: "done", to: "todo" },
  },
});

export const TRANSITION_LABEL: Record<string, string> = {
  start: "Start",
  submit: "Send to review",
  finish: "Mark done",
  approve: "Approve",
  sendBack: "Send back",
  reopen: "Reopen",
};

export const taskComments = defineComments(Tasks, { maxLength: 4000 });
export const taskTags = defineTags(Tasks);
export const taskHistory = defineHistory(Tasks, { keep: 50 });

export function newTaskId(): string {
  return "t_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

type Me = { id: string; tenant?: string; can(permission: string, scope?: string): boolean };

const later = (p: Promise<unknown>) => void p.catch((err) => console.error("notify:", err));

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function assignable(me: Me): { id: string; name: string }[] {
  if (!me.tenant || !me.can("access.members.read")) return [];
  const ids = [...new Set(access.members(me.id, me.tenant).map((m) => m.user))];
  return ids.map((id) => ({ id, name: nameOf(id) })).sort((a, b) => a.name.localeCompare(b.name));
}

export function createTask(me: Me, input: { title: string; assignee?: string | null; due?: string | null; notes?: string }): Task | string {
  if (!me.tenant) return "Pick a workspace first.";
  const title = input.title.trim().replace(/\s+/g, " ");
  if (title === "") return "Give the task a title.";
  if (title.length > 140) return "Keep the title under 140 characters.";
  const due = input.due ? input.due.trim() : "";
  if (due !== "" && !DAY.test(due)) return "The due date is a day such as 2026-12-01.";
  const assignee = input.assignee || null;
  if (assignee !== null && !access.memberOf(assignee, me.tenant)) return "Only members of this workspace can be given a task.";
  const task = Tasks.as(me).create({
    id: newTaskId(),
    workspace: me.tenant,
    title,
    notes: (input.notes ?? "").slice(0, 4000),
    status: "todo",
    assignee,
    owner: me.id,
    due: due || null,
    created: Date.now(),
    deleted: null,
  });
  if (!task) return "Your role does not let you add tasks here.";
  if (assignee && assignee !== me.id) tellAssigned(me, task, assignee);
  return task;
}

export function assign(me: Me, id: string, assignee: string | null): string | null {
  const t = Tasks.as(me).get(id);
  if (!t) return "That task is gone.";
  if (assignee !== null && !access.memberOf(assignee, t.workspace)) return "Only members of this workspace can be given a task.";
  if (Tasks.as(me).update((r) => r.id === id, { assignee }) === 0) return "Your role does not let you change this task.";
  if (assignee && assignee !== me.id) tellAssigned(me, t, assignee);
  return null;
}

function tellAssigned(me: Me, t: Task, to: string): void {
  later(notify.send(to, "assigned", { title: `${nameOf(me.id)} gave you ${t.title}`, url: `/app/tasks/${t.id}`, tenant: t.workspace }));
}

const MOVE_REFUSED: Record<string, string> = {
  "not found": "That task is gone.",
  "no such transition": "That step does not exist.",
  "wrong state": "Someone moved this task meanwhile.",
  "not allowed": "Your role does not let you take this step.",
  "note required": "Say why: the note goes to the person who sent it.",
  "bad note": "Keep the note under 1000 characters.",
  "changed meanwhile": "Someone changed this task meanwhile. Try again.",
};

export function moveTask(me: Me, id: string, transition: string, note?: string): string | null {
  const r = review.move(Tasks.as(me), id, transition, note ? { note } : {});
  if (!r.ok) return MOVE_REFUSED[r.reason] ?? "That did not work.";
  const t = r.row;
  if (transition === "submit") {
    for (const m of me.can("access.members.read") ? access.members(me.id, t.workspace) : []) {
      if (m.user !== me.id && access.allows(m.user, "tasks.approve", t.workspace)) {
        later(notify.send(m.user, "review", { title: `${t.title} is waiting for review`, url: `/app/tasks/${t.id}`, tenant: t.workspace }));
      }
    }
  } else if ((transition === "approve" || transition === "sendBack") && t.owner !== me.id) {
    const what = transition === "approve" ? "approved" : "sent back";
    later(notify.send(t.owner, "review", { title: `${nameOf(me.id)} ${what} ${t.title}`, body: note ?? "", url: `/app/tasks/${t.id}`, tenant: t.workspace }));
  }
  return null;
}

export function comment(me: Me, id: string, body: string): string | null {
  const text = body.trim();
  if (text === "") return "Write something first.";
  const t = Tasks.as(me).get(id);
  if (!t) return "That task is gone.";
  if (!taskComments.add(me, id, text)) return "Your role does not let you comment here.";
  for (const to of new Set([t.owner, t.assignee])) {
    if (to && to !== me.id) {
      later(notify.send(to, "comment", { title: `${nameOf(me.id)} commented on ${t.title}`, body: text.slice(0, 200), url: `/app/tasks/${t.id}`, tenant: t.workspace }));
    }
  }
  return null;
}
