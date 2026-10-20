import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { tmp } from './helpers.mjs';
import { Inbox } from '../bridge/lib/inbox.mjs';
import { parseUnifiedDiff } from '../bridge/lib/diff.mjs';

test('readers keep their own cursor', () => {
  const inbox = new Inbox(tmp('inbox'));
  inbox.append({ type: 'question', story: 's', text: 'one' });
  assert.equal(inbox.unread('claude', { advance: true }).length, 1);
  assert.equal(inbox.unread('claude', { advance: true }).length, 0);
  inbox.append({ type: 'question', story: 's', text: 'two' });
  assert.deepEqual(inbox.unread('claude', { advance: true }).map(e => e.text), ['two']);
  assert.equal(inbox.unread('hook').length, 2, 'another reader starts from the top');
});

test('a half-written last line waits for the next read', () => {
  const inbox = new Inbox(tmp('inbox'));
  inbox.append({ type: 'question', story: 's', text: 'one' });
  appendFileSync(inbox.file, '{"type":"question","text":"tw');
  assert.equal(inbox.unread('c', { advance: true }).length, 1);
  appendFileSync(inbox.file, 'o"}\n');
  assert.deepEqual(inbox.unread('c', { advance: true }).map(e => e.text), ['two']);
});

test('answers attach to their questions', () => {
  const inbox = new Inbox(tmp('inbox'));
  const q = inbox.append({ type: 'question', story: 's', text: 'why?' });
  inbox.append({ type: 'question', story: 'other', text: 'elsewhere' });
  inbox.append({ type: 'answer', question: q.id, story: 's', text: 'because' });
  const qs = inbox.questions('s');
  assert.equal(qs.length, 1);
  assert.equal(qs[0].answers[0].text, 'because');
});

test('parses a unified diff', () => {
  const diff = parseUnifiedDiff([
    'diff --git a/x.js b/x.js', 'index 1..2 100644', '--- a/x.js', '+++ b/x.js', '@@ -1,2 +1,3 @@ fn()', ' a', '-b', '+B', '+c',
    'diff --git a/old.js b/new.js', 'similarity index 90%', 'rename from old.js', 'rename to new.js',
  ].join('\n'));
  const x = diff.get('x.js');
  assert.deepEqual(x.stats, { added: 2, removed: 1 });
  assert.equal(x.hunks[0].header, 'fn()');
  assert.equal(diff.get('new.js').kind, 'renamed');
  assert.equal(diff.get('new.js').renamed_from, 'old.js');
  assert.notEqual(x.hash, diff.get('new.js').hash);
});
