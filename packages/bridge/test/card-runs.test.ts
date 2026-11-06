import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { claimAt, runCli, tmp, writeJson } from './helpers.ts';
import { Board, noPrWatcher } from '@once-upon-a-diff/board/board';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { BacklogStore, cardLookup } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { cardPhase, cardRunProblems, runsOf } from '@once-upon-a-diff/state/queues/backlog/phase';
import { claimViews } from '@once-upon-a-diff/board/stages/agents';
import { nestClaimedAgents } from '@once-upon-a-diff/board/stages/backlog';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';

// The 11/5 misses, as the rows the store held: one piece of work is one card, whatever its runs typed for repo, and a
// fix round is the card's run, not a card of its own. The old-form rows (a run's `card` in agents.jsonl) must read as the
// card's runs, so these fixtures are the proof that nothing needs rewriting.
const REPO = 'shank-eric/once-upon-a-diff';
const SID = 'eeea873a';
const START_MS = Date.parse('2026-11-06T00:38:00Z');
const stamp = (minutes: number) => new Date(START_MS + minutes * 60000);

function world() {
  const home = tmp('card-runs-home');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('card-runs-sessions') });
  const store = new BacklogStore(home);
  const registry = new AgentRegistry(home);
  const cards = async (now: Date): Promise<BoardCard[]> =>
    (
      await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
        source: registrySource,
        now: () => now,
      }).snapshot()
    ).lanes.flatMap((lane) => lane.cards);
  const card = (title: string, branch: string, agent: string) => {
    const item = store.add({ title, repo: REPO });
    store.start(item.id, { branch });
    claimAt(store, item.id, agent, stamp(0).toISOString(), SID);
    return item;
  };
  return { home, store, registry, cards, card };
}

/** What the board shows for the card: its cards, and every agent card in the whole board. */
async function shown(
  cards: (now: Date) => Promise<BoardCard[]>,
  id: string,
  now: Date,
): Promise<{ mine: BoardCard[]; agentCards: BoardCard[] }> {
  const all = await cards(now);
  return {
    mine: all.filter((card) => card.backlog?.id === id),
    agentCards: all.filter((card) => card.kind === 'agent'),
  };
}

test('A. a fix round is the card’s run: panel-css has one card, not a card and an agent card', async () => {
  const { registry, store, cards, card } = world();
  const item = card('panel.css split', 'panel-css', 'panel-css');
  const author = { name: 'panel-css', sid: SID, repo: REPO, branch: 'panel-css', card: item.id };
  registry.start({ ...author, kind: 'author', task: 'split the sheet', at: stamp(0) });
  registry.finish('panel-css', {
    sid: SID,
    result: { commit: '6989841', branch: 'panel-css', card: item.id },
    at: stamp(20),
  });
  // the critic's finish had findings null, with the count in its outcome (as in the store)
  registry.start({
    name: 'review-panel-css',
    sid: SID,
    repo: REPO,
    branch: 'panel-css',
    card: item.id,
    kind: 'critic',
    task: 'review',
    at: stamp(21),
  });
  registry.finish('review-panel-css', { sid: SID, outcome: '1 finding', at: stamp(25) });
  // the fix round: a second run of the same agent, on the same card
  registry.start({ ...author, kind: 'author', task: 'fix round', at: stamp(26) });
  registry.state('panel-css', { sid: SID, state: 'fixing', at: stamp(26) });
  const during = await shown(cards, item.id, stamp(28));
  assert.equal(during.mine.length, 1);
  assert.deepEqual(during.agentCards, [], 'the fix round has no card of its own while it runs');
  assert.notEqual(during.mine[0].column, 'ship');
  registry.finish('panel-css', {
    sid: SID,
    result: { commit: '12d6eb4', branch: 'panel-css', card: item.id },
    at: stamp(40),
  });
  const after = await shown(cards, item.id, stamp(41));
  assert.equal(after.mine.length, 1, 'one card');
  assert.deepEqual(after.agentCards, [], 'and no agent card beside it');
  assert.equal(after.mine[0].column, 'ship');
  assert.equal(store.items()[0].id, item.id);
});

