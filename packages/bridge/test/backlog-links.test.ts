import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, git } from './helpers.ts';
import { Board, noPrWatcher, type PrWatcher } from '../src/services/board/board.ts';
import { BacklogStore } from '../src/services/backlog/backlog.ts';
import {
  agentLinks,
  claimedId,
  claims,
  parseWorktrees,
  startedLinks,
  worktreeOfAgent,
} from '../src/services/backlog/backlog-links.ts';
import { parseLedger } from '../src/services/ledger/ledger.ts';
import { registrySource } from '../src/services/sessions/sources.ts';
import { seenCheckout } from '../src/services/config/repos.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import type { BoardCard, BoardStartedLinks } from '@once-upon-a-diff/shared/types';

const NOW = new Date('2026-10-26T19:00:00Z');

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

const ledgerLines = (state: string, rest: string) =>
  parseLedger(`- [${state}] sid:aaaaaaaa ou-kill-inbox ${rest}\n`, NOW, 'UTC');

test('startedLinks: a worktree on the branch, a session in it, the agent named by `by`, and a merge', () => {
  const home = tmp('links-unit');
  const store = new BacklogStore(home);
  const made = store.add({ title: 'Retire the inbox page?', repo: 'acme/widgets' });
  store.start(made.id, { branch: 'kill-inbox', by: 'Ou-Kill-Inbox' });
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
    agents: [
      ...ledgerLines('running', '(sonnet, high) — task — started 2:30 PM ET, 10/26'),
      ...parseLedger(
        '- [running] sid:aaaaaaaa ou-other (x) — t — started 2:30 PM ET, 10/26\n',
        NOW,
      ),
    ],
    beats: new Map([
      ['ou-kill-inbox', { n: 3, of: 6, step: 'code', note: 'removing' }],
      ['ou-other', { n: 1, of: 6, step: 'read', note: '' }],
    ]),
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

test('an agent whose task names the worktree folder is linked even when `by` is not its name', () => {
  const home = tmp('links-task');
  const store = new BacklogStore(home);
  const made = store.add({ title: 'T', repo: 'acme/widgets' });
  store.start(made.id, { branch: 'split', by: 'claude' });
  const agents = parseLedger(
    '- [running] sid:aaaaaaaa ou-splitter (x) — build in widgets-worktrees/split — started 2:30 PM ET, 10/26\n',
    NOW,
    'UTC',
  );
  const found = startedLinks(store.items()[0], {
    worktrees: new Map(),
    sessions: [],
    agents,
    beats: new Map(),
    merged: () => null,
  });
  assert.equal(found?.agent?.name, 'ou-splitter');
});

test('an agent named for the worktree folder or the branch’s last segment is linked when `by` is a session', () => {
  const home = tmp('links-folder');
  const store = new BacklogStore(home);
  const made = store.add({ title: 'TV barge-ins', repo: 'acme/widgets' });
  store.start(made.id, { branch: 'voice/speaker-cluster', by: 'clarifi-f9' });
  const agents = parseLedger(
    '- [done] sid:aaaaaaaa speaker-cluster (Opus) — 6:29 PM ET, 10/26 — 5901849 — notes\n' +
      '- [done] sid:aaaaaaaa speaker-windows (Opus) — 5:50 PM ET, 10/26 — a0fdc8b — notes\n',
    NOW,
    'UTC',
  );
  const found = startedLinks(store.items()[0], {
    worktrees: new Map(),
    sessions: [],
    agents,
    beats: new Map(),
    merged: () => null,
  });
  assert.equal(found?.agent?.name, 'speaker-cluster');
  assert.equal(found?.agent?.state, 'done');
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

test('the Retire-the-inbox case: a started card folds into its running agent’s card, and is Ready (unmerged work) when the agent finishes', async () => {
  const home = tmp('links-board');
  const sessions = tmp('links-sessions');
  const notes = tmp('links-notes');
  const ledger = path.join(notes, 'ledger.md');
  const progress = path.join(notes, 'progress.md');
  writeFileSync(
    ledger,
    '- [running] sid:54736864 ou-kill-inbox (sonnet, high) — remove the inbox — started 2:30 PM ET, 10/26\n',
  );
  writeFileSync(
    progress,
    '- 2:40 PM ou-kill-inbox 2/6 plan: plan written\n- 2:50 PM ou-kill-inbox 3/6 code: removing\n',
  );
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_ledger_file: ledger,
    board_progress_file: progress,
    board_ledger_time_zone: 'UTC',
  });
  repoWithWorktree(home);
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Retire the inbox page?', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'kill-inbox', repo: 'acme/widgets', by: 'ou-kill-inbox' });

  // one card: the agent's, titled by the backlog item, with the item noted on it; nothing left in Backlog
  const cardsOf = async (board: Board) =>
    (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  let cards = await cardsOf(boardOf(home, NOW));
  assert.equal(
    cards.some((one) => one.backlog?.id === item.id),
    false,
  );
  const agentCard = cards.find((one) => one.agents.some((agent) => agent.name === 'ou-kill-inbox'));
  assert.equal(agentCard?.kind, 'agent');
  assert.equal(agentCard?.title, 'Retire the inbox page?');
  assert.equal(agentCard?.column, 'working');
  assert.deepEqual(agentCard?.from_backlog, [{ id: item.id, title: 'Retire the inbox page?' }]);
  assert.deepEqual(agentCard?.agents[0].beat?.step, 'code');

  // still one card two days on, while the agent is running
  const later = new Date(Date.now() + 2 * 24 * 3600 * 1000); // the start events are stamped with the real clock
  cards = await cardsOf(boardOf(home, later));
  assert.equal(cards.filter((one) => one.title === 'Retire the inbox page?').length, 1);

  // the agent finishes with unmerged work on its branch: the item is one Ready card, linked to the worktree and the agent
  writeFileSync(
    ledger,
    '- [running] sid:54736864 ou-kill-inbox (sonnet, high) — remove the inbox — started 2:30 PM ET, 10/26\n' +
      '- [done] sid:54736864 ou-kill-inbox — 3:30 PM ET, 10/26 — committed on kill-inbox — notes\n',
  );
  // while the finished agent's own card stays (its 30 minutes), the item is on that card and there is no second one
  const waiting = (await cardsOf(boardOf(home, NOW))).find((one) => one.kind === 'agent');
  assert.equal(waiting?.column, 'done', 'it committed, so its card is in Done, not Waiting');
  assert.equal(waiting?.from_backlog?.[0].id, item.id);
  assert.equal(await backlogCard(boardOf(home, NOW), item.id), undefined);
  const done = await backlogCard(boardOf(home, later), item.id);
  assert.equal(done?.column, 'ready');
  assert.equal(done?.backlog?.started?.links?.agent?.state, 'done');
  assert.deepEqual(
    done?.backlog?.started?.links?.worktrees.map((tree) => tree.name),
    ['kill-inbox'],
  );
});

test('a card named in an agent’s ledger task is linked with no start: out of Backlog while it runs, and back in it when the agent fails', async () => {
  const home = tmp('links-named');
  const notes = tmp('links-named-notes');
  const ledger = path.join(notes, 'ledger.md');
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: tmp('links-named-sessions'),
    board_ledger_file: ledger,
    board_ledger_time_zone: 'UTC',
  });
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Research the thing', repo: 'acme/widgets' });
  const running = `- [running] sid:54736864 ou-scout (sonnet, high) — card ${item.id} research — started 2:30 PM ET, 10/26\n`;
  writeFileSync(ledger, running);
  const cardsOf = async () =>
    (await boardOf(home, NOW).snapshot()).lanes.flatMap((lane) => lane.cards);
  const cards = await cardsOf();
  assert.equal(
    cards.some((one) => one.backlog?.id === item.id),
    false,
  );
  const agentCard = cards.find((one) => one.agents.some((agent) => agent.name === 'ou-scout'));
  assert.equal(agentCard?.title, 'Research the thing');
  assert.deepEqual(agentCard?.from_backlog, [{ id: item.id, title: 'Research the thing' }]);
  // it fails: the item is a Backlog card again, marked tried by the agent
  writeFileSync(
    ledger,
    running + '- [failed] sid:54736864 ou-scout — 2:45 PM ET, 10/26 — gave up\n',
  );
  // (still one card while the failed agent's own card waits)
  assert.equal(await backlogCard(boardOf(home, NOW), item.id), undefined);
  const later = new Date(NOW.getTime() + 24 * 3600 * 1000);
  const back = await backlogCard(boardOf(home, later), item.id);
  assert.equal(back?.column, 'backlog');
  assert.equal(back?.backlog?.agent?.tried, true);
  assert.equal(back?.backlog?.agent?.links.agent?.name, 'ou-scout');
  // a reviewer naming the card, or a task that mentions it in passing, does not claim it
  const other = store.add({ title: 'Another card', repo: 'acme/widgets' });
  writeFileSync(
    ledger,
    `- [running] sid:54736864 review-x (opus, high) — review card ${other.id} diff — started 2:30 PM ET, 10/26\n` +
      `- [running] sid:54736864 ou-notes (sonnet, high) — card ${item.id} then see ${other.id} — started 2:30 PM ET, 10/26\n`,
  );
  assert.equal((await backlogCard(boardOf(home, NOW), other.id))?.column, 'backlog');
  assert.equal(
    (await backlogCard(boardOf(home, NOW), other.id))?.backlog?.agent,
    null,
    'no agent owns it',
  );
});

test('research that finished is Done for a day and then gone, never back in Backlog; an agent in a worktree makes its card Ready', async () => {
  const home = tmp('links-research');
  const ledger = path.join(tmp('links-research-notes'), 'ledger.md');
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: tmp('links-research-sessions'),
    board_ledger_file: ledger,
    board_ledger_time_zone: 'UTC',
  });
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Look into it', repo: 'acme/widgets' });
  writeFileSync(
    ledger,
    `- [running] sid:54736864 ou-look (sonnet, high) — card ${item.id} look — started 2:30 PM ET, 10/26\n` +
      '- [done] sid:54736864 ou-look — 3:00 PM ET, 10/26 — it is fine — notes/x.md\n',
  );
  const day = 24 * 3600 * 1000;
  // after the agent's own card is gone (a day on): Done, then off the board
  assert.equal(
    (await backlogCard(boardOf(home, new Date(NOW.getTime() + 12 * 3600 * 1000)), item.id))?.column,
    'done',
  );
  assert.equal(
    await backlogCard(boardOf(home, new Date(NOW.getTime() + 3 * day)), item.id),
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

test('agentLinks: an open item is linked by an agent whose task names its id, as a whole token', () => {
  const store = new BacklogStore(tmp('links-open'));
  const made = store.add({ title: 'Research a thing', repo: 'acme/widgets' });
  const item = store.items()[0];
  const facts = (task: string, state = 'running') => ({
    worktrees: new Map(),
    sessions: [],
    agents: ledgerLines(
      state,
      state === 'running'
        ? `(sonnet, high) — ${task} — started 2:30 PM ET, 10/26`
        : '— 3:00 PM ET, 10/26 — outcome',
    ),
    beats: new Map([['ou-kill-inbox', { n: 2, of: 6, step: 'plan', note: '' }]]),
    merged: () => null,
  });
  const found = agentLinks(item, facts(`card ${made.id} research`)) as BoardStartedLinks;
  assert.equal(found.agent?.name, 'ou-kill-inbox');
  assert.deepEqual(found.agent?.beat, { n: 2, of: 6, step: 'plan', note: '' });
  assert.equal(found.active, true);
  // a longer token around the id is not the id
  assert.equal(agentLinks(item, facts(`card ${made.id}x research`)), null);
  assert.equal(agentLinks(item, facts(`card x${made.id} research`)), null);
  assert.equal(agentLinks(item, facts('no card named')), null);
  // a finished agent still says who worked it, and is not active
  const done = agentLinks(item, {
    ...facts(''),
    agents: parseLedger(
      `- [running] sid:aaaaaaaa ou-kill-inbox (x) — card ${made.id} — started 2:30 PM ET, 10/26\n- [done] sid:aaaaaaaa ou-kill-inbox — 3:00 PM ET, 10/26 — ok\n`,
      NOW,
      'UTC',
    ),
  }) as BoardStartedLinks;
  assert.equal(done.agent?.state, 'done');
  assert.equal(done.active, false);
  // a started or dropped item is not an open item's link
  store.start(made.id, { branch: 'x' });
  assert.equal(agentLinks(store.items()[0], facts(`card ${made.id}`)), null);
});

test('claims: only the first `card <id>` of a non-reviewer’s task claims a card', () => {
  const agent = (name: string, task: string) => ({ name, task });
  assert.equal(claimedId('card bl_abcdef12 do it'), 'bl_abcdef12');
  assert.equal(claimedId('restore card bl_abcdef12 to top, then card bl_zzzzzz99'), 'bl_abcdef12');
  assert.equal(claimedId('see bl_abcdef12 for context'), null);
  assert.equal(claimedId('notes/x-bl_abcdef12-plan.md'), null);
  assert.equal(claims(agent('ou-a', 'card bl_abcdef12 x'), 'bl_abcdef12'), true);
  assert.equal(claims(agent('ou-a', 'card bl_abcdef12 x'), 'bl_zzzzzz99'), false);
  assert.equal(claims(agent('review-a', 'card bl_abcdef12 x'), 'bl_abcdef12'), false);
  assert.equal(claims(agent('ou-a', 'card bl_abcdef12x'), 'bl_abcdef12'), false);
});

test('worktreeOfAgent: the worktree named for the agent or in its task, never a default branch', () => {
  const trees = [
    { path: '/d/widgets', branch: 'main' },
    { path: '/d/widgets-worktrees/squash-ship', branch: 'squash-ship' },
    { path: '/d/widgets-worktrees/other', branch: 'stack/9-other' },
  ];
  const agent = (name: string, task: string) =>
    ({ name, task, sid: 'aaaaaaaa' }) as Parameters<typeof worktreeOfAgent>[0];
  assert.equal(worktreeOfAgent(agent('ou-squash-ship', 'card x'), trees)?.branch, 'squash-ship');
  assert.equal(
    worktreeOfAgent(agent('builder', 'in widgets-worktrees/other now'), trees)?.branch,
    'stack/9-other',
  );
  assert.equal(
    worktreeOfAgent(agent('builder', 'build on stack/9-other'), trees)?.branch,
    'stack/9-other',
  );
  assert.equal(worktreeOfAgent(agent('main', 'card x'), trees), null);
  assert.equal(worktreeOfAgent(agent('ou-research', 'card x'), trees), null);
});
