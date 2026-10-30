import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askDrafts,
  askedOnStep,
  createReadWatch,
  elapsedText,
  latestAnswerAt,
  readUpTo,
  unreadAnswersOf,
  withRead,
  questionStepLabel,
  questionTotals,
  waitingText,
} from '../src/ask/question-list.ts';
import type { Question } from '@once-upon-a-diff/protocol/types';

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
  assert.deepEqual(questionTotals(list), {
    open: 2,
    waiting: 1,
    working: 0,
    unread: 0,
    dismissed: 1,
  });
  assert.deepEqual(questionTotals([]), {
    open: 0,
    waiting: 0,
    working: 0,
    unread: 0,
    dismissed: 0,
  });
});

test('the totals say which questions a session is on and which answers are unread', () => {
  const working = {
    state: 'working' as const,
    by: 'repo-a',
    since: null,
    note: null,
    note_at: null,
  };
  const list = [
    ask('a', 1, { answers: [{ at: '2026-10-28T12:01:00Z', text: 'Because.' }], unread: true }),
    ask('b', 2, { status: working }),
    ask('c', 3, { status: { ...working, state: 'queued' } }),
    ask('d', 3, { status: { ...working, state: 'stalled' } }),
    ask('e', 3, {
      unread: true,
      dismissed: true,
      answers: [{ at: '2026-10-28T12:01:00Z', text: 'x' }],
    }),
  ];
  assert.deepEqual(questionTotals(list), {
    open: 4,
    waiting: 2,
    working: 1,
    unread: 1,
    dismissed: 1,
  });
});

test('elapsed time reads as minutes and seconds, then hours', () => {
  assert.equal(elapsedText(42_000), '0:42');
  assert.equal(elapsedText(12 * 60_000 + 3_000), '12:03');
  assert.equal(elapsedText(3_723_000), '1:02:03');
  assert.equal(elapsedText(-5), '0:00');
});

test('a question with no answer says who has it, or that nobody does', () => {
  const status = (state: 'queued' | 'working' | 'stalled', note: string | null = null) => ({
    state,
    by: state === 'queued' ? null : 'repo-acme',
    since: null,
    note,
    note_at: null,
  });
  assert.deepEqual(
    waitingText({ handed_to: 'repo-acme', status: status('working', 'reading auth.ts') }),
    {
      state: 'working',
      text: 'repo-acme is working on it',
      note: 'reading auth.ts',
    },
  );
  assert.match(
    waitingText({ handed_to: null, status: status('queued') }).text,
    /No session has picked it up/,
  );
  assert.match(
    waitingText({ handed_to: null, status: status('queued') }, { listening: false }).text,
    /No Claude session is listening/,
  );
  const stalled = waitingText(
    { handed_to: 'repo-acme', status: status('stalled') },
    { quietAt: '4:32 PM' },
  );
  assert.equal(stalled.state, 'stalled');
  assert.match(stalled.text, /quiet since 4:32 PM/);
  // a bridge too old to say a status: handed over still reads as taken
  assert.equal(waitingText({ handed_to: 'repo-acme' }).state, 'working');
  assert.equal(waitingText({ handed_to: null }).state, 'queued');
  // nothing re-queues a stalled question, so the line says so
  assert.match(stalled.text, /No session will pick it up again: ask it again, or dismiss it/);
});

const answer = (when: string) => ({ at: when, text: 'x' });
const ANSWER_1 = '2026-10-29T12:00:00.000Z';
const ANSWER_2 = '2026-10-29T12:05:00.000Z';
const ANSWER_3 = '2026-10-29T12:10:00.000Z';

test('the unread answers are those after the read mark, oldest first, all of them with no mark', () => {
  const question = ask('a', 1, { answers: [answer(ANSWER_2), answer(ANSWER_1), answer(ANSWER_3)] });
  assert.deepEqual(
    unreadAnswersOf(question).map((one) => one.at),
    [ANSWER_1, ANSWER_2, ANSWER_3],
  );
  assert.deepEqual(
    unreadAnswersOf({ ...question, read_at: ANSWER_1 }).map((one) => one.at),
    [ANSWER_2, ANSWER_3],
  );
  assert.deepEqual(unreadAnswersOf({ ...question, read_at: ANSWER_3 }), []);
  assert.equal(latestAnswerAt(question), ANSWER_3);
  assert.equal(latestAnswerAt(ask('b', 1)), null);
});

