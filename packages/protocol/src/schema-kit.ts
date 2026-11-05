/*
 * The field readers the area schemas share: a string cut to a length, a whole number from a number or a numeric string, a
 * flag, a session id, and lists the bridge caps. Server side only: it imports valibot.
 */
import {
  array,
  boolean,
  fallback,
  nullable,
  number,
  optional,
  pipe,
  regex,
  string,
  transform,
  union,
} from 'valibot';
import { SESSION_RE } from './domain/patterns.ts';

/** The ids and lists the bridge caps, so a body can't make it hold more. */
export const MAX_IDS = 500;
export const MAX_LIST = 100;

/** A string cut to `max`, null for none (a missing value, or null). */
export const clipped = (max: number) =>
  optional(
    pipe(
      nullable(string()),
      transform((value): string | null => (value == null ? null : value.slice(0, max))),
    ),
    null,
  );

/** A number or a numeric string as a whole number, null for anything else (and for none). */
export const toWhole = (value: number | string | null): number | null => {
  if (value == null) {
    return null;
  }
  return Number.isFinite(+value) ? Math.trunc(+value) : null;
};

/** A whole number from a number or a numeric string, null for anything else. */
export const whole = optional(
  pipe(nullable(union([number(), string()])), transform(toWhole)),
  null,
);

/** `true` or `false`, and `false` for anything else (and when missing). */
export const flag = optional(fallback(boolean(), false), false);

/** A Claude Code session id. */
export const sessionId = pipe(string(), regex(SESSION_RE));

/** A list of strings, or one string, as a list: empty ones dropped, at most MAX_LIST. */
export const names = optional(
  fallback(
    pipe(
      union([string(), array(string())]),
      transform((value) =>
        (Array.isArray(value) ? value : [value]).filter((one) => one !== '').slice(0, MAX_LIST),
      ),
    ),
    [],
  ),
  [],
);

/** Ids as a list, at most MAX_IDS. */
export const ids = pipe(
  array(string()),
  transform((list) => list.slice(0, MAX_IDS)),
);
