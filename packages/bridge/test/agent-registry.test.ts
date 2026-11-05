import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, runCli, tmp, writeJson } from './helpers.ts';
import { runGit } from '@once-upon-a-diff/core/adapters/git';
import { branchTip } from '@once-upon-a-diff/core/records/agents/made';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { Board, noPrWatcher } from '@once-upon-a-diff/core/orchestration/board/board';
import { AgentRegistry } from '@once-upon-a-diff/core/records/agents/registry';
import { runIsOpen } from '@once-upon-a-diff/core/records/agents/events';
import { appendAgentEvent } from '@once-upon-a-diff/core/adapters/stores/agents-file';
import { finishedColumn } from '@once-upon-a-diff/core/orchestration/board/agent-home';
import { workingIn } from '@once-upon-a-diff/core/records/worktrees/worktrees';
import { gateOf } from '@once-upon-a-diff/core/records/agents/ledger';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { StoryStore } from '@once-upon-a-diff/core/records/stories/store';
import { Builds } from '@once-upon-a-diff/core/queues/requests/builds';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';

const SID = 'abcdef01';
const OTHER = '12345678';
const minute = (minutes: number) => new Date(Date.parse('2026-11-03T15:00:00Z') + minutes * 60000);
const NOW = minute(30);

const BUILD = { name: 'ou-thing', sid: SID, kind: 'author', task: 'build the thing' } as const;

test('the registry takes any card id the backlog does (6 to 24 characters) and any full git sha', () => {
  const registry = new AgentRegistry(tmp('reg-card'));
  const card = `bl_${'a1'.repeat(12)}`; // 24 characters after bl_
  registry.start({ ...BUILD, card, at: minute(0) });
  assert.equal(registry.agents()[0].card, card);
  assert.throws(
    () => registry.start({ ...BUILD, name: 'ou-other', card: `${card}z`, at: minute(1) }),
    /the card/,
  );
  registry.finish('ou-thing', { result: { commit: 'f'.repeat(64) }, at: minute(2) });
  assert.equal(registry.agents()[0].result?.commit, 'f'.repeat(64));
});

test('start, beat, finish round trip folds to one agent with exact times', () => {
  const registry = new AgentRegistry(tmp('reg-round'));
  const run = registry.start({
    ...BUILD,
    model: 'sonnet',
    effort: 'high',
    repo: 'acme/widgets',
    branch: 'thing',
    pr: 7,
    cwd: '/work/widgets-worktrees/thing',
    card: 'bl_abc123def456',
    at: minute(0),
  });
  assert.match(run.run, /^r_/);
  assert.equal(run.id, `${SID}:ou-thing`);
  registry.beat('ou-thing', { n: 2, of: 6, step: 'plan', note: 'plan written', at: minute(5) });
  let [agent] = registry.agents();
  assert.equal(agent.state, 'running');
  assert.equal(agent.kind, 'author');
  assert.equal(agent.task, 'build the thing');
  assert.equal(agent.model, 'sonnet, high');
  assert.equal(agent.repo, 'acme/widgets');
  assert.equal(agent.branch, 'thing');
  assert.equal(agent.pr, 7);
  assert.equal(agent.cwd, '/work/widgets-worktrees/thing');
  assert.equal(agent.card, 'bl_abc123def456');
  assert.equal(agent.started?.toISOString(), minute(0).toISOString());
  assert.deepEqual(agent.beat, { n: 2, of: 6, step: 'plan', note: 'plan written' });
  assert.equal(agent.lastEvent?.toISOString(), minute(5).toISOString());

  registry.finish('ou-thing', {
    outcome: 'built it',
    result: { commit: 'abc1234', branch: 'thing' },
    findings: 2,
    at: minute(20),
  });
  [agent] = registry.agents();
  assert.equal(agent.state, 'done');
  assert.equal(agent.ended?.toISOString(), minute(20).toISOString());
  assert.equal(agent.outcome, 'built it');
  assert.deepEqual(agent.result, { commit: 'abc1234', branch: 'thing' });
  assert.equal(agent.findings, 2);
  // finishing again is refused (an amended --commit would be lost), and a beat after the end is refused
  assert.throws(
    () => registry.finish('ou-thing', { result: { commit: 'def5678' }, at: minute(21) }),
    /already finished.*agent start/,
  );
  assert.equal(registry.events().length, 3);
  assert.throws(() => registry.beat('ou-thing', { n: 3, of: 6, step: 'code' }), /no open run/);
});

test('a second start is a new run: the first is kept in earlier and its beat is not the new run', () => {
  const registry = new AgentRegistry(tmp('reg-rerun'));
  registry.start({ ...BUILD, at: minute(0) });
  registry.beat('ou-thing', { n: 6, of: 6, step: 'done', at: minute(3) });
  registry.finish('ou-thing', { at: minute(4) });
  registry.start({ ...BUILD, task: 'again', at: minute(10) });
  const [agent] = registry.agents();
  assert.equal(agent.state, 'running');
  assert.equal(agent.task, 'again');
  assert.equal(agent.beat, null, 'a rerun starts with no beat');
  assert.equal(agent.earlier?.length, 1);
  assert.equal(agent.earlier?.[0].state, 'done');
  assert.deepEqual(agent.earlier?.[0].beat, { n: 6, of: 6, step: 'done', note: '' });
});

test('states fold to the ledger states and gates: plan, fixing with a count, review, waiting', () => {
  const registry = new AgentRegistry(tmp('reg-states'));
  registry.start({ ...BUILD, at: minute(0) });
  registry.state('ou-thing', { state: 'plan', outcome: 'plan ready', at: minute(1) });
  assert.equal(registry.agents()[0].state, 'plan');
  registry.state('ou-thing', { state: 'running', at: minute(2) });
  assert.equal(registry.agents()[0].state, 'running');
  assert.equal(registry.agents()[0].ended, null);
  registry.state('ou-thing', { state: 'fixing', findings: 5, at: minute(3) });
  assert.equal(registry.agents()[0].findings, 5);
  registry.state('ou-thing', { state: 'review', outcome: 'story up', at: minute(4) });
  const [agent] = registry.agents();
  assert.equal(agent.state, 'waiting');
  assert.equal(agent.review, true);
  assert.equal(agent.outcome, 'story up');
  assert.throws(() => registry.state('ou-thing', { state: 'nonsense' as never }), /state/);
});

