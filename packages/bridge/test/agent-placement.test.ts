import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp, writeJson } from './helpers.ts';
import path from 'node:path';
import { readSettings } from '../src/services/config/settings.ts';
import { finishedColumn, homeOf } from '../src/services/board/agent-home.ts';
import { NO_PARENT, placeAgents } from '../src/services/board/stages/agents.ts';
import { backlogCards } from '../src/services/backlog/backlog.ts';
import type { BacklogItem } from '../src/services/backlog/backlog.ts';
import { nestClaimedAgents } from '../src/services/board/stages/backlog.ts';
import type { BuildContext } from '../src/services/board/stages/types.ts';
import type { LedgerAgent } from '../src/services/ledger/ledger.ts';
import type { BoardAgent, BoardCard } from '@once-upon-a-diff/protocol/types';

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
  agent({ source: 'events', kind: 'builder', ...over });

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
    kind: 'reviewer',
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
