import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp, writeJson } from './helpers.ts';
import path from 'node:path';
import { readSettings } from '../src/services/config/settings.ts';
import { finishedColumn, homeOf } from '../src/services/board/agent-home.ts';
import { NO_PARENT, placeAgents } from '../src/services/board/stages/agents.ts';
import { columnOf } from '../src/services/board/columns.ts';
import { worktreeSection } from '../src/services/board/stages/worktrees.ts';
import { markFinished, readFinished } from '../src/adapters/stores/finished-agents.ts';
import type { WorktreeFacts, WorktreeScanner } from '../src/services/worktrees/worktrees.ts';
import type { PrWatcher } from '../src/services/board/stages/pr-watcher.ts';
import { backlogCards } from '../src/services/backlog/backlog.ts';
import type { BacklogItem } from '../src/services/backlog/types.ts';
import { nestClaimedAgents } from '../src/services/board/stages/backlog.ts';
import type { BuildContext } from '../src/services/board/stages/types.ts';
import type { LedgerAgent } from '../src/services/ledger/ledger.ts';
import type { BoardAgent, BoardCard } from '@once-upon-a-diff/contracts/types';

const NOW = Date.parse('2026-11-03T15:30:00Z');
const ctx = () =>
  ({
    home: tmp('placement-home'),
    now: new Date(NOW),
    nowMs: NOW,
    settings: { finishedWaitMinutes: 30, doneHours: 4 },
  }) as unknown as BuildContext;

/** A work card (or a session card, with `kind`), as far as placement reads it. */
const card = (over: Partial<BoardCard>): BoardCard =>
  ({
    id: `c:${over.repo}:${over.branch}`,
    kind: 'work',
    title: 'card',
    repo: 'acme/widgets',
    branch: null,
    lane: over.repo ?? 'x',
    pr: null,
    sessions: [],
    agents: [],
    ...over,
  }) as unknown as BoardCard;

/** A ledger agent (no registered fields), or a registered one with `source: 'events'` and fields. */
const agent = (over: Partial<LedgerAgent> = {}): LedgerAgent => ({
  sid: 'aaaaaaaa',
  name: 'helper',
  state: 'running',
  lane: null,
  model: null,
  task: null,
  started: new Date(NOW - 600000),
  ended: null,
  outcome: null,
  ...over,
});
const registered = (over: Partial<LedgerAgent> = {}): LedgerAgent =>
  agent({ source: 'events', kind: 'author', ...over });

const place = (agents: LedgerAgent[], cards: BoardCard[], items: BacklogItem[] = []) =>
  placeAgents(ctx(), cards, { agents, beats: new Map(), pin: null, items });
const nestedIn = (target: BoardCard) => target.agents.map((one) => one.name);

const makeX = () => card({ branch: 'feat/x', pr: { number: 7 } as BoardCard['pr'] });
const makeY = () => card({ branch: 'feat/y', pr: { number: 8 } as BoardCard['pr'] });

test('a ledger agent whose task names a card’s branch and PR is not nested there: gated or tied to its parent, it is a card of its own', () => {
  const featX = makeX();
  const featY = makeY();
  // the launching session is on feat/x, and the task says feat/x and PR #7: text used to tie it
  const parent = card({
    kind: 'session',
    repo: 'acme/widgets',
    branch: 'feat/x',
    sessions: [{ id: 'aaaaaaaa-1111' } as BoardCard['sessions'][number]],
  });
  for (const state of ['running', 'plan', 'fixing'] as const) {
    const cards = [featX, featY, parent];
    const added = place(
      [agent({ name: `ou-${state}`, state, task: 'check feat/x, PR #7' })],
      cards,
    );
    assert.deepEqual(nestedIn(featX), [], state);
    assert.equal(added.length, 1, `${state} is a card of its own`);
    assert.equal(added[0].lane, 'acme/widgets', `${state} sits on its parent session's lane`);
  }
  const review = place(
    [agent({ name: 'ou-rev', state: 'waiting', review: true, task: 'story for PR #7' })],
    [featX],
  );
  assert.deepEqual(nestedIn(featX), []);
  assert.equal(review.length, 1);
  assert.equal(review[0].column, 'ready');
  const reviewer = place([agent({ name: 'review-x', task: 'review of feat/x' })], [featX]);
  assert.deepEqual(nestedIn(featX), []);
  assert.equal(reviewer.length, 1);
});

