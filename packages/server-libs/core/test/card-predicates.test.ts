import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';
import { hasStory } from '../src/features/sessions/listening.ts';
import { isLocalStory } from '../src/features/review/story-lists.ts';

test('hasStory: a built story, but not a storyless review', () => {
  const story = { id: 's', kind: 'local' } as NonNullable<BoardCard['story']>;
  assert.equal(hasStory({ story } as BoardCard), true);
  assert.equal(hasStory({ story: { ...story, storyless: true } } as BoardCard), false);
  assert.equal(hasStory({ story: null } as BoardCard), false);
});

test('isLocalStory: a local story, not one the retired turn capture left', () => {
  assert.equal(isLocalStory({ kind: 'local', turn: null }), true);
  assert.equal(isLocalStory({ kind: 'local', turn: 't-3' }), false);
  assert.equal(isLocalStory({ kind: 'github', turn: null }), false);
});
