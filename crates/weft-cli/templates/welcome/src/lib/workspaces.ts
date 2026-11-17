import { defineWizard, SqlDraftStore } from "@weft-framework/server/wizard";
import { redirect, switchTenant, type PageContext } from "@weft-framework/server";
import type { Principal } from "@weft-framework/core";
import { access } from "../access.ts";
import { db } from "./db.ts";
import { appUrl } from "./env.ts";
import { send } from "./mail.ts";
import { nameOf } from "./users.ts";

export type RoleId = Parameters<typeof access.assign>[1]["role"];

export type Me = Principal<string, Record<string, unknown>> & { tenant?: string };

export const meOf = (ctx: PageContext) => (ctx.user as Me | null) ?? null;

export function workspaceOf(ctx: PageContext): { id: string; name: string } | null {
  const me = meOf(ctx);
  if (!me?.tenant) return null;
  const t = me.tenants().find((w) => w.id === me.tenant);
  return t ? { id: t.id, name: t.name } : null;
}

export type Gate =
  | { ok: true; me: Me; workspace: { id: string; name: string } }
  | { ok: false; redirect: ReturnType<typeof redirect> };

export function gate(ctx: PageContext, permission?: string): Gate {
  const me = meOf(ctx);
  if (!me) return { ok: false, redirect: redirect("/sign-in?next=" + encodeURIComponent(ctx.url.pathname + ctx.url.search)) };
  const workspace = workspaceOf(ctx);
  if (!workspace) return { ok: false, redirect: redirect("/app/welcome") };
  if (permission && !me.can(permission)) return { ok: false, redirect: redirect("/app") };
  return { ok: true, me, workspace };
}

export const ZONES = ["Europe/Prague", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney", "UTC"];

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const emailsIn = (text: string) =>
  [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];

export async function invite(by: string, workspace: string, email: string, role: RoleId): Promise<void> {
  const { token } = await access.createInvite(by, { scope: workspace, role, email });
  const name = access.tenantsOf(by).find((t) => t.id === workspace)?.name ?? "a workspace";
  await send(email, `${nameOf(by)} invited you to ${name}`, [
    `${nameOf(by)} invited you to join ${name}.`,
    "Open this link to accept (sign up first with this address if you have no account):",
    `${appUrl}/invite?token=${encodeURIComponent(token)}`,
    "It works once and expires in 7 days.",
  ]);
}

export const onboarding = defineWizard({
  name: "onboarding",
  store: new SqlDraftStore(db),
  steps: [
    {
      id: "workspace",
      label: "Workspace",
      fields: {
        name: { type: "text", label: "Workspace name", required: true, maxLength: 60, placeholder: "Acme design team" },
        kind: { type: "choice", label: "What is it for", options: ["A team", "A project", "Just me"], required: true },
      },
    },
    {
      id: "habits",
      label: "How you work",
      fields: {
        review: {
          type: "boolean",
          label: "Review tasks before they are done",
          description: "Finished tasks wait for someone who may approve them.",
        },
        zone: { type: "choice", label: "Time zone for the rooms", options: ZONES, required: true },
      },
    },
    {
      id: "people",
      label: "People",
      when: (all) => all.kind !== "Just me",
      fields: {
        invites: {
          type: "textarea",
          label: "Invite people",
          description: "Email addresses, one per line or separated by commas. Each gets a link to join as a member.",
          maxLength: 2000,
        },
      },
      check: (v) => {
        const bad = emailsIn(String(v.invites ?? "")).filter((e) => !EMAIL.test(e));
        if (bad.length) return { invites: `Not an email address: ${bad.slice(0, 3).join(", ")}` };
        if (emailsIn(String(v.invites ?? "")).length > 20) return { invites: "Invite at most 20 people at once" };
      },
    },
  ],
  complete: async (ctx, v) => {
    const me = meOf(ctx);
    if (!me) throw new Error("signed out");
    const ws = access.createTenant(me.id, { name: String(v.name), type: "workspace" });
    access.configureTenant(ws.id, { "tasks.review": v.review === true, "calendar.zone": String(v.zone) });
    for (const email of emailsIn(String(v.invites ?? ""))) await invite(me.id, ws.id, email, "member");
    await switchTenant(ctx, ws.id);
    return ws.id;
  },
});
