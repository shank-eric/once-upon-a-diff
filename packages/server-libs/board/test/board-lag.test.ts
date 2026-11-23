import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { git } from '@once-upon-a-diff/test-kit/git';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import {
  isListedLocalStory,
  localEntries,
} from '@once-upon-a-diff/core/features/review/story-lists';
import { NOW, checkoutOf, localStory } from '@once-upon-a-diff/state/test/board-fixtures';
import { Board, noPrWatcher } from '../src/board.ts';
import { announceChange } from '@once-upon-a-diff/adapters/change-signal';
import { until } from './board-fixtures.ts';

const iso = (time: number) => new Date(time).toISOString();
const DAY = 24 * 3600 * 1000;

test('a quick build logs nothing', async () => {
  const home = tmp('board-quick-log');
  const lines: string[] = [];
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => NOW,
    log: (line) => lines.push(line),
  });
  await board.snapshot();
  assert.deepEqual(lines, []);
});

test('a build over half a second logs one line: the slow stages and how long the event loop stood still', async () => {
  const home = tmp('board-slow-stage');
  const lines: string[] = [];
  const slowWatcher = {
    ...noPrWatcher,
    kick: () => {
      const until = Date.now() + 600;
      while (Date.now() < until) {
        // held: a stage that blocks the loop
      }
    },
  };
  const board = new Board(home, new StoryStore({ home }), slowWatcher, new Builds(home), {
    source: registrySource,
    now: () => NOW,
    log: (line) => lines.push(line),
  });
  await board.snapshot(); // the first build starts the event-loop probe
  await board.rebuild();
  assert.equal(lines.length, 2);
  assert.match(
    lines[1],
    /^board build \d+ ms \(.*collectWorks \d+.*\); event loop max \d+ ms, p99 \d+ ms/,
  );
});

test('the board holds an approval until its background tip look says the branch moved, then the next snapshot shows it Ready, with no git call in the build', async () => {
  const home = tmp('board-kept-tip');
  const checkout = checkoutOf('widgets', 'feat/told');
  const approved = 'a'.repeat(40);
  localStory(home, 'local-told', checkout, 'feat/told', {
    built_at: iso(NOW.getTime() - 20 * 60000),
    head_oid: approved,
  });
  const stories = new StoryStore({ home });
  writeJson(path.join(home, 'state', 'local-told', 'review.json'), {
    approval: { at: iso(NOW.getTime() - 60000), head_oid: approved, base_oid: null },
  });
  const asked: string[] = [];
  let tip: string | null = approved;
  const board = new Board(home, stories, noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => NOW,
    tipOf: async (repo, ref) => {
      asked.push(`${repo} ${ref}`);
      return { tip, killed: false };
    },
  });
  const column = async () =>
    (await board.snapshot()).lanes
      .flatMap((lane) => lane.cards)
      .find((card) => card.story?.id === 'local-told')?.column;
  assert.equal(await column(), 'ship', 'the first build has no tip: the approval stands');
  await until(
    () => asked.length,
    (count) => count > 0,
  );
  assert.equal(await column(), 'ship', 'the tip is where it was approved');
  assert.equal(asked.length, 1, 'one look for the pair, not one per build');
  // the branch moves: the kept tip is looked at again when it is older than the keep time (the clock is real here)
  tip = 'b'.repeat(40);
  board['tips'].set(`${checkout}\0HEAD`, { at: 0, tip: approved, asking: false });
  assert.equal(await column(), 'ship', 'still the kept tip: the build did not wait on git');
  assert.equal(
    await until(column, (found) => found === 'ready', 5),
    'ready',
    'the look dropped the snapshot',
  );
});

