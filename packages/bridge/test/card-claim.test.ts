import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { claimAt, registerRuns, runCli, tmp, writeJson, type AgentRun } from './helpers.ts';
import { Board, noPrWatcher } from '../src/services/board/board.ts';
import { BacklogStore, backlogCards } from '../src/services/backlog/backlog.ts';
import { CLAIM_GRACE_HOURS, claimedAgents, criticHold } from '../src/services/backlog/claims.ts';
import { startedLinks } from '../src/services/backlog/backlog-links.ts';
import { STALE_MS } from '../src/services/ledger/events.ts';
import { AgentRegistry } from '../src/services/ledger/registry.ts';
import { registrySource } from '../src/services/sessions/sources.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { Builds } from '../src/services/inbox/builds.ts';
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

test('claimedAgents: the newest run of the claimed name, pinned by sid when the claim has one', () => {
  const store = new BacklogStore(tmp('claim-resolve'));
  const item = store.add({ title: 'A thing' });
  const agents = agentsOf(RUNNING('ou-one', 'x', 'aaaaaaaa'), RUNNING('ou-one', 'y', 'bbbbbbbb'));
  store.claim(item.id, { agent: 'ou-one', sid: 'aaaaaaaa' });
  assert.equal(claimedAgents(store.items(), agents).get(item.id)?.sid, 'aaaaaaaa');
  store.claim(item.id, { agent: 'ou-missing' });
  assert.equal(claimedAgents(store.items(), agents).has(item.id), false);
  assert.ok(CLAIM_GRACE_HOURS > 0);
});

test('startedLinks finds its agent only through the claim: not by `by`, a folder name or the task text', () => {
  const store = new BacklogStore(tmp('claim-links'));
  const made = store.add({ title: 'T', repo: 'acme/widgets' });
  store.start(made.id, { branch: 'kill-inbox', by: 'ou-kill-inbox' });
  const agents = agentsOf(
    RUNNING('ou-kill-inbox', 'build in widgets-worktrees/kill-inbox'),
    RUNNING('kill-inbox'),
  );
  const facts = { worktrees: new Map(), sessions: [], agents, merged: () => null };
  assert.equal(startedLinks(store.items()[0], facts)?.agent, null);
  store.claim(made.id, { agent: 'ou-kill-inbox' });
  assert.equal(startedLinks(store.items()[0], facts)?.agent?.name, 'ou-kill-inbox');
});