test('validation: kind, name, sid, repo, beat shape and a missing run', () => {
  const registry = new AgentRegistry(tmp('reg-validate'));
  assert.throws(() => registry.start({ ...BUILD, kind: 'wizard' as never }), /kind/);
  assert.throws(() => registry.start({ ...BUILD, name: 'two words' }), /not valid/);
  assert.throws(() => registry.start({ ...BUILD, sid: 'nothex' }), /session id/);
  assert.throws(() => registry.start({ ...BUILD, repo: 'nope' }), /repo/);
  assert.throws(() => registry.start({ ...BUILD, task: '' }), /task/);
  assert.throws(() => registry.beat('ou-thing', { n: 1, of: 6, step: 'read' }), /no open run/);
  registry.start(BUILD);
  assert.throws(() => registry.beat('ou-thing', { n: 7, of: 6, step: 'read' }), /beat/);
  assert.throws(() => registry.beat('ou-thing', { n: 1, of: 6, step: 'two words' }), /beat/);
});

test('without a sid a beat finds the newest open run of the name; with one, that exact run', () => {
  const registry = new AgentRegistry(tmp('reg-resolve'));
  registry.start({ ...BUILD, sid: SID, at: minute(0) });
  registry.start({ ...BUILD, sid: OTHER, at: minute(5) });
  registry.beat('ou-thing', { n: 1, of: 6, step: 'read', at: minute(6) });
  const byId = (sid: string) => registry.agents().find((one) => one.sid === sid);
  assert.equal(byId(OTHER)?.beat?.step, 'read', 'the newest open run');
  assert.equal(byId(SID)?.beat, null);
  registry.beat('ou-thing', { n: 2, of: 6, step: 'plan', sid: SID, at: minute(7) });
  assert.equal(byId(SID)?.beat?.step, 'plan');
  assert.equal(byId(OTHER)?.beat?.step, 'read');
});

test('the CLI round trip: start takes the sid from the session, beat and finish find the run, and each writes its log line', async () => {
  const home = tmp('reg-cli');
  const notes = tmp('reg-cli-notes');
  const ledger = path.join(notes, 'ledger.md');
  const progress = path.join(notes, 'progress.md');
  writeFileSync(ledger, '');
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_progress_file: progress,
  });
  const env = { CLAUDE_CODE_SESSION_ID: `${SID}-0000-4000-8000-000000000000` };
  const started = await runCli(
    home,
    ['agent', 'start', 'ou-cli', '--kind', 'reviewer', '--task', 'check the thing — now'],
    env,
  );
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stdout, new RegExp(`${SID}:ou-cli r_`));
  const beat = await runCli(home, ['agent', 'beat', 'ou-cli', '3/6', 'code', 'half done']);
  assert.equal(beat.code, 0, beat.stderr);
  const state = await runCli(home, [
    'agent',
    'state',
    'ou-cli',
    '--state',
    'fixing',
    '--findings',
    '4',
  ]);
  assert.equal(state.code, 0, state.stderr);
  const finish = await runCli(home, [
    'agent',
    'finish',
    'ou-cli',
    '--outcome',
    'all done',
    '--commit',
    'abc1234',
  ]);
  assert.equal(finish.code, 0, finish.stderr);

  const listed = JSON.parse((await runCli(home, ['agent', 'list', '--all', '--json'])).stdout);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sid, SID);
  assert.equal(listed[0].kind, 'critic');
  assert.equal(listed[0].state, 'done');
  assert.equal(listed[0].beat.step, 'code');
  assert.equal(listed[0].result.commit, 'abc1234');
  assert.equal(listed[0].findings, 4);
  const events = readFileSync(path.join(home, 'agents.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(
    events.map((line) => JSON.parse(line).op),
    ['start', 'beat', 'state', 'finish'],
  );

  // the log files get one line per event (the exact format is pinned in the mirror test below)
  const time = '\\d{1,2}:\\d{2} [AP]M ET, \\d{1,2}/\\d{1,2}';
  const lines = readFileSync(ledger, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(
    lines[0],
    new RegExp(`^- \\[running\\] sid:${SID} ou-cli — check the thing - now — started ${time}$`),
  );
  assert.match(lines[1], new RegExp(`^- \\[fixing\\] sid:${SID} ou-cli — ${time} — 4 findings$`));
  assert.match(lines[2], new RegExp(`^- \\[done\\] sid:${SID} ou-cli — ${time} — all done$`));
  assert.match(
    readFileSync(progress, 'utf8'),
    /^- \d{1,2}:\d{2} [AP]M ou-cli 3\/6 code: half done\n$/,
  );

  const bad = await runCli(home, ['agent', 'start', 'ou-bad', '--kind', 'wizard', '--task', 'x']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /kind/);
  const noRun = await runCli(home, ['agent', 'beat', 'ou-ghost', '1/6', 'read']);
  assert.notEqual(noRun.code, 0);
});

test('--no-mirror: a beat from beat.sh, which writes the progress line itself, is one line and one event', async () => {
  const home = tmp('reg-nomirror');
  const notes = tmp('reg-nomirror-notes');
  const ledger = path.join(notes, 'ledger.md');
  const progress = path.join(notes, 'progress.md');
  writeFileSync(ledger, '');
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_progress_file: progress,
  });
  const env = { CLAUDE_CODE_SESSION_ID: `${SID}-0000-4000-8000-000000000000` };
  const started = await runCli(
    home,
    ['agent', 'start', 'ou-once', '--kind', 'builder', '--task', 'one line'],
    env,
  );
  assert.equal(started.code, 0, started.stderr);
  // beat.sh's own echo, then its detached call to the CLI
  const echoed = '- 3:40 PM ou-once 3/6 code: half done';
  writeFileSync(progress, echoed + '\n');
  const beat = await runCli(home, [
    'agent',
    'beat',
    'ou-once',
    '3/6',
    'code',
    'half done',
    '--no-mirror',
  ]);
  assert.equal(beat.code, 0, beat.stderr);
  assert.equal(readFileSync(progress, 'utf8'), echoed + '\n');
  const events = readFileSync(path.join(home, 'agents.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.op),
    ['start', 'beat'],
  );
  // the ledger's start line is still the mirror's, written once
  assert.equal(readFileSync(ledger, 'utf8').trim().split('\n').length, 1);
  // a note that starts with -- is the beat's note, passed after the -- marker as beat.sh does
  const dashed = await runCli(home, [
    'agent',
    'beat',
    'ou-once',
    '4/6',
    'tests',
    '--no-mirror',
    '--',
    '--force removed',
  ]);
  assert.equal(dashed.code, 0, dashed.stderr);
  const lastBeat = readFileSync(path.join(home, 'agents.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .pop();
  assert.equal(lastBeat.note, '--force removed');
  assert.equal(readFileSync(progress, 'utf8').trim().split('\n').length, 1);
  // without the flag the CLI still writes the line itself
  const plain = await runCli(home, ['agent', 'beat', 'ou-once', '5/6', 'green']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(readFileSync(progress, 'utf8').trim().split('\n').length, 2);
});

/** A board over `home` (no ledger file set), and every card on it. */
function boardOf(home: string, now = NOW) {
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('reg-sessions') });
  return async (): Promise<BoardCard[]> =>
    (
      await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
        source: registrySource,
        now: () => now,
      }).snapshot()
    ).lanes.flatMap((lane) => lane.cards);
}

