/*
 * iTerm2, through its `it2` CLI: which sessions have a tab, typing a line into a tab, and raising a tab. Nothing here
 * decides what to type or which session may take it (core/src/features/sessions does); this only talks to iTerm. It
 * says nothing of a session's status: that comes from Claude Code's registry and the status hook.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './os.ts';

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

/** The ids of the sessions whose tty an iTerm tab holds (one `it2 session list`), so Open in iTerm and typing can reach them. */
export async function itermTabs(
  it2: string,
  sessions: { session: string; tty: string | null }[],
): Promise<Set<string>> {
  const found = new Set<string>();
  const listing = await run(it2, ['session', 'list', '--json']);
  if (!listing) {
    return found;
  }
  let tabs: { id?: string; tty?: string }[];
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
  const ttys = new Set(tabs.filter((tab) => tab.id).map((tab) => ttyName(tab.tty)));
  for (const live of sessions) {
    if (live.tty && ttys.has(ttyName(live.tty))) {
      found.add(live.session);
    }
  }
  return found;
}

/**
 * Raises iTerm2 over the other apps. `it2 app activate` says it worked but macOS doesn't let a background process take the
 * front from the app you are in (the board is in your browser), so this asks LaunchServices the way a Dock click does:
 * `open -a iTerm2`, which raises the app and its windows and opens no new window while it has one. No permission needed.
 */
async function raiseIterm(it2: string): Promise<void> {
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