test('a registered agent is nested by its repo and branch or PR, and what its task says is ignored', () => {
  const featX = makeX();
  const featY = makeY();
  const cards = [featX, featY];
  // gated (plan), task naming feat/x, registered on feat/y
  const byBranch = registered({
    name: 'ou-plan',
    state: 'plan',
    task: 'plan check for feat/x, PR #7',
    repo: 'acme/widgets',
    branch: 'feat/y',
  });
  // a reviewer (kind), task naming feat/y, registered on PR 7
  const byPr = registered({
    name: 'rv-seven',
    kind: 'critic',
    task: 'review feat/y',
    repo: 'acme/widgets',
    pr: 7,
  });
  assert.deepEqual(place([byBranch, byPr], cards), [], 'both nested, no card of their own');
  assert.deepEqual(nestedIn(featY), ['ou-plan']);
  assert.deepEqual(nestedIn(featX), ['rv-seven']);
});

test('a registered agent whose card is a started backlog item is nested on that item’s branch, with no repo of its own', () => {
  const featX = makeX();
  const featY = makeY();
  const item = { id: 'bl_aaaaaa111111', repo: 'acme/widgets', branch: 'feat/y' };
  const cards = [featX, featY];
  const added = place(
    [registered({ name: 'ou-by-card', task: 'work on feat/x', card: 'bl_aaaaaa111111' })],
    cards,
    [item as BacklogItem],
  );
  assert.deepEqual(added, []);
  assert.deepEqual(nestedIn(featY), ['ou-by-card']);
  assert.deepEqual(nestedIn(featX), []);
  // an item with no branch, or one the board doesn't have, gives no home
  assert.equal(
    homeOf(registered({ card: 'bl_aaaaaa111111' }), cards, [{ ...item, branch: null }]),
    null,
  );
  assert.equal(homeOf(registered({ card: 'bl_missing' }), cards, [item]), null);
});

test('a finished research agent on a registered branch is nested in its card, not in a Research card of its own', () => {
  const featX = makeX();
  const added = place(
    [
      registered({
        kind: 'research',
        state: 'done',
        repo: 'acme/widgets',
        branch: 'feat/x',
        ended: new Date(NOW - 60000),
      }),
    ],
    [featX],
  );
  assert.equal(added.length, 0);
  assert.equal(featX.agents.length, 1);
  assert.equal(featX.agents[0].kind, 'research');
});

test('a finished builder is nested by the branch or PR its finish event reports', () => {
  const featX = makeX();
  const featY = makeY();
  const home = homeOf(
    registered({ repo: 'acme/widgets', state: 'done', result: { branch: 'feat/y' } }),
    [featX, featY],
    [],
  );
  assert.equal(home, featY);
  assert.equal(
    homeOf(
      registered({ repo: 'acme/widgets', state: 'done', result: { pr: 7 } }),
      [featX, featY],
      [],
    ),
    featX,
  );
  // the branch it ended on wins over the one it began with
  assert.equal(
    homeOf(
      registered({ repo: 'acme/widgets', branch: 'feat/x', result: { branch: 'feat/y' } }),
      [featX, featY],
      [],
    ),
    featY,
  );
});

test('the same branch in two repos: the registered repo decides; no repo, an unknown repo, or two cards named is no home', () => {
  const featX = makeX();
  const featY = makeY();
  const gadgets = card({
    repo: 'acme/gadgets',
    branch: 'feat/x',
    pr: { number: 3 } as BoardCard['pr'],
  });
  const cards = [featX, gadgets];
  assert.equal(homeOf(registered({ repo: 'acme/gadgets', branch: 'feat/x' }), cards, []), gadgets);
  assert.equal(homeOf(registered({ repo: 'Acme/Widgets', branch: 'feat/x' }), cards, []), featX);
  assert.equal(homeOf(registered({ branch: 'feat/x' }), cards, []), null, 'no repo');
  assert.equal(homeOf(registered({ repo: 'acme/other', branch: 'feat/x' }), cards, []), null);
  assert.equal(
    homeOf(registered({ repo: 'acme/widgets', branch: 'FEAT/X' }), cards, []),
    null,
    'exact branch',
  );
  assert.equal(
    homeOf(registered({ repo: 'acme/widgets', branch: 'feat/x', pr: 8 }), [featX, featY], []),
    null,
    'the branch says one card and the PR another',
  );
  const sessionOnly = card({ kind: 'session', repo: 'acme/widgets', branch: 'feat/z' });
  assert.equal(
    homeOf(registered({ repo: 'acme/widgets', branch: 'feat/z' }), [sessionOnly], []),
    sessionOnly,
  );
  assert.equal(homeOf(registered({ repo: 'acme/widgets', pr: 7 }), [sessionOnly], []), null);
  assert.equal(
    homeOf(registered({ repo: 'acme/widgets' }), [sessionOnly], []),
    null,
    'no branch, no PR, no card',
  );
});