test('localEntries reads tips from the reader it is given, never from git', () => {
  const home = tmp('board-tips-stub');
  const approved = 'a'.repeat(40);
  // a checkout git cannot read: only the stub can say where the ref is
  localStory(home, 'local-told', path.join(home, 'no-such-checkout'), 'feat/told', {
    built_at: iso(NOW.getTime() - 20 * 60000),
    head_oid: approved,
  });
  writeJson(path.join(home, 'state', 'local-told', 'review.json'), {
    approval: { at: iso(NOW.getTime() - 60000), head_oid: approved, base_oid: null },
  });
  const stories = new StoryStore({ home });
  const approvedHead = (tips: () => string | null) =>
    localEntries(stories, { now: NOW.getTime(), tips })[0].story.approved_head;
  assert.equal(
    approvedHead(() => approved),
    approved,
  );
  assert.equal(
    approvedHead(() => null),
    approved,
    'no tip known: the approval stands',
  );
  assert.equal(
    approvedHead(() => 'b'.repeat(40)),
    null,
    'a tip somewhere else lapses it',
  );
});

test('isListedLocalStory answers for one story: a local one, not a turn capture or a PR story, and not past the story window', () => {
  const home = tmp('board-open-story');
  const checkout = checkoutOf('widgets', 'feat/x');
  localStory(home, 'local-new', checkout, 'feat/x', { built_at: iso(NOW.getTime() - 5 * DAY) });
  localStory(home, 'local-old', checkout, 'feat/old', { built_at: iso(NOW.getTime() - 31 * DAY) });
  localStory(home, 'local-edge', checkout, 'feat/edge', {
    built_at: iso(NOW.getTime() - 29 * DAY),
  });
  localStory(home, 'turn-abc', checkout, null, { built_at: iso(NOW.getTime() - DAY), turn: 'abc' });
  writeJson(path.join(home, 'gh-7', 'meta.json'), {
    kind: 'github',
    repo: 'acme/widgets',
    number: 7,
  });
  writeJson(path.join(home, 'gh-7', 'chapters.json'), { title: 'pr', chapters: [] });
  // no built_at: the folder's newest file time says when, and this one is 40 days old
  localStory(home, 'local-undated', checkout, 'feat/undated');
  const forty = new Date(NOW.getTime() - 40 * DAY);
  for (const file of ['meta.json', 'chapters.json']) {
    utimesSync(path.join(home, 'local-undated', file), forty, forty);
  }
  const stories = new StoryStore({ home });
  const now = NOW.getTime();
  assert.equal(isListedLocalStory(stories, 'local-new', now), true);
  assert.equal(isListedLocalStory(stories, 'local-edge', now), true);
  assert.equal(isListedLocalStory(stories, 'local-old', now), false, 'older than 30 days');
  assert.equal(
    isListedLocalStory(stories, 'local-undated', now),
    false,
    'the file time counts when built_at is missing',
  );
  assert.equal(isListedLocalStory(stories, 'turn-abc', now), false, 'a turn capture is not listed');
  assert.equal(isListedLocalStory(stories, 'gh-7', now), false, 'a PR story is not a local one');
  assert.equal(isListedLocalStory(stories, 'nope', now), false);
  assert.equal(isListedLocalStory(stories, '../etc', now), false);
  // it agrees with the full listing on who is in
  assert.deepEqual(
    localEntries(stories, { now })
      .map((entry) => entry.story.id)
      .sort(),
    ['local-edge', 'local-new'],
  );
});

