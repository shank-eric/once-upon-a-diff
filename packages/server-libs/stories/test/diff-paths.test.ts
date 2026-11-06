import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerPaths, parseUnifiedDiff } from '../src/diff.ts';

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
