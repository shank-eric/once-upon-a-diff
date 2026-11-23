import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { claimAt, registerRuns, runCli, tmp, writeJson, type AgentRun } from './helpers.ts';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { openRunWorktreeProblems } from '@once-upon-a-diff/state/queues/backlog/worktree-check';
import { Board, noPrWatcher } from '@once-upon-a-diff/board/board';
import { BacklogStore, backlogCards } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { startedLinks } from '@once-upon-a-diff/state/queues/backlog/backlog-links';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';

const NOW = new Date('2026-10-26T19:00:00Z');
/** An author's run that started at 2:30 PM ET on 10/26 and is still going. */
const RUNNING = (name: string, task = 'do a thing', sid = '54736864'): AgentRun => ({
  sid,
  name,
  kind: 'author',
  task,
  started: '2026-10-26T18:30:00Z',
});

/** The agents the runs register, as the board reads them. */
const agentsOf = (...runs: AgentRun[]) => registerRuns(tmp('owner-agents'), ...runs).agents();

function world(...runs: AgentRun[]) {
  const home = tmp('owner-home');
  registerRuns(home, ...runs);
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: tmp('owner-sessions'),
    repos: { larmor: { skips_review: true } },
  });
  const cards = async (now = NOW): Promise<BoardCard[]> =>
    (
      await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
        source: registrySource,
        now: () => now,
      }).snapshot()
    ).lanes.flatMap((lane) => lane.cards);
  return { home, cards, store: new BacklogStore(home) };
}

/*
 * ADR-29: a card's runs say who works it, so there is no claim. Old `claim` rows are still in backlog.jsonl and still fold: they
 * give a card its worktree until a `link` says another, and end someday. Nothing else reads them.
 */

test('an old claim row folds: it starts nothing, takes no owner, and a dropped card ignores it', () => {
  const store = new BacklogStore(tmp('owner-fold'));
  const item = store.add({ title: 'A thing', repo: 'acme/widgets' });
  claimAt(store, item.id, 'ou-one', '2026-10-26T18:35:00Z', '54736864');
  const [shown] = store.items();
  assert.equal(shown.state, 'open', 'a claim row alone does not start it');
  assert.equal('claim' in shown, false, 'a card has no claim');
  store.drop(item.id);
  claimAt(store, item.id, 'ou-two', '2026-10-26T18:40:00Z');
  assert.equal(store.items()[0].state, 'dropped');
  assert.equal(store.reopen(item.id).state, 'open');
  assert.equal('claim' in store, false, 'the store has no claim method');
});

test('an old claim row gives the card its worktree until a link says another, and ends someday', () => {
  const store = new BacklogStore(tmp('owner-worktree'));
  const item = store.add({ title: 'Wt card', repo: 'acme/widgets' });
  store.someday(item.id, true);
  claimAt(store, item.id, 'ou-wt', '2026-10-26T18:35:00Z', undefined, '/work/old-claim');
  assert.equal(store.items()[0].worktree, '/work/old-claim');
  assert.equal(store.items()[0].someday, false, 'a claim row ends someday');
  const linked = store.link(item.id, { worktree: '/work/linked' });
  assert.equal(linked.worktree, '/work/linked');
  claimAt(store, item.id, 'ou-wt', '2026-10-26T18:50:00Z', undefined, '/work/later-claim');
  assert.equal(store.items()[0].worktree, '/work/linked', 'a later old row never replaces a link');
});

test('an edited card folds an old claim row: the edit and the claim both stand', () => {
  const store = new BacklogStore(tmp('owner-edit'));
  const item = store.add({ title: 'First title', note: 'old note', repo: 'acme/widgets' });
  store.edit(item.id, { title: 'Better title', repo: 'acme/gadgets' });
  claimAt(store, item.id, 'ou-editor', '2026-10-26T18:35:00Z', '54736864');
  const again = store.edit(item.id, { note: 'new note' });
  assert.equal(again.note, 'new note');
  assert.equal(again.title, 'Better title');
  store.drop(item.id);
  const back = store.reopen(item.id);
  assert.equal(back.repo, 'acme/gadgets');
});

