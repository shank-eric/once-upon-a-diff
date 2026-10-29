import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmp, git, githubStory, localRepo, writeJson, startBridge, TOKEN } from './helpers.ts';
import { createLocalStory } from '../src/stories/local-story.ts';
import { refreshLocal, movedSince } from '../src/stories/local-diff.ts';
import { StoryStore } from '../src/stories/store.ts';
import { pageKey } from '../src/server/page-key.ts';
import { prStories, localStories } from '../src/story-lists/stories.ts';
import type { LocalMeta } from '../src/types.ts';

const metaOf = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as LocalMeta;
const commit = (repo: string, name: string) => {
  writeFileSync(path.join(repo, name), `${name}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', name);
};
const diffOf = (dir: string) => readFileSync(path.join(dir, 'local.diff'), 'utf8');

test('a reviewed.json with no `by` was marked by hand: the inbox says manual, not null', () => {
  const home = tmp('home');
  githubStory(path.join(home, 'acme-widgets-7'));
  writeJson(path.join(home, 'state', 'acme-widgets-7', 'reviewed.json'), {
    at: '2026-10-26T14:00:00Z',
  });
  const store = new StoryStore({ home });
  const [pr] = prStories(store);
  assert.equal(pr.reviewed_at, '2026-10-26T14:00:00Z');
  assert.equal(pr.reviewed_by, 'manual');

  const { repo, base } = localRepo();
  const { id } = createLocalStory({ home, repo, base, head: 'HEAD' });
  writeJson(path.join(home, 'state', id, 'reviewed.json'), { at: '2026-10-26T14:00:00Z' });
  const local = localStories(store).find((one) => one.id === id)!;
  assert.equal(local.reviewed_by, 'manual');
  // an unmarked story still has neither
  writeJson(path.join(home, 'state', id, 'reviewed.json'), { at: null, by: 'manual' });
  const unmarked = localStories(store).find((one) => one.id === id)!;
  assert.equal(unmarked.reviewed_at, null);
  assert.equal(unmarked.reviewed_by, null);
});

test('a story over a branch is pinned to the commits it was told over: a new commit or a restack does not change it', () => {
  const home = tmp('home');
  const { repo, base } = localRepo(); // on feature, two commits above base
  const tip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'stack/1', tip);
  const { id, dir } = createLocalStory({ home, repo, base, head: 'stack/1' });
  const told = diffOf(dir);
  assert.equal(metaOf(dir).head_oid, tip);
  assert.equal(metaOf(dir).base_oid, base);
  assert.equal(movedSince(metaOf(dir)), null, 'nothing has moved yet');

  // a commit on the branch
  git(repo, 'switch', '-q', 'stack/1');
  commit(repo, 'late.txt');
  const later = git(repo, 'rev-parse', 'HEAD');
  assert.equal(refreshLocal(dir, metaOf(dir)).head_oid, tip, 'refresh keeps the stored commit');
  assert.equal(diffOf(dir), told, 'the diff is the one it was told');
  assert.deepEqual(movedSince(metaOf(dir)), { base_oid: null, head_oid: later });

  // a restack: the branch is rebuilt on another base
  git(repo, 'switch', '-q', '-c', 'other', base);
  commit(repo, 'other.txt');
  const other = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', '-f', 'stack/1', other);
  assert.equal(refreshLocal(dir, metaOf(dir)).head_oid, tip);
  assert.equal(diffOf(dir), told);
  assert.deepEqual(movedSince(metaOf(dir)), { base_oid: null, head_oid: other });

  // the page's data carries the notice, with the commits it was told over still drawn
  const data = new StoryStore({ home }).load(id)!;
  assert.equal(data.local!.head_oid, tip);
  assert.deepEqual(data.local!.moved, { base_oid: null, head_oid: other });
  assert.ok(data.local!.files.some((file) => file.rel === 'lib/two.js'));
  assert.ok(!data.local!.files.some((file) => file.rel === 'other.txt'));
  assert.match(data.version, /-m/, 'an open page sees the move');

  // a base that moved is told too
  git(repo, 'branch', '-f', 'stack/1', tip);
  assert.equal(movedSince(metaOf(dir)), null, 'back where it was told');
  git(repo, 'branch', 'mid', base);
  const onBase = createLocalStory({ home, repo, base: 'mid', head: 'stack/1', id: 'by-ref' });
  git(repo, 'branch', '-f', 'mid', tip);
  assert.deepEqual(movedSince(metaOf(onBase.dir)), { base_oid: tip, head_oid: null });
});

test('a pinned story remakes a missing diff from its stored commits, and telling it again takes the new tips', () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  git(repo, 'branch', 'stack/1');
  const first = createLocalStory({ home, repo, base, head: 'stack/1' });
  const told = diffOf(first.dir);
  git(repo, 'switch', '-q', 'stack/1');
  commit(repo, 'late.txt');
  // the diff file is lost (cleaned out of the checkout): it is remade over the stored commits, not the new tip
  rmSync(path.join(first.dir, 'local.diff'));
  refreshLocal(first.dir, metaOf(first.dir));
  assert.equal(diffOf(first.dir), told);
  // once-upon local again is the way to follow it
  const again = createLocalStory({ home, repo, base, head: 'stack/1', id: first.id });
  assert.equal(metaOf(again.dir).head_oid, git(repo, 'rev-parse', 'stack/1'));
  assert.match(diffOf(again.dir), /late\.txt/);
  assert.equal(movedSince(metaOf(again.dir)), null);
});

test('a story over HEAD still follows the checkout', () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const { dir } = createLocalStory({ home, repo, base, head: 'HEAD' });
  commit(repo, 'late.txt');
  const next = refreshLocal(dir, metaOf(dir));
  assert.equal(next.head_oid, git(repo, 'rev-parse', 'HEAD'));
  assert.match(diffOf(dir), /late\.txt/);
  assert.equal(movedSince(metaOf(dir)), null, 'HEAD stories never say moved');
});

test('a commit sha, or HEAD~1, is a snapshot: --head takes it and the story stays on it', () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const sha = git(repo, 'rev-parse', 'HEAD~1');
  const snap = createLocalStory({ home, repo, base, head: sha });
  assert.ok(snap.id.endsWith(sha.slice(0, 9)), snap.id);
  assert.ok(snap.id.length < 40 + 10, 'the id uses a short sha');
  const meta = metaOf(snap.dir);
  assert.equal(meta.branch, null);
  assert.equal(meta.head_oid, sha);
  assert.ok(!diffOf(snap.dir).includes('lib/two.js'), 'the commit after the snapshot is not in it');
  assert.match(meta.title as string, new RegExp(`\\.\\.${sha.slice(0, 9)}$`));
  commit(repo, 'late.txt');
  assert.equal(refreshLocal(snap.dir, meta).head_oid, sha);
  assert.equal(movedSince(meta), null, 'a sha cannot move');
  const rel = createLocalStory({ home, repo, base, head: 'HEAD~1', id: 'rel' });
  assert.equal(metaOf(rel.dir).head_oid, git(repo, 'rev-parse', 'HEAD~1'));
  commit(repo, 'later.txt'); // HEAD~1 now names another commit
  assert.equal(refreshLocal(rel.dir, metaOf(rel.dir)).head_oid, metaOf(rel.dir).head_oid);
  assert.ok(movedSince(metaOf(rel.dir)), 'HEAD~1 is a ref that moved');
});

test('the page polls a version that changes when the pinned branch moves, and its data says moved', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  git(repo, 'branch', 'stack/1');
  const { id } = createLocalStory({ home, repo, base, head: 'stack/1' });
  const bridge = await startBridge({ home });
  try {
    const headers = { Authorization: `Bearer ${pageKey(TOKEN, id)}` };
    const version = async () =>
      (
        await bridge.call<{ version: string }>(
          'GET',
          `/api/stories/${id}/version`,
          undefined,
          headers,
        )
      ).body.version;
    const before = await version();
    assert.doesNotMatch(before, /-m/);
    git(repo, 'switch', '-q', 'stack/1');
    commit(repo, 'late.txt');
    const after = await version();
    assert.match(after, /-m[0-9a-f]{7}/);
    const loaded = await bridge.call<{ local: { moved: { head_oid: string } | null } }>(
      'GET',
      `/api/stories/${id}`,
      undefined,
      headers,
    );
    assert.equal(loaded.body.local.moved?.head_oid, git(repo, 'rev-parse', 'stack/1'));
  } finally {
    await bridge.close();
  }
});
