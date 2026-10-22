import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marksOf } from '../src/shared/panel/marks.js';

test('a stale story marks the chapters and files changed since it was told', () => {
  const marks = marksOf(
    {
      state: 'stale',
      story_head: 'aaaaaaa',
      current_head: 'bbbbbbb',
      changed_files: ['src/a.js'],
      chapters_touched: [2],
    },
    null,
  );
  assert.deepEqual(marks, [
    {
      why: 'story',
      steps: [2],
      files: ['src/a.js'],
      since: 'aaaaaaa',
      until: 'bbbbbbb',
      onlyOn: null,
    },
  ]);
});

test('a current story marks what its last update brought in, and reads add their own', () => {
  const updated = {
    from: 'aaaaaaa',
    to: 'ccccccc',
    changed_files: ['b.js'],
    chapters_touched: [1],
  };
  const reads = { changed: [{ step: 3, files: ['c.js'], since: 'ddddddd' }] };
  const marks = marksOf({ state: 'current', updated }, reads);
  assert.deepEqual(
    marks.map((mark) => [mark.why, mark.steps, mark.files, mark.since, mark.onlyOn]),
    [
      ['update', [1], ['b.js'], 'aaaaaaa', null],
      ['read', [3], ['c.js'], 'ddddddd', 3],
    ],
  );
  assert.deepEqual(marksOf({ state: 'current' }, null), [], 'up to date and never updated');
  assert.deepEqual(marksOf({ state: 'unknown' }, {}), []);
});
