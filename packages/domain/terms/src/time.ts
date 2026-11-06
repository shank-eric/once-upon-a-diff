/*
 * Dates and times as the panel and the GitHub tags show them, in the viewer's
 * own locale and time zone, and as the board shows them: how long ago something was, how long a session has been
 * on a question. No DOM or Node dependencies.
 */

const parse = (iso: string | null | undefined): Date | null => {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

/** Whole minutes from an ISO timestamp to `now` (never negative), or null when it isn't one. */
export function minutesSince(iso: string | null | undefined, now = Date.now()): number | null {
  const date = parse(iso);
  return date ? Math.max(0, Math.floor((now - date.getTime()) / 60000)) : null;
}

/**
 * The board's compact age since an ISO timestamp: "now", "5m", "3h" or "2d" (days from `daysAfterHours` on, 48 by
 * default), or '' when it isn't one. Intl.RelativeTimeFormat has no form this short, so prose like "5 minutes ago" is not built on it here.
 */
export function compactAge(
  iso: string | null | undefined,
  now = Date.now(),
  daysAfterHours = 48,
): string {
  const minutes = minutesSince(iso, now);
  if (minutes === null) {
    return '';
  }
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return minutes < daysAfterHours * 60
    ? `${Math.floor(minutes / 60)}h`
    : `${Math.floor(minutes / 1440)}d`;
}

/** "3:41 PM" for an ISO timestamp, or '' when it isn't one. */
export function clockTime(iso: string | null | undefined): string {
  const date = parse(iso);
  return date ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}

/** "10/21, 3:41 PM" for an ISO timestamp, or '' when it isn't one. */
export function shortDateTime(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) {
    return '';
  }
  return date.toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** 0:42, 12:03 or 1:02:03: how long a session has been on a question. */
export function elapsedText(millis: number): string {
  const total = Math.max(0, Math.floor(millis / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** "5m ago", or "just now" for the first minute (compactAge says "now"). */
export function ago(iso: string | null, now: number): string {
  const time = compactAge(iso, now);
  return time === 'now' ? 'just now' : time && `${time} ago`;
}

/** "3h", "5m" since an ISO time, for the Listeners lane. */
export const since = (iso: string | null, now: number) => (iso ? compactAge(iso, now) : '');
