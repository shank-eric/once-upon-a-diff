import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { buildFor, reviewFor } from '../src/features/sessions/listening.ts';
import { createLocalStory, isStoryless, reviewBranch } from '../src/records/stories/local-story.ts';
import { git, tmp, writeJson } from './helpers.ts';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';

/*
 * Build story and Review on the cards that have no story yet: a finished author's commit in Ready for your review (its
 * own agent card, typed into the session that launched it) and a work card's branch with no PR.
 */

const REQUEST =
  'Build the Once Upon story of the unpushed commits on branch feat/x in `/wt/feat-x`';

const agentCard = (over: Partial<BoardCard> = {}): BoardCard =>
  ({
    id: 'agent:aaaaaaaa:ou-commit',
    kind: 'agent',
    title: 'ou-commit',
    repo: null,
    branch: null,
    lane: 'acme/widgets',
    column: 'ready',
    story: null,
    pr: null,
    sessions: [],
    agents: [],
    focus_session: 'launcher',
    can_focus: true,
    review: { branch: 'feat/x', path: '/wt/feat-x' },
    ...over,
  }) as BoardCard;

const session = (over: Partial<BoardCard['sessions'][number]> = {}) =>
  ({
    id: 'in-repo',
    cwd: '/wt/feat-x/src',
    branch: 'feat/x',
    focus: true,
    ...over,
  }) as BoardCard['sessions'][number];

const workCard = (over: Partial<BoardCard> = {}): BoardCard =>
  ({
    id: 'branch:acme/widgets@feat/x',
    kind: 'work',
    title: 'feat/x',
    repo: 'acme/widgets',
    branch: 'feat/x',
    lane: 'acme/widgets',
    column: 'working',
    story: null,
    pr: null,
    sessions: [session()],
    agents: [],
    focus_session: 'in-repo',
    can_focus: true,
    ...over,
  }) as BoardCard;

const localStory = (over: Partial<NonNullable<BoardCard['story']>> = {}) => ({
  id: 'local-feat-x',
  kind: 'local' as const,
  url: null,
  reviewed: false,
  unread: false,
  unread_answers: 0,
  approved_at: null,
  ship: null,
  ...over,
});

test('Build story on a Ready agent card types a plain request naming the branch and its worktree into the launching session', () => {
  assert.deepEqual(buildFor(agentCard(), new Set(['launcher'])), {
    session: 'launcher',
    prompt: REQUEST,
    blocked: null,
  });
  assert.doesNotMatch(
    REQUEST,
    /^\//,
    'a request, not the slash command: the launcher decides who runs the skill',
  );
  assert.deepEqual(buildFor(agentCard(), new Set()), {
    session: null,
    prompt: REQUEST,
    blocked: 'session busy',
  });
  assert.deepEqual(buildFor(agentCard({ can_focus: false }), new Set(['launcher'])), {
    session: null,
    prompt: REQUEST,
    blocked: 'no iTerm tab',
  });
  assert.deepEqual(buildFor(agentCard({ focus_session: null, can_focus: false }), new Set()), {
    session: null,
    prompt: REQUEST,
    blocked: 'its session has ended',
  });
  assert.equal(buildFor(agentCard({ review: null }), new Set(['launcher'])), null, 'no branch');
  assert.equal(
    buildFor(
      agentCard({ review: { branch: 'feat/x', path: '/wt/x\n/rm' } }),
      new Set(['launcher']),
    ),
    null,
    'a path that would type a second line is never typed',
  );
  assert.equal(
    buildFor(agentCard({ review: { branch: 'feat x;', path: '/wt/x' } }), new Set(['launcher'])),
    null,
  );
  // the path is quoted, so a space in it can't end it; anything else that would break the line or the quote is refused
  assert.equal(
    buildFor(
      agentCard({ review: { branch: 'feat/x', path: '/wt/my tree' } }),
      new Set(['launcher']),
    )?.prompt,
    'Build the Once Upon story of the unpushed commits on branch feat/x in `/wt/my tree`',
  );
  for (const bad of [
    '/wt/a\tb',
    '/wt/a\u2028b',
    '/wt/a\u2029b',
    '/wt/a\u0085b',
    '/wt/a\u00a0b',
    '/wt/a`b',
    '/wt/a\u009bb',
  ]) {
    assert.equal(
      buildFor(agentCard({ review: { branch: 'feat/x', path: bad } }), new Set(['launcher'])),
      null,
      JSON.stringify(bad),
    );
  }
});

test('a storyless review on a work card still offers Build story; a told story does not', () => {
  const idle = new Set(['in-repo']);
  assert.equal(
    buildFor(workCard({ story: localStory({ storyless: true }) }), idle)?.session,
    'in-repo',
  );
  assert.equal(buildFor(workCard({ story: localStory() }), idle), null);
});

