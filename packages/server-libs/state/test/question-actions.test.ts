import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBody } from '@once-upon-a-diff/contracts/schemas';
import { QA_ACTIONS } from '../src/queues/requests/conversation.ts';

test('the question actions match the contract’s own list', () => {
  // the bridge refuses an action it doesn't know too (queues/requests/conversation.ts), so the two lists have to agree
  for (const action of QA_ACTIONS) {
    const checked = checkBody('questionMarks', { action });
    assert.ok(checked.ok, `questionMarks should take ${JSON.stringify({ action })}`);
  }
});
