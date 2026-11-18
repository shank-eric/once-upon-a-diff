/*
 * Where the board gets a Claude Code session's status: Claude Code's own registry (busy or idle) plus the status hook's
 * Waiting and Done (adapters/claude-sessions/hook-status.ts, from `extras/hooks/board-status.sh`), in any terminal. Nothing
 * asks the terminal: iTerm is used only to know which sessions have a tab (so Open in iTerm and typing can reach them),
 * which adds `tab` to what the hook source says and never changes a status. A source gets the live sessions (with their
 * ttys) and answers for the ones it knows; the board uses the registry's busy/idle for the rest.
 */
import { findIt2, itermTabs } from '@once-upon-a-diff/adapters/iterm';
import {
  hookFileCount,
  readHookStatuses,
} from '@once-upon-a-diff/adapters/claude-sessions/hook-status';
import type { StatusSource } from '@once-upon-a-diff/adapters/status-source';

/** Claude Code's busy/idle alone: it adds nothing to what the board already has (what tests that want no status use). */
export const registrySource: StatusSource = {
  name: 'registry',
  statuses: async () => new Map(),
};

/** The registry's busy/idle, with the status hook's Waiting and Done where the hook has written them under `<home>/status/`. */
export function hookSource(home: string): StatusSource {
  return {
    name: 'registry',
    statuses: async (sessions) => readHookStatuses(home, sessions),
  };
}

/**
 * The hook source, with `tab` on the sessions an iTerm tab holds: a session with a tab and no hook status gets the
 * registry's busy or idle as it is, so the entry says only that it has a tab.
 */
function hookWithTabs(home: string, it2: string): StatusSource {
  const hook = hookSource(home);
  return {
    name: 'registry',
    async statuses(sessions) {
      const [hooked, tabbed] = await Promise.all([
        hook.statuses(sessions),
        itermTabs(it2, sessions),
      ]);
      const found = new Map(hooked);
      for (const live of sessions) {
        if (!tabbed.has(live.session)) {
          continue;
        }
        const said = hooked.get(live.session);
        found.set(
          live.session,
          said
            ? { ...said, tab: true }
            : {
                status: live.status === 'busy' ? 'working' : 'idle',
                detail: null,
                tab: true,
              },
        );
      }
      return found;
    },
  };
}

const NO_HOOK =
  'no status hook has written a file yet, so Waiting and Done need it: wire extras/hooks/board-status.sh (README, "Board status hook")';

/** The status source: the registry with the hook, and the iTerm tabs when the it2 CLI is found. */
export function pickSource(
  it2Path: string | null,
  home: string,
): { source: StatusSource; warning: string | null } {
  const it2 = findIt2(it2Path);
  return {
    source: it2 ? hookWithTabs(home, it2) : hookSource(home),
    warning: hookFileCount(home) === 0 ? NO_HOOK : null,
  };
}
