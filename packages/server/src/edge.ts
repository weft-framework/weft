import { createApp, type AppOptions } from "./app.ts";

export type EdgeOptions = Omit<AppOptions, "transports" | "sync">;

export function edgeHandler(opts: EdgeOptions): (req: Request) => Promise<Response> {
  const app = createApp({ ...opts, transports: [], sync: false });
  return async (req) => {
    return (await app.fetch(req)) ?? new Response("Upgrade Required", { status: 426 });
  };
}