test('a claimed card is ONE Working card with its agent, and the agent has no card of its own', async () => {
  const { store, cards } = world({
    ...RUNNING('ou-scout', 'research the thing'),
    beat: { n: 2, of: 6, step: 'plan', note: 'plan written', at: '2026-10-26T18:40:00Z' },
  });
  const item = store.add({ title: 'Research the thing', repo: 'acme/widgets' });
  store.claim(item.id, { agent: 'ou-scout' });
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
    RUNNING('ou-text', `card ${open.id} research`),
    RUNNING('ou-look'),
    RUNNING('look-into'),
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
  const { store, cards } = world({
    ...RUNNING('ou-scout'),
    now: { state: 'failed', at: '2026-10-26T18:45:00Z', outcome: 'gave up' },
  });
  const item = store.add({ title: 'Try it', repo: 'acme/widgets' });
  claimAt(store, item.id, 'ou-scout', '2026-10-26T18:35:00Z');
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
  const agent = agentsOf(RUNNING('ou-build'))[0];
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
    new Map([[item.id, view]]),
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

test('a finished card in a skip-review repo is Ready to ship only once its critic has passed and no fix round is open', async () => {
  const { home, cards, store } = world();
  const registry = new AgentRegistry(home);
  const repo = 'shank-eric/once-upon-a-diff';
  const stamp = (minutes: number) => new Date(Date.parse('2026-11-03T15:00:00Z') + minutes * 60000);
  const item = store.add({ title: 'Build it', repo });
  store.start(item.id, { branch: 'build-it' });
  claimAt(store, item.id, 'ou-build', stamp(0).toISOString(), 'aaaaaaaa');
  const author = { name: 'ou-build', sid: 'aaaaaaaa', repo, branch: 'build-it' } as const;
  const critic = { name: 'review-build-it', sid: 'aaaaaaaa', repo, branch: 'build-it' } as const;
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
  assert.equal(await columnAt(20), 'checks', 'the author is fixing');

  registry.finish('ou-build', { sid: 'aaaaaaaa', result: { branch: 'build-it' }, at: stamp(25) });
  assert.equal(await columnAt(26), 'ship', 'the author finished after the critic');
});

test('a critic that passed with no findings leaves a finished card in Ready to ship, and other repos are unaffected', async () => {
  const { home, cards, store } = world();
  const registry = new AgentRegistry(home);
  const stamp = (minutes: number) => new Date(Date.parse('2026-11-03T15:00:00Z') + minutes * 60000);
  const columns: Record<string, string | undefined> = {};
  for (const repo of ['shank-eric/once-upon-a-diff', 'acme/widgets']) {
    const name = `ou-${repo.split('/')[1]}`;
    const item = store.add({ title: `Work in ${repo}`, repo });
    store.start(item.id, { branch: 'feat-x' });
    claimAt(store, item.id, name, stamp(0).toISOString(), 'bbbbbbbb');
    registry.start({
      name,
      sid: 'bbbbbbbb',
      kind: 'author',
      task: 't',
      repo,
      branch: 'feat-x',
      at: stamp(0),
    });
    registry.finish(name, { sid: 'bbbbbbbb', result: { branch: 'feat-x' }, at: stamp(10) });
    registry.start({
      name: `review-${name}`,
      sid: 'bbbbbbbb',
      kind: 'critic',
      task: 'r',
      repo,
      branch: 'feat-x',
      at: stamp(11),
    });
    registry.finish(`review-${name}`, { sid: 'bbbbbbbb', findings: 0, at: stamp(15) });
    columns[repo] = (await cards(stamp(16))).find((one) => one.backlog?.id === item.id)?.column;
  }
  assert.deepEqual(columns, { 'shank-eric/once-upon-a-diff': 'ship', 'acme/widgets': 'ready' });
});

test('a built card stays in Agent checks with no critic, or when its latest critic failed or was stopped, and ships once one passes', () => {
  const { registry, repo, stamp, hold } = builtCard('hold-passed');
  assert.equal(hold(stamp(11)), 'checks', 'no critic yet');
  const critic = { sid: 'cccccccc', repo, branch: 'feat-x' } as const;
  registry.start({ ...critic, name: 'review-a', kind: 'critic', task: 'review', at: stamp(11) });
  registry.finish('review-a', { sid: 'cccccccc', state: 'failed', at: stamp(13) });
  assert.equal(hold(stamp(14)), 'checks', 'the critic failed');
  registry.start({ ...critic, name: 'review-b', kind: 'critic', task: 'review', at: stamp(15) });
  registry.finish('review-b', { sid: 'cccccccc', state: 'stopped', at: stamp(16) });
  assert.equal(hold(stamp(17)), 'checks', 'the latest critic was stopped');
  registry.start({ ...critic, name: 'review-c', kind: 'critic', task: 'review', at: stamp(18) });
  registry.finish('review-c', { sid: 'cccccccc', findings: 0, at: stamp(20) });
  assert.equal(hold(stamp(21)), null, 'a clean critic passes it');
  registry.start({ ...critic, name: 'review-d', kind: 'critic', task: 'review', at: stamp(22) });
  registry.finish('review-d', { sid: 'cccccccc', state: 'failed', at: stamp(23) });
  assert.equal(hold(stamp(24)), 'checks', 'a later critic that failed takes it back');
});

test('a critic that died (open, no sign of life for STALE_MS) has not passed the card', () => {
  const { registry, repo, stamp, hold } = builtCard('hold-dead');
  registry.start({
    name: 'review-x',
    sid: 'cccccccc',
    kind: 'critic',
    task: 'review',
    repo,
    branch: 'feat-x',
    at: stamp(11),
  });
  assert.equal(hold(new Date(stamp(11).getTime() + STALE_MS + 1000)), 'checks');
});

/** A built card on feat-x with its author finished at minute 10, and the registry that holds it. */
function builtCard(name: string) {
  const registry = new AgentRegistry(tmp(name));
  const store = new BacklogStore(tmp(`${name}-backlog`));
  const repo = 'shank-eric/once-upon-a-diff';
  const stamp = (minutes: number) => new Date(Date.parse('2026-11-03T15:00:00Z') + minutes * 60000);
  const added = store.add({ title: 'Build it', repo });
  const item = store.start(added.id, { branch: 'feat-x' });
  const author = { name: 'ou-build', sid: 'cccccccc', repo, branch: 'feat-x' } as const;
  registry.start({ ...author, kind: 'author', task: 'build', card: item.id, at: stamp(0) });
  registry.finish('ou-build', { sid: 'cccccccc', result: { branch: 'feat-x' }, at: stamp(10) });
  const hold = (nowAt: Date) =>
    criticHold(item, { sid: 'cccccccc', name: 'ou-build' }, registry.agents(), nowAt.getTime());
  return { registry, item, repo, stamp, author, hold };
}

test('findings nobody fixed lapse after STALE_MS, and a newer critic run with none releases the card at once', () => {
  const { registry, repo, stamp, hold } = builtCard('hold-lapse');
  const critic = { name: 'review-x', sid: 'cccccccc', repo, branch: 'feat-x' } as const;
  registry.start({ ...critic, kind: 'critic', task: 'review', at: stamp(11) });
  registry.finish('review-x', { sid: 'cccccccc', findings: 2, at: stamp(15) });
  assert.equal(hold(stamp(16)), 'checks');
  assert.equal(hold(new Date(stamp(15).getTime() + STALE_MS - 1000)), 'checks');
  assert.equal(
    hold(new Date(stamp(15).getTime() + STALE_MS + 1000)),
    null,
    'dropped findings lapse',
  );
  registry.start({ ...critic, kind: 'critic', task: 'review again', at: stamp(20) });
  registry.finish('review-x', { sid: 'cccccccc', findings: 0, at: stamp(22) });
  assert.equal(hold(stamp(23)), null, 'the rerun passed');
});

test("an author run for another card is not this card's fix round", () => {
  const { registry, repo, stamp, author, hold } = builtCard('hold-author-card');
  registry.start({
    name: 'review-x',
    sid: 'cccccccc',
    kind: 'critic',
    task: 'review',
    repo,
    branch: 'feat-x',
    at: stamp(11),
  });
  registry.finish('review-x', { sid: 'cccccccc', findings: 2, at: stamp(15) });
  registry.start({
    ...author,
    kind: 'author',
    task: 'other work',
    card: 'bl_other0000001',
    at: stamp(16),
  });
  assert.equal(hold(stamp(17)), 'checks', "its running is the other card's");
  registry.finish('ou-build', { sid: 'cccccccc', result: { branch: 'feat-x' }, at: stamp(25) });
  assert.equal(hold(stamp(26)), 'checks', "and its finish is not this card's fix");
  registry.start({ ...author, kind: 'author', task: 'fix', card: undefined, at: stamp(27) });
  assert.equal(hold(stamp(28)), 'working', 'a run that names no card still counts');
});

test('a critic registered for another card does not hold this one, even on the same branch', () => {
  const { registry, repo, stamp, item, hold } = builtCard('hold-critic-card');
  registry.start({
    name: 'review-old',
    sid: 'dddddddd',
    kind: 'critic',
    task: 'review',
    repo,
    branch: 'feat-x',
    card: 'bl_other0000001',
    at: stamp(11),
  });
  assert.equal(hold(stamp(12)), 'checks', "another card's critic does not pass this one");
  registry.start({
    name: 'review-mine',
    sid: 'dddddddd',
    kind: 'critic',
    task: 'review',
    repo,
    branch: 'feat-x',
    card: item.id,
    at: stamp(13),
  });
  assert.equal(hold(stamp(14)), 'checks', 'its own critic holds it');
});
