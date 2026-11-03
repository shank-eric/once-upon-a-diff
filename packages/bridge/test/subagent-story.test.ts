import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  tmp,
  githubStory,
  git,
  localRepo,
  runCli,
  startBridge,
  writeJson,
  CLAUDE_DIR,
} from './helpers.ts';
import { Inbox } from '../src/services/inbox/inbox.ts';
import {
  RELAY_STALL_MS,
  STALL_MS,
  markQuestions,
  readHanded,
  statusOf,
  withMarks,
} from '../src/services/inbox/conversation.ts';
import {
  BINDING_FRESH_MS,
  activeBinding,
  forgetSessions,
  sessionLive,
  readBinding,
  relayBinding,
  writeBinding,
} from '../src/services/inbox/binding.ts';
import { relayMessage } from '../src/services/inbox/relay.ts';
import { beat, listeningOf } from '../src/services/listeners/listeners.ts';
import { waitingText } from '@once-upon-a-diff/panel/ask/question-list';
import { askWhoHtml, healthChecks } from '@once-upon-a-diff/panel/status-light';
import type { Health } from '@once-upon-a-diff/panel/status-light';
import type { Pulse, Question } from '@once-upon-a-diff/protocol/types';

const STORY = 'acme-widgets-7';
const OWNER = 'session-owner-1111';
const OTHER = 'session-other-2222';

/** A live Claude Code session in the registry the bridge reads (this test process stands in for it). */
function registerSession(session: string, pid = process.pid, extra: object = {}): void {
  forgetSessions();
  const dir = path.join(CLAUDE_DIR, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, `${pid}.json`), { pid, sessionId: session, status: 'idle', ...extra });
}

/** A home with the story, its first question asked, and the wait's cursors at the top of the inbox. */
function setup(): { home: string; inbox: Inbox; ask: (id: string, extra?: object) => void } {
  const home = tmp('home');
  githubStory(path.join(home, STORY));
  const inbox = new Inbox(home);
  writeFileSync(inbox.file, '');
  inbox.setCursor('story-x', 0);
  inbox.setCursor('repo-acme-widgets', 0);
  return {
    home,
    inbox,
    ask: (id, extra = {}) =>
      inbox.append({
        type: 'question',
        id,
        story: STORY,
        repo: 'acme/widgets',
        step: 2,
        chapter: 'Chapter 2: The cache',
        file: 'src/cache.ts',
        text: `Why ${id}?`,
        ...extra,
      }),
  };
}

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

const waitJson = async (home: string, env: Record<string, string>, ...args: string[]) => {
  const result = await runCli(
    home,
    ['wait', '--type', 'question', '--timeout', '1', '--json', ...args],
    env,
  );
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { id: string; relay?: { agent: string; message: string } | undefined },
    );
};

