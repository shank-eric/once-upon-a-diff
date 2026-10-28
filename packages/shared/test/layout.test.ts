import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLayout } from '../src/panel/layout.ts';

test('the layout’s sizes go over a story’s own, and its step and folds stay', () => {
  const saved = { n: 3, collapsed: true, width: 460, chatHeight: 280 };
  assert.deepEqual(withLayout(saved, { width: 700 }), { ...saved, width: 700 });
  assert.deepEqual(withLayout(saved, { width: 700, chatHeight: 400 }), {
    ...saved,
    width: 700,
    chatHeight: 400,
  });
  assert.deepEqual(
    withLayout(saved, null),
    saved,
    'no layout (the bridge is down): the story’s own',
  );
  assert.deepEqual(withLayout({}, { chatHeight: 300 }), { chatHeight: 300 });
});
