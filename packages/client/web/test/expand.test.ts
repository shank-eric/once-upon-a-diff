import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandHunks, gapsOf, EXPAND_STEP } from '../public/local/diff/expand.ts';
import type { DiffHunk } from '@once-upon-a-diff/contracts/types';

/** A 100-line file "l1".."l100". */
const text = Array.from({ length: 100 }, (_, i) => `l${i + 1}`);
const ctx = (from: number, last: number) =>
  Array.from({ length: last - from + 1 }, (_, i) => ` l${from + i}`);

const hunk = (
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
  lines: string[],
): DiffHunk => ({ oldStart, oldLines, newStart, newLines, header: 'fn', lines });

/** Line 10 changed (so 7..13 shown), then 2 lines added after line 50 (so 48..53 old, 48..55 new). */
const two = [
  hunk(7, 7, 7, 7, [...ctx(7, 9), '-old10', '+l10', ...ctx(11, 13)]),
  hunk(48, 6, 48, 8, [...ctx(48, 50), '+n51', '+n52', ...ctx(51, 53)]),
];
// the second hunk's new numbers: 48..50 context, 51..52 added, 53..55 context (old 51..53)
two[1].lines = [...ctx(48, 50), '+l51', '+l52', ' l53', ' l54', ' l55'];

test('gapsOf: the lines before the first hunk, between hunks, and after the last when it has full context', () => {
  assert.deepEqual(gapsOf(two), [
    { index: 0, hidden: 6 },
    { index: 1, hidden: 34 },
    { index: 2, hidden: null },
  ]);
});

test('gapsOf: no gap above line 1, none after a hunk that ends the file, none for a created or deleted file', () => {
  assert.deepEqual(gapsOf([hunk(1, 4, 1, 4, ['-a', '+A', ' b', ' c', ' d'])]), [
    { index: 1, hidden: null },
  ]);
  assert.deepEqual(gapsOf([hunk(1, 3, 1, 3, [...ctx(1, 1), '-b', '+B', ' c'])]), []);
  assert.deepEqual(gapsOf([hunk(0, 0, 1, 3, ['+a', '+b', '+c'])]), []);
  assert.deepEqual(gapsOf([hunk(1, 3, 0, 0, ['-a', '-b', '-c'])]), []);
  assert.deepEqual(gapsOf([]), []);
  // the "no newline" marker ends the file, however much context comes before it
  assert.deepEqual(
    gapsOf([hunk(1, 4, 1, 4, ['-a', '+A', ' b', ' c', ' d', '\\ No newline at end of file'])]),
    [],
  );
});

test('down adds the next lines to the hunk above the gap, with old numbers behind by what that hunk added', () => {
  const { hunks, added } = expandHunks(two, text, 2, 'down');
  assert.equal(hunks.length, 2);
  assert.equal(added.length, EXPAND_STEP);
  assert.deepEqual(added.slice(0, 2), [56, 57]);
  const last = hunks[1];
  assert.equal(last.newStart, 48);
  assert.equal(last.newLines, 8 + EXPAND_STEP);
  assert.equal(last.oldLines, 6 + EXPAND_STEP);
  assert.equal(last.lines.length, two[1].lines.length + EXPAND_STEP);
  assert.equal(last.lines.at(-1), ' l75');
  assert.equal(last.header, 'fn');
});

test('up adds the lines just above the hunk below the gap, and moves its start up', () => {
  const { hunks, added } = expandHunks(two, text, 1, 'up');
  assert.deepEqual(
    added,
    Array.from({ length: 20 }, (_, i) => 28 + i),
  );
  assert.equal(hunks[1].newStart, 28);
  assert.equal(hunks[1].newLines, 8 + 20);
  // two lines were added above in the first hunk? none: 0 delta here, old numbers equal the new
  assert.equal(hunks[1].oldStart, 28);
  assert.deepEqual(hunks[1].lines.slice(0, 2), [' l28', ' l29']);
  assert.equal(hunks[0], two[0]);
});

