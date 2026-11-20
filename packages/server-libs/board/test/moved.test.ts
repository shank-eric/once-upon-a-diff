import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import type { WorktreeFacts } from '@once-upon-a-diff/state/records/worktrees/worktrees';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';
import { Board, noPrWatcher } from '../src/board.ts';
import { columnOf, type ColumnInput } from '../src/columns.ts';
import { movedCards } from '../src/stages/moved.ts';
import { placeCards } from '../src/stages/cards.ts';
import { cardPhase } from '@once-upon-a-diff/state/queues/backlog/phase';
import { backlogCards } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { readyFactsFor } from '../src/stages/ready-facts.ts';
import type { PrWatcher } from '../src/stages/pr-watcher.ts';
import type { Lookups } from '../src/stages/types.ts';

const story = (over: Partial<NonNullable<ColumnInput['story']>> = {}) => ({
  reviewed: false,
  manualReviewedAt: null,
  unread: false,
  local: true,
  ...over,
});
const column = (input: Partial<ColumnInput>) =>
  columnOf({ sessions: [], agents: [], pr: null, story: story(), ...input });

test('columnOf: a would-be Ready card with a moved branch is Working; nothing else changes', () => {
  assert.equal(column({}), 'ready');
  assert.equal(column({ moved: true }), 'working');
  assert.equal(column({ moved: true, story: story({ unread: true }) }), 'working');
  assert.equal(column({ moved: true, story: story({ answered: 1 }) }), 'working');
  assert.equal(
    column({ moved: true, agents: [{ status: 'done', state: 'waiting', review: true }] }),
    'working',
  );
  // approved, landed, reviewed and PR cards are not Ready, so a move does not touch them
  assert.equal(column({ moved: true, story: story({ approved: true }) }), 'ship');
  assert.equal(column({ moved: true, story: story({ landed: true }) }), 'done');
  assert.equal(column({ moved: true, story: story({ reviewed: true }) }), 'idle');
  assert.equal(column({ moved: true, pr: { state: 'open' } as ColumnInput['pr'] }), 'pr_open');
});

const TOLD = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
const tree = {
  repo: 'acme/widgets',
  branch: 'feat/x',
  head: TIP,
  path: '/wt/x',
  defaultBranch: 'main',
} as WorktreeFacts;
const workCard = (over: Partial<BoardCard> = {}) =>
  ({
    kind: 'work',
    repo: 'acme/widgets',
    branch: 'feat/x',
    pr: null,
    story: { id: 's1', kind: 'local', reviewed: false, approved_at: null, unread_answers: 0 },
    ...over,
  }) as unknown as BoardCard;

test('movedCards: a local story card whose worktree tip is not its told commit, and the lookup says moved', () => {
  const asked: string[][] = [];
  const says =
    (answer: boolean | null) =>
    (checkout: string, told: string, tip: string, base: string | null) => {
      asked.push([checkout, told, tip, String(base)]);
      return answer;
    };
  const card = workCard();
  assert.deepEqual(
    [...movedCards([card], new Map([['s1', TOLD]]), [tree], says(true)).keys()],
    [card],
  );
  assert.deepEqual(asked, [['/wt/x', TOLD, TIP, 'main']]);
  // unknown yet, or no: unchanged
  assert.equal(movedCards([card], new Map([['s1', TOLD]]), [tree], says(null)).size, 0);
  assert.equal(movedCards([card], new Map([['s1', TOLD]]), [tree], says(false)).size, 0);
  // the tip is the told commit, no told commit, no scanner fact, another branch: nothing is asked
  asked.length = 0;
  const fresh = [
    movedCards([card], new Map([['s1', TIP]]), [tree], says(true)),
    movedCards([card], new Map(), [tree], says(true)),
    movedCards([card], new Map([['s1', TOLD]]), [], says(true)),
    movedCards([card], new Map([['s1', TOLD]]), [{ ...tree, branch: 'other' }], says(true)),
  ];
  assert.deepEqual(
    fresh.map((one) => one.size),
    [0, 0, 0, 0],
  );
  assert.deepEqual(asked, []);
  // a PR, an approval, a landing or a hand mark takes the card out of Ready, so it is not asked about
  const out = [
    workCard({ pr: { number: 3 } as BoardCard['pr'] }),
    workCard({ story: { ...card.story, approved_at: '2026-01-01' } as BoardCard['story'] }),
    workCard({ landed: { at: '2026-01-01' } as BoardCard['landed'] }),
    workCard({ story: { ...card.story, reviewed: true } as BoardCard['story'] }),
    workCard({ story: { ...card.story, kind: 'pr' } as BoardCard['story'] }),
  ];
  assert.equal(movedCards(out, new Map([['s1', TOLD]]), [tree], says(true)).size, 0);
  assert.deepEqual(asked, []);
});

