import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmp, githubStory, startBridge, runCli } from './helpers.ts';
import { Inbox } from '@once-upon-a-diff/core/queues/requests/inbox';
import {
  markQuestions,
  noteHanded,
  readAsking,
  readHanded,
  statusOf,
  unreadAnswers,
  withMarks,
} from '@once-upon-a-diff/core/queues/requests/conversation';
import {
  beat,
  listenPrompt,
  listeningOf,
} from '@once-upon-a-diff/core/records/listeners/listeners';
import { storyIdOf } from '@once-upon-a-diff/cli/commands/inbox';
import { askWhoHtml, type Health } from '@once-upon-a-diff/panel/components/status-light';
import type { StatusMany } from './helpers.ts';
import type { Pulse, Question, QuestionMarksAnswer } from '@once-upon-a-diff/contracts/types';

const STORY = 'acme-widgets-7';
const PATH = `/api/stories/${STORY}/questions`;

describe('clearing, collapsing and dismissing the conversation', () => {
  test('marks are kept per story in the bridge, so a reload and the next poll show the same', async () => {
    const home = tmp('home');
    githubStory(path.join(home, STORY));
    const bridge = await startBridge({ home });
    const listOf = async () =>
      (await bridge.call<{ questions: Question[] }>('GET', PATH)).body.questions;
    const pulse = async () => (await bridge.call<Pulse>('GET', `/api/stories/${STORY}/pulse`)).body;
    try {
      const first = (await bridge.call<{ id: string }>('POST', PATH, { text: 'One?', step: 1 }))
        .body;
      const second = (await bridge.call<{ id: string }>('POST', PATH, { text: 'Two?', step: 2 }))
        .body;
      let questions = await listOf();
      assert.deepEqual(
        questions.map((question) => [question.dismissed, question.collapsed]),
        [
          [false, false],
          [false, false],
        ],
      );
      const before = (await pulse()).questions_rev;

      const collapsed = await bridge.call<QuestionMarksAnswer>('POST', `${PATH}/marks`, {
        action: 'collapse',
        ids: [first.id],
      });
      assert.equal(collapsed.status, 200);
      assert.equal(collapsed.body.questions[0].collapsed, true, 'the answer is the new list');
      assert.notEqual((await pulse()).questions_rev, before, 'other tabs see it on their pulse');

      await bridge.call('POST', `${PATH}/marks`, { action: 'dismiss', ids: [second.id, 'q_nope'] });
      questions = await listOf();
      assert.equal(questions.length, 2, 'a dismissed question is still listed, marked');
      assert.equal(questions.find((question) => question.id === second.id)!.dismissed, true);
      assert.equal(questions.find((question) => question.id === first.id)!.collapsed, true);
      const saved = JSON.parse(
        readFileSync(path.join(home, 'state', STORY, 'questions.json'), 'utf8'),
      );
      assert.deepEqual(Object.keys(saved.dismissed), [second.id], 'unknown ids are dropped');

      const cleared = await bridge.call<QuestionMarksAnswer>('POST', `${PATH}/marks`, {
        action: 'clear',
      });
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
  const wait = async (home: string, ...args: string[]) => {
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
            .map((line) => (JSON.parse(line) as { id: string }).id)
        : [],
    };
  };
  /** A listener whose last beat is a minute old, so it no longer counts. */
  const goStale = (home: string, consumer: string, extra: Record<string, unknown>) =>
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
    inbox.setCursor('api-10', 0);
    const ask = (id: string) =>
      inbox.append({ type: 'question', id, story: STORY, repo: 'acme/widgets', text: id });

    beat(home, 'api-10', 'waiting', { story: STORY });
    ask('q_one');
    assert.deepEqual(
      (await wait(home, '--repo', 'acme/widgets')).ids,
      [],
      "the repo's listener leaves it to the story's",
    );
    const storyWait = await wait(home, '--story', 'acme/widgets#7', '--consumer', 'api-10');
    assert.deepEqual(storyWait.ids, ['q_one'], '--story takes owner/name#N');
    assert.equal(readHanded(home).q_one.consumer, 'api-10');
    goStale(home, 'api-10', { story: STORY });
    assert.deepEqual(
      (await wait(home, '--repo', 'acme/widgets')).ids,
      [],
      'a question handed to one session is not handed to another',
    );

    const answered = await runCli(home, ['answer', '--question', 'q_one', '--text', 'Because.']);
    assert.equal(answered.code, 0, answered.stderr);
    assert.equal(inbox.questions(STORY)[0].answers[0].by, 'api-10', 'who answered');

    ask('q_two');
    assert.deepEqual(
      (await wait(home, '--repo', 'acme/widgets')).ids,
      ['q_two'],
      "with no live story listener, the repo's takes it",
    );

    beat(home, 'api-10', 'waiting', { story: STORY });
    ask('q_three');
    assert.deepEqual((await wait(home, '--repo', 'acme/widgets')).ids, []);
    goStale(home, 'api-10', { story: STORY });
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
      inbox.questions(STORY).find((question) => question.id === 'q_two')!.answers[0].by,
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
      `once-upon wait --story ${STORY} --type question,build_request,fix_request,approved`,
    );
    assert.match(
      story.details,
      /For a build request \(the panel's Rebuild\)/,
      "a story listener takes the story's rebuilds, and no other builds",
    );
    assert.ok(!story.details.includes('/once-upon <PR url>'));

    let listening = listeningOf(home, { repo: 'acme/widgets', story: STORY });
    assert.equal(listening.answering, null);
    assert.equal(listening.story_prompt!.prompt, `/once-upon-listen --story ${STORY}`);
    beat(home, 'repo-acme-widgets', 'waiting', { repo: 'acme/widgets' });
    listening = listeningOf(home, { repo: 'acme/widgets', story: STORY });
    assert.deepEqual(listening.answering, { consumer: 'repo-acme-widgets', scope: 'repo' });
    beat(home, 'api-10', 'waiting', { story: STORY });
    listening = listeningOf(home, { repo: 'acme/widgets', story: STORY });
    assert.deepEqual(listening.answering, { consumer: 'api-10', scope: 'story' });
    assert.equal(
      listeningOf(home, { repo: 'acme/widgets', story: 'acme-widgets-8' }).answering!.consumer,
      'repo-acme-widgets',
      "another story's listener doesn't answer this one",
    );

    // just what askWhoHtml reads of the status light's health
    const result = {
      level: 'ok' as const,
      prompt: '/once-upon-listen acme/widgets',
      storyPrompt: { prompt: `/once-upon-listen --story ${STORY}` },
    };
    const byRepo = String(
      askWhoHtml(
        {
          ...result,
          answering: { consumer: 'repo-acme-widgets', scope: 'repo' },
        } as Health,
        true,
      ),
    );
    assert.match(byRepo, /Answered by <b>repo-acme-widgets<\/b> \(listening for the whole repo\)/);
    assert.match(byRepo, /Start listening for this story/);
    const byStory = String(
      askWhoHtml(
        {
          ...result,
          answering: { consumer: 'api-10', scope: 'story' },
        } as Health,
        true,
      ),
    );
    assert.match(byStory, /Answered by <b>api-10<\/b>, the session listening for this story/);
    assert.doesNotMatch(byStory, /Start listening/);
    assert.match(
      String(askWhoHtml({ ...result, answering: null } as Health, true)),
      /Start listening for this story/,
    );
    assert.equal(String(askWhoHtml({ level: 'error' } as Health)), '');
  });
});

