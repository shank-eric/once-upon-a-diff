import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRows } from '../src/bridge/public/split.js';

const pair = (row) =>
  row.info
    ? `info ${row.info}`
    : `${row.left ? `${row.left.kind}${row.left.num}` : '-'} | ${row.right ? `${row.right.kind}${row.right.num}` : '-'}`;

test('pairs a run of removed lines with the added run after it, old left and new right', () => {
  const rows = splitRows({ oldStart: 10, newStart: 20, lines: [' a', '-b', '-c', '+B', ' d'] });
  assert.deepEqual(rows.map(pair), [
    'ctx10 | ctx20',
    'del11 | add21',
    'del12 | -',
    'ctx13 | ctx22',
  ]);
  assert.equal(rows[1].left.text, 'b');
  assert.equal(rows[1].right.text, 'B');
});

test('extra added lines get an empty left cell, and a removal after additions starts a new pair', () => {
  assert.deepEqual(
    splitRows({ oldStart: 1, newStart: 1, lines: ['-x', '+X', '+Y', '-z', '+Z'] }).map(pair),
    ['del1 | add1', '- | add2', 'del2 | add3'],
  );
});

test('only added or only removed lines, and the no-newline marker', () => {
  assert.deepEqual(
    splitRows({
      oldStart: 0,
      newStart: 1,
      lines: ['+one', '+two', '\\ No newline at end of file'],
    }).map(pair),
    ['- | add1', '- | add2', 'info \\ No newline at end of file'],
  );
  assert.deepEqual(splitRows({ oldStart: 3, newStart: 2, lines: ['-gone'] }).map(pair), [
    'del3 | -',
  ]);
});

test('each side keeps its line index in the hunk, for its highlighted HTML', () => {
  const rows = splitRows({ oldStart: 1, newStart: 1, lines: [' a', '-b', '+B'] });
  assert.deepEqual(
    rows.map((row) => [row.left && row.left.i, row.right && row.right.i]),
    [
      [0, 0],
      [1, 2],
    ],
  );
});