test('an agent’s lane is its tag, else its registered repo’s lane, else its launching session’s: never its task', () => {
  const parentCard = card({
    kind: 'session',
    repo: 'acme/parent',
    branch: null,
    lane: 'acme/parent',
    sessions: [{ id: 'aaaaaaaa-1111' } as BoardCard['sessions'][number]],
  });
  const other = card({ repo: 'acme/widgets', branch: 'feat/x', lane: 'acme/widgets' });
  const cards = [parentCard, other];
  const lane = (over: Partial<LedgerAgent>, sid = 'aaaaaaaa') =>
    place(
      [agent({ sid, name: 'a', task: 'widgets-worktrees/x for widgets and larmor', ...over })],
      cards,
    )[0].lane;
  assert.equal(lane({ lane: 'tagged' }), 'tagged');
  assert.equal(
    lane({ lane: 'widgets' }),
    'acme/widgets',
    'a short tag stands for the one known repo',
  );
  assert.equal(lane({ lane: 'Acme/Widgets' }), 'acme/widgets', 'a whole key, any case');
  assert.equal(
    lane({ source: 'events', repo: 'acme/larmor', cwd: '/x/larmor-worktrees/y' }),
    'acme/larmor',
  );
  assert.equal(lane({ source: 'events', repo: 'acme/larmor', lane: 'tagged' }), 'tagged');
  assert.equal(lane({}), 'acme/parent', 'the task names widgets and a worktree, and is ignored');
  assert.equal(lane({ source: 'events', cwd: '/x/y' }), 'acme/parent', 'a cwd alone is not a lane');
  assert.equal(lane({}, 'deadbeef'), NO_PARENT);
  assert.equal(lane({ source: 'events' }, 'deadbeef'), NO_PARENT);
});

const started = (id: string, branch: string): BacklogItem =>
  ({
    id,
    title: 't',
    repo: 'acme/widgets',
    branch,
    state: 'started',
    claim: null,
    landed_at: null,
  }) as unknown as BacklogItem;
const view = (sid: string, name: string): BoardAgent =>
  ({ key: `${sid}:${name}`, name, state: 'running' }) as unknown as BoardAgent;

test('two agents of one name in different sessions are two agents on a card, and one agent is still listed once', () => {
  const item = started('bl_bbbbbb222222', 'feat/x');
  const target = card({ branch: 'feat/x', agents: [view('bbbbbbbb', 'ou-x')] });
  // the claimed agent of the same name, from another session
  nestClaimedAgents([item], [target], new Map([[item.id, view('aaaaaaaa', 'ou-x')]]));
  assert.deepEqual(
    target.agents.map((one) => one.key),
    ['bbbbbbbb:ou-x', 'aaaaaaaa:ou-x'],
  );
  nestClaimedAgents([item], [target], new Map([[item.id, view('aaaaaaaa', 'ou-x')]]));
  assert.equal(target.agents.length, 2, 'the same agent is not listed twice');

  // the Backlog column's own nesting (backlogCards) says the same
  const other = card({ branch: 'feat/x', agents: [view('bbbbbbbb', 'ou-x')] });
  backlogCards([item], [other], NOW, [], new Map(), new Map([[item.id, view('aaaaaaaa', 'ou-x')]]));
  assert.equal(other.agents.length, 2);
  // a view with no key is nobody's twin
  const keyless = card({ branch: 'feat/x', agents: [{ name: 'ou-x' } as BoardAgent] });
  nestClaimedAgents([item], [keyless], new Map([[item.id, { name: 'ou-x' } as BoardAgent]]));
  assert.equal(keyless.agents.length, 2);
});

test('a finished ledger agent is Done by its [done] line, not by a worktrees folder in its task or by its outcome', () => {
  assert.equal(finishedColumn({ name: 'a', state: 'done' }), 'done');
  assert.equal(
    finishedColumn({ name: 'a', state: 'stopped' }),
    'waiting',
    'a worktrees task is not output',
  );
  assert.equal(finishedColumn({ name: 'a', state: 'waiting' }), 'waiting');
});