test('startedLinks finds its agent only through the run’s card: not by an old claim row, `by`, a folder name or the task text', () => {
  const store = new BacklogStore(tmp('owner-links'));
  const made = store.add({ title: 'T', repo: 'acme/widgets' });
  store.start(made.id, { branch: 'kill-inbox', by: 'ou-kill-inbox' });
  claimAt(store, made.id, 'ou-kill-inbox', '2026-10-26T18:35:00Z');
  const named = [
    RUNNING('ou-kill-inbox', 'build in widgets-worktrees/kill-inbox'),
    RUNNING('kill-inbox'),
  ];
  const facts = (agents: ReturnType<typeof agentsOf>) => ({
    worktrees: new Map(),
    sessions: [],
    agents,
    merged: () => null,
  });
  // a claim row finds no run (ADR-25, the flip)
  assert.equal(startedLinks(store.items()[0], facts(agentsOf(...named)))?.agent, null);
  const carded = [{ ...named[0], card: made.id }, named[1]];
  assert.equal(
    startedLinks(store.items()[0], facts(agentsOf(...carded)))?.agent?.name,
    'ou-kill-inbox',
  );
});

test('a card a run names is ONE Working card with its agent, and the agent has no card of its own', async () => {
  const { store, cards, home } = world();
  const item = store.add({ title: 'Research the thing', repo: 'acme/widgets' });
  registerRuns(home, {
    ...RUNNING('ou-scout', 'research the thing'),
    card: item.id,
    beat: { n: 2, of: 6, step: 'plan', note: 'plan written', at: '2026-10-26T18:40:00Z' },
  });
  const all = await cards();
  assert.equal(all.filter((card) => card.kind === 'agent').length, 0, 'no duplicate agent card');
  const mine = all.filter((card) => card.backlog?.id === item.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].column, 'working');
  assert.deepEqual(
    mine[0].agents.map((agent) => agent.name),
    ['ou-scout'],
  );
  assert.equal('claim' in (mine[0].backlog ?? {}), false, 'the card has no claim');
  assert.equal(mine[0].backlog?.agent?.links.agent?.beat?.step, 'plan');
});

test('an agent with `card bl_x` in its task, its `by` name or its folder name does NOT link', async () => {
  const { store, cards, home } = world();
  const item = store.add({ title: 'Look into it', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'look-into', repo: 'acme/widgets', by: 'ou-look' });
  const open = store.add({ title: 'Open card', repo: 'acme/widgets' });
  registerRuns(
    home,
    { ...RUNNING('ou-text', `card ${open.id} research`), kind: 'helper' },
    { ...RUNNING('ou-look'), kind: 'helper' },
    { ...RUNNING('look-into'), kind: 'helper' },
  );
  const all = await cards();
  const card = all.find((one) => one.backlog?.id === open.id);
  assert.equal(card?.column, 'backlog');
  assert.equal(card?.backlog?.agent, null);
  assert.equal(
    all.filter((one) => one.kind === 'agent').length,
    3,
    'each agent keeps its own card',
  );
  const started = all.find((one) => one.backlog?.id === item.id);
  assert.equal(started?.backlog?.started?.links?.agent, null);
});

test('an old claim row with no run naming the card is Backlog, never Working, however fresh it is', async () => {
  const { store, cards } = world();
  const item = store.add({ title: 'Waiting for its agent', repo: 'acme/widgets' });
  const started = store.add({ title: 'Started with a claim', repo: 'acme/widgets' });
  store.start(started.id, { branch: 'claimed-started', repo: 'acme/widgets' });
  const real = new Date();
  claimAt(store, item.id, 'ou-late', real.toISOString());
  claimAt(store, started.id, 'ou-slow', real.toISOString());
  const all = await cards(real);
  assert.equal(all.find((one) => one.backlog?.id === item.id)?.column, 'backlog');
  const slow = all.find((one) => one.backlog?.id === started.id);
  assert.equal(slow?.column, 'backlog', 'started, no session yet');
  assert.equal(slow?.agents.length, 0);
});

test('an agent that fails puts its card in Error', async () => {
  const { store, cards, home } = world();
  const item = store.add({ title: 'Try it', repo: 'acme/widgets' });
  registerRuns(home, {
    ...RUNNING('ou-scout'),
    card: item.id,
    now: { state: 'failed', at: '2026-10-26T18:45:00Z', outcome: 'gave up' },
  });
  const back = (await cards()).find((one) => one.backlog?.id === item.id);
  assert.equal(back?.column, 'error');
  assert.equal(back?.backlog?.agent?.tried, false);
  assert.equal((await cards()).filter((one) => one.kind === 'agent').length, 0);
});

test('an agent on a card whose branch has a work card rides on that card, with the agent in it', () => {
  const store = new BacklogStore(tmp('owner-rides'));
  const item = store.add({ title: 'Build it', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'build-it' });
  const agent = agentsOf({ ...RUNNING('ou-build'), card: item.id })[0];
  const view = { name: 'ou-build', state: 'running' } as BoardCard['agents'][number];
  const workCard = {
    id: 'work:1',
    kind: 'work',
    repo: 'acme/widgets',
    branch: 'build-it',
    pr: null,
    story: null,
    agents: [],
    sessions: [],
    title: 'x',
  } as unknown as BoardCard;
  assert.ok(agent);
  const shown = backlogCards(
    store.items(),
    [workCard],
    NOW.getTime(),
    new Map(),
    new Map([[item.id, [view]]]),
  );
  assert.deepEqual(shown, []);
  assert.deepEqual(workCard.agents, [view]);
  assert.equal(workCard.from_backlog?.[0].id, item.id);
});

