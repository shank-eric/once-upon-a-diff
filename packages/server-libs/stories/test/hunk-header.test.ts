import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHunkHeader } from '../src/diff.ts';

test('parseHunkHeader reads the four numbers and the trailing text, a left-out count being 1', () => {
  assert.deepEqual(parseHunkHeader('@@ -5 +5,2 @@ fn()'), {
    oldStart: 5,
    oldLines: 1,
    newStart: 5,
    newLines: 2,
    header: 'fn()',
  });
  assert.deepEqual(parseHunkHeader('@@ -0,0 +1 @@'), {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 1,
    header: '',
  });
});

test('parseHunkHeader gives null for a line that is not a hunk header', () => {
  assert.equal(parseHunkHeader('+@@ -1 +1 @@'), null);
  assert.equal(parseHunkHeader('diff --git a/x b/x'), null);
});

test('parseHunkHeader keeps a header whose text holds a CR or a line separator', () => {
  assert.equal(parseHunkHeader('@@ -1 +1 @@ a\rb')?.header, 'a\rb');
  assert.equal(parseHunkHeader('@@ -1 +1 @@ a\u2028b')?.header, 'a\u2028b');
});