test('the board reads registered events with no ledger file: column, beat, and the agent kind', async () => {
  const home = tmp('reg-board');
  const registry = new AgentRegistry(home);
  registry.start({ ...BUILD, at: minute(0) });
  registry.beat('ou-thing', { n: 3, of: 6, step: 'code', note: 'writing', at: minute(10) });
  const cards = await boardOf(home)();
  const card = cards.find((one) => one.kind === 'agent' && one.title === 'ou-thing');
  assert.ok(card, 'the registered agent has a card');
  assert.equal(card.column, 'working');
  const [view] = card.agents;
  assert.equal(view.kind, 'author');
  assert.equal(view.task, 'build the thing');
  assert.deepEqual(view.beat, { n: 3, of: 6, step: 'code', note: 'writing' });
  assert.equal(view.started_at, minute(0).toISOString());
});

test('role comes from kind, and the standing row from --standing, not from the name or the task text', async () => {
  const home = tmp('reg-kind');
  const registry = new AgentRegistry(home);
  registry.start({ name: 'rv-x', sid: SID, kind: 'critic', task: 'look at it', at: minute(0) });
  registry.start({
    name: 'review-board-ui',
    sid: SID,
    kind: 'author',
    task: 'build the board',
    at: minute(0),
  });
  registry.start({
    name: 'ou-clerk',
    sid: SID,
    kind: 'helper',
    standing: true,
    task: 'answer requests',
    at: minute(0),
  });
  registry.start({
    name: 'standing-helper-x',
    sid: SID,
    kind: 'helper',
    task: 'standing helper: one-shot',
    at: minute(0),
  });
  const cards = await boardOf(home)();
  const view = (name: string) =>
    cards.find((one) => one.kind === 'agent' && one.title === name)?.agents[0];
  assert.equal(view('ou-clerk'), undefined, 'a standing agent has no card, whatever its task says');
  assert.equal(view('standing-helper-x')?.kind, 'helper', 'a helper without --standing is a card');
  assert.equal(view('rv-x')?.gate?.kind, 'review');
  assert.equal(view('review-board-ui')?.gate, null);
});

test('a restart of the same sid:name keeps its kind and standing; another id or an explicit kind does not', () => {
  const registry = new AgentRegistry(tmp('reg-carry'));
  const clerk = { name: 'clerk', sid: SID, kind: 'helper', standing: true, task: 'ops' } as const;
  registry.start({ ...clerk, at: minute(0) });
  registry.finish('clerk', { state: 'done', at: minute(5) });
  const find = (sid = SID) =>
    registry.agents().find((one) => one.sid === sid && one.name === 'clerk');
  registry.start({ name: 'clerk', sid: SID, task: 'ops again', at: minute(10) });
  assert.equal(find()?.kind, 'helper');
  assert.equal(find()?.standing, true);
  assert.equal(find()?.state, 'running');
  assert.equal(find()?.earlier?.length, 1);
  // no earlier run of this id: a kind is still needed, and nothing is standing
  assert.throws(
    () => registry.start({ name: 'clerk', sid: OTHER, task: 'ops', at: minute(11) }),
    /the kind must be one of/,
  );
  registry.start({ name: 'clerk', sid: OTHER, kind: 'author', task: 'ops', at: minute(11) });
  assert.equal(find(OTHER)?.standing, false);
  // an explicit kind wins, standing stays
  registry.start({ name: 'clerk', sid: SID, kind: 'research', task: 'ops', at: minute(12) });
  assert.equal(find()?.kind, 'research');
  assert.equal(find()?.standing, true);
});

test('standing: true sets it, false clears it, left out carries the earlier run', () => {
  const registry = new AgentRegistry(tmp('reg-standing-clear'));
  const standing = () => registry.agents().find((one) => one.name === 'clerk')?.standing;
  const start = (when: number, flag?: boolean) => {
    registry.start({
      name: 'clerk',
      sid: SID,
      kind: 'helper',
      task: 'ops',
      ...(flag === undefined ? {} : { standing: flag }),
      at: minute(when),
    });
    const sure = standing();
    registry.finish('clerk', { state: 'done', at: minute(when + 1) });
    return sure;
  };
  assert.equal(start(0), false, 'never said: not standing');
  assert.equal(start(2, true), true);
  assert.equal(start(4), true, 'left out: carries over');
  assert.equal(start(6, false), false, 'false clears it');
  assert.equal(start(8), false, 'and the cleared value carries over');
});

test('the CLI: --standing on start, and a restart with no --kind or --standing keeps both', async () => {
  const home = tmp('reg-cli-standing');
  const env = { CLAUDE_CODE_SESSION_ID: `${SID}-0000-4000-8000-000000000000` };
  const listed = async () =>
    JSON.parse((await runCli(home, ['agent', 'list', '--all', '--json'], env)).stdout) as {
      name: string;
      kind: string;
      standing: boolean;
      state: string;
    }[];
  await runCli(
    home,
    ['agent', 'start', 'clerk', '--kind', 'helper', '--standing', '--task', 'card ops'],
    env,
  );
  assert.deepEqual(
    (await listed()).map((one) => [one.kind, one.standing]),
    [['helper', true]],
  );
  await runCli(home, ['agent', 'finish', 'clerk'], env);
  await runCli(home, ['agent', 'start', 'clerk', '--task', 'card ops again'], env);
  const [again] = await listed();
  assert.deepEqual([again.kind, again.standing, again.state], ['helper', true, 'running']);
  const plain = await runCli(
    home,
    ['agent', 'start', 'one-shot', '--kind', 'helper', '--task', 'x'],
    env,
  );
  assert.equal(plain.code, 0);
  assert.equal((await listed()).find((one) => one.name === 'one-shot')?.standing, false);
  // `--standing true` sets it and `--standing false` clears it, on a restart too
  await runCli(home, ['agent', 'finish', 'clerk'], env);
  await runCli(home, ['agent', 'start', 'clerk', '--standing', 'false', '--task', 'x'], env);
  assert.equal((await listed()).find((one) => one.name === 'clerk')?.standing, false);
  await runCli(home, ['agent', 'finish', 'clerk'], env);
  await runCli(home, ['agent', 'start', 'clerk', '--standing', 'true', '--task', 'x'], env);
  assert.equal((await listed()).find((one) => one.name === 'clerk')?.standing, true);
});

