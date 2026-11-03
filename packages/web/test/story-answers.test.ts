import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerBits } from '../public/board/columns/story-answers.ts';
import type { BoardCard } from '@once-upon-a-diff/protocol/types';

const card = (
  column: BoardCard['column'],
  story: Partial<NonNullable<BoardCard['story']>> | null,
): Pick<BoardCard, 'column' | 'story'> => ({
  column,
  story: story && {
    id: 's',
    kind: 'pr',
    url: 'https://github.com/acme/widgets/pull/7/changes',
    reviewed: false,
    unread: false,
    unread_answers: 0,
    approved_at: null,
    ship: null,
    ...story,
  },
});

test('a card with unread answers says how many, offers the story, and opens it with the Ask dock', () => {
  const none = answerBits(card('back', {}));
  assert.deepEqual([none.chip, none.note, none.hash, none.openable], [null, null, '', false]);
  const one = answerBits(card('back', { unread_answers: 1 }));
  assert.equal(one.chip, '1 unread answer');
  assert.match(
    one.note!,
    /Claude answered a question you asked in the story\. Open the story to read it\./,
  );
  assert.equal(one.hash, '#ou-ask');
  assert.equal(one.openable, true, 'a PR card in Back to you can open its story for an answer');
  const two = answerBits(card('ready', { kind: 'local', url: null, unread_answers: 2 }));
  assert.equal(two.chip, '2 unread answers');
  assert.match(two.note!, /2 questions .* read them/);
});

test('Mark reviewed is for a local story in Ready that is not marked, or was rebuilt after it was', () => {
  const local = { kind: 'local' as const, url: null };
  assert.equal(answerBits(card('ready', { ...local })).markable, true);
  assert.equal(
    answerBits(card('ready', { ...local, reviewed: true })).markable,
    false,
    'marked, and nothing new',
  );
  assert.equal(
    answerBits(card('ready', { ...local, reviewed: true, unread: true })).markable,
    true,
    'marked reviewed, then rebuilt: the card is in Ready again and the button clears it',
  );
  assert.equal(
    answerBits(card('ready', { ...local, reviewed: true, unread_answers: 1 })).markable,
    false,
  );
  assert.equal(
    answerBits(card('back', { kind: 'pr' })).markable,
    false,
    'a PR story is marked on GitHub',
  );
  assert.equal(answerBits(card('idle', null)).openable, false);
});
