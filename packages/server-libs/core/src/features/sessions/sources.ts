/*
 * Where the board gets a Claude Code session's status. Claude Code's own registry only says busy or idle, so a status
 * source can say more: it gets the live sessions (with their ttys) and answers with a status and detail for the ones it
 * knows, and the board uses the registry's busy/idle for the rest. Two are built in: `registry`, the default, which adds
 * the status hook's Waiting and Done (adapters/claude-sessions/hook-status.ts, from `extras/hooks/board-status.sh`) in any
 * terminal, and `iterm` (adapters/iterm.ts), the iTerm2 tab's own status, which `board_status_source: "iterm"` asks for.
 * With it2 found, the default registry source also asks iTerm about the sessions the hook has not written for, so a
 * Mac with no hook installed loses nothing (the hook wins where it wrote; the tab still gives titles and task counts).
 * pickSource chooses between them from the settings. Typing into a tab and raising it need iTerm whatever the source.
 */
import { findIt2, itermSource } from '@once-upon-a-diff/adapters/iterm';
import {
  hasHookFile,
  hookFileCount,
  readHookStatuses,
} from '@once-upon-a-diff/adapters/claude-sessions/hook-status';
import type { SourceStatus, StatusSource } from '@once-upon-a-diff/adapters/status-source';

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
 * The hook source, with iTerm's tab status for what the hook has not written: a session with no status file gets its tab's
 * status as it is; one with a file gets the hook's Waiting or Done, or the registry's busy or idle when the file says
 * working, and in both the tab's title and task count, and `tab`.
 */
function hookWithIterm(home: string, it2: string): StatusSource {
  const hook = hookSource(home);
  const tabs = itermSource(it2);
  return {
    name: 'registry',
    async statuses(sessions) {
      const [hooked, tabbed] = await Promise.all([
        hook.statuses(sessions),
        tabs.statuses(sessions),
      ]);
      const found = new Map<string, SourceStatus>();
      for (const live of sessions) {
        const said = hooked.get(live.session);
        const tab = tabbed.get(live.session);
        if (said) {
          found.set(live.session, {
            ...said,
            tasks: tab?.tasks ?? null,
            title: tab?.title ?? null,
            tab: tab?.tab,
          });
        } else if (tab && hasHookFile(home, live.session)) {
          found.set(live.session, {
            ...tab,
            status: live.status === 'busy' ? 'working' : 'idle',
            detail: null,
          });
        } else if (tab) {
          found.set(live.session, tab);
        }
      }
      return found;
    },
  };
}

const noHook = (fallback: boolean) =>
  `no status hook has written a file yet, so Waiting and Done ${fallback ? "come from iTerm's tab status only" : 'need it'}: wire extras/hooks/board-status.sh (README, "Board status hook")`;

/** The source the settings ask for: iterm only when asked for and the it2 CLI is there, else the registry with the hook. */
export function pickSource(
  wanted: 'iterm' | 'registry' | null,
  it2Path: string | null,
  home: string,
): { source: StatusSource; warning: string | null } {
  const it2 = wanted === 'iterm' ? findIt2(it2Path) : null;
  if (it2) {
    return { source: itermSource(it2), warning: null };
  }
  const missing =
    wanted === 'iterm'
      ? 'the it2 CLI was not found, so status is Claude Code busy or idle only, plus the status hook'
      : null;
  const tabs = wanted === null ? findIt2(it2Path) : null;
  const notice = hookFileCount(home) === 0 ? noHook(tabs !== null) : null;
  return {
    source: tabs ? hookWithIterm(home, tabs) : hookSource(home),
    warning: [missing, notice].filter(Boolean).join('; ') || null,
  };
}
