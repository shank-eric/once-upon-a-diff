/*
 * What every session-status source implements. A source gets the live sessions (with their ttys) and answers with a
 * status and detail for the ones it knows: iTerm2 (adapters/iterm.ts) and the session registry (core/src/features/sessions) are
 * two of them, and another terminal or status line is one more object with the StatusSource shape.
 */
import type { BoardStatus } from '@once-upon-a-diff/contracts/types';
import type { LiveSession } from './claude-sessions/live-sessions.ts';

/** What a source knows about one session. */
export interface SourceStatus {
  status: BoardStatus;
  detail: string | null;
  /** the background tasks the session has running, as iTerm's status counts them (`background_tasks`); null when it doesn't say */
  tasks: number | null;
  /** a better title than the registry's derived name, such as the terminal tab's */
  title: string | null;
}

export interface StatusSource {
  name: 'iterm' | 'registry';
  /** Statuses by session id. Never rejects: a source that can't answer gives an empty map. */
  statuses(sessions: LiveSession[]): Promise<Map<string, SourceStatus>>;
}
