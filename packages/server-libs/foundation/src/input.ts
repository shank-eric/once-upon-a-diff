/*
 * Checks on the text and numbers a caller hands in (the backlog's and the agent registry's inputs): control
 * characters out, a length cap, an optional value matched to a pattern, a whole number. Each throws a plain Error
 * the CLI and the routes show as is.
 */

/** The longest a free-text field is when its caller gives no other limit. */
export const TEXT_MAX = 1000;

/** Text with control characters out (`multiline` keeps newlines), trimmed, or an error when too long. Empty gives ''. */
export function clean(value: unknown, what: string, max = TEXT_MAX, multiline = false): string {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  if (text.length > max) {
    throw new Error(`${what} is longer than ${max} characters`);
  }
  return text;
}

/** The trimmed text, null when empty, or an error when it doesn't match the pattern. */
export function optional(value: unknown, what: string, pattern: RegExp): string | null {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  if (!pattern.test(text)) {
    throw new Error(`${what} "${text.slice(0, 60)}" is not valid`);
  }
  return text;
}

/** A whole number from 0 to `max`, null when none was given, or an error. */
export function count(value: unknown, what: string, max = 100000): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) {
    throw new Error(`${what} must be a whole number`);
  }
  return number;
}
