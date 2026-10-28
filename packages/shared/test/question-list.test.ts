import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askDrafts,
  askedOnStep,
  questionStepLabel,
  questionTotals,
} from '../src/panel/question-list.ts';
import type { Question } from '../src/types.ts';

const ask = (id: string, step: number, extra: Partial<Question> = {}): Question => ({
  id,
  at: '2026-10-28T12:00:00Z',
  step,
  text: `Why ${id}?`,
  file: null,
  answers: [],
  ...extra,
});
const chapters = [{ title: 'Panel state' }, { title: 'Questions dock' }];

test('a question is labelled with the step it was asked on', () => {
  assert.equal(questionStepLabel(ask('a', 0), chapters), 'Overview');
  assert.equal(questionStepLabel(ask('b', 2), chapters), 'Chapter 2: Questions dock');
  assert.equal(questionStepLabel(ask('c', 9), chapters), 'Chapter 9', 'a chapter the story lost');
});

test('only the step on screen is marked, the others stay in the list', () => {
  const list = [ask('a', 0), ask('b', 1), ask('c', 2)];
  assert.deepEqual(
    list.filter((question) => askedOnStep(question, 2)).map((question) => question.id),
    ['c'],
  );
  assert.deepEqual(
    list.filter((question) => askedOnStep(question, 0)).map((question) => question.id),
    ['a'],
    'the Overview is a step of its own',
  );
});

test('the totals count the whole story, not one step', () => {
  const list = [
    ask('a', 1, { answers: [{ at: '2026-10-28T12:01:00Z', text: 'Because.' }] }),
    ask('b', 2),
    ask('c', 3, { dismissed: true }),
  ];
  assert.deepEqual(questionTotals(list), { open: 2, waiting: 1, dismissed: 1 });
  assert.deepEqual(questionTotals([]), { open: 0, waiting: 0, dismissed: 0 });
});

test('a typed question comes back after a remount, per story, and is gone once sent', () => {
  askDrafts.keep('story-1', 'Why two halves?');
  assert.equal(askDrafts.take('story-1'), 'Why two halves?');
  assert.equal(askDrafts.take('story-2'), '', 'another story starts empty');
  askDrafts.keep('story-1', '   ');
  assert.equal(askDrafts.take('story-1'), '', 'blank text is not a draft');
  askDrafts.keep('story-1', 'again');
  askDrafts.forget('story-1');
  assert.equal(askDrafts.take('story-1'), '');
});
