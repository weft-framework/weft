import { defineMail, Outbox, renderTemplate, smtp, type MailTransport } from "@weft-framework/server/mail";
import type { AccountMessage } from "@weft-framework/server";
import { appName, production } from "./env.ts";
import * as confirmAccount from "../emails/confirm-account.wx";

function transport(): MailTransport {
  const host = process.env.SMTP_HOST;
  if (host) {
    return smtp({
      host,
      port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
      ...(process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } : {}),
    });
  }
  if (production) throw new Error("set SMTP_HOST to send email (see README.md)");
  return new Outbox();
}

export const mail = defineMail({ transport: transport(), from: process.env.MAIL_FROM ?? `${appName} <no-reply@localhost>` });

export async function send(to: string, subject: string, lines: string[]): Promise<void> {
  await mail.send({ to, subject, text: lines.join("\n") + `\n\n-- \n${appName}\n` });
}

const minutes = (at: number | Date) => Math.max(1, Math.round((+at - Date.now()) / 60_000));

export function accountMail(m: AccountMessage): Promise<void> {
  switch (m.kind) {
    case "sign-up": {
      const template = { component: confirmAccount.ConfirmAccount, subject: confirmAccount.subject };
      const { html, text, subject } = renderTemplate(template, { app: appName, link: m.link, minutes: minutes(m.expires) });
      return mail.send({ to: m.to, subject: subject!, html, text }).then(() => {});
    }
    case "account-exists":
      return send(m.to, `You already have a ${appName} account`, [
        "Someone tried to sign up with this address, which already has an account.",
        "If it was you, sign in instead (or reset your password). Otherwise, ignore this message.",
      ]);
    case "password-reset":
      return send(m.to, "Reset your password", [
        "Open this link to choose a new password:",
        m.link,
        `It works once, for ${minutes(m.expires)} minutes. If you did not ask, ignore this message: your password stays as it is.`,
      ]);
    case "password-changed":
      return send(m.to, "Your password was changed", ["Your password was changed and every session was signed out.", "If this was not you, reset your password now."]);
    case "email-change":
      return send(m.to, "Confirm your new address", ["Open this link while signed in to use this address for your account:", m.link]);
    case "email-changed":
      return send(m.to, "Your address was changed", [`Your account now uses ${m.newEmail}.`, "If this was not you, reply to this message."]);
    case "verify-email":
      return send(m.to, "Confirm your address", ["Open this link while signed in to confirm this address:", m.link]);
  }
}