test('B. a critic that typed the wrong repo is on its card, not a card of its own in another lane', async () => {
  const { registry, cards, card } = world();
  const item = card('Cut the CLI from the server', 'cli-no-server', 'ou-cli');
  registry.start({
    name: 'ou-cli',
    sid: SID,
    card: item.id,
    repo: REPO,
    branch: 'cli-no-server',
    kind: 'author',
    task: 'cut it',
    at: stamp(0),
  });
  registry.finish('ou-cli', { sid: SID, result: { branch: 'cli-no-server' }, at: stamp(10) });
  registry.start({
    name: 'review-cli',
    sid: SID,
    card: item.id,
    repo: 'esshank/once-upon-a-diff',
    kind: 'critic',
    task: 'review',
    at: stamp(11),
  });
  registry.finish('review-cli', { sid: SID, findings: 0, at: stamp(15) });
  const { mine, agentCards } = await shown(cards, item.id, stamp(16));
  assert.equal(mine.length, 1);
  assert.deepEqual(agentCards, []);
  assert.equal(mine[0].column, 'ship');
  assert.deepEqual(mine[0].agents.map((one) => one.name).sort(), ['ou-cli', 'review-cli']);
});

test('B2. `agent start` refuses a critic with no --card, which is how the wrong-repo critic got no card', async () => {
  const home = tmp('card-runs-cli-critic');
  const env = { CLAUDE_CODE_SESSION_ID: `${SID}-0000-4000-8000-000000000000` };
  const refused = await runCli(
    home,
    ['agent', 'start', 'review-x', '--kind', 'critic', '--task', 'review it', '--repo', 'a/b'],
    env,
  );
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /--card/);
  const role = await runCli(
    home,
    ['agent', 'start', 'fix-x', '--role', 'fixer', '--task', 'fix it'],
    env,
  );
  assert.notEqual(role.code, 0);
  const helper = await runCli(
    home,
    ['agent', 'start', 'look', '--kind', 'helper', '--task', 'x'],
    env,
  );
  assert.equal(helper.code, 0, helper.stderr);
});

test('C. a fix round after a critic passed, with no `fixing` state, is Working, not Ready to ship', async () => {
  const { registry, cards, card } = world();
  const item = card('Build it', 'build-it', 'ou-build');
  const author = { name: 'ou-build', sid: SID, card: item.id, repo: REPO, branch: 'build-it' };
  registry.start({ ...author, kind: 'author', task: 'build', at: stamp(0) });
  registry.finish('ou-build', { sid: SID, result: { branch: 'build-it' }, at: stamp(10) });
  registry.start({
    name: 'review-build',
    sid: SID,
    card: item.id,
    kind: 'critic',
    task: 'review',
    at: stamp(11),
  });
  registry.finish('review-build', { sid: SID, findings: 0, at: stamp(14) });
  assert.equal((await shown(cards, item.id, stamp(15))).mine[0].column, 'ship');
  // Eric's review comments: a new run of the author, running, never told `fixing`
  registry.start({ ...author, kind: 'author', task: 'fix the comments', at: stamp(16) });
  const { mine, agentCards } = await shown(cards, item.id, stamp(17));
  assert.equal(mine.length, 1);
  assert.deepEqual(agentCards, []);
  assert.equal(mine[0].column, 'working');
});

test('D. a carded critic’s `finish --state done` without --findings is refused, since a null reads as a pass', async () => {
  const home = tmp('card-runs-cli-finish');
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Review me', repo: REPO });
  store.start(item.id, { branch: 'review-me' });
  const env = { CLAUDE_CODE_SESSION_ID: `${SID}-0000-4000-8000-000000000000` };
  const started = await runCli(
    home,
    ['agent', 'start', 'review-me', '--kind', 'critic', '--card', item.id, '--task', 'review'],
    env,
  );
  assert.equal(started.code, 0, started.stderr);
  const bare = await runCli(home, ['agent', 'finish', 'review-me', '--state', 'done'], env);
  assert.notEqual(bare.code, 0);
  assert.match(bare.stderr, /--findings/);
  const zero = await runCli(
    home,
    ['agent', 'finish', 'review-me', '--state', 'done', '--findings', '0'],
    env,
  );
  assert.equal(zero.code, 0, zero.stderr);
});

test('E. a landed card shows its runs once, on itself, and a rerun on another card belongs to that card', async () => {
  const { registry, store, cards, card } = world();
  const first = card('First job', 'first-job', 'ou-build');
  const second = card('Second job', 'second-job', 'ou-build');
  registry.start({
    name: 'ou-build',
    sid: SID,
    card: first.id,
    kind: 'author',
    task: 'one',
    at: stamp(0),
  });
  registry.finish('ou-build', { sid: SID, result: { branch: 'first-job' }, at: stamp(10) });
  registry.start({
    name: 'ou-build',
    sid: SID,
    card: second.id,
    kind: 'author',
    task: 'two',
    at: stamp(11),
  });
  store.done(first.id, { sha: 'abc1234', by: 'deploy-local' });
  const all = await cards(stamp(12));
  assert.equal(all.filter((one) => one.kind === 'agent').length, 0, 'no agent card for either run');
  assert.equal(all.find((one) => one.backlog?.id === first.id)?.column, 'done');
  const other = all.find((one) => one.backlog?.id === second.id);
  assert.equal(other?.column, 'working');
  assert.deepEqual(
    other?.agents.map((one) => one.name),
    ['ou-build'],
  );
});

