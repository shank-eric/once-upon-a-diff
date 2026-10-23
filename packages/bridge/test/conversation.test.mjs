import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmp, githubStory, startBridge, runCli } from './helpers.mjs';
import { Inbox } from '../src/inbox/inbox.ts';
import { markQuestions, readHanded } from '../src/inbox/conversation.ts';
import { beat, listenPrompt, listeningOf } from '../src/listeners/listeners.ts';
import { storyIdOf } from '../src/cli/commands/inbox.ts';
import { askWhoHtml } from '@once-upon-a-diff/shared/panel/status-light';

const STORY = 'acme-widgets-7';
const PATH = `/api/stories/${STORY}/questions`;

describe('clearing, collapsing and dismissing the conversation', () => {
  test('marks are kept per story in the bridge, so a reload and the next poll show the same', async () => {
    const home = tmp('home');
    githubStory(path.join(home, STORY));
    const bridge = await startBridge({ home });
    const listOf = async () => (await bridge.call('GET', PATH)).body.questions;
    const pulse = async () => (await bridge.call('GET', `/api/stories/${STORY}/pulse`)).body;
    try {
      const first = (await bridge.call('POST', PATH, { text: 'One?', step: 1 })).body;
      const second = (await bridge.call('POST', PATH, { text: 'Two?', step: 2 })).body;
      let questions = await listOf();
      assert.deepEqual(
        questions.map((question) => [question.dismissed, question.collapsed]),
        [
          [false, false],
          [false, false],
        ],
      );
      const before = (await pulse()).questions_rev;

      const collapsed = await bridge.call('POST', `${PATH}/marks`, {
        action: 'collapse',
        ids: [first.id],
      });
      assert.equal(collapsed.status, 200);
      assert.equal(collapsed.body.questions[0].collapsed, true, 'the answer is the new list');
      assert.notEqual((await pulse()).questions_rev, before, 'other tabs see it on their pulse');

      await bridge.call('POST', `${PATH}/marks`, { action: 'dismiss', ids: [second.id, 'q_nope'] });
      questions = await listOf();
      assert.equal(questions.length, 2, 'a dismissed question is still listed, marked');
      assert.equal(questions.find((question) => question.id === second.id).dismissed, true);
      assert.equal(questions.find((question) => question.id === first.id).collapsed, true);
      const saved = JSON.parse(
        readFileSync(path.join(home, 'state', STORY, 'questions.json'), 'utf8'),
      );
      assert.deepEqual(Object.keys(saved.dismissed), [second.id], 'unknown ids are dropped');

      const cleared = await bridge.call('POST', `${PATH}/marks`, { action: 'clear' });
      assert.deepEqual(cleared.body.cleared, [first.id], 'clear names what it dismissed, for Undo');
      assert.ok(cleared.body.questions.every((question) => question.dismissed));
      await bridge.call('POST', `${PATH}/marks`, { action: 'restore', ids: cleared.body.cleared });
      questions = await listOf();
      assert.deepEqual(
        questions.map((question) => question.dismissed),
        [false, true],
        'Undo restores only what Clear dismissed',
      );

      assert.equal(
        (await bridge.call('POST', `${PATH}/marks`, { action: 'explode', ids: [] })).status,
        400,
      );
      assert.equal((await bridge.call('POST', `${PATH}/nope`, { action: 'clear' })).status, 404);
    } finally {
      await bridge.close();
    }
  });
});