test('staleness runs from the last event: an agent that beats is live, a silent one is stale', async () => {
  const home = tmp('reg-stale');
  const registry = new AgentRegistry(home);
  registry.start({ ...BUILD, at: minute(-60 * 30) });
  // started 30 h ago, last beat 10 h ago
  registry.beat('ou-thing', { n: 2, of: 6, step: 'plan', at: minute(-60 * 10) });
  registry.start({ ...BUILD, name: 'ou-silent', at: minute(-60 * 30) });
  const cards = await boardOf(home)();
  const view = (name: string) =>
    cards.find((one) => one.kind === 'agent' && one.title === name)?.agents[0];
  assert.equal(view('ou-thing')?.stale, false);
  assert.equal(view('ou-silent')?.stale, true);
});

test('the board Finish on a registered agent writes a finish event', async () => {
  const home = tmp('reg-finish');
  const registry = new AgentRegistry(home);
  registry.start({ ...BUILD, task: 'research it', kind: 'research', at: minute(0) });
  registry.state('ou-thing', { state: 'waiting', outcome: 'needs a decision', at: minute(5) });
  boardOf(home);
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => NOW,
  });
  const answer = board.finishAgent(SID, 'ou-thing');
  assert.equal(answer.ledger, true);
  assert.equal(registry.agents()[0].state, 'done');
  assert.equal(registry.events().at(-1)?.op, 'finish');
});

test('a registered agent that finishes with a result is Done, with no outcome text; an author with none waits', () => {
  const registry = new AgentRegistry(tmp('reg-made'));
  registry.start({ ...BUILD, at: minute(0) });
  registry.finish('ou-thing', { result: { commit: 'abc1234', branch: 'thing' }, at: minute(5) });
  const [built] = registry.agents();
  assert.equal(finishedColumn(built), 'done');
  registry.start({
    ...BUILD,
    name: 'ou-scout',
    task: 'look in widgets-worktrees/x',
    at: minute(6),
  });
  registry.finish('ou-scout', { outcome: 'pushed back on the plan', at: minute(7) });
  const scout = registry.agents().find((one) => one.name === 'ou-scout');
  assert.ok(scout);
  assert.equal(
    finishedColumn(scout),
    'waiting',
    'an author with no result waits, whatever its words',
  );
});

/** The column of a registered agent's card on the board. */
const columnOf = async (home: string, name: string) =>
  (await boardOf(home)()).find((one) => one.kind === 'agent' && one.title === name)?.column;

test('Done, Research or Waiting comes from the finish event, never its words', async () => {
  const home = tmp('reg-done-waiting');
  const registry = new AgentRegistry(home);
  const finished = (name: string, outcome: string, result: object = {}, kind = 'author') => {
    registry.start({ ...BUILD, name, kind: kind as 'author', at: minute(0) });
    registry.finish(name, { outcome, result, at: minute(5) });
  };
  finished('ou-negated', 'didn’t commit abc1234, nothing pushed');
  finished(
    'ou-words',
    'committed 0637f8f, pushed and deployed, branch feat/x, filed bl_mvzro4kube937c',
  );
  finished('ou-commit', 'ok', { commit: 'abc1234' });
  finished('ou-pr', 'ok', { pr: 7 });
  finished('ou-branch', 'ok', { branch: 'feat/x' });
  finished('ou-card', 'ok', { card: 'bl_mvzro4kube937c' });
  finished('ou-nothing', 'built nothing', {}, 'builder');
  finished('ou-scout', 'options laid out', {}, 'research');
  finished('ou-lookup', 'found it', {}, 'helper');
  finished('ou-scout-card', 'filed a card', { card: 'bl_mvzro4kube937c' }, 'research');
  registry.start({ ...BUILD, name: 'ou-asker', at: minute(0) });
  registry.state('ou-asker', { state: 'waiting', outcome: 'pick A or B', at: minute(5) });
  registry.start({ ...BUILD, name: 'ou-parked', at: minute(0) });
  registry.state('ou-parked', { state: 'review', outcome: 'story ready', at: minute(5) });
  const columns: Record<string, string | undefined> = {};
  for (const name of [
    'ou-negated',
    'ou-words',
    'ou-commit',
    'ou-pr',
    'ou-branch',
    'ou-card',
    'ou-nothing',
    'ou-scout',
    'ou-lookup',
    'ou-scout-card',
    'ou-asker',
    'ou-parked',
  ]) {
    columns[name] = await columnOf(home, name);
  }
  assert.deepEqual(columns, {
    'ou-negated': 'waiting',
    'ou-words': 'waiting',
    'ou-commit': 'done',
    'ou-pr': 'done',
    'ou-branch': 'done',
    'ou-card': 'done',
    'ou-nothing': 'waiting',
    'ou-scout': 'research',
    'ou-lookup': 'done',
    'ou-scout-card': 'done',
    'ou-asker': 'waiting',
    'ou-parked': 'ready',
  });
});

test('a helper that deploys and finishes with --commit made something', () => {
  const registry = new AgentRegistry(tmp('reg-helper'));
  registry.start({ ...BUILD, name: 'deploy-x', kind: 'helper', at: minute(0) });
  registry.finish('deploy-x', {
    outcome: 'deployed',
    result: { commit: 'abc1234' },
    at: minute(5),
  });
  assert.equal(finishedColumn(registry.agents()[0]), 'done');
});

