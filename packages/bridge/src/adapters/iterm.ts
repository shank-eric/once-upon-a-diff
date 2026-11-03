/*
 * iTerm2, through its `it2` CLI: a tab's status for the board, typing a line into a tab, and raising a tab. Nothing here
 * decides what to type or which session may take it (services/sessions does); this only talks to iTerm.
 *
 *   iterm     iTerm2's per-tab status (`it2 session get-status`: working, waiting, done, error, idle, with a detail
 *             line), matched to a session by its tty. A Stop hook that sets the tab's status to "waiting" when a reply
 *             hands back to you is what makes the waiting column work.
 *
 * A status source gets the live sessions (with their ttys) and answers with a status and detail for the ones it knows.
 * Another terminal or status line is one more object with the StatusSource shape.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardStatus } from '@once-upon-a-diff/protocol/types';
import { run } from './os.ts';
import type { LiveSession } from './claude-sessions/registry.ts';

/** What a source knows about one session. */
export interface SourceStatus {
  status: BoardStatus;
  detail: string | null;
  /** a better title than the registry's derived name, such as the terminal tab's */
  title: string | null;
}

export interface StatusSource {
  name: 'iterm' | 'registry';
  /** Statuses by session id. Never rejects: a source that can't answer gives an empty map. */
  statuses(sessions: LiveSession[]): Promise<Map<string, SourceStatus>>;
}

/** Tab names that say nothing about the work, so the registry's name is the better title. */
const GENERIC_TITLES = new Set([
  '',
  'claude',
  'claude code',
  'zsh',
  '-zsh',
  'bash',
  '-bash',
  'node',
  'sh',
]);

/** A tab name iTerm cut short ("..e-upon-a-diff", "Long title…"), which says less than the session's own name. */
const TRUNCATED_TITLE = /^\.{2}|…$/;

const STATUSES: BoardStatus[] = ['working', 'waiting', 'done', 'error', 'idle'];

const asStatus = (value: unknown): BoardStatus | null =>
  STATUSES.includes(value as BoardStatus) ? (value as BoardStatus) : null;

/** The it2 CLI: the setting's path, else the one in iTerm2's app folders, else `it2` on PATH when it answers. */
export function findIt2(configured: string | null): string | null {
  const candidates = [
    configured,
    path.join(os.homedir(), 'Applications/iTerm.app/Contents/Resources/utilities/it2'),
    '/Applications/iTerm.app/Contents/Resources/utilities/it2',
  ];
  return candidates.find((file): file is string => !!file && existsSync(file)) || null;
}

