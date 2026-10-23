/*
 * Dates and times as the panel and the GitHub tags show them, in the viewer's
 * own locale and time zone. No DOM or Node dependencies.
 */

const parse = (iso: string | null | undefined): Date | null => {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

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
