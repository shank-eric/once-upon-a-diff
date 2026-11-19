import '@once-upon-a-diff/test-kit/env';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { registerRuns } from '@once-upon-a-diff/state/test/helpers';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { Board, noPrWatcher } from '../src/board.ts';
import { columnOf } from '../src/columns.ts';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { pickSource } from '@once-upon-a-diff/core/features/sessions/sources';
import { findIt2, itermTabs } from '@once-upon-a-diff/adapters/iterm';
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { type StatusSource } from '@once-upon-a-diff/adapters/status-source';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { type BoardCard } from '@once-upon-a-diff/contracts/types';
import { etAt, fakeWatcher, prInfo, sourceSaying } from './board-fixtures.ts';
import {
  NOW,
  checkoutOf,
  fullId,
  liveChild,
  prStory,
  procStartOf,
  registry,
} from '@once-upon-a-diff/state/test/board-fixtures';

test("someone else's PR with a built story stays in PR open despite an unread answer (#7009)", () => {
  const none = { sessions: [], agents: [], pr: null, story: null };
  // #7009's shape: Usman's PR, you not requested, a reviewed story you have opened, one unread answer to your question
  const theirs = prInfo(7009, {
    author: 'usman154',
    mine: false,
    review_requested: false,
    approvals: 1,
    required: 3,
    review: 'approved',
    checks: 'failure',
    unresolved: 1,
    viewer_at: '2026-11-02T22:05:47Z',
    others_at: null,
  });
  const story = { reviewed: true, manualReviewedAt: null, unread: false, answered: 1 };
  assert.equal(columnOf({ ...none, pr: theirs, story }), 'pr_open');
  // what still puts it in Back to you: GitHub asking for your review, a new version of the story, a reply for you
  assert.equal(
    columnOf({ ...none, pr: { ...theirs, review_requested: true }, story }),
    'back',
    'requested',
  );
  assert.equal(columnOf({ ...none, pr: theirs, story: { ...story, unread: true } }), 'back');
  assert.equal(
    columnOf({ ...none, pr: { ...theirs, others_at: '2026-11-02T22:30:00Z' }, story }),
    'back',
  );
  // your own PR keeps the rule: an unread answer is back to you
  assert.equal(columnOf({ ...none, pr: { ...theirs, mine: true }, story }), 'back');
  // a stub PR (GitHub has not said who wrote it yet): author null, mine false, not yours until GitHub says so
  assert.equal(columnOf({ ...none, pr: { ...theirs, author: null }, story }), 'pr_open', 'stub');
});

