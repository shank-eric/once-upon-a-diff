/**
 * `agent auto-finish` (the SubagentStop hook's verb): a subagent that stopped with its run still open is finished, by
 * `auto-finish`, so the board does not show it as running forever. It reads the subagent's folder, not its words: the
 * transcript lives at <projects>/<proj>/<launching session>/subagents/agent-X.jsonl, next to agent-X.meta.json with the
 * Agent tool's `name` or a `name: task` description. Anything it cannot tie to one open run changes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, runCli, tmp, writeJson } from './helpers.ts';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';

const SID = 'abcdef01';
const SESSION = `${SID}-1111-4222-8333-444444444444`;

function world() {
  const home = tmp('autofin-home');
  const ledger = path.join(tmp('autofin-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  writeJson(path.join(home, 'config.json'), { board_ledger_file: ledger });
  const registry = new AgentRegistry(home, { ledger, progress: null });
  const projects = tmp('autofin-projects');
  /** A subagent's files as Claude Code lays them out; returns the transcript path. */
  const subagent = (meta: Record<string, unknown> | null, session = SESSION, id = 'a1') => {
    const dir = path.join(projects, 'proj', session, 'subagents');
    mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, `agent-${id}.jsonl`);
    writeFileSync(transcript, '');
    if (meta) {
      writeJson(path.join(dir, `agent-${id}.meta.json`), meta);
    }
    return transcript;
  };
  const stop = (transcript: string, extra: string[] = []) =>
    runCli(home, ['agent', 'auto-finish', '--transcript', transcript, ...extra]);
  const finishes = () => registry.events().filter((one) => one.op === 'finish');
  const run = (name: string) => registry.agents().find((one) => one.name === name);
  return { home, ledger, registry, subagent, stop, finishes, run };
}

const start = (
  registry: AgentRegistry,
  name: string,
  input: Partial<Parameters<AgentRegistry['start']>[0]> = {},
) => registry.start({ name, sid: SID, kind: 'author', task: 'x', ...input });

test('a stopped helper, researcher or storyteller whose run is running is finished done, by auto-finish, with a ledger line', async () => {
  const { registry, subagent, stop, finishes, run, ledger } = world();
  const names = ['ou-help', 'ou-find', 'ou-tell'];
  start(registry, 'ou-help', { kind: 'helper' });
  start(registry, 'ou-find', { kind: 'research' });
  start(registry, 'ou-tell', { kind: 'storyteller', card: 'bl_aaaaaaaaaaaaaaaa' });
  for (const [index, name] of names.entries()) {
    const out = await stop(subagent({ description: `${name}: do it` }, SESSION, `id${index}`));
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.trim(), `${name} auto-finished`);
    assert.equal(run(name)?.state, 'done', name);
    assert.equal(run(name)?.outcome, 'auto-finished');
  }
  assert.deepEqual(
    finishes().map((one) => [one.name, one.state, one.by, one.outcome]),
    names.map((name) => [name, 'done', 'auto-finish', 'auto-finished']),
  );
  assert.match(readFileSync(ledger, 'utf8'), /\[done\] sid:abcdef01 ou-help .*auto-finished/);
});

test('a stopped author (running or fixing) or critic run is failed, not done: a failed run puts its card where a failure goes', async () => {
  const { registry, subagent, stop, finishes, run, ledger } = world();
  start(registry, 'ou-run');
  start(registry, 'ou-fix');
  registry.state('ou-fix', { sid: SID, state: 'fixing' });
  start(registry, 'ou-critic', { kind: 'critic', card: 'bl_aaaaaaaaaaaaaaaa' });
  const names = ['ou-run', 'ou-fix', 'ou-critic'];
  for (const [index, name] of names.entries()) {
    const out = await stop(subagent({ description: `${name}: do it` }, SESSION, `id${index}`));
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.trim(), `${name} auto-finished`);
    assert.equal(run(name)?.state, 'failed', name);
    assert.equal(run(name)?.outcome, 'stopped without agent finish');
  }
  assert.deepEqual(
    finishes().map((one) => [one.name, one.state, one.by, one.outcome]),
    names.map((name) => [name, 'failed', 'auto-finish', 'stopped without agent finish']),
  );
  assert.match(
    readFileSync(ledger, 'utf8'),
    /\[failed\] sid:abcdef01 ou-run .*stopped without agent finish/,
  );
  // the card's column comes from the run's `failed` state (board columns.ts: pinned in board/test/agent-cards.test.ts)
});