describe('a story bound to the agent that built it', () => {
  test('a binding is kept per story, and one that cannot be used is ignored', () => {
    const home = tmp('home');
    registerSession(OWNER);
    const now = Date.now();
    assert.equal(readBinding(home, STORY), null);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER, now);
    assert.deepEqual(
      { ...readBinding(home, STORY), at: 'x' },
      { agent: 'ou-fix-cache', session: OWNER, at: 'x' },
    );
    assert.equal(activeBinding(home, STORY, now)?.agent, 'ou-fix-cache');
    assert.equal(
      activeBinding(home, STORY, now + BINDING_FRESH_MS + 1000),
      null,
      'a binding from a day ago is stale: the agent is long gone',
    );
    writeBinding(home, STORY, 'ou-fix-cache', 'session-not-running-3333', now);
    assert.equal(activeBinding(home, STORY, now), null, 'its session has ended');
    writeBinding(home, STORY, 'ou-fix-cache', null, now);
    assert.equal(activeBinding(home, STORY, now), null, 'no session to relay from');
    writeBinding(home, STORY, 'ou-fix-cache', OWNER, now);
    assert.equal(relayBinding(home, STORY, OWNER, now)?.agent, 'ou-fix-cache');
    assert.equal(relayBinding(home, STORY, OTHER, now), null, 'only the owner can message it');
    assert.equal(relayBinding(home, STORY, null, now), null);
    assert.throws(() => writeBinding(home, STORY, 'bad name; rm -rf', OWNER), /agent's name/);
    assert.throws(() => writeBinding(home, '../up', 'ou-x', OWNER), /story id/);
  });

  test('bind, and --agent on publish and local, write the binding; --clear removes it', async () => {
    const home = tmp('home');
    githubStory(path.join(home, STORY));
    registerSession(OWNER);
    const env = { CLAUDE_CODE_SESSION_ID: OWNER };
    const bound = await runCli(home, ['bind', '--story', STORY, '--agent', 'ou-fix-cache'], env);
    assert.equal(bound.code, 0);
    assert.deepEqual(
      [readBinding(home, STORY)?.agent, readBinding(home, STORY)?.session],
      ['ou-fix-cache', OWNER],
    );
    assert.match(
      (await runCli(home, ['bind', '--story', STORY], env)).stdout,
      /ou-fix-cache.*in use/,
    );
    assert.equal((await runCli(home, ['bind', '--story', STORY, '--agent', 'a b'], env)).code, 1);
    assert.equal((await runCli(home, ['bind', '--story', 'nope-1', '--agent', 'x'], env)).code, 1);
    assert.match(
      (await runCli(home, ['bind', '--story', STORY, '--clear'], env)).stdout,
      /unbound/,
    );
    assert.equal(readBinding(home, STORY), null);

    // publish --agent binds as the story is published
    const folder = path.join(tmp('once'), 'acme-widgets-8');
    githubStory(folder);
    writeJson(path.join(folder, 'pr.json'), {
      url: 'https://github.com/acme/widgets/pull/8',
      number: 8,
      title: 'Another',
    });
    assert.equal((await runCli(home, ['publish', '--dir', folder, '--agent', 'a b'], env)).code, 1);
    const published = await runCli(
      home,
      ['publish', '--dir', folder, '--agent', 'ou-fix-cache'],
      env,
    );
    assert.equal(published.code, 0, published.stderr);
    assert.match(published.stderr, /its questions go to ou-fix-cache/);
    assert.equal(readBinding(home, 'acme-widgets-8')?.session, OWNER);

    // told again without --agent, the story is no longer the agent's, and with another agent it is theirs
    const again = await runCli(home, ['publish', '--dir', folder], env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stderr, /no longer bound to ou-fix-cache/);
    assert.equal(readBinding(home, 'acme-widgets-8'), null);
    await runCli(home, ['publish', '--dir', folder, '--agent', 'ou-fix-cache'], env);
    await runCli(home, ['publish', '--dir', folder, '--agent', 'ou-second'], env);
    assert.equal(readBinding(home, 'acme-widgets-8')?.agent, 'ou-second');
  });

  test('local --agent binds the local story, and a session that is not running is warned about', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    git(repo, 'switch', '-q', 'feature');
    registerSession(OWNER);
    const args = [
      'local',
      '--repo',
      repo,
      '--base',
      base,
      '--head',
      'feature',
      '--id',
      'sub-local',
      '--no-open',
      '--no-serve',
    ];
    const made = await runCli(home, [...args, '--agent', 'ou-fix-cache'], {
      CLAUDE_CODE_SESSION_ID: OWNER,
    });
    assert.equal(made.code, 0, made.stderr);
    assert.match(made.stderr, /its questions go to ou-fix-cache/);
    assert.deepEqual(
      [readBinding(home, 'sub-local')?.agent, readBinding(home, 'sub-local')?.session],
      ['ou-fix-cache', OWNER],
    );
    assert.equal((await runCli(home, [...args, '--agent', 'a b'])).code, 1);
    const ended = await runCli(home, [...args, '--agent', 'ou-fix-cache'], {
      CLAUDE_CODE_SESSION_ID: 'session-not-running-3333',
    });
    assert.match(ended.stderr, /isn't in Claude Code's session registry as running/);
    const none = await runCli(home, ['bind', '--story', 'sub-local', '--agent', 'ou-fix-cache'], {
      CLAUDE_CODE_SESSION_ID: '',
    });
    assert.match(none.stderr, /no CLAUDE_CODE_SESSION_ID/);
    const rebuilt = await runCli(home, args, { CLAUDE_CODE_SESSION_ID: OWNER });
    assert.match(rebuilt.stderr, /no longer bound to ou-fix-cache/);
    assert.equal(readBinding(home, 'sub-local'), null);
  });

  test('a story wait in the owner session hands the question over as a message for the agent', async () => {
    const { home, ask } = setup();
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    ask('q_one');
    const [handed] = await waitJson(
      home,
      { CLAUDE_CODE_SESSION_ID: OWNER },
      '--story',
      STORY,
      '--consumer',
      'story-x',
    );
    assert.equal(handed.id, 'q_one');
    assert.equal(handed.relay?.agent, 'ou-fix-cache');
    const message = handed.relay!.message;
    assert.match(message, /Question q_one \(Chapter 2: The cache, src\/cache.ts\)/);
    assert.match(message, /Why q_one\?/);
    assert.match(message, /asking --question q_one --consumer ou-fix-cache/);
    assert.match(message, /answer --question q_one --consumer ou-fix-cache/);
    assert.deepEqual(readHanded(home).q_one.consumer, 'ou-fix-cache', 'the agent has it');
    assert.equal(readHanded(home).q_one.via, 'story-x', 'through the relay');

    // the agent answers, and the panel credits it
    const answered = await runCli(home, [
      'answer',
      '--question',
      'q_one',
      '--text',
      'Because of the cache.',
    ]);
    assert.equal(answered.code, 0);
    const list = withMarks(home, STORY, new Inbox(home).questions(STORY));
    assert.equal(list[0].answers[0].by, 'ou-fix-cache');
    assert.equal(list[0].handed_to, 'ou-fix-cache');
  });

  test('the readable text names the agent, the message and the way out', async () => {
    const { home, ask } = setup();
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    ask('q_one');
    const result = await runCli(
      home,
      ['wait', '--story', STORY, '--consumer', 'story-x', '--type', 'question', '--timeout', '1'],
      { CLAUDE_CODE_SESSION_ID: OWNER },
    );
    assert.match(result.stdout, /SendMessage to "ou-fix-cache"/);
    assert.match(result.stdout, /Don't answer it yourself/);
    assert.match(result.stdout, /answer --question q_one --consumer story-x/);
    assert.doesNotMatch(result.stdout, /Answer with: once-upon answer/);
  });

  test("a repo wait in the owner session relays too, and a wait elsewhere doesn't", async () => {
    const { home, ask } = setup();
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    ask('q_one');
    // another session's repo wait answers it as it would any question
    const elsewhere = await waitJson(
      home,
      { CLAUDE_CODE_SESSION_ID: OTHER },
      '--repo',
      'acme/widgets',
    );
    assert.deepEqual(
      elsewhere.map((entry) => [entry.id, entry.relay]),
      [['q_one', undefined]],
      'a session that cannot reach the agent keeps the question',
    );
    assert.equal(readHanded(home).q_one.consumer, 'repo-acme-widgets');

    ask('q_two');
    const ownRepoWait = await waitJson(
      home,
      { CLAUDE_CODE_SESSION_ID: OWNER },
      '--repo',
      'acme/widgets',
    );
    assert.equal(ownRepoWait[0].relay?.agent, 'ou-fix-cache');

    ask('q_three');
    const noRelay = await waitJson(
      home,
      { CLAUDE_CODE_SESSION_ID: OWNER },
      '--repo',
      'acme/widgets',
      '--no-relay',
    );
    assert.deepEqual(
      noRelay.map((entry) => [entry.id, entry.relay]),
      [['q_three', undefined]],
      '--no-relay answers it here',
    );
  });

  test('a stale binding, or one whose session ended, never swallows a question', async () => {
    const { home, ask } = setup();
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-gone', OWNER, Date.now() - BINDING_FRESH_MS - 60000);
    ask('q_old');
    let heard = await waitJson(
      home,
      { CLAUDE_CODE_SESSION_ID: OWNER },
      '--story',
      STORY,
      '--consumer',
      'story-x',
    );
    assert.deepEqual(
      heard.map((entry) => [entry.id, entry.relay]),
      [['q_old', undefined]],
    );

    writeBinding(home, STORY, 'ou-gone', 'session-not-running-3333');
    ask('q_ended');
    heard = await waitJson(
      home,
      { CLAUDE_CODE_SESSION_ID: 'session-not-running-3333' },
      '--story',
      STORY,
      '--consumer',
      'story-x',
    );
    assert.deepEqual(
      heard.map((entry) => [entry.id, entry.relay]),
      [['q_ended', undefined]],
    );

    // with no relay live (its last beat is old), the repo's listener takes it as for any story
    writeFileSync(
      path.join(home, 'listeners', 'story-x.json'),
      JSON.stringify({
        consumer: 'story-x',
        pid: process.pid,
        state: 'waiting',
        at: new Date(Date.now() - 60000).toISOString(),
        story: STORY,
      }),
    );
    ask('q_repo');
    heard = await waitJson(home, {}, '--repo', 'acme/widgets');
    assert.deepEqual(
      heard.map((entry) => entry.id),
      ['q_repo'],
    );
  });

  test("a live wait in the owner session is named as the relay, whatever it covers, and the panel's pulse says so", async () => {
    const home = tmp('home');
    githubStory(path.join(home, STORY));
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    const bridge = await startBridge({ home });
    const pulse = async () => (await bridge.call<Pulse>('GET', `/api/stories/${STORY}/pulse`)).body;
    const answering = () => listeningOf(home, { repo: 'acme/widgets', story: STORY }).answering;
    try {
      assert.equal((await pulse()).agent, 'ou-fix-cache', 'built by an agent, nobody relaying yet');
      assert.equal((await pulse()).answering, null);
      beat(home, 'story-x', 'waiting', { story: STORY, session: OWNER });
      assert.equal((await pulse()).answering, 'story-x>ou-fix-cache');
      assert.deepEqual(answering(), { consumer: 'story-x', scope: 'story', agent: 'ou-fix-cache' });
      // a repo wait in the owner session relays too
      beat(home, 'story-x', 'waiting', { story: 'another-story-1', session: OWNER });
      beat(home, 'repo-acme', 'waiting', { repo: 'acme/widgets', session: OWNER });
      assert.deepEqual(answering(), {
        consumer: 'repo-acme',
        scope: 'repo',
        agent: 'ou-fix-cache',
      });
      assert.equal((await pulse()).answering, 'repo-acme>ou-fix-cache');
      // --no-relay, or a wait in another session, answers it itself
      beat(home, 'repo-acme', 'waiting', { repo: 'acme/widgets', session: OWNER, norelay: true });
      assert.equal(answering()?.agent, undefined);
      beat(home, 'repo-acme', 'waiting', { repo: 'acme/widgets', session: OTHER });
      assert.equal(answering()?.agent, undefined);
      // a story listener in another session keeps the story's questions, so nothing is relayed
      beat(home, 'repo-acme', 'waiting', { repo: 'acme/widgets', session: OWNER });
      beat(home, 'story-y', 'waiting', { story: STORY, session: OTHER });
      assert.deepEqual(answering(), { consumer: 'story-y', scope: 'story' });
      writeBinding(home, STORY, 'ou-fix-cache', OWNER, Date.now() - BINDING_FRESH_MS - 60000);
      assert.equal(listeningOf(home, { story: STORY }).agent, null, 'a stale binding is not shown');
    } finally {
      await bridge.close();
    }
  });

  test('a wait records its session in its beat, and --no-relay', async () => {
    const { home } = setup();
    registerSession(OWNER);
    await waitJson(home, { CLAUDE_CODE_SESSION_ID: OWNER }, '--repo', 'acme/widgets', '--no-relay');
    const saved = JSON.parse(
      readFileSync(path.join(home, 'listeners', 'repo-acme-widgets.json'), 'utf8'),
    );
    assert.equal(saved.session, OWNER);
    assert.equal(saved.norelay, true);
  });

  test('a story wait and a repo wait in one session: the story wait relays and the repo wait leaves it', async () => {
    const { home, ask } = setup();
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    const env = { CLAUDE_CODE_SESSION_ID: OWNER };
    ask('q_one');
    // the story wait is live (its beat is fresh), so the repo wait leaves the story's question to it
    beat(home, 'story-x', 'waiting', { story: STORY, session: OWNER });
    assert.deepEqual(await waitJson(home, env, '--repo', 'acme/widgets'), []);
    const [relayed] = await waitJson(home, env, '--story', STORY, '--consumer', 'story-x');
    assert.equal(relayed.id, 'q_one');
    assert.equal(relayed.relay?.agent, 'ou-fix-cache');
    // a question is relayed once: the wait started again hears nothing of it, and neither does the repo's wait
    assert.deepEqual(await waitJson(home, env, '--story', STORY, '--consumer', 'story-x'), []);
    goStale(home, 'story-x', { story: STORY, session: OWNER });
    assert.deepEqual(await waitJson(home, env, '--repo', 'acme/widgets'), []);
    assert.equal(readHanded(home).q_one.via, 'story-x');
  });

  test('a relayed question waits for the agent to speak, and only then counts as worked on', () => {
    const now = Date.now();
    const ago = (msAgo: number) => new Date(now - msAgo).toISOString();
    const handed = { consumer: 'ou-fix-cache', at: ago(6 * 60_000), via: 'story-x' };
    // printed by the relay six minutes ago: pending, not stalled
    const waiting = statusOf(handed, undefined, false, now);
    assert.deepEqual(
      [waiting.state, waiting.via, waiting.by],
      ['relaying', 'story-x', 'ou-fix-cache'],
    );
    assert.equal(
      statusOf({ ...handed, at: ago(STALL_MS + 1) }, undefined, false, now).state,
      'relaying',
    );
    assert.equal(
      statusOf({ ...handed, at: ago(RELAY_STALL_MS + 1) }, undefined, false, now).state,
      'stalled',
      'the relay never got it to the agent',
    );
    // the agent's first note makes it work, and then the usual window applies
    const noted = { note: 'reading cache.ts', at: ago(1000), by: 'ou-fix-cache' };
    assert.equal(statusOf(handed, noted, false, now).state, 'working');
    assert.equal(
      statusOf(handed, { ...noted, at: ago(STALL_MS + 1) }, false, now).state,
      'stalled',
    );
    // an ordinary handover is unchanged: the usual window, no relay state
    assert.equal(
      statusOf({ consumer: 'repo-x', at: ago(1000) }, undefined, false, now).state,
      'working',
    );
    assert.equal(
      statusOf({ consumer: 'repo-x', at: handed.at }, undefined, false, now).state,
      'stalled',
    );
  });

  test('re-asking: a relayed question answered or dismissed meanwhile is not answered a second time', async () => {
    const { home, ask } = setup();
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    const env = { CLAUDE_CODE_SESSION_ID: OWNER };
    ask('q_one');
    ask('q_two');
    await waitJson(home, env, '--story', STORY, '--consumer', 'story-x');
    const asking = (id: string) =>
      runCli(home, ['asking', '--question', id, '--consumer', 'ou-fix-cache', '--note', 'x']);
    const answer = (id: string, consumer = 'ou-fix-cache') =>
      runCli(home, ['answer', '--question', id, '--consumer', consumer, '--text', 'Because.']);
    assert.match((await asking('q_one')).stdout, /q_one: x/);
    // the reviewer dismisses q_two, then the relay's message reaches the agent
    markQuestions(home, STORY, 'dismiss', ['q_two']);
    assert.match((await asking('q_two')).stdout, /was dismissed: stop/);
    assert.equal((await answer('q_two')).code, 1);
    // q_one is answered once (by the relay itself, say), and the agent's late answer is refused
    assert.equal((await answer('q_one', 'story-x')).code, 0);
    assert.match((await asking('q_one')).stdout, /already answered: stop/);
    const late = await answer('q_one');
    assert.equal(late.code, 1);
    assert.match(late.stderr, /already answered/);
    assert.equal(new Inbox(home).questions(STORY)[0].answers.length, 1);
  });

  test('a relay keeps the binding fresh, so a long session does not lose it', async () => {
    const { home, ask } = setup();
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER, Date.now() - BINDING_FRESH_MS + 60 * 60_000);
    ask('q_one');
    await waitJson(
      home,
      { CLAUDE_CODE_SESSION_ID: OWNER },
      '--story',
      STORY,
      '--consumer',
      'story-x',
    );
    assert.ok(Date.parse(readBinding(home, STORY)!.at) > Date.now() - 60_000);
  });

  test('a session found by its registry file must still be the process that wrote it', () => {
    const home = tmp('home');
    const start = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    }).trim();
    registerSession('session-real-4444', process.pid, { procStart: start });
    assert.equal(sessionLive(home, 'session-real-4444'), true);
    registerSession('session-reused-5555', process.pid, { procStart: 'Mon Jan  1 00:00:00 2001' });
    assert.equal(sessionLive(home, 'session-reused-5555'), false, 'its pid was reused later');
    registerSession('session-dead-6666', 2 ** 22 + 1);
    assert.equal(sessionLive(home, 'session-dead-6666'), false);
    // a result is kept for a moment, so a panel's pulses don't each read the registry
    registerSession('session-late-7777');
    assert.equal(sessionLive(home, 'session-late-7777'), true);
    writeJson(path.join(CLAUDE_DIR, 'sessions', `${process.pid}.json`), {
      pid: process.pid,
      sessionId: 'x',
    });
    assert.equal(sessionLive(home, 'session-late-7777'), true, 'kept for 2 seconds');
    assert.equal(sessionLive(home, 'session-late-7777', Date.now() + 3000), false);
    registerSession(OWNER); // the other tests' session
  });
});

