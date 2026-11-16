import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { CLI_BIN, ROOT } from './script-helpers.ts';
import { tmp, git, localRepo, githubStory, writeJson, startBridge, runCli } from './helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { seenCheckout } from '@once-upon-a-diff/foundation/repos';
import type { StoryData } from '@once-upon-a-diff/contracts/types';

/** A branch that tracks `.once-upon/<id>/` files with other content, checked out in `repo`: what a PR branch can do to a story kept there. */
function checkOutOver(repo: string, id: string): void {
  git(repo, 'checkout', '-q', '-b', 'tamper');
  writeJson(path.join(repo, '.once-upon', id, 'chapters.json'), {
    title: 'TAMPERED',
    chapters: [],
  });
  writeJson(path.join(repo, '.once-upon', id, 'meta.json'), {
    kind: 'github',
    repo: 'evil/evil',
    number: 1,
  });
  git(repo, 'add', '-f', '.once-upon');
  git(repo, 'commit', '-q', '-m', 'track a story');
  git(repo, 'checkout', '-q', '-');
  git(repo, 'checkout', '-q', 'tamper');
}

test('a branch that tracks .once-upon/<id>/ files and is checked out cannot change a PR story the bridge serves', async () => {
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
  assert.equal(
    realpathSync(published.stdout.trim()),
    realpathSync(path.join(home, 'acme-widgets-7')),
    'the story is a folder of the bridge, not of the checkout',
  );
  assert.ok(!existsSync(path.join(repo, '.once-upon')), 'nothing in the checkout');
  checkOutOver(repo, 'acme-widgets-7');
  const bridge = await startBridge({ home });
  try {
    const served = await bridge.call<StoryData>('GET', '/api/stories/acme-widgets-7');
    assert.equal(served.status, 200);
    assert.equal(served.body.title, 'Widgets');
    assert.equal(served.body.kind, 'github');
  } finally {
    await bridge.close();
  }
  assert.equal(new StoryStore({ home }).load('acme-widgets-7')?.title, 'Widgets');
});

test('a branch that tracks .once-upon/<id>/ files cannot change a local story, and git status stays clean of it', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const made = createLocalStory({ home, repo, base, head: 'HEAD' });
  const before = new StoryStore({ home }).load(made.id)?.title;
  assert.ok(before);
  assert.equal(git(repo, 'status', '--porcelain'), '', 'git status is clean');
  checkOutOver(repo, made.id);
  const bridge = await startBridge({ home });
  try {
    const served = await bridge.call<StoryData>('GET', `/api/stories/${made.id}`);
    assert.equal(served.status, 200);
    assert.equal(served.body.title, before);
    assert.equal(served.body.kind, 'local');
  } finally {
    await bridge.close();
  }
});

/** A story an older version kept in <repo>/.once-upon/<id>, named in the index. */
function legacyStory(home: string, repo: string): string {
  const dir = path.join(repo, '.once-upon', 'acme-widgets-7');
  githubStory(dir, { meta: { head_oid: 'a'.repeat(40) } });
  writeJson(path.join(home, 'stories.json'), { 'acme-widgets-7': dir });
  return dir;
}

test('once-upon setup moves a legacy story into the home and says so, and any other command does it quietly first', async () => {
  const home = tmp('home');
  const { repo } = localRepo();
  const dir = legacyStory(home, repo);
  const setup = await runCli(home, ['setup']);
  assert.equal(setup.code, 0, setup.stderr);
  assert.match(setup.stdout, /Story folders: moved 1 to /);
  assert.ok(existsSync(path.join(home, 'acme-widgets-7', 'chapters.json')));
  assert.ok(!existsSync(dir));

  const other = tmp('home');
  const second = localRepo().repo;
  legacyStory(other, second);
  const listed = await runCli(other, ['list']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stderr, /moved 1 story folder into /);
  assert.match(listed.stdout, /acme-widgets-7/);
  assert.ok(existsSync(path.join(other, 'acme-widgets-7', 'meta.json')));
});

test('a legacy story a branch tracks files in stays in its checkout, is not served, and setup names it', async () => {
  const home = tmp('home');
  const { repo } = localRepo();
  const dir = legacyStory(home, repo);
  git(repo, 'add', '-f', '.once-upon');
  git(repo, 'commit', '-q', '-m', 'track a story');
  const setup = await runCli(home, ['setup']);
  assert.match(setup.stdout, /Story folders: none to move/);
  assert.match(setup.stdout, /left in place, not served: .*a branch tracks files/);
  assert.ok(existsSync(path.join(dir, 'chapters.json')));
  const bridge = await startBridge({ home });
  try {
    assert.equal((await bridge.call('GET', '/api/stories/acme-widgets-7')).status, 404);
  } finally {
    await bridge.close();
  }
});

