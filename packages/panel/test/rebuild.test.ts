import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebuildAsk, rebuildLine } from '../src/rebuild/rebuild.ts';
import type { RebuildView } from '@once-upon-a-diff/contracts/types';

test("the panel's request and status line", () => {
  assert.deepEqual(
    { ...rebuildAsk(0, '  '), requested_at: null },
    { mode: 'rebuild', requested_at: null },
  );
  const fromThree = rebuildAsk(3, ' Chapter 3 reads backwards ');
  assert.equal(fromThree.mode, 'rebuild_from');
  assert.equal(fromThree.from_step, 3);
  assert.equal(fromThree.guidance, 'Chapter 3 reads backwards');
  assert.equal(rebuildAsk(1).mode, 'rebuild');

  assert.equal(rebuildLine(null), '');
  assert.match(rebuildLine({ state: 'queued', from_step: 3 }), /^Rebuild from chapter 3 queued/);
  assert.equal(
    rebuildLine({ state: 'building', claimed_by: 'story-x' }),
    'Rebuilding the whole story… (story-x)',
  );
  const now = Date.parse('2026-10-22T20:00:00Z');
  const done: Partial<RebuildView> = {
    state: 'done',
    done_at: '2026-10-22T19:50:00Z',
    note: 'Re-told the whole story.',
  };
  assert.match(rebuildLine(done, now), /^Rebuilt the whole story at .*Re-told the whole story\.$/);
  assert.equal(rebuildLine(done, now + 60 * 60 * 1000), '', 'an old one says nothing');
  assert.match(
    rebuildLine({ state: 'failed', done_at: '2026-10-22T19:55:00Z', note: 'the PR moved' }, now),
    /failed.*: the PR moved$/,
  );
});
