import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { BacklogStore, backlogCards } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { findWorkCard } from '@once-upon-a-diff/state/queues/backlog/ensure';
import { startedLinks } from '@once-upon-a-diff/state/queues/backlog/backlog-links';
import type {
  WorktreeFacts,
  WorktreeScanner,
} from '@once-upon-a-diff/state/records/worktrees/worktrees';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';
import { assignCards } from '../src/stages/works.ts';
import { cardHomes, homeOf, NO_HOMES } from '../src/stages/homes.ts';
import {
  ignoreStoriesBeforePark,
  keepWorkWorking,
  markLandedWorks,
} from '../src/stages/backlog.ts';
import { worktreeSection } from '../src/stages/worktrees.ts';
import type { PrWatcher } from '../src/stages/pr-watcher.ts';
import type { Work } from '../src/stages/types.ts';

// ADR-29, key by card id: a stored card is joined to its work, sessions and worktree by its id; the branch name is the first-learn lookup.
const REPO = 'acme/widgets';
const NOW = Date.parse('2026-11-23T15:00:00Z');

const store = () => new BacklogStore(tmp('key-by-card'));
const work = (over: Partial<Work>): Work => ({
  key: 'w',
  repo: REPO,
  number: null,
  branch: null,
  story: null,
  local: null,
  mergedAt: null,
  title: null,
  built: false,
  sessions: [],
  ...over,
});
const review = { info: () => null } as unknown as PrWatcher;
const workCard = (id: string, over: Partial<BoardCard> = {}): BoardCard =>
  ({
    id,
    kind: 'work',
    repo: REPO,
    branch: null,
    pr: null,
    story: null,
    sessions: [],
    agents: [],
    ...over,
  }) as unknown as BoardCard;

test('findWorkCard: by PR number then branch; a card of another PR is another work’s; open before landed', () => {
  const backlog = store();
  const old = backlog.add({ title: 'old', repo: REPO, branch: 'feat/x', source: 'pr', pr: 5 });
  backlog.done(old.id, { mergedAt: new Date(NOW - 3600_000).toISOString() });
  const fresh = backlog.add({ title: 'fresh', repo: REPO, branch: 'feat/x' });
  const items = backlog.items();
  // the branch was reused by a new PR: its work is the new card's, not the landed PR 5 card's
  assert.equal(findWorkCard(items, { repo: REPO, number: 9, branch: 'feat/x' })?.id, fresh.id);
  // a work found by PR 5 alone (no branch yet) is the landed card's, when no open card has the PR
  assert.equal(findWorkCard(items, { repo: REPO, number: 5, branch: null })?.id, old.id);
  // PR 5 with the branch it has now: its own card by number, though a newer open card is on that branch
  assert.equal(findWorkCard(items, { repo: REPO, number: 5, branch: 'feat/x' })?.id, old.id);
  assert.equal(findWorkCard(items, { repo: 'acme/other', number: 9, branch: 'feat/x' }), undefined);
});

test('assignCards: a PR whose head was renamed is on the card that holds its number, and a second call keeps the first answer', () => {
  const backlog = store();
  const card = backlog.add({ title: 'renamed', repo: REPO, branch: 'feat/old-name' });
  backlog.start(card.id, { branch: 'feat/old-name', repo: REPO });
  backlog.link(card.id, { pr: 12 });
  const renamed = work({ key: 'pr', number: 12, branch: 'feat/new-name' });
  const other = work({ key: 'other', number: 13, branch: 'feat/old-name' });
  const works = new Map([
    [renamed.key, renamed],
    [other.key, other],
  ]);
  assignCards(works, backlog.items(), review);
  assert.equal(renamed.card, card.id);
  assert.equal(other.card, undefined, 'another PR on the old branch name is not that card’s');
  renamed.card = 'bl_pinned';
  assignCards(works, backlog.items(), review);
  assert.equal(renamed.card, 'bl_pinned');
});