test('old numbers follow what the hunks above added or removed', () => {
  // 2 lines added by the first hunk: later unchanged line new N is old N-2
  const shifted = [
    hunk(1, 3, 1, 5, ['+a', '+b', ' c', ' d', ' e']),
    hunk(40, 4, 42, 4, [...ctx(42, 44), '-x', '+y']),
  ];
  const { hunks } = expandHunks(shifted, text, 1, 'up');
  assert.equal(hunks[1].newStart, 22);
  assert.equal(hunks[1].oldStart, 20);
});

test('a gap of 20 or fewer, or Expand all, joins the two hunks into one with true counts', () => {
  const small = [
    hunk(1, 4, 1, 4, ['-a', '+A', ' b', ' c', ' d']),
    hunk(19, 4, 19, 4, [' s', ' t', '-u', '+U', ' v']),
  ];
  // new 5..18 hidden: 14 lines
  const { hunks, added } = expandHunks(small, text, 1, 'down');
  assert.equal(hunks.length, 1);
  assert.equal(added.length, 14);
  assert.deepEqual(
    [hunks[0].oldStart, hunks[0].oldLines, hunks[0].newStart, hunks[0].newLines],
    [1, 22, 1, 22],
  );
  assert.equal(hunks[0].header, 'fn');
  assert.equal(hunks[0].lines.length, 5 + 14 + 5);
  const all = expandHunks(two, text, 1, 'all');
  assert.equal(all.hunks.length, 1);
  assert.deepEqual(
    [all.hunks[0].newStart, all.hunks[0].newLines, all.hunks[0].oldLines],
    [7, 55 - 7 + 1, 55 - 7 + 1 - 2],
  );
  assert.equal(all.added.length, 34);
  assert.deepEqual(gapsOf(all.hunks), [
    { index: 0, hidden: 6 },
    { index: 1, hidden: null },
  ]);
});

test('the lines before the first hunk: up takes the last 20, a short gap fills; down there is nothing to do', () => {
  const far = [hunk(40, 4, 40, 4, [' a', ' b', ' c', '-x'])];
  const lead = expandHunks(far, text, 0, 'up');
  assert.deepEqual(
    [lead.hunks[0].newStart, lead.hunks[0].oldStart, lead.added.length],
    [20, 20, 20],
  );
  assert.equal(expandHunks(far, text, 0, 'down').hunks, far);
  const near = expandHunks(two, text, 0, 'up');
  assert.deepEqual([near.hunks[0].newStart, near.hunks[0].oldStart], [1, 1]);
  assert.equal(near.added.length, 6);
});

test('after the last hunk: down adds up to 20 lines, then nothing is left', () => {
  const end = [hunk(95, 4, 95, 4, ['-x', '+X', ' l96', ' l97', ' l98'])];
  const { hunks, added } = expandHunks(end, text, 1, 'down');
  assert.deepEqual(added, [99, 100]);
  assert.equal(hunks[0].newLines, 4 + 2);
  // the page can't tell from the hunks that the file is done; the next expand finds nothing and says so
  const again = expandHunks(hunks, text, 1, 'down');
  assert.equal(again.hunks, hunks);
  assert.deepEqual(again.added, []);
});

test('a hunk with no old lines (an added block) keeps its numbers true when joined', () => {
  // two lines added after old line 30: @@ -30,0 +31,2 @@, and a later one removing a line: @@ -57,1 +58,0 @@
  const zeros = [hunk(30, 0, 31, 2, ['+p', '+q']), hunk(57, 1, 58, 0, ['-gone'])];
  const all = expandHunks(zeros, text, 1, 'all');
  assert.equal(all.hunks.length, 1);
  const merged = all.hunks[0];
  assert.deepEqual([merged.newStart, merged.newLines], [31, 28]);
  // old side: first old line is 31 (after old 30), up to old 57
  assert.deepEqual([merged.oldStart, merged.oldLines], [31, 27]);
});

test('a hunk ending in the "no newline" marker is the end of the file: nothing opens after it', () => {
  const marked = [hunk(98, 3, 98, 3, [' a', '-b', '+B', '\\ No newline at end of file'])];
  assert.deepEqual(gapsOf(marked), [{ index: 0, hidden: 97 }]);
  assert.equal(expandHunks(marked, text, 1, 'down', 20).hunks, marked);
});
