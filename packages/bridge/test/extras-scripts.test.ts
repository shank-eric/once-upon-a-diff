/** The optional extras: the status line snippet, the require-beats hook and the subagent status line, with a fresh home. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from './helpers.ts';
import { ROOT, runScript } from './script-helpers.ts';

const has = (cmd: string) => {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

test(
  'statusline-snippet.sh writes <home>/statusline/<sid>.json, and nothing without a home',
  { skip: !has('jq') },
  async () => {
    const home = tmp('snippet');
    const input = JSON.stringify({
      session_id: 'abc-123',
      context_window: { used_percentage: 42 },
      rate_limits: { five_hour: { used_percentage: 5 } },
    });
    const run = await runScript(
      path.join(ROOT, 'extras/statusline-snippet.sh'),
      [],
      { ONCE_UPON_HOME: home },
      input,
    );
    assert.equal(run.code, 0);
    assert.equal(run.stdout, '');
    const written = JSON.parse(readFileSync(path.join(home, 'statusline/abc-123.json'), 'utf8'));
    assert.equal(written.context, 42);
    assert.equal(written.session_id, 'abc-123');
    const none = path.join(tmp('snippet-none'), 'missing');
    await runScript(
      path.join(ROOT, 'extras/statusline-snippet.sh'),
      [],
      { ONCE_UPON_HOME: none },
      input,
    );
    assert.throws(() => readFileSync(path.join(none, 'statusline/abc-123.json')));
  },
);

test(
  'require-beats.sh lets a brief with `once-upon beat` or no-beats through and stops one without',
  { skip: !has('python3') },
  async () => {
    const hook = path.join(ROOT, 'extras/hooks/require-beats.sh');
    const brief = (prompt: string) => JSON.stringify({ tool_input: { prompt } });
    for (const prompt of [
      'post beats with once-upon beat x 1/6',
      'run fnm exec --using=24 once-upon beat x 1/6 read',
    ]) {
      assert.equal((await runScript(hook, [], {}, brief(prompt))).code, 0, prompt);
    }
    assert.equal((await runScript(hook, [], {}, brief('do it. no-beats'))).code, 0);
    const stopped = await runScript(hook, [], {}, brief('do it'));
    assert.equal(stopped.code, 2);
    assert.match(stopped.stderr, /once-upon beat <tag> <N>\/<M>/);
    assert.equal((await runScript(hook, [], {}, brief('use the shell script x 1/6'))).code, 2);
  },
);

test(
  'subagent-statusline.py shows the newest beat from board_progress_file and reads no personal path',
  { skip: !has('python3') },
  async () => {
    const home = tmp('substatus');
    const progress = path.join(home, 'progress.md');
    writeJson(path.join(home, 'config.json'), { board_progress_file: progress });
    writeFileSync(progress, '- 1:00 PM stage-b 2/5 tests: halfway\n');
    const row = JSON.stringify({
      id: 't1',
      name: 'stage-b',
      description: 'stage-b build',
      status: 'running',
      columns: 100,
    });
    const run = await runScript(
      '/usr/bin/env',
      ['python3', path.join(ROOT, 'extras/subagent-statusline.py')],
      { ONCE_UPON_HOME: home },
      row,
    );
    assert.equal(run.code, 0, run.stderr);
    const out = JSON.parse(run.stdout.trim().split('\n')[0]);
    assert.equal(out.id, 't1');
    assert.match(out.content, /tests/);
    assert.match(out.content, /2\/5 40%/);
  },
);

test('the scripts and extras name no personal path', () => {
  const files = [
    'scripts/link-skills.sh',
    'extras/subagent-statusline.py',
    'extras/statusline-snippet.sh',
    'extras/hooks/require-beats.sh',
  ];
  for (const rel of files) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(text, /Configuration|ClariFi|\/Users\/|OneDrive|\.larmor|Eric/, rel);
  }
});