/** "/dev/ttys004", "\/dev\/ttys004" or "ttys004" as "ttys004". */
const ttyName = (tty: string | null | undefined) =>
  String(tty || '')
    .replace(/\\/g, '')
    .replace(/^\/dev\//, '');

export function itermSource(it2: string): StatusSource {
  return {
    name: 'iterm',
    async statuses(sessions) {
      const found = new Map<string, SourceStatus>();
      const listing = await run(it2, ['session', 'list', '--json']);
      if (!listing) {
        return found;
      }
      let tabs: { id?: string; name?: string; tty?: string }[];
      try {
        const parsed: unknown = JSON.parse(listing);
        // `null` or an object is valid JSON but not a list of tabs; one odd entry drops only itself
        if (!Array.isArray(parsed)) {
          return found;
        }
        tabs = parsed.filter((tab) => tab && typeof tab === 'object');
      } catch {
        return found;
      }
      const byTty = new Map(tabs.map((tab) => [ttyName(tab.tty), tab]));
      await Promise.all(
        sessions.map(async (live) => {
          const tab = live.tty ? byTty.get(ttyName(live.tty)) : null;
          if (!tab?.id) {
            return;
          }
          const text = await run(it2, ['session', 'get-status', '-s', tab.id]);
          let status: { status?: unknown; detail?: unknown } = {};
          try {
            status = JSON.parse(text || '{}');
          } catch {
            return;
          }
          if (!status || typeof status !== 'object') {
            return;
          }
          const mapped = asStatus(status.status);
          if (!mapped) {
            return;
          }
          const name = String(tab.name || '').trim();
          found.set(live.session, {
            status: mapped,
            detail: typeof status.detail === 'string' && status.detail ? status.detail : null,
            title:
              GENERIC_TITLES.has(name.toLowerCase()) || TRUNCATED_TITLE.test(name) ? null : name,
          });
        }),
      );
      return found;
    },
  };
}

/**
 * Raises iTerm2 over the other apps. `it2 app activate` says it worked but macOS doesn't let a background process take the
 * front from the app you are in (the board is in your browser), so this asks LaunchServices the way a Dock click does:
 * `open -a iTerm2`, which raises the app and its windows and opens no new window while it has one. No permission needed.
 */
export async function raiseIterm(it2: string): Promise<void> {
  const opened = await run('open', ['-a', 'iTerm']);
  if (opened === null) {
    await run(it2, ['app', 'activate']);
  }
}

/** The iTerm session id of the tab whose tty this is (from `it2 session list`), or null. */
async function tabOf(
  it2: string,
  tty: string | null,
): Promise<{ id: string; window_id?: string } | null> {
  if (!tty) {
    return null;
  }
  const listing = await run(it2, ['session', 'list', '--json']);
  try {
    const tabs: { id?: string; tty?: string; window_id?: string }[] = JSON.parse(listing || '[]');
    const tab = tabs.find((candidate) => candidate?.tty && ttyName(candidate.tty) === ttyName(tty));
    return tab?.id ? { id: tab.id, window_id: tab.window_id } : null;
  } catch {
    return null;
  }
}

/**
 * Types a line into a session's iTerm tab and presses Enter (`it2 session run`), the tab found from the session's tty here.
 * The text is built by the bridge, never taken from the page. Resolves to null when it worked, else why not.
 */
export async function typeLine(
  it2: string,
  tty: string | null,
  text: string,
): Promise<string | null> {
  const tab = await tabOf(it2, tty);
  if (!tab) {
    return 'no iTerm tab for that session';
  }
  return (await run(it2, ['session', 'run', text, '--session', tab.id])) === null
    ? 'iTerm could not type into the tab'
    : null;
}

/**
 * Brings a session's iTerm tab to the front, never opening a window: finds the tab by the session's tty (never by anything
 * the page said), raises its window and selects the tab and pane inside iTerm (`it2 window focus`, `it2 session focus`),
 * then raises iTerm over the other apps. Resolves to null when it worked, else why not.
 */
export async function focusTab(
  it2: string,
  tty: string | null,
  raise: (it2: string) => Promise<void> = raiseIterm,
): Promise<string | null> {
  if (!tty) {
    return 'the session has no terminal';
  }
  const listing = await run(it2, ['session', 'list', '--json']);
  if (listing === null) {
    return 'iTerm did not answer';
  }
  let tabs: { id?: string; tty?: string; window_id?: string }[] = [];
  try {
    tabs = JSON.parse(listing);
  } catch {
    return 'iTerm did not answer';
  }
  if (!Array.isArray(tabs)) {
    return 'iTerm did not answer';
  }
  const tab = tabs.find((candidate) => candidate?.tty && ttyName(candidate.tty) === ttyName(tty));
  if (!tab?.id) {
    return 'no iTerm tab for that session';
  }
  if (tab.window_id) {
    // the window first, so the tab selected next is in front; a failure here leaves the tab selection to do it
    await run(it2, ['window', 'focus', tab.window_id]);
  }
  if ((await run(it2, ['session', 'focus', tab.id])) === null) {
    return 'iTerm could not select the tab';
  }
  // raising the app is last: the tab is already selected if this one fails
  await raise(it2);
  return null;
}
