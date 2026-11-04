import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, git, claimAt, registerRuns, type AgentRun } from './helpers.ts';
import { Board, noPrWatcher, type PrWatcher } from '../src/services/board/board.ts';
import { BacklogStore } from '../src/services/backlog/backlog.ts';
import { agentLinks, parseWorktrees, startedLinks } from '../src/services/backlog/backlog-links.ts';
import { registrySource } from '../src/services/sessions/sources.ts';
import { seenCheckout } from '../src/services/config/repos.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import type { BoardCard, BoardStartedLinks } from '@once-upon-a-diff/contracts/types';

const NOW = new Date('2026-10-26T19:00:00Z');
/** while the fixtures' runs (2:30 PM ET, 10/26) were going */
const CLAIMED = '2026-10-26T18:35:00Z';

test('parseWorktrees reads the porcelain list: paths, branches, detached ones', () => {
  const text = [
    'worktree /dev/widgets',
    'HEAD aaaa',
    'branch refs/heads/main',
    '',
    'worktree /dev/widgets-worktrees/kill-inbox',
    'HEAD bbbb',
    'branch refs/heads/kill-inbox',
    '',
    'worktree /dev/widgets-worktrees/split',
    'HEAD cccc',
    'detached',
    '',
  ].join('\n');
  assert.deepEqual(parseWorktrees(text), [
    { path: '/dev/widgets', branch: 'main' },
    { path: '/dev/widgets-worktrees/kill-inbox', branch: 'kill-inbox' },
    { path: '/dev/widgets-worktrees/split', branch: null },
  ]);
});

/** 2:30 PM ET, 10/26, when the fixtures' runs start */
const STARTED = '2026-10-26T18:30:00Z';

/** The agents the runs register, as the board reads them. */
const agentsOf = (...runs: AgentRun[]) => registerRuns(tmp('links-agents'), ...runs).agents();

test('startedLinks: a worktree on the branch, a session in it, the agent that claimed the card, and a merge', () => {
  const home = tmp('links-unit');
  const store = new BacklogStore(home);
  const made = store.add({ title: 'Retire the inbox page?', repo: 'acme/widgets' });
  store.start(made.id, { branch: 'kill-inbox', by: 'Ou-Kill-Inbox' });
  store.claim(made.id, { agent: 'ou-kill-inbox' });
  const item = store.items()[0];
  const facts = {
    worktrees: new Map([
      [
        'acme/widgets',
        [
          { path: '/dev/widgets', branch: 'main' },
          { path: '/dev/widgets-worktrees/kill-inbox', branch: 'kill-inbox' },
          { path: '/dev/widgets-worktrees/other', branch: 'other' },
        ],
      ],
    ]),
    sessions: [
      {
        id: 's1',
        title: 'the builder',
        cwd: '/dev/widgets-worktrees/kill-inbox/src',
        repo: 'acme/widgets',
        branch: null,
      },
      { id: 's2', title: 'elsewhere', cwd: '/dev/widgets', repo: 'acme/widgets', branch: 'main' },
      { id: 's3', title: 'other repo', cwd: '/x', repo: 'acme/gadgets', branch: 'kill-inbox' },
    ],
    agents: agentsOf(
      {
        sid: 'aaaaaaaa',
        name: 'ou-kill-inbox',
        kind: 'author',
        started: STARTED,
        beat: { n: 3, of: 6, step: 'code', note: 'removing', at: '2026-10-26T18:50:00Z' },
      },
      {
        sid: 'aaaaaaaa',
        name: 'ou-other',
        started: STARTED,
        beat: { n: 1, of: 6, step: 'read', at: '2026-10-26T18:40:00Z' },
      },
    ),
    merged: () => null,
  };
  const found = startedLinks(item, facts) as BoardStartedLinks;
  assert.deepEqual(found.worktrees, [
    { path: '/dev/widgets-worktrees/kill-inbox', name: 'kill-inbox' },
  ]);
  assert.deepEqual(found.sessions, [{ id: 's1', title: 'the builder' }]);
  assert.equal(found.agent?.name, 'ou-kill-inbox');
  assert.deepEqual(found.agent?.beat, { n: 3, of: 6, step: 'code', note: 'removing' });
  assert.equal(found.active, true);
  // merged: shown as merged, and no longer active
  const merged = startedLinks(item, {
    ...facts,
    merged: () => ({ at: null }),
  }) as BoardStartedLinks;
  assert.equal(merged.merged, true);
  assert.equal(merged.active, false);
  // nothing linked says so, as before
  const bare = store.add({ title: 'Lonely', repo: 'acme/widgets' });
  store.start(bare.id, { branch: 'lonely', by: 'someone' });
  const lonely = startedLinks(
    store.items().find((one) => one.id === bare.id) as never,
    facts,
  ) as BoardStartedLinks;
  assert.equal(lonely.active, false);
});

