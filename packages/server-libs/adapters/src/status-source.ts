/*
 * What a session-status source implements. A source gets the live sessions (with their ttys) and answers with a status
 * and detail for the ones it knows: the status hook (adapters/claude-sessions/hook-status.ts) is the one, and the board
 * uses Claude Code's registry busy/idle for the rest (core/src/features/sessions/sources.ts).
 */
import type { BoardStatus } from '@once-upon-a-diff/contracts/types';
import type { LiveSession } from './claude-sessions/live-sessions.ts';

/** What a source knows about one session. */
export interface SourceStatus {
  status: BoardStatus;
  detail: string | null;
  /** an iTerm2 tab holds this session (iTerm knows its tty): Open in iTerm and typing can reach it */
  tab?: boolean;
}

export interface StatusSource {
  name: 'registry';
  /** Statuses by session id. Never rejects: a source that can't answer gives an empty map. */
  statuses(sessions: LiveSession[]): Promise<Map<string, SourceStatus>>;
}