describe('questions by voice', () => {
  test('ask files a question the panel lists, marked by voice, and relays like a typed one', async () => {
    const { home } = setup();
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    const asked = await runCli(home, [
      'ask',
      '--story',
      STORY,
      '--text',
      'Why does it cache the whole list?',
      '--voice',
    ]);
    assert.equal(asked.code, 0, asked.stderr);
    const id = asked.stdout.trim();
    assert.match(id, /^q_/);
    const [question] = new Inbox(home).questions(STORY);
    assert.equal(question.id, id);
    assert.equal(question.channel, 'voice');
    assert.equal((await runCli(home, ['ask', '--story', STORY, '--text', ' '])).code, 1);
    assert.equal((await runCli(home, ['ask', '--story', 'nope-1', '--text', 'x'])).code, 1);

    const [handed] = await waitJson(
      home,
      { CLAUDE_CODE_SESSION_ID: OWNER },
      '--story',
      STORY,
      '--consumer',
      'story-x',
    );
    assert.equal(handed.id, id);
    assert.match(handed.relay!.message, /asked by voice/);
    assert.match(
      handed.relay!.message,
      /SendMessage the main session the answer in two short spoken sentences/,
    );

    const bridge = await startBridge({ home });
    try {
      const listed = await bridge.call<{ questions: Question[] }>(
        'GET',
        `/api/stories/${STORY}/questions`,
      );
      assert.equal(listed.body.questions[0].channel, 'voice');
      assert.equal(listed.body.questions[0].status?.via, 'story-x');
      assert.equal(listed.body.questions[0].status?.by, 'ou-fix-cache');
    } finally {
      await bridge.close();
    }
  });

  test('a typed question gets no voice mark, and the message for it asks for one chat line', () => {
    const message = relayMessage(
      {
        id: 'q_a',
        story: STORY,
        step: 1,
        chapter: null,
        file: null,
        text: 'Hm?',
        channel: undefined,
      },
      'ou-fix-cache',
      'once-upon',
    );
    assert.match(message, /\(step 1\)/);
    assert.doesNotMatch(message, /voice/);
    assert.match(message, /Reply in chat with one line only/);
  });
});

