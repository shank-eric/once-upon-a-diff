import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmp, git, localRepo, githubStory, writeJson, startBridge, runCli } from './helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { seenCheckout } from '@once-upon-a-diff/foundation/repos';
import { readIndex } from '@once-upon-a-diff/stories/placement';
import type { StoryData } from '@once-upon-a-diff/contracts/types';

const status = (repo: string) => git(repo, 'status', '--porcelain');
const exclude = (repo: string) => readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');

test("a local story lives in the bridge's folder, and nothing is written in the checkout", async () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const made = createLocalStory({ home, repo, base, head: 'HEAD' });
  assert.equal(realpathSync(made.dir), realpathSync(path.join(home, made.id)));
  assert.ok(existsSync(path.join(made.dir, 'local.diff')));
  assert.equal(status(repo), '', 'git status stays clean');
  assert.ok(!existsSync(path.join(repo, '.once-upon')), 'no .once-upon in the checkout');
  assert.ok(
    !existsSync(path.join(repo, '.git', 'info', 'exclude')) || !/once-upon/.test(exclude(repo)),
    'no exclude line written',
  );
  assert.deepEqual(readIndex(home), {}, 'no index entry');
  const bridge = await startBridge({ home });
  try {
    assert.equal(
      (await bridge.call<StoryData>('GET', `/api/stories/${made.id}`)).body.kind,
      'local',
    );
    await bridge.call('POST', `/api/stories/${made.id}/viewed`, { path: 'one.txt', viewed: true });
    assert.ok(
      existsSync(path.join(home, 'state', made.id, 'viewed.json')),
      'state stays in ~/.once-upon',
    );
  } finally {
    await bridge.close();
  }
});

test("in a worktree, the story is in the bridge's folder too and the worktree stays clean", () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const worktree = path.join(tmp('wts'), 'feature-two');
  git(repo, 'worktree', 'add', '-q', '-b', 'two', worktree);
  const made = createLocalStory({ home, repo: worktree, base, head: 'HEAD' });
  assert.equal(realpathSync(path.dirname(made.dir)), realpathSync(home));
  assert.equal(status(worktree), '');
  assert.equal(status(repo), '');
  assert.ok(!existsSync(path.join(worktree, '.once-upon')));
});

test('a story id another checkout made is refused, the first story stays, and an id the bridge uses is refused', () => {
  const home = tmp('home');
  const first = localRepo();
  const made = createLocalStory({ home, repo: first.repo, base: first.base, head: 'HEAD' });
  const other = localRepo();
  assert.throws(
    () => createLocalStory({ home, repo: other.repo, base: other.base, head: 'HEAD', id: made.id }),
    /belongs to .*pass --id/,
  );
  const kept = JSON.parse(readFileSync(path.join(made.dir, 'meta.json'), 'utf8'));
  assert.equal(realpathSync(kept.repo_path), realpathSync(first.repo));
  // the same checkout tells it again without a refusal
  createLocalStory({ home, repo: first.repo, base: first.base, head: 'HEAD' });
  assert.throws(
    () => createLocalStory({ home, repo: first.repo, base: first.base, head: 'HEAD', id: 'state' }),
    /pass another --id/,
  );
});

test("once-upon publish writes into the bridge's folder with the commits the story was told from", async () => {
  const home = tmp('home');
  const { repo } = localRepo();
  seenCheckout(home, 'acme/widgets', repo);
  const src = tmp('scratch');
  githubStory(src);
  writeJson(path.join(src, 'pr.json'), {
    url: 'https://github.com/acme/widgets/pull/7',
    number: 7,
    title: 'Add widgets',
    author: { login: 'octocat' },
    headRefOid: 'b'.repeat(40),
    baseRefOid: 'a'.repeat(40),
  });
  const published = await runCli(home, ['publish', '--dir', src]);
  assert.equal(published.code, 0, published.stderr);
  const out = published.stdout.trim();
  assert.equal(realpathSync(out), realpathSync(path.join(home, 'acme-widgets-7')));
  assert.equal(status(repo), '');
  const meta = JSON.parse(readFileSync(path.join(out, 'meta.json'), 'utf8'));
  assert.equal(meta.head_oid, 'b'.repeat(40), 'the head the story was told from is kept');
  assert.equal(meta.base_oid, 'a'.repeat(40));
  assert.equal(meta.pr_author, 'octocat', "whose PR it is, for Fix before push's own-PR rule");
  const store = new StoryStore({ home });
  assert.equal(
    realpathSync(store.dirOf('acme-widgets-7') as string),
    realpathSync(out),
    'the store finds it',
  );
});
