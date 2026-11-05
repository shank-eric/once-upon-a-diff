/*
 * Time as text for the board and the panel, over the protocol's `compactAge`: how long ago something was, how long a
 * session has been on a question.
 */
import { compactAge } from '@once-upon-a-diff/domain/time';

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
