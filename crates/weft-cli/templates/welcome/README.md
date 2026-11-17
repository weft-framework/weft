# {{name}}

A [Weft](https://github.com/weft-framework/weft) application: a team workspace with
tasks, notes, chat, room booking, people and roles, and accounts with
passkeys and two-factor. It is a real app, not a demo, so read it, change it
and delete what you do not need.

## Develop

```sh
npm install
npm run dev
```

The development server compiles `src/`, serves the app at
<http://localhost:3000> and updates open pages when a file changes. Press
Alt+Shift+D in the browser for the dev overlay: the page's components,
live messages, data reads and access decisions.

Create an account at `/sign-up`. Mail the app sends (confirmation links,
invites, reminders) is kept in memory while you develop and listed at
<http://localhost:3000/_weft/dev/mail>. To see the live parts work, sign up
as a second person in a private window and invite them from People.

## What is where

| Area | Pages | Built with |
| --- | --- | --- |
| Signing in | `src/pages/sign-in`, `sign-up`, `forgot-password` | `login`, magic links and codes, passkeys, rate limits |
| Tasks | `src/pages/app/tasks` | `defineModel` rules, `defineWorkflow`, row history, presence, the audit hook, CSV |
| Notes | `src/pages/app/notes`, `src/pages/shared` | rich text, signed share links |
| Chat | `src/pages/app/chat.wx` | `@weft-framework/server/chat` |
| Rooms | `src/pages/app/rooms.wx` | `@weft-framework/server/calendar`, jobs, mail |
| People and roles | `src/pages/app/team.wx`, `src/pages/invite.wx` | `@weft-framework/core` memberships, roles, invites, seats |
| Your account | `src/pages/app/account` | two-factor, passkeys, sessions, notification preferences |
| Workspace settings | `src/pages/app/settings.wx` | `@weft-framework/core` tenant settings |

Access is decided in one place: `src/access.ts` (roles and permissions) and
the rules on each model (`src/lib`, `src/models`). The pages ask; they never decide.

## Layout

| Path | Purpose |
| --- | --- |
| `src/pages/` | Routes. `index.wx` is `/`, `app/team.wx` is `/app/team`, `shared/[id].wx` matches `/shared/<anything>`. |
| `src/pages/_layout.wx` | Wraps every page; receives the page as `children`. |
| `src/components/AppShell.wx` | The frame around every page under `/app`. |
| `src/components/ui/` | The component library, copied in by `weft add`. Your code now. |
| `src/lib/` | Models, rules and the app's services (mail, jobs, notifications). |
| `src/theme.ts` | Colours and radius for light and dark; every component follows it. |
| `src/app.css` | Global styles, compiled with Tailwind. |
| `data/` | The SQLite database and the development key. Git-ignored. |
| `public/` | Static files served at `/`. |

## Production

Set these before `NODE_ENV=production`; the app refuses to start without
them:

| Variable | What it is |
| --- | --- |
| `APP_URL` | The public address, used in links sent by email. |
| `APP_KEY` | A long random secret. It encrypts two-factor secrets, so keep it. |
| `SMTP_HOST` | The mail server (also `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`). |

`weft doctor` checks the project and this machine are set up correctly.
