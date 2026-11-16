/**
 * The status line step of `once-upon setup`: what to add so Claude Code's status line feeds the board each session's
 * context and usage (extras/statusline-snippet.sh). Only text: setup never writes the user's settings or scripts.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claudeStatusLine,
  freshStatusLineIds,
} from '@once-upon-a-diff/adapters/claude-sessions/statusline';

/** extras/statusline-snippet.sh in this checkout (six folders up from this file), or a placeholder when it is not there. */
function snippetPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const found = path.resolve(here, ...Array(6).fill('..'), 'extras', 'statusline-snippet.sh');
  return existsSync(found) ? found : '/path/to/once-upon-a-diff/extras/statusline-snippet.sh';
}

/** The path as one shell word: bare when it is plain, else in single quotes. */
function shellQuote(file: string): string {
  return /^[\w@%+=:,./-]+$/.test(file) ? file : `'${file.replaceAll("'", `'\\''`)}'`;
}

/**
 * The optional step that feeds the board each session's context and usage. It only prints: whether the user has a status
 * line is theirs to say, so setup never writes Claude Code's settings.
 */
export function statusLineStep(
  home: string,
  snippet = snippetPath(),
  configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
): string[] {
  if (freshStatusLineIds(home, Date.now()).size) {
    return ['Board context and usage: a status line is already writing them.'];
  }
  const existing = claudeStatusLine(configDir);
  const quoted = shellQuote(snippet);
  const head =
    'Optional, for `ctx N%` and the usage limits on the board (nothing is written for you):';
  if (existing === null) {
    return [
      head,
      `Claude Code has no status line yet. Add this to ${path.join(configDir, 'settings.json')}:`,
      `  "statusLine": { "type": "command", "command": ${JSON.stringify(quoted)} }`,
      'The snippet needs jq and prints nothing, so the status line stays empty.',
    ];
  }
  if (typeof existing === 'string' && existing.includes('statusline-snippet.sh')) {
    return [
      head,
      `The snippet is already set up as your status line (${existing}), but it writes nothing.`,
      'It needs jq, which may be missing: check that `jq` is installed and on the PATH Claude Code runs with.',
    ];
  }
  return [
    head,
    existing === 'unreadable'
      ? `${path.join(configDir, 'settings.json')} could not be read, so your status line is unknown and left alone. If you have one,`
      : `You already have a status line${existing ? ` (${existing})` : ''}, and it is left alone. In its script,`,
    `add this line after it reads its input into $input:`,
    `  printf '%s' "$input" | ${quoted}`,
  ];
}
