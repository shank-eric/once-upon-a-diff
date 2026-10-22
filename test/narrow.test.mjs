import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsOf, narrowRows } from '../src/bridge/public/narrow.js';

const ctx = (oldLine, newLine) => ({ type: 'line', L: oldLine, R: newLine, add: false });
const del = (oldLine) => ({ type: 'line', L: oldLine, R: null, add: false });
const add = (newLine) => ({ type: 'line', L: null, R: newLine, add: true });
const hunk = { type: 'hunk' };
const shown = (rows, res) =>
  rows
    .map((row, i) => {
      if (res.hidden[i]) {
        return null;
      }
      return row.type === 'line' ? `${row.L ?? '-'}/${row.R ?? '-'}` : row.type;
    })
    .filter(Boolean);

// one file two chapters share, as in a story whose chapter 2 is one block of chapter 1's file
const chapters = [
  { files: [{ rel: 'a.js', lines: [{ side: 'R', start: 10, end: 12 }] }, { rel: 'b.js' }] },
  { files: [{ rel: 'a.js', lines: [{ side: 'R', start: 20, end: 21 }] }] },
  { files: [{ rel: 'a.js' }] },
];
const claims = claimsOf(chapters);
const rows = [
  hunk,
  ctx(1, 1),
  add(2),
  ctx(2, 3), // no chapter's range: shown in chapter 1, the first to list a.js
  hunk,
  ctx(9, 10),
  del(10),
  add(11),
  add(12),
  ctx(11, 13), // chapter 1's lines, with the removal they replace
  hunk,
  ctx(18, 20),
  del(19),
  del(20),
  ctx(21, 21), // chapter 2's lines, with a pure removal between them
];

test('a chapter folds the lines another chapter tells, and lines no range covers go to the file’s first chapter', () => {
  const first = narrowRows(rows, claims, 'a.js', 1);
  assert.deepEqual(shown(rows, first), [
    'hunk',
    '1/1',
    '-/2',
    '2/3',
    'hunk',
    '9/10',
    '10/-',
    '-/11',
    '-/12',
    '11/13',
  ]);
  assert.deepEqual(
    first.runs.map((run) => [run.from, run.to, run.steps]),
    [[10, 14, [2]]],
    'all of hunk 3, header too, folds into one run, told in chapter 2',
  );
  const second = narrowRows(rows, claims, 'a.js', 2);
  assert.deepEqual(shown(rows, second), ['hunk', '18/20', '19/-', '20/-', '21/21']);
  assert.deepEqual(
    second.runs.map((run) => [run.from, run.to, run.steps]),
    [[0, 9, [1]]],
    'hunks 1 and 2 fold into one run, told in chapter 1',
  );
});

test('a removal goes with the lines that replace it, and a pure removal with the lines around it', () => {
  const second = narrowRows(rows, claims, 'a.js', 2);
  assert.equal(second.hidden[6], true, 'the removed line 10 is replaced by chapter 1’s added 11');
  assert.equal(second.hidden[12], false, 'removed 19 and 20 sit between chapter 2’s lines');
});

test('no narrowing for a chapter that lists the file whole, the Overview, or a file the chapter doesn’t list', () => {
  for (const step of [3, 0]) {
    assert.ok(
      narrowRows(rows, claims, 'a.js', step).hidden.every((hidden) => !hidden),
      `step ${step}`,
    );
  }
  assert.ok(narrowRows([ctx(1, 1)], claims, 'b.js', 1).hidden.every((hidden) => !hidden));
  assert.ok(narrowRows(rows, claims, 'a.js', 1).hidden.some((hidden) => hidden));
});

test('a "Since you read it" chapter isn’t where uncovered lines go', () => {
  const since = claimsOf([
    {
      since: { from: 'a', to: 'b' },
      files: [{ rel: 'a.js', lines: [{ side: 'R', start: 20, end: 21 }] }],
    },
    ...chapters,
  ]);
  assert.equal(since.home['a.js'], 2);
  assert.equal(
    narrowRows(rows, since, 'a.js', 1).hidden[1],
    true,
    'line 1 is chapter 1’s, now step 2',
  );
  assert.equal(narrowRows(rows, since, 'a.js', 2).hidden[1], false);
});

test('a note keeps its line showing, and split rows count both sides', () => {
  const withNote = [hunk, ctx(19, 20), { type: 'note' }, ctx(20, 21)];
  assert.deepEqual(narrowRows(withNote, claims, 'a.js', 1).hidden, [false, false, false, true]);
  const split = [
    hunk,
    { type: 'line', L: 10, R: 11, add: true },
    { type: 'line', L: 30, R: 31, add: true },
  ];
  assert.deepEqual(
    narrowRows(
      split,
      claimsOf([
        ...chapters,
        { files: [{ rel: 'a.js', lines: [{ side: 'L', start: 30, end: 30 }] }] },
      ]),
      'a.js',
      4,
    ).hidden,
    [false, true, false],
    'an old-side range claims by the old line number',
  );
});
