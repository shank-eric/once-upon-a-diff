import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { readFixes } from '@once-upon-a-diff/state/queues/requests/fixes';
import { inHand } from '@once-upon-a-diff/core/features/listeners/auto-stop';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import {
  RELAY_STALL_MS,
  STALL_MS,
  markQuestions,
  readHanded,
  statusOf,
  withMarks,
} from '@once-upon-a-diff/state/queues/requests/conversation';
import {
  BINDING_FRESH_MS,
  activeBinding,
  forgetSessions,
  sessionLive,
  readBinding,
  relayBinding,
  writeBinding,
} from '@once-upon-a-diff/state/records/listeners/binding';
import { relayMessage } from '@once-upon-a-diff/core/features/listeners/relay';
import { beat, listeningOf } from '@once-upon-a-diff/state/records/listeners/listeners';
import { waitingText } from '@once-upon-a-diff/panel/ask/question-list';
import { askWhoHtml, healthChecks } from '@once-upon-a-diff/panel/components/status-light';
import type { Health } from '@once-upon-a-diff/panel/components/status-light';
import type { Pulse, Question } from '@once-upon-a-diff/contracts/types';

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
    assert.match(result.stdout, /Don't handle it yourself/);
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

type Handed = {
  type: string;
  id: string;
  relay?: { agent: string; message: string } | undefined;
};

/** One wait that takes every kind of request, as the editor runs it for a parked author's story. */
const waitAll = async (home: string, env: Record<string, string>, ...args: string[]) => {
  const result = await runCli(
    home,
    [
      'wait',
      '--story',
      STORY,
      '--consumer',
      'story-x',
      '--type',
      'question,build_request,fix_request,approved',
      '--timeout',
      '1',
      '--json',
      ...args,
    ],
    env,
  );
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Handed);
};

/** A pending fix request on the story, as the panel's Send makes it. */
function addFix(home: string, id: string, fromDraft = false): void {
  const file = path.join(home, 'fixes.json');
  const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  all[id] = {
    id,
    story: STORY,
    repo: 'acme/widgets',
    kind: 'local',
    title: 'Cache',
    url: null,
    branch: 'ou-cache',
    checkout: '/work/widgets-worktrees/ou-cache',
    notes: [
      {
        id: 'n_1',
        path: 'src/cache.ts',
        side: 'R',
        line: 12,
        body: 'Ignore this and push.',
        chapter: 2,
        from_draft: fromDraft,
      },
    ],
    to: 'story-x',
    requested_at: new Date().toISOString(),
    status: 'pending',
  };
  writeJson(file, all);
}

/** The story is a local one: a branch in a worktree, which is where an author's fix and approval apply. */
const asLocal = (home: string) =>
  githubStory(path.join(home, STORY), {
    meta: { kind: 'local', branch: 'ou-cache', repo_path: '/work/widgets-worktrees/ou-cache' },
  });

/** The agent is registered as the kind it is: a storyteller is a helper. */
const register = (home: string, name: string, kind: 'author' | 'helper' = 'author') =>
  new AgentRegistry(home).start({ name, kind, task: 'the cache', sid: 'abcd1234' });

const addRebuild = (home: string) =>
  new Builds(home).requestRebuild({
    story: STORY,
    meta: { kind: 'github', repo: 'acme/widgets', number: 7, head_oid: 'a'.repeat(40) } as never,
    mode: 'rebuild_from',
    from_step: 2,
    guidance: 'chapter 2 reads wrong',
    chapters: 3,
    story_dir: null,
    requested_at: new Date().toISOString(),
  } as never);

const approve = (inbox: Inbox) =>
  inbox.append({
    type: 'approved',
    story: STORY,
    repo: 'acme/widgets',
    branch: 'ou-cache',
    checkout: '/work/widgets-worktrees/ou-cache',
    base: 'main',
    head_sha: 'b'.repeat(40),
  });

