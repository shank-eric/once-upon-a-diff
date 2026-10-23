import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { tmp } from './helpers.ts';
import { Inbox, type QuestionEntry } from '../src/inbox/inbox.ts';

test('readers keep their own cursor', () => {
  const inbox = new Inbox(tmp('inbox'));
  inbox.append({ type: 'question', story: 's', text: 'one' });
  assert.equal(inbox.unread('claude', { advance: true }).length, 1);
  assert.equal(inbox.unread('claude', { advance: true }).length, 0);
  inbox.append({ type: 'question', story: 's', text: 'two' });
  assert.deepEqual(
    inbox.unread('claude', { advance: true }).map((e) => (e as QuestionEntry).text),
    ['two'],
  );
  assert.equal(inbox.unread('hook').length, 2, 'another reader starts from the top');
});

test('a half-written last line waits for the next read', () => {
  const inbox = new Inbox(tmp('inbox'));
  inbox.append({ type: 'question', story: 's', text: 'one' });
  appendFileSync(inbox.file, '{"type":"question","text":"tw');
  assert.equal(inbox.unread('c', { advance: true }).length, 1);
  appendFileSync(inbox.file, 'o"}\n');
  assert.deepEqual(
    inbox.unread('c', { advance: true }).map((e) => (e as QuestionEntry).text),
    ['two'],
  );
});

test('answers attach to their questions', () => {
  const inbox = new Inbox(tmp('inbox'));
  const question = inbox.append({ type: 'question', story: 's', text: 'why?' });
  inbox.append({ type: 'question', story: 'other', text: 'elsewhere' });
  inbox.append({ type: 'answer', question: question.id, story: 's', text: 'because' });
  const questions = inbox.questions('s');
  assert.equal(questions.length, 1);
  assert.equal(questions[0].answers[0].text, 'because');
});