test('reading up to an answer leaves a newer one unread', () => {
  const question = ask('a', 1, { answers: [answer(ANSWER_1), answer(ANSWER_2)], unread: true });
  const some = withRead(question, ANSWER_1);
  assert.equal(some.read_at, ANSWER_1);
  assert.equal(some.unread, true);
  assert.equal(withRead(question, ANSWER_2).unread, false);
  assert.equal(withRead(some, ANSWER_1).read_at, ANSWER_1);
  assert.equal(
    withRead({ ...some, read_at: ANSWER_2 }, ANSWER_1).read_at,
    ANSWER_2,
    'a mark never moves back',
  );
  assert.equal(withRead({ ...question, dismissed: true }, ANSWER_1).unread, false);
});

test('an older answer in view never reads a newer one that was not', () => {
  const question = ask('a', 1, { answers: [answer(ANSWER_1), answer(ANSWER_2), answer(ANSWER_3)] });
  assert.equal(readUpTo(question, new Set()), null);
  assert.equal(readUpTo(question, new Set([ANSWER_1])), ANSWER_1, 'only the first was looked at');
  assert.equal(
    readUpTo(question, new Set([ANSWER_3])),
    null,
    'the newest alone waits for the ones before it',
  );
  assert.equal(readUpTo(question, new Set([ANSWER_1, ANSWER_3])), ANSWER_1);
  assert.equal(readUpTo(question, new Set([ANSWER_1, ANSWER_2, ANSWER_3])), ANSWER_3);
  // an answer already read does not count, and the run starts after the mark
  assert.equal(readUpTo({ ...question, read_at: ANSWER_1 }, new Set([ANSWER_2])), ANSWER_2);
  assert.equal(readUpTo({ ...question, read_at: ANSWER_1 }, new Set([ANSWER_1])), null);
});

/** A fake clock for createReadWatch's timers. */
function clock() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  return {
    timers: {
      set: (run: () => void, millis: number) => {
        due.set(++next, { at: now + millis, run });
        return next;
      },
      clear: (handle: unknown) => due.delete(handle as number),
    },
    advance(millis: number) {
      now += millis;
      for (const [handle, timer] of [...due]) {
        if (timer.at <= now) {
          due.delete(handle);
          timer.run();
        }
      }
    },
  };
}

test('an answer in view for 1.5 s counts as read, and a redraw does not restart its timer', () => {
  const fake = clock();
  const question = ask('a', 1, { answers: [answer(ANSWER_1)], unread: true });
  const reads: [string, string][] = [];
  let can = true;
  const watch = createReadWatch({
    afterMs: 1500,
    canRead: () => can,
    find: () => question,
    onRead: (id, upto) => reads.push([id, upto]),
    timers: fake.timers,
  });
  const ref = { question: 'a', at: ANSWER_1 };
  watch.keep([ref]);
  watch.inView(ref, true);
  fake.advance(1000);
  // a draw: the observer is made again and says the answer is still in view
  watch.keep([ref]);
  watch.inView(ref, true);
  fake.advance(600);
  assert.deepEqual(reads, [['a', ANSWER_1]], 'read 1.5 s after it first came into view');
  assert.equal(watch.pending(), 0);

  // out of view before the time is up: no read
  watch.inView(ref, true);
  fake.advance(1000);
  watch.inView(ref, false);
  fake.advance(5000);
  assert.equal(reads.length, 1);

  // an answer that went away from the page loses its timer
  watch.inView(ref, true);
  watch.keep([]);
  assert.equal(watch.pending(), 0);
  fake.advance(5000);
  assert.equal(reads.length, 1);

  // the tab is hidden when the time is up (or the dock is closed): nothing is read
  can = false;
  watch.inView(ref, true);
  fake.advance(2000);
  assert.equal(reads.length, 1);
  can = true;
  watch.inView(ref, true);
  fake.advance(2000);
  assert.equal(reads.length, 2, 'it comes into view again, and is read');
});

test('answers looked at out of order are read up to the first gap, once the gap is filled', () => {
  const fake = clock();
  const question = ask('a', 1, { answers: [answer(ANSWER_1), answer(ANSWER_2)], unread: true });
  const reads: [string, string][] = [];
  const watch = createReadWatch({
    afterMs: 1500,
    canRead: () => true,
    find: () => question,
    onRead: (id, upto) => reads.push([id, upto]),
    timers: fake.timers,
  });
  const second = { question: 'a', at: ANSWER_2 };
  const first = { question: 'a', at: ANSWER_1 };
  watch.inView(second, true);
  fake.advance(2000);
  assert.deepEqual(reads, [], 'the newer answer alone reads nothing');
  watch.inView(first, true);
  fake.advance(2000);
  assert.deepEqual(
    reads,
    [['a', ANSWER_2]],
    'with the gap filled, both are read, up to the newer one',
  );
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
