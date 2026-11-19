import { test } from 'node:test';
import assert from 'node:assert/strict';
import { halvesNameOnePath, headerPaths, parseUnifiedDiff } from '../src/diff.ts';

test('a diff header’s paths are read whether git quoted them or not', () => {
  assert.deepEqual(headerPaths('diff --git a/src/one.ts b/src/one.ts'), {
    from: 'src/one.ts',
    to: 'src/one.ts',
  });
  // a tab, a quote or a backslash makes git quote the path, and a non-ASCII byte too unless core.quotePath is off
  assert.deepEqual(headerPaths('diff --git "a/x\\ty" "b/x\\ty"'), { from: 'x\ty', to: 'x\ty' });
  assert.deepEqual(headerPaths('diff --git a/old.txt "b/we\\"ird\\\\n\\303\\251.txt"'), {
    from: 'old.txt',
    to: 'we"ird\\né.txt',
  });
  assert.deepEqual(headerPaths('diff --git "a/q\\"s" b/plain.txt'), {
    from: 'q"s',
    to: 'plain.txt',
  });
  assert.equal(headerPaths('diff --git nonsense'), null);
  // a path with " b/" in it splits where both halves name the same path, not at the last " b/"
  // equal halves without b/ on the second are not that split: they fall through to the regex
  assert.deepEqual(headerPaths('diff --git a/dir b/f a/dir b/f'), {
    from: 'dir b/f a/dir',
    to: 'f',
  });
  assert.deepEqual(headerPaths('diff --git a/dir b/file.ts b/dir b/file.ts'), {
    from: 'dir b/file.ts',
    to: 'dir b/file.ts',
  });
});

test('parseUnifiedDiff keeps a quoted path as the file’s own name, and a rename’s old one', () => {
  const parsed = parseUnifiedDiff(
    'diff --git "a/x\\ty" "b/x\\ty"\nrename from "x\\ty"\n--- "a/x\\ty"\n+++ "b/x\\ty"\n@@ -1 +1 @@\n-a\n+b\n' +
      'diff --git a/plain.txt b/plain.txt\n--- a/plain.txt\n+++ b/plain.txt\n@@ -1 +1 @@\n-c\n+d\n',
  );
  assert.deepEqual([...parsed.keys()], ['x\ty', 'plain.txt']);
  assert.equal(parsed.get('x\ty')?.renamed_from, 'x\ty');
  assert.deepEqual(parsed.get('x\ty')?.stats, { added: 1, removed: 1 });
  assert.equal(parsed.get('plain.txt')?.renamed_from, undefined);
});

test('a type change’s two entries for one path keep both hunks', () => {
  const parsed = parseUnifiedDiff(
    'diff --git a/link b/link\ndeleted file mode 120000\n--- a/link\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\n\\ No newline at end of file\n' +
      'diff --git a/link b/link\nnew file mode 100644\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+text\n',
  );
  assert.deepEqual([...parsed.keys()], ['link']);
  const file = parsed.get('link');
  assert.equal(file?.hunks.length, 2);
  assert.deepEqual(file?.stats, { added: 1, removed: 1 });
  assert.equal(file?.kind, 'created');
});

test('halvesNameOnePath: a/<path> b/<path> split at its middle is one path, anything else is not', () => {
  const text = 'a/src/one.ts b/src/one.ts';
  assert.equal(halvesNameOnePath(text, (text.length - 1) / 2), true);
  const spaced = 'a/x b/y b/x b/y';
  assert.equal(halvesNameOnePath(spaced, (spaced.length - 1) / 2), true);
  const renamed = 'a/one.ts b/two.ts';
  assert.equal(halvesNameOnePath(renamed, (renamed.length - 1) / 2), false);
  const even = 'a/ab b/ab';
  assert.equal(halvesNameOnePath(even, (even.length - 1) / 2), true);
  assert.equal(halvesNameOnePath('a/x b/x!', 3.5), false);
});
