export type AccessErrorCode =
  | "forbidden"
  | "not-found"
  | "invalid"
  | "conflict"
  | "last-owner"
  | "limit"
  | "expired";

export class AccessError extends Error {
  readonly code: AccessErrorCode;

  constructor(code: AccessErrorCode, message: string) {
    super(message);
    this.name = "AccessError";
    this.code = code;
  }
}

export function isAccessError(e: unknown, code?: AccessErrorCode): e is AccessError {
  return e instanceof AccessError && (code === undefined || e.code === code);
}
