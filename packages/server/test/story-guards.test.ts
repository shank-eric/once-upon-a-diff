import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/request.ts';
import { localOnly, oncePerStory } from '../src/routes/story-guards.ts';
import type { ServedStory } from '@once-upon-a-diff/core/records/stories/types';

const storyOf = (kind: string) => ({ meta: { kind } }) as unknown as ServedStory;

test('localOnly: a local story passes, a PR story is a 400 with the route its own words', () => {
  localOnly(storyOf('local'), 'unused');
  assert.throws(
    () => localOnly(storyOf('pr'), 'a PR story is not pushed from here'),
    (err: unknown) =>
      err instanceof HttpError &&
      err.status === 400 &&
      err.message === 'a PR story is not pushed from here',
  );
});

test('oncePerStory: a second run for the story is a 409 while the first is going, another story is not, and the id frees after success or a throw', async () => {
  let release: () => void = () => {};
  const first = oncePerStory(
    'a',
    () => new Promise<string>((resolve) => (release = () => resolve('one'))),
  );
  await assert.rejects(
    oncePerStory('a', async () => 'two'),
    (err: unknown) =>
      err instanceof HttpError &&
      err.status === 409 &&
      err.message === 'a push for this story is already running',
  );
  assert.equal(await oncePerStory('b', async () => 'other'), 'other');
  release();
  assert.equal(await first, 'one');
  assert.equal(await oncePerStory('a', async () => 'again'), 'again');
  await assert.rejects(
    oncePerStory('a', async () => {
      throw new Error('boom');
    }),
    { message: 'boom' },
  );
  assert.equal(await oncePerStory('a', async () => 'after a throw'), 'after a throw');
});
