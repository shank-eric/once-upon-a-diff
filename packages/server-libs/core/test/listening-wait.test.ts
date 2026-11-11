import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { githubStory } from '@once-upon-a-diff/test-kit/stories';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { markQuestions, noteHanded } from '@once-upon-a-diff/state/queues/requests/conversation';
import { Listening } from '../src/features/listeners/service.ts';
import { handOverLines, stoppedEvent, stoppedLines } from '../src/features/listeners/hand-over.ts';

// `wait` as the service returns it, with no process to run: what it took, or why it stopped. The text a session reads
// (byte for byte, through the CLI) is pinned by packages/server/bridge/test/wait-golden.test.ts.

const STORY = 'acme-widgets-7';

test('wait returns the question it was handed, with the lines a session acts on', async () => {
  const home = tmp('home');
  const inbox = new Inbox(home);
  inbox.setCursor('repo-acme-widgets', 0);
  inbox.append({
    type: 'question',
    id: 'q_a',
    story: STORY,
    repo: 'acme/widgets',
    step: 1,
    text: 'Why?',
  });
  const outcome = await new Listening(home).wait({ repo: 'acme/widgets', cwd: home });
  assert.equal(outcome.kind, 'handed');
  if (outcome.kind !== 'handed') {
    return;
  }
  assert.equal(outcome.items.length, 1);
  assert.equal(outcome.items[0].entry.id, 'q_a');
  assert.equal(outcome.items[0].relay, undefined);
  assert.deepEqual(outcome.items[0].lines, handOverLines(outcome.items[0].entry));
  assert.match(outcome.items[0].lines.join('\n'), /Answer with: once-upon answer --question q_a/);
});

/** A question in the repo's inbox, `hoursAgo` old. */
const ask = (inbox: Inbox, id: string, hoursAgo = 0) =>
  inbox.append({
    type: 'question',
    id,
    story: STORY,
    repo: 'acme/widgets',
    step: 1,
    text: 'Why?',
    at: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  });

test("a question asked before a new consumer's first wait is handed over then, once", async () => {
  const home = tmp('home');
  const inbox = new Inbox(home);
  ask(inbox, 'q_early');
  const service = new Listening(home);
  const first = await service.wait({ repo: 'acme/widgets', timeout: '1', cwd: home });
  assert.equal(first.kind, 'handed');
  assert.deepEqual(first.kind === 'handed' ? first.items.map((item) => item.entry.id) : [], [
    'q_early',
  ]);
  assert.deepEqual(await service.wait({ repo: 'acme/widgets', timeout: '1', cwd: home }), {
    kind: 'timeout',
  });
});

test('a first wait hands over only the unanswered, undismissed, unhanded, day-fresh questions, oldest first', async () => {
  const home = tmp('home');
  githubStory(path.join(home, STORY));
  const inbox = new Inbox(home);
  ask(inbox, 'q_old', 25);
  ask(inbox, 'q_answered', 3);
  inbox.append({ type: 'answer', question: 'q_answered', text: 'Because.' });
  ask(inbox, 'q_dismissed', 2);
  markQuestions(home, STORY, 'dismiss', ['q_dismissed']);
  ask(inbox, 'q_elsewhere', 2);
  noteHanded(home, ['q_elsewhere'], 'someone-else');
  ask(inbox, 'q_b', 1);
  ask(inbox, 'q_a', 5);
  const outcome = await new Listening(home).wait({ repo: 'acme/widgets', timeout: '1', cwd: home });
  assert.equal(outcome.kind, 'handed');
  assert.deepEqual(outcome.kind === 'handed' ? outcome.items.map((item) => item.entry.id) : [], [
    'q_a',
    'q_b',
  ]);
});

test("a question of another repo or story isn't handed to a new consumer's first wait", async () => {
  const home = tmp('home');
  const inbox = new Inbox(home);
  inbox.append({
    type: 'question',
    id: 'q_other',
    story: 'acme-other-1',
    repo: 'acme/other',
    text: 'Hm?',
  });
  assert.deepEqual(
    await new Listening(home).wait({ repo: 'acme/widgets', timeout: '1', cwd: home }),
    { kind: 'timeout' },
  );
});

test('wait returns a timeout when nothing arrives, and a stop when the story goes quiet', async () => {
  const home = tmp('home');
  writeJson(path.join(home, 'config.json'), { story_listener_idle_minutes: 1 / 60 });
  githubStory(path.join(home, STORY));
  const service = new Listening(home);
  assert.deepEqual(await service.wait({ repo: 'acme/widgets', timeout: '1', cwd: home }), {
    kind: 'timeout',
  });
  assert.deepEqual(await service.wait({ story: STORY, timeout: '20', cwd: home }), {
    kind: 'stopped',
    scope: { story: STORY },
    reason: 'no page has shown the story for 1 second',
  });
});

test('wait refuses a repo that is not owner/name before it beats', async () => {
  const home = tmp('home');
  await assert.rejects(
    new Listening(home).wait({ repo: 'nonsense', cwd: home }),
    /usage: once-upon wait --repo owner\/name/,
  );
});

test('the stop notice, in words and as the --json event', () => {
  assert.deepEqual(stoppedLines({ repo: 'a/b' }, 'because'), [
    'Stopped listening for a/b: because.',
    "Don't start this wait again. Start listening (the panel, the PR pages or the board) starts a repo listener again.",
  ]);
  assert.equal(stoppedLines({ story: 's-1' }, 'because')[0], 'Stopped listening for s-1: because.');
  assert.deepEqual(stoppedEvent({ story: 's-1' }, 'because', new Date(0)), {
    type: 'listen_stopped',
    story: 's-1',
    reason: 'because',
    at: '1970-01-01T00:00:00.000Z',
  });
});
