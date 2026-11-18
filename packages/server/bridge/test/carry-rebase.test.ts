import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { git, localRepo, runCli, tmp, writeJson } from './helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readApproval } from '@once-upon-a-diff/stories/approval';
import { storyData } from '@once-upon-a-diff/stories/story-data';
import { AutoReview } from '@once-upon-a-diff/core/features/review/github-watcher';
import { localEntries } from '@once-upon-a-diff/core/features/review/story-lists';

// An approved story whose branch is rebased by hand keeps its approval when no patch changed.

/** An approved story pinned to `feature` (two commits over `base`), with `main` at base. */
async function approvedWorld(told?: string) {
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
  const { id } = createLocalStory({ home, repo, base: told ?? base, head: 'feature', chapters });
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
  const { repo, id, store, first, check } = await approvedWorld();
  git(repo, 'rebase', '-q', 'main');
  writeFileSync(path.join(repo, 'lib/two.js'), 'export const two = 22;\n');
  git(repo, 'commit', '-q', '-a', '--amend', '--no-edit');
  const tip = git(repo, 'rev-parse', 'HEAD');
  await check();
  const lapsed = readApproval(store, id);
  assert.equal(lapsed?.lapsed, true);
  assert.deepEqual(lapsed?.lapse?.changes, [
    { kind: 'edited', sha: tip, subject: 'add two', was: first },
  ]);
  assert.equal(lapsed?.lapse?.tip, tip);
  // the story page's data names the changed commit, and has no approval
  const { local } = storyData(store, id, store.dirOf(id)!);
  assert.equal(local?.approved, null);
  assert.deepEqual(local?.lapse?.changes, [
    { kind: 'edited', sha: tip, subject: 'add two', was: first },
  ]);
});

test('a lapse with nothing to compare stores no lapse field', async () => {
  const { repo, id, store, check } = await approvedWorld();
  // the approval's base commit is gone from the record: nothing can be compared, the approval still lapses
  const file = path.join(store.home, 'state', id, 'review.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.approval.base_oid = null;
  writeFileSync(file, JSON.stringify(record));
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'more');
  await check();
  const lapsed = readApproval(store, id);
  assert.equal(lapsed?.lapsed, true);
  assert.equal('lapse' in (lapsed ?? {}), false);
  assert.equal(storyData(store, id, store.dirOf(id)!).local?.lapse, undefined);
});

test('a rebase onto origin/main while local main is stale lists no upstream commit as added', async () => {
  // told over `main`, so the lapse must not take that stale ref as the base just because it is named first
  const { repo, id, store, first, check } = await approvedWorld('main');
  // origin/main is two commits ahead of the stale local main; the branch is rebased onto it and one patch is edited
  git(repo, 'checkout', '-q', 'main');
  for (const name of ['up-one.txt', 'up-two.txt']) {
    writeFileSync(path.join(repo, name), `${name}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', `upstream ${name}`);
  }
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'reset', '-q', '--hard', 'HEAD~2');
  git(repo, 'checkout', '-q', 'feature');
  git(repo, 'rebase', '-q', 'refs/remotes/origin/main');
  writeFileSync(path.join(repo, 'lib/two.js'), 'export const two = 22;\n');
  git(repo, 'commit', '-q', '-a', '--amend', '--no-edit');
  const tip = git(repo, 'rev-parse', 'HEAD');
  await check();
  const lapsed = readApproval(store, id);
  assert.equal(lapsed?.lapsed, true);
  assert.deepEqual(lapsed?.lapse?.changes, [
    { kind: 'edited', sha: tip, subject: 'add two', was: first },
  ]);
});

test('a branch reset to its base lapses with every approved commit dropped', async () => {
  const { repo, id, store, check } = await approvedWorld();
  git(repo, 'reset', '-q', '--hard', 'main');
  await check();
  const lapsed = readApproval(store, id);
  assert.equal(lapsed?.lapsed, true);
  assert.deepEqual(
    lapsed?.lapse?.changes.map((change) => change.kind),
    ['dropped', 'dropped'],
  );
});

test('a rebase that drops a commit, or a new commit on top, lapses the approval', async () => {
  const dropped = await approvedWorld();
  git(dropped.repo, 'rebase', '-q', 'main');
  git(dropped.repo, 'reset', '-q', '--hard', 'HEAD~1');
  await dropped.check();
  assert.equal(readApproval(dropped.store, dropped.id)?.lapsed, true);
  assert.deepEqual(
    readApproval(dropped.store, dropped.id)?.lapse?.changes.map((change) => [
      change.kind,
      change.subject,
    ]),
    [['dropped', 'add two']],
  );

  const added = await approvedWorld();
  writeFileSync(path.join(added.repo, 'extra.txt'), 'x\n');
  git(added.repo, 'add', '.');
  git(added.repo, 'commit', '-q', '-m', 'extra');
  await added.check();
  assert.equal(readApproval(added.store, added.id)?.lapsed, true);
  assert.deepEqual(
    readApproval(added.store, added.id)?.lapse?.changes.map((change) => [
      change.kind,
      change.subject,
    ]),
    [['added', 'extra']],
  );
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
  assert.deepEqual(
    readApproval(store, id)?.lapse?.changes.map((change) => [change.kind, change.subject]),
    [['added', 'extra']],
  );
});

test('a rebase that swaps the approved commits lapses the approval and names the one that moved', async () => {
  const { repo, id, store, check } = await approvedWorld();
  git(repo, 'rebase', '-q', 'main');
  const rebased = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-B', 'feature', 'main');
  git(repo, 'cherry-pick', rebased, `${rebased}~1`);
  await check();
  const lapsed = readApproval(store, id);
  assert.equal(lapsed?.lapsed, true);
  assert.deepEqual(
    lapsed?.lapse?.changes.map((change) => change.kind),
    ['reordered'],
  );
});
