import '@once-upon-a-diff/test-kit/env';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { git, localRepo } from '@once-upon-a-diff/test-kit/git';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { markQuestions } from '@once-upon-a-diff/state/queues/requests/conversation';
import { Board, noPrWatcher } from '../src/board.ts';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { type BranchPr } from '@once-upon-a-diff/state/records/github/github-checks';
import { AutoReview } from '@once-upon-a-diff/core/features/review/github-watcher';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import {
  localEntries,
  localStories,
  LOCAL_IDLE_DAYS,
} from '@once-upon-a-diff/core/features/review/story-lists';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { forgetTips } from '@once-upon-a-diff/stories/approval';
import { refreshLocal } from '@once-upon-a-diff/stories/local-diff';
import { type LocalMeta } from '@once-upon-a-diff/stories/types';
import {
  NOW,
  checkoutOf,
  liveChild,
  localStory,
  prStory,
  registry,
  reviewedBy,
} from '@once-upon-a-diff/state/test/board-fixtures';
import { fakeWatcher, prInfo, sourceSaying } from './board-fixtures.ts';

const metaOf = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>;

/** A local story whose checkout is a real repo (an origin of acme/<name>), told at `builtAt`, with the given heads. */
function builtLocal(
  home: string,
  id: string,
  checkout: string,
  branch: string,
  builtAt: string,
  extra: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
) {
  localStory(home, id, checkout, branch, { built_at: builtAt, ...extra }, state);
}

const DAY = 24 * 3600 * 1000;

const iso = (time: number) => new Date(time).toISOString();

test('local stories older than the story window are not listed', () => {
  const home = tmp('board-inbox');
  const widgets = checkoutOf('widgets', 'feat/x');
  localStory(home, 'local-old', widgets, 'feat/old');
  const old = new Date(NOW.getTime() - 40 * 24 * 3600 * 1000);
  for (const file of ['meta.json', 'chapters.json']) {
    utimesSync(path.join(home, 'local-old', file), old, old);
  }
  localStory(home, 'local-new', widgets, 'feat/new');
  const found = localStories(new StoryStore({ home }), { now: Date.now() });
  assert.deepEqual(
    found.map((story) => story.id),
    ['local-new'],
  );
});

test('a local story’s built time is when it was told: a refresh of its diff is not a rebuild', async () => {
  const home = tmp('board-inbox');
  const { repo, base } = localRepo();
  const first = createLocalStory({ home, repo, base, head: 'HEAD' });
  const store = new StoryStore({ home });
  const told = metaOf(first.dir).built_at as string;
  assert.ok(told, 'once-upon local records it');
  assert.equal(localStories(store)[0].built_at, told);
  // HEAD moves and a page remakes local.diff and meta.json: newer files, the same story
  await new Promise((resolve) => setTimeout(resolve, 15));
  writeFileSync(path.join(repo, 'one.txt'), 'a\nB\nc\nd\ne\n');
  git(repo, 'commit', '-q', '-am', 'one more');
  const raw = metaOf(first.dir);
  const refreshed = refreshLocal(first.dir, raw as unknown as LocalMeta);
  assert.notEqual(refreshed.head_oid, raw.head_oid, 'the diff was remade');
  assert.ok(Number(store.list()[0].version) > Date.parse(told), 'the folder looks newer');
  assert.equal(refreshed.built_at, told, 'the refresh keeps it');
  assert.equal(localStories(store)[0].built_at, told, 'so it is not a new build');
  // a rebuild (once-upon local again) is
  await new Promise((resolve) => setTimeout(resolve, 15));
  createLocalStory({ home, repo, base, head: 'HEAD', id: first.id });
  const rebuilt = localStories(store)[0].built_at;
  assert.ok(Date.parse(rebuilt) > Date.parse(told), 'a rebuild is a new build');
  // a story made before built_at was kept falls back to its files' time
  const old = new Date(NOW.getTime() - 40 * 24 * 3600 * 1000);
  const meta = metaOf(first.dir);
  delete meta.built_at;
  writeJson(path.join(first.dir, 'meta.json'), meta);
  for (const file of ['meta.json', 'chapters.json', 'local.diff']) {
    utimesSync(path.join(first.dir, file), old, old);
  }
  assert.deepEqual(
    localStories(store, { now: Date.now() }),
    [],
    'older than the window by its files',
  );
});

