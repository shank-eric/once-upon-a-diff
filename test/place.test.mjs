import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmp, git, localRepo, githubStory, writeJson, startBridge } from './helpers.mjs';
import { createLocalStory } from '../bridge/stories/local-story.mjs';
import { StoryStore } from '../bridge/stories/store.mjs';
import { seenCheckout } from '../bridge/config/repos.mjs';
import {
  mainCheckout,
  excludeStories,
  readIndex,
  adoptHomeStories,
} from '../bridge/stories/placement.mjs';
import { isStoryDir } from '../bridge/stories/meta.mjs';

const BIN = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../bridge/bin/diff-story.mjs',
);
const status = (repo) => git(repo, 'status', '--porcelain');
const exclude = (repo) => readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');

test('a local story lives in the checkout it diffs, kept out of git by .git/info/exclude', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const made = createLocalStory({ home, repo, base, head: 'HEAD' });
  assert.equal(realpathSync(made.dir), realpathSync(path.join(repo, '.diff-story', made.id)));
  assert.ok(existsSync(path.join(made.dir, 'local.diff')));
  assert.equal(status(repo), '', 'git status stays clean');
  assert.match(exclude(repo), /^\/\.diff-story\/$/m);
  createLocalStory({ home, repo, base, head: 'HEAD' });
  assert.equal(exclude(repo).match(/\.diff-story/g).length, 1, 'the exclude line is added once');
  assert.ok(!existsSync(path.join(home, made.id)), 'nothing in ~/.diff-story but state');
  assert.equal(readIndex(home)[made.id], made.dir, 'the index maps the id to its folder');
  const bridge = await startBridge({ home });
  try {
    assert.equal((await bridge.call('GET', `/api/stories/${made.id}`)).body.kind, 'local');
    await bridge.call('POST', `/api/stories/${made.id}/viewed`, { path: 'one.txt', viewed: true });
    assert.ok(
      existsSync(path.join(home, 'state', made.id, 'viewed.json')),
      'state stays in ~/.diff-story',
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
    /\/\.diff-story\//,
    'one exclude covers the checkout and its worktrees',
  );
  assert.equal(realpathSync(mainCheckout(worktree)), realpathSync(repo));
});

test('a PR story published to ~/.diff-story moves into the repo checkout once it is known, and a new render follows', () => {
  const home = tmp('home');
  const { repo } = localRepo();
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  githubStory(path.join(home, 'acme-widgets-7'));
  writeJson(path.join(home, 'state', 'acme-widgets-7', 'ui.json'), { n: 2 });
  const store = new StoryStore({ home, scratch: false });
  assert.equal(
    store.dirOf('acme-widgets-7'),
    path.join(home, 'acme-widgets-7'),
    'no checkout known: it stays put',
  );

  seenCheckout(home, 'acme/widgets', repo);
  adoptHomeStories(home, { isStoryDir, force: true });
  const inRepo = path.join(realpathSync(repo), '.diff-story', 'acme-widgets-7');
  assert.ok(existsSync(path.join(inRepo, 'chapters.json')));
  assert.ok(!existsSync(path.join(home, 'acme-widgets-7')));
  assert.equal(store.dirOf('acme-widgets-7'), inRepo);
  assert.equal(status(repo), '');
  assert.ok(
    existsSync(path.join(home, 'state', 'acme-widgets-7', 'ui.json')),
    "its state didn't move",
  );

  githubStory(path.join(home, 'acme-widgets-7')); // pr-story renders again into ~/.diff-story
  writeFileSync(
    path.join(home, 'acme-widgets-7', 'chapters.json'),
    JSON.stringify({ title: 'Re-rendered', chapters: [] }),
  );
  adoptHomeStories(home, { isStoryDir, force: true });
  assert.equal(
    JSON.parse(readFileSync(path.join(inRepo, 'chapters.json'), 'utf8')).title,
    'Re-rendered',
    'the newer render wins',
  );
  assert.ok(!existsSync(path.join(home, 'acme-widgets-7')));
});

test('diff-story publish writes into the checkout, and --root folders are read in place', async () => {
  const home = tmp('home');
  const { repo } = localRepo();
  seenCheckout(home, 'acme/widgets', repo);
  const src = tmp('scratch');
  githubStory(src);
  const out = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [BIN, 'publish', '--dir', src],
      { env: { ...process.env, DIFF_STORY_HOME: home } },
      (err, stdout) => resolve(err ? `ERR ${err.message}` : stdout.trim()),
    ),
  );
  assert.equal(realpathSync(out), realpathSync(path.join(repo, '.diff-story', 'acme-widgets-7')));
  assert.equal(status(repo), '');

  const root = tmp('root');
  githubStory(path.join(root, 'acme-widgets-8'));
  const store = new StoryStore({ home, roots: [root], scratch: false });
  assert.equal(store.dirOf('acme-widgets-8'), path.join(root, 'acme-widgets-8'));
  assert.ok(existsSync(path.join(root, 'acme-widgets-8')));
  assert.equal(
    excludeStories(tmp('not-a-repo')),
    false,
    "outside a checkout there's nothing to exclude",
  );
});