test('a finished agent stays inside its card for an hour by default, never less than the finished wait', () => {
  const home = tmp('placement-done-hour');
  const finished = (minutesAgo: number) =>
    registered({
      name: 'ou-done',
      state: 'done',
      outcome: 'committed abc1234',
      repo: 'acme/widgets',
      branch: 'feat/x',
      ended: new Date(NOW - minutesAgo * 60000),
    });
  const nestedAfter = (settings: BuildContext['settings'], minutesAgo: number) => {
    const featX = makeX();
    placeAgents({ ...ctx(), home, settings } as unknown as BuildContext, [featX], {
      agents: [finished(minutesAgo)],
      beats: new Map(),
      pin: null,
    });
    return nestedIn(featX);
  };
  const defaults = readSettings(home).board;
  assert.equal(defaults.doneHours, 1);
  assert.deepEqual(nestedAfter(defaults, 30), ['ou-done'], 'finished 30 minutes ago: shown');
  assert.deepEqual(nestedAfter(defaults, 120), [], 'finished 2 hours ago: gone');
  // the finished wait is a floor: a long wait keeps it past the hour
  assert.deepEqual(nestedAfter({ ...defaults, finishedWaitMinutes: 180 }, 120), ['ou-done']);
  // the setting still overrides the default
  writeJson(path.join(home, 'config.json'), { board_done_hours: 4 });
  assert.deepEqual(nestedAfter(readSettings(home).board, 120), ['ou-done']);
});

test('a --card home is a started or open item: a dropped or landed one is not a home', () => {
  const featY = makeY();
  const item = { id: 'bl_aaaaaa111111', repo: 'acme/widgets', branch: 'feat/y' };
  const homeFor = (over: Partial<BacklogItem>) =>
    homeOf(registered({ card: item.id }), [featY], [{ ...item, ...over } as BacklogItem]);
  assert.equal(homeFor({ state: 'started', landed_at: null }), featY);
  assert.equal(homeFor({ state: 'open', landed_at: null }), featY);
  assert.equal(homeFor({ state: 'dropped', landed_at: null }), null, 'dropped');
  assert.equal(homeFor({ state: 'started', landed_at: '2026-11-03T12:00:00Z' }), null, 'landed');
  // a PR merged on GitHub leaves the item started with no landed_at, so the card's own PR says so
  const merged = card({ branch: 'feat/y', pr: { number: 8, state: 'merged' } as BoardCard['pr'] });
  assert.equal(
    homeOf(registered({ card: item.id }), [merged], [{ ...item, state: 'started' } as BacklogItem]),
    null,
    'its PR merged',
  );
});

test('Finish clears a finished agent nested in a card, and a new line brings it back', () => {
  const home = tmp('placement-finish-nested');
  const finished = registered({
    name: 'ou-done',
    state: 'done',
    repo: 'acme/widgets',
    branch: 'feat/x',
    ended: new Date(NOW - 5 * 60000),
  });
  const run = (agents: LedgerAgent[]) => {
    const featX = makeX();
    placeAgents({ ...ctx(), home } as unknown as BuildContext, [featX], {
      agents,
      beats: new Map(),
      pin: null,
    });
    return nestedIn(featX);
  };
  assert.deepEqual(run([finished]), ['ou-done']);
  markFinished(home, 'aaaaaaaa:ou-done', NOW - 60000);
  assert.deepEqual(run([finished]), [], 'cleared by Finish');
  assert.deepEqual(
    run([{ ...finished, ended: new Date(NOW - 30000) }]),
    ['ou-done'],
    'it did something more after the click',
  );
});

test('a failed agent nested in a card puts the card in Waiting, not Error or Idle, and stays a line on it', () => {
  const sessionCard = card({
    kind: 'session',
    repo: 'acme/widgets',
    branch: 'feat/z',
    sessions: [{ id: 'cccccccc-1', status: 'idle' } as BoardCard['sessions'][number]],
  });
  placeAgents(ctx(), [sessionCard], {
    agents: [
      registered({
        name: 'ou-broke',
        state: 'failed',
        repo: 'acme/widgets',
        branch: 'feat/z',
        ended: new Date(NOW - 60000),
      }),
    ],
    beats: new Map(),
    pin: null,
  });
  assert.deepEqual(nestedIn(sessionCard), ['ou-broke']);
  const columnWith = (pr: BoardCard['pr'], agents: BoardCard['agents']) =>
    columnOf({ sessions: sessionCard.sessions, agents, pr, story: null, building: false });
  assert.equal(columnWith(null, sessionCard.agents), 'waiting');
  assert.equal(
    columnWith({ state: 'merged' } as BoardCard['pr'], sessionCard.agents),
    'done',
    'a merged card stays Done',
  );
});

