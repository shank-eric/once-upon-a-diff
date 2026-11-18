/**
 * The status hook step of `once-upon setup`: what to add to Claude Code's settings so the board learns that a session is
 * waiting on you or done (extras/hooks/board-status.sh), in any terminal. Only text: setup never writes the user's settings.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookFileCount } from '@once-upon-a-diff/adapters/claude-sessions/hook-status';

/** extras/hooks/board-status.sh in this checkout (six folders up from this file), or a placeholder when it is not there. */
function hookScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const found = path.resolve(here, ...Array(6).fill('..'), 'extras', 'hooks', 'board-status.sh');
  return existsSync(found) ? found : '/path/to/once-upon-a-diff/extras/hooks/board-status.sh';
}

/** The hook events the script reads, each with the matcher it needs (README, "Board status hook"). */
const EVENTS: [string, string | null][] = [
  ['UserPromptSubmit', null],
  ['PreToolUse', 'AskUserQuestion'],
  ['PermissionRequest', null],
  ['Notification', 'permission_prompt|elicitation_dialog'],
  ['PostToolUse', null],
  ['Stop', null],
  ['SessionEnd', null],
];

/**
 * The step that feeds the board Waiting and Done. It only prints: the hooks are in the user's own settings.json, so setup
 * never writes it. Nothing is added when the hook has already written status files, or when the settings already name it
 * (then the hint is about jq, which the script needs).
 */
export function statusHookStep(
  home: string,
  script = hookScriptPath(),
  configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
): string[] {
  if (hookFileCount(home) > 0) {
    return ['Board status hook: already writing Waiting and Done.'];
  }
  const settingsFile = path.join(configDir, 'settings.json');
  let settings = '';
  try {
    settings = readFileSync(settingsFile, 'utf8');
  } catch {
    // no settings file yet: the block below is the whole "hooks" entry
  }
  const head = 'For Waiting and Done on the board (nothing is written for you):';
  if (settings.includes('board-status.sh')) {
    return [
      head,
      `${settingsFile} already names board-status.sh, but it has written no status file yet.`,
      'It needs jq, which may be missing: check that `jq` is installed and on the PATH Claude Code runs with, then send a prompt.',
    ];
  }
  const command = JSON.stringify(script);
  const entries = EVENTS.map(([event, matcher]) => {
    const hook = `{ "hooks": [{ "type": "command", "command": ${command} }] }`;
    const withMatcher = matcher
      ? `{ "matcher": ${JSON.stringify(matcher)}, "hooks": [{ "type": "command", "command": ${command} }] }`
      : hook;
    return `    "${event}": [${withMatcher}]`;
  });
  return [
    head,
    `Add these hooks to ${settingsFile} (merge them into an existing "hooks" entry; the script needs jq):`,
    '  "hooks": {',
    entries.join(',\n'),
    '  }',
  ];
}