test('a finish with no result records what the registered branch gained since the start tip, whatever the cwd', async () => {
  const fixture = worktreeFixture();
  git(fixture.main, 'checkout', '-q', '--detach');
  const home = tmp('reg-branch');
  const registry = new AgentRegistry(home);
  const begin = (name: string, branch: string | null) =>
    registry.start({ ...BUILD, name, branch, cwd: fixture.main, at: minute(0) });
  const resultOf = (name: string) =>
    registry.agents().find((one) => one.name === name)?.result ?? null;
  // the cwd is the main checkout, detached at main. A branch made after the start has no start tip to compare with, so
  // no result is guessed, whatever it holds: the author passes --commit
  begin('ou-new', 'new-branch');
  assert.equal(registry.agents()[0].tip, null);
  const dir = fixture.add('new-branch');
  fixture.commit(dir, 'work');
  registry.finish('ou-new', { at: minute(5) });
  assert.equal(resultOf('ou-new'), null);
  assert.equal(await columnOf(home, 'ou-new'), 'waiting');
  // deployed before it finished: main fast-forwarded to the branch, the ref is still there
  const deployed = fixture.add('deployed');
  begin('ou-deployed', 'deployed');
  fixture.commit(deployed, 'ship');
  git(fixture.main, 'checkout', '-q', '--detach', 'deployed');
  registry.finish('ou-deployed', { at: minute(5) });
  assert.equal(resultOf('ou-deployed')?.branch, 'deployed');
  assert.equal(await columnOf(home, 'ou-deployed'), 'done');
  // a branch that was there at the start and did not move: nothing made
  begin('ou-same', 'new-branch');
  registry.finish('ou-same', { at: minute(5) });
  assert.equal(resultOf('ou-same'), null);
  assert.equal(await columnOf(home, 'ou-same'), 'waiting');
  // the same branch moving on
  begin('ou-moved', 'new-branch');
  fixture.commit(dir, 'more', 2);
  registry.finish('ou-moved', { at: minute(5) });
  assert.equal(resultOf('ou-moved')?.commit, git(fixture.main, 'rev-parse', 'new-branch'));
  assert.equal(await columnOf(home, 'ou-moved'), 'done');
  // a result given on the command line is kept as given
  begin('ou-given', 'new-branch');
  fixture.commit(dir, 'again', 3);
  registry.finish('ou-given', { result: { commit: 'abc1234' }, at: minute(5) });
  assert.deepEqual(resultOf('ou-given'), { commit: 'abc1234' });
  // a failed run made nothing to point at
  begin('ou-failed', 'new-branch');
  fixture.commit(dir, 'failing', 4);
  registry.finish('ou-failed', { state: 'failed', at: minute(5) });
  assert.equal(resultOf('ou-failed'), null);
  // no branch registered, or the ref gone before the finish (a deploy removed it): no result, and finish still works
  begin('ou-no-branch', null);
  registry.finish('ou-no-branch', { at: minute(5) });
  assert.equal(resultOf('ou-no-branch'), null);
  const gone = fixture.add('gone');
  begin('ou-gone', 'gone');
  fixture.commit(gone, 'x');
  git(fixture.main, 'worktree', 'remove', '--force', gone);
  git(fixture.main, 'branch', '-D', 'gone');
  registry.finish('ou-gone', { at: minute(5) });
  assert.equal(resultOf('ou-gone'), null);
});

test('the automatic result is for a builder whose branch moved since its start tip: not for no start tip, a helper, reviewer or researcher, a stopped run, or another repo’s checkout', async () => {
  const fixture = worktreeFixture();
  git(fixture.main, 'checkout', '-q', '--detach');
  const home = tmp('reg-branch-gates');
  const registry = new AgentRegistry(home);
  const begin = (name: string, over: Record<string, unknown> = {}) =>
    registry.start({
      ...BUILD,
      name,
      branch: 'work',
      cwd: fixture.main,
      repo: 'acme/widgets',
      at: minute(0),
      ...over,
    } as Parameters<AgentRegistry['start']>[0]);
  const resultOf = (name: string) =>
    registry.agents().find((one) => one.name === name)?.result ?? null;
  // started before its branch existed: the worktree is cut at the base and nothing is committed (a plan-only or stopped
  // author, or a helper on an author's branch)
  begin('ou-cut-only');
  const dir = fixture.add('work');
  registry.finish('ou-cut-only', { at: minute(5) });
  assert.equal(resultOf('ou-cut-only'), null, 'no start tip, no result');
  assert.equal(await columnOf(home, 'ou-cut-only'), 'waiting');
  // an old start event has no tip either: the same
  appendAgentEvent(registry.file, {
    op: 'start',
    id: `${SID}:ou-old-start`,
    sid8: SID,
    name: 'ou-old-start',
    at: minute(0).toISOString(),
    run: 'r_old',
    kind: 'author',
    task: 'old',
    branch: 'work',
    cwd: fixture.main,
  });
  // the branch gains a commit: with no start tip it is still nobody's result
  fixture.commit(dir, 'work');
  const tip = git(fixture.main, 'rev-parse', 'work');
  registry.finish('ou-old-start', { at: minute(5) });
  assert.equal(resultOf('ou-old-start'), null);
  begin('ou-tipless', { branch: 'late' });
  registry.finish('ou-tipless', { at: minute(5) });
  assert.equal(resultOf('ou-tipless'), null, 'a branch that does not exist is nothing');
  // a helper, a reviewer and a researcher on a branch that moved: never an author's commit
  for (const kind of ['helper', 'reviewer', 'research']) {
    begin(`ou-${kind}`, { kind, branch: 'work' });
  }
  fixture.commit(dir, 'moved', 2);
  for (const kind of ['helper', 'reviewer', 'research']) {
    registry.finish(`ou-${kind}`, { at: minute(5) });
    assert.equal(resultOf(`ou-${kind}`), null, kind);
  }
  // a stopped run, and a failed one, made nothing, even with a result given
  begin('ou-stopped');
  fixture.commit(dir, 'moved again', 3);
  registry.finish('ou-stopped', { state: 'stopped', at: minute(5) });
  assert.equal(resultOf('ou-stopped'), null);
  begin('ou-stopped-given');
  registry.finish('ou-stopped-given', {
    state: 'stopped',
    result: { commit: 'abc1234' },
    at: minute(5),
  });
  assert.equal(
    finishedColumn(registry.agents().find((one) => one.name === 'ou-stopped-given')!),
    'waiting',
  );
  assert.equal(await columnOf(home, 'ou-stopped-given'), 'waiting');
  // another repo's checkout: neither the start tip nor the result is taken from it
  begin('ou-elsewhere', { repo: 'other/repo', branch: 'work' });
  assert.equal(registry.agents().find((one) => one.name === 'ou-elsewhere')?.tip, null);
  fixture.commit(dir, 'moved once more', 4);
  registry.finish('ou-elsewhere', { at: minute(5) });
  assert.equal(resultOf('ou-elsewhere'), null);
  // the same repo spelled in another case is a match
  begin('ou-cased', { repo: 'ACME/Widgets', branch: 'work' });
  assert.equal(registry.agents().find((one) => one.name === 'ou-cased')?.tip?.length, 40);
  fixture.commit(dir, 'last', 5);
  registry.finish('ou-cased', { at: minute(5) });
  assert.equal(resultOf('ou-cased')?.commit, git(fixture.main, 'rev-parse', 'work'));
  assert.notEqual(resultOf('ou-cased')?.commit, tip);
});

test('a git call that runs too long is killed: made.ts takes it as nothing made', () => {
  const fixture = worktreeFixture();
  assert.throws(() =>
    runGit(fixture.main, ['-c', 'alias.slow=!sleep 5', 'slow'], { quiet: true, timeoutMs: 100 }),
  );
  assert.equal(
    runGit(fixture.main, ['rev-parse', 'HEAD'], { quiet: true, timeoutMs: 3000 }).trim().length,
    40,
  );
});