/** A repo (origin acme/widgets) with a worktree on `kill-inbox`, like <repo>-worktrees/kill-inbox, known to the board. */
function repoWithWorktree(home: string) {
  const parent = tmp('links-repo');
  const checkout = path.join(parent, 'widgets');
  mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  writeFileSync(path.join(checkout, 'a.txt'), 'a\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'base');
  const trees = path.join(parent, 'widgets-worktrees');
  mkdirSync(trees);
  git(checkout, 'worktree', 'add', '-q', path.join(trees, 'kill-inbox'), '-b', 'kill-inbox');
  seenCheckout(home, 'acme/widgets', checkout);
  return checkout;
}

function boardOf(home: string, now: Date, review: PrWatcher = noPrWatcher) {
  return new Board(home, new StoryStore({ home }), review, new Builds(home), {
    source: registrySource,
    now: () => now,
  });
}

const backlogCard = async (board: Board, id: string): Promise<BoardCard | undefined> =>
  (await board.snapshot()).lanes
    .flatMap((lane) => lane.cards)
    .find((card) => card.backlog?.id === id);

test('the Retire-the-inbox case: a claimed, started card is one Working card with its agent, and is Ready (unmerged work) when the agent finishes', async () => {
  const home = tmp('links-board');
  const sessions = tmp('links-sessions');
  const registry = registerRuns(home, {
    sid: '54736864',
    name: 'ou-kill-inbox',
    kind: 'author',
    task: 'remove the inbox',
    started: STARTED,
  });
  registry.beat('ou-kill-inbox', {
    n: 2,
    of: 6,
    step: 'plan',
    note: 'plan written',
    at: new Date('2026-10-26T18:40:00Z'),
  });
  registry.beat('ou-kill-inbox', {
    n: 3,
    of: 6,
    step: 'code',
    note: 'removing',
    at: new Date('2026-10-26T18:50:00Z'),
  });
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  repoWithWorktree(home);
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Retire the inbox page?', repo: 'acme/widgets' });
  claimAt(store, item.id, 'ou-kill-inbox', CLAIMED);
  store.start(item.id, { branch: 'kill-inbox', repo: 'acme/widgets', by: 'ou-kill-inbox' });

  // one card: the backlog card itself, in Working, with the agent on it and no card for the agent
  const cardsOf = async (board: Board) =>
    (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  let cards = await cardsOf(boardOf(home, NOW));
  assert.equal(cards.filter((one) => one.kind === 'agent').length, 0);
  const only = cards.filter((one) => one.backlog?.id === item.id);
  assert.equal(only.length, 1);
  assert.equal(only[0].title, 'Retire the inbox page?');
  assert.equal(only[0].column, 'working');
  assert.deepEqual(only[0].agents[0].beat?.step, 'code');
  assert.equal(only[0].backlog?.started?.links?.agent?.name, 'ou-kill-inbox');

  // still one card two days on, while the agent is running
  const later = new Date(Date.now() + 2 * 24 * 3600 * 1000); // the start events are stamped with the real clock
  cards = await cardsOf(boardOf(home, later));
  assert.equal(cards.filter((one) => one.title === 'Retire the inbox page?').length, 1);
  assert.equal(cards.filter((one) => one.kind === 'agent').length, 0);

  // the agent finishes with unmerged work on its branch: the item is one Ready card, linked to the worktree and the agent
  registry.finish('ou-kill-inbox', {
    outcome: 'committed on kill-inbox',
    at: new Date('2026-10-26T19:30:00Z'),
  });
  const done = await backlogCard(boardOf(home, later), item.id);
  assert.equal(done?.column, 'ready');
  assert.equal(done?.backlog?.started?.links?.agent?.state, 'done');
  assert.deepEqual(
    done?.backlog?.started?.links?.worktrees.map((tree) => tree.name),
    ['kill-inbox'],
  );
});

test('a claimed card (no start) is out of Backlog while its agent runs, and back in it when the agent fails', async () => {
  const home = tmp('links-named');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('links-named-sessions') });
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Research the thing', repo: 'acme/widgets' });
  claimAt(store, item.id, 'ou-scout', CLAIMED);
  const registry = registerRuns(home, {
    sid: '54736864',
    name: 'ou-scout',
    kind: 'research',
    task: 'research',
    started: STARTED,
  });
  const cardsOf = async () =>
    (await boardOf(home, NOW).snapshot()).lanes.flatMap((lane) => lane.cards);
  const cards = await cardsOf();
  assert.equal(
    cards.some((one) => one.kind === 'agent'),
    false,
  );
  const mine = cards.find((one) => one.backlog?.id === item.id);
  assert.equal(mine?.column, 'working');
  assert.equal(mine?.agents[0].name, 'ou-scout');
  // it fails: the item is a Backlog card, marked tried by the agent
  registry.finish('ou-scout', {
    state: 'failed',
    outcome: 'gave up',
    at: new Date('2026-10-26T18:45:00Z'),
  });
  const back = await backlogCard(boardOf(home, NOW), item.id);
  assert.equal(back?.column, 'backlog');
  assert.equal(back?.backlog?.agent?.tried, true);
  assert.equal(back?.backlog?.agent?.links.agent?.name, 'ou-scout');
  // a task that names a card, for a reviewer or in passing, claims nothing
  const other = store.add({ title: 'Another card', repo: 'acme/widgets' });
  registerRuns(
    home,
    {
      sid: '54736864',
      name: 'review-x',
      kind: 'critic',
      task: `review card ${other.id} diff`,
      started: STARTED,
    },
    {
      sid: '54736864',
      name: 'ou-notes',
      task: `card ${other.id} then see ${item.id}`,
      started: STARTED,
    },
  );
  assert.equal((await backlogCard(boardOf(home, NOW), other.id))?.column, 'backlog');
  assert.equal(
    (await backlogCard(boardOf(home, NOW), other.id))?.backlog?.agent,
    null,
    'no agent owns it',
  );
});

