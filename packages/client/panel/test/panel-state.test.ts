import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStoryModel } from '../src/state/story-model.ts';
import { createPanelState } from '../src/state/panel-state.ts';
import type { StoryData } from '@once-upon-a-diff/contracts/types';

const chapter = (key: string, extra: object = {}) => ({
  key,
  title: key,
  files: [{ rel: 'a.js' }],
  ...extra,
});
const model = (...chapters: object[]) =>
  createStoryModel({
    pr: { title: 'PR' },
    files: [{ rel: 'a.js', sha: 'sha0' }],
    chapters,
  } as unknown as StoryData);

const before = model(chapter('first'), chapter('loader'), chapter('last'));
// an update inserts a "Since you read it" chapter first
const after = model(
  chapter('since-abc1234-def5678', { since: { from: 'abc1234' } }),
  chapter('first'),
  chapter('loader'),
  chapter('last'),
);

test('a saved place keeps its chapter when an update inserts one first', () => {
  const state = createPanelState(before, { n: 2 });
  assert.equal(state.key, 'loader');
  // the redraw hands the old overlay's state back as the new overlay's initial
  const next = createPanelState(after, { ...state });
  assert.equal(next.n, 3);
  assert.equal(next.key, 'loader');
});

test('a place saved before keys uses its step, and a key no chapter has falls back to it', () => {
  assert.equal(createPanelState(after, { n: 2 }).n, 2);
  assert.equal(createPanelState(after, { n: 2, key: 'gone' }).n, 2);
  assert.equal(createPanelState(before, { n: 9, key: 'gone' }).n, 3, 'clamped to the last step');
});

test('the Overview is the key "" and a jump overrides a saved key', () => {
  const overview = createPanelState(after, { n: 3, key: '' });
  assert.equal(overview.n, 0);
  assert.equal(overview.key, '');
  assert.equal(createPanelState(after, { n: 4, key: undefined }).n, 4);
});

test('the key follows the step, and a copy of the state keeps the key it had', () => {
  const state = createPanelState(before, { n: 1 });
  state.n = 3;
  assert.equal(state.key, 'last');
  assert.equal({ ...state }.key, 'last');
});
