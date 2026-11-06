/**
 * `once-upon editor start|slots`: an editor registers as an editor, with its slots (required), and `editor slots` answers
 * how many are in use with the same function the board uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runCli, tmp, writeJson } from './helpers.ts';
import { Board, noPrWatcher } from '@once-upon-a-diff/board/board';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';

const SID = 'abcdef01';
const SESSION = `${SID}-1111-4222-8333-444444444444`;
const env = { CLAUDE_CODE_SESSION_ID: SESSION };

const editor = (home: string, ...args: string[]) => runCli(home, ['editor', ...args], env);
const agent = (home: string, ...args: string[]) => runCli(home, ['agent', ...args], env);

test('editor start without --slots is refused, with slots it registers kind editor with its full session', async () => {
  const home = tmp('editor-cli-start');
  const refused = await editor(home, 'start', '--task', 'queue');
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /needs --slots/);
  assert.deepEqual(new AgentRegistry(home).agents(), []);
  const started = await editor(home, 'start', '--slots', '2', '--task', 'queue');
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stdout, new RegExp(`^${SID}:editor-${SID} r_`));
  const [one] = new AgentRegistry(home).agents();
  assert.equal(one.kind, 'editor');
  assert.equal(one.slots, 2);
  assert.equal(one.session, SESSION);
  const bad = await editor(home, 'start', 'editor-two', '--slots', '0');
  assert.notEqual(bad.code, 0);
});

test('agent start --kind editor is refused and names editor start', async () => {
  const home = tmp('editor-cli-refused');
  const refused = await agent(
    home,
    'start',
    'ed',
    '--kind',
    'editor',
    '--slots',
    '3',
    '--task',
    'x',
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /editor start/);
  assert.deepEqual(new AgentRegistry(home).agents(), []);
});

test('editor slots --json counts the editor’s running, plan and fixing authors and no one else’s', async () => {
  const home = tmp('editor-cli-slots');
  assert.equal((await editor(home, 'start', '--slots', '3')).code, 0);
  for (const name of ['ou-a', 'ou-b', 'ou-c']) {
    assert.equal(
      (await agent(home, 'start', name, '--kind', 'author', '--branch', name, '--task', name)).code,
      0,
    );
  }
  assert.equal((await agent(home, 'state', 'ou-b', '--state', 'plan')).code, 0);
  assert.equal((await agent(home, 'state', 'ou-c', '--state', 'waiting')).code, 0);
  assert.equal(
    (
      await agent(
        home,
        'start',
        'ou-x',
        '--kind',
        'author',
        '--branch',
        'ou-x',
        '--sid',
        '12345678',
        '--task',
        'x',
      )
    ).code,
    0,
  );
  const slots = await editor(home, 'slots', '--json');
  assert.equal(slots.code, 0, slots.stderr);
  const found = JSON.parse(slots.stdout);
  assert.equal(found.sid, SID);
  assert.equal(found.slots, 3);
  assert.equal(found.in_use, 2);
  assert.equal(found.free, 1);
  assert.deepEqual(found.authors.map((one: { name: string }) => one.name).sort(), [
    'ou-a',
    'ou-b',
    'ou-c',
  ]);
  const text = await editor(home, 'slots');
  assert.match(text.stdout, /2 of 3 slots in use/);
});

test('editor slots is the board’s in_use for the same store', async () => {
  const home = tmp('editor-cli-board');
  const sessions = tmp('editor-cli-board-live');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  writeJson(path.join(sessions, `${process.pid}.json`), {
    pid: process.pid,
    sessionId: SESSION,
    cwd: '/work/widgets',
  });
  assert.equal((await editor(home, 'start', '--slots', '4')).code, 0);
  for (const name of ['ou-a', 'ou-b']) {
    assert.equal(
      (await agent(home, 'start', name, '--kind', 'author', '--branch', name, '--task', name)).code,
      0,
    );
  }
  const data = await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => new Date(),
  }).snapshot();
  const cli = JSON.parse((await editor(home, 'slots', '--json')).stdout);
  assert.equal(data.editors[0].in_use, 2);
  assert.equal(cli.in_use, data.editors[0].in_use);
  assert.equal(cli.slots, data.editors[0].slots);
});

test('editor slots exits non-zero when the editor is not registered', async () => {
  const home = tmp('editor-cli-none');
  const none = await editor(home, 'slots', '--json');
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /no editor/);
});

test('a restart of an editor under its name keeps its slots, not the default', async () => {
  const home = tmp('editor-cli-restart');
  assert.equal((await editor(home, 'start', 'editor-x', '--slots', '2')).code, 0);
  assert.equal((await agent(home, 'start', 'editor-x', '--task', 'again')).code, 0);
  const slots = JSON.parse((await editor(home, 'slots', 'editor-x', '--json')).stdout);
  assert.equal(slots.slots, 2);
  // and an editor restarted through editor start with new slots takes the new ones
  assert.equal((await editor(home, 'start', 'editor-x', '--slots', '5')).code, 0);
  assert.equal(JSON.parse((await editor(home, 'slots', 'editor-x', '--json')).stdout).slots, 5);
});