test('the board: a card per branch or PR with its sessions and agents, columns to merge, lanes by repo', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const children = Array.from({ length: 7 }, () => liveChild());
  after(() => children.forEach((child) => child.stop()));
  const [onStory, second, onBranch, onMain, loose, staleOne, staleTwo] = children;
  const sid = (child: { pid: number }) => String(child.pid).padStart(8, '0');
  const widgetsX = checkoutOf('widgets', 'feat/x');
  const widgetsY = checkoutOf('widgets', 'feat/y');
  const gadgets = checkoutOf('gadgets', 'main');
  const noRepo = tmp('board-no-repo');
  const stale = checkoutOf('widgets', 'old/merged');
  // two sessions on the branch that has a story, one on a branch GitHub knows a PR for, one on a default branch, one outside any repo
  registry(
    sessions,
    onStory.pid,
    { cwd: widgetsX, name: 'story-one', status: 'busy' },
    onStory.procStart,
  );
  registry(sessions, second.pid, { cwd: widgetsX, name: 'story-two' }, second.procStart);
  registry(sessions, onBranch.pid, { cwd: widgetsY, name: 'branch-one' }, onBranch.procStart);
  registry(sessions, onMain.pid, { cwd: gadgets, name: 'main-one' }, onMain.procStart);
  registry(sessions, loose.pid, { cwd: noRepo, name: 'loose-one' }, loose.procStart);
  // two unrelated sessions in a checkout left on a branch whose PR merged: each is a card of its own
  registry(sessions, staleOne.pid, { cwd: stale, name: 'stale-one' }, staleOne.procStart);
  registry(sessions, staleTwo.pid, { cwd: stale, name: 'stale-two' }, staleTwo.procStart);

  // stories: 7 is being worked on, 8 is built and waiting for you, 10 you reviewed and others asked something since,
  // 11 you reviewed and read, nothing is new, 17 you reviewed but it was rebuilt since, 12 merged half an hour ago,
  // 13 merged three days ago, 21 merged two hours ago, 14 is someone else's PR with a story built for you, 15 has not been described by GitHub yet
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  prStory(home, 'acme-widgets-8', 'acme/widgets', 8, 'feat/z');
  prStory(home, 'acme-widgets-14', 'acme/widgets', 14, 'feat/theirs');
  prStory(home, 'acme-widgets-15', 'acme/widgets', 15, 'feat/unknown');
  prStory(home, 'acme-widgets-23', 'acme/widgets', 23, 'feat/their-draft');
  const byHand = { 'review.json': { mark: { at: '2026-10-26T14:00:00Z', by: 'manual' } } };
  const opened = { 'position.json': { at: '2099-01-01T00:00:00Z' } }; // you opened the story after it was built
  prStory(home, 'acme-widgets-10', 'acme/widgets', 10, 'feat/ten', { ...byHand, ...opened });
  prStory(home, 'acme-widgets-11', 'acme/widgets', 11, 'feat/eleven', { ...byHand, ...opened });
  prStory(home, 'acme-widgets-17', 'acme/widgets', 17, 'feat/seventeen', byHand);
  // a session is fixing the code for story 18 (a claimed fix request), and building a story for PR 16, which has none yet
  prStory(home, 'acme-widgets-18', 'acme/widgets', 18, 'feat/eighteen', { ...byHand, ...opened });
  writeJson(path.join(home, 'fixes.json'), {
    f1: {
      id: 'f1',
      story: 'acme-widgets-18',
      repo: 'acme/widgets',
      kind: 'github',
      title: null,
      url: null,
      branch: null,
      checkout: null,
      notes: [],
      to: null,
      requested_at: NOW.toISOString(),
      status: 'pending',
      claimed_by: 'session-a',
      claimed_at: new Date().toISOString(),
    },
  });
  new Builds(home).save({
    'acme/widgets#16': {
      id: 'b1',
      repo: 'acme/widgets',
      number: 16,
      url: null,
      requested_at: NOW.toISOString(),
      status: 'pending',
      mode: 'rebuild',
      claimed_by: 'session-b',
      claimed_at: new Date().toISOString(),
    },
  });
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3600000).toISOString();
  prStory(home, 'acme-widgets-12', 'acme/widgets', 12, 'feat/twelve', {
    'merged.json': { at: hoursAgo(0.25), why: 'merged', merged_at: hoursAgo(0.5) },
  });
  prStory(home, 'acme-widgets-21', 'acme/widgets', 21, 'feat/twenty-one', {
    'merged.json': { at: hoursAgo(1.9), why: 'merged', merged_at: hoursAgo(2) },
  });
  prStory(home, 'acme-widgets-13', 'acme/widgets', 13, 'feat/thirteen', {
    'merged.json': { at: hoursAgo(71), why: 'merged', merged_at: hoursAgo(72) },
  });

  // two cardless agents registered on PR 7's branch and PR: a card each, never nested (ADR-25)
  const registered = new AgentRegistry(home);
  registered.start({
    sid: sid(onStory),
    name: 'nested-one',
    kind: 'author',
    task: 'nested task',
    model: 'sonnet',
    effort: 'low',
    repo: 'acme/widgets',
    branch: 'feat/x',
    at: etAt(14, 50),
  });
  registered.beat('nested-one', { n: 3, of: 6, step: 'code', note: 'writing', at: etAt(14, 52) });
  registered.start({
    sid: sid(onStory),
    name: 'pr-agent',
    kind: 'author',
    task: 'review fixes',
    model: 'sonnet',
    effort: 'low',
    repo: 'acme/widgets',
    pr: 7,
    at: etAt(14, 51),
  });
  // agents with no registered repo, branch or PR: each a card of its own
  registerRuns(
    home,
    {
      sid: sid(onStory),
      name: 'nested-done',
      started: etAt(14, 35),
      now: { state: 'done', at: etAt(14, 40), outcome: 'it finished' },
    },
    {
      sid: sid(onStory),
      name: 'nested-old',
      started: etAt(7, 35),
      now: { state: 'done', at: etAt(7, 40), outcome: 'hours ago' },
    },
    {
      sid: sid(onStory),
      name: 'tagged-one',
      task: 'tagged task',
      started: etAt(14, 55),
      beat: { n: 1, of: 6, step: 'read', note: 'reading', at: etAt(14, 56) },
    },
    {
      sid: sid(onStory),
      name: 'wt-agent',
      task: 'refactor in widgets-worktrees/refactor',
      started: etAt(14, 52),
    },
    {
      sid: sid(onStory),
      name: 'crosscut-note',
      task: 'notes for the Cross Cutting plan',
      started: etAt(14, 53),
    },
    {
      sid: sid(onMain),
      name: 'needs-answer',
      started: etAt(14, 40),
      now: {
        state: 'waiting',
        at: etAt(14, 45),
        outcome: 'needs Eric: pick A or B',
        notes: 'notes/x.md',
      },
    },
    { sid: 'deadbeef', name: 'orphan', task: 'no parent', started: etAt(14, 57) },
    {
      sid: 'deadbeef',
      name: 'broke',
      started: etAt(14, 50),
      now: { state: 'failed', at: etAt(14, 58), outcome: 'exploded' },
    },
    {
      sid: 'deadbeef',
      name: 'stopped-one',
      started: etAt(14, 50),
      now: { state: 'stopped', at: etAt(14, 59), outcome: 'asked to stop' },
    },
  );
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const seven = prInfo(7, {
    title: 'Seven on GitHub',
    branch: 'feat/x',
    approvals: 1,
    required: 2,
    checks: 'success',
    merge: { ready: false, text: 'needs 1 more approval', tone: 'warn' },
  });
  const { watcher, asked } = fakeWatcher(
    [
      seven,
      prInfo(8),
      prInfo(14, { author: 'someone', mine: false }),
      prInfo(16, { author: 'someone', mine: false }),
      prInfo(17),
      prInfo(18),
      prInfo(19, { author: 'someone', mine: false, review_requested: true }),
      prInfo(20, { author: 'someone', mine: false, review_requested: true, draft: true }),
      prInfo(22, { draft: true }),
      prInfo(23, { author: 'someone', mine: false, review_requested: true, draft: true }),
      prInfo(9, { branch: 'feat/y', checks: 'pending' }),
      prInfo(10, { viewer_at: '2026-10-26T13:00:00Z', others_at: '2026-10-26T15:00:00Z' }),
      prInfo(11, { others_at: '2026-10-26T13:00:00Z' }),
      prInfo(12, { state: 'merged', merged_at: hoursAgo(0.5) }),
      prInfo(21, { state: 'merged', merged_at: hoursAgo(2) }),
    ],
    {
      'acme/widgets@feat/y': { number: 9, state: 'open', merged_at: null },
      'acme/widgets@old/merged': { number: 3, state: 'merged', merged_at: null },
    },
    // 19 is someone else's PR GitHub is waiting on your review for
    // 20 is someone else's draft with a review request, and 22 is your own draft
    [
      { repo: 'acme/widgets', number: 19 },
      { repo: 'acme/widgets', number: 20 },
      { repo: 'acme/widgets', number: 22 },
    ],
  );
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({
      [sid(onBranch)]: { status: 'waiting', detail: 'asked you a question' },
      [sid(loose)]: { status: 'working', detail: 'compiling' },
      [sid(staleTwo)]: { status: 'done', detail: null },
    }),
    now: () => NOW,
  });
  const data = await board.snapshot();
  assert.equal(data.status_source, 'registry');
  const cards = data.lanes.flatMap((lane) => lane.cards);
  const card = (id: string) => cards.find((found) => found.id === id) as BoardCard;

  assert.deepEqual(Object.fromEntries(cards.map((found) => [found.id, found.column])), {
    'pr:acme/widgets#7': 'working', // a session is busy on it, though its story is unreviewed
    'pr:acme/widgets#9': 'waiting', // found by its branch, no story; the session asked a question
    'pr:acme/widgets#8': 'pr_open', // an unreviewed story on a PR is still the GitHub side's
    'pr:acme/widgets#10': 'back', // an open thread asks something of you
    'pr:acme/widgets#11': 'pr_open',
    'pr:acme/widgets#17': 'back', // rebuilt since you last opened it
    'pr:acme/widgets#18': 'working', // a session is fixing the code
    'pr:acme/widgets#16': 'working', // a session is building its story, whatever branch it is on
    'pr:acme/widgets#14': 'pr_open', // someone else's PR, with a story built for you: GitHub's side, not Ready
    'pr:acme/widgets#15': 'pr_open',
    'pr:acme/widgets#19': 'back', // GitHub is waiting on your review
    'pr:acme/widgets#22': 'pr_open', // your own draft still shows
    'pr:acme/widgets#12': 'done',
    [fullId(onMain.pid)]: 'idle',
    [`agent:${sid(onMain)}:needs-answer`]: 'waiting', // its own card, in its parent's lane
    [fullId(staleOne.pid)]: 'idle', // the branch's PR merged: a card of its own, not shared
    [fullId(staleTwo.pid)]: 'idle', // its tab says done, nothing waiting: the Idle lane
    [`agent:${sid(onStory)}:wt-agent`]: 'working',
    [`agent:${sid(onStory)}:crosscut-note`]: 'working',
    [fullId(loose.pid)]: 'thinking', // busy, no run open, no work card
    [`agent:${sid(onStory)}:tagged-one`]: 'working',
    [`agent:${sid(onStory)}:nested-one`]: 'working', // cardless: its branch is no link to PR 7's card
    [`agent:${sid(onStory)}:pr-agent`]: 'working',
    'agent:deadbeef:orphan': 'working',
    [`agent:${sid(onStory)}:nested-done`]: 'done', // a helper that finished 20 minutes ago: in Done for 30
    'agent:deadbeef:broke': 'error',
    'agent:deadbeef:stopped-one': 'done',
  });
  assert.equal(card('pr:acme/widgets#13'), undefined, 'merged three days ago: gone');
  assert.equal(
    card('pr:acme/widgets#21'),
    undefined,
    'merged two hours ago: gone, the Done hour is up',
  );
  assert.equal(card('pr:acme/widgets#17').story?.unread, true);
  assert.equal(card('pr:acme/widgets#11').story?.unread, false);
  assert.equal(
    card('pr:acme/widgets#8').story?.unread,
    false,
    'never opened: ready, not back to you',
  );
  assert.deepEqual(
    [card('pr:acme/widgets#16').building?.kind, card('pr:acme/widgets#16').building?.by],
    ['rebuild', 'session-b'],
  );
  assert.equal(card('pr:acme/widgets#16').detail, 'rebuilding story');
  assert.equal(card('pr:acme/widgets#18').building?.kind, 'fix');
  assert.equal(card('pr:acme/widgets#16').story, null);
  assert.equal(card('pr:acme/widgets#19').pr?.review_requested, true);
  assert.equal(card('pr:acme/widgets#19').story, null);
  assert.equal(
    card('pr:acme/widgets#20'),
    undefined,
    'someone else’s draft is not on the board, review request or not',
  );
  assert.equal(
    card('pr:acme/widgets#23'),
    undefined,
    'someone else’s draft is not on the board even with a story built for you',
  );
  assert.equal(card('pr:acme/widgets#14').pr?.mine, false);
  // a finished agent sits in Done (finished or stopped) or Error (failed) for 30 minutes after its last event
  // (finished-agents.test.ts has the timing), then has no card, not even in the Idle lane
  assert.equal(card(`agent:${sid(onStory)}:nested-old`), undefined, 'hours ago');
  assert.equal(card(`agent:${sid(onStory)}:nested-done`).column, 'done');
  assert.equal(card('agent:deadbeef:stopped-one').column, 'done');
  assert.equal(card('agent:deadbeef:broke').column, 'error');
  // sessions on a branch whose PR merged are not lumped into one card named for it: one card each, by session title
  assert.equal(card(fullId(staleOne.pid)).kind, 'session');
  assert.equal(card(fullId(staleOne.pid)).title, 'stale-one');
  assert.equal(card(fullId(staleTwo.pid)).title, 'stale-two');
  assert.equal(card(fullId(staleOne.pid)).branch, 'old/merged');
  assert.equal(cards.filter((found) => found.branch === 'old/merged').length, 2);
  // an agent's lane with no registered repo: its parent's (no tag, no task text is read)
  assert.equal(card(`agent:${sid(onStory)}:wt-agent`).lane, 'acme/widgets');
  assert.equal(card(`agent:${sid(onStory)}:crosscut-note`).lane, 'acme/widgets');
  assert.equal(card(`agent:${sid(onMain)}:needs-answer`).lane, 'acme/gadgets');
  assert.equal(card('agent:deadbeef:orphan').lane, 'No live session');
  assert.equal(card(`agent:${sid(onStory)}:wt-agent`).parent, 'story-one');
  assert.deepEqual(
    data.lanes.map((lane) => lane.name).filter((name) => !name.startsWith('once-upon-')),
    ['gadgets', 'No live session', 'widgets'],
  );
  assert.equal(card('pr:acme/widgets#9').lane, 'acme/widgets');

  const working = card('pr:acme/widgets#7');
  assert.equal(working.kind, 'work');
  assert.equal(working.title, 'Seven on GitHub');
  assert.equal(working.branch, 'feat/x');
  assert.deepEqual(
    working.sessions.map((session) => [session.title, session.status]),
    [
      ['story-one', 'working'],
      ['story-two', 'idle'],
    ],
  );
  assert.deepEqual(
    working.agents.map((agent) => [agent.name, agent.status]),
    [],
    'a card’s agents are the runs that name it; a branch or PR on a cardless run is no link',
  );
  assert.equal(
    card(`agent:${sid(onStory)}:nested-one`).agents[0]?.model,
    'sonnet',
    'the board shows the model alone, not "sonnet, low"',
  );
  assert.deepEqual(card(`agent:${sid(onStory)}:nested-one`).agents[0]?.beat ?? null, {
    n: 3,
    of: 6,
    step: 'code',
    note: 'writing',
  });
  assert.deepEqual(working.pr, seven);
  assert.deepEqual(working.story?.reviewed, false);

  const asking = card('pr:acme/widgets#9');
  assert.equal(asking.story, null);
  assert.equal(asking.detail, 'asked you a question');
  assert.equal(asking.sessions[0].title, 'branch-one');
  assert.equal(asking.pr?.checks, 'pending');

  const ready = card('pr:acme/widgets#8');
  assert.equal(ready.title, 'PR 8');
  assert.equal(ready.story?.reviewed, false);
  assert.equal(ready.sessions.length, 0);
  assert.equal(ready.column, 'pr_open');

  assert.equal(card('pr:acme/widgets#12').since, hoursAgo(0.5));
  assert.equal(card('pr:acme/widgets#12').story, null);

  const main = card(fullId(onMain.pid));
  assert.equal(main.kind, 'session');
  assert.equal(main.branch, 'main');
  assert.equal(main.lane, 'acme/gadgets');
  assert.equal(main.agents.length, 0, 'a session card has its agents as cards of their own');
  const needsAnswer = card(`agent:${sid(onMain)}:needs-answer`);
  assert.equal(needsAnswer.detail, 'needs Eric: pick A or B');
  assert.equal(needsAnswer.parent, 'main-one');
  assert.equal(card(fullId(loose.pid)).detail, 'compiling');
  assert.equal(card(`agent:${sid(onStory)}:tagged-one`).parent, 'story-one');
  assert.equal(card(`agent:${sid(onStory)}:tagged-one`).lane, 'acme/widgets');

  // GitHub was asked in the background for what the board needs
  assert.deepEqual([...new Set(asked.branches)].sort(), [
    'acme/widgets@feat/y',
    'acme/widgets@old/merged',
  ]);
  assert.ok(
    asked.checkouts.length && asked.checkouts.every((dir) => path.isAbsolute(dir)),
    'a branch ask names the session’s checkout, where a merged PR’s head commit is looked for',
  );
  assert.ok(asked.infos.includes(9) && asked.infos.includes(8));
  assert.ok(asked.stories.includes('acme-widgets-7'));
  assert.ok(!asked.stories.includes('acme-widgets-12'), 'a merged story is not asked about again');

  // answers are kept for a moment, and `since` stays while the status does
  const since = working.sessions[0].since;
  const later = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => new Date(NOW.getTime() + 60000),
  });
  assert.ok(await later.snapshot());
  assert.equal(since, working.sessions[0].since);
});