test('homeOf: the card’s home by id first, the branch second; a home the build dropped is not returned', () => {
  const onNew = workCard('pr:12', {
    branch: 'feat/new-name',
    pr: { number: 12 } as BoardCard['pr'],
  });
  const onOld = workCard('branch:old', { branch: 'feat/old-name' });
  const placed = work({ key: 'pr:12', card: 'bl_a', number: 12 });
  const homes = cardHomes(new Map([[placed.key, placed]]), [onNew, onOld], new Map());
  const place = { repo: REPO, branch: 'feat/old-name' };
  assert.equal(
    homeOf(homes, 'bl_a', place, [onNew, onOld]),
    onNew,
    'by id, not by the stored branch',
  );
  assert.equal(homeOf(homes, 'bl_b', place, [onNew, onOld]), onOld, 'no home: its branch');
  assert.equal(
    homeOf(homes, 'bl_a', place, [onOld]),
    onOld,
    'a home no longer on the board is not used',
  );
  assert.equal(homeOf(NO_HOMES, 'bl_a', place, [onNew]), undefined);
});

test('a started item rides on its home when its stored branch names no work card (a renamed head)', () => {
  const backlog = store();
  const item = backlog.add({ title: 'renamed', repo: REPO, branch: 'feat/old-name' });
  backlog.start(item.id, { branch: 'feat/old-name', repo: REPO });
  const onNew = workCard('pr:12', { branch: 'feat/new-name' });
  const placed = work({ key: 'pr:12', card: item.id });
  const homes = cardHomes(new Map([[placed.key, placed]]), [onNew], new Map());
  const shown = backlogCards(
    backlog.items(),
    [onNew],
    NOW,
    new Map(),
    new Map(),
    new Map(),
    (one) => homeOf(homes, one.id, one, [onNew]),
  );
  assert.deepEqual(shown, [], 'no card of its own');
  assert.deepEqual(onNew.from_backlog, [{ id: item.id, title: 'renamed' }]);
  // and a session card its runs put on the card's branch is its home when no work has it
  const session = workCard('sess', { kind: 'session', branch: 'feat/old-name' } as never);
  const second = cardHomes(new Map(), [session], new Map([[item.id, session]]));
  assert.equal(homeOf(second, item.id, item, [session]), session);
});

test('markLandedWorks: a landed card whose branch was reused takes no work of the new card (the story’s times stay the guard)', () => {
  const backlog = store();
  const old = backlog.add({ title: 'old', repo: REPO, branch: 'feat/x' });
  backlog.start(old.id, { branch: 'feat/x', repo: REPO });
  backlog.done(old.id, { mergedAt: new Date(NOW - 3600_000).toISOString() });
  const fresh = backlog.add({ title: 'fresh', repo: REPO, branch: 'feat/x' });
  backlog.start(fresh.id, { branch: 'feat/x', repo: REPO });
  const story = {
    id: 'local-x',
    kind: 'local',
    approved_at: null,
  } as unknown as BoardCard['story'];
  const onFresh = workCard('branch:x', { branch: 'feat/x', story });
  const placed = work({ key: 'branch:x', card: fresh.id });
  const homes = cardHomes(new Map([[placed.key, placed]]), [onFresh], new Map());
  // the new story was built after the old card landed: it is the new card's work
  const built = new Map([
    ['local-x', { id: 'local-x', built_at: new Date(NOW - 60_000).toISOString() }],
  ]);
  markLandedWorks(backlog.items(), [onFresh], NOW, built as never, [], homes);
  assert.equal(onFresh.landed, undefined);
  assert.deepEqual(onFresh.story, story);
  keepWorkWorking(backlog.items(), [onFresh], homes);
});

test('startedLinks: the worktree a card stored is its own, whatever branch it is on now', () => {
  const backlog = store();
  const item = backlog.add({ title: 'moved', repo: REPO, branch: 'feat/old-name' });
  backlog.start(item.id, { branch: 'feat/old-name', repo: REPO });
  backlog.link(item.id, { worktree: '/dev/widgets-worktrees/moved' });
  const facts = {
    worktrees: new Map([
      [
        REPO,
        [
          { path: '/dev/widgets-worktrees/moved', branch: 'feat/new-name' },
          { path: '/dev/widgets-worktrees/else', branch: 'feat/else' },
        ],
      ],
    ]),
    sessions: [],
    agents: [],
    merged: () => null,
  };
  const found = startedLinks(backlog.items()[0], facts as never);
  assert.deepEqual(found?.worktrees, [{ path: '/dev/widgets-worktrees/moved', name: 'moved' }]);
});