describe('one story, one session', () => {
  const wait = async (home, ...args) => {
    const result = await runCli(home, [
      'wait',
      '--type',
      'question',
      '--timeout',
      '1',
      '--json',
      ...args,
    ]);
    return {
      code: result.code,
      stderr: result.stderr,
      ids: result.stdout.trim()
        ? result.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line).id)
        : [],
    };
  };
  /** A listener whose last beat is a minute old, so it no longer counts. */
  const goStale = (home, consumer, extra) =>
    writeFileSync(
      path.join(home, 'listeners', `${consumer}.json`),
      JSON.stringify({
        consumer,
        pid: process.pid,
        state: 'waiting',
        at: new Date(Date.now() - 60000).toISOString(),
        ...extra,
      }),
    );

  test("a story's own listener takes its questions ahead of the repo's, and the repo's takes them when it's gone", async () => {
    const home = tmp('home');
    githubStory(path.join(home, STORY));
    const inbox = new Inbox(home);
    writeFileSync(inbox.file, '');
    // both have waited before, so their cursors are at the top
    inbox.setCursor('repo-acme-widgets', 0);
    inbox.setCursor('furnace-10', 0);
    const ask = (id) =>
      inbox.append({ type: 'question', id, story: STORY, repo: 'acme/widgets', text: id });

    beat(home, 'furnace-10', 'waiting', { story: STORY });
    ask('q_one');
    assert.deepEqual(
      (await wait(home, '--repo', 'acme/widgets')).ids,
      [],
      "the repo's listener leaves it to the story's",
    );
    const storyWait = await wait(home, '--story', 'acme/widgets#7', '--consumer', 'furnace-10');
    assert.deepEqual(storyWait.ids, ['q_one'], '--story takes owner/name#N');
    assert.equal(readHanded(home).q_one.consumer, 'furnace-10');
    goStale(home, 'furnace-10', { story: STORY });
    assert.deepEqual(
      (await wait(home, '--repo', 'acme/widgets')).ids,
      [],
      'a question handed to one session is not handed to another',
    );

    const answered = await runCli(home, ['answer', '--question', 'q_one', '--text', 'Because.']);
    assert.equal(answered.code, 0, answered.stderr);
    assert.equal(inbox.questions(STORY)[0].answers[0].by, 'furnace-10', 'who answered');

    ask('q_two');
    assert.deepEqual(
      (await wait(home, '--repo', 'acme/widgets')).ids,
      ['q_two'],
      "with no live story listener, the repo's takes it",
    );

    beat(home, 'furnace-10', 'waiting', { story: STORY });
    ask('q_three');
    assert.deepEqual((await wait(home, '--repo', 'acme/widgets')).ids, []);
    goStale(home, 'furnace-10', { story: STORY });
    assert.deepEqual(
      (await wait(home, '--repo', 'acme/widgets')).ids,
      ['q_three'],
      'a question left to a story listener that went away comes back to the repo listener',
    );

    ask('q_four');
    markQuestions(home, STORY, 'dismiss', ['q_four']);
    assert.deepEqual(
      (await wait(home, '--repo', 'acme/widgets')).ids,
      [],
      'a dismissed question is not handed over',
    );

    const byHand = await runCli(home, [
      'answer',
      '--question',
      'q_two',
      '--text',
      'Done.',
      '--consumer',
      'me',
    ]);
    assert.equal(byHand.code, 0, byHand.stderr);
    assert.equal(
      inbox.questions(STORY).find((question) => question.id === 'q_two').answers[0].by,
      'me',
      '--consumer names who answered',
    );
    assert.ok(existsSync(path.join(home, 'cursors', 'repo-acme-widgets.deferred.json')));
  });

  test('--story takes an id, owner/name#N, a PR URL or a PR number in this checkout', () => {
    const home = tmp('home');
    githubStory(path.join(home, 'acme-widgets-7-v2'));
    const here = () => 'acme/widgets';
    assert.equal(storyIdOf(home, 'local-x', here), 'local-x');
    assert.equal(storyIdOf(home, 'acme/widgets#7', here), 'acme-widgets-7-v2', 'the story it has');
    assert.equal(
      storyIdOf(home, 'https://github.com/ACME/widgets/pull/7/changes', here),
      'acme-widgets-7-v2',
    );
    assert.equal(storyIdOf(home, '7', here), 'acme-widgets-7-v2');
    assert.equal(storyIdOf(home, '8', here), 'acme-widgets-8', 'the id publish will give it');
    assert.throws(() => storyIdOf(home, '8', () => null), /owner\/name#8/);
  });

  test('the panel says who answers, and copies the prompt for this story', () => {
    const home = tmp('home');
    const story = listenPrompt({ story: STORY }, 'once-upon');
    assert.equal(story.prompt, `/once-upon-listen --story ${STORY}`);
    assert.equal(
      story.command,
      `once-upon wait --story ${STORY} --type question,build_request,fix_request`,
    );
    assert.match(
      story.details,
      /For a build request \(the panel's Rebuild\)/,
      "a story listener takes the story's rebuilds, and no other builds",
    );
    assert.ok(!story.details.includes('/once-upon <PR url>'));

    let listening = listeningOf(home, { repo: 'acme/widgets', story: STORY });
    assert.equal(listening.answering, null);
    assert.equal(listening.story_prompt.prompt, `/once-upon-listen --story ${STORY}`);
    beat(home, 'repo-acme-widgets', 'waiting', { repo: 'acme/widgets' });
    listening = listeningOf(home, { repo: 'acme/widgets', story: STORY });
    assert.deepEqual(listening.answering, { consumer: 'repo-acme-widgets', scope: 'repo' });
    beat(home, 'furnace-10', 'waiting', { story: STORY });
    listening = listeningOf(home, { repo: 'acme/widgets', story: STORY });
    assert.deepEqual(listening.answering, { consumer: 'furnace-10', scope: 'story' });
    assert.equal(
      listeningOf(home, { repo: 'acme/widgets', story: 'acme-widgets-8' }).answering.consumer,
      'repo-acme-widgets',
      "another story's listener doesn't answer this one",
    );

    const result = {
      level: 'ok',
      prompt: '/once-upon-listen acme/widgets',
      storyPrompt: { prompt: `/once-upon-listen --story ${STORY}` },
    };
    const byRepo = String(
      askWhoHtml({
        ...result,
        answering: { consumer: 'repo-acme-widgets', scope: 'repo' },
      }),
    );
    assert.match(byRepo, /Answered by <b>repo-acme-widgets<\/b> \(listening for the whole repo\)/);
    assert.match(byRepo, /Copy prompt for this story/);
    const byStory = String(
      askWhoHtml({
        ...result,
        answering: { consumer: 'furnace-10', scope: 'story' },
      }),
    );
    assert.match(byStory, /Answered by <b>furnace-10<\/b>, the session listening for this story/);
    assert.doesNotMatch(byStory, /Copy prompt/);
    assert.match(String(askWhoHtml({ ...result, answering: null })), /Copy prompt for this story/);
    assert.equal(String(askWhoHtml({ level: 'error' })), '');
  });
});