test('a status change moves `since` to when the board saw it', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  registry(sessions, process.pid, { status: 'busy' }, procStartOf(process.pid));
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  let clock = NOW;
  let state: 'working' | 'waiting' = 'working';
  const source: StatusSource = {
    name: 'registry',
    statuses: async (live) =>
      new Map(live.map((session) => [session.session, { status: state, detail: null, tab: true }])),
  };
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source,
    now: () => clock,
  });
  const first = (await board.snapshot()).lanes[0].cards[0];
  assert.equal(first.column, 'thinking', 'busy, no run open');
  assert.equal(
    first.sessions[0].since,
    new Date(NOW.getTime() - 600000).toISOString(),
    'first sight: the registry’s time',
  );
  clock = new Date(NOW.getTime() + 5000);
  state = 'waiting';
  const second = (await board.snapshot()).lanes[0].cards[0];
  assert.equal(second.column, 'waiting');
  assert.equal(second.since, clock.toISOString());
});

test('the board settings: the ledger and progress files are off until set, and the settings read as documented', () => {
  const home = tmp('board-settings');
  const unset = readSettings(home).board;
  assert.equal(unset.ledgerFile, null);
  assert.equal(unset.progressFile, null);
  assert.equal(unset.doneHours, 1);
  assert.match(unset.sessionsDir, /sessions$/);
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: '~/notes/ledger.md',
    board_done_hours: 8,
    board_sessions_dir: '/x/sessions',
  });
  const set = readSettings(home).board;
  assert.match(set.ledgerFile as string, /\/notes\/ledger\.md$/);
  assert.ok(!(set.ledgerFile as string).startsWith('~'));
  assert.equal(set.doneHours, 8);
  assert.equal(set.sessionsDir, '/x/sessions');
});

