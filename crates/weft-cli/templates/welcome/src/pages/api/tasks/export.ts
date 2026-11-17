import { toCsv } from "@weft/data";
import type { PageContext } from "@weft/server";
import { Tasks, STATUS_LABEL } from "../../../lib/tasks.ts";
import { meOf } from "../../../lib/workspaces.ts";
import { userById } from "../../../lib/users.ts";

export function GET(ctx: PageContext): Response {
  const me = meOf(ctx);
  if (!me?.tenant || !me.can("tasks.read")) return new Response("Sign in to a workspace first.", { status: 403 });
  const rows = Tasks.as(me)
    .all()
    .sort((a, b) => a.created - b.created)
    .map((t) => ({
      title: t.title,
      status: STATUS_LABEL[t.status] ?? t.status,
      assignee: t.assignee ? (userById(t.assignee)?.email ?? "") : "",
      due: t.due ?? "",
      notes: t.notes,
      created: new Date(t.created),
    }));
  const csv = toCsv(rows, ["title", "status", "assignee", "due", "notes", "created"], { bom: true });
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="tasks-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