test('the Agent tool name in meta.json wins over the description prefix, and the launching session comes from the folder', async () => {
  const { registry, subagent, stop, run } = world();
  start(registry, 'ou-named');
  start(registry, 'ou-other');
  // the hook's own session id is another one: the folder is the launching session
  const out = await stop(subagent({ name: 'ou-named', description: 'ou-other: x' }, SESSION, 'a'), [
    '--session',
    'ffffffff-0000-4000-8000-000000000000',
  ]);
  assert.equal(out.stdout.trim(), 'ou-named auto-finished');
  assert.equal(run('ou-named')?.state, 'failed');
  assert.equal(run('ou-other')?.state, 'running');
});

test('a run parked on purpose, over already, standing, an editor or a --self run is left alone', async () => {
  const { registry, subagent, stop, finishes } = world();
  start(registry, 'ou-plan');
  registry.state('ou-plan', { sid: SID, state: 'plan' });
  start(registry, 'ou-asked');
  registry.state('ou-asked', { sid: SID, state: 'waiting', outcome: 'which?' });
  start(registry, 'ou-review');
  registry.state('ou-review', { sid: SID, state: 'review', outcome: 'story' });
  for (const [name, state] of [
    ['ou-done', 'done'],
    ['ou-failed', 'failed'],
    ['ou-stopped', 'stopped'],
  ] as const) {
    start(registry, name);
    registry.finish(name, { sid: SID, state, outcome: 'by hand' });
  }
  start(registry, 'ou-standing', { kind: 'helper', standing: true });
  start(registry, 'ou-editor', { kind: 'editor' });
  start(registry, 'self-abc123', { kind: 'author' });
  const before = registry.events().length;
  const names = [
    'ou-plan',
    'ou-asked',
    'ou-review',
    'ou-done',
    'ou-failed',
    'ou-stopped',
    'ou-standing',
    'ou-editor',
    'self-abc123',
  ];
  for (const [index, name] of names.entries()) {
    const out = await stop(subagent({ description: `${name}: x` }, SESSION, `p${index}`));
    assert.equal(out.code, 0, `${name}: ${out.stderr}`);
    assert.equal(out.stdout, '', name);
  }
  assert.equal(registry.events().length, before);
  assert.deepEqual(
    finishes().map((one) => one.by),
    ['cli', 'cli', 'cli'],
  );
});

test('nothing is guessed: no meta file, no name, an unknown run, another session, a bad transcript path', async () => {
  const { registry, subagent, stop } = world();
  start(registry, 'ou-run');
  const before = registry.events().length;
  const other = 'bbbbbbbb-1111-4222-8333-444444444444';
  const cases: string[] = [
    subagent(null, SESSION, 'nometa'),
    subagent({ description: 'no prefix here' }, SESSION, 'noname'),
    subagent({ agentType: 'x' }, SESSION, 'nodesc'),
    subagent({ description: 'ou-ghost: x' }, SESSION, 'ghost'),
    subagent({ description: 'ou-run: x' }, other, 'elsewhere'),
    path.join(tmp('autofin-nowhere'), 'agent-x.jsonl'),
    '',
  ];
  for (const transcript of cases) {
    const out = await stop(transcript);
    assert.equal(out.code, 0, `${transcript}: ${out.stderr}`);
    assert.equal(out.stdout, '', transcript);
  }
  assert.equal(registry.events().length, before);
});

test('a second stop on a finished run writes nothing', async () => {
  const { registry, subagent, stop, finishes } = world();
  start(registry, 'ou-run');
  const transcript = subagent({ description: 'ou-run: x' });
  await stop(transcript);
  const out = await stop(transcript);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout, '');
  assert.equal(finishes().length, 1);
});

test('a real finish after an auto-finish is accepted and replaces it: its state, outcome, commit and findings win', async () => {
  const { home, registry, subagent, stop, finishes, run, ledger } = world();
  start(registry, 'ou-run');
  const transcript = subagent({ description: 'ou-run: x' });
  await stop(transcript);
  assert.equal(run('ou-run')?.outcome, 'stopped without agent finish');
  const sha = 'a'.repeat(40);
  const done = await runCli(home, [
    'agent',
    'finish',
    'ou-run',
    '--sid',
    SID,
    '--state',
    'failed',
    '--outcome',
    'really failed',
    '--commit',
    sha,
    '--findings',
    '2',
  ]);
  assert.equal(done.code, 0, done.stderr);
  const now = run('ou-run');
  assert.equal(now?.state, 'failed');
  assert.equal(now?.outcome, 'really failed');
  assert.equal(now?.result?.commit, sha);
  assert.equal(now?.findings, 2);
  assert.equal(finishes().length, 2);
  assert.match(readFileSync(ledger, 'utf8'), /\[failed\] sid:abcdef01 ou-run/);
  // a real finish is final: another stop does not auto-finish over it, and a second real finish is refused
  const again = await stop(transcript);
  assert.equal(again.stdout, '');
  assert.equal(run('ou-run')?.outcome, 'really failed');
  const second = await runCli(home, ['agent', 'finish', 'ou-run', '--sid', SID]);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already finished/);
});