/** A worktree the scanner has, on feat/x, which something is working in. */
const facts = (dir: string) =>
  ({
    path: dir,
    main: dir,
    mainBranch: 'main',
    repo: 'acme/widgets',
    branch: 'feat/x',
    head: 'abc',
    detached: false,
    locked: false,
    lastCommitMs: NOW,
    created: NOW,
    unmoved: false,
    modified: 0,
    untracked: 0,
    statusHead: 'abc',
    statusAt: NOW,
    unpushed: 0,
    sizeKb: 1,
    sizeAt: NOW,
    defaultBranch: 'main',
    merged: false,
    superseded: false,
    onRemote: false,
    reachable: true,
    ignored: [],
  }) as WorktreeFacts;

test('a worktree goes on the card of the agent holding it by key, not by name; agent task text finds none', () => {
  const dir = tmp('placement-worktree');
  const kicked: string[] = [];
  const scanner = {
    kick: (seeds: string[]) => kicked.push(...seeds),
    read: () => ({ items: [facts(dir)], scanning: false, finished: NOW, prunable: [] }),
  } as unknown as WorktreeScanner;
  const review = { kickBranch: () => {}, branchPr: () => undefined } as unknown as PrWatcher;
  // two agents of one name, started at the same time, in two sessions; only the second works in the worktree
  const same = { name: 'ou-x', started: new Date(NOW - 600000), state: 'running' as const };
  const other = registered({ ...same, sid: 'aaaaaaaa', task: `look at ${dir}` });
  const holder = registered({ ...same, sid: 'bbbbbbbb', cwd: dir });
  const onCard = (agent: LedgerAgent): BoardCard =>
    card({
      repo: 'acme/other',
      branch: `b-${agent.sid}`,
      agents: [{ ...view(agent.sid, agent.name), started_at: agent.started?.toISOString() }],
    } as Partial<BoardCard>);
  const cards = [onCard(other), onCard(holder)];
  worktreeSection({
    scanner,
    home: tmp('placement-worktree-home'),
    review,
    cards,
    live: [],
    sessionViews: new Map(),
    agents: [other, holder],
    keepBranches: [],
    nowMs: NOW,
  });
  assert.equal(cards[0].worktrees, undefined, 'the same-named agent of another session');
  assert.equal(cards[1].worktrees?.length, 1);
  assert.deepEqual(
    kicked.filter((seed) => seed === dir),
    [dir],
    'the holder’s registered cwd is a place to look, once',
  );
});

test('a done author with no result whose registered card has landed is Done, with what it did and why on its card', () => {
  const ended = new Date(NOW - 5 * 60000);
  const author = registered({
    name: 'ou-rename',
    state: 'done',
    task: 'card bl_aaaaaa111111 rename builders; plan stop',
    card: 'bl_aaaaaa111111',
    result: null,
    started: new Date(NOW - 3600000),
    ended,
    lastEvent: ended,
    outcome: 'landed at fc59563 (closed 11/4 by sid 989b3246)',
  });
  assert.equal(finishedColumn(author, true), 'done');
  assert.equal(finishedColumn(author, false), 'waiting', 'not landed: an author that made nothing');
  assert.equal(finishedColumn({ ...author, state: 'stopped' }, true), 'waiting', 'a stopped run');
  const item = {
    id: 'bl_aaaaaa111111',
    title: 'Rename builders to authors',
    repo: 'acme/widgets',
    branch: 'rename',
    state: 'done',
    landed_at: '2026-11-03T15:20:00Z',
    landed_sha: 'fc5956306d994c30c0a7d34578e216c73294d275',
  } as unknown as BacklogItem;
  const [own] = place([author], [], [item]);
  assert.equal(own.column, 'done');
  assert.deepEqual(own.agents[0].summary, {
    did: 'Rename builders to authors',
    why: 'landed fc59563',
  });
});