describe('unread answers', () => {
  const ago = (millis: number) => new Date(Date.now() - millis).toISOString();
  const DAY = 24 * 3600 * 1000;
  const setup = (home: string) => {
    githubStory(path.join(home, STORY));
    const inbox = new Inbox(home);
    const ask = (id: string) =>
      inbox.append({ type: 'question', id, story: STORY, repo: 'acme/widgets', step: 1, text: id });
    const answer = (question: string, when: string) =>
      inbox.append({ type: 'answer', question, story: STORY, text: 'Because.', at: when });
    return { inbox, ask, answer };
  };

  test('an answer is unread until it is read, and a newer one is unread again', async () => {
    const home = tmp('home');
    const { ask, answer } = setup(home);
    const bridge = await startBridge({ home });
    const listOf = async () =>
      (await bridge.call<{ questions: Question[] }>('GET', PATH)).body.questions;
    const pulse = async () => (await bridge.call<Pulse>('GET', `/api/stories/${STORY}/pulse`)).body;
    try {
      ask('q_one');
      ask('q_two');
      assert.deepEqual(
        (await listOf()).map((question) => question.unread),
        [false, false],
        'no answer, nothing to read',
      );
      assert.equal((await pulse()).unread_answers, 0);
      const before = (await pulse()).questions_rev;
      answer('q_one', ago(60000));
      assert.equal((await listOf())[0].unread, true);
      assert.equal((await pulse()).unread_answers, 1);
      assert.notEqual((await pulse()).questions_rev, before, 'the panel refreshes on the pulse');

      const read = await bridge.call<QuestionMarksAnswer>('POST', `${PATH}/marks`, {
        action: 'read',
        ids: ['q_one'],
      });
      assert.equal(read.body.questions[0].unread, false);
      assert.ok(read.body.questions[0].read_at);
      assert.equal((await pulse()).unread_answers, 0);

      await new Promise((resolve) => setTimeout(resolve, 5));
      answer('q_one', new Date().toISOString());
      assert.equal((await listOf())[0].unread, true, 'a newer answer to a read question');

      await bridge.call('POST', `${PATH}/marks`, { action: 'dismiss', ids: ['q_one'] });
      assert.equal((await listOf())[0].unread, false, 'a dismissed question has nothing unread');
      await bridge.call('POST', `${PATH}/marks`, { action: 'restore', ids: ['q_one'] });
      assert.equal((await listOf())[0].unread, true, 'a restored question is as unread as it was');

      answer('q_two', ago(1000));
      const all = await bridge.call<QuestionMarksAnswer>('POST', `${PATH}/marks`, {
        action: 'read_all',
      });
      assert.ok(all.body.questions.every((question) => !question.unread));
      await bridge.call('POST', `${PATH}/marks`, { action: 'unread', ids: ['q_two'] });
      assert.deepEqual(
        (await listOf()).map((question) => question.unread),
        [false, true],
        'Mark unread brings one back',
      );
    } finally {
      await bridge.close();
    }
  });

  test('an old answer nobody marked is not unread, unless it is marked unread', () => {
    const home = tmp('home');
    const { inbox, ask, answer } = setup(home);
    ask('q_old');
    answer('q_old', ago(10 * DAY));
    ask('q_new');
    answer('q_new', ago(2 * DAY));
    assert.equal(unreadAnswers(home, inbox).get(STORY), 1, 'only the one inside the week');
    markQuestions(home, STORY, 'unread', ['q_old']);
    assert.equal(unreadAnswers(home, inbox).get(STORY), 2);
    markQuestions(home, STORY, 'read', ['q_old', 'q_new']);
    assert.equal(unreadAnswers(home, inbox).size, 0);
  });

  test('a question with no answer is queued, then a session is on it, then it may go quiet', () => {
    const home = tmp('home');
    const { inbox, ask } = setup(home);
    ask('q_one');
    const list = () => withMarks(home, STORY, inbox.questions(STORY))[0];
    assert.equal(list().status?.state, 'queued');
    assert.equal(list().status?.by, null);

    noteHanded(home, ['q_one'], 'repo-acme-widgets');
    let status = list().status!;
    assert.equal(status.state, 'working');
    assert.equal(status.by, 'repo-acme-widgets');
    assert.equal(status.note, null);

    const run = (...args: string[]) => runCli(home, args);
    return run('asking', '--question', 'q_one', '--note', 'reading auth.ts').then(
      async (result) => {
        assert.equal(result.code, 0, result.stderr);
        status = list().status!;
        assert.equal(status.note, 'reading auth.ts');
        assert.ok(status.note_at);

        // quiet for ten minutes: gone quiet, unless its listener's beat says it is handling this question. A listener
        // back in wait is no sign of work on it
        const later = Date.now() + 10 * 60 * 1000;
        const handed = readHanded(home).q_one;
        const asking = readAsking(home).q_one;
        assert.equal(statusOf(handed, asking, false, later).state, 'stalled');
        assert.equal(statusOf(handed, asking, true, later).state, 'working');
        assert.equal(statusOf(handed, asking, false, Date.now() + 1000).state, 'working');
        assert.equal(
          statusOf(handed, undefined, false, Date.now() + 4 * 60 * 1000).state,
          'working',
        );
        assert.equal(
          statusOf(handed, undefined, false, Date.now() + 6 * 60 * 1000).state,
          'stalled',
        );
        assert.equal(statusOf(undefined, undefined, true, later).state, 'queued');

        const missing = await run('asking', '--question', 'q_nope', '--note', 'x');
        assert.notEqual(missing.code, 0);
        const bare = await run('asking', '--question', 'q_one');
        assert.notEqual(bare.code, 0, 'a note is required');

        // the answer clears the note and the status
        const answered = await run('answer', '--question', 'q_one', '--text', 'Done.');
        assert.equal(answered.code, 0, answered.stderr);
        assert.equal(readAsking(home).q_one, undefined);
        assert.equal(list().status, null);
        const after = await run('asking', '--question', 'q_one', '--note', 'late');
        assert.match(after.stdout, /already answered/);
        assert.equal(readAsking(home).q_one, undefined);
      },
    );
  });

  test("the pulse changes when a session's note does, so the panel redraws", async () => {
    const home = tmp('home');
    const { ask } = setup(home);
    ask('q_one');
    noteHanded(home, ['q_one'], 'repo-acme-widgets');
    const bridge = await startBridge({ home });
    try {
      const pulse = async () =>
        (await bridge.call<Pulse>('GET', `/api/stories/${STORY}/pulse`)).body.questions_rev;
      const first = await pulse();
      await runCli(home, ['asking', '--question', 'q_one', '--note', 'writing the answer']);
      assert.notEqual(await pulse(), first);
    } finally {
      await bridge.close();
    }
  });

  test('status-many says how many answers of a PR are unread', async () => {
    const home = tmp('home');
    const { ask, answer } = setup(home);
    ask('q_one');
    answer('q_one', ago(1000));
    const bridge = await startBridge({ home });
    try {
      const lookup = async () =>
        (
          await bridge.call<StatusMany>('POST', '/api/stories/status-many', {
            prs: [{ repo: 'acme/widgets', number: 7 }],
          })
        ).body.results[0];
      assert.equal((await lookup()).unread_answers, 1);
      await bridge.call('POST', `${PATH}/marks`, { action: 'read', ids: ['q_one'] });
      // status-many keeps its story list for 5s, but the count is read fresh
      assert.equal((await lookup()).unread_answers, 0);
    } finally {
      await bridge.close();
    }
  });

  test('a question handed over long ago shows as gone quiet unless its listener is handling it', () => {
    const home = tmp('home');
    const { inbox, ask } = setup(home);
    ask('q_one');
    ask('q_two');
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    writeFileSync(
      path.join(home, 'handed.json'),
      JSON.stringify({
        q_one: { consumer: 'repo-acme-widgets', at: old },
        q_two: { consumer: 'repo-acme-widgets', at: old },
      }),
    );
    const states = () =>
      Object.fromEntries(
        withMarks(home, STORY, inbox.questions(STORY)).map((question) => [
          question.id,
          question.status?.state,
        ]),
      );
    // the listener went back to wait: nothing says it is on either one
    beat(home, 'repo-acme-widgets', 'waiting', { repo: 'acme/widgets' });
    assert.deepEqual(states(), { q_one: 'stalled', q_two: 'stalled' });
    // a handover carries more than one question: its beat names them all
    beat(home, 'repo-acme-widgets', 'handling', {
      question: 'q_one',
      questions: ['q_one', 'q_two'],
    });
    assert.deepEqual(states(), { q_one: 'working', q_two: 'working' });
  });

  test('a read marks the answer the panel drew, never a newer one, and Mark unread holds until a read by hand', async () => {
    const home = tmp('home');
    const { ask, answer } = setup(home);
    const bridge = await startBridge({ home });
    const listOf = async () =>
      (await bridge.call<{ questions: Question[] }>('GET', PATH)).body.questions;
    const marks = (body: Record<string, unknown>) =>
      bridge.call<QuestionMarksAnswer>('POST', `${PATH}/marks`, body);
    try {
      ask('q_one');
      const first = ago(60000);
      const second = ago(30000);
      answer('q_one', first);
      answer('q_one', second);
      // the panel drew only the first answer
      let read = await marks({ action: 'read', ids: ['q_one'], seen: { q_one: first } });
      assert.equal(read.body.questions[0].read_at, first);
      assert.equal(read.body.questions[0].unread, true, 'the newer answer is still unread');
      // a mark never moves back
      read = await marks({ action: 'read', ids: ['q_one'], seen: { q_one: ago(120000) } });
      assert.equal(read.body.questions[0].read_at, first);
      read = await marks({ action: 'read', ids: ['q_one'], seen: { q_one: second } });
      assert.equal(read.body.questions[0].unread, false);

      // read_all: only what the panel drew
      ask('q_two');
      ask('q_three');
      answer('q_two', ago(5000));
      answer('q_three', ago(4000));
      const some = await marks({ action: 'read_all', seen: { q_two: ago(5000) } });
      assert.deepEqual(
        some.body.questions.map((question) => question.unread),
        [false, false, true],
        'q_three was not drawn, so it stays unread',
      );
      const rest = await marks({ action: 'read_all' });
      assert.ok(
        rest.body.questions.every((question) => !question.unread),
        'no seen: every unread one',
      );

      // Mark unread is kept in the bridge: looking at it does not read it, a read by hand does
      const held = await marks({ action: 'unread', ids: ['q_one'] });
      assert.equal(held.body.questions[0].unread, true);
      assert.equal(held.body.questions[0].held, true);
      const looked = await marks({
        action: 'read',
        ids: ['q_one'],
        seen: { q_one: second },
        auto: true,
      });
      assert.equal(
        looked.body.questions[0].unread,
        true,
        'an automatic read leaves a held question',
      );
      const byHand = await marks({ action: 'read', ids: ['q_one'], seen: { q_one: second } });
      assert.equal(byHand.body.questions[0].unread, false);
      assert.equal(byHand.body.questions[0].held, false);
      assert.equal((await listOf())[0].held, false);
    } finally {
      await bridge.close();
    }
  });

  test('Undo after a dismissal brings the unread answer back as it was', async () => {
    const home = tmp('home');
    const { ask, answer } = setup(home);
    const bridge = await startBridge({ home });
    try {
      ask('q_one');
      answer('q_one', ago(1000));
      const cleared = await bridge.call<QuestionMarksAnswer>('POST', `${PATH}/marks`, {
        action: 'clear',
      });
      assert.equal(cleared.body.questions[0].unread, false);
      const undone = await bridge.call<QuestionMarksAnswer>('POST', `${PATH}/marks`, {
        action: 'restore',
        ids: cleared.body.cleared,
      });
      assert.equal(undone.body.questions[0].unread, true);
    } finally {
      await bridge.close();
    }
  });
});