test('the board: a local story puts its branch in Ready for your review, rebuilt after you opened it too, and makes a branch-only card', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const [onX] = [liveChild()];
  after(() => onX.stop());
  const widgetsX = checkoutOf('widgets', 'feat/x');
  const widgetsMain = checkoutOf('widgets', 'main');
  const elsewhere = tmp('board-no-repo');
  // a session on feat/x, which has a local story; no PR
  registry(sessions, onX.pid, { cwd: widgetsX, name: 'on-x' }, onX.procStart);
  localStory(home, 'local-feat-x', widgetsX, 'feat/x');
  // branch-only cards: unreviewed, and reviewed then rebuilt; and ones that give no card
  localStory(home, 'local-feat-new', widgetsMain, 'feat/new');
  const opened = { 'position.json': { at: '2026-10-26T10:00:00Z' } }; // opened before it was built (the file was written now)
  localStory(home, 'local-feat-rebuilt', widgetsMain, 'feat/rebuilt', {}, opened);
  const byHand = { 'reviewed.json': { at: '2026-10-26T14:00:00Z', by: 'manual' } };
  localStory(
    home,
    'local-feat-done',
    widgetsMain,
    'feat/done',
    {},
    { ...byHand, 'position.json': { at: '2099-01-01T00:00:00Z' } },
  );
  // commits on a default branch, or a range with no branch: a card of their own while they wait for review
  localStory(home, 'local-main', widgetsMain, 'main');
  localStory(home, 'local-detached', widgetsMain, null);
  localStory(
    home,
    'local-main-done',
    widgetsMain,
    'main',
    {},
    {
      ...byHand,
      'position.json': { at: '2099-01-01T00:00:00Z' },
    },
  );
  localStory(home, 'local-norepo', elsewhere, 'feat/y'); // no GitHub repo: no card
  localStory(home, 'turn-abc', widgetsMain, null, { turn: 'abc' });
  // a PR story on feat/pr wins over a local one of the same branch
  prStory(home, 'acme-widgets-5', 'acme/widgets', 5, 'feat/pr');
  localStory(home, 'local-feat-pr', widgetsMain, 'feat/pr');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const { watcher } = fakeWatcher([prInfo(5, { branch: 'feat/pr' })]);
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  const byId = Object.fromEntries(cards.map((found) => [found.id, found]));
  assert.deepEqual(Object.fromEntries(cards.map((found) => [found.id, found.column])), {
    'branch:acme/widgets@feat/x': 'ready', // the session joins it; the story is unreviewed
    'branch:acme/widgets@feat/new': 'ready',
    'branch:acme/widgets@feat/rebuilt': 'ready', // rebuilt since you opened it: a local story is never in Back to you
    'pr:acme/widgets#5': 'pr_open', // the PR story on the branch wins, on GitHub's side
    'story:local-main': 'ready',
    'story:local-detached': 'ready',
  });
  const withSession = byId['branch:acme/widgets@feat/x'];
  assert.equal(withSession.kind, 'work');
  assert.deepEqual(
    withSession.sessions.map((one) => one.title),
    ['on-x'],
  );
  assert.equal(withSession.pr, null);
  assert.deepEqual(withSession.story, {
    id: 'local-feat-x',
    kind: 'local',
    url: null,
    reviewed: false,
    unread: false,
    unread_answers: 0,
    approved_at: null,
  });
  assert.equal(withSession.lane, 'acme/widgets');
  assert.equal(withSession.build, null, 'it has a story: nothing to build');
  const branchOnly = byId['branch:acme/widgets@feat/new'];
  assert.equal(branchOnly.title, 'Story of local-feat-new');
  assert.equal(branchOnly.branch, 'feat/new');
  assert.equal(branchOnly.sessions.length, 0);
  assert.ok(branchOnly.since, 'ready since it was built');
  assert.equal(byId['branch:acme/widgets@feat/rebuilt'].story?.unread, true);
  assert.equal(
    byId['pr:acme/widgets#5'].story?.id,
    'acme-widgets-5',
    'a PR story is the card’s story',
  );
  assert.equal(byId['pr:acme/widgets#5'].story?.kind, 'pr');
  // a reviewed one, no repo and a story left by turn capture are not cards
  for (const gone of ['feat/done', 'feat/y']) {
    assert.ok(!cards.some((found) => found.branch === gone), gone);
  }
  assert.ok(!cards.some((found) => found.id === 'story:local-main-done'), 'reviewed: no card');
  assert.equal(cards.length, 6, 'the six above, nothing else');
});

