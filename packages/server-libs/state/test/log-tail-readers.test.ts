/*
 * backlog.jsonl and inbox.jsonl are read on every board poll and panel pulse, so a process keeps what it parsed and parses
 * only what was appended (adapters' `tailLog`, which has its own tests). What these pin: another writer's append is seen, the
 * result is what a whole read gives, nothing already parsed is parsed again, and a replaced file is read afresh.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, renameSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { BacklogStore, backlogEventsIn, foldBacklog } from '../src/queues/backlog/backlog.ts';
import { Inbox, inboxEntriesIn } from '../src/queues/requests/inbox.ts';

test('backlog: an append from another store is seen, equals a whole fold, and parses only what is new', () => {
  const home = tmp('tail-backlog');
  const mine = new BacklogStore(home);
  const theirs = new BacklogStore(home);
  mine.add({ title: 'first' });
  mine.add({ title: 'second' });
  const parsed = backlogEventsIn(mine.file);
  assert.equal(parsed.length, 2);
  theirs.add({ title: 'third' });
  const items = mine.items();
  assert.deepEqual(
    items.map((one) => one.title),
    ['first', 'second', 'third'],
  );
  assert.deepEqual(items, foldBacklog(readFileSync(mine.file, 'utf8')));
  assert.equal(
    backlogEventsIn(mine.file)[0],
    parsed[0],
    'the first events are the ones parsed before',
  );
  theirs.start(items[0].id, { branch: 'b-one' });
  assert.equal(mine.items()[0].state, 'started');
  assert.equal(mine.items()[0].branch, 'b-one');
});

test('backlog: a replaced file is read afresh', () => {
  const home = tmp('tail-backlog');
  const store = new BacklogStore(home);
  store.add({ title: 'old one' });
  store.add({ title: 'old two' });
  const other = new BacklogStore(tmp('tail-backlog-other'));
  other.add({ title: 'only' });
  renameSync(other.file, store.file);
  assert.deepEqual(
    store.items().map((one) => one.title),
    ['only'],
  );
});

test('inbox: an append from another inbox is seen by all() and questions(), and parses only what is new', () => {
  const home = tmp('tail-inbox');
  const mine = new Inbox(home);
  const theirs = new Inbox(home);
  mine.append({ type: 'question', story: 's', text: 'one' });
  const first = inboxEntriesIn(mine.file);
  assert.equal(first.length, 1);
  const asked = theirs.append({ type: 'question', story: 's', text: 'two' });
  theirs.append({ type: 'answer', story: 's', question: asked.id, text: 'yes', by: 'me' });
  assert.equal(mine.all().length, 3);
  assert.equal(inboxEntriesIn(mine.file)[0], first[0], 'the first entry is the one parsed before');
  assert.deepEqual(
    mine.questions('s').map((question) => [question.text, question.answers.length]),
    [
      ['one', 0],
      ['two', 1],
    ],
  );
  assert.deepEqual(mine.all(), mine.readFrom(0).entries, 'what a read from the top gives');
});

test('inbox: a cursor still reads from its byte offset, whatever all() has cached', () => {
  const inbox = new Inbox(tmp('tail-inbox'));
  inbox.append({ type: 'question', story: 's', text: 'one' });
  inbox.all();
  assert.equal(inbox.unread('c', { advance: true }).length, 1);
  inbox.append({ type: 'question', story: 's', text: 'two' });
  assert.equal(inbox.all().length, 2);
  assert.deepEqual(
    inbox.unread('c', { advance: true }).map((e) => (e as { text: string }).text),
    ['two'],
  );
});