test('research that finished is Done for an hour and then gone, never back in Backlog; an agent in a worktree makes its card Ready', async () => {
  const home = tmp('links-research');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('links-research-sessions') });
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Look into it', repo: 'acme/widgets' });
  claimAt(store, item.id, 'ou-look', CLAIMED);
  registerRuns(home, {
    sid: '54736864',
    name: 'ou-look',
    kind: 'research',
    task: 'look',
    started: STARTED,
    now: { state: 'done', at: '2026-10-26T19:00:00Z', outcome: 'it is fine', notes: 'notes/x.md' },
  });
  const hour = 3600 * 1000;
  // the agent ended at 7:00 PM UTC (NOW): Done half an hour on, off the board two hours on
  assert.equal(
    (await backlogCard(boardOf(home, new Date(NOW.getTime() + 0.5 * hour)), item.id))?.column,
    'done',
  );
  assert.equal(
    await backlogCard(boardOf(home, new Date(NOW.getTime() + 2 * hour)), item.id),
    undefined,
  );
});

test('a started card with no session, agent or worktree yet is a Working card, for the grace day', async () => {
  const home = tmp('links-unlinked');
  const sessions = tmp('links-sessions-u');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  repoWithWorktree(home);
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Not picked up', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'not-yet', repo: 'acme/widgets', by: 'nobody' });
  const card = await backlogCard(boardOf(home, new Date()), item.id);
  assert.equal(card?.column, 'working');
  assert.equal(card?.backlog?.started?.links?.active, false);
});

test('a merged branch shows merged, and an unlinked started card still drops after the day', async () => {
  const home = tmp('links-merged');
  const sessions = tmp('links-sessions2');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  repoWithWorktree(home);
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Retire the inbox page?', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'kill-inbox', repo: 'acme/widgets', by: 'nobody' });
  const lonely = store.add({ title: 'No trace', repo: 'acme/widgets' });
  store.start(lonely.id, { branch: 'no-trace', repo: 'acme/widgets', by: 'nobody' });
  const merged: PrWatcher = {
    ...noPrWatcher,
    branchPr: (_repo, branch) =>
      branch === 'kill-inbox'
        ? { number: 9, state: 'merged', merged_at: NOW.toISOString() }
        : undefined,
  };
  const card = await backlogCard(boardOf(home, NOW, merged), item.id);
  assert.equal(card?.backlog?.started?.links?.merged, true);
  assert.equal(card?.backlog?.started?.links?.active, false);
  assert.equal(card?.backlog?.started?.links?.merged_at, NOW.toISOString());
  assert.equal(card?.column, 'done', 'merged work is a Done card, not a Backlog one');
  const later = new Date(Date.now() + 2 * 24 * 3600 * 1000); // the start events are stamped with the real clock
  assert.equal(await backlogCard(boardOf(home, later, merged), item.id), undefined);
  assert.equal(await backlogCard(boardOf(home, later, merged), lonely.id), undefined);
  assert.ok(await backlogCard(boardOf(home, NOW, merged), lonely.id), 'within the day it shows');
});