test('a finished agent’s summary says why it is done from its fields, never its outcome text', () => {
  const ended = new Date(NOW - 5 * 60000);
  const why = (over: Partial<LedgerAgent>) =>
    place(
      [
        registered({
          name: 'x',
          state: 'done',
          started: new Date(NOW - 3600000),
          ended,
          lastEvent: ended,
          outcome: 'free text',
          ...over,
        }),
      ],
      [],
    )[0].agents[0].summary?.why;
  assert.equal(why({ state: 'failed' }), 'failed');
  assert.equal(why({ state: 'stopped' }), 'stopped');
  assert.equal(why({ kind: 'critic', findings: 0 }), 'critic clean');
  assert.equal(why({ kind: 'critic', findings: 3 }), '3 findings');
  assert.equal(why({ kind: 'critic' }), 'critic done');
  assert.equal(why({ result: { commit: 'abcdef1234', branch: 'b' } }), 'committed abcdef1');
  assert.equal(why({ result: { pr: 12 } }), 'PR #12');
  assert.equal(why({ result: { branch: 'feat/z' } }), 'on feat/z');
  assert.equal(why({ kind: 'research' }), 'research done');
  assert.equal(why({ kind: 'author' }), 'made nothing to point at');
  assert.equal(why({ kind: 'helper' }), 'done');
});

test('a finished agent’s did line is its card’s title, else its task, and is left out when it would repeat the card’s title', () => {
  const ended = new Date(NOW - 5 * 60000);
  const did = (over: Partial<LedgerAgent>) =>
    place(
      [
        registered({
          name: 'deploy-x',
          kind: 'helper',
          state: 'done',
          started: new Date(NOW - 3600000),
          ended,
          lastEvent: ended,
          ...over,
        }),
      ],
      [],
    )[0].agents[0].summary?.did;
  assert.equal(did({ task: 'ff deploy x' }), 'ff deploy x');
  assert.equal(did({ task: 'deploy-x' }), null, 'the task is its name, the card’s title');
  assert.equal(did({ task: null }), null);
  // a running agent's card has no summary
  assert.equal(place([registered({ name: 'r', state: 'running' })], [])[0].agents[0].summary, null);
});

const landedStart = new Date(NOW - 3600000);
const landedItem = (over: Partial<BacklogItem> = {}) =>
  ({
    id: 'bl_aaaaaa222222',
    title: 'Landed card',
    repo: 'acme/widgets',
    branch: 'b',
    state: 'done',
    landed_at: new Date(NOW - 30 * 60000).toISOString(),
    landed_sha: 'abcdef1234567',
    ...over,
  }) as unknown as BacklogItem;
const onLandedCard = (over: Partial<LedgerAgent>, item: BacklogItem) => {
  const ended = new Date(NOW - 5 * 60000);
  const [own] = place(
    [
      registered({
        name: 'ou-x',
        state: 'done',
        card: 'bl_aaaaaa222222',
        result: null,
        started: landedStart,
        ended,
        lastEvent: ended,
        ...over,
      }),
    ],
    [],
    [item],
  );
  return { column: own.column, why: own.agents[0].summary?.why };
};

test('a card marked done with no sha is landed: Done, and it says landed, not that it made nothing', () => {
  assert.deepEqual(onLandedCard({}, landedItem({ landed_sha: null })), {
    column: 'done',
    why: 'landed',
  });
});

test('a research run keeps Research though its card landed', () => {
  assert.deepEqual(onLandedCard({ kind: 'research' }, landedItem()), {
    column: 'research',
    why: 'research done',
  });
});

test('a card dropped after it landed is not landed for its agent', () => {
  assert.deepEqual(onLandedCard({}, landedItem({ state: 'dropped' })), {
    column: 'waiting',
    why: 'made nothing to point at',
  });
});

test('a landing from before the run started is an earlier run’s; one at its start counts', () => {
  const before = new Date(landedStart.getTime() - 60000).toISOString();
  assert.deepEqual(onLandedCard({}, landedItem({ landed_at: before })), {
    column: 'waiting',
    why: 'made nothing to point at',
  });
  assert.deepEqual(onLandedCard({}, landedItem({ landed_at: landedStart.toISOString() })), {
    column: 'done',
    why: 'landed abcdef1',
  });
});

/** What pendingReview says of an unpushed commit on feat/x. */
const PENDING = { pushed: false, branch: 'feat/x', path: '/wt/feat-x' };

/** The tip of feat/x's worktree: the commit the author below finished with. */
const TIP = 'c80964d9' + '0'.repeat(32);

