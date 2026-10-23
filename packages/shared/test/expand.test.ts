import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { expandDirOf, expandStep, EXPAND_ALL_FAR } from '../src/overlay.ts';

/** A file's table as expandStep reads it: hunk rows with their controls, and drawn rows with their line. */
type Row = { gap?: string[]; n?: number };
const gap = (...dirs: string[]): Row => ({ gap: dirs });
const drawn = (...lines: number[]): Row[] => lines.map((line) => ({ n: line }));

describe('expand controls: which way one opens', () => {
  test("from /changes' data-direction, or the label when there's none", () => {
    assert.equal(expandDirOf('up', 'Expand file up from line 64'), 'up');
    assert.equal(expandDirOf('all', 'Expand file from line 89 to line 96'), 'all');
    assert.equal(expandDirOf(null, 'Expand file from line 89 to line 96'), 'all');
    assert.equal(expandDirOf(null, 'Expand file down from line 140'), 'down');
  });
  test("from classic /files' a.js-expand labels", () => {
    assert.equal(expandDirOf(null, 'Expand Up'), 'up');
    assert.equal(expandDirOf(null, 'Expand Down'), 'down');
    assert.equal(expandDirOf(null, 'Expand All'), 'all');
    assert.equal(expandDirOf(null, 'Collapse file'), null);
  });
});

// repo-age.tsx on refined-github#10298 /changes (2026-10-21), right side:
// HUNK[up 64] 64..89 HUNK[all 89-96] 96..104 HUNK[all 104-113] 113..140 HUNK[down 140, up 162] 162..167
const file: Row[] = [
  gap('up'),
  ...drawn(64, 65, 66, 67, 88, 89),
  gap('all'),
  ...drawn(96, 97, 104),
  gap('all'),
  ...drawn(113, 114, 140),
  gap('down', 'up'),
  ...drawn(162, 167),
];

describe('expand controls: the next one to click for a line', () => {
  test('a line above the first hunk opens upward from it', () => {
    assert.deepEqual(expandStep(file, 10), { at: 0, dir: 'up', far: 54 });
    assert.deepEqual(expandStep(file, 63), { at: 0, dir: 'up', far: 1 });
  });
  test('a short gap opens all at once', () => {
    assert.deepEqual(expandStep(file, 92), { at: 7, dir: 'all', far: 3 });
    assert.equal(expandStep(file, 110)!.dir, 'all');
  });
  test('a long gap opens from whichever side is nearer the line', () => {
    const i = file.findIndex((row, k) => row.gap && k > 12);
    assert.deepEqual(expandStep(file, 145), { at: i, dir: 'down', far: 5 });
    assert.deepEqual(expandStep(file, 160), { at: i, dir: 'up', far: 2 });
    assert.equal(expandStep(file, 151)!.dir, 'down', 'the middle goes down');
  });
  test('a line past the last hunk opens downward', () => {
    const tail = [gap('up'), ...drawn(10, 20), gap('down')];
    assert.deepEqual(expandStep(tail, 400), { at: 3, dir: 'down', far: 380 });
    assert.ok(
      expandStep(tail, 400)!.far > EXPAND_ALL_FAR,
      'far enough to open the whole file where there is a button for it',
    );
  });
  test('a line already drawn, or between drawn lines with no gap, needs nothing', () => {
    assert.equal(expandStep(file, 65), null);
    assert.equal(
      expandStep(file, 70),
      null,
      'inside a hunk: a removed line, or an added one on the other side',
    );
  });
  test('a hunk row with no controls left, or only the wrong one, is a dead end', () => {
    assert.equal(expandStep([gap(), ...drawn(30, 31)], 5), null);
    assert.deepEqual(expandStep([...drawn(1, 2), gap('down')], 9), { at: 2, dir: 'down', far: 7 });
  });
  test('rows with no number on the wanted side (added rows, on the old side) are skipped over', () => {
    const old = [
      gap('up'),
      { n: 40 },
      { n: null },
      { n: 41 },
      gap('down', 'up'),
      { n: null },
      { n: 90 },
    ];
    assert.deepEqual(expandStep(old, 45), { at: 4, dir: 'down', far: 4 });
    assert.deepEqual(expandStep(old, 88), { at: 4, dir: 'up', far: 2 });
  });
});