test('iTerm tabs: a session is matched to its tab by tty, and nothing asks a tab for its status', async () => {
  const dir = tmp('board-it2');
  const it2 = path.join(dir, 'it2');
  const calls = path.join(dir, 'calls.log');
  writeFileSync(
    it2,
    `#!/bin/sh
echo "$@" >> '${calls}'
if [ "$2" = list ]; then
  echo '[{"id":"TAB-1","name":"Claude Code","tty":"\\\\/dev\\\\/ttys042"},{"id":"TAB-2","name":"Real title","tty":"\\\\/dev\\\\/ttys043"}]'
else
  echo '{"status":"waiting","detail":"needs you","background_tasks":2}'
fi
`,
  );
  chmodSync(it2, 0o755);
  const live = (tty: string | null, session: string) => ({
    pid: 1,
    session,
    cwd: '/x',
    name: null,
    tty,
    status: 'idle',
    statusAt: null,
    startedAt: null,
  });
  const found = await itermTabs(it2, [
    live('ttys043', 's-two'),
    live(null, 's-none'),
    live('ttys999', 's-missing'),
  ]);
  assert.deepEqual([...found], ['s-two']);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['session list --json']);
  assert.equal(findIt2(it2), it2);
  assert.equal(
    findIt2(path.join(dir, 'nope')) === null || typeof findIt2(path.join(dir, 'nope')) === 'string',
    true,
  );
  // the source is the registry with the hook, whether or not it2 is there
  assert.equal(pickSource(it2, dir).source.name, 'registry');
  assert.equal(pickSource(null, dir).source.name, 'registry');
});

