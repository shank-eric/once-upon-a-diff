import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixSummary, takesNotes } from '../src/fixes/fixes.ts';
import type { FixNote, FixesView } from '@once-upon-a-diff/contracts/types';

test('the panel says what a send does and how far the notes have got', () => {
  // just the field fixSummary reads of a note
  const notes = [
    { id: 'n1', state: 'draft' },
    { id: 'n2', state: 'draft' },
    { id: 'n3', state: 'sent' },
    { id: 'n4', state: 'fixed' },
  ] as FixNote[];
  assert.deepEqual(
    fixSummary({ notes, to: { consumer: 'api-10', scope: 'story' } as FixesView['to'] }),
    {
      drafts: 2,
      send: 'Send 2 notes to api-10',
      counts: '2 to send · 1 sent · 1 fixed',
    },
  );
  assert.equal(fixSummary({ notes: notes.slice(0, 1), to: null }).send, 'Send 1 note');
  assert.equal(fixSummary({ notes: notes.slice(2), to: null }).send, null);
});

test('the panel takes notes not before the view is in, not when it says no, and an older bridge that says nothing means yes', () => {
  assert.equal(takesNotes(null), false);
  assert.equal(takesNotes({ can_add: false }), false);
  assert.equal(takesNotes({ can_add: true }), true);
  assert.equal(takesNotes({}), true);
});