/** A finished author's commit on feat/x, the scanner's facts of its worktree, and what GitHub said of its PR. */
const committer = (over: Partial<LedgerAgent> = {}) => {
  const ended = new Date(NOW - 5 * 60000);
  return registered({
    name: 'ou-commit',
    state: 'done',
    task: 'bump the lockfile',
    repo: 'acme/widgets',
    branch: 'feat/x',
    result: { commit: 'c80964d9', branch: 'feat/x' },
    started: new Date(NOW - 3600000),
    ended,
    lastEvent: ended,
    ...over,
  });
};
const placeWith = (
  agents: LedgerAgent[],
  options: {
    cards?: BoardCard[];
    tree?: Partial<WorktreeFacts> | null;
    /** GitHub's answer: null is no PR (the default), undefined not answered yet */
    pr?: unknown;
    items?: BacklogItem[];
    home?: string;
  } = {},
) => {
  const { cards = [], tree = {}, items = [], home } = options;
  const pr = 'pr' in options ? options.pr : null;
  const review = { branchPr: () => pr } as unknown as PrWatcher;
  return placeAgents({ ...ctx(), ...(home ? { home } : {}), review } as BuildContext, cards, {
    agents,
    beats: new Map(),
    pin: null,
    items,
    trees: tree ? [{ ...facts('/wt/feat-x'), head: TIP, unpushed: 1, ...tree }] : [],
  });
};
const ownCard = (agent: LedgerAgent, options: Parameters<typeof placeWith>[1] = {}) => {
  const [own] = placeWith([agent], options);
  return own && { column: own.column, why: own.agents[0].summary?.why };
};

test('an author’s commit on a branch with no PR, not merged, is Ready for your review, not Done', () => {
  assert.deepEqual(ownCard(committer()), {
    column: 'ready',
    why: 'committed c80964d, not pushed',
  });
  assert.deepEqual(
    ownCard(committer(), { tree: { unpushed: 0, onRemote: true } }),
    { column: 'ready', why: 'committed c80964d, no PR' },
    'pushed with no PR is still on you',
  );
  assert.deepEqual(
    ownCard(committer({ card: 'bl_aaaaaa333333' })),
    { column: 'ready', why: 'committed c80964d, not pushed' },
    'with a card that has not landed',
  );
  assert.deepEqual(
    ownCard(committer({ branch: null, result: { commit: 'c80964d9', branch: 'feat/x' } })),
    { column: 'ready', why: 'committed c80964d, not pushed' },
    'the finish event’s branch',
  );
});

test('an author’s merged commit is Done, as before', () => {
  const done = { column: 'done', why: 'committed c80964d' };
  assert.deepEqual(ownCard(committer(), { tree: { merged: true } }), done, 'merged locally');
  assert.deepEqual(
    ownCard(committer(), { tree: { superseded: true } }),
    done,
    'its patch is in main',
  );
  assert.deepEqual(
    ownCard(committer(), {
      pr: {
        number: 9,
        state: 'merged',
        merged_at: '2026-11-03T15:00:00Z',
        head_oid: 'f'.repeat(40),
      },
    }),
    done,
    'squash-merged: GitHub has the merged PR',
  );
  assert.deepEqual(ownCard(committer(), { tree: { merged: null } }), done, 'merge state unknown');
  assert.deepEqual(ownCard(committer(), { pr: undefined }), done, 'GitHub has not answered');
  assert.deepEqual(ownCard(committer(), { tree: null }), done, 'no worktree the scanner lists');
  assert.deepEqual(
    ownCard(committer(), { tree: { branch: 'feat/other' } }),
    done,
    'another branch',
  );
  assert.deepEqual(ownCard(committer(), { tree: { repo: 'acme/other' } }), done, 'another repo');
  assert.deepEqual(
    ownCard(committer({ branch: 'main', result: { commit: 'c80964d9', branch: 'main' } }), {
      tree: { branch: 'main' },
    }),
    done,
    'a commit on a default branch is in it',
  );
});

test('an author’s commit whose branch has a PR follows the PR’s rules', () => {
  const open = { number: 9, state: 'open', merged_at: null };
  assert.deepEqual(ownCard(committer(), { pr: open }), {
    column: 'done',
    why: 'committed c80964d',
  });
  // with the PR's card on the board, the author is nested in it, and the card's column is the PR's
  const prCard = card({ branch: 'feat/x', pr: { number: 9, state: 'open' } as BoardCard['pr'] });
  assert.deepEqual(placeWith([committer()], { cards: [prCard], pr: open }), []);
  assert.deepEqual(nestedIn(prCard), ['ou-commit']);
  assert.equal(
    columnOf({
      sessions: [],
      agents: prCard.agents,
      pr: prCard.pr,
      story: null,
      building: false,
    }),
    'pr_open',
  );
});