test('`backlog claim` is retired: it prints a note and writes no row, and --branch still starts the card', async () => {
  const home = tmp('owner-cli');
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Claim me', repo: 'acme/widgets' });
  const run = (...args: string[]) => runCli(home, ['backlog', ...args]);
  const before = readFileSync(store.file, 'utf8');
  const bare = await run('claim', item.id, '--agent', 'ou-claimer', '--sid', '54736864');
  assert.equal(bare.code, 0, bare.stderr);
  assert.match(bare.stdout, /claim is retired/);
  assert.equal(readFileSync(store.file, 'utf8'), before, 'no row is written');
  assert.equal(store.items()[0].state, 'open');
  const started = await run('claim', item.id, '--agent', 'ou-claimer', '--branch', 'claim-me');
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stdout, /claim is retired/);
  assert.equal(store.items()[0].state, 'started');
  assert.equal(store.items()[0].branch, 'claim-me');
  assert.equal(store.items()[0].started_by, 'ou-claimer');
  assert.equal(readFileSync(store.file, 'utf8').includes('"op":"claim"'), false);
  // no --agent is needed now
  assert.equal((await run('claim', item.id)).code, 0);
  // `start` no longer tells whoever starts a card to claim it first
  const other = store.add({ title: 'Start me', repo: 'acme/widgets' });
  const plain = await run('start', other.id, '--branch', 'start-me');
  assert.doesNotMatch(plain.stdout, /claim/i);
});

test('a finished card in any repo waits in Waiting until its critic has passed, holds in Agent checks while a critic runs or fixes are due, then is Ready to ship (Larmor, skips_review) or Ready for review (others)', async () => {
  for (const [repo, done] of [
    ['naveenvasou/larmor', 'ship'],
    ['shank-eric/once-upon-a-diff', 'ready'],
    ['acme/widgets', 'ready'],
  ] as const) {
    const { home, cards, store } = world();
    const registry = new AgentRegistry(home);
    const stamp = (minutes: number) =>
      new Date(Date.parse('2026-11-03T15:00:00Z') + minutes * 60000);
    const item = store.add({ title: 'Build it', repo });
    store.start(item.id, { branch: 'build-it' });
    const author = { name: 'ou-build', sid: 'aaaaaaaa', card: item.id } as const;
    const critic = { name: 'review-build-it', sid: 'aaaaaaaa', card: item.id } as const;
    const columnAt = async (minutes: number) =>
      (await cards(stamp(minutes))).find((one) => one.backlog?.id === item.id)?.column;

    registry.start({ ...author, kind: 'author', task: 'build it', at: stamp(0) });
    assert.equal(await columnAt(5), 'working');
    registry.finish('ou-build', { sid: 'aaaaaaaa', result: { branch: 'build-it' }, at: stamp(10) });
    assert.equal(await columnAt(11), 'waiting', 'built, and no critic has said anything yet');

    registry.start({ ...critic, kind: 'critic', task: 'review it', at: stamp(11) });
    assert.equal(await columnAt(12), 'checks', 'the critic is running');

    registry.finish('review-build-it', { sid: 'aaaaaaaa', findings: 2, at: stamp(15) });
    assert.equal(
      await columnAt(16),
      'checks',
      'the critic found things and no fix round has finished',
    );

    registry.start({ ...author, kind: 'author', task: 'fix the findings', at: stamp(17) });
    assert.equal(await columnAt(18), 'working', 'the fix round is running');
    registry.state('ou-build', { sid: 'aaaaaaaa', state: 'fixing', findings: 2, at: stamp(19) });
    assert.equal(
      await columnAt(20),
      'working',
      'the author is fixing: a run that names the card, so Working (cardPhase row 1)',
    );

    registry.finish('ou-build', { sid: 'aaaaaaaa', result: { branch: 'build-it' }, at: stamp(25) });
    assert.equal(await columnAt(26), done, 'the author finished after the critic');
  }
});