test('the board: a session on a branch whose PR merged long ago is a card of its own, not on the branch’s old local story', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const child = liveChild();
  after(() => child.stop());
  const checkout = checkoutOf('widgets', 'feat/old');
  registry(sessions, child.pid, { cwd: checkout, name: 'new-work' }, child.procStart);
  localStory(home, 'local-feat-old', checkout, 'feat/old');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const mergedAt = new Date(NOW.getTime() - 5 * 24 * 3600 * 1000).toISOString();
  const { watcher } = fakeWatcher([], {
    'acme/widgets@feat/old': { number: 9, state: 'merged', merged_at: mergedAt },
  });
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: registrySource,
    now: () => NOW,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  assert.deepEqual(
    cards.map((found) => [found.kind, found.title]),
    [['session', 'new-work']],
  );
});

test('a card whose branch has a local story: an open storyteller holds it in Agent checks, then the story is Ready for your review, approved is Ready to ship, a new head is Ready again, and a silent storyteller holds nothing', async () => {
  for (const name of ['once-upon-a-diff', 'widgets']) {
    const home = tmp('board-storyteller');
    const checkout = checkoutOf(name, 'feat/told');
    const store = new BacklogStore(home);
    const item = store.add({ title: 'Told', repo: `acme/${name}` });
    store.start(item.id, { branch: 'feat/told' });
    const registered = new AgentRegistry(home);
    const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60000);
    registered.start({
      name: 'tell-x',
      sid: 'abcdef01',
      kind: 'storyteller',
      card: item.id,
      task: 't',
      at: later(-30),
    });
    builtLocal(home, 'local-told', checkout, 'feat/told', later(-20).toISOString(), {
      head_oid: 'a'.repeat(40),
    });
    const stories = new StoryStore({ home });
    const columnAt = async (minutes: number) => {
      const cards = (
        await new Board(home, stories, noPrWatcher, new Builds(home), {
          source: registrySource,
          now: () => later(minutes),
        }).snapshot()
      ).lanes.flatMap((lane) => lane.cards);
      const mine = cards.filter((card) => card.story?.id === 'local-told');
      assert.equal(mine.length, 1, name);
      assert.deepEqual(
        mine[0].from_backlog?.map((one) => one.id),
        [item.id],
      );
      return mine[0].column;
    };
    // open and alive: the story is being told
    assert.equal(await columnAt(0), 'checks', name);
    // silent for over 24 hours: a dead storyteller holds nothing
    assert.equal(await columnAt(24 * 60), 'ready', `${name}: dead`);
    // finished: the story is up and not approved
    registered.finish('tell-x', { sid: 'abcdef01', state: 'done', at: later(-5) });
    assert.equal(await columnAt(0), 'ready', name);
    // approved for the head
    writeJson(path.join(home, 'state', 'local-told', 'approved.json'), {
      at: later(-1).toISOString(),
      head_oid: 'a'.repeat(40),
      base_oid: null,
      marked: true,
    });
    writeJson(path.join(home, 'state', 'local-told', 'reviewed.json'), {
      at: later(-1).toISOString(),
      by: 'approved',
    });
    assert.equal(await columnAt(0), 'ship', name);
    // a new commit moves the head: back in Ready for your review
    writeJson(path.join(home, 'local-told', 'meta.json'), {
      kind: 'local',
      repo_path: checkout,
      repo_name: name,
      base: 'origin/main',
      head: 'HEAD',
      branch: 'feat/told',
      title: 'Local local-told',
      built_at: later(-20).toISOString(),
      head_oid: 'b'.repeat(40),
    });
    assert.equal(await columnAt(0), 'ready', name);
  }
});