test('a start or finish in a folder that is not a checkout still works, with no tip and no result', () => {
  const registry = new AgentRegistry(tmp('reg-not-git'));
  registry.start({ ...BUILD, branch: 'thing', cwd: tmp('not-a-checkout'), at: minute(0) });
  registry.start({
    ...BUILD,
    name: 'ou-nowhere',
    branch: 'thing',
    cwd: '/no/such/dir',
    at: minute(0),
  });
  assert.equal(registry.agents()[0].tip, null);
  registry.finish('ou-thing', { at: minute(5) });
  registry.finish('ou-nowhere', { at: minute(5) });
  assert.deepEqual(
    registry.agents().map((one) => [one.state, one.result]),
    [
      ['done', null],
      ['done', null],
    ],
  );
});

test('a torn last line does not swallow the next event', () => {
  const home = tmp('reg-torn');
  const registry = new AgentRegistry(home);
  registry.start({ ...BUILD, at: minute(0) });
  appendFileSync(registry.file, '{"op":"beat","id":"abcdef01:ou-thing","sid8"');
  registry.beat('ou-thing', { n: 1, of: 6, step: 'read', at: minute(2) });
  assert.equal(registry.agents()[0].beat?.step, 'read');
  assert.equal(registry.events().length, 2, 'the torn line is skipped, the new one is whole');
});

test('with no sid a beat prefers the caller session, and ignores runs that are stale or closed', () => {
  const registry = new AgentRegistry(tmp('reg-prefer'));
  registry.start({ ...BUILD, sid: SID, at: minute(0) });
  registry.start({ ...BUILD, sid: OTHER, at: minute(5) });
  // the older run is the caller's: it wins over the newer one
  registry.beat('ou-thing', { n: 1, of: 6, step: 'read', prefer: SID, at: minute(6) });
  const byId = (sid: string) => registry.agents().find((one) => one.sid === sid);
  assert.equal(byId(SID)?.beat?.step, 'read');
  assert.equal(byId(OTHER)?.beat, null);
  // a run silent for more than a day is not a candidate
  registry.start({ ...BUILD, name: 'ou-old', sid: SID, at: minute(0) });
  registry.start({ ...BUILD, name: 'ou-old', sid: OTHER, at: minute(60 * 30) });
  registry.beat('ou-old', { n: 1, of: 6, step: 'read', at: minute(60 * 30 + 1) });
  assert.equal(
    registry.agents().find((one) => one.name === 'ou-old' && one.sid === SID)?.beat,
    null,
  );
  assert.equal(
    registry.agents().find((one) => one.name === 'ou-old' && one.sid === OTHER)?.beat?.step,
    'read',
  );
  // finished runs are not candidates either
  registry.finish('ou-old', { sid: OTHER, at: minute(60 * 30 + 2) });
  assert.throws(
    () => registry.beat('ou-old', { n: 2, of: 6, step: 'plan', at: minute(60 * 30 + 3) }),
    /no open run/,
  );
});

test('events are keyed on their run: an old run cannot beat or close a restarted one', () => {
  const registry = new AgentRegistry(tmp('reg-runs'));
  const first = registry.start({ ...BUILD, at: minute(0) });
  const second = registry.start({ ...BUILD, task: 'again', at: minute(5) });
  assert.notEqual(first.run, second.run);
  // the CLI path refuses a run that is not the latest
  assert.throws(
    () => registry.beat('ou-thing', { n: 1, of: 6, step: 'read', run: first.run, at: minute(6) }),
    /no open run/,
  );
  assert.throws(
    () => registry.finish('ou-thing', { run: first.run, at: minute(6) }),
    /no open run/,
  );
  // and so does the fold, for an event written another way
  appendAgentEvent(registry.file, {
    op: 'finish',
    id: first.id,
    sid8: SID,
    name: 'ou-thing',
    at: minute(7).toISOString(),
    run: first.run,
    state: 'done',
  });
  appendAgentEvent(registry.file, {
    op: 'beat',
    id: first.id,
    sid8: SID,
    name: 'ou-thing',
    at: minute(8).toISOString(),
    run: first.run,
    n: 5,
    of: 6,
    step: 'code',
  });
  const [agent] = registry.agents();
  assert.equal(agent.state, 'running');
  assert.equal(agent.beat, null);
  registry.beat('ou-thing', { n: 1, of: 6, step: 'read', run: second.run, at: minute(9) });
  assert.equal(registry.agents()[0].beat?.step, 'read');
});

test('running again clears the last fixing round count', () => {
  const registry = new AgentRegistry(tmp('reg-findings'));
  registry.start({ ...BUILD, at: minute(0) });
  registry.state('ou-thing', { state: 'fixing', findings: 5, at: minute(1) });
  registry.state('ou-thing', { state: 'running', at: minute(2) });
  registry.state('ou-thing', { state: 'fixing', at: minute(3) });
  assert.equal(registry.agents()[0].findings, null);
});

test('agent start stores --cwd as an absolute path', async () => {
  const home = tmp('reg-cwd-cli');
  const env = { CLAUDE_CODE_SESSION_ID: `${SID}-0000-4000-8000-000000000000` };
  const started = await runCli(
    home,
    ['agent', 'start', 'ou-rel', '--kind', 'builder', '--task', 'x', '--cwd', 'some/where/../here'],
    env,
  );
  assert.equal(started.code, 0, started.stderr);
  assert.equal(new AgentRegistry(home).agents()[0].cwd, path.resolve('some/here'));
});

test('a registered agent works in the worktree its cwd is in', () => {
  const dir = '/work/widgets-worktrees/thing';
  const registry = new AgentRegistry(tmp('reg-cwd'));
  registry.start({ ...BUILD, name: 'ou-elsewhere', cwd: `${dir}/packages/x`, at: minute(0) });
  assert.deepEqual(workingIn(dir, [], registry.agents()), [
    { kind: 'agent', id: `${SID}:ou-elsewhere`, label: 'ou-elsewhere' },
  ]);
  registry.finish('ou-elsewhere', { at: minute(1) });
  assert.deepEqual(workingIn(dir, [], registry.agents()), []);
});

