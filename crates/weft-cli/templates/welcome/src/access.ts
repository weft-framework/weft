import { defineAccess } from "@weft-framework/core";

export const access = defineAccess({
  scopes: { workspace: { label: "Workspace" } },
  permissions: {
    "tasks.read": "See tasks",
    "tasks.edit": { label: "Create and change tasks", description: "Write tasks, comment, tag and move them up to review." },
    "tasks.approve": { label: "Approve tasks", description: "Move a task out of review: approve it or send it back." },
    "notes.read": "Read notes",
    "notes.edit": "Write notes",
    "chat.use": "Message other members",
    "calendar.book": "Book rooms",
    "calendar.manage": { label: "Manage rooms", description: "See, move and cancel everyone's bookings." },
    "billing.view": "See the plan and usage",
  },
  roles: {
    owner: { scope: "workspace", permissions: ["*"], label: "Owner", description: "Everything, including deleting the workspace." },
    admin: {
      scope: "workspace",
      label: "Admin",
      description: "Runs the workspace: members, settings, approvals and rooms.",
      includes: ["member"],
      permissions: ["tasks.approve", "calendar.manage", "billing.view", "access.members.manage", "access.roles.manage", "access.settings.manage"],
    },
    member: {
      scope: "workspace",
      label: "Member",
      description: "Works in the workspace.",
      permissions: ["tasks.read", "tasks.edit", "notes.read", "notes.edit", "chat.use", "calendar.book", "access.members.read"],
    },
    guest: { scope: "workspace", label: "Guest", description: "Reads tasks and notes, and chats.", permissions: ["tasks.read", "notes.read", "chat.use"] },
  },
  owner: "owner",
  custom: { roles: { max: 20 } },
  settings: {
    "tasks.review": {
      type: "boolean",
      default: true,
      editable: true,
      label: "Review before done",
      description: "Finished tasks wait in review until someone who may approve them does.",
    },
    "calendar.hours": {
      type: "string",
      default: "09:00-18:00",
      options: ["08:00-17:00", "09:00-18:00", "10:00-19:00"],
      editable: true,
      label: "Room hours",
    },
    "calendar.zone": { type: "string", default: "Europe/Prague", maxLength: 64, editable: true, label: "Time zone" },
    seats: { type: "number", default: 10, min: 1, max: 500, integer: true, label: "Seats" },
  },
  seats: "seats",
  invites: { ttlMs: 7 * 24 * 3600_000 },
});

export type Permission = Parameters<ReturnType<typeof access.user>["can"]>[0];
