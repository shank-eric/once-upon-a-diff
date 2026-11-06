/**
 * scripts/beat.sh from the repo, with a fresh HOME and ONCE_UPON_HOME: the progress line it writes comes from config.json's
 * board_progress_file (the one setting the CLI's mirror reads too), the registry event goes through the CLI it finds, and
 * nothing outside the temp folders is read or written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runCli, tmp, writeJson } from './helpers.ts';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { beatLine } from '@once-upon-a-diff/state/records/agents/events';
import { CLI_BIN, ROOT, runScript, until, writeExecutable } from './script-helpers.ts';

const BEAT = path.join(ROOT, 'scripts/beat.sh');
const SID = 'abcdef01';
const CLI = `${process.execPath} ${CLI_BIN}`;
const TIME = /^- \d{1,2}:\d{2} [AP]M /;

/** A home with config.json, and a registered helper `name` in the session SID. */
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
  const env = { HOME: fakeHome, ONCE_UPON_HOME: home, ONCE_UPON_CLI: CLI };
  const beats = () => new AgentRegistry(home).agents().find((one) => one.name === name)?.beat;
  return { home, fakeHome, env, beats };
}

test('a beat appends one progress line to board_progress_file and registers the beat once', async () => {
  const file = path.join(tmp('beat-out'), 'progress.md');
  const { env, beats } = await setup('beat-a', { board_progress_file: file });
  const run = await runScript(BEAT, ['beat-a', '3/6', 'code', 'a', 'note'], env);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(await until(() => beats()?.n === 3), 'the CLI event arrives');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, '--no-mirror: the line is written once');
  assert.match(lines[0], /^- \d{1,2}:\d{2} [AP]M beat-a 3\/6 code: a note$/);
});

test('its line is the line `agent beat` mirrors for the same beat (the two writers cannot drift)', async () => {
  const viaCli = path.join(tmp('beat-pin-cli'), 'progress.md');
  const viaScript = path.join(tmp('beat-pin-script'), 'progress.md');
  const mirrored = await setup('beat-p', { board_progress_file: viaCli });
  const scripted = await setup('beat-p', { board_progress_file: viaScript });
  const beat = await runCli(
    mirrored.home,
    ['agent', 'beat', 'beat-p', '2/5', 'plan', '--', '--note with dashes'],
    {
      CLAUDE_CODE_SESSION_ID: `${SID}-1111-4222-8333-444444444444`,
    },
  );
  assert.equal(beat.code, 0, beat.stderr);
  const run = await runScript(BEAT, ['beat-p', '2/5', 'plan', '--note with dashes'], scripted.env);
  assert.equal(run.code, 0, run.stderr);
  const fromCli = readFileSync(viaCli, 'utf8').trim();
  const fromScript = readFileSync(viaScript, 'utf8').trim();
  assert.match(fromCli, TIME);
  assert.match(fromScript, TIME);
  assert.equal(fromScript.replace(TIME, ''), fromCli.replace(TIME, ''));
  // and the function the CLI writes it with, for a fixed instant
  const event = {
    at: '2026-11-06T20:40:00Z',
    name: 'beat-p',
    n: 2,
    of: 5,
    step: 'plan',
    note: 'n',
  };
  assert.equal(beatLine(event as never), '- 3:40 PM beat-p 2/5 plan: n');
});

test('a leading ~/ in board_progress_file is the user home, and with no setting nothing is written', async () => {
  const withTilde = await setup('beat-t', { board_progress_file: '~/notes/progress.md' });
  mkdirSync(path.join(withTilde.fakeHome, 'notes'));
  await runScript(BEAT, ['beat-t', '1/6', 'read'], withTilde.env);
  assert.match(
    readFileSync(path.join(withTilde.fakeHome, 'notes/progress.md'), 'utf8'),
    / beat-t 1\/6 read\n$/,
  );

  const bare = await setup('beat-n', {});
  const run = await runScript(BEAT, ['beat-n', '4/6', 'tests', 'n'], bare.env);
  assert.equal(run.code, 0);
  assert.ok(await until(() => bare.beats()?.n === 4), 'the registry event still arrives');
  assert.deepEqual(readdirSync(bare.fakeHome), [], 'the fresh user home is untouched');
});

test('with no node to read the config, the CLI mirrors the progress line itself, once', async () => {
  const file = path.join(tmp('beat-out'), 'progress.md');
  const { env, beats } = await setup('beat-m', { board_progress_file: file });
  const run = await runScript(BEAT, ['beat-m', '2/6', 'plan', 'n'], {
    ...env,
    PATH: '/usr/bin:/bin',
  });
  assert.equal(run.code, 0, run.stderr);
  assert.ok(await until(() => beats()?.n === 2), 'the CLI event arrives');
  assert.ok(await until(() => existsSync(file)), 'the CLI wrote the line');
  assert.match(readFileSync(file, 'utf8'), /^- \d{1,2}:\d{2} [AP]M beat-m 2\/6 plan: n\n$/);
});

test('a beat for an agent that was never registered still writes its progress line and exits 0', async () => {
  const file = path.join(tmp('beat-out'), 'progress.md');
  const { env } = await setup('beat-known', { board_progress_file: file });
  const run = await runScript(BEAT, ['unregistered', '1/6', 'read'], env);
  assert.equal(run.code, 0);
  assert.match(readFileSync(file, 'utf8'), / unregistered 1\/6 read\n$/);
});

test('a bad step, tag or label is refused with exit 1 and writes nothing; a bare N is N/6', async () => {
  const file = path.join(tmp('beat-out'), 'progress.md');
  const { env } = await setup('beat-b', { board_progress_file: file });
  for (const args of [
    ['beat-b', '7/3', 'code'],
    ['bad tag', '1/6', 'code'],
    ['beat-b', '1/6', 'two words'],
    ['beat-b', '0/6', 'code'],
  ]) {
    const run = await runScript(BEAT, args, env);
    assert.equal(run.code, 1, args.join(' '));
  }
  assert.equal(existsSync(file), false);
  await runScript(BEAT, ['beat-b', '3', 'code'], env);
  assert.match(readFileSync(file, 'utf8'), / beat-b 3\/6 code\n$/);
});

test('the CLI is $ONCE_UPON_CLI when set, else once-upon on PATH under Node 24', async () => {
  const bin = tmp('beat-bin');
  const log = path.join(bin, 'argv.txt');
  writeExecutable(path.join(bin, 'once-upon'), `printf '%s\\n' "$*" >> "${log}"`);
  const home = tmp('beat-home');
  const fakeHome = tmp('beat-user');
  const env = {
    HOME: fakeHome,
    ONCE_UPON_HOME: home,
    ONCE_UPON_CLI: null,
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  };
  await runScript(BEAT, ['t', '1/2', 'read', '--', 'a note'], env);
  assert.ok(await until(() => existsSync(log)), 'the PATH once-upon ran');
  assert.equal(readFileSync(log, 'utf8').trim(), 'agent beat t 1/2 read -- -- a note');

  const other = path.join(bin, 'other.txt');
  writeExecutable(path.join(bin, 'mine'), `printf '%s\\n' "$*" >> "${other}"`);
  await runScript(BEAT, ['t', '2/2', 'done'], { ...env, ONCE_UPON_CLI: path.join(bin, 'mine') });
  assert.ok(await until(() => existsSync(other)), 'ONCE_UPON_CLI ran');
  assert.equal(readFileSync(other, 'utf8').trim(), 'agent beat t 2/2 done');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'PATH was not used as well');
});

test('the scripts, skill and extras name no personal path', () => {
  const files = [
    'scripts/beat.sh',
    'scripts/heavy.sh',
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