test('the registry source shows the status hook’s Waiting and falls back to busy or idle with no file', async () => {
  const home = tmp('board-hook-source');
  const live = {
    pid: 1,
    session: 'hook-sess-1',
    cwd: '/x',
    name: null,
    tty: null,
    status: 'busy',
    statusAt: Date.now() - 60_000,
    startedAt: null,
  };
  const source = pickSource(null, home).source;
  assert.equal((await source.statuses([live])).size, 0, 'no file: the board uses busy or idle');
  writeJson(path.join(home, 'status', 'hook-sess-1.json'), {
    session_id: 'hook-sess-1',
    at: Date.now(),
    state: 'waiting',
    detail: 'Ship it?',
    event: 'Stop',
  });
  assert.equal((await source.statuses([live])).get('hook-sess-1')?.status, 'waiting');
});

test('the status hook’s waiting file puts a busy session in Waiting with no source set; with none it is Thinking', async () => {
  const home = tmp('board-hook-home');
  const sessions = tmp('board-hook-sessions');
  registry(sessions, process.pid, { status: 'busy' }, procStartOf(process.pid));
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const board = () =>
    new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), { now: () => NOW });
  assert.equal((await board().snapshot()).lanes[0].cards[0].column, 'thinking', 'no hook file');
  const id = fullId(process.pid);
  const file = path.join(home, 'status', `${id}.json`);
  writeJson(file, { session_id: id, at: NOW.getTime(), state: 'waiting', detail: 'Ship it?' });
  const waiting = (await board().snapshot()).lanes[0].cards[0];
  assert.equal(waiting.column, 'waiting');
  assert.equal(waiting.sessions[0].detail, 'Ship it?');
  assert.equal(waiting.sessions[0].source, 'registry');
});