test('a story approved at a head the branch has left is Ready for your review, even while its meta still names the approved head; approved at the branch tip it stays Ready to ship', async () => {
  const home = tmp('board-approved-head');
  const checkout = checkoutOf('widgets', 'feat/told');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'first');
  const approvedHead = git(checkout, 'rev-parse', 'HEAD').trim();
  builtLocal(home, 'local-told', checkout, 'feat/told', iso(NOW.getTime() - 20 * 60000), {
    head_oid: approvedHead,
  });
  const stories = new StoryStore({ home });
  writeJson(path.join(home, 'state', 'local-told', 'approved.json'), {
    at: iso(NOW.getTime() - 60000),
    head_oid: approvedHead,
    base_oid: null,
    marked: true,
  });
  writeJson(path.join(home, 'state', 'local-told', 'reviewed.json'), {
    at: iso(NOW.getTime() - 60000),
    by: 'approved',
  });
  const columnOf = async () => {
    const cards = (
      await new Board(home, stories, noPrWatcher, new Builds(home), {
        source: registrySource,
        now: () => NOW,
      }).snapshot()
    ).lanes.flatMap((lane) => lane.cards);
    return cards.find((card) => card.story?.id === 'local-told')?.column;
  };
  // the branch is still at the approved head
  assert.equal(await columnOf(), 'ship');
  // a fix round amends the branch: meta.json has not been refreshed (no page is polling), the approval still names the old head
  git(checkout, 'commit', '-q', '--allow-empty', '--amend', '-m', 'first, fixed');
  assert.notEqual(git(checkout, 'rev-parse', 'HEAD').trim(), approvedHead);
  forgetTips(); // where the branch is stays known for 2 s
  assert.equal(await columnOf(), 'ready');
});

test('an approved story whose ref git cannot resolve (the branch deleted, the checkout gone) stays Ready to ship', async () => {
  const home = tmp('board-approved-unresolvable');
  const checkout = checkoutOf('widgets', 'feat/told');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'first');
  const approvedHead = git(checkout, 'rev-parse', 'HEAD').trim();
  builtLocal(home, 'local-gone', checkout, 'feat/told', iso(NOW.getTime() - 20 * 60000), {
    head_oid: approvedHead,
  });
  const stories = new StoryStore({ home });
  writeJson(path.join(home, 'state', 'local-gone', 'approved.json'), {
    at: iso(NOW.getTime() - 60000),
    head_oid: approvedHead,
    base_oid: null,
    marked: true,
  });
  const approvedAt = () => localEntries(stories, { now: NOW.getTime() })[0].story.approved_head;
  forgetTips();
  assert.equal(approvedAt(), approvedHead);
  git(checkout, 'checkout', '-q', '--detach');
  git(checkout, 'branch', '-q', '-D', 'feat/told');
  forgetTips();
  assert.equal(approvedAt(), approvedHead, 'the branch is deleted');
  rmSync(checkout, { recursive: true, force: true });
  forgetTips();
  assert.equal(approvedAt(), approvedHead, 'the checkout is gone');
});

test('local stories: nothing opened, read, marked or rebuilt for 3 days is done (idle), computed and never written; a hand mark or unmark wins', () => {
  assert.equal(LOCAL_IDLE_DAYS, 3);
  const home = tmp('local-idle');
  const widgets = checkoutOf('widgets', 'feat/x');
  const now = Date.parse('2026-10-28T15:00:00Z');
  builtLocal(home, 'local-quiet', widgets, 'feat/quiet', iso(now - 4 * DAY));
  builtLocal(home, 'local-recent', widgets, 'feat/recent', iso(now - 2 * DAY));
  // opened a day ago: the clock runs from then
  builtLocal(
    home,
    'local-opened',
    widgets,
    'feat/opened',
    iso(now - 5 * DAY),
    {},
    {
      'position.json': { at: iso(now - DAY) },
    },
  );
  // unmarked by hand: left alone, however quiet
  builtLocal(
    home,
    'local-unmarked',
    widgets,
    'feat/unmarked',
    iso(now - 6 * DAY),
    {},
    {
      'reviewed.json': { at: null, by: 'manual' },
    },
  );
  builtLocal(
    home,
    'local-hand',
    widgets,
    'feat/hand',
    iso(now - 6 * DAY),
    {},
    {
      'reviewed.json': { at: iso(now - 5 * DAY), by: 'manual' },
    },
  );
  const byId = Object.fromEntries(
    localStories(new StoryStore({ home }), { now }).map((story) => [story.id, story]),
  );
  assert.equal(byId['local-quiet'].reviewed_by, 'idle');
  assert.equal(byId['local-quiet'].reviewed_at, iso(now - DAY), 'done since the cutoff passed');
  assert.equal(byId['local-recent'].reviewed_at, null);
  assert.equal(byId['local-opened'].reviewed_at, null);
  assert.equal(byId['local-unmarked'].reviewed_at, null);
  assert.equal(byId['local-hand'].reviewed_by, 'manual');
  assert.equal(reviewedBy(home, 'local-quiet'), null, 'idle is worked out, not written');
  // a day later the opened one has gone quiet too
  const later = localStories(new StoryStore({ home }), { now: now + 2 * DAY + 1 });
  assert.equal(later.find((story) => story.id === 'local-opened')?.reviewed_by, 'idle');
  assert.equal(later.find((story) => story.id === 'local-unmarked')?.reviewed_at, null);
});