const placed = (): BoardCard => workCard({ sessions: [], agents: [] });
const fixer = (over: Partial<LedgerAgent> = {}): LedgerAgent => ({
  sid: 'aaaaaaaa',
  name: 'fix-feat-x',
  kind: 'author',
  state: 'done',
  model: null,
  modelName: null,
  task: null,
  started: new Date(NOW - 3600000),
  ended: new Date(NOW - 60000),
  lastEvent: new Date(NOW - 60000),
  outcome: null,
  repo: 'acme/widgets',
  result: { commit: TIP, branch: 'feat/x' },
  ...over,
});
const NOW = Date.parse('2026-11-19T15:00:00Z');

test('a story card whose branch moved: "changed outside a run" with Record as fix, until a run covers the tip', () => {
  const told = new Map([['s1', TOLD]]);
  const says = () => true;
  // no run of the branch: outside
  const bare = placed();
  const outside = movedCards([bare], told, [tree], says, [], NOW);
  assert.equal(outside.get(bare)?.covering, null);
  placeCards([bare], new Map(), outside);
  assert.equal(bare.column, 'working');
  assert.equal(bare.detail, 'changed outside a run');
  assert.deepEqual(bare.outside, {
    sha: TIP,
    branch: 'feat/x',
    repo: 'acme/widgets',
    path: '/wt/x',
  });
  // a finished fixer run whose commit is the tip (what `fixed --sha` records): the fix is recorded, the story needs retelling
  const done = placed();
  const recorded = movedCards([done], told, [tree], says, [fixer()], NOW);
  placeCards([done], new Map(), recorded);
  assert.equal(done.column, 'working');
  assert.equal(done.detail, 'fixed in bbbbbbb, story not retold');
  assert.equal(done.outside, undefined);
  // a run still going accounts for it too, with the plain text
  const going = placed();
  const live = fixer({ state: 'fixing', ended: null, branch: 'feat/x', result: undefined });
  placeCards([going], new Map(), movedCards([going], told, [tree], says, [live], NOW));
  assert.equal(going.detail, 'branch moved past its story');
  assert.equal(going.outside, undefined);
  // a run of another branch, or a finished one with another commit, does not
  const other = placed();
  const unrelated = [
    fixer({ branch: 'other', result: { commit: TIP, branch: 'other' } }),
    fixer({ result: { commit: 'c'.repeat(40), branch: 'feat/x' } }),
    fixer({ state: 'waiting', ended: null }),
  ];
  assert.equal(movedCards([other], told, [tree], says, unrelated, NOW).get(other)?.covering, null);
});

test('a built backlog card whose branch moved past its run’s commit is Working, outside a run, with its tip', () => {
  const item = {
    id: 'bl_aaaaaa111111',
    state: 'started',
    repo: 'acme/widgets',
    branch: 'feat/x',
    title: 'x',
    note: null,
    added_by: 'cli',
    added_at: '2026-11-19T10:00:00Z',
    started_at: '2026-11-19T11:00:00Z',
    critic_skipped: true,
  } as unknown as BacklogItem;
  const run = fixer({ card: item.id, result: { commit: TOLD, branch: 'feat/x' } });
  const unpushed = { ...tree, unpushed: 1 } as WorktreeFacts;
  const review = {
    branchPr: () => null,
    kickInfo: () => {},
    info: () => null,
  } as unknown as PrWatcher;
  const ready = (head: string) =>
    readyFactsFor(
      review,
      { repo: 'acme/widgets', branch: 'feat/x' },
      [{ ...unpushed, head }],
      NOW,
      { commit: run.result?.commit, movedPast: () => true },
    );
  const phase = cardPhase(item, [run], NOW, ready(TIP), false);
  assert.equal(phase?.column, 'working');
  assert.deepEqual(phase?.outside, { tip: TIP, path: '/wt/x' });
  const [shown] = backlogCards(
    [item],
    [],
    NOW,
    [],
    new Map(),
    new Map(),
    new Map([[item.id, phase ?? null]]),
  );
  assert.deepEqual(shown.outside, {
    sha: TIP,
    branch: 'feat/x',
    repo: 'acme/widgets',
    path: '/wt/x',
  });
  // a fixer run recorded at the tip: no longer working, so no label
  const recorded = fixer({
    card: item.id,
    started: new Date(NOW - 1000),
    result: { commit: TIP, branch: 'feat/x' },
  });
  const after = cardPhase(
    item,
    [run, recorded],
    NOW,
    readyFactsFor(
      review,
      { repo: 'acme/widgets', branch: 'feat/x' },
      [{ ...unpushed, head: TIP }],
      NOW,
      {
        commit: recorded.result?.commit,
        movedPast: () => true,
      },
    ),
    false,
  );
  assert.equal(after?.column, 'ready');
  assert.equal(after?.outside, undefined);
});

