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

export const REQUIRE_BEATS_HOOK = 'require-beats.sh';
export const AUTO_FINISH_HOOK = 'auto-finish-run.sh';

/**
 * The two optional agent hooks beside the listen script: require-beats.sh (PreToolUse on the Agent tool) and
 * auto-finish-run.sh (SubagentStop). Printed after the listen block by `install-hooks`; never written for you.
 */
export function agentHooksText(script = listenHookPath()): string[] {
  const dir = path.dirname(script);
  const command = (file: string) => shellQuote(path.join(dir, file));
  const block = {
    hooks: {
      PreToolUse: [
        { matcher: 'Agent', hooks: [{ type: 'command', command: command(REQUIRE_BEATS_HOOK) }] },
      ],
      SubagentStop: [{ hooks: [{ type: 'command', command: command(AUTO_FINISH_HOOK) }] }],
    },
  };
  return [
    '',
    'Optional, for agents you launch by hand or with once-upon dispatch: merge these too.',
    ...JSON.stringify(block, null, 2).split('\n'),
    '',
    `${REQUIRE_BEATS_HOOK} stops an Agent launch whose brief has no "once-upon beat" line (or "no-beats"), so every agent shows its progress; you can skip it when you only launch with once-upon dispatch, which writes that line.`,
    `${AUTO_FINISH_HOOK} ends the run of a background agent that stopped without finishing it.`,
    `Both hooks run /usr/bin/python3; without it ${REQUIRE_BEATS_HOOK} refuses every Agent launch, so install python3 first or skip the block.`,
  ];
}

/** Whether the settings name the listen hook: true, false, or 'unreadable'. */
export const listenHookWired = (configDir = claudeConfigDir()): boolean | 'unreadable' =>
  settingsMention(configDir, LISTEN_HOOK);