test('a critic, a helper, a research run, a stopped author and a landed card keep their columns beside an unpushed commit', () => {
  assert.deepEqual(ownCard(committer({ kind: 'critic', findings: 0 })), {
    column: 'done',
    why: 'critic clean',
  });
  assert.deepEqual(ownCard(committer({ kind: 'helper' })), {
    column: 'done',
    why: 'committed c80964d',
  });
  assert.deepEqual(ownCard(committer({ kind: 'research' })), {
    column: 'done',
    why: 'committed c80964d',
  });
  assert.deepEqual(ownCard(committer({ state: 'stopped' })), { column: 'waiting', why: 'stopped' });
  assert.deepEqual(ownCard(committer({ state: 'failed' })), { column: 'waiting', why: 'failed' });
  assert.deepEqual(
    ownCard(committer({ card: 'bl_aaaaaa222222', started: landedStart }), {
      items: [landedItem()],
    }),
    { column: 'done', why: 'landed abcdef1' },
  );
  assert.equal(finishedColumn(committer(), true, PENDING), 'done', 'a landing comes first');
  assert.equal(finishedColumn(committer({ source: undefined }), false, PENDING), 'done');
});

test('an unpushed commit stays in Ready past the finished wait until Finish clears it', () => {
  const home = tmp('placement-unpushed');
  const old = committer({
    ended: new Date(NOW - 2 * 86400000),
    lastEvent: new Date(NOW - 2 * 86400000),
  });
  const [own] = placeWith([old], { home });
  assert.equal(own?.column, 'ready', 'two days on, still waiting on you');
  assert.equal(own.agents[0].clears_at, null, 'no timer');
  assert.deepEqual(
    placeWith([old], { home, tree: { merged: true } }),
    [],
    'merged: the old card goes',
  );
  markFinished(home, 'aaaaaaaa:ou-commit', NOW - 60000);
  assert.deepEqual(placeWith([old], { home }), [], 'cleared by Finish');
});

test('an old author whose branch name is reused is not Ready: its commit must be the worktree’s tip', () => {
  const done = { column: 'done', why: 'committed c80964d' };
  assert.deepEqual(
    ownCard(committer(), { tree: { head: 'f'.repeat(40) } }),
    done,
    'a new worktree on the same branch name, with other commits',
  );
  assert.deepEqual(ownCard(committer(), { tree: { head: null } }), done, 'no tip known');
  // two authors on one branch: the one whose commit is the tip waits on you; the earlier one is Done
  const later = committer({ name: 'ou-later', result: { commit: 'c80964d9', branch: 'feat/x' } });
  const earlier = committer({
    name: 'ou-earlier',
    result: { commit: 'aaaaaaa1', branch: 'feat/x' },
  });
  const cards = placeWith([earlier, later]);
  assert.deepEqual(
    cards.map((one) => [one.title, one.column]),
    [
      ['ou-earlier', 'done'],
      ['ou-later', 'ready'],
    ],
  );
});

test('a pending author stops waiting after the week Finish is kept for, so a purged Finish never brings it back', () => {
  const home = tmp('placement-unpushed-week');
  const week = 7 * 24 * 3600 * 1000;
  const endedAt = (when: number) => committer({ ended: new Date(when), lastEvent: new Date(when) });
  const [six] = placeWith([endedAt(NOW - 6 * 24 * 3600 * 1000)], { home });
  assert.equal(six?.column, 'ready', 'six days on');
  // finished a week and two minutes ago, cleared a minute later, and that entry purged by a later Finish
  const old = endedAt(NOW - week - 2 * 60000);
  markFinished(home, 'aaaaaaaa:ou-commit', NOW - week - 60000);
  markFinished(home, 'aaaaaaaa:someone-else', NOW);
  assert.equal(readFinished(home).has('aaaaaaaa:ou-commit'), false, 'purged');
  assert.deepEqual(
    placeWith([old], { home }),
    [],
    'past the week: not Ready, and its window long gone',
  );
});

test('a Ready author’s own card carries its branch’s worktree, for Review and Build story; a Done one does not', () => {
  const [own] = placeWith([committer()]);
  assert.equal(own.column, 'ready');
  assert.deepEqual(own.review, { branch: 'feat/x', path: '/wt/feat-x' });
  const [merged] = placeWith([committer()], { tree: { merged: true } });
  assert.equal(merged?.review ?? null, null, 'merged: nothing to review');
});