test('readyFactsFor: a reviewed commit the tip has moved past is working, unless a PR is open', () => {
  const review = (answer: unknown) =>
    ({ branchPr: () => answer, kickInfo: () => {}, info: () => null }) as unknown as PrWatcher;
  const branch = { repo: 'acme/widgets', branch: 'feat/x' };
  const reviewed = (moved: boolean | null, commit: string | null = TOLD) => ({
    commit,
    movedPast: () => moved,
  });
  const unpushedTree = { ...tree, unpushed: 1 } as WorktreeFacts;
  assert.deepEqual(readyFactsFor(review(null), branch, [unpushedTree], 0, reviewed(true)), {
    pr: 'none',
    pushed: false,
    working: true,
    moved: { tip: TIP, path: '/wt/x' },
  });
  assert.deepEqual(readyFactsFor(review(null), branch, [unpushedTree], 0, reviewed(null)), {
    pr: 'none',
    pushed: false,
  });
  assert.deepEqual(readyFactsFor(review(null), branch, [unpushedTree], 0, reviewed(true, null)), {
    pr: 'none',
    pushed: false,
  });
  assert.deepEqual(
    readyFactsFor(review(null), branch, [unpushedTree], 0, reviewed(true, TIP)),
    { pr: 'none', pushed: false },
    'the tip is the commit',
  );
  assert.equal(
    readyFactsFor(review({ number: 1, state: 'open' }), branch, [unpushedTree], 0, reviewed(true))
      .working,
    undefined,
  );
});

test('the board’s movedPast look: asked once per pair of shas, a few at a time, and a true answer drops the snapshot', async () => {
  const home = tmp('moved-home');
  const calls: string[] = [];
  const held: ((moved: boolean | null) => void)[] = [];
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    movedPast: (_repo: string, told: string, tip: string) => {
      calls.push(`${told}>${tip}`);
      return new Promise((resolve) => held.push(resolve));
    },
  });
  const { lookups } = board as unknown as { lookups: Lookups };
  assert.equal(lookups.movedPast('/wt', 'a1', 'b1', 'main'), null);
  assert.equal(lookups.movedPast('/wt', 'a1', 'b1', 'main'), null, 'in flight: not asked twice');
  assert.deepEqual(calls, ['a1>b1']);
  for (const tip of ['b2', 'b3', 'b4', 'b5']) {
    lookups.movedPast('/wt', 'a1', tip, 'main');
  }
  assert.equal(calls.length, 4, 'a fifth look waits for a free slot');
  held[0](true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    lookups.movedPast('/wt', 'a1', 'b1', 'main'),
    true,
    'answered, and kept for the pair',
  );
  assert.equal(calls.length, 4);
  lookups.movedPast('/wt', 'a1', 'b5', 'main');
  assert.equal(calls.length, 5, 'the freed slot takes it');
  held.forEach((resolve) => resolve(false));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookups.movedPast('/wt', 'a1', 'b2', 'main'), false);
});

test('the board’s movedPast look: a null answer is asked again after a short wait, not a minute', async (ctx) => {
  const home = tmp('moved-retry-home');
  let calls = 0;
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    movedPast: () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? null : true);
    },
  });
  const { lookups } = board as unknown as { lookups: Lookups };
  const start = Date.now();
  const now = ctx.mock.method(Date, 'now', () => start);
  assert.equal(lookups.movedPast('/wt', 'a1', 'b1', 'main'), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookups.movedPast('/wt', 'a1', 'b1', 'main'), null);
  assert.equal(calls, 1, 'not asked again at once');
  now.mock.mockImplementation(() => start + 11000);
  lookups.movedPast('/wt', 'a1', 'b1', 'main');
  assert.equal(calls, 2, 'asked again after BRANCH_CACHE_MS');
});
