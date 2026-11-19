import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR } from '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { githubStory } from '@once-upon-a-diff/test-kit/stories';
import { readHanded } from '@once-upon-a-diff/state/queues/requests/conversation';
import {
  forgetSessions,
  readBinding,
  writeBinding,
} from '@once-upon-a-diff/state/records/listeners/binding';
import { noteRelayed, relaysOf } from '../src/features/listeners/relay.ts';

const STORY = 'acme-widgets-7';
const OTHER_STORY = 'acme-widgets-8';
const OWNER = 'session-owner-1111';

/** A live Claude Code session in the registry (this test process stands in for it). */
function registerSession(session: string): void {
  forgetSessions();
  const dir = path.join(CLAUDE_DIR, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, `${process.pid}.json`), {
    pid: process.pid,
    sessionId: session,
    status: 'idle',
  });
}

test('relaysOf maps the entries of bound stories to their binding, skips the rest and touches a used binding', () => {
  const home = tmp('home');
  githubStory(path.join(home, STORY));
  githubStory(path.join(home, OTHER_STORY));
  registerSession(OWNER);
  const old = Date.now() - 3600 * 1000;
  writeBinding(home, STORY, 'ou-fix-cache', OWNER, old);
  const entries = [
    { type: 'question', id: 'q1', story: STORY },
    { type: 'question', id: 'q2', story: OTHER_STORY }, // no binding
    { type: 'build_request', id: 'b1', story: STORY, mode: 'rebuild' },
    { type: 'build_request', id: 'b2', story: STORY, mode: 'update' }, // not a rebuild
    { type: 'fix_request', id: 'f1', story: STORY }, // a GitHub story's fix is the listening session's
    { type: 'question', id: 'q3' }, // no story
  ];
  const relays = relaysOf(home, entries, OWNER);
  assert.deepEqual([...relays.keys()], ['q1', 'b1']);
  assert.equal(relays.get('q1')?.agent, 'ou-fix-cache');
  assert.ok(Date.parse(readBinding(home, STORY)!.at) > old, 'the used binding was touched');
});

test('relaysOf is empty for another session, and for no session or no entries', () => {
  const home = tmp('home');
  githubStory(path.join(home, STORY));
  registerSession(OWNER);
  writeBinding(home, STORY, 'ou-fix-cache', OWNER);
  const entries = [{ type: 'question', id: 'q1', story: STORY }];
  assert.equal(relaysOf(home, entries, 'session-other-2222').size, 0);
  assert.equal(relaysOf(home, entries, null).size, 0);
  assert.equal(relaysOf(home, [], OWNER).size, 0);
});

test('noteRelayed notes only the relayed questions, as handed to the agent through the consumer', () => {
  const home = tmp('home');
  const bound = { agent: 'ou-fix-cache', session: OWNER, at: new Date().toISOString() };
  const relays = new Map([
    ['q1', bound],
    ['b1', bound], // a rebuild request is relayed too, but it is no question
  ]);
  noteRelayed(home, relays, [{ id: 'q1' }, { id: 'q2' }], 'listener-1');
  const handed = readHanded(home);
  assert.deepEqual(Object.keys(handed), ['q1']);
  assert.equal(handed.q1.consumer, 'ou-fix-cache');
  assert.equal(handed.q1.via, 'listener-1');
  noteRelayed(home, new Map(), [{ id: 'q2' }], 'listener-1');
  assert.deepEqual(Object.keys(readHanded(home)), ['q1']);
});
