import { createJobs, defineJob, SqlJobStore, type Jobs } from "@weft-framework/server/jobs";
import { access } from "../access.ts";
import { db } from "./db.ts";
import { notify } from "./notify.ts";
import { bookings } from "./rooms.ts";
import { Notes } from "./notes.ts";
import { Tasks } from "./tasks.ts";

const MONTH = 30 * 24 * 3600_000;

export const dailyDigest = defineJob("dailyDigest", [], () => notify.digest("daily").then(() => undefined));
export const emptyTrash = defineJob("emptyTrash", [], () => {
  Tasks.purgeTrash(Date.now() - MONTH);
  Notes.purgeTrash(Date.now() - MONTH);
  notify.prune();
});

export const jobs: Jobs = createJobs({
  jobs: [bookings.job, dailyDigest, emptyTrash],
  store: new SqlJobStore(db),
  user: (id, tenant) => (tenant ? access.user(id).in(tenant) : access.user(id)),
  schedule: [
    { cron: "0 7 * * *", job: dailyDigest },
    { cron: "30 3 * * *", job: emptyTrash },
  ],
});
bookings.use(jobs);

const KEY = Symbol.for("app.jobs");
const slot = globalThis as { [KEY]?: Jobs };
void slot[KEY]?.stop();
slot[KEY] = jobs;
jobs.start();
