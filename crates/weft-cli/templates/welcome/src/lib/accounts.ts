import {
  defineAccount,
  definePasskeys,
  defineTwoFactor,
  emailSignIn,
  SqlAccountTokenStore,
  SqlEmailTokenStore,
  SqlPasskeyStore,
  SqlTwoFactorStore,
} from "@weft/server";
import { db } from "./db.ts";
import { appKey, appName, appUrl } from "./env.ts";
import { accountMail, send } from "./mail.ts";
import { createUser, setEmail, setPassword, userByEmail, userById } from "./users.ts";

export const account = defineAccount({
  url: appUrl,
  send: accountMail,
  findUser: (email) => userByEmail(email)?.id ?? null,
  emailOf: (user) => userById(user)?.email ?? null,
  setPassword,
  setEmail,
  createUser: (email, hash) => createUser(email, hash).id,
  markVerified: () => undefined,
  signUpPage: "/sign-up/confirm",
  resetPage: "/reset-password",
  emailPage: "/app/account/email",
  minPasswordLength: 10,
  store: new SqlAccountTokenStore(db),
});

export const email = emailSignIn({
  url: appUrl,
  page: "/sign-in/confirm",
  allow: (address) => userByEmail(address) !== null,
  send: ({ email: to, link, code }) =>
    send(to, `Sign in to ${appName}`, [`Open this link to sign in:`, link, "", `Or type this code on the sign-in page: ${code}`, "", "It works once, for 15 minutes."]),
  store: new SqlEmailTokenStore(db),
});

export const twoFactor = defineTwoFactor({
  key: appKey,
  issuer: appName,
  page: "/sign-in/two-factor",
  store: new SqlTwoFactorStore(db),
});

export const passkeys = definePasskeys({ url: appUrl, name: appName, store: new SqlPasskeyStore(db) });
