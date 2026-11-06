import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { claimAt, registerRuns, runCli, tmp, writeJson, type AgentRun } from './helpers.ts';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { claimWorktreeProblems } from '@once-upon-a-diff/state/queues/backlog/claim-worktree';
import { Board, noPrWatcher } from '@once-upon-a-diff/board/board';
import { BacklogStore, backlogCards } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { CLAIM_GRACE_HOURS } from '@once-upon-a-diff/state/queues/backlog/claims';
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
const agentsOf = (...runs: AgentRun[]) => registerRuns(tmp('claim-agents'), ...runs).agents();

function world(...runs: AgentRun[]) {
  const home = tmp('claim-home');
  registerRuns(home, ...runs);
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('claim-sessions') });
  const cards = async (now = NOW): Promise<BoardCard[]> =>
    (
      await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
        source: registrySource,
        now: () => now,
      }).snapshot()
    ).lanes.flatMap((lane) => lane.cards);
  return { home, cards, store: new BacklogStore(home) };
}

test('a claim event folds: the latest wins, reopen clears it, a dropped item cannot be claimed', () => {
  const store = new BacklogStore(tmp('claim-fold'));
  const item = store.add({ title: 'A thing', repo: 'acme/widgets' });
  assert.equal(item.claim, null);
  const first = store.claim(item.id, { agent: 'ou-one', sid: '54736864', by: 'main' });
  assert.equal(first.claim?.agent, 'ou-one');
  assert.equal(first.claim?.sid, '54736864');
  assert.equal(first.state, 'open', 'a claim alone does not start it');
  assert.equal(store.claim(item.id, { agent: 'ou-two' }).claim?.agent, 'ou-two');
  // one agent may hold several cards
  const other = store.add({ title: 'Another', repo: 'acme/widgets' });
  assert.equal(store.claim(other.id, { agent: 'ou-two' }).claim?.agent, 'ou-two');
  assert.throws(() => store.claim(item.id, { agent: 'two words' }), /not valid/);
  assert.throws(() => store.claim(item.id, { agent: '' }), /agent/);
  assert.throws(() => store.claim('bl_nothere1', { agent: 'ou-x' }), /no backlog item/);
  store.drop(item.id);
  assert.throws(() => store.claim(item.id, { agent: 'ou-x' }), /dropped/);
  assert.equal(store.reopen(item.id).claim, null);
  // an event line is append-only: the claim is its own op
  const lines = readFileSync(store.file, 'utf8').trim().split('\n');
  assert.ok(lines.some((line) => JSON.parse(line).op === 'claim'));
});

test('an edited card can be claimed, and a claimed card can be edited: both events fold', () => {
  const store = new BacklogStore(tmp('claim-edit'));
  const item = store.add({ title: 'First title', note: 'old note', repo: 'acme/widgets' });
  store.edit(item.id, { title: 'Better title', repo: 'acme/gadgets' });
  const claimed = store.claim(item.id, { agent: 'ou-editor', sid: '54736864' });
  assert.equal(claimed.title, 'Better title');
  assert.equal(claimed.repo, 'acme/gadgets');
  assert.equal(claimed.note, 'old note');
  assert.equal(claimed.claim?.agent, 'ou-editor');
  // edit after the claim keeps the claim
  const again = store.edit(item.id, { note: 'new note' });
  assert.equal(again.note, 'new note');
  assert.equal(again.claim?.agent, 'ou-editor');
  assert.equal(again.title, 'Better title');
  // a drop and a reopen clear the claim and go back to the edited repo
  store.drop(item.id);
  const back = store.reopen(item.id);
  assert.equal(back.claim, null);
  assert.equal(back.repo, 'acme/gadgets');
});