test('Review on a work or session card: a branch with no story and no PR, in the checkout of a session on that branch', () => {
  assert.deepEqual(reviewFor(workCard()), { branch: 'feat/x', path: '/wt/feat-x/src' });
  // a storyless review keeps Review, so a moved branch can be reviewed again (re-pinned to its tip)
  assert.deepEqual(reviewFor(workCard({ story: localStory({ storyless: true }) })), {
    branch: 'feat/x',
    path: '/wt/feat-x/src',
  });
  assert.deepEqual(
    reviewFor(
      workCard({
        story: localStory({ storyless: true }),
        sessions: [],
        review: { branch: 'feat/x', path: '/wt/feat-x' },
      }),
    ),
    { branch: 'feat/x', path: '/wt/feat-x' },
    'no session on it: the story’s own checkout',
  );
  assert.deepEqual(
    reviewFor(workCard({ kind: 'session', id: 'in-repo' })),
    { branch: 'feat/x', path: '/wt/feat-x/src' },
    'a session alone on a branch with no PR or story',
  );
  assert.equal(reviewFor(workCard({ story: localStory() })), null, 'it has a story: Open story');
  assert.equal(
    reviewFor(workCard({ pr: { number: 7 } as BoardCard['pr'] })),
    null,
    'GitHub has its diff',
  );
  assert.equal(
    reviewFor(workCard({ branch: 'main', sessions: [session({ branch: 'main' })] })),
    null,
  );
  assert.equal(
    reviewFor(workCard({ sessions: [session({ branch: 'feat/y' })] })),
    null,
    'no session on the branch: no checkout known',
  );
  assert.equal(reviewFor(agentCard()), null, 'an agent card’s review is placement’s');
  assert.equal(
    reviewFor(workCard(), (repo, branch) => repo === 'acme/widgets' && branch === 'feat/x'),
    null,
    'a branch whose work shipped (merged or superseded) has nothing to review',
  );
});

test('storyless is only what Review made: a by-folder story told with chapters, or one made by hand, keeps Approve', () => {
  const home = tmp('storyless-home');
  const fixture = worktreeFixture();
  const dir = fixture.add('feat/x');
  fixture.commit(dir, 'x one');
  const made = reviewBranch({ home, path: dir, branch: 'feat/x' });
  assert.equal(isStoryless(made.dir), true);
  // a rebuild that starts from the published chapters.json carries its mode: told, it is a story
  const served = JSON.parse(readFileSync(path.join(made.dir, 'chapters.json'), 'utf8'));
  assert.equal(served.mode, 'by-folder');
  const told = path.join(tmp('told'), 'chapters.json');
  writeJson(told, {
    ...served,
    chapters: served.chapters.map((chapter: { narrative: string }) => ({
      ...chapter,
      refs: [],
      narrative: 'Told.',
    })),
  });
  createLocalStory({ home, repo: dir, base: 'main', head: 'feat/x', id: made.id, chapters: told });
  assert.equal(isStoryless(made.dir), false, 'told over the same id');
  assert.notEqual(
    JSON.parse(readFileSync(path.join(made.dir, 'chapters.json'), 'utf8')).mode,
    'by-folder',
    'the carried mode is dropped, so a skeleton is still being written',
  );
  // a by-folder fallback made by hand (once-upon local with no chapters) is not a Review
  const other = fixture.add('feat/y');
  fixture.commit(other, 'y one');
  const byHand = createLocalStory({ home, repo: other, base: 'main', head: 'feat/y' });
  assert.equal(isStoryless(byHand.dir), false);
});

test('a leftover storyless mark counts only while the story is pinned to the sha Review pinned it to', () => {
  const home = tmp('storyless-pin-home');
  const fixture = worktreeFixture();
  const dir = fixture.add('feat/z');
  fixture.commit(dir, 'z one');
  const made = reviewBranch({ home, path: dir, branch: 'feat/z' });
  const pinned = JSON.parse(readFileSync(path.join(made.dir, 'storyless.json'), 'utf8'));
  assert.equal(pinned.head_oid, git(dir, 'rev-parse', 'HEAD'), 'the mark names the pinned sha');
  assert.equal(isStoryless(made.dir), true);
  // the same id told by hand over HEAD (a reused branch name, or once-upon local with no chapters): not storyless
  createLocalStory({ home, repo: dir, base: 'main', head: 'HEAD', id: made.id });
  assert.equal(isStoryless(made.dir), false, 'following HEAD is not the pinned review');
  // pinned again by hand to a newer tip: not the sha Review pinned, so it has Approve
  fixture.commit(dir, 'z two', 2);
  createLocalStory({ home, repo: dir, base: 'main', head: 'feat/z', id: made.id });
  assert.equal(isStoryless(made.dir), false, 'another sha');
  // Review again re-pins to the tip and marks it
  reviewBranch({ home, path: dir, branch: 'feat/z' });
  assert.equal(isStoryless(made.dir), true);
});