test('F. the card’s runs, not its claim, find its agents; critics and the author both show, and nest in a work card', () => {
  const { registry, store, card } = world();
  const item = card('Build it', 'build-it', 'ou-build');
  registry.start({
    name: 'ou-build',
    sid: SID,
    card: item.id,
    kind: 'author',
    task: 'b',
    at: stamp(0),
  });
  registry.start({
    name: 'review-b',
    sid: SID,
    card: item.id,
    kind: 'critic',
    task: 'r',
    at: stamp(1),
  });
  const agents = registry.agents();
  const views = claimViews(store.items(), agents, stamp(2).getTime());
  assert.deepEqual(
    views.get(item.id)?.map((one) => one.name),
    ['ou-build', 'review-b'],
  );
  const work = {
    id: 'work:1',
    kind: 'work',
    repo: REPO,
    branch: 'build-it',
    agents: [],
    sessions: [],
  } as unknown as BoardCard;
  nestClaimedAgents(store.items(), [work], views);
  assert.deepEqual(
    work.agents.map((one) => one.name),
    ['ou-build', 'review-b'],
  );
  assert.equal(runsOf(item, agents).length, 2);
});

test('G. cardPhase: every row of the table', () => {
  const home = tmp('card-runs-phase');
  const registry = new AgentRegistry(home);
  const store = new BacklogStore(home);
  const phase = (repo: string, build: (card: string) => void, nowMin = 100) => {
    const item = store.add({ title: 'x', repo });
    const started = store.start(item.id, { branch: 'x' });
    build(item.id);
    const agents = registry.agents();
    return cardPhase(started, runsOf(started, agents), stamp(nowMin).getTime());
  };
  let count = 0;
  const unique = () => `w${count++}`;
  const run = (card: string, name: string, kind: 'author' | 'critic', startMin: number) =>
    registry.start({ name, sid: SID, card, kind, task: 't', at: stamp(startMin) });
  const ONCE = 'acme/once-upon-a-diff';
  const OTHER = 'acme/widgets';
  // 1: a work run open
  assert.equal(phase(OTHER, (card) => run(card, unique(), 'author', 0))?.column, 'working');
  assert.equal(
    phase(OTHER, (card) => {
      const name = unique();
      run(card, name, 'author', 0);
      registry.state(name, { sid: SID, state: 'plan', at: stamp(1) });
    })?.column,
    'checks',
  );
  assert.equal(
    phase(OTHER, (card) => {
      const name = unique();
      run(card, name, 'author', 0);
      registry.state(name, { sid: SID, state: 'waiting', at: stamp(1) });
    })?.column,
    'waiting',
  );
  // 3: failed goes back to Backlog, tried
  const failed = phase(OTHER, (card) => {
    const name = unique();
    run(card, name, 'author', 0);
    registry.finish(name, { sid: SID, state: 'failed', at: stamp(5) });
  });
  assert.deepEqual([failed?.column, failed?.tried], ['backlog', true]);
  // 4: findings pending, in any repo, until the fix round (row 1) opens
  const findings = (repo: string) =>
    phase(repo, (card) => {
      const author = unique();
      run(card, author, 'author', 0);
      registry.finish(author, { sid: SID, result: { branch: 'x' }, at: stamp(5) });
      const critic = unique();
      run(card, critic, 'critic', 6);
      registry.finish(critic, { sid: SID, findings: 2, at: stamp(9) });
    });
  assert.equal(findings(ONCE)?.column, 'checks');
  // elsewhere, findings are the story's (fix-before-push comments), and do not hold the card
  assert.equal(findings(OTHER)?.column, 'ready');
  // 5: skip-review repo with no critic waits; 6: built is Ready to ship there, Ready for review elsewhere
  const built = (repo: string, critic: boolean) =>
    phase(repo, (card) => {
      const author = unique();
      run(card, author, 'author', 0);
      registry.finish(author, { sid: SID, result: { branch: 'x' }, at: stamp(5) });
      if (critic) {
        const name = unique();
        run(card, name, 'critic', 6);
        registry.finish(name, { sid: SID, findings: 0, at: stamp(9) });
      }
    });
  assert.equal(built(ONCE, false)?.column, 'checks');
  assert.equal(built(ONCE, true)?.column, 'ship');
  assert.equal(built(OTHER, false)?.column, 'ready');
  // a critic running holds a skip-review repo's card in Agent checks, and no other
  const reviewing = (repo: string) =>
    phase(repo, (card) => {
      const author = unique();
      run(card, author, 'author', 0);
      registry.finish(author, { sid: SID, result: { branch: 'x' }, at: stamp(5) });
      run(card, unique(), 'critic', 6);
    })?.column;
  assert.equal(reviewing(ONCE), 'checks');
  assert.equal(reviewing(OTHER), 'ready');
  // an author at its fixing state is working; at its plan check it is Agent checks
  const gate = (state: 'fixing' | 'plan') =>
    phase(OTHER, (card) => {
      const name = unique();
      run(card, name, 'author', 0);
      registry.state(name, { sid: SID, state, at: stamp(1) });
    })?.column;
  assert.equal(gate('fixing'), 'working');
  assert.equal(gate('plan'), 'checks');
});