test('local stories: a branch with a PR (open or merged) is done by pr, a default branch is not asked, a hand mark or unmark is left alone', async () => {
  const home = tmp('local-pr');
  const widgets = checkoutOf('widgets', 'feat/x');
  const now = Date.now();
  const built = iso(now - 1000);
  builtLocal(home, 'local-open', widgets, 'feat/open', built);
  builtLocal(home, 'local-merged', widgets, 'feat/merged', built);
  builtLocal(home, 'local-none', widgets, 'feat/none', built);
  builtLocal(home, 'local-main', widgets, 'main', built);
  builtLocal(
    home,
    'local-unmarked',
    widgets,
    'feat/open2',
    built,
    {},
    {
      'reviewed.json': { at: null, by: 'manual' },
    },
  );
  const asked: string[] = [];
  const answers: Record<string, BranchPr | null> = {
    'acme/widgets@feat/open': { number: 1, state: 'open', merged_at: null },
    'acme/widgets@feat/merged': { number: 2, state: 'merged', merged_at: built },
    'acme/widgets@feat/open2': { number: 3, state: 'open', merged_at: null },
  };
  const stories = new StoryStore({ home });
  const review = new AutoReview(
    stories,
    async () => ({ merged: false, why: null }),
    60000,
    async (repo, branch) => {
      asked.push(`${repo}@${branch}`);
      return answers[`${repo}@${branch}`] ?? null;
    },
  );
  const list = () => localEntries(stories, { now });
  review.kickLocal(list(), now); // asks GitHub; it answers a moment later
  await review.idle();
  assert.equal(reviewedBy(home, 'local-open'), null, 'not on the first ask');
  review.kickLocal(list(), now);
  await review.idle();
  assert.equal(reviewedBy(home, 'local-open'), 'pr');
  assert.equal(reviewedBy(home, 'local-merged'), 'pr');
  assert.equal(reviewedBy(home, 'local-none'), null);
  assert.equal(reviewedBy(home, 'local-main'), null);
  assert.ok(!asked.includes('acme/widgets@main'), 'a default branch has no PR to ask for');
  const unmarked = stories.readState<{ at: string | null } | null>(
    'local-unmarked',
    'reviewed.json',
    null,
  );
  assert.equal(unmarked?.at, null, 'an unmark by hand is left alone');
  assert.ok(!asked.includes('acme/widgets@feat/open2'), 'it is not even asked about');
  const inbox = localStories(stories, { now });
  assert.equal(inbox.find((story) => story.id === 'local-open')?.reviewed_by, 'pr');
});