test('the mirror keeps the line format the scripts outside this repo parse (the subagent status line, the iTerm hook)', () => {
  const notes = tmp('reg-mirror-notes');
  const ledger = path.join(notes, 'ledger.md');
  const progress = path.join(notes, 'progress.md');
  const registry = new AgentRegistry(tmp('reg-mirror'), { ledger, progress });
  // 10:00 AM ET on 11/3 is minute(0)
  registry.start({ ...BUILD, model: 'sonnet', effort: 'high', lane: 'widgets', at: minute(0) });
  registry.beat('ou-thing', { n: 2, of: 6, step: 'plan', note: 'plan written', at: minute(5) });
  registry.state('ou-thing', {
    state: 'plan',
    outcome: 'plan ready — see notes',
    notes: 'notes/plan.md',
    at: minute(6),
  });
  registry.state('ou-thing', { state: 'running', at: minute(7) });
  registry.state('ou-thing', { state: 'fixing', findings: 3, at: minute(8) });
  registry.state('ou-thing', { state: 'waiting', outcome: 'needs Eric: A or B', at: minute(9) });
  registry.state('ou-thing', { state: 'review', outcome: 'story abc up', at: minute(10) });
  registry.finish('ou-thing', { outcome: 'merged', at: minute(11) });
  const head = `sid:${SID} lane:widgets ou-thing`;
  assert.deepEqual(readFileSync(ledger, 'utf8').split('\n'), [
    `- [running] ${head} (sonnet, high) — build the thing — started 10:00 AM ET, 11/3`,
    `- [plan] ${head} — 10:06 AM ET, 11/3 — plan ready - see notes — notes/plan.md`,
    `- [running] ${head} (sonnet, high) — build the thing — started 10:00 AM ET, 11/3`,
    `- [fixing] ${head} — 10:08 AM ET, 11/3 — 3 findings — notes/plan.md`,
    `- [waiting] ${head} — 10:09 AM ET, 11/3 — needs Eric: A or B — notes/plan.md`,
    `- [review] ${head} — 10:10 AM ET, 11/3 — story abc up — notes/plan.md`,
    `- [done] ${head} — 10:11 AM ET, 11/3 — merged — notes/plan.md`,
    '',
  ]);
  assert.equal(readFileSync(progress, 'utf8'), '- 10:05 AM ou-thing 2/6 plan: plan written\n');
});

test('an author in a GitHub Enterprise checkout registered with --repo gets a start tip, and a result when its branch moves', () => {
  const fixture = worktreeFixture('widgets', 'https://ghe.example.com/acme/widgets.git');
  const dir = fixture.add('work');
  const home = tmp('reg-ghe-tip');
  const registry = new AgentRegistry(home);
  const begin = (name: string, repo: string) =>
    registry.start({
      ...BUILD,
      name,
      branch: 'work',
      cwd: fixture.main,
      repo,
      at: minute(0),
    } as Parameters<AgentRegistry['start']>[0]);
  const tip = git(fixture.main, 'rev-parse', 'work');
  assert.equal(branchTip(fixture.main, 'work', 'acme/widgets'), tip);
  begin('ou-ghe', 'acme/widgets');
  begin('ou-other', 'other/thing');
  const agents = registry.agents();
  assert.equal(agents.find((one) => one.name === 'ou-ghe')?.tip, tip);
  assert.equal(agents.find((one) => one.name === 'ou-other')?.tip, null, "another repo's checkout");
  fixture.commit(dir, 'work');
  registry.finish('ou-ghe', { at: minute(5) });
  const result = registry.agents().find((one) => one.name === 'ou-ghe')?.result;
  assert.equal(result?.commit, git(fixture.main, 'rev-parse', 'work'));
  assert.equal(result?.branch, 'work');
});

test("a second finish from the caller's session is refused even when another session has an open run of the name", () => {
  const home = tmp('reg-finish-cross');
  const registry = new AgentRegistry(home);
  const other = '99999999';
  registry.start({ name: 'ou-twin', sid: SID, kind: 'author', task: 'mine', at: minute(0) });
  registry.start({ name: 'ou-twin', sid: other, kind: 'author', task: 'theirs', at: minute(1) });
  registry.finish('ou-twin', { sid: SID, result: { commit: 'abc1234' }, at: minute(2) });
  // no --sid: the caller's own session (prefer) has no open run, so the other session's is not its to end
  assert.throws(
    () =>
      registry.finish('ou-twin', {
        prefer: SID,
        result: { commit: 'def5678', card: 'bl_x' },
        at: minute(3),
      }),
    /already finished/,
  );
  const theirs = registry.agents().find((one) => one.sid === other);
  assert.equal(theirs?.state, 'running');
  assert.equal(theirs?.result?.commit, undefined);
  // with the caller's own run open too, a finish with no --sid ends that one and leaves the other
  registry.start({ name: 'ou-twin', sid: SID, kind: 'author', task: 'again', at: minute(4) });
  registry.finish('ou-twin', { prefer: SID, at: minute(5) });
  assert.equal(registry.agents().find((one) => one.sid === other)?.state, 'running');
  assert.equal(registry.agents().find((one) => one.sid === SID)?.state, 'done');
});

test('a finish with no --sid from a session with no run of the name, when two sessions have one, is refused rather than picking', () => {
  const home = tmp('reg-finish-ambiguous');
  const registry = new AgentRegistry(home);
  registry.start({ name: 'ou-twin', sid: SID, kind: 'author', task: 'a', at: minute(0) });
  registry.start({ name: 'ou-twin', sid: '99999999', kind: 'author', task: 'b', at: minute(1) });
  assert.throws(
    () => registry.finish('ou-twin', { prefer: '77777777', at: minute(2) }),
    /more than one session.*--sid/,
  );
  assert.equal(registry.agents().filter(runIsOpen).length, 2);
});

test('a finish with no --sid from a session of its own, when one other session has only a finished run of the name, ends the one open run', () => {
  const home = tmp('reg-finish-subagent');
  const registry = new AgentRegistry(home);
  registry.start({
    name: 'review-x',
    sid: 'aaaaaaaa',
    kind: 'critic',
    task: 'old',
    at: minute(0),
  });
  registry.finish('review-x', { sid: 'aaaaaaaa', at: minute(1) });
  registry.start({
    name: 'review-x',
    sid: 'bbbbbbbb',
    kind: 'critic',
    task: 'live',
    at: minute(2),
  });
  // a subagent whose session differs from its launcher's, and a caller with no session at all
  const done = registry.finish('review-x', { prefer: 'cccccccc', at: minute(3) });
  assert.equal(done.sid, 'bbbbbbbb');
  registry.start({
    name: 'review-x',
    sid: 'bbbbbbbb',
    kind: 'critic',
    task: 'again',
    at: minute(4),
  });
  assert.equal(registry.finish('review-x', { at: minute(5) }).sid, 'bbbbbbbb');
  // an open run gone stale in another session is not a live one either
  registry.start({
    name: 'review-y',
    sid: 'aaaaaaaa',
    kind: 'critic',
    task: 'dead',
    at: minute(0),
  });
  registry.start({
    name: 'review-y',
    sid: 'bbbbbbbb',
    kind: 'critic',
    task: 'live',
    at: new Date(minute(0).getTime() + 30 * 3600 * 1000),
  });
  const later = new Date(minute(0).getTime() + 31 * 3600 * 1000);
  assert.equal(registry.finish('review-y', { at: later }).sid, 'bbbbbbbb');
});

