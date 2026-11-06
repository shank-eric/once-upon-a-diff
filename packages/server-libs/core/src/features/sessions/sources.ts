/*
 * Where the board gets a Claude Code session's status. Claude Code's own registry only says busy or idle, so a status
 * source can say more: it gets the live sessions (with their ttys) and answers with a status and detail for the ones it
 * knows, and the board uses the registry's busy/idle for the rest. Two are built in: `iterm` (adapters/iterm.ts) and
 * `registry`, which adds nothing: busy is working, idle is idle. pickSource chooses between them from the settings.
 */
import { findIt2, itermSource } from '@once-upon-a-diff/adapters/iterm';
import type { StatusSource } from '@once-upon-a-diff/adapters/status-source';

export const registrySource: StatusSource = {
  name: 'registry',
  statuses: async () => new Map(),
};

/** The source the settings ask for: iterm when the it2 CLI is there (and not overridden), else the registry. */
export function pickSource(
  wanted: 'iterm' | 'registry' | null,
  it2Path: string | null,
): { source: StatusSource; warning: string | null } {
  const it2 = wanted === 'registry' ? null : findIt2(it2Path);
  if (it2) {
    return { source: itermSource(it2), warning: null };
  }
  return {
    source: registrySource,
    warning:
      wanted === 'iterm'
        ? 'the it2 CLI was not found, so status is Claude Code busy or idle only'
        : null,
  };
}