test('work fast-forwarded into the main checkout’s branch shows merged; a branch with no commits of its own does not', async () => {
  const home = tmp('links-ff');
  const sessions = tmp('links-sessions3');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const checkout = repoWithWorktree(home);
  const tree = path.join(path.dirname(checkout), 'widgets-worktrees', 'kill-inbox');
  git(checkout, 'checkout', '-q', '-b', 'phone/live');
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Retire the inbox page?', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'kill-inbox', repo: 'acme/widgets', by: 'nobody' });
  // created, nothing committed yet: its tip is in phone/live, but it is not merged work
  let card = await backlogCard(boardOf(home, NOW), item.id);
  assert.equal(card?.backlog?.started?.links?.merged, false);
  assert.equal(card?.backlog?.started?.links?.active, true);
  // a commit in the worktree, then fast-forwarded into the main checkout's branch
  writeFileSync(path.join(tree, 'b.txt'), 'b\n');
  git(tree, 'add', '.');
  git(tree, 'commit', '-q', '-m', 'work');
  card = await backlogCard(boardOf(home, NOW), item.id);
  assert.equal(card?.backlog?.started?.links?.merged, false, 'committed but not in phone/live yet');
  git(checkout, 'merge', '-q', '--ff-only', 'kill-inbox');
  card = await backlogCard(boardOf(home, NOW), item.id);
  assert.equal(card?.backlog?.started?.links?.merged, true);
  assert.equal(card?.backlog?.started?.links?.active, false);
  assert.ok(card?.backlog?.started?.links?.merged_at, 'dated by the branch tip’s commit');
  assert.equal(card?.column, 'done');
});

test('agentLinks: an open item is linked by the agent that claimed it, and by nothing else', () => {
  const store = new BacklogStore(tmp('links-open'));
  const made = store.add({ title: 'Research a thing', repo: 'acme/widgets' });
  const facts = (task: string, state = 'running') => ({
    worktrees: new Map(),
    sessions: [],
    agents: agentsOf({
      sid: 'aaaaaaaa',
      name: 'ou-kill-inbox',
      task,
      started: STARTED,
      beat: { n: 2, of: 6, step: 'plan', at: '2026-10-26T18:40:00Z' },
      ...(state === 'running'
        ? {}
        : { now: { state, at: NOW, outcome: 'outcome' } as AgentRun['now'] }),
    }),
    merged: () => null,
  });
  // the task naming the id is not a claim
  assert.equal(agentLinks(store.items()[0], facts(`card ${made.id} research`)), null);
  claimAt(store, made.id, 'ou-kill-inbox', CLAIMED);
  const found = agentLinks(store.items()[0], facts('research')) as BoardStartedLinks;
  assert.equal(found.agent?.name, 'ou-kill-inbox');
  assert.deepEqual(found.agent?.beat, { n: 2, of: 6, step: 'plan', note: '' });
  assert.equal(found.active, true);
  // a claim by another name finds no agent
  claimAt(store, made.id, 'ou-someone-else', CLAIMED);
  assert.equal(agentLinks(store.items()[0], facts('research')), null);
  claimAt(store, made.id, 'ou-kill-inbox', CLAIMED);
  // a finished agent still says who worked it, and is not active
  const done = agentLinks(store.items()[0], {
    ...facts(''),
    agents: agentsOf({
      sid: 'aaaaaaaa',
      name: 'ou-kill-inbox',
      task: 'go',
      started: STARTED,
      now: { state: 'done', at: NOW, outcome: 'ok' },
    }),
  }) as BoardStartedLinks;
  assert.equal(done.agent?.state, 'done');
  assert.equal(done.active, false);
  // a started item is not an open item's link
  store.start(made.id, { branch: 'x' });
  assert.equal(agentLinks(store.items()[0], facts('go')), null);
});
