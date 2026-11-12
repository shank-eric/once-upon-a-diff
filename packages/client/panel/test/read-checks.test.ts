import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferReadSteps, viewedEarlyCheck } from '../src/reading/read-checks.ts';
import { finishedInOf } from '@once-upon-a-diff/terms/chapters';
import type { ReadChange, ReadInfo } from '@once-upon-a-diff/contracts/types';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('a chapter he has read, and that has not changed since, does not make its files "viewed early"', () => {
  const chapters = [
    { title: 'Chapter 1: Logging in', files: [{ rel: 'login.js' }] },
    { title: 'Chapter 2: The task', files: [{ rel: 'task.js' }] },
    { title: 'Chapter 3: Dependencies and CI', files: [{ rel: 'yarn.lock' }, { rel: 'ci.yml' }] },
  ];
  const finishedIn = finishedInOf(chapters);
  const earlyOn = (step: number, readInfo: ReadInfo | null) =>
    ['login.js', 'task.js', 'yarn.lock', 'ci.yml'].filter(
      viewedEarlyCheck({ chapters, finishedIn, readInfo, step }),
    );
  assert.deepEqual(earlyOn(1, null), ['task.js', 'yarn.lock', 'ci.yml'], 'nothing read yet');
  assert.deepEqual(earlyOn(0, null), [], 'nothing is early on the Overview');
  const reads = {
    'dependencies and ci': { head_sha: SHA_A, story_head: SHA_A, at: '2026-10-21T19:28:03Z' },
    'the task': { head_sha: SHA_A, story_head: SHA_A, at: '2026-10-21T19:39:20Z' },
  };
  assert.deepEqual(earlyOn(1, { reads }), []);
  assert.deepEqual(
    earlyOn(1, { reads, changed: [{ step: 3, files: ['yarn.lock'] }] }),
    ['yarn.lock'],
    'a file that changed after he read its chapter is due again, and only that file',
  );
  assert.deepEqual(
    earlyOn(1, { reads, changed: [{ step: 3 } as ReadChange] }), // a change that names no files
    ['yarn.lock', 'ci.yml'],
    'a change that names no files counts for the whole chapter',
  );
});

test('a "Since you read it" chapter first does not make the chapters he read "viewed early"', () => {
  // A real PR on 10/22: one new commit changed a file that chapter 2 also lists. The
  // bridge then reports chapter 2 as changed since he read it, but its other files, still Viewed, are as he read them.
  const chapters = [
    {
      key: 'since-6180a7a-1d8180f',
      title: 'Since you read it: 1 new commit',
      since: { from: SHA_A, to: SHA_B, commits: 1 },
      files: [{ rel: 'useFetchOptions.ts' }],
    },
    { title: 'Chapter 1: The timeline select', files: [{ rel: 'DateField.tsx' }] },
    {
      title: 'Chapter 2: Where the options come from',
      files: [{ rel: 'useFetchOptions.ts' }, { rel: 'index.ts' }, { rel: 'useFilterOptions.ts' }],
    },
  ];
  const finishedIn = finishedInOf(chapters);
  const reads = {
    'the timeline select': { head_sha: SHA_A, story_head: SHA_A, at: '2026-10-21T20:20:41Z' },
    'where the options come from': {
      head_sha: SHA_A,
      story_head: SHA_A,
      at: '2026-10-21T19:56:14Z',
    },
  };
  const readInfo = { reads, changed: [{ step: 3, files: ['useFetchOptions.ts'] }] };
  const all = ['useFetchOptions.ts', 'DateField.tsx', 'index.ts', 'useFilterOptions.ts'];
  const earlyOn = (step: number, info: ReadInfo) =>
    all.filter(viewedEarlyCheck({ chapters, finishedIn, readInfo: info, step }));
  assert.deepEqual(
    earlyOn(2, readInfo),
    [],
    'chapter 1: chapter 2 is read apart from the new file',
  );
  assert.deepEqual(
    earlyOn(1, { reads: {} }),
    [],
    'nothing is early on the "Since you read it" step, read or not',
  );
  assert.deepEqual(
    earlyOn(2, { reads: {} }),
    ['index.ts', 'useFilterOptions.ts'],
    'an old chapter not read yet still warns from the one before it',
  );
});

test('a chapter whose files were all Viewed when the page first showed them counts as read, once', () => {
  const chapters = [
    { title: 'Chapter 1: Logging in' },
    { title: 'Chapter 2: The task' },
    { title: 'Chapter 3: Dependencies and CI' },
  ];
  const progress = (due: number, viewed: number, unknown: string[] = []) => ({
    due,
    viewed,
    unknown,
    noToggle: false,
  });
  const look = new Map();
  assert.deepEqual(
    inferReadSteps(chapters, [progress(2, 2), progress(3, 3), progress(3, 3)], null, look),
    [],
    'nothing until read.json has loaded',
  );
  assert.equal(look.size, 0);
  const readInfo = { reads: { 'the task': { head_sha: SHA_A, at: '2026-10-21T19:39:20Z' } } };
  assert.deepEqual(
    inferReadSteps(
      chapters,
      [progress(2, 2), progress(3, 3), progress(3, 2, ['yarn.lock'])],
      readInfo,
      look,
    ),
    [1],
    'chapter 2 is already read; chapter 3 is not all loaded yet',
  );
  assert.deepEqual(
    inferReadSteps(chapters, [progress(2, 2), progress(3, 3), progress(3, 3)], readInfo, look),
    [3],
    'chapter 3 once its files load',
  );
  assert.deepEqual(
    inferReadSteps(chapters, [progress(2, 2), progress(3, 3), progress(3, 3)], readInfo, look),
    [],
    'each chapter is looked at once',
  );
  const fresh = new Map();
  assert.deepEqual(
    inferReadSteps(
      chapters,
      [progress(2, 0), progress(0, 0), progress(3, 1)],
      { reads: {} },
      fresh,
    ),
    [],
    'not all Viewed, or nothing to view: not read',
  );
  assert.deepEqual(
    inferReadSteps(
      chapters,
      [progress(2, 2), progress(0, 0), progress(3, 3)],
      { reads: {} },
      fresh,
    ),
    [],
    'ticking them all later is not the first look',
  );
});

test('a chapter first published without its text is not inferred read from Viewed ticks made meanwhile', () => {
  const chapters = [
    { title: 'Chapter 1: Told', key: 'told' },
    { title: 'Chapter 2: Late', key: 'late', skeleton: true },
  ];
  const progress = (due: number, viewed: number) => ({
    due,
    viewed,
    unviewed: [],
    unknown: [],
    noToggle: false,
  });
  assert.deepEqual(
    inferReadSteps(chapters, [progress(2, 2), progress(2, 2)], { reads: {} }, new Map()),
    [1],
    'only the chapter whose text was there when its files were ticked',
  );
});
