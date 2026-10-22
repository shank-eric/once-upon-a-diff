import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmp, git, localRepo, githubStory, writeJson, startBridge, runCli } from './helpers.mjs';
import { createLocalStory } from '../src/bridge/stories/local-story.mjs';
import { StoryStore } from '../src/bridge/stories/store.mjs';
import { seenCheckout } from '../src/bridge/config/repos.mjs';
import { mainCheckout, excludeStories, readIndex } from '../src/bridge/stories/placement.mjs';

const status = (repo) => git(repo, 'status', '--porcelain');
const exclude = (repo) => readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');

test('a local story lives in the checkout it diffs, kept out of git by .git/info/exclude', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const made = createLocalStory({ home, repo, base, head: 'HEAD' });
  assert.equal(realpathSync(made.dir), realpathSync(path.join(repo, '.once-upon', made.id)));
  assert.ok(existsSync(path.join(made.dir, 'local.diff')));
  assert.equal(status(repo), '', 'git status stays clean');
  assert.match(exclude(repo), /^\/\.once-upon\/$/m);
  createLocalStory({ home, repo, base, head: 'HEAD' });
  assert.equal(exclude(repo).match(/\.once-upon/g).length, 1, 'the exclude line is added once');
  assert.ok(!existsSync(path.join(home, made.id)), 'nothing in ~/.once-upon but state');
  assert.equal(readIndex(home)[made.id], made.dir, 'the index maps the id to its folder');
  const bridge = await startBridge({ home });
  try {
    assert.equal((await bridge.call('GET', `/api/stories/${made.id}`)).body.kind, 'local');
    await bridge.call('POST', `/api/stories/${made.id}/viewed`, { path: 'one.txt', viewed: true });
    assert.ok(
      existsSync(path.join(home, 'state', made.id, 'viewed.json')),
      'state stays in ~/.once-upon',
    );
  } finally {
    await bridge.close();
  }
});

test("in a worktree, the story goes in the worktree and the exclude in the repo's common git dir", () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const worktree = path.join(tmp('wts'), 'feature-two');
  git(repo, 'worktree', 'add', '-q', '-b', 'two', worktree);
  const made = createLocalStory({ home, repo: worktree, base, head: 'HEAD' });
  assert.equal(realpathSync(path.dirname(path.dirname(made.dir))), realpathSync(worktree));
  assert.equal(status(worktree), '');
  assert.equal(status(repo), '');
  assert.match(
    exclude(repo),
    /\/\.once-upon\//,
    'one exclude covers the checkout and its worktrees',
  );
  assert.equal(realpathSync(mainCheckout(worktree)), realpathSync(repo));
});

test('once-upon publish writes into the checkout with the commits the story was told from', async () => {
  const home = tmp('home');
  const { repo } = localRepo();
  seenCheckout(home, 'acme/widgets', repo);
  const src = tmp('scratch');
  githubStory(src);
  writeJson(path.join(src, 'pr.json'), {
    url: 'https://github.com/acme/widgets/pull/7',
    number: 7,
    title: 'Add widgets',
    headRefOid: 'b'.repeat(40),
    baseRefOid: 'a'.repeat(40),
  });
  const published = await runCli(home, ['publish', '--dir', src]);
  assert.equal(published.code, 0, published.stderr);
  const out = published.stdout.trim();
  assert.equal(realpathSync(out), realpathSync(path.join(repo, '.once-upon', 'acme-widgets-7')));
  assert.equal(status(repo), '');
  const meta = JSON.parse(readFileSync(path.join(out, 'meta.json'), 'utf8'));
  assert.equal(meta.head_oid, 'b'.repeat(40), 'the head the story was told from is kept');
  assert.equal(meta.base_oid, 'a'.repeat(40));
  const store = new StoryStore({ home });
  assert.equal(
    realpathSync(store.dirOf('acme-widgets-7')),
    realpathSync(out),
    'the index finds it',
  );
  assert.equal(
    excludeStories(tmp('not-a-repo')),
    false,
    "outside a checkout there's nothing to exclude",
  );
});

test('the CLI moves an old <checkout>/.diff-story to .once-upon once, with its exclude line and index', async () => {
  const home = tmp('home');
  const { repo } = localRepo();
  const old = path.join(repo, '.diff-story', 'acme-widgets-7');
  githubStory(old);
  const excludeFile = path.join(repo, '.git', 'info', 'exclude');
  mkdirSync(path.dirname(excludeFile), { recursive: true });
  writeFileSync(excludeFile, "# Diff Story Mode's stories (local only)\n/.diff-story/\n");
  writeJson(path.join(home, 'stories.json'), { 'acme-widgets-7': old });
  const first = await runCli(home, ['token']);
  assert.match(first.stderr, /moved .*\.diff-story to .*\.once-upon/);
  const moved = path.join(repo, '.once-upon', 'acme-widgets-7');
  assert.ok(existsSync(moved) && !existsSync(path.join(repo, '.diff-story')));
  assert.equal(readIndex(home)['acme-widgets-7'], moved);
  assert.equal(exclude(repo), "# Once Upon a Diff's stories (local only)\n/.once-upon/\n");
  assert.equal(status(repo), '', 'git status stays clean');
  const second = await runCli(home, ['token']);
  assert.doesNotMatch(second.stderr, /moved/);
});

test('the CLI moves an old <checkout>/.pr-story to .once-upon once, with its exclude line and index', async () => {
  const home = tmp('home');
  const { repo } = localRepo();
  const old = path.join(repo, '.pr-story', 'acme-widgets-8');
  githubStory(old);
  const excludeFile = path.join(repo, '.git', 'info', 'exclude');
  mkdirSync(path.dirname(excludeFile), { recursive: true });
  writeFileSync(excludeFile, "# PR Story's stories (local only)\n/.pr-story/\n");
  writeJson(path.join(home, 'stories.json'), { 'acme-widgets-8': old });
  const first = await runCli(home, ['token']);
  assert.match(first.stderr, /moved .*\.pr-story to .*\.once-upon/);
  const moved = path.join(repo, '.once-upon', 'acme-widgets-8');
  assert.ok(existsSync(moved) && !existsSync(path.join(repo, '.pr-story')));
  assert.equal(readIndex(home)['acme-widgets-8'], moved);
  assert.equal(exclude(repo), "# Once Upon a Diff's stories (local only)\n/.once-upon/\n");
  assert.equal(status(repo), '', 'git status stays clean');
  const second = await runCli(home, ['token']);
  assert.doesNotMatch(second.stderr, /moved/);
});
