/**
 * The status line files and the status hook's files of sessions that are gone, swept: the board only reads them (adapters
 * claude-sessions/statusline.ts and hook-status.ts), so a day-old file of a session that is not live any more is removed
 * here, by `once-upon agent start` and `agent sweep`.
 */
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { liveSessions } from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import { sweepStatusLines as sweep } from '@once-upon-a-diff/adapters/claude-sessions/statusline';
import { sweepHookStatuses } from '@once-upon-a-diff/adapters/claude-sessions/hook-status';

/** Removes the day-old status line and status hook files of sessions that are not live; the removed file names. */
export async function sweepStatusLines(home: string, now = Date.now()): Promise<string[]> {
  // the live sessions are asked once, and only when some file is a day old
  let asked: Promise<Set<string>> | null = null;
  const live = () =>
    (asked ??= liveSessions(readSettings(home).board.sessionsDir).then(
      (sessions) => new Set(sessions.map((one) => one.session)),
    ));
  return [...(await sweep(home, live, now)), ...(await sweepHookStatuses(home, live, now))];
}
