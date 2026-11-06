/**
 * The 24-hour sweep: a run that should be beating and has been silent for a day is closed with a `finish --state stopped
 * --by sweep`, so the ledger's last line for it closes. A run parked on you (a question, a plan check, a story review) is
 * never swept, however old, and neither is a standing helper or an editor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runCli, tmp, writeJson } from './helpers.ts';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';

const ago = (hours: number) => new Date(Date.now() - hours * 3600 * 1000);
const SID = 'abcdef01';

function world() {
  const home = tmp('sweep-home');
  const ledger = path.join(tmp('sweep-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  writeJson(path.join(home, 'config.json'), { board_ledger_file: ledger });
  const registry = new AgentRegistry(home, { ledger, progress: null });
  const states = () => new Map(registry.agents().map((one) => [one.name, one.state]));
  return { home, ledger, registry, states };
}

test('agent sweep stops a running or fixing run silent for 25 hours, by sweep, with a ledger line that closes it', async () => {
  const { home, ledger, registry, states } = world();
  registry.start({ name: 'ou-dead', sid: SID, kind: 'author', task: 'x', at: ago(25) });
  registry.start({ name: 'ou-fix', sid: SID, kind: 'author', task: 'x', at: ago(30) });
  registry.state('ou-fix', { state: 'fixing', at: ago(26) });
  const swept = await runCli(home, ['agent', 'sweep']);
  assert.equal(swept.code, 0, swept.stderr);
  assert.deepEqual(
    [...states()],
    [
      ['ou-dead', 'stopped'],
      ['ou-fix', 'stopped'],
    ],
  );
  const finish = registry.events().filter((one) => one.op === 'finish');
  assert.deepEqual(
    finish.map((one) => [one.name, one.state, one.by]),
    [
      ['ou-dead', 'stopped', 'sweep'],
      ['ou-fix', 'stopped', 'sweep'],
    ],
  );
  assert.match(readFileSync(ledger, 'utf8'), /\[stopped\] sid:abcdef01 ou-dead/);
});

test('agent sweep leaves a 23-hour run, a beat is a sign of life, and a second sweep writes nothing', async () => {
  const { home, registry, states } = world();
  registry.start({ name: 'ou-fresh', sid: SID, kind: 'author', task: 'x', at: ago(23) });
  registry.start({ name: 'ou-beating', sid: SID, kind: 'author', task: 'x', at: ago(40) });
  registry.beat('ou-beating', { sid: SID, n: 1, of: 4, step: 'read', at: ago(2) });
  registry.start({ name: 'ou-dead', sid: SID, kind: 'author', task: 'x', at: ago(25) });
  await runCli(home, ['agent', 'sweep']);
  assert.deepEqual(
    [...states()],
    [
      ['ou-fresh', 'running'],
      ['ou-beating', 'running'],
      ['ou-dead', 'stopped'],
    ],
  );
  const before = registry.events().length;
  await runCli(home, ['agent', 'sweep']);
  assert.equal(registry.events().length, before);
});

test('agent sweep never closes a run parked on you: a question, a plan check or a story review, however old', async () => {
  const { home, registry, states } = world();
  for (const name of ['ou-asked', 'ou-plan', 'ou-review']) {
    registry.start({ name, sid: SID, kind: 'author', task: 'x', at: ago(100) });
  }
  registry.state('ou-asked', { state: 'waiting', outcome: 'which?', at: ago(80) });
  registry.state('ou-plan', { state: 'plan', at: ago(80) });
  registry.state('ou-review', { state: 'review', outcome: 'story abc', at: ago(80) });
  const swept = await runCli(home, ['agent', 'sweep']);
  assert.equal(swept.code, 0, swept.stderr);
  assert.deepEqual(
    [...states()],
    [
      ['ou-asked', 'waiting'],
      ['ou-plan', 'plan'],
      ['ou-review', 'waiting'],
    ],
  );
});

test('agent sweep leaves every helper (standing or not) and an editor registered as a helper, however silent', async () => {
  const { home, registry, states } = world();
  registry.start({ name: 'a-lookup', sid: SID, kind: 'helper', task: 'x', at: ago(25) });
  // the live editor skill registers the editor as a helper, and an editor never beats
  registry.start({ name: 'editor-abcdef01', sid: SID, kind: 'helper', task: 'q', at: ago(90) });
  registry.start({ name: 'a-scout', sid: SID, kind: 'research', task: 'x', at: ago(25) });
  registry.start({ name: 'tell-quiet', sid: SID, kind: 'storyteller', task: 'x', at: ago(25) });
  registry.start({ name: 'ou-dead', sid: SID, kind: 'author', task: 'x', at: ago(25) });
  registry.start({ name: 'review-dead', sid: SID, kind: 'critic', task: 'x', at: ago(25) });
  const swept = await runCli(home, ['agent', 'sweep']);
  assert.equal(swept.code, 0, swept.stderr);
  assert.deepEqual(
    [...states()],
    [
      ['a-lookup', 'running'],
      ['editor-abcdef01', 'running'],
      ['a-scout', 'running'],
      ['tell-quiet', 'running'],
      ['ou-dead', 'stopped'],
      ['review-dead', 'stopped'],
    ],
  );
});

test('agent sweep leaves a standing helper and an editor, and --dry-run writes nothing', async () => {
  const { home, registry, states } = world();
  registry.start({
    name: 'backlog-clerk',
    sid: SID,
    kind: 'helper',
    standing: true,
    task: 'clerk',
    at: ago(90),
  });
  registry.start({
    name: 'editor-one',
    sid: SID,
    kind: 'editor',
    slots: 3,
    task: 'q',
    at: ago(90),
  });
  registry.start({ name: 'ou-dead', sid: SID, kind: 'author', task: 'x', at: ago(25) });
  const dry = await runCli(home, ['agent', 'sweep', '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /ou-dead/);
  assert.equal(states().get('ou-dead'), 'running');
  await runCli(home, ['agent', 'sweep']);
  assert.deepEqual(
    [...states()],
    [
      ['backlog-clerk', 'running'],
      ['editor-one', 'running'],
      ['ou-dead', 'stopped'],
    ],
  );
});

test('agent start sweeps as it writes', async () => {
  const { home, registry, states } = world();
  registry.start({ name: 'ou-dead', sid: SID, kind: 'author', task: 'x', at: ago(25) });
  const started = await runCli(home, [
    'agent',
    'start',
    'ou-new',
    '--kind',
    'author',
    '--sid',
    SID,
    '--task',
    'y',
  ]);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(states().get('ou-dead'), 'stopped');
  assert.equal(states().get('ou-new'), 'running');
});

test('agent finish does not sweep first: a silent run’s own finish still records its commit', async () => {
  const { home, registry } = world();
  registry.start({ name: 'ou-late', sid: SID, kind: 'author', task: 'x', at: ago(26) });
  const finished = await runCli(home, [
    'agent',
    'finish',
    'ou-late',
    '--sid',
    SID,
    '--commit',
    'abc1234',
  ]);
  assert.equal(finished.code, 0, finished.stderr);
  const [one] = registry.agents();
  assert.equal(one.state, 'done');
  assert.equal(one.result?.commit, 'abc1234');
});
