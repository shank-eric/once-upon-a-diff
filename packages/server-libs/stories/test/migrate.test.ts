import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { git, localRepo } from '@once-upon-a-diff/test-kit/git';
import { githubStory } from '@once-upon-a-diff/test-kit/stories';
import { createLocalStory } from '../src/local-story.ts';
import { legacyProblem, legacyStories, migrateStories, moveStoryFolder } from '../src/migrate.ts';
import { indexFile, readIndex, recordedKind } from '../src/placement.ts';
import { StoryStore } from '../src/store.ts';

/** A story folder as an older version kept it: in <repo>/.once-upon/<id>, named in the index, with its kind recorded. */
function legacy(home: string, repo: string, id: string, build: (dir: string) => void): string {
  const dir = path.join(repo, '.once-upon', id);
  mkdirSync(dir, { recursive: true });
  build(dir);
  writeJson(indexFile(home), { ...readIndex(home), [id]: dir });
  return dir;
}
const prStory = (dir: string) => githubStory(dir, { meta: { head_oid: 'a'.repeat(40) } });
const modeOf = (file: string) => (statSync(file).mode & 0o777).toString(8);

/** A local story made as an older version did, then placed in the checkout. */
function legacyLocal(home: string, repo: string, base: string): { id: string; dir: string } {
  const staged = tmp('staged-home');
  const made = createLocalStory({ home: staged, repo, base, head: 'HEAD' });
  const dir = legacy(home, repo, made.id, () => {});
  renameSync(made.dir, dir);
  return { id: made.id, dir };
}

test('migration moves a legacy PR story and a legacy local story into the home, owner-only, and serves them from there', () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const pr = legacy(home, repo, 'acme-widgets-7', prStory);
  const local = legacyLocal(home, repo, base);
  const before = new StoryStore({ home });
  assert.equal(before.dirOf('acme-widgets-7'), null, 'a folder in a checkout is not served');
  assert.equal(legacyStories(home).length, 2);
  const result = migrateStories(home);
  assert.deepEqual([...result.moved].sort(), ['acme-widgets-7', local.id].sort());
  assert.deepEqual(result.skipped, []);
  assert.ok(!existsSync(pr) && !existsSync(local.dir), 'moved, not copied');
  assert.deepEqual(readIndex(home), {}, 'the index entries are dropped');
  assert.equal(new StoryStore({ home }).dirOf('acme-widgets-7'), path.join(home, 'acme-widgets-7'));
  assert.equal(new StoryStore({ home }).dirOf(local.id), path.join(home, local.id));
  assert.equal(modeOf(path.join(home, 'acme-widgets-7')), '700');
  assert.equal(recordedKind(home, 'acme-widgets-7'), 'github');
  assert.equal(
    JSON.parse(readFileSync(path.join(home, local.id, 'meta.json'), 'utf8')).kind,
    'local',
  );
});

test('a second migration finds nothing outside the home and changes nothing', () => {
  const home = tmp('home');
  const { repo } = localRepo();
  legacy(home, repo, 'acme-widgets-7', prStory);
  assert.equal(migrateStories(home).moved.length, 1);
  const index = readFileSync(indexFile(home), 'utf8');
  assert.deepEqual(migrateStories(home), { moved: [], skipped: [] });
  assert.equal(readFileSync(indexFile(home), 'utf8'), index);
  assert.deepEqual(migrateStories(tmp('empty-home')), { moved: [], skipped: [] });
});

test('a legacy folder a branch tracks files in is left, flagged and not served', () => {
  const home = tmp('home');
  const { repo } = localRepo();
  const dir = legacy(home, repo, 'acme-widgets-7', prStory);
  git(repo, 'add', '-f', '.once-upon');
  git(repo, 'commit', '-q', '-m', 'track a story');
  const result = migrateStories(home);
  assert.deepEqual(result.moved, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.why, /a branch tracks files/);
  assert.ok(existsSync(path.join(dir, 'chapters.json')), 'left where it was');
  assert.ok(!existsSync(path.join(home, 'acme-widgets-7')));
  assert.equal(readIndex(home)['acme-widgets-7'], dir, 'the entry stays so doctor can name it');
  assert.equal(new StoryStore({ home }).dirOf('acme-widgets-7'), null);
});

