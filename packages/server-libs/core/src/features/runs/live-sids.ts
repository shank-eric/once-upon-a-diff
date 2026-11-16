/**
 * The sessions the CLI may call live when it decides a parent session's own run (`agent start --self`) has lost its session:
 * the first 8 of each live session's id from Claude Code's registry, or none when the scan cannot be trusted (the folder is
 * missing or unreadable, or a file that could not be used has a running pid, so its session is unknown, not gone). The same
 * test as the board's (board/src/stages/sessions.ts); an empty list closes nothing (registry.ts `sweep`).
 */
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { liveRegistry } from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';

export async function trustedLiveSids(home: string): Promise<string[]> {
  const { sessions, health, unknown } = await liveRegistry(readSettings(home).board.sessionsDir);
  return health.folder === 'ok' && !unknown ? sessions.map((one) => one.session.slice(0, 8)) : [];
}
