/**
 * `once-upon install-hooks` and doctor's Listen hook check: the hook that starts a queued Start listening in whatever
 * Claude Code session you use next (extras/hooks/listen-pending.sh). Only text: nothing here writes the user's settings.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingsMention } from '@once-upon-a-diff/adapters/claude-sessions/hook-install';

export const LISTEN_HOOK = 'listen-pending.sh';

/** extras/hooks/listen-pending.sh in this checkout (six folders up from this file), or a placeholder when it is not there. */
export function listenHookPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const found = path.resolve(here, ...Array(6).fill('..'), 'extras', 'hooks', LISTEN_HOOK);
  return existsSync(found) ? found : `/path/to/once-upon-a-diff/extras/hooks/${LISTEN_HOOK}`;
}

/** Claude Code's config folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
export const claudeConfigDir = (): string =>
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** The path as one shell word: bare when it is plain, else in single quotes. */
const shellQuote = (file: string): string =>
  /^[\w@%+=:,./-]+$/.test(file) ? file : `'${file.replaceAll("'", `'\\''`)}'`;

/** The `hooks` block for settings.json: the script on SessionStart and UserPromptSubmit, the two events it claims on. */
export function listenHookBlock(script = listenHookPath()): { hooks: Record<string, unknown[]> } {
  const entry = [{ hooks: [{ type: 'command', command: shellQuote(script) }] }];
  return { hooks: { SessionStart: entry, UserPromptSubmit: entry } };
}

/** What `once-upon install-hooks` prints: the block to merge into settings.json, and what it is for. Never written for you. */
export function installHooksText(
  script = listenHookPath(),
  configDir = claudeConfigDir(),
): string[] {
  return [
    `Add this to the "hooks" in ${path.join(configDir, 'settings.json')}, merging with any hooks you already have (nothing is written for you):`,
    '',
    ...JSON.stringify(listenHookBlock(script), null, 2).split('\n'),
    '',
    'It lets Start listening work from any terminal or the Desktop Code tab: when nothing can be typed into, the button queues a request,',
    'and the next message you send in a Claude Code session in that repo starts the listener. It needs jq, and does nothing when no request is queued.',
  ];
}

/** Whether the settings name the listen hook: true, false, or 'unreadable'. */
export const listenHookWired = (configDir = claudeConfigDir()): boolean | 'unreadable' =>
  settingsMention(configDir, LISTEN_HOOK);