const TAB_SESSION = {
  pid: 1,
  session: 'tab-sess-1',
  cwd: '/x',
  name: null,
  tty: 'ttys042',
  status: 'idle',
  statusAt: Date.now() - 60_000,
  startedAt: null,
};

/** An it2 stand-in with one tab, on ttys042, that logs each call to `calls` and, asked for a status, says `waiting`. */
function fakeIt2(dir: string, calls: string): string {
  const it2 = path.join(dir, 'it2');
  writeFileSync(
    it2,
    `#!/bin/sh
echo "$@" >> '${calls}'
if [ "$2" = list ]; then
  echo '[{"id":"TAB-1","name":"Tab title","tty":"\\/dev\\/ttys042"}]'
else
  echo '{"status":"waiting","detail":"tab says so","background_tasks":3}'
fi
`,
  );
  chmodSync(it2, 0o755);
  return it2;
}

test('session status comes only from the registry and the status hook: with it2 found, it is asked for tabs and never for a status', async () => {
  const home = tmp('board-hook-iterm-home');
  const dir = tmp('board-hook-iterm');
  const calls = path.join(dir, 'calls.log');
  const it2 = fakeIt2(dir, calls);
  const source = pickSource(it2, home).source;
  const bare = (await source.statuses([TAB_SESSION])).get('tab-sess-1');
  assert.deepEqual(
    [bare?.status, bare?.detail, bare?.tab],
    ['idle', null, true],
    'no hook file: the registry’s idle, whatever the tab would say; the tab only makes it reachable',
  );
  const file = path.join(home, 'status', 'tab-sess-1.json');
  writeJson(file, { session_id: 'tab-sess-1', at: Date.now(), state: 'done', detail: null });
  const hooked = (await source.statuses([TAB_SESSION])).get('tab-sess-1');
  assert.deepEqual(
    [hooked?.status, hooked?.tab],
    ['done', true],
    'the hook says done where it wrote',
  );
  writeJson(file, { session_id: 'tab-sess-1', at: Date.now(), state: 'working', detail: null });
  assert.equal(
    (await source.statuses([TAB_SESSION])).get('tab-sess-1')?.status,
    'idle',
    'a file that says working is the registry’s word',
  );
  // no it2: the hook alone, and no tab
  assert.equal((await pickSource(null, home).source.statuses([TAB_SESSION])).size, 0);
  const asked = readFileSync(calls, 'utf8').trim().split('\n');
  assert.ok(
    asked.length > 0 && asked.every((line) => line === 'session list --json'),
    asked.join('; '),
  );
});