test('local stories: a head already in origin’s default branch is done by delivered; a head not there, a missing ref, or a story with no commits of its own is not', async () => {
  const home = tmp('local-delivered');
  const repo = tmp('local-delivered-repo');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'merged work');
  const merged = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', merged);
  git(repo, 'checkout', '-q', '-b', 'feat/unmerged');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'not merged');
  const unmerged = git(repo, 'rev-parse', 'HEAD');
  const bare = tmp('local-delivered-bare'); // no origin ref at all
  git(bare, 'init', '-q', '-b', 'main');
  git(bare, 'remote', 'add', 'origin', 'git@github.com:acme/gadgets.git');
  git(bare, 'commit', '-q', '--allow-empty', '-m', 'only');
  const only = git(bare, 'rev-parse', 'HEAD');
  const now = Date.now();
  const built = iso(now - 1000);
  builtLocal(home, 'local-in', repo, 'main', built, { base_oid: base, head_oid: merged });
  builtLocal(home, 'local-out', repo, 'feat/unmerged', built, {
    base_oid: base,
    head_oid: unmerged,
  });
  builtLocal(home, 'local-norefs', bare, 'main', built, {
    base_oid: only.slice(0, 1).repeat(40),
    head_oid: only,
  });
  builtLocal(home, 'local-empty', repo, 'main', built, { base_oid: merged, head_oid: merged });
  builtLocal(home, 'local-nohead', repo, 'main', built, {});
  const stories = new StoryStore({ home });
  const review = new AutoReview(
    stories,
    async () => ({ merged: false, why: null }),
    60000,
    async () => null,
  );
  review.kickLocal(localEntries(stories, { now }), now);
  await review.idle();
  assert.equal(reviewedBy(home, 'local-in'), 'delivered');
  assert.equal(reviewedBy(home, 'local-out'), null);
  assert.equal(
    reviewedBy(home, 'local-norefs'),
    null,
    'git answers 128 for a missing ref: not done',
  );
  assert.equal(reviewedBy(home, 'local-empty'), null);
  assert.equal(reviewedBy(home, 'local-nohead'), null);
});

test('local stories: commits rewritten and pushed straight to the default branch are delivered, only with the base in it, no ref holding the head, and nothing unpushed', async () => {
  const home = tmp('local-rewritten');
  const now = Date.now();
  const built = iso(now - 1000);
  /** A checkout whose story commit was then amended; `push` says whether the amended commit is origin's tip. */
  const checkoutOf = (name: string, push: boolean) => {
    const repo = tmp(`local-rewritten-${name}`);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', base);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'the story commit');
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '--amend', '-m', 'the story commit, reworded');
    if (push) {
      git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    }
    return { repo, base, head };
  };
  const pushed = checkoutOf('pushed', true);
  const unpushed = checkoutOf('unpushed', false);
  const feature = checkoutOf('feature', true);
  builtLocal(home, 'local-rewritten', pushed.repo, 'main', built, {
    base_oid: pushed.base,
    head_oid: pushed.head,
  });
  builtLocal(home, 'local-unpushed', unpushed.repo, 'main', built, {
    base_oid: unpushed.base,
    head_oid: unpushed.head,
  });
  builtLocal(home, 'local-feature', feature.repo, 'feat/branch', built, {
    base_oid: feature.base,
    head_oid: feature.head,
  });
  const stories = new StoryStore({ home });
  const review = new AutoReview(
    stories,
    async () => ({ merged: false, why: null }),
    60000,
    async () => null,
  );
  review.kickLocal(localEntries(stories, { now }), now);
  await review.idle();
  assert.equal(reviewedBy(home, 'local-rewritten'), 'delivered');
  assert.equal(reviewedBy(home, 'local-unpushed'), null, 'the amended commit is not pushed yet');
  assert.equal(reviewedBy(home, 'local-feature'), null, 'a branch story is the PR’s to clear');
});

test('the board: a local story rebuilt after you opened it stays in Ready, and one a check marked done (pr, delivered, idle) stays done through a rebuild', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const widgets = checkoutOf('widgets', 'main');
  const opened = { 'position.json': { at: '2026-10-26T10:00:00Z' } }; // before it was built (the file is made now)
  const marked = (reason: string) => ({
    'reviewed.json': { at: '2026-10-26T11:00:00Z', by: reason },
    ...opened,
  });
  localStory(home, 'local-hand', widgets, 'feat/hand', {}, marked('manual'));
  localStory(home, 'local-pr', widgets, 'feat/pr', {}, marked('pr'));
  localStory(home, 'local-delivered', widgets, 'feat/delivered', {}, marked('delivered'));
  localStory(home, 'local-idle', widgets, 'feat/idle', {}, opened);
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const { watcher, asked } = fakeWatcher();
  const later = new Date(Date.now() + 5 * DAY); // idle by then: a rebuild is what would have brought it back
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => later,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  assert.deepEqual(
    Object.fromEntries(cards.map((found) => [found.id, [found.column, found.story?.unread]])),
    { 'branch:acme/widgets@feat/hand': ['ready', true] },
    'a hand mark does not survive a rebuild; the three automatic ones do',
  );
  assert.deepEqual(asked.locals.sort(), [
    'local-delivered',
    'local-hand',
    'local-idle',
    'local-pr',
  ]);
});