test('startedLinks finds its agent only through the run’s card: not by the claim, `by`, a folder name or the task text', () => {
  const store = new BacklogStore(tmp('claim-links'));
  const made = store.add({ title: 'T', repo: 'acme/widgets' });
  store.start(made.id, { branch: 'kill-inbox', by: 'ou-kill-inbox' });
  store.claim(made.id, { agent: 'ou-kill-inbox' });
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
  // the claim finds no run (ADR-25, the flip)
  assert.equal(startedLinks(store.items()[0], facts(agentsOf(...named)))?.agent, null);
  const carded = [{ ...named[0], card: made.id }, named[1]];
  assert.equal(
    startedLinks(store.items()[0], facts(agentsOf(...carded)))?.agent?.name,
    'ou-kill-inbox',
  );
});

test('a claimed card is ONE Working card with its agent, and the agent has no card of its own', async () => {
  const { store, cards, home } = world();
  const item = store.add({ title: 'Research the thing', repo: 'acme/widgets' });
  store.claim(item.id, { agent: 'ou-scout' });
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
  assert.equal(mine[0].backlog?.claim?.agent, 'ou-scout');
  assert.equal(mine[0].backlog?.claim?.pending, false);
  assert.equal(mine[0].backlog?.agent?.links.agent?.beat?.step, 'plan');
  assert.equal(mine[0].backlog?.assign, null, 'a claimed card is not offered to Assign');
});

test('an unclaimed agent with `card bl_x` in its task, its `by` name or its folder name does NOT link', async () => {
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
  assert.equal(card?.backlog?.claim, null);
  assert.equal(
    all.filter((one) => one.kind === 'agent').length,
    3,
    'each agent keeps its own card',
  );
  const started = all.find((one) => one.backlog?.id === item.id);
  assert.equal(started?.backlog?.started?.links?.agent, null);
});

test('a claim whose agent is not registered yet is Working, pending, for CLAIM_GRACE_HOURS', async () => {
  const { store, cards } = world();
  const item = store.add({ title: 'Waiting for its agent', repo: 'acme/widgets' });
  store.claim(item.id, { agent: 'ou-late' });
  const real = new Date();
  const pending = (await cards(real)).find((one) => one.backlog?.id === item.id);
  assert.equal(pending?.column, 'working');
  assert.equal(pending?.backlog?.claim?.pending, true);
  const later = new Date(real.getTime() + (CLAIM_GRACE_HOURS + 1) * 3600 * 1000);
  const back = (await cards(later)).find((one) => one.backlog?.id === item.id);
  assert.equal(back?.column, 'backlog');
  assert.equal(back?.backlog?.claim, null);
});

test('a claimed agent that fails sends its card back to Backlog, tried', async () => {
  const { store, cards, home } = world();
  const item = store.add({ title: 'Try it', repo: 'acme/widgets' });
  claimAt(store, item.id, 'ou-scout', '2026-10-26T18:35:00Z');
  registerRuns(home, {
    ...RUNNING('ou-scout'),
    card: item.id,
    now: { state: 'failed', at: '2026-10-26T18:45:00Z', outcome: 'gave up' },
  });
  const back = (await cards()).find((one) => one.backlog?.id === item.id);
  assert.equal(back?.column, 'backlog');
  assert.equal(back?.backlog?.agent?.tried, true);
  assert.equal((await cards()).filter((one) => one.kind === 'agent').length, 0);
});

test('a claimed agent on a card whose branch has a work card rides on that card, with the agent in it', () => {
  const store = new BacklogStore(tmp('claim-rides'));
  const item = store.add({ title: 'Build it', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'build-it' });
  store.claim(item.id, { agent: 'ou-build' });
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
    [],
    new Map(),
    new Map([[item.id, [view]]]),
  );
  assert.deepEqual(shown, []);
  assert.deepEqual(workCard.agents, [view]);
  assert.equal(workCard.from_backlog?.[0].id, item.id);
});