test('the board warns until a status file exists, pointing to the hook', () => {
  const home = tmp('board-hook-notice');
  assert.match(pickSource(null, home).warning ?? '', /board-status\.sh/);
  writeJson(path.join(home, 'status', 'some-sess.json'), { state: 'done' });
  assert.equal(pickSource(null, home).warning, null);
});

test('Open in iTerm is offered only for sessions whose tab the source knows', async () => {
  const home = tmp('board-focus-home');
  const sessions = tmp('board-focus-sessions');
  registry(sessions, process.pid, { status: 'idle' }, procStartOf(process.pid));
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const id = fullId(process.pid);
  const focus = async (tab: boolean) => {
    const source: StatusSource = {
      name: 'registry',
      statuses: async () =>
        new Map([[id, { status: 'idle', detail: null, ...(tab ? { tab } : {}) }]]),
    };
    const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source,
      now: () => NOW,
    });
    return (await board.snapshot()).lanes[0].cards[0].sessions[0].focus;
  };
  assert.equal(await focus(true), true);
  assert.equal(await focus(false), false, 'a session in another terminal has no tab to raise');
});

test('the board: someone else’s draft comes onto the board once it is marked ready, and goes off again as a draft', async () => {
  const home = tmp('board-draft-home');
  const quiet = tmp('board-draft-quiet');
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: path.join(quiet, 'ledger.md'),
    board_progress_file: path.join(quiet, 'progress.md'),
    board_sessions_dir: quiet,
  });
  prStory(home, 'acme-widgets-30', 'acme/widgets', 30, 'feat/their-draft');
  const infos = [
    prInfo(30, { author: 'someone', mine: false, review_requested: true, draft: true }),
  ];
  const { watcher } = fakeWatcher(infos, {}, [{ repo: 'acme/widgets', number: 30 }]);
  // each look is an hour on, past the board's kept answer
  let clock = NOW.getTime();
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => new Date(clock),
  });
  const columnOfPr = async () =>
    (clock += 3600000) &&
    (await board.snapshot()).lanes
      .flatMap((lane) => lane.cards)
      .find((found) => found.id === 'pr:acme/widgets#30')?.column;
  assert.equal(await columnOfPr(), undefined, 'a draft with a story: not on the board');
  infos[0] = { ...infos[0], draft: false };
  assert.equal(await columnOfPr(), 'back', 'marked ready: GitHub is waiting on your review');
  infos[0] = { ...infos[0], draft: true };
  assert.equal(await columnOfPr(), undefined, 'converted back to a draft: gone again');
});

