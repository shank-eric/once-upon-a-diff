/** The optional extras: the status line snippet, the require-beats hook and the subagent status line, with a fresh home. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from './helpers.ts';
import { OPEN_STATES, END_STATES } from '@once-upon-a-diff/contracts/files/agent-states';
import { ledgerLine } from '@once-upon-a-diff/state/records/agents/events';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
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

test(
  'subagent-statusline.py names the model from the ledger on a row with a beat, and nothing extra with no model',
  { skip: !has('python3') },
  async () => {
    const home = tmp('substatus-model');
    const progress = path.join(home, 'progress.md');
    const ledger = path.join(home, 'ledger.md');
    writeJson(path.join(home, 'config.json'), {
      board_progress_file: progress,
      board_ledger_file: ledger,
    });
    writeFileSync(
      progress,
      '- 1:00 PM with-model 2/5 tests: halfway\n- 1:00 PM no-model 2/5 tests: halfway\n- 1:00 PM effort-only 2/5 tests: halfway\n',
    );
    writeFileSync(
      ledger,
      '- [running] sid:abcdef01 with-model (sonnet, high) — build it — started 1:00 PM ET, 11/11\n' +
        '- [running] sid:abcdef01 no-model — build it — started 1:00 PM ET, 11/11\n' +
        '- [running] sid:abcdef01 effort-only (high) — build it — started 1:00 PM ET, 11/11\n',
    );
    const content = async (name: string) => {
      const run = await runScript(
        '/usr/bin/env',
        ['python3', path.join(ROOT, 'extras/subagent-statusline.py')],
        { ONCE_UPON_HOME: home },
        JSON.stringify({
          id: 't1',
          name,
          description: name,
          status: 'running',
          session_id: 'abcdef01xyz',
        }),
      );
      assert.equal(run.code, 0, run.stderr);
      return JSON.parse(run.stdout.trim().split('\n')[0]).content as string;
    };
    assert.match(await content('with-model'), /^with-model · sonnet · tests/);
    assert.match(await content('no-model'), /^no-model · tests/);
    assert.match(await content('effort-only'), /^effort-only · tests/);
  },
);

test(
  'subagent-statusline.py clears a waiting row on every other state the ledger can write',
  { skip: !has('python3') },
  async () => {
    const home = tmp('substatus-states');
    const ledger = path.join(home, 'ledger.md');
    writeJson(path.join(home, 'config.json'), { board_ledger_file: ledger });
    const line = (state: string) =>
      ledgerLine(
        {
          v: 1,
          op: 'state',
          id: 'abcdef01:w',
          sid8: 'abcdef01',
          name: 'w',
          at: new Date().toISOString(),
          state,
        },
        { sid: 'abcdef01', name: 'w', state, notes: null } as unknown as LedgerAgent,
      ) + '\n';
    let extra = '';
    const rows = async (...states: string[]) => {
      writeFileSync(ledger, states.map(line).join('') + extra);
      const run = await runScript(
        '/usr/bin/env',
        ['python3', path.join(ROOT, 'extras/subagent-statusline.py')],
        { ONCE_UPON_HOME: home },
        JSON.stringify({
          id: 't1',
          name: 'x',
          description: 'x',
          status: 'running',
          session_id: 'abcdef01xyz',
        }),
      );
      assert.equal(run.code, 0, run.stderr);
      return run.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((row) => JSON.parse(row).id as string);
    };
    assert.deepEqual(await rows('waiting'), ['waiting:w']);
    extra = '- [deploying] sid:abcdef01 w main to live\n- [note] sid:abcdef01 w hi\n';
    assert.deepEqual(await rows('waiting'), ['waiting:w'], 'a [deploying] line is not a state');
    extra = '';
    const listed = /^LEDGER_STATES = \((.*)\)$/m.exec(
      readFileSync(path.join(ROOT, 'extras/subagent-statusline.py'), 'utf8'),
    );
    assert.deepEqual(
      [...(listed?.[1] ?? '').matchAll(/"(\w+)"/g)].map((one) => one[1]),
      [...OPEN_STATES, ...END_STATES],
      'the Python state list matches the contracts',
    );
    for (const state of [...OPEN_STATES, ...END_STATES].filter((one) => one !== 'waiting')) {
      assert.deepEqual(await rows('waiting', state), [], `a ${state} line clears the waiting row`);
    }
  },
);

test(
  'board-status.sh writes <home>/status/<sid>.json for each hook event, and nothing without a home or a good session id',
  { skip: !has('jq') },
  async () => {
    const script = path.join(ROOT, 'extras/hooks/board-status.sh');
    const home = tmp('board-status-hook');
    const sid = 'abc-123';
    const file = path.join(home, 'status', `${sid}.json`);
    const send = async (payload: Record<string, unknown>, dest = home) => {
      const run = await runScript(
        script,
        [],
        { ONCE_UPON_HOME: dest },
        JSON.stringify({ session_id: sid, ...payload }),
      );
      assert.equal(run.code, 0);
      assert.equal(run.stdout, '');
    };
    const read = () => JSON.parse(readFileSync(file, 'utf8'));
    const stop = (last: string) =>
      send({ hook_event_name: 'Stop', last_assistant_message: `Done with the work.\n\n${last}\n` });

    await send({ hook_event_name: 'UserPromptSubmit' });
    assert.equal(read().state, 'working');
    assert.equal(read().session_id, sid);
    assert.ok(Math.abs(read().at - Date.now()) < 60_000, 'at is milliseconds');

    // Stop on a turn the user started: a question or a handoff line waits, anything else is done
    await stop('Want me to ship it?');
    assert.deepEqual(
      [read().state, read().detail, read().event],
      ['waiting', 'Want me to ship it?', 'Stop'],
    );
    for (const line of ['**Next: the PR text**', '> Queued: the story', '- still to do: docs']) {
      await send({ hook_event_name: 'UserPromptSubmit' });
      await stop(line);
      assert.equal(read().state, 'waiting', line);
    }
    await send({ hook_event_name: 'UserPromptSubmit' });
    await stop('Everything is pushed.');
    assert.deepEqual([read().state, read().detail], ['done', null]);
    await send({ hook_event_name: 'UserPromptSubmit' });
    await stop('Nextly, an ordinary line.');
    assert.equal(read().state, 'done', 'Next needs a word break');
    await send({ hook_event_name: 'UserPromptSubmit' });
    await send({ hook_event_name: 'Stop', last_assistant_message: '' });
    assert.equal(read().state, 'done', 'no reply text: done');

    // a turn another session started (no prompt hook before Stop) is never waiting
    await stop('Is that right?');
    assert.equal(read().state, 'done');

    // permission prompts, questions and notifications wait; PostToolUse clears only a wait
    await send({ hook_event_name: 'UserPromptSubmit' });
    await send({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    assert.equal(read().state, 'working');
    const before = read().at;
    await send({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    assert.deepEqual([read().state, read().detail], ['waiting', 'Needs your approval: Bash']);
    await send({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    assert.equal(read().state, 'working');
    assert.ok(read().at >= before);
    await send({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which branch?' }] },
    });
    assert.deepEqual([read().state, read().detail], ['waiting', 'Which branch?']);
    await send({ hook_event_name: 'UserPromptSubmit' });
    await send({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    assert.equal(read().state, 'working', 'another tool is not a wait');
    await send({
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });
    assert.deepEqual(
      [read().state, read().detail],
      ['waiting', 'Claude needs your permission to use Bash'],
    );
    await send({ hook_event_name: 'UserPromptSubmit' });
    await send({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    assert.equal(read().state, 'working', 'an idle notification is not a wait');

    await send({ hook_event_name: 'SessionEnd' });
    assert.throws(() => readFileSync(file, 'utf8'));

    // no home, and a session id that is not safe as a file name: nothing written
    const none = path.join(tmp('board-status-none'), 'missing');
    await send({ hook_event_name: 'UserPromptSubmit' }, none);
    assert.throws(() => readFileSync(path.join(none, 'status', `${sid}.json`)));
    const bad = await runScript(
      script,
      [],
      { ONCE_UPON_HOME: home },
      JSON.stringify({ session_id: '../evil', hook_event_name: 'UserPromptSubmit' }),
    );
    assert.equal(bad.code, 0);
    assert.throws(() => readFileSync(path.join(home, 'evil.json')));
    assert.throws(() => readFileSync(path.join(home, 'status', '../evil.json')));
  },
);

test(
  'board-status.sh: a turn another session or a notification started is never waiting, and a Stop after a blocked Stop still judges the reply',
  { skip: !has('jq') },
  async () => {
    const script = path.join(ROOT, 'extras/hooks/board-status.sh');
    const home = tmp('board-status-peer');
    const sid = 'peer-123';
    const file = path.join(home, 'status', `${sid}.json`);
    const send = async (payload: Record<string, unknown>) => {
      const run = await runScript(
        script,
        [],
        { ONCE_UPON_HOME: home },
        JSON.stringify({ session_id: sid, ...payload }),
      );
      assert.equal(run.code, 0);
    };
    const read = () => JSON.parse(readFileSync(file, 'utf8'));
    const prompt = (text: string) => send({ hook_event_name: 'UserPromptSubmit', prompt: text });
    const stop = (last: string, extra: Record<string, unknown> = {}) =>
      send({ hook_event_name: 'Stop', last_assistant_message: `Work.\n\n${last}\n`, ...extra });

    // every prompt a session did not get from you fires UserPromptSubmit too, and none of them can be waiting
    for (const text of [
      'Another Claude session sent a message\n<cross-session-message from="x">Is it ready?</cross-session-message>',
      '<cross-session-message from="x">hi</cross-session-message>',
      '<task-notification>\n<task-id>1</task-id></task-notification>',
      '  <agent-message>done</agent-message>',
      '<system-reminder>\nsomething</system-reminder>\nthe rest',
      '[Subagent hand-back] review-x finished',
    ]) {
      await prompt(text);
      await stop('Is that right?');
      assert.equal(read().state, 'done', text);
    }
    // a prompt wait in a peer turn is real, but the turn still ends done
    await prompt('<task-notification>x</task-notification>');
    await send({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    assert.equal(read().state, 'waiting');
    await send({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    await stop('Want me to ship it?');
    assert.equal(read().state, 'done', 'the peer turn stays a peer turn through an approval');

    // a typed prompt can wait, and so can a prompt that merely mentions a tag later in its text
    await prompt('please look at the <task-notification> handling');
    await stop('Want me to ship it?');
    assert.equal(read().state, 'waiting');

    // a Stop hook that blocks (stop_hook_active) continues the turn: the next Stop still judges the reply by who began it
    await prompt('go');
    await stop('Is that right?');
    await stop('Want me to ship it?', { stop_hook_active: true });
    assert.deepEqual([read().state, read().detail], ['waiting', 'Want me to ship it?']);
    await stop('All pushed.', { stop_hook_active: true });
    assert.equal(read().state, 'done');
    await prompt('<cross-session-message>x</cross-session-message>');
    await stop('Is that right?');
    await stop('Is that right?', { stop_hook_active: true });
    assert.equal(read().state, 'done', 'a blocked peer turn stays a peer turn');
  },
);

test('the scripts and extras name no personal path', () => {
  const files = [
    'scripts/link-skills.sh',
    'extras/subagent-statusline.py',
    'extras/statusline-snippet.sh',
    'extras/hooks/require-beats.sh',
    'extras/hooks/board-status.sh',
  ];
  for (const rel of files) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(text, /Configuration|ClariFi|\/Users\/|OneDrive|\.larmor|Eric/, rel);
  }
});