/** Tracks `<path>` in the checkout's index only, as a PR branch checked out over a case-insensitive filesystem does. */
function trackIndexOnly(repo: string, file: string): void {
  const sha = git(repo, 'hash-object', '-w', '/dev/null').trim();
  git(repo, 'update-index', '--add', '--cacheinfo', `100644,${sha},${file}`);
}

test('a branch tracking the folder under another letter case (.ONCE-UPON/<id>/...) is refused too', () => {
  const home = tmp('home');
  const { repo } = localRepo();
  const dir = legacy(home, repo, 'acme-widgets-7', prStory);
  const other = legacy(home, repo, 'acme-widgets-8', prStory);
  trackIndexOnly(repo, '.ONCE-UPON/acme-widgets-7/chapters.json');
  trackIndexOnly(repo, '.once-upon/ACME-WIDGETS-8/chapters.json');
  const result = migrateStories(home);
  assert.deepEqual(result.moved, []);
  assert.equal(result.skipped.length, 2);
  for (const one of result.skipped) {
    assert.match(one.why, /a branch tracks files/);
  }
  assert.ok(
    existsSync(path.join(dir, 'chapters.json')) && existsSync(path.join(other, 'chapters.json')),
  );
  assert.ok(!existsSync(path.join(home, 'acme-widgets-7')));
});

test('moveStoryFolder moves one folder of a checkout the index never named, through the same checks', () => {
  const home = tmp('home');
  const { repo } = localRepo();
  const dir = path.join(repo, '.once-upon', 'acme-widgets-7');
  prStory(dir);
  assert.equal(moveStoryFolder(home, dir), null);
  assert.ok(existsSync(path.join(home, 'acme-widgets-7', 'chapters.json')) && !existsSync(dir));
  assert.ok(!existsSync(path.join(home, 'acme-widgets-7', 'acme-widgets-7')), 'no nesting');
  assert.equal(recordedKind(home, 'acme-widgets-7'), 'github');

  const again = path.join(repo, '.once-upon', 'acme-widgets-7');
  prStory(again);
  assert.match(moveStoryFolder(home, again) ?? '', /is already there/);
  assert.ok(existsSync(again) && !existsSync(path.join(home, 'acme-widgets-7', 'acme-widgets-7')));

  const tracked = path.join(repo, '.once-upon', 'acme-widgets-8');
  prStory(tracked);
  trackIndexOnly(repo, '.ONCE-UPON/acme-widgets-8/chapters.json');
  assert.match(moveStoryFolder(home, tracked) ?? '', /a branch tracks files/);

  const linked = path.join(repo, '.once-upon', 'acme-widgets-9');
  prStory(linked);
  rmSync(path.join(linked, 'chapters.json'));
  symlinkSync(path.join(again, 'chapters.json'), path.join(linked, 'chapters.json'));
  assert.match(moveStoryFolder(home, linked) ?? '', /symbolic link/);
  assert.ok(existsSync(tracked) && existsSync(linked));
  assert.ok(
    !existsSync(path.join(home, 'acme-widgets-8')) &&
      !existsSync(path.join(home, 'acme-widgets-9')),
  );

  assert.match(moveStoryFolder(home, path.join(home, 'acme-widgets-7')) ?? '', /not a .once-upon/);
});