test('a state after an auto-finish is accepted like a finish: the run is parked as asked, and the stop is no longer its end', async () => {
  const { home, registry, subagent, stop, run, ledger } = world();
  start(registry, 'ou-plan');
  start(registry, 'ou-late');
  await stop(subagent({ description: 'ou-plan: x' }));
  await stop(subagent({ description: 'ou-late: x' }, SESSION, 'a2'));
  assert.equal(run('ou-plan')?.outcome, 'stopped without agent finish');
  const waiting = await runCli(home, [
    'agent',
    'state',
    'ou-plan',
    '--sid',
    SID,
    '--state',
    'waiting',
    '--outcome',
    'which one?',
  ]);
  assert.equal(waiting.code, 0, waiting.stderr);
  const parked = run('ou-plan');
  assert.equal(parked?.state, 'waiting');
  assert.equal(parked?.outcome, 'which one?');
  assert.equal(parked?.autoFinished, undefined);
  assert.equal(parked?.result, null);
  assert.match(readFileSync(ledger, 'utf8'), /\[waiting\] sid:abcdef01 ou-plan/);
  // a later stop leaves a run parked on a person alone, and the agent's own finish still ends it
  await stop(subagent({ description: 'ou-plan: x' }));
  assert.equal(run('ou-plan')?.state, 'waiting');
  const review = await runCli(home, ['agent', 'state', 'ou-late', '--state', 'review']);
  assert.equal(review.code, 0, review.stderr);
  assert.equal(run('ou-late')?.state, 'waiting');
  assert.equal(run('ou-late')?.review, true);
  // a run that is over for real still refuses a state
  registry.finish('ou-plan', { sid: SID });
  const over = await runCli(home, [
    'agent',
    'state',
    'ou-plan',
    '--sid',
    SID,
    '--state',
    'waiting',
  ]);
  assert.notEqual(over.code, 0);
});

test('a resumed agent that registers a new run and stops again is auto-finished again; one that finished for real is not', async () => {
  const { registry, subagent, stop, finishes, run } = world();
  start(registry, 'ou-run');
  const transcript = subagent({ description: 'ou-run: x' });
  await stop(transcript);
  start(registry, 'ou-run');
  assert.equal(run('ou-run')?.state, 'running');
  const out = await stop(transcript);
  assert.equal(out.stdout.trim(), 'ou-run auto-finished');
  assert.equal(finishes().length, 2);
  registry.finish('ou-run', { sid: SID, outcome: 'by hand' });
  start(registry, 'ou-run');
  registry.finish('ou-run', { sid: SID, outcome: 'by hand 2' });
  const last = await stop(transcript);
  assert.equal(last.stdout, '');
  assert.equal(run('ou-run')?.outcome, 'by hand 2');
});

test('a failed auto-finish records no commit, as any failed run: the author did not report one', async () => {
  const { registry, subagent, stop, run } = world();
  const fixture = worktreeFixture();
  git(fixture.main, 'checkout', '-q', '--detach');
  const dir = fixture.add('feat-x');
  start(registry, 'ou-run', { branch: 'feat-x', cwd: fixture.main });
  assert.ok(run('ou-run')?.tip, 'the branch existed at the start');
  fixture.commit(dir, 'work');
  const out = await stop(subagent({ description: 'ou-run: x' }));
  assert.equal(out.code, 0, out.stderr);
  assert.equal(run('ou-run')?.result ?? null, null);
});

test('an auto-finished run with no kind is failed, not done, as any author', async () => {
  const { home, registry, subagent, stop, run } = world();
  // an old row has no kind: drop it from the start row
  start(registry, 'ou-nokind');
  const file = path.join(home, 'agents.jsonl');
  writeFileSync(
    file,
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => (line ? JSON.stringify({ ...JSON.parse(line), kind: undefined }) : line))
      .join('\n'),
  );
  assert.equal(run('ou-nokind')?.kind ?? null, null);
  await stop(subagent({ description: 'ou-nokind: x' }));
  assert.equal(run('ou-nokind')?.state, 'failed');
});

test('a run that reopens after an auto-finish loses its ack, so a later failure shows', async () => {
  const { home, registry, subagent, stop, run } = world();
  start(registry, 'ou-ack');
  await stop(subagent({ description: 'ou-ack: x' }));
  registry.ack('ou-ack', { sid: SID });
  assert.ok(run('ou-ack')?.acked);
  const out = await runCli(home, ['agent', 'state', 'ou-ack', '--sid', SID, '--state', 'running']);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(run('ou-ack')?.acked, undefined);
});
