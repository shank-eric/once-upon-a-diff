/**
 * `once-upon beat`: the progress line it writes comes from config.json's board_progress_file (the one setting `agent beat`'s
 * mirror reads too), the beat is registered on the agent's open run, and nothing outside the temp folders is read or written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runCli, tmp, writeJson } from './helpers.ts';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { beatLine } from '@once-upon-a-diff/state/records/agents/events';

const SID = 'abcdef01';
const TIME = /^- \d{1,2}:\d{2} [AP]M /;

/** A home with config.json, a fresh user home, and a registered helper `name` in the session SID. */
async function setup(name: string, config: Record<string, unknown>) {
  const home = tmp('beat-home');
  const fakeHome = tmp('beat-user');
  writeJson(path.join(home, 'config.json'), config);
  const started = await runCli(home, [
    'agent',
    'start',
    name,
    '--kind',
    'helper',
    '--task',
    'x',
    '--sid',
    SID,
  ]);
  assert.equal(started.code, 0, started.stderr);
  const env = { HOME: fakeHome };
  const beats = () => new AgentRegistry(home).agents().find((one) => one.name === name)?.beat;
  return { home, fakeHome, env, beats };
}

test('a beat appends one progress line to board_progress_file and registers the beat on the run', async () => {
  const file = path.join(tmp('beat-out'), 'progress.md');
  const { home, env, beats } = await setup('beat-a', { board_progress_file: file });
  const run = await runCli(home, ['beat', 'beat-a', '3/6', 'code', 'a', 'note', '--sid', SID], env);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, '', 'a beat prints nothing');
  assert.equal(beats()?.n, 3);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'the line is written once');
  assert.match(lines[0], /^- \d{1,2}:\d{2} [AP]M beat-a 3\/6 code: a note$/);
});

test('its line is the line `agent beat` mirrors for the same beat, and the one beatLine makes', async () => {
  const viaAgent = path.join(tmp('beat-pin-agent'), 'progress.md');
  const viaBeat = path.join(tmp('beat-pin-beat'), 'progress.md');
  const mirrored = await setup('beat-p', { board_progress_file: viaAgent });
  const direct = await setup('beat-p', { board_progress_file: viaBeat });
  const agentBeat = await runCli(
    mirrored.home,
    ['agent', 'beat', 'beat-p', '2/5', 'plan', '--', '--note with dashes'],
    { CLAUDE_CODE_SESSION_ID: `${SID}-1111-4222-8333-444444444444` },
  );
  assert.equal(agentBeat.code, 0, agentBeat.stderr);
  // a note that starts with -- goes after a bare --, as for `agent beat`
  const beat = await runCli(
    direct.home,
    ['beat', 'beat-p', '2/5', 'plan', '--', '--note with dashes'],
    { ...direct.env, CLAUDE_CODE_SESSION_ID: `${SID}-1111-4222-8333-444444444444` },
  );
  assert.equal(beat.code, 0, beat.stderr);
  const fromAgent = readFileSync(viaAgent, 'utf8').trim();
  const fromBeat = readFileSync(viaBeat, 'utf8').trim();
  assert.match(fromAgent, TIME);
  assert.match(fromBeat, TIME);
  assert.equal(fromBeat.replace(TIME, ''), fromAgent.replace(TIME, ''));
  const event = {
    at: '2026-11-06T20:40:00Z',
    name: 'beat-p',
    n: 2,
    of: 5,
    step: 'plan',
    note: 'n',
  };
  assert.equal(beatLine(event), '- 3:40 PM beat-p 2/5 plan: n');
});

test('a leading ~/ in board_progress_file is the user home, and with no setting nothing is written', async () => {
  const withTilde = await setup('beat-t', { board_progress_file: '~/notes/progress.md' });
  mkdirSync(path.join(withTilde.fakeHome, 'notes'));
  await runCli(withTilde.home, ['beat', 'beat-t', '1/6', 'read', '--sid', SID], withTilde.env);
  assert.match(
    readFileSync(path.join(withTilde.fakeHome, 'notes/progress.md'), 'utf8'),
    / beat-t 1\/6 read\n$/,
  );

  const bare = await setup('beat-n', {});
  const run = await runCli(
    bare.home,
    ['beat', 'beat-n', '4/6', 'tests', 'n', '--sid', SID],
    bare.env,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(bare.beats()?.n, 4, 'the registry event still arrives');
  assert.deepEqual(readdirSync(bare.fakeHome), [], 'the fresh user home is untouched');
});

test('a beat for an agent that was never registered still writes its progress line, warns and exits 0', async () => {
  const file = path.join(tmp('beat-out'), 'progress.md');
  const { home, env } = await setup('beat-known', { board_progress_file: file });
  const run = await runCli(home, ['beat', 'unregistered', '1/6', 'read'], env);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /no open run of unregistered/);
  assert.match(readFileSync(file, 'utf8'), / unregistered 1\/6 read\n$/);
});

test('a bad step or name is refused with exit 1 and writes nothing; a bare N is N/6', async () => {
  const file = path.join(tmp('beat-out'), 'progress.md');
  const { home, env } = await setup('beat-b', { board_progress_file: file });
  for (const args of [
    ['beat-b', '7/3', 'code'],
    ['beat-b', '0/6', 'code'],
    ['beat-b', '1/100', 'code'],
    ['beat-b', 'x/6', 'code'],
    ['beat-b', '1/6'],
    ['bad name!', '1/6', 'code'],
    ['beat-b', '1/6', 'two words;'],
  ]) {
    const run = await runCli(home, ['beat', ...args, '--sid', SID], env);
    assert.equal(run.code, 1, args.join(' '));
  }
  assert.equal(existsSync(file), false);
  const bare = await runCli(home, ['beat', 'beat-b', '3', 'code', '--sid', SID], env);
  assert.equal(bare.code, 0, bare.stderr);
  assert.match(readFileSync(file, 'utf8'), / beat-b 3\/6 code\n$/);
});

test('where it runs from changes nothing: a repo folder with its own settings is not read', async () => {
  const file = path.join(tmp('beat-out'), 'progress.md');
  const { home, env } = await setup('beat-c', { board_progress_file: file });
  const folder = tmp('beat-repo');
  writeJson(path.join(folder, '.once-upon/config.json'), { board_progress_file: '/nowhere/x.md' });
  const run = await runCli(home, ['beat', 'beat-c', '1/6', 'read', '--sid', SID], env, folder);
  assert.equal(run.code, 0, run.stderr);
  assert.match(readFileSync(file, 'utf8'), / beat-c 1\/6 read\n$/);
});