/** A repo whose ignored `.once-upon/<id>/` story folders live in worktrees on branches already in main, and a way to run the deploy cleanup on one. */
function cleanupFixture() {
  const home = tmp('home');
  const repo = realpathSync(tmp('cleanup-repo'));
  const worktrees = `${repo}-worktrees`;
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(path.join(repo, 'a'), 'a');
  git(repo, 'add', 'a');
  git(repo, 'commit', '-q', '-m', 'one');
  writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '/.once-upon/\n');
  const branch = (name: string) => {
    git(repo, 'worktree', 'add', '-q', '-b', name, path.join(worktrees, name), 'main');
    return path.join(worktrees, name);
  };
  const storyIn = (tree: string, id: string) => {
    const dir = path.join(tree, '.once-upon', id);
    githubStory(dir, { meta: { head_oid: 'a'.repeat(40) } });
    return dir;
  };
  const cleanup = (name: string) =>
    execFileSync(
      'bash',
      [
        '-c',
        `. "${path.join(ROOT, 'scripts/lib/worktree-cleanup.sh')}"; cleanup_landed_worktree "$1" "$2" "$3" main`,
        'bash',
        repo,
        worktrees,
        name,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ONCE_UPON_HOME: home,
          ONCE_UPON_BIN: CLI_BIN,
        },
      },
    );
  return { home, repo, branch, storyIn, cleanup };
}

test('deploy cleanup moves a worktree story folder into the home through the CLI, once, with no <id>/<id> nesting', () => {
  const { home, branch, storyIn, cleanup } = cleanupFixture();
  const tree = branch('ok');
  storyIn(tree, 'acme-widgets-7');
  const said = cleanup('ok');
  assert.match(said, /moved story folder .once-upon\/acme-widgets-7 to /);
  assert.match(said, /removed worktree/);
  assert.ok(existsSync(path.join(home, 'acme-widgets-7', 'chapters.json')));
  assert.ok(!existsSync(path.join(home, 'acme-widgets-7', 'acme-widgets-7')));
  assert.ok(!existsSync(tree));
});

test('deploy cleanup keeps a worktree whose story folder holds a symbolic link or has tracked files, and moves nothing', () => {
  const { home, repo, branch, storyIn, cleanup } = cleanupFixture();
  const linked = branch('linked');
  const dir = storyIn(linked, 'acme-widgets-8');
  rmSync(path.join(dir, 'chapters.json'));
  symlinkSync(path.join(repo, 'a'), path.join(dir, 'chapters.json'));
  const said = cleanup('linked');
  assert.match(
    said,
    /worktree .* kept: its story folder .once-upon\/acme-widgets-8 was not moved: .*symbolic link/,
  );
  assert.ok(existsSync(dir) && !existsSync(path.join(home, 'acme-widgets-8')));

  // a branch that tracks a file in the folder: landed in main, so it checks out with the worktree
  mkdirSync(path.join(repo, '.once-upon', 'acme-widgets-9'), { recursive: true });
  writeFileSync(
    path.join(repo, '.once-upon', 'acme-widgets-9', 'chapters.json'),
    '{"chapters":[]}',
  );
  git(repo, 'add', '-f', '.once-upon');
  git(repo, 'commit', '-q', '-m', 'track a story');
  const tracked = branch('tracked');
  const trackedDir = path.join(tracked, '.once-upon', 'acme-widgets-9');
  writeJson(path.join(trackedDir, 'meta.json'), { kind: 'github', head_oid: 'a'.repeat(40) });
  const kept = cleanup('tracked');
  assert.match(
    kept,
    /kept: its story folder .once-upon\/acme-widgets-9 was not moved: .*a branch tracks files/,
  );
  assert.ok(existsSync(trackedDir) && !existsSync(path.join(home, 'acme-widgets-9')));
});

test('deploy cleanup keeps a worktree whose id is already in the home, and nothing nests', () => {
  const { home, branch, storyIn, cleanup } = cleanupFixture();
  const tree = branch('dup');
  storyIn(tree, 'acme-widgets-7');
  githubStory(path.join(home, 'acme-widgets-7'));
  assert.match(cleanup('dup'), /kept/);
  assert.ok(existsSync(tree));
  assert.ok(!existsSync(path.join(home, 'acme-widgets-7', 'acme-widgets-7')));
});