test('a critic that passed with no findings leaves a finished card in Ready to ship where the repo settings skip review (Larmor), and in Ready for your review elsewhere', async () => {
  const { home, cards, store } = world();
  const registry = new AgentRegistry(home);
  const stamp = (minutes: number) => new Date(Date.parse('2026-11-03T15:00:00Z') + minutes * 60000);
  const columns: Record<string, string | undefined> = {};
  for (const repo of ['naveenvasou/larmor', 'shank-eric/once-upon-a-diff', 'acme/widgets']) {
    const name = `ou-${repo.split('/')[1]}`;
    const item = store.add({ title: `Work in ${repo}`, repo });
    store.start(item.id, { branch: 'feat-x' });
    registry.start({
      name,
      sid: 'bbbbbbbb',
      kind: 'author',
      task: 't',
      card: item.id,
      at: stamp(0),
    });
    registry.finish(name, { sid: 'bbbbbbbb', result: { branch: 'feat-x' }, at: stamp(10) });
    registry.start({
      name: `review-${name}`,
      sid: 'bbbbbbbb',
      kind: 'critic',
      task: 'r',
      card: item.id,
      at: stamp(11),
    });
    registry.finish(`review-${name}`, { sid: 'bbbbbbbb', findings: 0, at: stamp(15) });
    columns[repo] = (await cards(stamp(16))).find((one) => one.backlog?.id === item.id)?.column;
  }
  assert.deepEqual(columns, {
    'naveenvasou/larmor': 'ship',
    'shank-eric/once-upon-a-diff': 'ready',
    'acme/widgets': 'ready',
  });
});

test('an author at a plan stop is in Agent checks with a plan check label, one asking is in Waiting, and one fixing stays in Working', async () => {
  const { home, cards, store } = world();
  const registry = new AgentRegistry(home);
  const repo = 'naveenvasou/larmor';
  const stamp = (minutes: number) => new Date(Date.parse('2026-11-05T15:00:00Z') + minutes * 60000);
  const item = store.add({ title: 'Plan it', repo });
  store.start(item.id, { branch: 'plan-it' });
  registry.start({
    name: 'ou-plan',
    sid: 'cccccccc',
    card: item.id,
    kind: 'author',
    task: 'plan it',
    at: stamp(0),
  });
  const cardAt = async (minutes: number) =>
    (await cards(stamp(minutes))).find((one) => one.backlog?.id === item.id);
  assert.equal((await cardAt(5))?.column, 'working');

  registry.state('ou-plan', {
    sid: 'cccccccc',
    state: 'plan',
    outcome: 'plan ready',
    at: stamp(10),
  });
  const planned = await cardAt(11);
  assert.equal(planned?.column, 'checks', 'a plan stop waits on the editor, not on you');
  // the card's chip reads the agent's gate (gateText): `plan check`, not `agent review`
  assert.deepEqual(
    planned?.agents.map((agent) => agent.gate),
    [{ kind: 'plan', findings: null }],
  );

  registry.state('ou-plan', {
    sid: 'cccccccc',
    state: 'waiting',
    outcome: 'needs you: which one',
    at: stamp(15),
  });
  assert.equal((await cardAt(16))?.column, 'waiting', 'a question for you stays in Waiting');

  registry.state('ou-plan', { sid: 'cccccccc', state: 'fixing', findings: 2, at: stamp(20) });
  const fixing = await cardAt(21);
  // (unchanged by the plan column: a run's fix round shows its fixing chip on the card in Working)
  assert.equal(fixing?.column, 'working');
  assert.deepEqual(
    fixing?.agents.map((agent) => agent.gate),
    [{ kind: 'fixing', findings: 2 }],
  );
});

test('doctor lists a card whose open run has a linked worktree git no longer knows, and none for one that is there or whose run is over', () => {
  const home = tmp('owner-doctor');
  const store = new BacklogStore(home);
  const { add } = worktreeFixture();
  const tree = add('feat-x');
  const here = store.add({ title: 'There', repo: 'acme/widgets' });
  const gone = store.add({ title: 'Gone', repo: 'acme/widgets' });
  const done = store.add({ title: 'Done run', repo: 'acme/widgets' });
  store.link(here.id, { worktree: tree });
  store.link(gone.id, { worktree: path.join(tree, '..', 'removed') });
  store.link(done.id, { worktree: path.join(tree, '..', 'also-removed') });
  const registry = new AgentRegistry(home);
  for (const [name, card] of [
    ['ou-a', here.id],
    ['ou-b', gone.id],
    ['ou-c', done.id],
  ]) {
    registry.start({ name, sid: 'aaaaaaaa', kind: 'author', task: 't', card });
  }
  registry.finish('ou-c', { sid: 'aaaaaaaa' });
  const problems = openRunWorktreeProblems(store.items(), registry.agents());
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], new RegExp(`${gone.id}'s run ou-b`));
});
