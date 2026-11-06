import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { githubStory } from '@once-upon-a-diff/test-kit/stories';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
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
