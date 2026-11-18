/**
 * What Claude Code's hooks know and the registry doesn't: that a session is waiting on you, or finished. The hook script
 * (`extras/hooks/board-status.sh`) writes `<home>/status/<session id>.json` on each event:
 *
 *   {session_id, at (ms since the epoch), state: "working" | "waiting" | "done", detail (the question, or null), event}
 *
 * The registry stays the arbiter of busy and idle, so a file is trusted only while it agrees with it (there is no clock
 * expiry: a session can honestly wait for hours). The hook and Claude Code share this Mac's clock, so `at` and the
 * registry's `statusAt` compare directly, with a few seconds of margin for the two changing at the same moment:
 *
 * - a session that is not live: ignored.
 * - `working`: ignored (busy already shows as working; a working file under an idle registry is a crashed turn).
 * - `waiting`: shown unless the registry changed after the file was written (a new turn began, so the file is old).
 * - `done`: shown only while the registry is not busy and has not changed since (a turn with no prompt hook is busy).
 *
 * Reading changes nothing; a gone session's file is swept a day later (`sweepHookStatuses`, run by `agent start` and
 * `agent sweep`), and the hook's SessionEnd removes it at once.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SourceStatus } from '../status-source.ts';
import type { LiveSession } from './live-sessions.ts';
import { sweepSessionFiles } from './statusline.ts';

/** The registry's change and the hook's write can land in either order within this long. */
const SKEW_MS = 5000;
const DETAIL_MAX = 300;

/** The hook-reported Waiting and Done of the live sessions, by session id. */
export function readHookStatuses(home: string, sessions: LiveSession[]): Map<string, SourceStatus> {
  const found = new Map<string, SourceStatus>();
  for (const live of sessions) {
    if (!/^[A-Za-z0-9-]+$/.test(live.session)) {
      continue;
    }
    let file: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(path.join(home, 'status', `${live.session}.json`), 'utf8'),
      );
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }
      file = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const wroteAt = typeof file.at === 'number' && Number.isFinite(file.at) ? file.at : null;
    if (wroteAt === null || (file.state !== 'waiting' && file.state !== 'done')) {
      continue;
    }
    const current = live.statusAt === null || wroteAt >= live.statusAt - SKEW_MS;
    if (!current || (file.state === 'done' && live.status === 'busy')) {
      continue;
    }
    found.set(live.session, {
      status: file.state,
      detail:
        typeof file.detail === 'string' && file.detail ? file.detail.slice(0, DETAIL_MAX) : null,
    });
  }
  return found;
}

/** Whether the hook has written a status file for this session, whatever it says. */
export function hasHookFile(home: string, session: string): boolean {
  return (
    /^[A-Za-z0-9-]+$/.test(session) && existsSync(path.join(home, 'status', `${session}.json`))
  );
}

/** How many status files the hook has written (a gone session's, not yet swept, counts): 0 means it is not installed. */
export function hookFileCount(home: string): number {
  try {
    return readdirSync(path.join(home, 'status')).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/** Removes the day-old status files of sessions that are not live; the removed file names. */
export function sweepHookStatuses(
  home: string,
  live: () => Promise<Set<string>>,
  nowMs: number,
): Promise<string[]> {
  return sweepSessionFiles(home, 'status', live, nowMs);
}
