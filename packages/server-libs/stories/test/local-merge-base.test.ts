import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { git, localRepo } from '@once-upon-a-diff/test-kit/git';
import { createLocalStory } from '../src/local-story.ts';
import { movedSince, refreshLocal } from '../src/local-diff.ts';
import type { LocalMeta } from '../src/types.ts';

// the branch `feature` is two commits over `base`; `main` is made at base, then moves on with a commit of its own
function movedMain() {
  const { repo, base } = localRepo();
  git(repo, 'branch', 'main', base);
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(path.join(repo, 'main-only.txt'), 'from main\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'main moves');
  git(repo, 'checkout', '-q', 'feature');
  return { repo, base };
}

const metaOf = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));

test('local --base tells the commits since the merge-base, not the base ref tip undone', () => {
  const { repo, base } = movedMain();
  const made = createLocalStory({ home: tmp('home'), repo, base: 'main' });
  const diff = readFileSync(path.join(made.dir, 'local.diff'), 'utf8');
  assert.ok(!diff.includes('main-only.txt'), "main's own commit is not in the diff");
  assert.equal(made.files, 3); // one.txt, gone.txt, lib/two.js
  const meta = metaOf(made.dir);
  assert.equal(meta.base_oid, base, 'base_oid is the merge-base used');
  assert.deepEqual(
    meta.commits.map((commit: { subject: string }) => commit.subject),
    ['add two', 'change one'],
  );
});

test('a base that moves after the story was told remakes nothing it should not, and a pinned story is not marked moved', () => {
  const { repo, base } = movedMain();
  const home = tmp('home');
  const followed = createLocalStory({ home, repo, base: 'main' });
  const pinned = createLocalStory({ home, repo, base: 'main', head: 'feature', id: 'pinned' });
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(path.join(repo, 'more.txt'), 'more main\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'main moves again');
  git(repo, 'checkout', '-q', 'feature');
  const next = refreshLocal(followed.dir, metaOf(followed.dir) as LocalMeta);
  assert.equal(next.base_oid, base);
  assert.ok(!readFileSync(path.join(followed.dir, 'local.diff'), 'utf8').includes('more.txt'));
  assert.equal(movedSince(metaOf(pinned.dir) as LocalMeta), null);
});

test('a base that shares no history with the head falls back to the base tip', () => {
  const { repo } = localRepo();
  git(repo, 'checkout', '-q', '--orphan', 'other');
  git(repo, 'rm', '-rfq', '.');
  writeFileSync(path.join(repo, 'x.txt'), 'x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'unrelated');
  const tip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'feature');
  const made = createLocalStory({ home: tmp('home'), repo, base: 'other' });
  assert.equal(metaOf(made.dir).base_oid, tip);
});

test('a branch that landed in its base keeps its told range, so the delivered check does not take it for a story with no commits', () => {
  const { repo, base } = movedMain();
  const made = createLocalStory({ home: tmp('home'), repo, base: 'main' });
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-edit', 'feature');
  git(repo, 'checkout', '-q', 'feature');
  const next = refreshLocal(made.dir, metaOf(made.dir) as LocalMeta);
  assert.equal(next.head_oid, head);
  assert.equal(next.base_oid, base, 'base_oid is not the head itself');
  assert.equal(next.commits?.length, 2);
  assert.equal(metaOf(made.dir).base_oid, base);
});

test('a pinned story told when base_oid was the base tip is not marked moved by the merge-base switch', () => {
  const { repo } = movedMain();
  const pinned = createLocalStory({
    home: tmp('home'),
    repo,
    base: 'main',
    head: 'feature',
    id: 'pinned',
  });
  const meta = { ...metaOf(pinned.dir), base_oid: git(repo, 'rev-parse', 'main') } as LocalMeta;
  assert.equal(movedSince(meta), null);
  const rebased = { ...meta, base_oid: git(repo, 'rev-parse', 'feature~1') } as LocalMeta;
  assert.deepEqual(movedSince(rebased), {
    base_oid: git(repo, 'rev-parse', 'feature~2'),
    head_oid: null,
  });
});