test('`backlog claim` writes the claim, and --branch also starts the card', async () => {
  const home = tmp('claim-cli');
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Claim me', repo: 'acme/widgets' });
  const run = (...args: string[]) => runCli(home, ['backlog', ...args]);
  assert.equal((await run('claim', item.id, '--agent', 'ou-claimer', '--sid', '54736864')).code, 0);
  assert.equal(store.items()[0].claim?.agent, 'ou-claimer');
  assert.equal(store.items()[0].claim?.sid, '54736864');
  assert.equal(store.items()[0].state, 'open');
  assert.equal(
    (await run('claim', item.id, '--agent', 'ou-claimer', '--branch', 'claim-me')).code,
    0,
  );
  assert.equal(store.items()[0].state, 'started');
  assert.equal(store.items()[0].branch, 'claim-me');
  assert.equal(store.items()[0].started_by, 'ou-claimer');
  const missing = await run('claim', item.id);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /agent/);
});

test('a finished card in a critic-hold repo is held in Agent checks until its critic has passed and no fix round is open, then Ready to ship (Larmor) or Ready for review (once-upon-a-diff)', async () => {
  for (const [repo, done] of [
    ['naveenvasou/larmor', 'ship'],
    ['shank-eric/once-upon-a-diff', 'ready'],
  ] as const) {
    const { home, cards, store } = world();
    const registry = new AgentRegistry(home);
    const stamp = (minutes: number) =>
      new Date(Date.parse('2026-11-03T15:00:00Z') + minutes * 60000);
    const item = store.add({ title: 'Build it', repo });
    store.start(item.id, { branch: 'build-it' });
    claimAt(store, item.id, 'ou-build', stamp(0).toISOString(), 'aaaaaaaa');
    const author = { name: 'ou-build', sid: 'aaaaaaaa', card: item.id } as const;
    const critic = { name: 'review-build-it', sid: 'aaaaaaaa', card: item.id } as const;
    const columnAt = async (minutes: number) =>
      (await cards(stamp(minutes))).find((one) => one.backlog?.id === item.id)?.column;

    registry.start({ ...author, kind: 'author', task: 'build it', at: stamp(0) });
    assert.equal(await columnAt(5), 'working');
    registry.finish('ou-build', { sid: 'aaaaaaaa', result: { branch: 'build-it' }, at: stamp(10) });
    assert.equal(await columnAt(11), 'checks', 'built, and no critic has said anything yet');

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

test('a critic that passed with no findings leaves a finished Larmor card in Ready to ship, and once-upon-a-diff and other repos wait for your review', async () => {
  const { home, cards, store } = world();
  const registry = new AgentRegistry(home);
  const stamp = (minutes: number) => new Date(Date.parse('2026-11-03T15:00:00Z') + minutes * 60000);
  const columns: Record<string, string | undefined> = {};
  for (const repo of ['naveenvasou/larmor', 'shank-eric/once-upon-a-diff', 'acme/widgets']) {
    const name = `ou-${repo.split('/')[1]}`;
    const item = store.add({ title: `Work in ${repo}`, repo });
    store.start(item.id, { branch: 'feat-x' });
    claimAt(store, item.id, name, stamp(0).toISOString(), 'bbbbbbbb');
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

test('a claimed author at a plan stop is in Agent checks with a plan check label, one asking is in Waiting, and one fixing stays in Working', async () => {
  const { home, cards, store } = world();
  const registry = new AgentRegistry(home);
  const repo = 'naveenvasou/larmor';
  const stamp = (minutes: number) => new Date(Date.parse('2026-11-05T15:00:00Z') + minutes * 60000);
  const item = store.add({ title: 'Plan it', repo });
  store.start(item.id, { branch: 'plan-it' });
  claimAt(store, item.id, 'ou-plan', stamp(0).toISOString(), 'cccccccc');
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
  // (unchanged by the plan column: a claimed run's fix round shows its fixing chip on the card in Working)
  assert.equal(fixing?.column, 'working');
  assert.deepEqual(
    fixing?.agents.map((agent) => agent.gate),
    [{ kind: 'fixing', findings: 2 }],
  );
});

const EDITOR_SESSION = 'abcdef01-1111-4222-8333-444444444444';

test('a claim records the editor’s full session, and an old claim with none folds with a null one', async () => {
  const home = tmp('claim-session');
  const store = new BacklogStore(home);
  const old = store.add({ title: 'Old style', repo: 'acme/widgets' });
  store.claim(old.id, { agent: 'ou-old' });
  assert.equal(store.items()[0].claim?.session ?? null, null);
  assert.equal(store.items()[0].claim?.worktree ?? null, null);
  const item = store.add({ title: 'Edited', repo: 'acme/widgets' });
  const claimed = await runCli(
    home,
    ['backlog', 'claim', item.id, '--agent', 'ou-new', '--sid', 'abcdef01'],
    { CLAUDE_CODE_SESSION_ID: EDITOR_SESSION },
  );
  assert.equal(claimed.code, 0, claimed.stderr);
  const claim = store.items().find((one) => one.id === item.id)?.claim;
  assert.equal(claim?.session, EDITOR_SESSION);
  assert.equal(claim?.sid, 'abcdef01');
  assert.equal(claim?.agent, 'ou-new');
});

test('claim --worktree must be a worktree on the claimed branch of the card’s repo; without it nothing is checked', async () => {
  const home = tmp('claim-worktree');
  const store = new BacklogStore(home);
  const { main, add } = worktreeFixture();
  const tree = add('feat-x');
  add('other-branch');
  const item = store.add({ title: 'Wt card', repo: 'acme/widgets' });
  const claim = (...args: string[]) =>
    runCli(home, ['backlog', 'claim', item.id, '--agent', 'ou-wt', ...args], {
      CLAUDE_CODE_SESSION_ID: EDITOR_SESSION,
    });
  const notATree = await claim('--branch', 'feat-x', '--worktree', tmp('not-a-worktree'));
  assert.notEqual(notATree.code, 0);
  assert.match(notATree.stderr, /worktree/);
  // a folder inside a worktree is not a worktree
  const inside = await claim('--branch', 'feat-x', '--worktree', path.join(tree, 'sub'));
  assert.notEqual(inside.code, 0);
  const wrongBranch = await claim('--branch', 'feat-y', '--worktree', tree);
  assert.notEqual(wrongBranch.code, 0);
  assert.match(wrongBranch.stderr, /feat-x/);
  assert.equal(store.items()[0].claim, null, 'a refused claim writes nothing');
  const ok = await claim('--branch', 'feat-x', '--worktree', tree);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(store.items()[0].claim?.worktree, tree);
  // the main checkout is a worktree too, but of another repo's card it is refused
  const other = store.add({ title: 'Other repo', repo: 'acme/gadgets' });
  const wrongRepo = await runCli(
    home,
    ['backlog', 'claim', other.id, '--agent', 'ou-wt2', '--worktree', main],
    { CLAUDE_CODE_SESSION_ID: EDITOR_SESSION },
  );
  assert.notEqual(wrongRepo.code, 0);
  assert.match(wrongRepo.stderr, /acme\/gadgets/);
  // no --worktree: nothing to check
  const bare = await runCli(home, ['backlog', 'claim', other.id, '--agent', 'ou-wt2']);
  assert.equal(bare.code, 0, bare.stderr);
});

test('doctor lists a live claim whose worktree git no longer knows, and none for one that is there', () => {
  const store = new BacklogStore(tmp('claim-doctor'));
  const { add } = worktreeFixture();
  const tree = add('feat-x');
  const here = store.add({ title: 'There', repo: 'acme/widgets' });
  const gone = store.add({ title: 'Gone', repo: 'acme/widgets' });
  store.claim(here.id, { agent: 'ou-a', worktree: tree });
  store.claim(gone.id, { agent: 'ou-b', worktree: path.join(tree, '..', 'removed') });
  const problems = claimWorktreeProblems(store.items());
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(gone.id));
});