describe('what the panel says', () => {
  const status = {
    state: 'working' as const,
    by: 'ou-fix-cache',
    since: null,
    note: null,
    note_at: null,
  };

  test('a relayed question reads as sent to the agent only once the agent has spoken', () => {
    assert.deepEqual(
      waitingText({
        handed_to: 'ou-fix-cache',
        status: { ...status, state: 'relaying', via: 'story-x' },
      }),
      {
        state: 'queued',
        text: 'Waiting for story-x to pass it to ou-fix-cache, which built this story',
        note: null,
      },
    );
    const stalled = waitingText(
      { handed_to: 'ou-fix-cache', status: { ...status, state: 'stalled', via: 'story-x' } },
      { quietAt: '4:32 PM' },
    );
    assert.match(
      stalled.text,
      /Nothing from ou-fix-cache since 4:32 PM, and story-x may not have passed it on/,
    );
    assert.equal(
      waitingText({ handed_to: 'ou-fix-cache', status: { ...status, via: 'story-x' } }).text,
      'Sent to ou-fix-cache, which built this story, through story-x',
    );
    assert.equal(
      waitingText({ handed_to: 'ou-fix-cache', status }).text,
      'ou-fix-cache is working on it',
    );
  });

  test('the line under the Ask box names the agent, with or without a relay', () => {
    const health = (extra: Partial<Health>): Health => ({
      level: 'ok',
      checks: [],
      listening: true,
      ...extra,
    });
    const relayed = String(
      askWhoHtml(
        health({
          answering: { consumer: 'story-x', scope: 'story', agent: 'ou-fix-cache' },
          agent: 'ou-fix-cache',
        }),
      ),
    );
    assert.match(
      relayed,
      /Questions go to <b>ou-fix-cache<\/b>, the agent that built this story, through <b>story-x<\/b>/,
    );
    // a repo wait in the owner session relays: the panel names the agent, not the repo listener, as who answers
    const repoRelay = String(
      askWhoHtml(
        health({
          answering: { consumer: 'repo-acme', scope: 'repo', agent: 'ou-fix-cache' },
          agent: 'ou-fix-cache',
        }),
      ),
    );
    assert.match(repoRelay, /Questions go to <b>ou-fix-cache<\/b>.*through <b>repo-acme<\/b>/);
    // not relayed yet: only the session that launched the agent can reach it, so no Start button and no copy button, only the line to run by hand as plain text
    const waiting = String(
      askWhoHtml(
        health({
          answering: { consumer: 'repo-acme', scope: 'repo' },
          agent: 'ou-fix-cache',
          prompt: '/once-upon-listen acme/widgets',
          storyPrompt: { prompt: `/once-upon-listen --story ${STORY}` },
        }),
        true,
      ),
    );
    assert.match(waiting, /ou-fix-cache<\/b> built this story/);
    assert.match(waiting, /Only the Claude session that launched it can pass/);
    assert.match(waiting, /Until it does, <b>repo-acme<\/b> answers/);
    assert.doesNotMatch(waiting, /ou-startstory/);
    assert.doesNotMatch(waiting, /Copy prompt|ou-copystory|<button/);
    assert.match(
      waiting,
      new RegExp(
        `To start that, run <code>/once-upon-listen --story ${STORY}</code> in the session that launched ou-fix-cache`,
      ),
    );
    const plain = String(
      askWhoHtml(health({ answering: { consumer: 'story-x', scope: 'story' } })),
    );
    assert.match(plain, /Answered by <b>story-x<\/b>, the session listening for this story/);
    // the status light's own answer carries the agent through
    assert.equal(
      healthChecks({
        bridge: { version: '1' },
        story: { ok: true, id: STORY },
        listening: { ok: true, agent: 'ou-fix-cache' },
      }).agent,
      'ou-fix-cache',
    );
  });
});
