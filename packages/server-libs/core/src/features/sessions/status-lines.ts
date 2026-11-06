/**
 * The status line files of sessions that are gone, swept: the board only reads them (adapters claude-sessions/statusline.ts),
 * so a day-old file of a session that is not live any more is removed here, by `once-upon agent start` and `agent sweep`.
 */
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { liveSessions } from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import { sweepStatusLines as sweep } from '@once-upon-a-diff/adapters/claude-sessions/statusline';

/** Removes the day-old status line files of sessions that are not live; the removed file names. */
export function sweepStatusLines(home: string, now = Date.now()): Promise<string[]> {
  return sweep(
    home,
    async () =>
      new Set((await liveSessions(readSettings(home).board.sessionsDir)).map((one) => one.session)),
    now,
  );
}
