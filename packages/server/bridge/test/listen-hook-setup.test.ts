/** `once-upon install-hooks` prints the settings block and writes nothing; doctor's Listen hook line follows the settings. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, runCli } from './helpers.ts';
import { doctor } from '@once-upon-a-diff/core/orchestration/bridge/doctor';
import {
  agentHooksText,
  installHooksText,
  listenHookBlock,
} from '@once-upon-a-diff/core/features/sessions/hook-setup';
import { ROOT } from './script-helpers.ts';

const SCRIPT = path.join(ROOT, 'extras/hooks/listen-pending.sh');

/** The nth JSON object in the printed lines (from a `{` line to the next `}` line). */
const blockOf = (lines: string[], nth = 0) => {
  let from = 0;
  for (let i = 0; i < nth; i++) {
    from = lines.indexOf('}', from) + 1;
  }
  const start = lines.indexOf('{', from);
  return JSON.parse(lines.slice(start, lines.indexOf('}', start) + 1).join('\n'));
};

test('install-hooks prints a block that parses, with both events and the absolute script path, and writes nothing', async () => {
  const claude = tmp('install-hooks-claude');
  const settings = JSON.stringify({ hooks: { Stop: [] } });
  writeFileSync(path.join(claude, 'settings.json'), settings);
  const run = await runCli(tmp('install-hooks-home'), ['install-hooks'], {
    CLAUDE_CONFIG_DIR: claude,
  });
  assert.equal(run.code, 0, run.stderr);
  const block = blockOf(run.stdout.split('\n'));
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    assert.deepEqual(block.hooks[event], [{ hooks: [{ type: 'command', command: SCRIPT }] }]);
  }
  assert.match(
    run.stdout,
    new RegExp(`${claude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/settings\\.json`),
  );
  assert.equal(readFileSync(path.join(claude, 'settings.json'), 'utf8'), settings, 'left alone');
  assert.ok(statSync(SCRIPT).mode & 0o111, 'the script it names is executable');
});

test('install-hooks also prints the optional agent hooks beside the listen script, and still writes nothing', async () => {
  const claude = tmp('install-hooks-agents-claude');
  const run = await runCli(tmp('install-hooks-agents-home'), ['install-hooks'], {
    CLAUDE_CONFIG_DIR: claude,
  });
  assert.equal(run.code, 0, run.stderr);
  const block = blockOf(run.stdout.split('\n'), 1);
  const beats = path.join(ROOT, 'extras/hooks/require-beats.sh');
  const finish = path.join(ROOT, 'extras/hooks/auto-finish-run.sh');
  assert.deepEqual(block.hooks.PreToolUse, [
    { matcher: 'Agent', hooks: [{ type: 'command', command: beats }] },
  ]);
  assert.deepEqual(block.hooks.SubagentStop, [{ hooks: [{ type: 'command', command: finish }] }]);
  assert.ok(statSync(beats).mode & 0o111 && statSync(finish).mode & 0o111, 'both are executable');
  assert.match(run.stdout, /once-upon dispatch/);
  assert.equal(
    agentHooksText('/x/y/listen-pending.sh').join('\n').includes('/x/y/require-beats.sh'),
    true,
  );
});

test('a script path with a space is one shell word inside the command', () => {
  const block = listenHookBlock("/Users/a b/it's/extras/hooks/listen-pending.sh");
  assert.equal(
    (block.hooks.SessionStart[0] as { hooks: { command: string }[] }).hooks[0].command,
    `'/Users/a b/it'\\''s/extras/hooks/listen-pending.sh'`,
  );
  assert.ok(installHooksText('/x/listen-pending.sh', '/c').join('\n').includes('/c/settings.json'));
});

test('doctor says whether the listen hook is in the settings, with the fix when it is not', async () => {
  const home = tmp('listen-hook-doctor');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('listen-hook-sessions') });
  const claude = tmp('listen-hook-doctor-claude');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claude;
  try {
    const lines = async () => {
      const out: string[] = [];
      await doctor(home, { token: 't', port: 1 }, { out: (line) => out.push(line) });
      return out;
    };
    let out = await lines();
    const none = out.find((line) => line.includes('Listen hook:')) ?? '';
    assert.match(none, /^WARN/);
    assert.ok(out.some((line) => line.includes('once-upon install-hooks')));
    writeFileSync(path.join(claude, 'settings.json'), JSON.stringify(listenHookBlock(SCRIPT)));
    out = await lines();
    assert.match(out.find((line) => line.includes('Listen hook:')) ?? '', /^PASS/);
    writeFileSync(path.join(claude, 'settings.json'), '{"hooks": {"Stop": []}}');
    out = await lines();
    assert.match(out.find((line) => line.includes('Listen hook:')) ?? '', /^WARN/);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
  }
});