test('the board: an unread answer keeps a reviewed local story in Ready and sends a PR card to Back to you, until it is read', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const widgets = checkoutOf('widgets', 'main');
  // reviewed by hand and opened long after it was built: no card, but for the answer
  const done = {
    'reviewed.json': { at: '2026-10-26T14:00:00Z', by: 'manual' },
    'position.json': { at: '2099-01-01T00:00:00Z' },
  };
  localStory(home, 'local-answered', widgets, 'feat/answered', {}, done);
  localStory(home, 'local-quiet', widgets, 'feat/quiet', {}, done);
  prStory(home, 'acme-widgets-5', 'acme/widgets', 5, 'feat/pr');
  const inbox = new Inbox(home);
  for (const story of ['local-answered', 'acme-widgets-5']) {
    inbox.append({ type: 'question', id: `q_${story}`, story, text: 'Why?', step: 1 });
    inbox.append({ type: 'answer', question: `q_${story}`, story, text: 'Because.' });
  }
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const snapshot = async () => {
    const { watcher } = fakeWatcher([prInfo(5, { branch: 'feat/pr' })]);
    const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
      source: sourceSaying({}),
      now: () => NOW,
    });
    const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
    return Object.fromEntries(cards.map((found) => [found.id, found]));
  };
  let byId = await snapshot();
  assert.equal(byId['branch:acme/widgets@feat/answered'].column, 'ready');
  assert.equal(byId['branch:acme/widgets@feat/answered'].story?.unread_answers, 1);
  assert.equal(byId['pr:acme/widgets#5'].column, 'back');
  assert.equal(byId['pr:acme/widgets#5'].story?.unread_answers, 1);
  assert.equal(byId['branch:acme/widgets@feat/quiet'], undefined, 'no answer, nothing to review');

  markQuestions(home, 'local-answered', 'read', ['q_local-answered']);
  markQuestions(home, 'acme-widgets-5', 'read', ['q_acme-widgets-5']);
  byId = await snapshot();
  assert.equal(byId['branch:acme/widgets@feat/answered'], undefined, 'read: the card goes');
  assert.equal(byId['pr:acme/widgets#5'].column, 'pr_open');
  assert.equal(byId['pr:acme/widgets#5'].story?.unread_answers, 0);
});

test('the board: a PR card whose branch has a local story shows how many commits it is ahead of GitHub, and a PR with no local story is left alone', async () => {
  const home = tmp('board-home');
  const widgets = checkoutOf('widgets', 'main');
  prStory(home, 'acme-widgets-5', 'acme/widgets', 5, 'feat/pr');
  localStory(home, 'local-feat-pr', widgets, 'feat/pr');
  prStory(home, 'acme-widgets-6', 'acme/widgets', 6, 'feat/lonely');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/level');
  localStory(home, 'local-feat-level', widgets, 'feat/level');
  writeJson(path.join(home, 'config.json'), {});
  const { watcher } = fakeWatcher([
    prInfo(5, { branch: 'feat/pr' }),
    prInfo(6, { branch: 'feat/lonely' }),
    prInfo(7, { branch: 'feat/level' }),
  ]);
  const looked: string[] = [];
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    aheadOf: async (checkout, branch) => {
      looked.push(`${checkout}@${branch}`);
      return branch === 'feat/pr' ? 2 : 0;
    },
  });
  const cardsOf = async () =>
    Object.fromEntries(
      (await board.snapshot()).lanes.flatMap((lane) => lane.cards).map((card) => [card.id, card]),
    );
  const first = await cardsOf();
  assert.ok(
    !first['pr:acme/widgets#5'].ahead,
    'the look runs in the background, the snapshot does not wait',
  );
  await new Promise((resolve) => setImmediate(resolve));
  const cards = await cardsOf();
  assert.deepEqual(cards['pr:acme/widgets#5'].ahead, { count: 2, story: 'local-feat-pr' });
  assert.ok(
    !cards['pr:acme/widgets#6'].ahead,
    'no local story of that branch: the board leaves it alone',
  );
  assert.ok(!cards['pr:acme/widgets#7'].ahead, 'nothing ahead: no badge');
  assert.deepEqual([...new Set(looked)].sort(), [`${widgets}@feat/level`, `${widgets}@feat/pr`]);
});