test('a stale branch or worktree list answers at once, is looked at again in the background, and the new answer drops the kept snapshot', async () => {
  const home = tmp('board-stale-branch');
  const checkout = checkoutOf('widgets', 'main');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'first');
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
  });
  let clock = Date.now();
  const settled = () =>
    until(
      () => board['refreshing'].size,
      (running) => running === 0,
    );
  assert.equal(await board['branchOf'](checkout, clock), 'main');
  git(checkout, 'checkout', '-q', '-b', 'feat/next');
  clock += 60000;
  const before = board['generation'];
  assert.equal(
    await board['branchOf'](checkout, clock),
    'main',
    'the kept answer, without waiting',
  );
  await settled();
  assert.equal(await board['branchOf'](checkout, clock), 'feat/next', 'the background look landed');
  assert.ok(board['generation'] > before, 'and the kept snapshot was dropped');
  // unchanged answers leave the snapshot alone
  clock += 60000;
  const same = board['generation'];
  await board['branchOf'](checkout, clock);
  await settled();
  assert.equal(board['generation'], same);
  // the worktree list the same way
  assert.deepEqual(
    (await board['worktreesOf'](checkout, clock)).map((tree) => tree.branch),
    ['feat/next'],
  );
  git(checkout, 'checkout', '-q', 'main');
  clock += 60000;
  assert.deepEqual(
    (await board['worktreesOf'](checkout, clock)).map((tree) => tree.branch),
    ['feat/next'],
  );
  await settled();
  assert.deepEqual(
    (await board['worktreesOf'](checkout, clock)).map((tree) => tree.branch),
    ['main'],
  );
});

test('a change made through the board shows on the very next snapshot, even with kept answers about', async () => {
  const home = tmp('board-no-stale');
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => NOW,
  });
  const titles = async () =>
    (await board.snapshot()).lanes.flatMap((lane) => lane.cards.map((card) => card.title));
  assert.deepEqual(await titles(), []);
  const item = board.addBacklog({ title: 'Fresh card', by: 'board' });
  assert.ok(item.id);
  assert.ok((await titles()).includes('Fresh card'));
  // the store itself, not the board, changed: the board is told with refresh()
  new BacklogStore(home).add({ title: 'Outside card', by: 'board' });
  board.refresh();
  assert.ok((await titles()).includes('Outside card'));
});

test('an approved story whose branch moved and was then deleted stays approved on the board, as on the page', async () => {
  const home = tmp('board-deleted-tip');
  const checkout = checkoutOf('widgets', 'feat/told');
  const approved = 'a'.repeat(40);
  localStory(home, 'local-told', checkout, 'feat/told', {
    built_at: iso(NOW.getTime() - 20 * 60000),
    head_oid: approved,
  });
  writeJson(path.join(home, 'state', 'local-told', 'review.json'), {
    approval: { at: iso(NOW.getTime() - 60000), head_oid: approved, base_oid: null },
  });
  let answer: { tip: string | null; killed: boolean } = { tip: 'b'.repeat(40), killed: false };
  const asked: string[] = [];
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => NOW,
    tipOf: async (repo, ref) => {
      asked.push(`${repo} ${ref}`);
      return answer;
    },
  });
  const column = async () =>
    (await board.snapshot()).lanes
      .flatMap((lane) => lane.cards)
      .find((card) => card.story?.id === 'local-told')?.column;
  const age = () =>
    board['tips'].set(`${checkout}\0HEAD`, {
      ...board['tips'].get(`${checkout}\0HEAD`)!,
      at: 0,
      asking: false,
    });
  assert.equal(await column(), 'ship');
  assert.equal(
    await until(column, (found) => found === 'ready', 5),
    'ready',
    'the branch moved: the approval lapsed',
  );
  // a look killed under load keeps the last tip
  answer = { tip: null, killed: true };
  age();
  const before = asked.length;
  await board.rebuild(); // a build is what asks for the tip again
  await until(
    () => asked.length,
    (count) => count > before,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await column(), 'ready', 'a killed look says nothing: the lapse stays');
  // the branch is deleted: git has no such ref, the approval stands
  answer = { tip: null, killed: false };
  age();
  await board.rebuild();
  assert.equal(
    await until(column, (found) => found === 'ship', 5),
    'ship',
    'a ref git cannot resolve leaves the approval standing',
  );
});

test('a closed board no longer invalidates on a background change', async () => {
  const home = tmp('board-closed');
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => NOW,
  });
  await board.snapshot();
  announceChange();
  assert.equal(board['cache'], null, 'an open board drops its snapshot on a background change');
  await board.snapshot();
  assert.ok(board['cache'], 'built again');
  board.close();
  announceChange();
  assert.ok(board['cache'], 'a closed board keeps its snapshot');
});
