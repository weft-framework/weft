import { NOTICE_KIND } from "@weft-framework/runtime";
import type { Model } from "@weft-framework/data";

export interface Notice {
  text: string;
  kind?: string;
  data?: unknown;
}

export interface NotifyOptions {
  self?: boolean;
}

export class NoticeError extends Error {}

export interface SentNotice {
  text: string;
  kind: string;
  data?: unknown;
}

type Hub = (model: Model<unknown>, row: unknown, notice: SentNotice, self: boolean) => number;

const hubs = new Set<Hub>();

export function addNoticeHub(hub: Hub): () => void {
  hubs.add(hub);
  return () => void hubs.delete(hub);
}

const MAX_DATA = 4096;

export function checkNotice(n: Notice): SentNotice {
  if (typeof n !== "object" || n === null) throw new NoticeError("a notice is an object with `text`");
  const { text, kind = "info", data } = n;
  if (typeof text !== "string" || text.trim() === "") throw new NoticeError("a notice needs non-empty `text`");
  if (text.length > 500) throw new NoticeError("a notice's text is at most 500 characters");
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(text)) throw new NoticeError("a notice's text is one line of plain text");
  if (typeof kind !== "string" || !NOTICE_KIND.test(kind)) {
    throw new NoticeError("a notice's kind is lowercase letters, digits and _.- (at most 32 characters)");
  }
  if (data === undefined) return { text, kind };
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    throw new NoticeError("a notice's data must be JSON");
  }
  if (json === undefined) throw new NoticeError("a notice's data must be JSON");
  if (new TextEncoder().encode(json).length > MAX_DATA) throw new NoticeError(`a notice's data is at most ${MAX_DATA} bytes of JSON`);
  return { text, kind, data: JSON.parse(json) as unknown };
}

export function notifyReaders<T>(model: Model<T>, row: T, notice: Notice, opts: NotifyOptions = {}): number {
  if (typeof (model as { name?: unknown })?.name !== "string") throw new NoticeError("notifyReaders needs a model");
  if (typeof row !== "object" || row === null) throw new NoticeError("notifyReaders needs the row");
  const sent = checkNotice(notice);
  let n = 0;
  for (const hub of hubs) n += hub(model as Model<unknown>, row, sent, opts.self === true);
  return n;
}
