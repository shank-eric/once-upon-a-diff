/** The status hook step of `once-upon setup`: it prints the hooks block for Claude Code's settings and writes nothing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, runCli } from './helpers.ts';
import { ROOT } from './script-helpers.ts';
import { statusHookStep } from '@once-upon-a-diff/core/features/sessions/status-hook-setup';

const HOOK = path.join(ROOT, 'extras/hooks/board-status.sh');

test('setup prints the hooks block with this checkout’s script, and writes nothing', async () => {
  const home = tmp('hook-setup');
  const claude = tmp('hook-setup-claude');
  const run = await runCli(home, ['setup'], { CLAUDE_CONFIG_DIR: claude });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Waiting and Done on the board/);
  const lines = run.stdout.split('\n');
  const start = lines.indexOf('  "hooks": {');
  const parsed = JSON.parse(`{${lines.slice(start, lines.indexOf('  }', start) + 1).join('\n')}}`);
  assert.deepEqual(Object.keys(parsed.hooks), [
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'Notification',
    'PostToolUse',
    'Stop',
    'SessionEnd',
  ]);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, HOOK);
  assert.equal(parsed.hooks.PreToolUse[0].matcher, 'AskUserQuestion');
  assert.throws(() => readFileSync(path.join(claude, 'settings.json')));
});

test('setup says so, and prints no block, once the hook is writing status files', () => {
  const home = tmp('hook-setup-fresh');
  writeJson(path.join(home, 'status', 'some-session.json'), { state: 'done' });
  assert.deepEqual(statusHookStep(home, HOOK, tmp('hook-setup-fresh-claude')), [
    'Board status hook: already writing Waiting and Done.',
  ]);
});

test('setup points at jq when the settings already name the hook but it has written nothing', () => {
  const claude = tmp('hook-setup-named-claude');
  writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK }] }] } }),
  );
  const lines = statusHookStep(tmp('hook-setup-named'), HOOK, claude).join('\n');
  assert.match(lines, /already names board-status\.sh/);
  assert.match(lines, /jq/);
  assert.doesNotMatch(lines, /"hooks": \{/);
});