const treeAt = (dir: string, branch: string): WorktreeFacts =>
  ({
    path: dir,
    main: dir,
    mainBranch: 'main',
    repo: REPO,
    branch,
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

test('worktreeSection: a worktree on a stored card’s path goes on that card by its id, not by its branch name', () => {
  const dir = tmp('key-worktree');
  const tree = treeAt(dir, 'feat/renamed-again');
  const scanner = {
    kick: () => {},
    read: () => ({ items: [tree], scanning: false, finished: NOW, prunable: [] }),
  } as unknown as WorktreeScanner;
  const watcher = { kickBranch: () => {}, branchPr: () => undefined } as unknown as PrWatcher;
  const backlog = store();
  const item = backlog.add({ title: 'wt', repo: REPO, branch: 'feat/old-name' });
  backlog.link(item.id, { worktree: dir });
  const mine = workCard('pr:12', { branch: 'feat/new-name' });
  const bystander = workCard('branch:renamed', { branch: 'feat/renamed-again' });
  const placed = work({ key: 'pr:12', card: item.id });
  const homes = cardHomes(new Map([[placed.key, placed]]), [mine, bystander], new Map());
  const section = worktreeSection({
    scanner,
    home: tmp('key-worktree-home'),
    review: watcher,
    cards: [mine, bystander],
    live: [],
    sessionViews: new Map(),
    agents: [],
    keepBranches: [],
    nowMs: NOW,
    stored: backlog.items(),
    homes,
  });
  assert.equal(mine.worktrees?.length, 1);
  assert.equal(bystander.worktrees, undefined);
  assert.equal(section.items.length, 0);
});

test('worktreeSection: a folder two stored cards hold is the open card’s, not a landed older one’s', () => {
  const dir = tmp('key-worktree-reused');
  const scanner = {
    kick: () => {},
    read: () => ({
      items: [treeAt(dir, 'feat/second')],
      scanning: false,
      finished: NOW,
      prunable: [],
    }),
  } as unknown as WorktreeScanner;
  const watcher = { kickBranch: () => {}, branchPr: () => undefined } as unknown as PrWatcher;
  const backlog = store();
  const old = backlog.add({ title: 'old', repo: REPO, branch: 'feat/first', worktree: dir });
  backlog.done(old.id, { mergedAt: new Date(NOW - 3600_000).toISOString() });
  const fresh = backlog.add({ title: 'fresh', repo: REPO, branch: 'feat/second', worktree: dir });
  const onOld = workCard('pr:5', { branch: 'feat/first' });
  const onFresh = workCard('branch:second', { branch: 'feat/second' });
  const homes = cardHomes(
    new Map([
      ['pr:5', work({ key: 'pr:5', card: old.id })],
      ['branch:second', work({ key: 'branch:second', card: fresh.id })],
    ]),
    [onOld, onFresh],
    new Map(),
  );
  worktreeSection({
    scanner,
    home: tmp('key-worktree-reused-home'),
    review: watcher,
    cards: [onOld, onFresh],
    live: [],
    sessionViews: new Map(),
    agents: [],
    keepBranches: [],
    nowMs: NOW,
    stored: backlog.items(),
    homes,
  });
  assert.equal(onOld.worktrees, undefined);
  assert.equal(onFresh.worktrees?.length, 1);
});

test('ignoreStoriesBeforePark: the card’s home by id for its own branch, and each run’s branch by its own work card', () => {
  const backlog = store();
  const item = backlog.add({ title: 'parked', repo: REPO, branch: 'feat/x' });
  const parked = { ...item, parked_at: new Date(NOW).toISOString() };
  const story = (id: string) =>
    ({ id, kind: 'local', approved_at: null }) as unknown as BoardCard['story'];
  const onItem = workCard('branch:x', {
    branch: 'feat/x',
    story: story('local-x'),
    sessions: [{}] as never,
  });
  const onRun = workCard('branch:y', { branch: 'feat/y', story: story('local-y') });
  const placed = work({ key: 'branch:x', card: item.id });
  const homes = cardHomes(new Map([[placed.key, placed]]), [onItem, onRun], new Map());
  const built = new Map(
    ['local-x', 'local-y'].map((id) => [
      id,
      { id, built_at: new Date(NOW - 60_000).toISOString() },
    ]),
  );
  const run = { card: item.id, branch: 'feat/y', repo: REPO, started: new Date(NOW - 1000) };
  const cards = [onItem, onRun];
  ignoreStoriesBeforePark([parked], cards, built as never, [run as never], homes);
  assert.equal(onItem.story, null, 'the home’s story was told before the park');
  assert.equal(cards.includes(onRun), false, 'and so was the run branch’s own work card’s');
});