test('snapshot is single-flight: callers during a build share it, and the cache fills when it finishes', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
  });
  let started = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const source: StatusSource = {
    name: 'registry',
    statuses: async () => {
      started += 1;
      await gate;
      return new Map();
    },
  };
  let clock = NOW.getTime();
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source,
    now: () => new Date(clock),
  });
  // a poll slower than the 3 s interval: later callers, even after the cache time has passed, join the build
  const first = board.snapshot();
  clock += 3000;
  const second = board.snapshot();
  clock += 3000;
  const third = board.snapshot();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started, 1, 'one build for all three');
  release();
  const [one, two, three] = await Promise.all([first, second, third]);
  assert.equal(two, one);
  assert.equal(three, one);
  assert.equal(started, 1);
  // the cache was set when the build finished, stamped with the time the build began
  clock = NOW.getTime() + 1000;
  assert.equal(await board.snapshot(), one, 'within the cache time of the build that began');
  clock = NOW.getTime() + 2500;
  assert.notEqual(await board.snapshot(), one, 'past it, a new build');
  assert.equal(started, 2);
});

test('a session’s repo is looked up without holding the snapshot: it goes on, and a later snapshot has it', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
  });
  const child = liveChild();
  after(() => child.stop());
  const folder = tmp('hung-mount');
  registry(sessions, child.pid, { cwd: folder, name: 'plain' }, child.procStart);
  let answer: (repo: string | null) => void = () => {};
  let pending: Promise<string | null> | null = null;
  const asked: string[] = [];
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf: (cwd) => {
      asked.push(cwd);
      pending ??= new Promise((resolve) => (answer = resolve));
      return pending;
    },
  });
  const began = Date.now();
  const lanes = (await board.snapshot()).lanes;
  assert.ok(Date.now() - began < 3000, 'did not wait for the lookup to finish');
  assert.deepEqual(asked, [folder]);
  assert.equal(lanes[0].cards[0].repo, null);
  assert.equal(lanes[0].cards[0].lane, path.basename(folder), 'the folder’s name for now');
  answer('acme/widgets');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const found = (await board.snapshot()).lanes[0].cards[0];
  assert.equal(found.repo, 'acme/widgets', 'the next snapshot has it, not the kept one');
  assert.equal(found.lane, 'acme/widgets');
});

test('a busy session that registered a run of its own and has none open is Thinking; a plain busy one is Working', () => {
  const none = { agents: [], pr: null, story: null };
  assert.equal(
    columnOf({ ...none, sessions: [{ status: 'working', thinking: true }] }),
    'thinking',
  );
  assert.equal(columnOf({ ...none, sessions: [{ status: 'working' }] }), 'working');
  // asking is still Waiting, and an idle registered session is idle
  assert.equal(columnOf({ ...none, sessions: [{ status: 'waiting', thinking: true }] }), 'waiting');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'idle' }] }), 'idle');
});
