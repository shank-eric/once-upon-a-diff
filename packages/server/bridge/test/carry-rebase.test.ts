import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { git, localRepo, runCli, tmp, writeJson } from './helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readApproval } from '@once-upon-a-diff/stories/approval';
import { AutoReview } from '@once-upon-a-diff/core/features/review/github-watcher';
import { localEntries } from '@once-upon-a-diff/core/features/review/story-lists';

// An approved story whose branch is rebased by hand keeps its approval when no patch changed.

/** An approved story pinned to `feature` (two commits over `base`), with `main` at base. */
async function approvedWorld() {
  const home = tmp('home');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('sessions') });
  const { repo, base } = localRepo();
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  git(repo, 'branch', 'main', base);
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, {
    title: 'Two commits',
    chapters: [
      { refs: [], title: 'C', narrative: 'Told.', files: ['one.txt', 'lib/two.js', 'gone.txt'] },
    ],
  });
  const { id } = createLocalStory({ home, repo, base, head: 'feature', chapters });
  assert.equal((await runCli(home, ['approve', id])).code, 0);
  const store = new StoryStore({ home });
  const first = git(repo, 'rev-parse', 'HEAD');
  // main moves on with an unrelated commit
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(path.join(repo, 'other.txt'), 'other\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'main moves');
  git(repo, 'checkout', '-q', 'feature');
  const check = async () => {
    const now = Date.now();
    const review = new AutoReview(store, async () => ({ merged: false, why: null }), 0);
    review.kickLocal(localEntries(store, { now }), now);
    await review.idle();
  };
  return { repo, id, store, first, check };
}

test('a hand rebase onto a newer base changes no patch: the approval moves to the new head', async () => {
  const { repo, id, store, first, check } = await approvedWorld();
  const was = readApproval(store, id);
  git(repo, 'rebase', '-q', 'main');
  const tip = git(repo, 'rev-parse', 'HEAD');
  assert.notEqual(tip, first);
  await check();
  const now = readApproval(store, id);
  assert.equal(now?.head_oid, tip);
  assert.ok(!now?.lapsed);
  assert.equal(now?.carried?.via, 'rebase');
  assert.equal(now?.carried?.from, first);
  assert.equal(now?.at, was?.at);
});

test('a rebase that also rewords a commit still carries (the patch is the same)', async () => {
  const { repo, id, store, check } = await approvedWorld();
  git(repo, 'rebase', '-q', 'main');
  git(repo, 'commit', '-q', '--amend', '-m', 'add two, reworded');
  const tip = git(repo, 'rev-parse', 'HEAD');
  await check();
  assert.equal(readApproval(store, id)?.head_oid, tip);
});

test('a rebase that edits a commit’s patch lapses the approval', async () => {
  const { repo, id, store, check } = await approvedWorld();
  git(repo, 'rebase', '-q', 'main');
  writeFileSync(path.join(repo, 'lib/two.js'), 'export const two = 22;\n');
  git(repo, 'commit', '-q', '-a', '--amend', '--no-edit');
  await check();
  assert.equal(readApproval(store, id)?.lapsed, true);
});

test('a rebase that drops a commit, or a new commit on top, lapses the approval', async () => {
  const dropped = await approvedWorld();
  git(dropped.repo, 'rebase', '-q', 'main');
  git(dropped.repo, 'reset', '-q', '--hard', 'HEAD~1');
  await dropped.check();
  assert.equal(readApproval(dropped.store, dropped.id)?.lapsed, true);

  const added = await approvedWorld();
  writeFileSync(path.join(added.repo, 'extra.txt'), 'x\n');
  git(added.repo, 'add', '.');
  git(added.repo, 'commit', '-q', '-m', 'extra');
  await added.check();
  assert.equal(readApproval(added.store, added.id)?.lapsed, true);
});

test('a hand rebase with an extra commit inserted below the approved ones lapses the approval', async () => {
  const { repo, id, store, check } = await approvedWorld();
  git(repo, 'rebase', '-q', 'main');
  const rebased = git(repo, 'rev-parse', 'HEAD');
  // rebuild the branch as main + an unreviewed commit + the two approved patches
  git(repo, 'checkout', '-q', '-B', 'feature', 'main');
  writeFileSync(path.join(repo, 'extra.txt'), 'x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'extra');
  git(repo, 'cherry-pick', `${rebased}~1`, rebased);
  await check();
  assert.equal(readApproval(store, id)?.lapsed, true);
});
