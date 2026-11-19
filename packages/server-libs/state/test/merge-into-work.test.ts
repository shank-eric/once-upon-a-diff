import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@once-upon-a-diff/test-kit/env';
import { mergeIntoWork } from '../src/queues/backlog/backlog.ts';

const card = (over: object = {}) =>
  ({ kind: 'work', title: 'old title', agents: [], ...over }) as never as Parameters<
    typeof mergeIntoWork
  >[0];
const view = (key: string) =>
  ({ key, name: key }) as never as Parameters<typeof mergeIntoWork>[2][0];
const item = { id: 'bl_1', title: 'the item' };

test('an item merged into a work card marks it, lists each agent once and titles a card with no PR or story', () => {
  const work = card({ from_backlog: [{ id: 'bl_0', title: 'earlier' }], agents: [view('a')] });
  mergeIntoWork(work, item, [view('a'), view('b'), view('b'), { name: 'keyless' } as never]);
  assert.deepEqual(work.from_backlog, [
    { id: 'bl_0', title: 'earlier' },
    { id: 'bl_1', title: 'the item' },
  ]);
  assert.deepEqual(
    work.agents.map((one) => one.key),
    ['a', 'b', undefined],
    'a view with no key is nobody’s twin, so it is added',
  );
  assert.equal(work.title, 'the item');
});

test('a card with a PR or a story keeps its title, and a session card is never retitled', () => {
  const withPr = card({ pr: 7 });
  mergeIntoWork(withPr, item, []);
  assert.equal(withPr.title, 'old title');
  assert.deepEqual(withPr.from_backlog, [{ id: 'bl_1', title: 'the item' }]);
  const withStory = card({ story: { id: 's' } });
  mergeIntoWork(withStory, item, []);
  assert.equal(withStory.title, 'old title');
  const session = card({ kind: 'session' });
  mergeIntoWork(session, item, []);
  assert.equal(session.title, 'old title');
});
