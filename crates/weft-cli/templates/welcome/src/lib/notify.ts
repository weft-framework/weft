import { defineNotifications } from "@weft-framework/core/notifications";
import { appUrl } from "./env.ts";
import { send } from "./mail.ts";
import { userById } from "./users.ts";

const link = (url: string | null) => (url ? (url.startsWith("/") ? appUrl + url : url) : "");

export const notify = defineNotifications({
  types: {
    assigned: { label: "Tasks given to you", channels: { inApp: "instant", email: "instant" } },
    review: { label: "Tasks waiting for your review", channels: { inApp: "instant", email: "daily" } },
    comment: { label: "Comments on your tasks", channels: { inApp: "instant", email: "daily" } },
    booking: { label: "Room bookings and reminders", channels: { inApp: "instant", email: "instant" } },
    security: {
      label: "Account security",
      description: "New sign-in methods and second-factor changes.",
      channels: { inApp: "instant", email: "instant" },
      locked: ["email"],
    },
  },
  channels: {
    email: {
      label: "Email",
      send: ({ user, notification: n }) => {
        const to = userById(user)?.email;
        return to ? send(to, n.title, [n.body, link(n.url)].filter(Boolean)) : undefined;
      },
      digest: ({ user, notifications }) => {
        const to = userById(user)?.email;
        if (!to) return;
        const lines = notifications.flatMap((n) => [`- ${n.title}`, ...(n.url ? [`  ${link(n.url)}`] : [])]);
        return send(to, `${notifications.length} update${notifications.length === 1 ? "" : "s"}`, lines);
      },
    },
  },
});