test('H. the registry checks a run that names a card: unknown, dropped, a second author, typed repo', () => {
  const home = tmp('card-runs-checks');
  const store = new BacklogStore(home);
  const registry = new AgentRegistry(home, undefined, cardLookup(store));
  const item = store.add({ title: 'Checked', repo: REPO });
  store.start(item.id, { branch: 'checked' });
  const warnings: string[] = [];
  const base = { sid: SID, task: 't', kind: 'author' as const };
  assert.throws(
    () => registry.start({ ...base, name: 'a', card: 'bl_missing1' }),
    /no backlog card/,
  );
  registry.start(
    { ...base, name: 'a', card: item.id, repo: 'esshank/once-upon-a-diff', branch: 'typed' },
    (line) => warnings.push(line),
  );
  assert.equal(warnings.filter((line) => /ignored/.test(line)).length, 2);
  assert.equal(registry.agents()[0].repo, REPO, 'the card’s repo is the run’s');
  assert.equal(registry.agents()[0].branch, 'checked');
  // a different author on the card is a second one; the same name starting again is the fix round
  assert.throws(
    () => registry.start({ ...base, name: 'b', card: item.id }),
    /already has an open author/,
  );
  registry.state('a', { sid: SID, state: 'plan' });
  assert.throws(
    () => registry.start({ ...base, name: 'b', card: item.id }),
    /already has an open author/,
  );
  registry.start({ ...base, name: 'a', card: item.id });
  assert.equal(runsOf(item, registry.agents()).length, 2);
  assert.throws(
    () => registry.start({ ...base, name: 'c', kind: 'critic' as never, task: 't' }),
    /--card/,
  );
  store.drop(item.id);
  assert.throws(() => registry.start({ ...base, name: 'd', card: item.id }), /dropped/);
});

test('I. `backlog claim --repo` cannot move a card to another repo, and doctor lists the joins that do not hold', async () => {
  const home = tmp('card-runs-claim-repo');
  const store = new BacklogStore(home);
  const item = store.add({ title: 'On widgets', repo: 'acme/widgets' });
  const refused = await runCli(home, [
    'backlog',
    'claim',
    item.id,
    '--agent',
    'ou-x',
    '--repo',
    'acme/gadgets',
  ]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /acme\/widgets/);
  assert.equal(store.items()[0].repo, 'acme/widgets');
  const registry = new AgentRegistry(home);
  registry.start({
    name: 'ou-x',
    sid: SID,
    kind: 'author',
    task: 't',
    card: item.id,
    repo: 'esshank/widgets',
    at: stamp(0),
  });
  registry.start({
    name: 'lost',
    sid: SID,
    kind: 'author',
    task: 't',
    card: 'bl_missing1',
    at: stamp(0),
  });
  const problems = cardRunProblems(store.items(), registry.agents(), stamp(1).getTime());
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /typed repo esshank\/widgets/);
  assert.match(problems.join('\n'), /bl_missing1, which is not a card/);
});

