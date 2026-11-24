import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rmSync } from 'node:fs';
import '@once-upon-a-diff/test-kit/env';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { githubStory } from '@once-upon-a-diff/test-kit/stories';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { markQuestions, noteHanded } from '@once-upon-a-diff/state/queues/requests/conversation';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { approveStory } from '../src/features/review/approve.ts';
import { Listening } from '../src/features/listeners/service.ts';
import { pollMsOf } from '../src/features/listeners/wait.ts';
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

test('wait returns a timeout when nothing arrives, and a story wait stays past the old idle window until approved', async () => {
  const home = tmp('home');
  // the old no-page window (a second here): a story wait now ignores it, and a repo wait is not the story's
  writeJson(path.join(home, 'config.json'), { story_listener_idle_minutes: 1 / 60 });
  githubStory(path.join(home, STORY));
  const service = new Listening(home);
  assert.deepEqual(await service.wait({ repo: 'acme/widgets', timeout: '1', cwd: home }), {
    kind: 'timeout',
  });
  // nothing shows the story, and the wait is still there 2.5 s on (past that window), then ends on the approval
  const waiting = service.wait({ story: STORY, cwd: home, pollSeconds: 0.05 });
  let ended = false;
  void waiting.then(() => {
    ended = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(ended, false, 'a story wait with no page showing it is still waiting');
  new Inbox(home).append({
    type: 'approved',
    id: 'ap_late',
    story: STORY,
    repo: 'acme/widgets',
    branch: 'ou-cache',
    checkout: '/work/widgets-worktrees/ou-cache',
    base: 'main',
    head_sha: 'b'.repeat(40),
  });
  const outcome = await waiting;
  assert.equal(outcome.kind, 'handed');
});

test('a story wait stops, with its reason, when the story is deleted', async () => {
  const home = tmp('home');
  githubStory(path.join(home, STORY));
  const waiting = new Listening(home).wait({ story: STORY, cwd: home, pollSeconds: 0.05 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(path.join(home, STORY), { recursive: true });
  assert.deepEqual(await waiting, {
    kind: 'stopped',
    scope: { story: STORY },
    reason: 'the story is no longer there',
  });
});

test('a story wait stops once an approval that counts is on its story, and hands over an approval made while it waits', async () => {
  const home = tmp('home');
  const head = 'b'.repeat(40);
  githubStory(path.join(home, STORY), { meta: { head_oid: head } });
  const stories = new StoryStore({ home });
  const inbox = new Inbox(home);
  const service = new Listening(home);
  // Approve writes the record, then the line: a wait that looks in between hands the line over, it doesn't stop
  const waiting = service.wait({ story: STORY, cwd: home, pollSeconds: 0.05 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  approveStory(stories, inbox, {
    id: STORY,
    ref: { story: STORY, kind: 'github', title: undefined, repo: 'acme/widgets' },
    branch: 'ou-cache',
    checkout: '/work/widgets-worktrees/ou-cache',
    base: 'main',
    headOid: head,
    baseOid: null,
  });
  assert.equal((await waiting).kind, 'handed');
  // a wait started on the approved story (the listen skill's step 4, were it to restart one) ends at once
  assert.deepEqual(await service.wait({ story: STORY, cwd: home, pollSeconds: 0.05 }), {
    kind: 'stopped',
    scope: { story: STORY },
    reason: 'the story is approved',
  });
});

test('--keep and --no-auto-stop keep a story wait going after its story is deleted', async () => {
  for (const flags of [{ keep: true }, { noAutoStop: true }]) {
    const home = tmp('home');
    githubStory(path.join(home, STORY));
    const waiting = new Listening(home).wait({
      story: STORY,
      cwd: home,
      pollSeconds: 0.05,
      timeout: '1',
      ...flags,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(path.join(home, STORY), { recursive: true });
    assert.deepEqual(await waiting, { kind: 'timeout' });
  }
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
  // no catch-up or restart steps: a story that is no longer in review has nothing to catch up on
  assert.equal(stoppedLines({ story: 's-1' }, 'because').length, 2);
  assert.doesNotMatch(
    stoppedLines({ story: 's-1' }, 'because').join('\n'),
    /--timeout 1|Start listening/,
  );
  assert.deepEqual(stoppedEvent({ story: 's-1' }, 'because', new Date(0)), {
    type: 'listen_stopped',
    story: 's-1',
    reason: 'because',
    at: '1970-01-01T00:00:00.000Z',
  });
});

test('a poll of a finite number from 10 ms to an hour is kept, anything else is the 2 s default', () => {
  assert.equal(pollMsOf(0.2), 200);
  assert.equal(pollMsOf(2), 2000);
  assert.equal(pollMsOf(3600), 3_600_000);
  for (const bad of [
    undefined,
    NaN,
    0,
    -1,
    Infinity,
    -Infinity,
    0.0001,
    0.009,
    3601,
    2147484,
    1e12,
  ]) {
    assert.equal(pollMsOf(bad), 2000, String(bad));
  }
});