test("a finish with no --sid never ends another session's run when the caller's own run is stale", () => {
  const home = tmp('reg-finish-stale-own');
  const registry = new AgentRegistry(home);
  registry.start({ name: 'ou-twin', sid: SID, kind: 'author', task: 'mine', at: minute(0) });
  const fresh = new Date(minute(0).getTime() + 30 * 3600 * 1000);
  registry.start({ name: 'ou-twin', sid: '99999999', kind: 'author', task: 'theirs', at: fresh });
  const later = new Date(fresh.getTime() + 60000);
  // the caller's run is over 24h quiet; it is still the caller's run to end, not the other session's
  const done = registry.finish('ou-twin', {
    prefer: SID,
    result: { commit: 'abc1234' },
    at: later,
  });
  assert.equal(done.sid, SID);
  const theirs = registry.agents().find((one) => one.sid === '99999999');
  assert.equal(theirs?.state, 'running');
  assert.equal(theirs?.result?.commit, undefined);
});

test('author and critic are the kinds; builder and reviewer are accepted as aliases and stored as the new names', async () => {
  const home = tmp('reg-alias');
  const registry = new AgentRegistry(home);
  const env = { CLAUDE_CODE_SESSION_ID: `${SID}-0000-4000-8000-000000000000` };
  const start = async (name: string, kind: string) =>
    runCli(home, ['agent', 'start', name, '--kind', kind, '--task', 'x'], env);
  for (const [name, kind] of [
    ['ou-a', 'author'],
    ['ou-b', 'builder'],
    ['rv-a', 'critic'],
    ['rv-b', 'reviewer'],
  ]) {
    const done = await start(name, kind);
    assert.equal(done.code, 0, done.stderr);
  }
  const listed = JSON.parse((await runCli(home, ['agent', 'list', '--all', '--json'], env)).stdout);
  assert.deepEqual(
    listed.map((one: { name: string; kind: string }) => [one.name, one.kind]),
    [
      ['ou-a', 'author'],
      ['ou-b', 'author'],
      ['rv-a', 'critic'],
      ['rv-b', 'critic'],
    ],
  );
  const stored = readFileSync(path.join(home, 'agents.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).kind);
  assert.deepEqual(stored, ['author', 'author', 'critic', 'critic']);
  const bad = await start('ou-c', 'wizard');
  assert.notEqual(bad.code, 0);
  assert.match(
    bad.stderr,
    /author, critic, helper, research, editor \(builder and reviewer still work\)/,
  );
  // an author holds a build slot-style gate, a critic running is at the review gate, whichever name it came by
  assert.equal(registry.agents().filter((one) => one.kind === 'author').length, 2);
});

test('old agents.jsonl lines with kind builder or reviewer read as author and critic; the file is not rewritten', () => {
  const home = tmp('reg-old-lines');
  const file = path.join(home, 'agents.jsonl');
  const line = (name: string, kind: string) =>
    JSON.stringify({
      op: 'start',
      id: `${SID}:${name}`,
      sid8: SID,
      name,
      at: minute(0).toISOString(),
      run: `r_${name}`,
      kind,
      task: 'old',
    });
  const before =
    [line('old-a', 'builder'), line('old-r', 'reviewer'), line('old-w', 'wizard')].join('\n') +
    '\n';
  writeFileSync(file, before);
  const registry = new AgentRegistry(home);
  assert.deepEqual(
    registry.agents().map((one) => [one.name, one.kind]),
    [
      ['old-a', 'author'],
      ['old-r', 'critic'],
      ['old-w', null],
    ],
  );
  const [, critic] = registry.agents();
  assert.deepEqual(gateOf(critic), { kind: 'review', findings: null });
  assert.equal(readFileSync(file, 'utf8'), before);
  // finishing an old author with nothing made is still a miss in Waiting, as an author is
  registry.finish('old-a', { outcome: 'nothing', at: minute(5) });
  assert.equal(finishedColumn(registry.agents().find((one) => one.name === 'old-a')!), 'waiting');
});

test('the CLI: a 1,000-character task and outcome go in through a file or stdin, and a 5,000-character one is refused by name, not killed', async () => {
  // an outside watchdog SIGKILLs node (137) when one argument passes about 1,000 bytes, so long text never rides in argv
  const home = tmp('reg-cli-long');
  const env = { CLAUDE_CODE_SESSION_ID: `${SID}-0000-4000-8000-000000000000` };
  const long = (mark: string, size: number) =>
    `${mark} ${'word '.repeat(size / 4)}`.slice(0, size).trim();
  const taskFile = path.join(tmp('reg-cli-long-files'), 'task.md');
  writeFileSync(taskFile, long('task', 1000) + '\n');
  const started = await runCli(
    home,
    ['agent', 'start', 'long-one', '--kind', 'helper', '--task-file', taskFile],
    env,
  );
  assert.equal(started.code, 0, started.stderr);
  // 5,000 characters on stdin reaches the registry's own 1,000-character cap
  const tooLong = await runCli(
    home,
    ['agent', 'state', 'long-one', '--state', 'running', '--outcome', '-'],
    env,
    undefined,
    long('big', 5000),
  );
  assert.equal(tooLong.code, 1);
  assert.match(tooLong.stderr, /the outcome is longer than 1000 characters/);

  const waiting = await runCli(
    home,
    ['agent', 'state', 'long-one', '--state', 'waiting', '--outcome', '-'],
    env,
    undefined,
    long('waiting', 1000),
  );
  assert.equal(waiting.code, 0, waiting.stderr);
  const outcomeFile = path.join(tmp('reg-cli-long-outcome'), 'outcome.md');
  writeFileSync(outcomeFile, long('done', 1000));
  const finished = await runCli(
    home,
    ['agent', 'finish', 'long-one', '--state', 'done', '--outcome-file', outcomeFile],
    env,
  );
  assert.equal(finished.code, 0, finished.stderr);
  const events = readFileSync(path.join(home, 'agents.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const field = (kind: string, key: string) => events.find((one) => one.op === kind)?.[key];
  assert.equal(field('start', 'task'), long('task', 1000));
  assert.equal(field('state', 'outcome'), long('waiting', 1000));
  assert.equal(field('finish', 'outcome'), long('done', 1000));
});
