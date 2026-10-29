import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockHeightWithin, withLayout } from '../src/panel/layout.ts';

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

test('the dock keeps its saved height within the panel, and a panel with no height yet does not shrink it', () => {
  assert.equal(dockHeightWithin(400, 900), 400);
  assert.equal(dockHeightWithin(800, 900), 720, 'at most 80% of the panel');
  assert.equal(dockHeightWithin(400, 300), 240, 'a short panel limits what is shown');
  assert.equal(dockHeightWithin(400, 60), 120, 'never below the minimum');
  assert.equal(
    dockHeightWithin(400, 0),
    400,
    'a panel not laid out yet (no stylesheet) shows the saved height',
  );
});