test('a legacy folder with a meta.json that fails the checks, or a recorded kind it differs from, is left', () => {
  const home = tmp('home');
  const { repo } = localRepo();
  const bad = legacy(home, repo, 'acme-widgets-7', prStory);
  writeJson(path.join(bad, 'meta.json'), { kind: 'weird' });
  const flipped = legacy(home, repo, 'acme-widgets-8', prStory);
  writeJson(path.join(home, 'story-kinds.json'), { 'acme-widgets-8': 'local' });
  const result = migrateStories(home);
  assert.deepEqual(result.moved, []);
  assert.equal(result.skipped.length, 2);
  assert.match(result.skipped.find((one) => one.dir === bad)!.why, /kind/);
  assert.match(result.skipped.find((one) => one.dir === flipped)!.why, /is not the local/);
  assert.ok(existsSync(bad) && existsSync(flipped));
});

test('a legacy folder that is a symbolic link, or holds one, is refused and never followed', () => {
  const home = tmp('home');
  const { repo } = localRepo();
  const target = tmp('target');
  prStory(target);
  const linked = path.join(repo, '.once-upon', 'acme-widgets-7');
  mkdirSync(path.dirname(linked), { recursive: true });
  symlinkSync(target, linked);
  const inner = legacy(home, repo, 'acme-widgets-8', prStory);
  rmSync(path.join(inner, 'chapters.json'));
  symlinkSync(path.join(target, 'chapters.json'), path.join(inner, 'chapters.json'));
  writeJson(indexFile(home), { ...readIndex(home), 'acme-widgets-7': linked });
  const result = migrateStories(home);
  assert.deepEqual(result.moved, []);
  assert.equal(result.skipped.length, 2);
  for (const one of result.skipped) {
    assert.match(one.why, /symbolic link/);
  }
  assert.ok(existsSync(path.join(target, 'chapters.json')), 'the link target is untouched');
  assert.ok(
    !existsSync(path.join(home, 'acme-widgets-7')) &&
      !existsSync(path.join(home, 'acme-widgets-8')),
  );
});

test('a story already in the home wins: the legacy copy is left and reported', () => {
  const home = tmp('home');
  const { repo } = localRepo();
  prStory(path.join(home, 'acme-widgets-7'));
  writeJson(path.join(home, 'acme-widgets-7', 'chapters.json'), {
    title: 'Home one',
    chapters: [],
  });
  const dir = legacy(home, repo, 'acme-widgets-7', prStory);
  const result = migrateStories(home);
  assert.deepEqual(result.moved, []);
  assert.match(result.skipped[0]!.why, /already there/);
  assert.equal(
    JSON.parse(readFileSync(path.join(home, 'acme-widgets-7', 'chapters.json'), 'utf8')).title,
    'Home one',
  );
  assert.ok(existsSync(dir));
  assert.match(legacyProblem(home, { id: 'acme-widgets-7', dir }) as string, /already there/);
});

test('the migration waits for the index lock another process holds, then moves', async () => {
  const home = tmp('home');
  const { repo } = localRepo();
  legacy(home, repo, 'acme-widgets-7', prStory);
  const script = path.join(tmp('lock-script'), 'hold.ts');
  const lockModule = new URL(import.meta.resolve('@once-upon-a-diff/adapters/stores/fs/lock'))
    .pathname;
  const place = new URL('../src/placement.ts', import.meta.url).pathname;
  writeFileSync(
    script,
    `import { withLock } from ${JSON.stringify(lockModule)};
import { indexFile } from ${JSON.stringify(place)};
withLock(indexFile(process.argv[2]), () => {
  process.stdout.write('held\\n');
  const until = Date.now() + 1200;
  while (Date.now() < until) { /* hold */ }
});`,
  );
  const child = execFile(process.execPath, [script, home], { timeout: 30_000 });
  await new Promise<void>((resolve) => {
    child.stdout!.once('data', () => resolve());
  });
  const started = Date.now();
  const result = migrateStories(home);
  assert.ok(Date.now() - started >= 600, 'it waited for the holder');
  assert.deepEqual(result.moved, ['acme-widgets-7']);
  await new Promise((resolve) => child.once('exit', resolve));
});
