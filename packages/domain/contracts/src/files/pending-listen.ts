/*
 * pending-listen/<key>.json: a queued Start listening, for the hook (extras/hooks/listen-pending.sh) to claim. The key is
 * `repo-<owner>-<name>` or `story-<id>`; `expires` is `at` plus 15 minutes (ms since the epoch). Its own file, without valibot,
 * because schemas.ts is at the package's file-length limit (as story-kinds.ts is). The hook checks every field again.
 */
export interface PendingListen {
  v: 1;
  key: string;
  repo: string | null;
  story: string | null;
  checkout: string | null;
  at: number;
  expires: number;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** The request the file holds, or null when it is not one (a different version, no key, a time that is not a number). */
export function readPendingListen(value: unknown): PendingListen | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const file = value as Record<string, unknown>;
  const { key, at, expires } = file;
  if (
    file.v !== 1 ||
    typeof key !== 'string' ||
    !Number.isFinite(at) ||
    !Number.isFinite(expires)
  ) {
    return null;
  }
  return {
    v: 1,
    key,
    repo: text(file.repo),
    story: text(file.story),
    checkout: text(file.checkout),
    at: at as number,
    expires: expires as number,
  };
}
