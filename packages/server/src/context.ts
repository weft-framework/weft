import type { Params } from "./router.ts";

export interface PageContext {
  request: Request;
  url: URL;
  params: Params;
  query: URLSearchParams;
  session: string;
  user: unknown;
  clientAddress?: string | null;
}
