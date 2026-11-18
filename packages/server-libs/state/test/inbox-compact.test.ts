/*
 * What doctor --fix does to inbox.jsonl (src/queues/requests/inbox-compact.ts): old reads and positions go, the conversation
 * stays, and every consumer's cursor (a byte offset) moves with the file, so nothing old is handed over again and nothing new is
 * skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { replaceLog } from '@once-upon-a-diff/adapters/stores/fs/jsonl';
import { waitSeam } from '@once-upon-a-diff/adapters/stores/fs/lock';
import { Inbox, type QuestionEntry } from '../src/queues/requests/inbox.ts';
import { compactInboxText } from '../src/queues/requests/inbox-compact.ts';

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-11-17T12:00:00Z');
const CUTOFF = NOW - 14 * DAY;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const raw = (inbox: Inbox, value: Record<string, unknown>) =>
  appendFileSync(inbox.file, JSON.stringify(value) + '\n');
const read = (id: string, time: string) => ({
  type: 'read',
  id,
  at: time,
  story: 's',
  chapter: 'c',
  reason: 'time',
});
const texts = (entries: unknown[]) => entries.map((entry) => (entry as QuestionEntry).text);

/** An inbox with old and new reads and positions between questions, and what compacting does to it. */
function build() {
  const inbox = new Inbox(tmp('inbox-compact'));
  inbox.append({ type: 'question', story: 's', text: 'q1', at: ago(40) });
  raw(inbox, read('rd_1', ago(30)));
  raw(inbox, { type: 'position', id: 'p_1', at: ago(30), story: 's' });
  inbox.append({ type: 'question', story: 's', text: 'q2', at: ago(20) });
  raw(inbox, read('rd_2', ago(20)));
  inbox.append({ type: 'question', story: 's', text: 'q3', at: ago(1) });
  raw(inbox, read('rd_3', ago(1)));
  return inbox;
}
const compactNow = (inbox: Inbox, beforeSwap?: () => void) => {
  let move = (offset: number) => offset;
  const done = replaceLog(
    inbox.file,
    (whole) => {
      const plan = compactInboxText(whole, CUTOFF);
      move = plan.remap;
      return plan.text;
    },
    {
      beforeSwap: () => {
        inbox.moveCursors((offset) => move(offset));
        beforeSwap?.();
      },
    },
  );
  return done;
};

test('old reads and positions go, a recent read and every question stay', () => {
  const inbox = build();
  compactNow(inbox);
  assert.deepEqual(
    inbox.all().map((entry) => entry.type),
    ['question', 'question', 'question', 'read'],
  );
  assert.ok(!readFileSync(inbox.file, 'utf8').includes('"position"'));
});

test('a consumer behind, in the middle and at the end keeps its place', () => {
  const inbox = build();
  // behind: has read nothing; middle: read up to and including q2's old read; end: read all
  inbox.setCursor('behind', 0);
  const lines = readFileSync(inbox.file, 'utf8').split('\n');
  const upTo = (count: number) => Buffer.byteLength(lines.slice(0, count).join('\n') + '\n');
  inbox.setCursor('middle', upTo(5)); // q1, rd_1, p_1, q2, rd_2 handed over
  inbox.setCursor('end', upTo(7));
  compactNow(inbox);
  assert.deepEqual(texts(inbox.unread('behind').filter((e) => e.type === 'question')), [
    'q1',
    'q2',
    'q3',
  ]);
  assert.deepEqual(texts(inbox.unread('middle').filter((e) => e.type === 'question')), ['q3']);
  assert.deepEqual(inbox.unread('end'), [], 'a cursor at the end stays at the end');
  inbox.append({ type: 'question', story: 's', text: 'q4' });
  assert.deepEqual(texts(inbox.unread('end')), ['q4']);
});

test('a line appended while it works, and a cursor past the old text, keep their place', () => {
  const inbox = build();
  const total = Buffer.byteLength(readFileSync(inbox.file, 'utf8'));
  inbox.setCursor('end', total);
  compactNow(inbox, () => inbox.append({ type: 'question', story: 's', text: 'q-late' }));
  assert.deepEqual(texts(inbox.unread('end')), ['q-late']);
});

test('nothing old: the text is the same and every offset maps to itself', () => {
  const inbox = new Inbox(tmp('inbox-compact'));
  inbox.append({ type: 'question', story: 's', text: 'q1' });
  const whole = readFileSync(inbox.file, 'utf8');
  const plan = compactInboxText(whole, CUTOFF);
  assert.equal(plan.text, whole);
  assert.equal(plan.removed, 0);
  assert.equal(plan.remap(whole.length), whole.length);
});

test('a read that advances a cursor waits for the inbox lock that a compaction holds, and a plain read does not', () => {
  const inbox = build();
  const lock = `${inbox.file}.lock`;
  mkdirSync(lock);
  const before = waitSeam.limitMs;
  waitSeam.limitMs = 200;
  try {
    assert.throws(
      () => inbox.unread('late', { advance: true }),
      (err: Error) => err.message.includes(lock),
    );
    assert.equal(inbox.getCursor('late'), 0, 'its cursor did not move');
    assert.equal(inbox.unread('late').length > 0, true);
  } finally {
    waitSeam.limitMs = before;
    rmdirSync(lock);
  }
  assert.ok(inbox.unread('late', { advance: true }).length > 0);
});
