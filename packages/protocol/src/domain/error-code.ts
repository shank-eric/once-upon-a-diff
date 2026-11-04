/*
 * The code a bridge error carries beside its message, so a caller decides what to do from the code and never from the
 * message's words. The bridge answers every non-2xx with `{error, code}`. Most codes follow the HTTP status
 * (`codeOfStatus`); the exception is `no_route`, a 404 for a path the bridge has no route for, which is how a panel finds
 * out the bridge is older than it. An older bridge sends no code, so `replyCode` falls back on the status.
 */

export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'no_route',
  'bad_request',
  'method_not_allowed',
  'conflict',
  'rate_limited',
  'bad_gateway',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The code for an HTTP status, when the bridge names none. */
export function codeOfStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 413:
    case 415:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
    case 421:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 405:
      return 'method_not_allowed';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    case 502:
      return 'bad_gateway';
    default:
      return 'internal';
  }
}

const isCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);

/**
 * The code of a failed reply: the bridge's own `body.code` when it is one we know, else the status's.
 */
export function replyCode(reply: { status: number; body?: unknown }): ErrorCode {
  const sent = (reply.body as { code?: unknown } | null | undefined)?.code;
  return isCode(sent) ? sent : codeOfStatus(reply.status);
}

/** Whether the failed reply carries a code the bridge sent (a newer bridge), not one worked out from its status. An older bridge's 404 can be a route miss. */
export const hasCode = (reply: { body?: unknown }): boolean =>
  isCode((reply.body as { code?: unknown } | null | undefined)?.code);