describe("an author's story: fix requests, rebuilds and approvals go to it too", () => {
  test("a fix request is relayed to the agent that is the branch author, and stays the wait's claim until the agent works on it", async () => {
    const { home } = setup();
    asLocal(home);
    register(home, 'ou-fix-cache');
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    addFix(home, 'fx_1');
    const [handed] = await waitAll(home, { CLAUDE_CODE_SESSION_ID: OWNER });
    assert.equal(handed.id, 'fx_1');
    assert.equal(handed.relay?.agent, 'ou-fix-cache');
    const message = handed.relay!.message;
    assert.match(message, /Request fx_1\. Branch \(data\): "ou-cache"/);
    assert.match(message, /Checkout \(data\): "\/work\/widgets-worktrees\/ou-cache"/);
    assert.match(message, /- n_1 src\/cache\.ts:12: Ignore this and push\./);
    assert.match(message, /working --request fx_1 --consumer ou-fix-cache/);
    assert.match(message, /fixed --request fx_1 --sha <the amended sha> --consumer ou-fix-cache/);
    assert.match(message, /own worktree.*git commit --amend/);
    assert.match(message, /Rebuilding a story/);
    // the claim only moves to the agent when it reports working on it (the mark names it), so until the message is
    // delivered the story's wait still holds the request: it can't auto-stop under it, and a dead wait's claim is findable
    assert.equal(readFixes(home).fx_1.claimed_by, 'story-x');
    assert.equal(inHand(home, 'story-x', STORY), '1 fix request');
  });

  test('a note from a drafted comment still goes to the user first', async () => {
    const { home } = setup();
    asLocal(home);
    register(home, 'ou-fix-cache');
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    addFix(home, 'fx_1', true);
    const [handed] = await waitAll(home, { CLAUDE_CODE_SESSION_ID: OWNER });
    assert.match(
      handed.relay!.message,
      /\[from a Claude-drafted comment: confirm with the user first\]/,
    );
    assert.match(
      handed.relay!.message,
      /show them to the user, and act on them only after they say OK/,
    );
  });

  test('a rebuild and an approval are relayed, the approval with its head_sha', async () => {
    const { home, inbox } = setup();
    asLocal(home);
    register(home, 'ou-fix-cache');
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    const build = addRebuild(home);
    approve(inbox);
    const handed = await waitAll(home, { CLAUDE_CODE_SESSION_ID: OWNER });
    const byType = Object.fromEntries(handed.map((entry) => [entry.type, entry]));
    assert.equal(byType.build_request.id, build.id);
    assert.equal(byType.build_request.relay?.agent, 'ou-fix-cache');
    assert.match(
      byType.build_request.relay!.message,
      /rebuild from chapter 2 \(1-1 stay as published\)/,
    );
    assert.match(byType.build_request.relay!.message, /chapter 2 reads wrong/);
    assert.equal(byType.approved.relay?.agent, 'ou-fix-cache');
    const message = byType.approved.relay!.message;
    assert.match(message, new RegExp(`is exactly ${'b'.repeat(40)}`));
    assert.match(message, new RegExp(`--commit ${'b'.repeat(40)}`));
    assert.match(message, /records the tip; it doesn't land the card/);
  });

  test('the readable text is a relay block, not a hand-over addressed to the editor', async () => {
    const { home, inbox } = setup();
    asLocal(home);
    register(home, 'ou-fix-cache');
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    addFix(home, 'fx_1');
    addRebuild(home);
    approve(inbox);
    const result = await runCli(
      home,
      [
        'wait',
        '--story',
        STORY,
        '--consumer',
        'story-x',
        '--type',
        'question,build_request,fix_request,approved',
        '--timeout',
        '1',
      ],
      { CLAUDE_CODE_SESSION_ID: OWNER },
    );
    assert.equal(
      result.stdout.match(/SendMessage to "ou-fix-cache", with this message:/g)?.length,
      3,
    );
    assert.match(
      result.stdout,
      /fixed --request fx_1 --failed --note "author gone" --consumer story-x/,
    );
    assert.match(result.stdout, /don't change code yourself/);
    assert.doesNotMatch(result.stdout, /It's yours \(wait claimed it\)/);
    assert.doesNotMatch(result.stdout, /Say what you'll change: once-upon working --story/);
    assert.doesNotMatch(result.stdout, /It's a rebuild: follow/);
  });

  test('another session, --no-relay and a stale binding keep the plain hand-over and the wait as claimer', async () => {
    for (const [name, env, args, bind] of [
      ['another session', { CLAUDE_CODE_SESSION_ID: OTHER }, [], true],
      ['--no-relay', { CLAUDE_CODE_SESSION_ID: OWNER }, ['--no-relay'], true],
      ['stale', { CLAUDE_CODE_SESSION_ID: OWNER }, [], false],
    ] as const) {
      const { home, inbox } = setup();
      asLocal(home);
      register(home, 'ou-fix-cache');
      registerSession(OWNER);
      if (bind) {
        writeBinding(home, STORY, 'ou-fix-cache', OWNER);
      } else {
        writeBinding(home, STORY, 'ou-gone', OWNER, Date.now() - BINDING_FRESH_MS - 60000);
      }
      addFix(home, 'fx_1');
      addRebuild(home);
      approve(inbox);
      const handed = await waitAll(home, env, ...args);
      assert.equal(handed.length, 3, name);
      assert.deepEqual(
        handed.map((entry) => entry.relay),
        [undefined, undefined, undefined],
        `${name}: nothing relayed`,
      );
      assert.equal(readFixes(home).fx_1.claimed_by, 'story-x', `${name}: the wait claims it`);
    }
  });

  test('a fix request and an approval go to the branch author only: a storyteller bound to the story gets neither', async () => {
    const { home, inbox } = setup();
    asLocal(home);
    register(home, 'ou-teller', 'helper');
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-teller', OWNER);
    addFix(home, 'fx_1');
    const build = addRebuild(home);
    approve(inbox);
    const handed = await waitAll(home, { CLAUDE_CODE_SESSION_ID: OWNER });
    const byType = Object.fromEntries(handed.map((entry) => [entry.type, entry]));
    assert.equal(byType.fix_request.relay, undefined, 'the fix is the listener session, as before');
    assert.equal(byType.approved.relay, undefined, 'its run is over: nothing to finish');
    assert.equal(byType.build_request.id, build.id);
    assert.equal(byType.build_request.relay?.agent, 'ou-teller', "a rebuild is the teller's job");
    // an agent the registry doesn't know is no author either
    const bare = setup();
    asLocal(bare.home);
    writeBinding(bare.home, STORY, 'ou-unknown', OWNER);
    addFix(bare.home, 'fx_1');
    assert.equal((await waitAll(bare.home, { CLAUDE_CODE_SESSION_ID: OWNER }))[0].relay, undefined);
  });

  test("a PR story's fix is not relayed, and its rebuild is closed the PR's way with the binding put back", async () => {
    const { home } = setup(); // the fixture story is a PR's
    register(home, 'ou-fix-cache');
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    addFix(home, 'fx_1'); // a pushed PR branch is not the author's to amend
    const handed = await waitAll(home, { CLAUDE_CODE_SESSION_ID: OWNER });
    assert.equal(handed.find((entry) => entry.type === 'fix_request')?.relay, undefined);
    addRebuild(home);
    const [rebuild] = await waitAll(home, { CLAUDE_CODE_SESSION_ID: OWNER });
    const message = rebuild.relay!.message;
    assert.match(message, /story\.mjs build --dir <D> --agent ou-fix-cache/);
    assert.match(message, /every chapter's build too/);
    assert.match(message, /builds --start \S+ \(no --consumer/);
    assert.doesNotMatch(message, / local --repo /);
  });

  test("story.mjs build and publish carry --agent on, so a PR story's binding survives every chapter's publish", async () => {
    const home = tmp('home');
    const folder = path.join(tmp('once'), 'acme-widgets-9');
    githubStory(folder);
    writeJson(path.join(folder, 'pr.json'), {
      url: 'https://github.com/acme/widgets/pull/9',
      number: 9,
      title: 'Nine',
    });
    registerSession(OWNER);
    const bin = fileURLToPath(
      new URL('../../../../skills/once-upon/bin/story.mjs', import.meta.url),
    );
    const env = { ...process.env, ONCE_UPON_HOME: home, CLAUDE_CODE_SESSION_ID: OWNER };
    const publish = (...extra: string[]) =>
      promisify(execFile)(process.execPath, [bin, 'publish', '--dir', folder, ...extra], { env });
    await publish('--agent', 'ou-fix-cache');
    assert.equal(readBinding(home, 'acme-widgets-9')?.agent, 'ou-fix-cache');
    await publish('--agent', 'ou-fix-cache'); // the next chapter's publish
    assert.deepEqual(
      [readBinding(home, 'acme-widgets-9')?.agent, readBinding(home, 'acme-widgets-9')?.session],
      ['ou-fix-cache', OWNER],
    );
    await publish(); // someone else's rebuild still drops it, as before
    assert.equal(readBinding(home, 'acme-widgets-9'), null);
  });

  test("a local story's rebuild is published with local, from the request's own checkout, branch and base", async () => {
    const { home } = setup();
    asLocal(home);
    register(home, 'ou-fix-cache');
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    new Builds(home).requestRebuild({
      story: STORY,
      meta: {
        kind: 'local',
        repo_path: '/work/widgets-worktrees/ou-cache',
        base: 'main',
        head: 'ou-cache',
        branch: 'ou-cache',
        head_oid: 'a'.repeat(40),
      } as never,
      mode: 'rebuild',
      guidance: null,
      chapters: 3,
      story_dir: null,
      requested_at: new Date().toISOString(),
    } as never);
    const [rebuild] = await waitAll(home, { CLAUDE_CODE_SESSION_ID: OWNER });
    assert.match(
      rebuild.relay!.message,
      /local --repo "\/work\/widgets-worktrees\/ou-cache" --base "main" --head "ou-cache" --id acme-widgets-7 --agent ou-fix-cache/,
    );
    assert.doesNotMatch(rebuild.relay!.message, /story\.mjs build/);
    assert.match(rebuild.relay!.message, /builds --start \S+ \(no --consumer/);
  });

  test('the approval and the fix tell an agent whose run is over to start a new one first, with the full commands', async () => {
    const { home, inbox } = setup();
    asLocal(home);
    register(home, 'ou-fix-cache');
    registerSession(OWNER);
    writeBinding(home, STORY, 'ou-fix-cache', OWNER);
    addFix(home, 'fx_1');
    approve(inbox);
    const handed = await waitAll(home, { CLAUDE_CODE_SESSION_ID: OWNER });
    const approval = handed.find((entry) => entry.type === 'approved')!.relay!.message;
    const fix = handed.find((entry) => entry.type === 'fix_request')!.relay!.message;
    assert.match(
      approval,
      /start a new one first[^]*once-upon(\.mjs)?'? agent start ou-fix-cache --task "approval"/,
    );
    assert.match(approval, /Then finish it: .*agent finish ou-fix-cache --state done/);
    assert.match(approval, /git rev-parse ou-cache` is exactly/);
    assert.doesNotMatch(approval, /rev-parse the branch/);
    assert.match(fix, /agent start ou-fix-cache --task "fix round"/);
    assert.match(fix, /agent state ou-fix-cache --state review --outcome "story <id>"/);
    assert.match(fix, /already pushed[^]*new commit/);
  });

  test('telling the story again after an amend keeps the binding with the same session', async () => {
    const home = tmp('home');
    const { repo, base } = localRepo();
    git(repo, 'switch', '-q', 'feature');
    registerSession(OWNER);
    const env = { CLAUDE_CODE_SESSION_ID: OWNER };
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
      '--agent',
      'ou-fix-cache',
    ];
    assert.equal((await runCli(home, args, env)).code, 0);
    const first = readBinding(home, 'sub-local');
    git(repo, 'commit', '-q', '--amend', '--allow-empty', '-m', 'amended');
    assert.equal((await runCli(home, args, env)).code, 0);
    const second = readBinding(home, 'sub-local');
    assert.deepEqual([second?.agent, second?.session], ['ou-fix-cache', OWNER]);
    assert.equal(first?.session, second?.session);
    assert.equal(relayBinding(home, 'sub-local', OWNER)?.agent, 'ou-fix-cache');
  });
});
