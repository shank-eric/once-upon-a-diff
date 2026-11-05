import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStoryModel } from '../src/state/story-model.ts';
import type { StoryData } from '@once-upon-a-diff/contracts/types';

const model = (second: object) =>
  createStoryModel({
    pr: { title: 'PR' },
    files: ['a.js', 'b.js'].map((rel, i) => ({ rel, sha: `sha${i}` })),
    chapters: [
      { title: 'Chapter 1: A', narrative: 'Told.', files: [{ rel: 'a.js' }, { rel: 'b.js' }] },
      { title: 'Chapter 2: B', files: [{ rel: 'b.js' }], ...second },
    ],
  } as unknown as StoryData);

test('a chapter still being written holds Mark viewed for the files it finishes, and nothing else changes', () => {
  const writing = model({ unwritten: true });
  assert.equal(writing.statusIn('b.js', 2)!.kind, 'pending');
  assert.equal(
    writing.statusIn('b.js', 1)!.kind,
    'later',
    'chapter 1 still leaves b.js to chapter 2',
  );
  assert.equal(writing.statusIn('a.js', 1)!.kind, 'mark', 'a written chapter keeps its buttons');
  const written = model({ narrative: 'Now told.' });
  assert.equal(written.statusIn('b.js', 2)!.kind, 'mark', 'the text landed: Mark viewed is back');
});