test('J. a fix round restarted without --card is still the card’s run: one card, no agent card', async () => {
  const { registry, cards, card } = world();
  const item = card('Build it', 'build-it', 'ou-build');
  const author = { name: 'ou-build', sid: SID, kind: 'author' as const };
  registry.start({ ...author, card: item.id, task: 'build', at: stamp(0) });
  registry.finish('ou-build', { sid: SID, result: { branch: 'build-it' }, at: stamp(10) });
  registry.start({ ...author, task: 'fix round', at: stamp(11) });
  registry.state('ou-build', { sid: SID, state: 'fixing', at: stamp(11) });
  assert.equal(registry.agents()[0].card, item.id, 'the card carries over, as the kind does');
  const { mine, agentCards } = await shown(cards, item.id, stamp(12));
  assert.equal(mine.length, 1);
  assert.deepEqual(agentCards, []);
  assert.equal(mine[0].column, 'working');
});

test('K. a cardless claimed author and a carded critic or helper: the card is read by its claim, and the author has no card of its own', async () => {
  const { registry, cards, card } = world();
  const item = card('Mixed rows', 'mixed', 'ou-old');
  // an old brief: the author registered with no card; the critic (now required to) names it
  registry.start({
    name: 'ou-old',
    sid: SID,
    kind: 'author',
    task: 'build',
    repo: REPO,
    branch: 'mixed',
    at: stamp(0),
  });
  registry.start({
    name: 'review-m',
    sid: SID,
    kind: 'critic',
    task: 'r',
    card: item.id,
    at: stamp(1),
  });
  registry.start({
    name: 'tell-m',
    sid: SID,
    kind: 'helper',
    task: 'story',
    card: item.id,
    at: stamp(1),
  });
  let shownNow = await shown(cards, item.id, stamp(2));
  assert.equal(shownNow.mine.length, 1);
  assert.deepEqual(shownNow.agentCards, [], 'the author is on the card, not a card of its own');
  assert.deepEqual(shownNow.mine[0].agents.map((one) => one.name).sort(), [
    'ou-old',
    'review-m',
    'tell-m',
  ]);
  // the critic passes while the author still runs: not Ready to ship
  registry.finish('review-m', { sid: SID, findings: 0, at: stamp(3) });
  shownNow = await shown(cards, item.id, stamp(4));
  assert.notEqual(shownNow.mine[0].column, 'ship');
  assert.equal(shownNow.mine[0].column, 'working');
  assert.deepEqual(shownNow.agentCards, []);
});

test('L. a carded research run that fails does not send a finished card back to Backlog', async () => {
  const { registry, cards, store } = world();
  const item = store.add({ title: 'Built', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'built' });
  claimAt(store, item.id, 'ou-built', stamp(0).toISOString(), SID);
  registry.start({
    name: 'ou-built',
    sid: SID,
    kind: 'author',
    task: 'b',
    card: item.id,
    at: stamp(0),
  });
  registry.finish('ou-built', { sid: SID, result: { branch: 'built' }, at: stamp(10) });
  registry.start({
    name: 'look',
    sid: SID,
    kind: 'research',
    task: 'look',
    card: item.id,
    at: stamp(11),
  });
  registry.finish('look', { sid: SID, state: 'failed', at: stamp(12) });
  const { mine } = await shown(cards, item.id, stamp(13));
  assert.equal(mine[0].column, 'ready');
  assert.ok(mine[0].agents.some((one) => one.name === 'ou-built'));
});

test('M. a second author is refused only while the first is working: one parked in review or waiting frees the card', () => {
  const home = tmp('card-runs-parked');
  const store = new BacklogStore(home);
  const registry = new AgentRegistry(home, undefined, cardLookup(store));
  const item = store.add({ title: 'Parked', repo: REPO });
  const base = { sid: SID, task: 't', kind: 'author' as const, card: item.id };
  registry.start({ ...base, name: 'first' });
  assert.throws(() => registry.start({ ...base, name: 'second' }), /already has an open author/);
  registry.state('first', { sid: SID, state: 'review' });
  registry.start({ ...base, name: 'second' });
  assert.equal(runsOf(item, registry.agents()).length, 2);
});

test('N. `--role` and `--kind` agree through the aliases', async () => {
  const home = tmp('card-runs-role-alias');
  const item = new BacklogStore(home).add({ title: 'Alias', repo: REPO, branch: 'alias-branch' });
  const env = { CLAUDE_CODE_SESSION_ID: `${SID}-0000-4000-8000-000000000000` };
  const start = (name: string, ...flags: string[]) =>
    runCli(home, ['agent', 'start', name, ...flags, '--card', item.id, '--task', 'x'], env);
  assert.equal((await start('a-one', '--role', 'critic', '--kind', 'reviewer')).code, 0);
  assert.notEqual((await start('a-two', '--role', 'critic', '--kind', 'helper')).code, 0);
});
