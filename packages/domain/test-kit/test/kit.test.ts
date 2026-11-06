import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { git, localRepo, worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { githubStory } from '@once-upon-a-diff/test-kit/stories';

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('tmp makes a distinct, existing folder and writeJson makes the folders above its file', () => {
  const one = tmp('kit');
  assert.ok(existsSync(one));
  assert.notEqual(one, tmp('kit'));
  assert.match(path.basename(one), /^once-upon-kit-/);
  const file = path.join(one, 'a/b/c.json');
  writeJson(file, { ok: true });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ok: true });
});

test('git commits under its own identity and localRepo is a base plus two commits', () => {
  const { repo, base } = localRepo();
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '3');
  assert.equal(git(repo, 'rev-list', '--max-parents=0', 'HEAD'), base);
  assert.equal(git(repo, 'log', '-1', '--format=%an <%ae>'), 'T <t@example.com>');
  assert.ok(!existsSync(path.join(repo, 'gone.txt')));
  assert.ok(existsSync(path.join(repo, 'lib/two.js')));
});

test('worktreeFixture adds a worktree and commits to it', () => {
  const { main, trees, add, commit } = worktreeFixture();
  const dir = add('feature/x');
  assert.equal(path.dirname(dir), trees);
  commit(dir, 'tweak');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'tweak');
  assert.equal(git(main, 'rev-list', '--count', 'main'), '1');
});

test('githubStory writes a two-chapter story for acme/widgets#7, with meta overrides', () => {
  const dir = tmp('story');
  githubStory(dir, { meta: { head_oid: 'abc' } });
  assert.deepEqual(readdirSync(dir).sort(), [
    'chapters.json',
    'file-map.json',
    'meta.json',
    'pr.json',
  ]);
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.repo, 'acme/widgets');
  assert.equal(meta.head_oid, 'abc');
});

test('the kit is a devDependency wherever it is used, never a dependency', () => {
  const names = readdirSync(PACKAGES).flatMap((group) =>
    readdirSync(path.join(PACKAGES, group)).map((name) => path.join(group, name)),
  );
  assert.ok(names.length >= 19, 'the walk finds every package');
  for (const name of names) {
    const file = path.join(PACKAGES, name, 'package.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(
      !manifest.dependencies?.['@once-upon-a-diff/test-kit'],
      `${name} lists the test kit under dependencies`,
    );
  }
});
