import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { request, type IncomingHttpHeaders } from 'node:http';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import {
  tmp,
  git,
  localRepo,
  writeJson,
  startBridge,
  runCli,
  TOKEN,
  CLAUDE_DIR,
  storyList,
  markReviewed,
  claimAt,
  type TestBridge,
} from './helpers.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import { Sessions, type SessionsFeed } from '../src/services/sessions/sessions.ts';
import { worktreeFixture } from '@once-upon-a-diff/test-kit/git';
import { Inbox } from '../src/services/inbox/inbox.ts';
import { markQuestions } from '../src/services/inbox/conversation.ts';
import { Board, liveSessions, noPrWatcher, type PrWatcher } from '../src/services/board/board.ts';
import { columnOf, isBackToYou } from '../src/services/board/columns.ts';
import { answerBits } from '@once-upon-a-diff/web/public/board/columns/story-answers.ts';
import {
  BacklogStore,
  assignBranch,
  assignLine,
  backlogCards,
} from '../src/services/backlog/backlog.ts';
import { voiceStatus } from '../src/services/voice/voice.ts';
import {
  bridgeUp,
  forgetProbes,
  readVoice,
  phoneReady,
  runVoiceCtl,
  sinkPort,
  type PhoneCommand,
  waitBridgeDown,
} from '../src/adapters/larmor.ts';
import {
  listenCandidates,
  listenStoryPromptFor,
  adoptHandlers,
  sessionOfPid,
  type ListeningInput,
} from '../src/services/sessions/listening.ts';
import { listenPrompt, type Listener } from '../src/services/listeners/listeners.ts';
import type { LiveSession } from '../src/adapters/claude-sessions/live-sessions.ts';
import { noteListener, readHistory } from '../src/services/listeners/history.ts';
import { repoStopReason, requestStop, stopRequested } from '../src/services/inbox/auto-stop.ts';
import { AgentRegistry } from '../src/services/ledger/registry.ts';
import {
  gateOf,
  parseLedger,
  parseLedgerTime,
  parseProgress,
} from '../src/services/ledger/ledger.ts';
import { pickSource, registrySource } from '../src/services/sessions/sources.ts';
import { findIt2, focusTab, itermSource, typeLine } from '../src/adapters/iterm.ts';
import { boardKey, pageKey, viewKey } from '../src/services/pages/page-key.ts';
import { readSettings } from '../src/services/config/settings.ts';
import type { StatusSource } from '../src/adapters/status-source.ts';
import {
  ghBranchCheck,
  ghPrCheck,
  ghRequestedCheck,
  type BranchPr,
} from '../src/services/review/github-checks.ts';
import { mergeSummary } from '../src/services/review/merge-rules.ts';
import { AutoReview } from '../src/services/review/github-watcher.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { localEntries, localStories, LOCAL_IDLE_DAYS } from '../src/services/review/story-lists.ts';
import { createLocalStory } from '../src/services/stories/local-story.ts';
import { refreshLocal } from '../src/services/stories/local-diff.ts';
import type { LocalMeta } from '../src/services/stories/types.ts';
import type {
  BoardCard,
  BoardData,
  BoardSession,
  PrInfo,
  StoryRequest,
} from '@once-upon-a-diff/contracts/types';

const NOW = new Date('2026-10-26T19:00:00Z'); // 3:00 PM EDT

const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

/** The process's start time as the registry's procStart spells it (UTC, as `ps` says it). */
const procStartOf = (pid: number) =>
  execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  }).trim();

/** A pid that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid as number;
}

/** A transcript the way Claude Code writes it, in the projects folder the board looks in by default. */
function transcript(cwd: string, sessionId: string, lines: unknown[]) {
  const file = path.join(
    CLAUDE_DIR,
    'projects',
    cwd.replace(/[^A-Za-z0-9]/g, '-'),
    `${sessionId}.jsonl`,
  );
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

/** The lines of a session that has had a prompt, and of one that was just cleared. */
const usedLines = (sessionId: string) => [
  { type: 'mode', mode: 'normal', sessionId },
  { type: 'user', message: { role: 'user', content: 'fix the build' }, sessionId },
  { type: 'assistant', message: { role: 'assistant', content: [] }, sessionId },
];
const clearedLines = (sessionId: string) => [
  { type: 'mode', mode: 'normal', sessionId },
  { type: 'file-history-snapshot', messageId: 'a', snapshot: {}, isSnapshotUpdate: false },
  {
    type: 'user',
    isMeta: true,
    message: {
      role: 'user',
      content: '<local-command-caveat>Caveat: not for you</local-command-caveat>',
    },
    sessionId,
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content:
        '<command-name>/clear</command-name>\n <command-message>clear</command-message>\n <command-args></command-args>',
    },
    sessionId,
  },
  {
    type: 'system',
    subtype: 'local_command',
    content: '<local-command-stdout></local-command-stdout>',
    sessionId,
  },
];

/**
 * A registry file the way Claude Code writes it, and (unless `blank`) a transcript of a session that has had a prompt, so
 * the board shows it as a card; `blank` leaves the transcript as just the clear.
 */
function registry(
  dir: string,
  pid: number,
  extra: Record<string, unknown> = {},
  procStart: string | null = null,
  { blank = false }: { blank?: boolean } = {},
) {
  const sessionId = `${String(pid).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;
  const cwd = (extra.cwd as string) || '/tmp/somewhere/widgets';
  transcript(cwd, sessionId, blank ? clearedLines(sessionId) : usedLines(sessionId));
  writeJson(path.join(dir, `${pid}.json`), {
    pid,
    sessionId,
    cwd: '/tmp/somewhere/widgets',
    name: `session-${pid}`,
    status: 'idle',
    startedAt: NOW.getTime() - 3600000,
    statusUpdatedAt: NOW.getTime() - 600000,
    ...(procStart ? { procStart } : {}),
    ...extra,
  });
}

test('ledger times: a label picks the zone, the year is this one, and a far-future date is last year', () => {
  assert.equal(
    parseLedgerTime('1:50 PM ET, 10/26', NOW)?.toISOString(),
    '2026-10-26T17:50:00.000Z',
  );
  assert.equal(
    parseLedgerTime('12:05 AM ET, 10/26', NOW)?.toISOString(),
    '2026-10-26T04:05:00.000Z',
  );
  assert.equal(
    parseLedgerTime('12:05 PM EST, 1/5', NOW)?.toISOString(),
    '2026-01-05T17:05:00.000Z',
  );
  assert.equal(
    parseLedgerTime('9:00 AM PT, 10/26', NOW)?.toISOString(),
    '2026-10-26T16:00:00.000Z',
  );
  assert.equal(
    parseLedgerTime('8:00 AM, 10/26', NOW, 'Asia/Tokyo')?.toISOString(),
    '2026-10-25T23:00:00.000Z',
  );
  assert.equal(
    parseLedgerTime('3:00 PM ET, 12/30', NOW)?.toISOString(),
    '2025-12-30T20:00:00.000Z',
  );
  assert.equal(parseLedgerTime('no time here', NOW), null);
});

test('the ledger: the last line for a sid and name wins, lane tags and odd lines are handled', () => {
  const agents = parseLedger(
    [
      '# ledger',
      '- [running] sid:5cf3b512 lane:once-upon ou-agent-board (sonnet, high) — Once Upon agent board — started 1:50 PM ET, 10/26',
      '- [done] sid:5cf3b512 lane:once-upon ou-agent-board — 2:30 PM ET, 10/26 — built it — notes/x.md',
      '- [running] sid:5cf3b512 other-agent (opus, default) — a task — started 2:00 PM ET, 10/26',
      '- [failed] sid:abcdef01 broke (sonnet) — 2:10 PM ET, 10/26 — it died',
      '- [done] sid:abcdef01 old-style (sonnet) — no time, just words — path',
      '- [note] sid:abcdef01 2:12 PM ET, 10/26: not an agent line',
      '- [running] sid:zzzz no-sid-hex (x) — t — started 1:00 PM ET, 10/26',
      '- [stopped] sid:abcdef01 stopped-one — 1:00 PM ET, 10/26 — asked to stop',
    ].join('\n'),
    NOW,
  );
  const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent]));
  assert.deepEqual(Object.keys(byName).sort(), [
    'broke',
    'old-style',
    'other-agent',
    'ou-agent-board',
    'stopped-one',
  ]);
  assert.equal(byName['ou-agent-board'].state, 'done');
  assert.equal(byName['ou-agent-board'].lane, 'once-upon');
  assert.equal(byName['ou-agent-board'].model, 'sonnet, high');
  assert.equal(byName['ou-agent-board'].task, 'Once Upon agent board');
  assert.equal(byName['ou-agent-board'].started?.toISOString(), '2026-10-26T17:50:00.000Z');
  assert.equal(byName['ou-agent-board'].ended?.toISOString(), '2026-10-26T18:30:00.000Z');
  assert.equal(byName['ou-agent-board'].outcome, 'built it');
  assert.equal(byName['other-agent'].state, 'running');
  assert.equal(byName['other-agent'].lane, null);
  assert.equal(byName['broke'].state, 'failed');
  assert.equal(byName['broke'].outcome, 'it died');
  assert.equal(byName['old-style'].ended, null);
  assert.equal(byName['stopped-one'].state, 'stopped');
});

test('a waiting agent stays waiting until a later done or stopped line clears it', () => {
  const lines = [
    '- [running] sid:5cf3b512 asker (sonnet, high) — task — started 1:00 PM ET, 10/26',
    '- [waiting] sid:5cf3b512 asker — 1:20 PM ET, 10/26 — needs Eric: which one? — notes/a.md',
  ];
  const [waiting] = parseLedger(lines.join('\n'), NOW);
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.outcome, 'needs Eric: which one?');
  assert.equal(waiting.ended?.toISOString(), '2026-10-26T17:20:00.000Z');
  const stopped = '- [stopped] sid:5cf3b512 asker — 1:30 PM ET, 10/26 — Eric chose A';
  assert.equal(parseLedger([...lines, stopped].join('\n'), NOW)[0].state, 'stopped');
});

test('[review] reads as waiting with the review flag, and a later line clears it', () => {
  const lines = [
    '- [running] sid:5cf3b512 builder (sonnet, high) — build feat/x — started 1:00 PM ET, 10/29',
    '- [review] sid:5cf3b512 builder — 1:20 PM ET, 10/29 — story abc123 up, three chapters — notes/a.md',
  ];
  const [parked] = parseLedger(lines.join('\n'), NOW);
  assert.equal(parked.state, 'waiting');
  assert.equal(parked.review, true);
  assert.equal(parked.outcome, 'story abc123 up, three chapters');
  assert.equal(parked.task, 'build feat/x');
  const [asking] = parseLedger(
    '- [waiting] sid:5cf3b512 builder — 1:30 PM ET, 10/29 — needs Eric: which one?',
    NOW,
  );
  assert.equal(asking.review, false, 'a plain waiting line is a question');
  const after = (line: string) => parseLedger([...lines, line].join('\n'), NOW)[0];
  assert.equal(after('- [done] sid:5cf3b512 builder — 1:40 PM ET, 10/29 — shipped').review, false);
  assert.equal(
    after('- [running] sid:5cf3b512 builder — 1:40 PM ET, 10/29 — fixing').state,
    'running',
  );
  assert.equal(
    after('- [waiting] sid:5cf3b512 builder — 1:40 PM ET, 10/29 — needs Eric: x').review,
    false,
  );
});

test('the outcome is found whether the time comes before it or after it, and a lone notes path is no outcome', () => {
  // the ledger's real lines put the time last
  const [done, review, notesOnly, timeFirst] = parseLedger(
    [
      '- [done] sid:225477e3 ou-ready-label (sonnet, high) — 1d547c3 on stack/39-ready-label: [review] → Ready column; hook edited (uncommitted), dry run OK — 6:04 PM ET, 10/29',
      '- [review] sid:225477e3 ou-x (sonnet, high) — story abc123 up on stack/39, three chapters — 6:04 PM ET, 10/29',
      '- [review] sid:225477e3 ou-y — 6:05 PM ET, 10/29 — notes/y.md',
      '- [review] sid:225477e3 ou-z — 6:06 PM ET, 10/29 — story def456 up — notes/z.md',
    ].join('\n'),
    NOW,
  );
  assert.equal(
    done.outcome,
    '1d547c3 on stack/39-ready-label: [review] → Ready column; hook edited (uncommitted), dry run OK',
  );
  assert.equal(review.outcome, 'story abc123 up on stack/39, three chapters');
  assert.equal(review.review, true);
  assert.equal(notesOnly.outcome, 'notes/y.md', 'nothing else to show: the path stays');
  assert.equal(timeFirst.outcome, 'story def456 up');
});

test('progress beats: the latest per agent', () => {
  const beats = parseProgress(
    [
      '- 1:23 PM ou-review-inbox 4/6 tests: writing turn tests',
      '- 1:32 PM ou-review-inbox 5/6 green: typecheck lint tests pass',
      '- 1:34 PM ou-agent-board 1/6 read: reading inbox notes',
      'garbage',
    ].join('\n'),
  );
  assert.deepEqual(beats.get('ou-review-inbox'), {
    n: 5,
    of: 6,
    step: 'green',
    note: 'typecheck lint tests pass',
  });
  assert.equal(beats.get('ou-agent-board')?.n, 1);
  assert.equal(beats.size, 2);
});

test('live sessions: a dead pid, a reused pid and a bad file are left out; the tty comes from ps', async () => {
  const dir = tmp('board-sessions');
  registry(dir, process.pid, {}, procStartOf(process.pid));
  registry(dir, await deadPid());
  registry(dir, process.ppid, {}, 'Mon Jan  1 00:00:00 2001'); // alive, but not the process that wrote it
  writeFileSync(path.join(dir, '12345.json'), '{not json');
  writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const live = await liveSessions(dir);
  assert.deepEqual(
    live.map((session) => session.pid),
    [process.pid],
  );
  assert.equal(live[0].cwd, '/tmp/somewhere/widgets');
  assert.equal(live[0].status, 'idle');
  assert.equal(await liveSessions(path.join(dir, 'missing')).then((list) => list.length), 0);
});

test('valid JSON that is not the expected shape (null, a number, an object for a list) drops only itself', async () => {
  const dir = tmp('board-bad-shapes');
  registry(dir, process.pid, {}, procStartOf(process.pid));
  for (const [pid, text] of [
    [11111, 'null'],
    [22222, '7'],
    [33333, '"text"'],
  ] as const) {
    writeFileSync(path.join(dir, `${pid}.json`), text);
  }
  assert.deepEqual(
    (await liveSessions(dir)).map((session) => session.pid),
    [process.pid],
    'the real session is still there',
  );

  const voice = tmp('board-bad-voice');
  for (const text of ['null', '3', '"on"', '[]']) {
    writeFileSync(path.join(voice, 'session'), text);
    assert.equal(readVoice(voice), null, text);
  }

  // an it2 that answers `null` for the list, a list holding null, and `null` for a tab's status
  const live = (tty: string, session: string) => ({
    pid: 1,
    session,
    cwd: '/x',
    name: null,
    tty,
    status: 'idle',
    statusAt: null,
    startedAt: null,
  });
  const it2With = (list: string, status: string) => {
    const file = path.join(tmp('board-bad-it2'), 'it2');
    writeFileSync(
      file,
      `#!/bin/sh\nif [ "$2" = list ]; then\n  echo '${list}'\nelse\n  echo '${status}'\nfi\n`,
    );
    chmodSync(file, 0o755);
    return file;
  };
  const sessions = [live('ttys042', 's-one')];
  for (const list of ['null', '{"id":"TAB-1"}', '7']) {
    assert.equal((await itermSource(it2With(list, '{}')).statuses(sessions)).size, 0, list);
    assert.equal(typeof (await focusTab(it2With(list, '{}'), 'ttys042', async () => {})), 'string');
  }
  const mixed = '[null,{"id":"TAB-1","name":"Real","tty":"ttys042"}]';
  assert.equal((await itermSource(it2With(mixed, 'null')).statuses(sessions)).size, 0);
  assert.equal(
    (await itermSource(it2With(mixed, '{"status":"working"}')).statuses(sessions)).get('s-one')
      ?.status,
    'working',
    'the null entry is skipped, the real tab is read',
  );
  // the count is the status's own `background_tasks`: a whole number from 0, else unknown, whatever the detail says
  const tasksOf = async (status: string) =>
    (await itermSource(it2With(mixed, status)).statuses(sessions)).get('s-one')?.tasks;
  assert.equal(await tasksOf('{"status":"working","detail":"zzz","background_tasks":2}'), 2);
  assert.equal(await tasksOf('{"status":"working","background_tasks":0}'), 0);
  assert.equal(
    await tasksOf('{"status":"working","detail":"3 background tasks running"}'),
    null,
    'a detail line is not a count',
  );
  assert.equal(await tasksOf('{"status":"working","background_tasks":-1}'), null);
  assert.equal(await tasksOf('{"status":"working","background_tasks":"2"}'), null);
});

/** A built PR story in the home, where the bridge finds it. `state` adds files to its state folder. */
function prStory(
  home: string,
  id: string,
  repo: string,
  number: number,
  branch: string | null = null,
  state: Record<string, unknown> = {},
) {
  const dir = path.join(home, id);
  writeJson(path.join(dir, 'meta.json'), {
    kind: 'github',
    repo,
    number,
    pr_title: `PR ${number}`,
    ...(branch ? { head_ref: branch } : {}),
  });
  writeJson(path.join(dir, 'chapters.json'), { title: `Story ${number}`, chapters: [] });
  for (const [name, value] of Object.entries(state)) {
    writeJson(path.join(home, 'state', id, name), value);
  }
}

/** A source that says what it's told, keyed by session id prefix. */
const sourceSaying = (
  says: Record<
    string,
    { status: 'waiting' | 'working' | 'done'; detail: string | null; tasks?: number | null }
  >,
): StatusSource => ({
  name: 'iterm',
  statuses: async (sessions) =>
    new Map(
      sessions.flatMap((session) => {
        const found = says[session.session.slice(0, 8)];
        return found
          ? [[session.session, { tasks: null, ...found, title: 'Tab title' }] as const]
          : [];
      }),
    ),
});

/** A PR as GitHub would say it, with what a test changes. */
const prInfo = (number: number, extra: Partial<PrInfo> = {}): PrInfo => ({
  number,
  url: `https://github.com/acme/widgets/pull/${number}`,
  title: `PR ${number}`,
  state: 'open',
  draft: false,
  branch: null,
  author: 'octocat',
  mine: true,
  review_requested: false,
  approvals: 0,
  required: null,
  review: null,
  checks: null,
  merge: null,
  merged_at: null,
  unresolved: 0,
  viewer_at: null,
  others_at: null,
  ...extra,
});

/** A GitHub watcher that answers from what a test gives it, and records what the board asked. */
function fakeWatcher(
  infos: PrInfo[] = [],
  branchPrs: Record<string, BranchPr | null> = {},
  requested: { repo: string; number: number }[] = [],
) {
  const asked = {
    branches: [] as string[],
    checkouts: [] as string[],
    infos: [] as number[],
    stories: [] as string[],
    locals: [] as string[],
  };
  const watcher: PrWatcher = {
    kick: (list) => asked.stories.push(...list.map((story) => story.id)),
    kickInfo: (_repo, number) => asked.infos.push(number),
    kickBranch: (repo, branch, checkout) => {
      asked.branches.push(`${repo}@${branch}`);
      asked.checkouts.push(checkout);
    },
    info: (_repo, number) => infos.find((info) => info.number === number) || null,
    branchPr: (repo, branch) => branchPrs[`${repo}@${branch}`],
    kickLocal: (list) => asked.locals.push(...list.map((entry) => entry.story.id)),
    kickRequested: () => undefined,
    requested: () => requested,
  };
  return { watcher, asked };
}

/** A process that stays alive for the test, so a registry file can name it. */
function liveChild(): { pid: number; procStart: string; stop: () => void } {
  const child = spawn('sleep', ['60']);
  const pid = child.pid as number;
  return { pid, procStart: procStartOf(pid), stop: () => child.kill() };
}

/** A checkout of acme/<name> on a branch, where a session can work. */
function checkoutOf(name: string, branch: string): string {
  const dir = tmp('board-checkout');
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'remote', 'add', 'origin', `git@github.com:acme/${name}.git`);
  return dir;
}

const fullId = (pid: number) => `${String(pid).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;

test("someone else's PR with a built story stays in PR open despite an unread answer (#7009)", () => {
  const none = { sessions: [], agents: [], pr: null, story: null };
  // #7009's shape: Usman's PR, you not requested, a reviewed story you have opened, one unread answer to your question
  const theirs = prInfo(7009, {
    author: 'usman154',
    mine: false,
    review_requested: false,
    approvals: 1,
    required: 3,
    review: 'approved',
    checks: 'failure',
    unresolved: 1,
    viewer_at: '2026-11-02T22:05:47Z',
    others_at: null,
  });
  const story = { reviewed: true, manualReviewedAt: null, unread: false, answered: 1 };
  assert.equal(columnOf({ ...none, pr: theirs, story }), 'pr_open');
  // what still puts it in Back to you: GitHub asking for your review, a new version of the story, a reply for you
  assert.equal(
    columnOf({ ...none, pr: { ...theirs, review_requested: true }, story }),
    'back',
    'requested',
  );
  assert.equal(columnOf({ ...none, pr: theirs, story: { ...story, unread: true } }), 'back');
  assert.equal(
    columnOf({ ...none, pr: { ...theirs, others_at: '2026-11-02T22:30:00Z' }, story }),
    'back',
  );
  // your own PR keeps the rule: an unread answer is back to you
  assert.equal(columnOf({ ...none, pr: { ...theirs, mine: true }, story }), 'back');
  // a stub PR (GitHub has not said who wrote it yet): author null, mine false, treated as yours
  assert.equal(columnOf({ ...none, pr: { ...theirs, author: null }, story }), 'back', 'stub');
  // the answer is still on the card in PR open: a chip and Open story
  const bits = answerBits({
    column: 'pr_open',
    story: { unread_answers: 1 } as Parameters<typeof answerBits>[0]['story'],
  });
  assert.equal(bits.chip, '1 unread answer');
  assert.ok(bits.openable);
});

test('columns follow the work to merge: waiting and working first, then merged, ready, back to you, PR open', () => {
  const none = { sessions: [], agents: [], pr: null, story: null };
  const open = prInfo(1);
  const unseen = { reviewed: false, manualReviewedAt: null, unread: false };
  assert.equal(columnOf({ ...none, sessions: [{ status: 'waiting' }], pr: open }), 'waiting');
  assert.equal(columnOf({ ...none, agents: [{ status: 'waiting', state: 'waiting' }] }), 'waiting');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'working' }], story: unseen }), 'working');
  assert.equal(columnOf({ ...none, agents: [{ status: 'working', state: 'running' }] }), 'working');
  assert.equal(columnOf({ ...none, pr: prInfo(1, { state: 'merged' }), story: unseen }), 'done');
  assert.equal(columnOf({ ...none, story: unseen }), 'ready');
  // a PR is the GitHub side, whoever wrote it and whatever story it has: never Ready for your review
  assert.equal(columnOf({ ...none, pr: open, story: unseen }), 'pr_open');
  assert.equal(columnOf({ ...none, pr: open, story: { ...unseen, local: true } }), 'pr_open');
  assert.equal(
    columnOf({ ...none, pr: open, story: { ...unseen, local: true, unread: true } }),
    'pr_open',
  );
  // a local story is never in Back to you: unread or not, reviewed or not, it waits in Ready
  const local = { ...unseen, local: true };
  assert.equal(columnOf({ ...none, story: { ...local, unread: true } }), 'ready');
  assert.equal(columnOf({ ...none, story: { ...local, reviewed: true, unread: true } }), 'ready');
  assert.equal(columnOf({ ...none, story: local }), 'ready');
  assert.equal(columnOf({ ...none, story: { ...local, reviewed: true } }), 'idle');
  assert.equal(columnOf({ ...none, pr: open, story: { ...unseen, unread: true } }), 'back');
  // an unread answer to your question: Ready while there is no PR, Back to you once there is one, local story or not
  const answered = { ...unseen, reviewed: true, answered: 1 };
  assert.equal(columnOf({ ...none, story: { ...answered, local: true } }), 'ready');
  assert.equal(columnOf({ ...none, pr: open, story: answered }), 'back');
  assert.equal(columnOf({ ...none, pr: open, story: { ...answered, local: true } }), 'back');
  assert.equal(columnOf({ ...none, pr: open, story: { ...answered, answered: 0 } }), 'pr_open');
  assert.equal(columnOf({ ...none, pr: { ...open, state: 'merged' }, story: answered }), 'done');
  assert.equal(
    columnOf({ ...none, sessions: [{ status: 'working' }], pr: open, story: answered }),
    'working',
  );
  assert.equal(columnOf({ ...none, pr: open }), 'pr_open');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'idle' }], pr: open }), 'pr_open');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'idle' }] }), 'idle');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'error' }] }), 'error');
  assert.equal(columnOf({ ...none, agents: [{ status: 'error', state: 'failed' }] }), 'waiting');
  // back to you: others newer than your last activity (a review or comment of yours, or a story you marked by hand)
  const later = { viewer_at: '2026-10-26T10:00:00Z', others_at: '2026-10-26T11:00:00Z' };
  assert.equal(columnOf({ ...none, pr: prInfo(1, later) }), 'back');
  const caughtUp = prInfo(1, { ...later, viewer_at: '2026-10-26T12:00:00Z' });
  assert.equal(columnOf({ ...none, pr: caughtUp }), 'pr_open');
  const byHand = {
    reviewed: true,
    manualReviewedAt: Date.parse('2026-10-26T10:30:00Z'),
    unread: false,
  };
  assert.equal(
    columnOf({ ...none, pr: prInfo(1, { others_at: later.others_at }), story: byHand }),
    'back',
  );
  const older = prInfo(1, { others_at: '2026-10-26T09:00:00Z' });
  assert.equal(columnOf({ ...none, pr: older, story: byHand }), 'pr_open');
  // no sign of your activity: nothing to compare with, so not back to you
  assert.equal(columnOf({ ...none, pr: prInfo(1, { others_at: later.others_at }) }), 'pr_open');
  assert.equal(isBackToYou({ pr: null, story: null }), false);
  // a story built after you last opened it is back to you; one you never opened is ready for review
  assert.equal(columnOf({ ...none, pr: open, story: { ...unseen, unread: true } }), 'back');
  assert.equal(columnOf({ ...none, pr: open, story: { ...byHand, unread: true } }), 'back');
  assert.equal(columnOf({ ...none, pr: open, story: { ...unseen, reviewed: true } }), 'pr_open');
  // GitHub waiting on your review is back to you; a session building for the PR is working
  assert.equal(columnOf({ ...none, pr: prInfo(1, { review_requested: true }) }), 'back');
  assert.equal(columnOf({ ...none, pr: open, story: unseen, building: true }), 'working');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'waiting' }], building: true }), 'waiting');
});

test('the board: a card per branch or PR with its sessions and agents, columns to merge, lanes by repo', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  const progress = path.join(path.dirname(ledger), 'progress.md');
  const children = Array.from({ length: 7 }, () => liveChild());
  after(() => children.forEach((child) => child.stop()));
  const [onStory, second, onBranch, onMain, loose, staleOne, staleTwo] = children;
  const sid = (child: { pid: number }) => String(child.pid).padStart(8, '0');
  const widgetsX = checkoutOf('widgets', 'feat/x');
  const widgetsY = checkoutOf('widgets', 'feat/y');
  const gadgets = checkoutOf('gadgets', 'main');
  const noRepo = tmp('board-no-repo');
  const stale = checkoutOf('widgets', 'old/merged');
  // two sessions on the branch that has a story, one on a branch GitHub knows a PR for, one on a default branch, one outside any repo
  registry(
    sessions,
    onStory.pid,
    { cwd: widgetsX, name: 'story-one', status: 'busy' },
    onStory.procStart,
  );
  registry(sessions, second.pid, { cwd: widgetsX, name: 'story-two' }, second.procStart);
  registry(sessions, onBranch.pid, { cwd: widgetsY, name: 'branch-one' }, onBranch.procStart);
  registry(sessions, onMain.pid, { cwd: gadgets, name: 'main-one' }, onMain.procStart);
  registry(sessions, loose.pid, { cwd: noRepo, name: 'loose-one' }, loose.procStart);
  // two unrelated sessions in a checkout left on a branch whose PR merged: each is a card of its own
  registry(sessions, staleOne.pid, { cwd: stale, name: 'stale-one' }, staleOne.procStart);
  registry(sessions, staleTwo.pid, { cwd: stale, name: 'stale-two' }, staleTwo.procStart);

  // stories: 7 is being worked on, 8 is built and waiting for you, 10 you reviewed and others asked something since,
  // 11 you reviewed and read, nothing is new, 17 you reviewed but it was rebuilt since, 12 merged half an hour ago,
  // 13 merged three days ago, 21 merged two hours ago, 14 is someone else's PR with a story built for you, 15 has not been described by GitHub yet
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  prStory(home, 'acme-widgets-8', 'acme/widgets', 8, 'feat/z');
  prStory(home, 'acme-widgets-14', 'acme/widgets', 14, 'feat/theirs');
  prStory(home, 'acme-widgets-15', 'acme/widgets', 15, 'feat/unknown');
  prStory(home, 'acme-widgets-23', 'acme/widgets', 23, 'feat/their-draft');
  const byHand = { 'reviewed.json': { at: '2026-10-26T14:00:00Z', by: 'manual' } };
  const opened = { 'position.json': { at: '2099-01-01T00:00:00Z' } }; // you opened the story after it was built
  prStory(home, 'acme-widgets-10', 'acme/widgets', 10, 'feat/ten', { ...byHand, ...opened });
  prStory(home, 'acme-widgets-11', 'acme/widgets', 11, 'feat/eleven', { ...byHand, ...opened });
  prStory(home, 'acme-widgets-17', 'acme/widgets', 17, 'feat/seventeen', byHand);
  // a session is fixing the code for story 18 (a claimed fix request), and building a story for PR 16, which has none yet
  prStory(home, 'acme-widgets-18', 'acme/widgets', 18, 'feat/eighteen', { ...byHand, ...opened });
  writeJson(path.join(home, 'fixes.json'), {
    f1: {
      id: 'f1',
      story: 'acme-widgets-18',
      repo: 'acme/widgets',
      kind: 'github',
      title: null,
      url: null,
      branch: null,
      checkout: null,
      notes: [],
      to: null,
      requested_at: NOW.toISOString(),
      status: 'pending',
      claimed_by: 'session-a',
      claimed_at: new Date().toISOString(),
    },
  });
  new Builds(home).save({
    'acme/widgets#16': {
      id: 'b1',
      repo: 'acme/widgets',
      number: 16,
      url: null,
      requested_at: NOW.toISOString(),
      status: 'pending',
      mode: 'rebuild',
      claimed_by: 'session-b',
      claimed_at: new Date().toISOString(),
    },
  });
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3600000).toISOString();
  prStory(home, 'acme-widgets-12', 'acme/widgets', 12, 'feat/twelve', {
    'merged.json': { at: hoursAgo(0.25), why: 'merged', merged_at: hoursAgo(0.5) },
  });
  prStory(home, 'acme-widgets-21', 'acme/widgets', 21, 'feat/twenty-one', {
    'merged.json': { at: hoursAgo(1.9), why: 'merged', merged_at: hoursAgo(2) },
  });
  prStory(home, 'acme-widgets-13', 'acme/widgets', 13, 'feat/thirteen', {
    'merged.json': { at: hoursAgo(71), why: 'merged', merged_at: hoursAgo(72) },
  });

  // two agents registered on PR 7's branch and PR: nested in its card, whatever their tasks say
  const registered = new AgentRegistry(home);
  registered.start({
    sid: sid(onStory),
    name: 'nested-one',
    kind: 'author',
    task: 'nested task',
    model: 'sonnet',
    effort: 'low',
    repo: 'acme/widgets',
    branch: 'feat/x',
    at: etAt(14, 50),
  });
  registered.beat('nested-one', { n: 3, of: 6, step: 'code', note: 'writing', at: etAt(14, 52) });
  registered.start({
    sid: sid(onStory),
    name: 'pr-agent',
    kind: 'author',
    task: 'review fixes',
    model: 'sonnet',
    effort: 'low',
    repo: 'acme/widgets',
    pr: 7,
    at: etAt(14, 51),
  });
  writeFileSync(
    ledger,
    [
      `- [done] sid:${sid(onStory)} nested-done — 2:40 PM ET, 10/26 — it finished`,
      `- [done] sid:${sid(onStory)} nested-old — 7:40 AM ET, 10/26 — hours ago`,
      `- [running] sid:${sid(onStory)} lane:cross-cutting tagged-one (sonnet, high) — tagged task — started 2:55 PM ET, 10/26`,
      `- [running] sid:${sid(onStory)} wt-agent (sonnet, low) — refactor in widgets-worktrees/refactor — started 2:52 PM ET, 10/26`,
      `- [running] sid:${sid(onStory)} crosscut-note (sonnet, low) — notes for the Cross Cutting plan — started 2:53 PM ET, 10/26`,
      `- [waiting] sid:${sid(onMain)} needs-answer — 2:45 PM ET, 10/26 — needs Eric: pick A or B — notes/x.md`,
      '- [running] sid:deadbeef orphan (sonnet, high) — no parent — started 2:57 PM ET, 10/26',
      '- [failed] sid:deadbeef broke — 2:58 PM ET, 10/26 — exploded',
      '- [stopped] sid:deadbeef stopped-one — 2:59 PM ET, 10/26 — asked to stop',
    ].join('\n'),
  );
  writeFileSync(progress, '- 2:56 PM tagged-one 1/6 read: reading\n');
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_progress_file: progress,
    board_sessions_dir: sessions,
  });
  const seven = prInfo(7, {
    title: 'Seven on GitHub',
    branch: 'feat/x',
    approvals: 1,
    required: 2,
    checks: 'success',
    merge: { ready: false, text: 'needs 1 more approval', tone: 'warn' },
  });
  const { watcher, asked } = fakeWatcher(
    [
      seven,
      prInfo(8),
      prInfo(14, { author: 'someone', mine: false }),
      prInfo(16, { author: 'someone', mine: false }),
      prInfo(17),
      prInfo(18),
      prInfo(19, { author: 'someone', mine: false, review_requested: true }),
      prInfo(20, { author: 'someone', mine: false, review_requested: true, draft: true }),
      prInfo(22, { draft: true }),
      prInfo(23, { author: 'someone', mine: false, review_requested: true, draft: true }),
      prInfo(9, { branch: 'feat/y', checks: 'pending' }),
      prInfo(10, { viewer_at: '2026-10-26T13:00:00Z', others_at: '2026-10-26T15:00:00Z' }),
      prInfo(11, { others_at: '2026-10-26T13:00:00Z' }),
      prInfo(12, { state: 'merged', merged_at: hoursAgo(0.5) }),
      prInfo(21, { state: 'merged', merged_at: hoursAgo(2) }),
    ],
    {
      'acme/widgets@feat/y': { number: 9, state: 'open', merged_at: null },
      'acme/widgets@old/merged': { number: 3, state: 'merged', merged_at: null },
    },
    // 19 is someone else's PR GitHub is waiting on your review for
    // 20 is someone else's draft with a review request, and 22 is your own draft
    [
      { repo: 'acme/widgets', number: 19 },
      { repo: 'acme/widgets', number: 20 },
      { repo: 'acme/widgets', number: 22 },
    ],
  );
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({
      [sid(onBranch)]: { status: 'waiting', detail: 'asked you a question' },
      [sid(loose)]: { status: 'working', detail: 'compiling' },
      [sid(staleTwo)]: { status: 'done', detail: null },
    }),
    now: () => NOW,
  });
  const data = await board.snapshot();
  assert.equal(data.status_source, 'iterm');
  const cards = data.lanes.flatMap((lane) => lane.cards);
  const card = (id: string) => cards.find((found) => found.id === id) as BoardCard;

  assert.deepEqual(Object.fromEntries(cards.map((found) => [found.id, found.column])), {
    'pr:acme/widgets#7': 'working', // a session is busy on it, though its story is unreviewed
    'pr:acme/widgets#9': 'waiting', // found by its branch, no story; the session asked a question
    'pr:acme/widgets#8': 'pr_open', // an unreviewed story on a PR is still the GitHub side's
    'pr:acme/widgets#10': 'back', // an open thread asks something of you
    'pr:acme/widgets#11': 'pr_open',
    'pr:acme/widgets#17': 'back', // rebuilt since you last opened it
    'pr:acme/widgets#18': 'working', // a session is fixing the code
    'pr:acme/widgets#16': 'working', // a session is building its story, whatever branch it is on
    'pr:acme/widgets#14': 'pr_open', // someone else's PR, with a story built for you: GitHub's side, not Ready
    'pr:acme/widgets#15': 'pr_open',
    'pr:acme/widgets#19': 'back', // GitHub is waiting on your review
    'pr:acme/widgets#22': 'pr_open', // your own draft still shows
    'pr:acme/widgets#12': 'done',
    [fullId(onMain.pid)]: 'idle',
    [`agent:${sid(onMain)}:needs-answer`]: 'waiting', // its own card, in its parent's lane
    [fullId(staleOne.pid)]: 'idle', // the branch's PR merged: a card of its own, not shared
    [fullId(staleTwo.pid)]: 'idle', // its tab says done, nothing waiting: the Idle lane
    [`agent:${sid(onStory)}:wt-agent`]: 'working',
    [`agent:${sid(onStory)}:crosscut-note`]: 'working',
    [fullId(loose.pid)]: 'working',
    [`agent:${sid(onStory)}:tagged-one`]: 'working',
    'agent:deadbeef:orphan': 'working',
    [`agent:${sid(onStory)}:nested-done`]: 'done', // a ledger [done] line, finished 20 minutes ago: in Done for 30
    'agent:deadbeef:broke': 'waiting',
    'agent:deadbeef:stopped-one': 'waiting',
  });
  assert.equal(card('pr:acme/widgets#13'), undefined, 'merged three days ago: gone');
  assert.equal(
    card('pr:acme/widgets#21'),
    undefined,
    'merged two hours ago: gone, the Done hour is up',
  );
  assert.equal(card('pr:acme/widgets#17').story?.unread, true);
  assert.equal(card('pr:acme/widgets#11').story?.unread, false);
  assert.equal(
    card('pr:acme/widgets#8').story?.unread,
    false,
    'never opened: ready, not back to you',
  );
  assert.deepEqual(
    [card('pr:acme/widgets#16').building?.kind, card('pr:acme/widgets#16').building?.by],
    ['rebuild', 'session-b'],
  );
  assert.equal(card('pr:acme/widgets#16').detail, 'rebuilding story');
  assert.equal(card('pr:acme/widgets#18').building?.kind, 'fix');
  assert.equal(card('pr:acme/widgets#16').story, null);
  assert.equal(card('pr:acme/widgets#19').pr?.review_requested, true);
  assert.equal(card('pr:acme/widgets#19').story, null);
  assert.equal(
    card('pr:acme/widgets#20'),
    undefined,
    'someone else’s draft is not on the board, review request or not',
  );
  assert.equal(
    card('pr:acme/widgets#23'),
    undefined,
    'someone else’s draft is not on the board even with a story built for you',
  );
  assert.equal(card('pr:acme/widgets#14').pr?.mine, false);
  // a finished agent sits in Done (a ledger [done] line) or Waiting (stopped or failed) for 30 minutes after its last line
  // (finished-agents.test.ts has the timing), then has no card, not even in the Idle lane
  assert.equal(card(`agent:${sid(onStory)}:nested-old`), undefined, 'hours ago');
  assert.equal(card(`agent:${sid(onStory)}:nested-done`).column, 'done');
  for (const id of ['agent:deadbeef:stopped-one', 'agent:deadbeef:broke']) {
    assert.equal(card(id).column, 'waiting', id);
  }
  // sessions on a branch whose PR merged are not lumped into one card named for it: one card each, by session title
  assert.equal(card(fullId(staleOne.pid)).kind, 'session');
  assert.equal(card(fullId(staleOne.pid)).title, 'stale-one');
  assert.equal(card(fullId(staleTwo.pid)).title, 'Tab title');
  assert.equal(card(fullId(staleOne.pid)).branch, 'old/merged');
  assert.equal(cards.filter((found) => found.branch === 'old/merged').length, 2);
  // a ledger agent's lane: its tag, else its parent's (its task text is not read)
  assert.equal(card(`agent:${sid(onStory)}:wt-agent`).lane, 'acme/widgets');
  assert.equal(card(`agent:${sid(onStory)}:crosscut-note`).lane, 'acme/widgets');
  assert.equal(card(`agent:${sid(onMain)}:needs-answer`).lane, 'acme/gadgets');
  assert.equal(card('agent:deadbeef:orphan').lane, 'No live session');
  assert.equal(card(`agent:${sid(onStory)}:wt-agent`).parent, 'story-one');
  assert.deepEqual(
    data.lanes.map((lane) => lane.name).filter((name) => !name.startsWith('once-upon-')),
    ['cross-cutting', 'gadgets', 'No live session', 'widgets'],
  );
  assert.equal(card('pr:acme/widgets#9').lane, 'acme/widgets');

  const working = card('pr:acme/widgets#7');
  assert.equal(working.kind, 'work');
  assert.equal(working.title, 'Seven on GitHub');
  assert.equal(working.branch, 'feat/x');
  assert.deepEqual(
    working.sessions.map((session) => [session.title, session.status]),
    [
      ['story-one', 'working'],
      ['story-two', 'idle'],
    ],
  );
  assert.deepEqual(
    working.agents.map((agent) => [agent.name, agent.status]),
    [
      ['nested-one', 'working'],
      ['pr-agent', 'working'],
    ],
    'only agents registered on the same branch or PR are nested; the rest have their own cards',
  );
  assert.deepEqual(working.agents[0].beat, { n: 3, of: 6, step: 'code', note: 'writing' });
  assert.deepEqual(working.pr, seven);
  assert.deepEqual(working.story?.reviewed, false);

  const asking = card('pr:acme/widgets#9');
  assert.equal(asking.story, null);
  assert.equal(asking.detail, 'asked you a question');
  assert.equal(asking.sessions[0].title, 'Tab title');
  assert.equal(asking.pr?.checks, 'pending');

  const ready = card('pr:acme/widgets#8');
  assert.equal(ready.title, 'PR 8');
  assert.equal(ready.story?.reviewed, false);
  assert.equal(ready.sessions.length, 0);
  assert.equal(ready.column, 'pr_open');

  assert.equal(card('pr:acme/widgets#12').since, hoursAgo(0.5));
  assert.equal(card('pr:acme/widgets#12').story, null);

  const main = card(fullId(onMain.pid));
  assert.equal(main.kind, 'session');
  assert.equal(main.branch, 'main');
  assert.equal(main.lane, 'acme/gadgets');
  assert.equal(main.agents.length, 0, 'a session card has its agents as cards of their own');
  const needsAnswer = card(`agent:${sid(onMain)}:needs-answer`);
  assert.equal(needsAnswer.detail, 'needs Eric: pick A or B');
  assert.equal(needsAnswer.parent, 'main-one');
  assert.equal(card(fullId(loose.pid)).detail, 'compiling');
  assert.equal(card(`agent:${sid(onStory)}:tagged-one`).parent, 'story-one');
  assert.equal(card(`agent:${sid(onStory)}:tagged-one`).lane, 'cross-cutting');

  // GitHub was asked in the background for what the board needs
  assert.deepEqual([...new Set(asked.branches)].sort(), [
    'acme/widgets@feat/y',
    'acme/widgets@old/merged',
  ]);
  assert.ok(
    asked.checkouts.length && asked.checkouts.every((dir) => path.isAbsolute(dir)),
    'a branch ask names the session’s checkout, where a merged PR’s head commit is looked for',
  );
  assert.ok(asked.infos.includes(9) && asked.infos.includes(8));
  assert.ok(asked.stories.includes('acme-widgets-7'));
  assert.ok(!asked.stories.includes('acme-widgets-12'), 'a merged story is not asked about again');

  // answers are kept for a moment, and `since` stays while the status does
  const since = working.sessions[0].since;
  const later = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => new Date(NOW.getTime() + 60000),
  });
  assert.ok(await later.snapshot());
  assert.equal(since, working.sessions[0].since);
});

test('a status change moves `since` to when the board saw it', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  registry(sessions, process.pid, { status: 'busy' }, procStartOf(process.pid));
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  let clock = NOW;
  let state: 'working' | 'waiting' = 'working';
  const source: StatusSource = {
    name: 'iterm',
    statuses: async (live) =>
      new Map(
        live.map((session) => [
          session.session,
          { status: state, detail: null, tasks: null, title: null },
        ]),
      ),
  };
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source,
    now: () => clock,
  });
  const first = (await board.snapshot()).lanes[0].cards[0];
  assert.equal(first.column, 'working');
  assert.equal(
    first.sessions[0].since,
    new Date(NOW.getTime() - 600000).toISOString(),
    'first sight: the registry’s time',
  );
  clock = new Date(NOW.getTime() + 5000);
  state = 'waiting';
  const second = (await board.snapshot()).lanes[0].cards[0];
  assert.equal(second.column, 'waiting');
  assert.equal(second.since, clock.toISOString());
});

test('the board is off until configured: no ledger, no agents; and the settings read as documented', () => {
  const home = tmp('board-settings');
  const unset = readSettings(home).board;
  assert.equal(unset.ledgerFile, null);
  assert.equal(unset.progressFile, null);
  assert.equal(unset.statusSource, null);
  assert.equal(unset.doneHours, 1);
  assert.match(unset.sessionsDir, /sessions$/);
  writeJson(path.join(home, 'config.json'), {
    board_status_source: 'registry',
    board_ledger_file: '~/notes/ledger.md',
    board_done_hours: 8,
    board_sessions_dir: '/x/sessions',
  });
  const set = readSettings(home).board;
  assert.equal(set.statusSource, 'registry');
  assert.match(set.ledgerFile as string, /\/notes\/ledger\.md$/);
  assert.ok(!(set.ledgerFile as string).startsWith('~'));
  assert.equal(set.doneHours, 8);
  assert.equal(set.sessionsDir, '/x/sessions');
});

test('the iTerm source matches a session to its tab by tty and reads the tab’s status', async () => {
  const dir = tmp('board-it2');
  const it2 = path.join(dir, 'it2');
  writeFileSync(
    it2,
    `#!/bin/sh
if [ "$2" = list ]; then
  echo '[{"id":"TAB-1","name":"Claude Code","tty":"\\\\\\\\/dev\\\\\\\\/ttys042"},{"id":"TAB-2","name":"Real title","tty":"\\\\\\\\/dev\\\\\\\\/ttys043"}]'
elif [ "$4" = TAB-2 ]; then
  echo '{"status":"waiting","detail":"needs you","background_tasks":2}'
else
  echo '{"status":"nonsense"}'
fi
`,
  );
  chmodSync(it2, 0o755);
  const live = (tty: string | null, session: string) => ({
    pid: 1,
    session,
    cwd: '/x',
    name: null,
    tty,
    status: 'idle',
    statusAt: null,
    startedAt: null,
  });
  const found = await itermSource(it2).statuses([
    live('ttys043', 's-two'),
    live('ttys042', 's-one'),
    live(null, 's-none'),
    live('ttys999', 's-missing'),
  ]);
  assert.deepEqual([...found.keys()], ['s-two']);
  assert.deepEqual(found.get('s-two'), {
    status: 'waiting',
    detail: 'needs you',
    tasks: 2,
    title: 'Real title',
  });
  assert.equal(findIt2(it2), it2);
  assert.equal(
    findIt2(path.join(dir, 'nope')) === null || typeof findIt2(path.join(dir, 'nope')) === 'string',
    true,
  );
  assert.equal(pickSource('iterm', it2).source.name, 'iterm');
  assert.equal(pickSource('registry', it2).source, registrySource);
  const missing = pickSource('iterm', path.join(dir, 'nope'));
  if (findIt2(null) === null) {
    assert.equal(missing.source, registrySource);
    assert.match(missing.warning as string, /it2/);
  }
});

/** A bridge whose settings point at an empty registry folder, so the real ~/.claude is never read. */
async function boardBridge() {
  const home = tmp('board-bridge');
  const sessions = tmp('board-sessions');
  registry(sessions, process.pid, { status: 'busy' }, procStartOf(process.pid));
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_status_source: 'registry',
  });
  const bridge = await startBridge({ home });
  open.push(bridge);
  return { home, bridge };
}

test('the board page and its key: the board routes only, the other pages’ links, nothing else', async () => {
  const { bridge } = await boardBridge();
  const withKey = (key: string, route: string) =>
    bridge.call('GET', route, undefined, { Authorization: `Bearer ${key}` });
  const key = boardKey(TOKEN);
  const answer = await withKey(key, '/api/board');
  assert.equal(answer.status, 200);
  const data = answer.body as BoardData;
  assert.equal(data.status_source, 'registry');
  assert.equal(data.lanes[0].cards[0].column, 'working');
  assert.equal((await bridge.call('GET', '/api/board')).status, 200, 'the token reaches it too');

  for (const route of ['/api/board/link', '/api/stories', '/api/prefs']) {
    assert.equal((await withKey(key, route)).status, 403, route);
  }
  // the board's key is handed out to the bridge's token alone (the extension, the CLI), and to no other key
  const withToken = await bridge.call<{ url: string }>('GET', '/api/board/link');
  assert.equal(withToken.body.url, `${bridge.base}/board/#key=${key}`);
  for (const route of ['/api/board/link', '/api/board/link?public=1']) {
    const got = await withKey(pageKey(TOKEN, 'x'), route);
    assert.ok(!got.text.includes(key), `${route} leaks no board key`);
  }
  for (const [method, route] of [
    ['POST', '/api/board/type'],
    ['POST', '/api/board/focus'],
    ['POST', '/api/board/voice/pause'],
    ['POST', '/api/board/voice/phone'],
    ['POST', '/api/board/voice/phone/bridge-stop'],
    ['POST', '/api/board/stop-listening'],
    ['POST', '/api/board/agent/finish'],
  ] as const) {
    assert.equal(
      (await bridge.call(method, route, {}, { Authorization: `Bearer ${pageKey(TOKEN, 'x')}` }))
        .status,
      403,
      `${route} is the board's`,
    );
  }
  assert.equal((await withKey(pageKey(TOKEN, 'x'), '/api/board')).status, 403);
  assert.equal((await withKey(`${key}x`, '/api/board')).status, 403);
  assert.equal(
    (await bridge.call('POST', '/api/board', {}, { Authorization: `Bearer ${key}` })).status,
    403,
  );
  // the page carries no key
  const page = await fetch(`${bridge.base}/board/`);
  assert.equal(page.status, 200);
  assert.ok(!(await page.text()).includes(key));
  assert.equal((await fetch(`${bridge.base}/assets/board.ts`)).status, 200);
});

test('`once-upon board` prints the board link', async () => {
  const home = tmp('board-cli');
  const sessions = tmp('board-sessions');
  mkdirSync(sessions, { recursive: true });
  writeJson(path.join(home, 'config.json'), {
    port: 48998,
    token: TOKEN,
    board_sessions_dir: sessions,
    board_status_source: 'registry',
  });
  const ran = await runCli(home, ['board', '--no-open']);
  assert.equal(ran.code, 0);
  assert.equal(ran.stdout.trim(), `https://once-upon.test/board/#key=${boardKey(TOKEN)}`);
  assert.match(ran.stderr, /0 cards/);
  const local = await runCli(home, ['board', '--no-open', '--local']);
  assert.equal(local.stdout.trim(), `http://127.0.0.1:48998/board/#key=${boardKey(TOKEN)}`);
  // the name is a setting, and "none" goes back to the bridge's own address
  writeJson(path.join(home, 'config.json'), {
    port: 48998,
    token: TOKEN,
    board_sessions_dir: sessions,
    board_status_source: 'registry',
    allowed_hosts: ['board.example.test', 'once-upon.test'],
    public_host: 'board.example.test',
  });
  assert.match(
    (await runCli(home, ['board', '--no-open'])).stdout,
    /^https:\/\/board\.example\.test\/board\//,
  );
  writeJson(path.join(home, 'config.json'), { port: 48998, token: TOKEN, public_host: 'none' });
  assert.match(
    (await runCli(home, ['board', '--no-open'])).stdout,
    /^http:\/\/127\.0\.0\.1:48998\/board\//,
  );
});

test('the bridge lists built PR stories apart from local stories, and a PR story can be marked reviewed', async () => {
  const home = tmp('board-stories');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  prStory(home, 'acme-gadgets-3', 'acme/gadgets', 3);
  writeJson(path.join(home, 'local-x', 'meta.json'), {
    kind: 'local',
    repo_path: '/x',
    base: 'a',
    head: 'b',
  });
  writeJson(path.join(home, 'local-x', 'chapters.json'), { title: 'Local', chapters: [] });
  const bridge = await startBridge({ home });
  open.push(bridge);

  const list = storyList(bridge);
  const link = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}/files`;
  assert.deepEqual(
    list.stories
      .map((story) => [
        story.id,
        story.repo,
        story.number,
        story.title,
        story.url,
        story.reviewed_at,
      ])
      .sort(),
    [
      ['acme-gadgets-3', 'acme/gadgets', 3, 'Story 3', link('acme/gadgets', 3), null],
      ['acme-widgets-7', 'acme/widgets', 7, 'Story 7', link('acme/widgets', 7), null],
    ],
    'a local story is not a PR story',
  );
  // it has its own list
  assert.deepEqual(
    list.local_stories.map((story) => [story.id, story.repo, story.repo_name, story.title]),
    [['local-x', null, 'x', 'Local']],
  );

  assert.ok(markReviewed(bridge, 'acme-widgets-7')?.reviewed_at);
  markReviewed(bridge, 'acme-widgets-7', false);
  assert.equal(
    storyList(bridge).stories.find((story) => story.id === 'acme-widgets-7')?.reviewed_at,
    null,
  );
  for (const id of ['nope', '../x']) {
    assert.equal(markReviewed(bridge, id), null, id);
  }
});

// ---------- the bridge marks a PR story reviewed when GitHub says you have

/** The PR as GitHub's GraphQL answers it: who reviewed (each with an approval at REVIEWED_AT), and each file's Viewed state. */
const REVIEWED_AT = '2026-10-26T12:00:00Z';
const prAnswer = (
  reviewers: string[],
  states: string[],
  merged = false,
  {
    state = 'OPEN',
    headRef = { id: 'ref1' } as { id: string } | null,
    reviews = reviewers.map((login) => ({
      state: 'APPROVED',
      body: '',
      submittedAt: REVIEWED_AT,
      author: { login },
    })) as unknown[],
  } = {},
) => ({
  data: {
    viewer: { login: 'octocat' },
    repository: {
      pullRequest: {
        merged,
        state,
        headRef,
        reviews: { nodes: reviews },
        files: {
          totalCount: states.length,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: states.map((viewerViewedState) => ({ viewerViewedState })),
        },
      },
    },
  },
});

test('the PR check reads your review and your Viewed marks through gh', async () => {
  const fake = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'fixtures',
    'fake-gh-pr-check.ts',
  );
  chmodSync(fake, 0o755);
  const json = path.join(tmp('pr-check'), 'answer.json');
  const saved = { gh: process.env.ONCE_UPON_GH, json: process.env.FAKE_GH_PR_JSON };
  process.env.ONCE_UPON_GH = fake;
  process.env.FAKE_GH_PR_JSON = json;
  try {
    const withoutInfo = async (repo: string, number: number) => {
      const { info: _info, ...rest } = await ghPrCheck(repo, number);
      return rest;
    };
    const answers: [string[], string[], string | null, boolean][] = [
      [['someone'], ['VIEWED', 'UNVIEWED'], null, false],
      [['someone', 'OctoCat'], ['UNVIEWED'], 'review', false],
      [[], ['VIEWED', 'VIEWED'], 'all viewed', true],
      [[], ['VIEWED', 'DISMISSED'], null, false],
      [[], [], null, false],
      // a review and every file Viewed: the check says both, and the story's build time picks
      [['octocat'], ['VIEWED'], 'review', true],
    ];
    for (const [reviewers, states, expected, viewed] of answers) {
      writeJson(json, prAnswer(reviewers, states));
      assert.deepEqual(
        await withoutInfo('acme/widgets', 7),
        {
          merged: false,
          why: expected,
          reviewed_at: expected === 'review' ? REVIEWED_AT : null,
          viewed,
        },
        JSON.stringify(states),
      );
    }
    // a COMMENTED review with no body is a reply in a thread, which isn't a review; one with a body is
    const review = (state: string, body: string, submittedAt: string, login = 'OctoCat') => ({
      state,
      body,
      submittedAt,
      author: { login },
    });
    const reviewedAt = async (reviews: unknown[]) => {
      writeJson(json, prAnswer([], ['UNVIEWED'], false, { reviews }));
      return (await ghPrCheck('acme/widgets', 7)).reviewed_at;
    };
    assert.equal(await reviewedAt([review('COMMENTED', '', '2026-10-26T13:00:00Z')]), null);
    assert.equal(await reviewedAt([review('COMMENTED', '  \n', '2026-10-26T13:00:00Z')]), null);
    assert.equal(
      await reviewedAt([
        review('APPROVED', '', '2026-10-26T10:00:00Z'),
        review('COMMENTED', '', '2026-10-26T13:00:00Z'),
        review('COMMENTED', 'one nit', '2026-10-26T11:00:00Z'),
        review('CHANGES_REQUESTED', 'no', '2026-10-26T15:00:00Z', 'someone'),
      ]),
      '2026-10-26T11:00:00Z',
      'the latest review of yours that counts',
    );
    writeJson(json, prAnswer(['octocat'], ['VIEWED'], true));
    assert.deepEqual(await withoutInfo('acme/widgets', 7), { merged: true, why: null });
    // closed: the branch decides (a deleted fork's branch is gone too)
    writeJson(json, prAnswer([], [], false, { state: 'CLOSED' }));
    assert.deepEqual(await withoutInfo('acme/widgets', 7), {
      merged: false,
      why: null,
      reviewed_at: null,
      viewed: false,
    });
    writeJson(json, prAnswer([], [], false, { state: 'CLOSED', headRef: null }));
    assert.deepEqual(await withoutInfo('acme/widgets', 7), {
      merged: false,
      abandoned: true,
      why: null,
    });
    writeJson(json, prAnswer([], [], false, { headRef: null }));
    assert.deepEqual(
      await withoutInfo('acme/widgets', 7),
      { merged: false, why: null, reviewed_at: null, viewed: false },
      'open stays',
    );
    writeJson(json, { errors: [{ message: 'Could not resolve' }] });
    await assert.rejects(ghPrCheck('acme/widgets', 7), /Could not resolve/);
  } finally {
    for (const [key, value] of [
      ['ONCE_UPON_GH', saved.gh],
      ['FAKE_GH_PR_JSON', saved.json],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('a PR story you reviewed or finished Viewing is marked reviewed, with why; a manual unmark sticks', async () => {
  const home = tmp('board-auto');
  for (const [id, number] of [
    ['acme-widgets-1', 1],
    ['acme-widgets-2', 2],
    ['acme-widgets-3', 3],
    ['acme-widgets-4', 4],
  ] as const) {
    prStory(home, id, 'acme/widgets', number);
  }
  const asked: number[] = [];
  const why: Record<number, 'review' | 'all viewed' | null> = {
    1: 'review',
    2: 'all viewed',
    3: null,
    4: 'review',
  };
  const bridge = await startBridge({
    home,
    checkPr: async (_repo, number) => {
      asked.push(number);
      return { merged: false, why: why[number] };
    },
  });
  open.push(bridge);
  const stories = async () =>
    Object.fromEntries(
      storyList(bridge).stories.map((story) => [
        story.number,
        [!!story.reviewed_at, story.reviewed_by],
      ]),
    );

  // 4 is unmarked by hand before GitHub is asked: that decision stays
  markReviewed(bridge, 'acme-widgets-4', false);
  assert.deepEqual((await stories())[1], [false, null], 'the poll answers before GitHub does');
  await bridge.server.autoReview.idle();
  assert.deepEqual(await stories(), {
    1: [true, 'review'],
    2: [true, 'all viewed'],
    3: [false, null],
    4: [false, null],
  });
  assert.deepEqual(asked.sort(), [1, 2, 3, 4], 'every listed PR is asked about once');

  // polls inside the cache window don't ask again
  await stories();
  await bridge.server.autoReview.idle();
  assert.equal(asked.length, 4);

  // a manual unmark of an auto-marked story sticks, and a manual mark says so
  markReviewed(bridge, 'acme-widgets-1', false);
  markReviewed(bridge, 'acme-widgets-3');
  await stories();
  await bridge.server.autoReview.idle();
  assert.deepEqual(await stories(), {
    1: [false, null],
    2: [true, 'all viewed'],
    3: [true, 'manual'],
    4: [false, null],
  });
});

test('a PR story whose PR has merged, or closed with its branch deleted, leaves the story list and the board count; a closed one with its branch stays', async () => {
  const home = tmp('board-merged');
  for (const number of [1, 2, 3, 4]) {
    prStory(home, `acme-widgets-${number}`, 'acme/widgets', number);
  }
  writeJson(path.join(home, 'state', 'acme-widgets-2', 'reviewed.json'), {
    at: NOW.toISOString(),
    by: 'manual',
  });
  const merged = new Set([1, 2]);
  const bridge = await startBridge({
    home,
    // 3 is closed with its branch still there, 4 closed with the branch deleted
    checkPr: async (_repo, number) => ({
      merged: merged.has(number),
      abandoned: number === 4,
      why: null,
    }),
  });
  open.push(bridge);
  const ids = async () => {
    const list = storyList(bridge);
    return [
      list.stories.map((story) => story.id).sort(),
      list.stories.filter((story) => !story.reviewed_at).length,
    ];
  };
  assert.deepEqual(await ids(), [
    ['acme-widgets-1', 'acme-widgets-2', 'acme-widgets-3', 'acme-widgets-4'],
    3,
  ]);
  await bridge.server.autoReview.idle();
  assert.deepEqual(await ids(), [['acme-widgets-3'], 1]);
});

/** Runs `body` with gh faked: its answer is `answer.json` in `dir`, and each call's arguments go to `calls.log`. */
async function withFakeGh(
  dir: string,
  body: (io: { answer: string; calls: () => string[][] }) => Promise<void>,
) {
  const fake = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'fixtures',
    'fake-gh-pr-check.ts',
  );
  chmodSync(fake, 0o755);
  const answer = path.join(dir, 'answer.json');
  const log = path.join(dir, 'calls.log');
  const names = ['ONCE_UPON_GH', 'FAKE_GH_PR_JSON', 'FAKE_GH_LOG'] as const;
  const saved = names.map((name) => process.env[name]);
  process.env.ONCE_UPON_GH = fake;
  process.env.FAKE_GH_PR_JSON = answer;
  process.env.FAKE_GH_LOG = log;
  try {
    await body({
      answer,
      calls: () =>
        existsSync(log)
          ? readFileSync(log, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [],
    });
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[index];
      }
    });
  }
}

test('the board: someone else’s draft comes onto the board once it is marked ready, and goes off again as a draft', async () => {
  const home = tmp('board-draft-home');
  const quiet = tmp('board-draft-quiet');
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: path.join(quiet, 'ledger.md'),
    board_progress_file: path.join(quiet, 'progress.md'),
    board_sessions_dir: quiet,
  });
  prStory(home, 'acme-widgets-30', 'acme/widgets', 30, 'feat/their-draft');
  const infos = [
    prInfo(30, { author: 'someone', mine: false, review_requested: true, draft: true }),
  ];
  const { watcher } = fakeWatcher(infos, {}, [{ repo: 'acme/widgets', number: 30 }]);
  // each look is an hour on, past the board's kept answer
  let clock = NOW.getTime();
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => new Date(clock),
  });
  const columnOfPr = async () =>
    (clock += 3600000) &&
    (await board.snapshot()).lanes
      .flatMap((lane) => lane.cards)
      .find((found) => found.id === 'pr:acme/widgets#30')?.column;
  assert.equal(await columnOfPr(), undefined, 'a draft with a story: not on the board');
  infos[0] = { ...infos[0], draft: false };
  assert.equal(await columnOfPr(), 'back', 'marked ready: GitHub is waiting on your review');
  infos[0] = { ...infos[0], draft: true };
  assert.equal(await columnOfPr(), undefined, 'converted back to a draft: gone again');
});

test('a story is marked reviewed only by a review you submitted after it was built', async () => {
  const home = tmp('board-built');
  prStory(home, 'acme-widgets-1', 'acme/widgets', 1);
  prStory(home, 'acme-widgets-2', 'acme/widgets', 2);
  // 1: reviewed before the story was built, 2: after (stories are built now)
  const facts = new Map<number, { reviewed_at: string | null; viewed: boolean }>([
    [1, { reviewed_at: '2020-01-01T00:00:00Z', viewed: false }],
    [2, { reviewed_at: '2099-01-01T00:00:00Z', viewed: false }],
  ]);
  const bridge = await startBridge({
    home,
    checkPr: async (_repo, number) => ({
      merged: false,
      why: 'review',
      ...facts.get(number),
    }),
  });
  open.push(bridge);
  const list = async () => storyList(bridge);
  const marks = async () => {
    storyList(bridge);
    await bridge.server.autoReview.idle();
    return Object.fromEntries(
      (await list()).stories.map((story) => [story.number, story.reviewed_by]),
    );
  };
  assert.deepEqual(await marks(), { 1: null, 2: 'review' });
});

test('an older review does not stop every file Viewed from marking the story, and no review at all marks nothing', async () => {
  const home = tmp('board-built-viewed');
  prStory(home, 'acme-widgets-1', 'acme/widgets', 1);
  prStory(home, 'acme-widgets-2', 'acme/widgets', 2);
  const bridge = await startBridge({
    home,
    checkPr: async (_repo, number) => ({
      merged: false,
      why: 'review',
      reviewed_at: number === 1 ? '2020-01-01T00:00:00Z' : null,
      viewed: number === 1,
    }),
  });
  open.push(bridge);
  storyList(bridge);
  await bridge.server.autoReview.idle();
  const stories = storyList(bridge).stories;
  assert.deepEqual(Object.fromEntries(stories.map((story) => [story.number, story.reviewed_by])), {
    1: 'all viewed',
    2: null,
  });
});

test('the board and the story list share one check per PR, in either order, and the answer reaches every story of the PR', async () => {
  const home = tmp('board-shared');
  prStory(home, 'acme-widgets-1', 'acme/widgets', 1);
  prStory(home, 'acme-widgets-1-again', 'acme/widgets', 1);
  prStory(home, 'acme-widgets-2', 'acme/widgets', 2);
  const asked: number[] = [];
  const bridge = await startBridge({
    home,
    checkPr: async (_repo, number) => {
      asked.push(number);
      return {
        merged: number === 2,
        why: 'review',
        info: { number, state: number === 2 ? 'merged' : 'open' } as never,
      };
    },
  });
  open.push(bridge);
  const review = bridge.server.autoReview;
  const marks = async () => {
    const stories = storyList(bridge).stories;
    await review.idle();
    return stories.length;
  };

  // the board asks about 1 and 2 first: a story-list read in the same window neither asks again nor loses the answer
  review.kickInfo('acme/widgets', 1);
  review.kickInfo('acme/widgets', 2);
  assert.equal(await marks(), 3);
  assert.deepEqual(asked.sort(), [1, 2], 'one check per PR');
  const after = storyList(bridge).stories;
  assert.deepEqual(
    after.map((story) => [story.id, story.reviewed_by]).sort(),
    [
      ['acme-widgets-1', 'review'],
      ['acme-widgets-1-again', 'review'],
    ],
    'both stories of PR 1 are marked and the merged PR 2 is dropped, from the board’s check',
  );
  assert.equal(review.info('acme/widgets', 1)?.number, 1);
  assert.equal(review.info('acme/widgets', 2)?.state, 'merged');

  // the story list first, then the board in the same window
  const second = tmp('board-shared-2');
  prStory(second, 'acme-widgets-5', 'acme/widgets', 5);
  const asked5: number[] = [];
  const other = await startBridge({
    home: second,
    checkPr: async (_repo, number) => {
      asked5.push(number);
      return { merged: false, why: null, info: { number } as never };
    },
  });
  open.push(other);
  storyList(other);
  other.server.autoReview.kickInfo('acme/widgets', 5);
  await other.server.autoReview.idle();
  assert.deepEqual(asked5, [5]);
  assert.equal(other.server.autoReview.info('acme/widgets', 5)?.number, 5);
});

test('the branch check keeps PRs from this repo, prefers an open one, and counts a merged one only when the local branch contains its head', async () => {
  const { repo: checkout } = localRepo(); // branch "feature": base, change one, add two
  const [tip, behind] = git(checkout, 'rev-list', '--max-count=2', 'HEAD').split('\n');
  git(checkout, 'switch', '-q', '-c', 'elsewhere', 'HEAD~2');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'not on feature');
  const stray = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'switch', '-q', 'feature');
  const node = (
    number: number,
    oid: string,
    nameWithOwner: string | null,
    mergedAt: string | null = null,
  ) => ({
    number,
    mergedAt,
    headRefOid: oid,
    headRepository: nameWithOwner ? { nameWithOwner } : null,
  });
  await withFakeGh(tmp('branch-check'), async ({ answer, calls }) => {
    const ask = async (opened: unknown[], merged: unknown[]) => {
      writeJson(answer, {
        data: { repository: { open: { nodes: opened }, merged: { nodes: merged } } },
      });
      return ghBranchCheck('Acme/Widgets', 'feature', checkout);
    };
    const mine = 'acme/widgets';
    assert.deepEqual(
      await ask([node(5, tip, mine)], [node(3, behind, mine, '2026-10-01T00:00:00Z')]),
      {
        number: 5,
        state: 'open',
        merged_at: null,
      },
    );
    // a PR from a fork with the same branch name is not this checkout's
    assert.deepEqual(
      await ask(
        [node(6, tip, 'fork/widgets'), node(7, tip, null)],
        [node(3, behind, mine, '2026-10-01T00:00:00Z')],
      ),
      { number: 3, state: 'merged', merged_at: '2026-10-01T00:00:00Z', head_oid: behind },
    );
    assert.equal(await ask([], [node(3, behind, 'fork/widgets', '2026-10-01T00:00:00Z')]), null);
    // merged: its head is the tip, or behind it: the latest such one; a head the branch doesn't have is an old PR of a reused name
    assert.deepEqual(
      await ask(
        [],
        [
          node(2, behind, mine, '2026-10-01T00:00:00Z'),
          node(4, tip, mine, '2026-10-03T00:00:00Z'),
          node(9, stray, mine, '2026-10-09T00:00:00Z'),
        ],
      ),
      { number: 4, state: 'merged', merged_at: '2026-10-03T00:00:00Z', head_oid: tip },
    );
    assert.equal(await ask([], [node(9, stray, mine, '2026-10-09T00:00:00Z')]), null);
    assert.equal(
      await ask([], [node(9, '0'.repeat(40), mine, '2026-10-09T00:00:00Z')]),
      null,
      'a head commit this checkout has never seen',
    );
    // a commit a story is at counts without the local branch having it: a squash merge whose branch was deleted after
    // (`gh pr merge --delete-branch`), where git can't say the branch contains anything
    writeJson(answer, {
      data: {
        repository: {
          open: { nodes: [] },
          merged: { nodes: [node(11, stray, mine, '2026-10-11T00:00:00Z')] },
        },
      },
    });
    assert.deepEqual(await ghBranchCheck('Acme/Widgets', 'deleted-branch', checkout, [stray]), {
      number: 11,
      state: 'merged',
      merged_at: '2026-10-11T00:00:00Z',
      head_oid: stray,
      shipped: [stray],
    });
    // GitHub added a commit after the approval: the PR's last commit is not a story head, but the approved head is among
    // its commits, so the merged PR is the story's (an older PR of a reused name has none of the story's heads)
    writeJson(answer, {
      data: {
        repository: {
          open: { nodes: [] },
          merged: {
            nodes: [
              {
                ...node(12, '1'.repeat(40), mine, '2026-10-12T00:00:00Z'),
                commits: {
                  nodes: [{ commit: { oid: '2'.repeat(40) } }, { commit: { oid: stray } }],
                },
              },
            ],
          },
        },
      },
    });
    assert.deepEqual(await ghBranchCheck('Acme/Widgets', 'deleted-branch', checkout, [stray]), {
      number: 12,
      state: 'merged',
      merged_at: '2026-10-12T00:00:00Z',
      head_oid: '1'.repeat(40),
      shipped: [stray],
    });
    assert.equal(
      await ghBranchCheck('Acme/Widgets', 'deleted-branch', checkout, ['3'.repeat(40)]),
      null,
      'none of the story’s heads is in the PR',
    );
    assert.equal(
      await ghBranchCheck('Acme/Widgets', 'deleted-branch', checkout),
      null,
      'with no head named, a branch that is gone proves nothing',
    );
    // open and merged are asked for separately, up to 100 each, with the head repository and commit
    const query = calls()[0].find((arg) => arg.startsWith('query=')) as string;
    assert.match(query, /open:pullRequests\(headRefName:\$branch,first:100,states:\[OPEN\]/);
    assert.match(query, /merged:pullRequests\(headRefName:\$branch,first:100,states:\[MERGED\]/);
    assert.match(query, /headRefOid headRepository\{nameWithOwner\}/);
    assert.match(query, /commits\(last:20\)/);
  });
});

test('the board’s PR search: requests made of you by name and your own open PRs, each once; PrInfo.review_requested by name too', async () => {
  await withFakeGh(tmp('requested'), async ({ answer, calls }) => {
    writeJson(answer, {
      data: {
        requested: {
          nodes: [{ number: 4, repository: { nameWithOwner: 'acme/widgets' } }, {}],
        },
        mine: {
          nodes: [
            { number: 3071, repository: { nameWithOwner: 'acme/furnace' } },
            { number: 4, repository: { nameWithOwner: 'Acme/Widgets' } },
          ],
        },
      },
    });
    assert.deepEqual(await ghRequestedCheck(), [
      { repo: 'acme/widgets', number: 4 },
      { repo: 'acme/furnace', number: 3071 },
    ]);
    const query = calls()[0].find((arg) => arg.startsWith('query=')) as string;
    assert.match(query, /user-review-requested:@me/);
    assert.match(query, /is:pr is:open author:@me/);
    assert.doesNotMatch(query.replace('user-review-requested:@me', ''), /review-requested:@me/);

    // a request to a team reads as no User login, so it is not yours
    const pr = prAnswer([], ['UNVIEWED']);
    const node = pr.data.repository.pullRequest as Record<string, unknown>;
    node.reviewRequests = {
      nodes: [{ requestedReviewer: {} }, { requestedReviewer: { login: 'someone' } }],
    };
    writeJson(answer, pr);
    assert.equal((await ghPrCheck('acme/widgets', 7)).info?.review_requested, false);
    const asked = calls()
      .at(-1)
      ?.find((arg) => arg.startsWith('query=')) as string;
    assert.match(
      asked,
      /reviewRequests\(first:30\)\{nodes\{requestedReviewer\{\.\.\. on User\{login\}\}\}\}/,
    );
    node.reviewRequests = { nodes: [{ requestedReviewer: { login: 'OctoCat' } }] };
    writeJson(answer, pr);
    assert.equal((await ghPrCheck('acme/widgets', 7)).info?.review_requested, true);
  });
});

test('the PR check reads what the board shows: approvals, checks, mergeable, and who commented after whom', async () => {
  const fake = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'fixtures',
    'fake-gh-pr-check.ts',
  );
  chmodSync(fake, 0o755);
  const json = path.join(tmp('pr-info'), 'answer.json');
  const saved = { gh: process.env.ONCE_UPON_GH, json: process.env.FAKE_GH_PR_JSON };
  process.env.ONCE_UPON_GH = fake;
  process.env.FAKE_GH_PR_JSON = json;
  const rules = path.join(path.dirname(json), 'rules.json');
  writeJson(rules, [
    { type: 'deletion' },
    { type: 'pull_request', parameters: { required_approving_review_count: 3 } },
  ]);
  process.env.FAKE_GH_RULES_JSON = rules;
  try {
    const person = (login: string, type = 'User') => ({ login, __typename: type });
    writeJson(json, {
      data: {
        viewer: { login: 'Octocat' },
        repository: {
          pullRequest: {
            number: 7,
            url: 'https://github.com/acme/widgets/pull/7',
            title: 'Seven',
            merged: false,
            mergedAt: null,
            state: 'OPEN',
            isDraft: true,
            headRefName: 'feat/seven',
            headRef: { id: 'ref1' },
            author: { login: 'OctoCat' },
            reviewRequests: {
              nodes: [{ requestedReviewer: { login: 'OCTOCAT' } }, { requestedReviewer: {} }],
            },
            mergeStateStatus: 'BLOCKED',
            baseRefName: 'rules-base',
            reviewDecision: 'REVIEW_REQUIRED',
            baseRef: { branchProtectionRule: null, refUpdateRule: null },
            latestOpinionatedReviews: {
              nodes: [
                { state: 'APPROVED', author: { login: 'one' } },
                { state: 'COMMENTED', author: { login: 'two' } },
              ],
            },
            reviews: {
              nodes: [
                { state: 'COMMENTED', submittedAt: '2026-10-26T10:00:00Z', author: person('two') },
                {
                  state: 'COMMENTED',
                  body: 'A note on the approach',
                  submittedAt: '2026-10-26T12:00:00Z',
                  author: person('octocat'),
                },
              ],
            },
            reviewThreads: {
              nodes: [
                {
                  isResolved: false,
                  comments: {
                    nodes: [
                      { createdAt: '2026-10-26T13:00:00Z', author: person('two') },
                      { createdAt: '2026-10-26T14:00:00Z', author: person('one') },
                    ],
                  },
                },
                { isResolved: true, comments: { nodes: [] } },
              ],
            },
            comments: {
              nodes: [
                { createdAt: '2026-10-26T16:00:00Z', author: person('snyk', 'Bot') },
                { createdAt: '2026-10-26T11:00:00Z', author: person('OCTOCAT') },
              ],
            },
            commits: {
              nodes: [
                {
                  commit: {
                    committedDate: '2026-10-26T09:00:00Z',
                    author: { user: { login: 'someone' } },
                    statusCheckRollup: { state: 'FAILURE' },
                  },
                },
              ],
            },
            files: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ viewerViewedState: 'UNVIEWED' }],
            },
          },
        },
      },
    });
    // you reviewed, so the story counts as reviewed too (why: review), and the details come with it
    const { info, why } = await ghPrCheck('acme/widgets', 7);
    assert.equal(why, 'review');
    assert.deepEqual(info, {
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
      title: 'Seven',
      state: 'open',
      draft: true,
      branch: 'feat/seven',
      author: 'OctoCat',
      mine: true,
      review_requested: true,
      approvals: 1,
      required: 3, // from the base branch's ruleset, since protection says nothing
      review: 'review_required',
      checks: 'failure',
      merge: { ready: false, text: 'needs 2 more approvals', tone: 'warn' },
      merged_at: null,
      unresolved: 1,
      viewer_at: '2026-10-26T12:00:00.000Z'.replace('.000', ''),
      others_at: '2026-10-26T14:00:00Z',
    });
  } finally {
    for (const [name, value] of [
      ['ONCE_UPON_GH', saved.gh],
      ['FAKE_GH_PR_JSON', saved.json],
      ['FAKE_GH_RULES_JSON', undefined],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test('what blocks the merge button, in one plain line', () => {
  const base = { approvals: 0, required: null, review: null, checks: null, unresolved: 0 } as const;
  const say = (status: string, extra: Partial<Parameters<typeof mergeSummary>[0]> = {}) =>
    mergeSummary({ ...base, status, ...extra })?.text;
  assert.equal(say('CLEAN'), 'ready to merge');
  assert.equal(say('HAS_HOOKS'), 'ready to merge');
  assert.equal(say('UNSTABLE'), 'ready to merge (optional checks failing)');
  assert.equal(mergeSummary({ ...base, status: 'UNSTABLE' })?.ready, true);
  assert.equal(say('DRAFT'), 'draft');
  assert.equal(say('DIRTY'), 'conflicts');
  assert.equal(say('BEHIND'), 'behind base');
  assert.equal(say('BLOCKED', { approvals: 1, required: 2 }), 'needs 1 more approval');
  assert.equal(say('BLOCKED', { approvals: 1, required: 3 }), 'needs 2 more approvals');
  assert.equal(
    say('BLOCKED', { approvals: 2, required: 2, review: 'changes_requested' }),
    'changes requested',
  );
  assert.equal(say('BLOCKED', { approvals: 2, required: 2, checks: 'failure' }), 'checks failing');
  assert.equal(say('BLOCKED', { approvals: 2, required: 2, checks: 'pending' }), 'checks running');
  assert.equal(
    say('BLOCKED', { approvals: 2, required: 2, unresolved: 2 }),
    'open threads to resolve',
  );
  assert.equal(
    say('BLOCKED', { approvals: 0, required: null, review: 'review_required' }),
    'needs approval',
  );
  assert.equal(mergeSummary({ ...base, status: 'BLOCKED' })?.ready, false);
  assert.equal(mergeSummary({ ...base, status: 'UNKNOWN' }), null);
  assert.equal(mergeSummary({ ...base, status: undefined }), null);
});

type Who = { login: string; __typename?: string };
const user = (login: string): Who => ({ login, __typename: 'User' });
const comment = (when: string, author: Who, body = 'text') => ({ createdAt: when, author, body });
const thread = (resolved: boolean, comments: ReturnType<typeof comment>[]) => ({
  isResolved: resolved,
  opener: { nodes: comments.slice(0, 1) },
  comments: { nodes: comments.slice(-5) },
});

interface AskParts {
  /** who opened the PR (default octocat, the viewer: their own PR) */
  author?: string;
  reviews?: { state: string; submittedAt: string; author: Who }[];
  standing?: { state: string; author: { login: string } }[];
  threads?: ReturnType<typeof thread>[];
  issue?: ReturnType<typeof comment>[];
}

/**
 * Runs `body` with gh replaced by a fake that answers the PR query with what `ask` is given, as `octocat`. `ask` returns
 * the PR's others_at: when someone last asked something of the viewer.
 */
async function withFakePr(
  body: (ask: (parts: AskParts) => Promise<string | null | undefined>) => Promise<void>,
) {
  const fake = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'fixtures',
    'fake-gh-pr-check.ts',
  );
  chmodSync(fake, 0o755);
  const json = path.join(tmp('pr-action'), 'answer.json');
  const saved = { gh: process.env.ONCE_UPON_GH, json: process.env.FAKE_GH_PR_JSON };
  process.env.ONCE_UPON_GH = fake;
  process.env.FAKE_GH_PR_JSON = json;
  const ask = async (parts: AskParts) => {
    writeJson(json, {
      data: {
        viewer: { login: 'octocat' },
        repository: {
          pullRequest: {
            author: { login: parts.author ?? 'octocat' },
            merged: false,
            state: 'OPEN',
            headRef: { id: 'ref1' },
            latestOpinionatedReviews: { nodes: parts.standing || [] },
            reviews: { nodes: parts.reviews || [] },
            reviewThreads: { nodes: parts.threads || [] },
            comments: { nodes: parts.issue || [] },
            files: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ viewerViewedState: 'UNVIEWED' }],
            },
          },
        },
      },
    });
    return (await ghPrCheck('acme/widgets', 7)).info?.others_at;
  };
  try {
    await body(ask);
  } finally {
    for (const [name, value] of [
      ['ONCE_UPON_GH', saved.gh],
      ['FAKE_GH_PR_JSON', saved.json],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test('Back to you on your own PR needs something asked of you: changes requested or an open thread, not bots or AI-review comments', async () =>
  withFakePr(async (ask) => {
    const marker = '<!-- claude-ai-review -->\nlooks fine';
    // #6970's case: only issue comments by scanners and the AI review, nothing asked of you
    assert.equal(
      await ask({
        issue: [
          comment('2026-10-26T17:10:00Z', user('snyk-io')),
          comment('2026-10-26T17:19:00Z', { login: 'cypress', __typename: 'Bot' }),
          comment('2026-10-26T17:28:00Z', user('blafev'), marker),
        ],
      }),
      null,
    );
    // a COMMENTED review asks nothing; a standing changes-requested one does
    const review = (state: string, when: string, login = 'other') => ({
      state,
      submittedAt: when,
      author: user(login),
    });
    assert.equal(await ask({ reviews: [review('COMMENTED', '2026-10-26T18:00:00Z')] }), null);
    assert.equal(
      await ask({
        reviews: [review('CHANGES_REQUESTED', '2026-10-26T18:00:00Z')],
        standing: [{ state: 'CHANGES_REQUESTED', author: { login: 'other' } }],
      }),
      '2026-10-26T18:00:00Z',
    );
    assert.equal(
      await ask({
        reviews: [review('CHANGES_REQUESTED', '2026-10-26T18:00:00Z')],
        standing: [{ state: 'APPROVED', author: { login: 'other' } }],
      }),
      null,
      'they approved afterwards',
    );
    // open threads: the newest comment that counts decides, and it has to be a person's
    const them = user('other');
    const open = (comments: ReturnType<typeof comment>[], resolved = false) =>
      ask({ threads: [thread(resolved, comments)] });
    assert.equal(await open([comment('2026-10-26T13:00:00Z', them)]), '2026-10-26T13:00:00Z');
    assert.equal(await open([comment('2026-10-26T13:00:00Z', them)], true), null, 'resolved');
    assert.equal(
      await open([
        comment('2026-10-26T13:00:00Z', them),
        comment('2026-10-26T14:00:00Z', user('Octocat')),
      ]),
      null,
      'you answered last',
    );
    assert.equal(await open([comment('2026-10-26T13:00:00Z', user('github-actions'))]), null);
    assert.equal(await open([comment('2026-10-26T13:00:00Z', user('someone[bot]'))]), null);
    // the AI review counts only when its comment opened the thread
    assert.equal(
      await open([comment('2026-10-26T13:00:00Z', them, marker)]),
      '2026-10-26T13:00:00Z',
    );
    assert.equal(
      await open([
        comment('2026-10-26T13:00:00Z', user('Octocat')),
        comment('2026-10-26T14:00:00Z', them, marker),
      ]),
      null,
      'a marked reply does not open anything',
    );
    // a bot's or the AI review's reply after a person's request doesn't hide it
    assert.equal(
      await open([
        comment('2026-10-26T13:00:00Z', them),
        comment('2026-10-26T13:05:00Z', user('github-actions')),
        comment('2026-10-26T13:06:00Z', user('blafev'), marker),
        comment('2026-10-26T13:07:00Z', { login: 'coderabbit', __typename: 'Bot' }),
      ]),
      '2026-10-26T13:00:00Z',
    );
    assert.equal(
      await open([
        comment('2026-10-26T13:00:00Z', them),
        comment('2026-10-26T13:30:00Z', user('Octocat')),
        comment('2026-10-26T13:35:00Z', user('github-actions')),
      ]),
      null,
      'you answered, and only a bot spoke after',
    );
  }));

test('on someone else’s PR, Back to you is only an answer in a thread you are in: new third-party threads and others’ changes requested stay PR open', () =>
  withFakePr(async (ask) => {
    const them = user('luis');
    const bot = user('blafev'); // the AI review posts under a person's account
    const marker = '<!-- claude-ai-review -->\nlooks fine';
    const theirs = { author: 'luis' };
    // #6980's shape: Luis's PR, your two threads unanswered, and four new threads from the AI review aimed at the author
    const yours = [
      thread(false, [
        comment('2026-10-26T10:00:00Z', user('Octocat')),
        comment('2026-10-26T10:05:00Z', them),
      ]),
    ];
    const ours = thread(false, [comment('2026-10-26T10:00:00Z', user('octocat'))]);
    const newOnes = [1, 2, 3, 4].map((minute) =>
      thread(false, [comment(`2026-10-26T12:0${minute}:00Z`, bot, marker)]),
    );
    // your thread's last comment is the author's reply: that is an answer to you
    assert.equal(await ask({ ...theirs, threads: yours }), '2026-10-26T10:05:00Z');
    // your threads have nobody's answer, and four new threads aren't yours: nothing is asked of you
    assert.equal(await ask({ ...theirs, threads: [ours, ours, ...newOnes] }), null);
    // a new thread by a person you aren't in, and a reviewer's changes requested, are for the author
    assert.equal(
      await ask({
        ...theirs,
        threads: [ours, thread(false, [comment('2026-10-26T13:00:00Z', user('bobby'))])],
        reviews: [
          {
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-10-26T13:10:00Z',
            author: user('bobby'),
          },
        ],
        standing: [{ state: 'CHANGES_REQUESTED', author: { login: 'bobby' } }],
      }),
      null,
    );
    // a reply in a thread you started counts, from the author or from another reviewer, once a person has the last word
    const answered = thread(false, [
      comment('2026-10-26T10:00:00Z', user('octocat')),
      comment('2026-10-26T14:00:00Z', user('bobby')),
      comment('2026-10-26T14:05:00Z', { login: 'github-actions', __typename: 'Bot' }),
      comment('2026-10-26T14:06:00Z', bot, marker),
    ]);
    assert.equal(await ask({ ...theirs, threads: [answered, ...newOnes] }), '2026-10-26T14:00:00Z');
    // a thread you commented in but didn't open counts too, and you answering last, or it being resolved, takes it away
    const joined = (resolved: boolean, last: string) =>
      thread(resolved, [
        comment('2026-10-26T09:00:00Z', them),
        comment('2026-10-26T09:30:00Z', user('octocat')),
        comment('2026-10-26T15:00:00Z', last === 'me' ? user('octocat') : them),
      ]);
    assert.equal(
      await ask({ ...theirs, threads: [joined(false, 'them')] }),
      '2026-10-26T15:00:00Z',
    );
    assert.equal(await ask({ ...theirs, threads: [joined(false, 'me')] }), null);
    assert.equal(await ask({ ...theirs, threads: [joined(true, 'them')] }), null);
    // a PR with no author in the answer is not taken for yours
    assert.equal(await ask({ author: '', threads: [ours, ...newOnes] }), null);
  }));

test('on your own PR, anyone’s new thread, a standing changes requested and a reply all come back to you', () =>
  withFakePr(async (ask) => {
    const bot = user('blafev');
    const marker = '<!-- claude-ai-review -->\nlooks fine';
    // anyone's new thread, by a person
    assert.equal(
      await ask({ threads: [thread(false, [comment('2026-10-26T12:00:00Z', user('bobby'))])] }),
      '2026-10-26T12:00:00Z',
    );
    // a new thread the AI review opened, which counts when it opened the thread
    assert.equal(
      await ask({ threads: [thread(false, [comment('2026-10-26T12:30:00Z', bot, marker)])] }),
      '2026-10-26T12:30:00Z',
    );
    // another reviewer's standing changes requested
    assert.equal(
      await ask({
        reviews: [
          {
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-10-26T13:10:00Z',
            author: user('bobby'),
          },
        ],
        standing: [{ state: 'CHANGES_REQUESTED', author: { login: 'bobby' } }],
      }),
      '2026-10-26T13:10:00Z',
    );
    // a reply in a thread you were in, and the latest of all of them wins
    assert.equal(
      await ask({
        threads: [
          thread(false, [
            comment('2026-10-26T10:00:00Z', user('octocat')),
            comment('2026-10-26T16:00:00Z', user('bobby')),
          ]),
          thread(false, [comment('2026-10-26T12:00:00Z', user('bobby'))]),
        ],
      }),
      '2026-10-26T16:00:00Z',
    );
  }));

test('the required approvals are the strictest of branch protection and the rulesets, and the rules call asks for a full page', async () => {
  const dir = tmp('pr-required');
  const fake = path.join(dir, 'gh.mjs');
  // a gh that writes down the rules call's path, then answers it like fake-gh-pr-check.ts does
  writeFileSync(
    fake,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
if (process.argv[3]?.startsWith('repos/')) {
  appendFileSync(process.env.FAKE_GH_CALLS, process.argv[3] + '\\n');
  process.stdout.write(readFileSync(process.env.FAKE_GH_RULES_JSON, 'utf8'));
} else {
  process.stdout.write(readFileSync(process.env.FAKE_GH_PR_JSON, 'utf8'));
}
`,
  );
  chmodSync(fake, 0o755);
  const calls = path.join(dir, 'calls.txt');
  const rules = path.join(dir, 'rules.json');
  const json = path.join(dir, 'answer.json');
  const saved = { gh: process.env.ONCE_UPON_GH };
  Object.assign(process.env, {
    ONCE_UPON_GH: fake,
    FAKE_GH_CALLS: calls,
    FAKE_GH_RULES_JSON: rules,
    FAKE_GH_PR_JSON: json,
  });
  const required = async (protection: number | null, base: string) => {
    writeJson(json, {
      data: {
        viewer: { login: 'octocat' },
        repository: {
          pullRequest: {
            merged: false,
            state: 'OPEN',
            headRef: { id: 'ref1' },
            baseRefName: base,
            baseRef: {
              branchProtectionRule:
                protection === null ? null : { requiredApprovingReviewCount: protection },
              refUpdateRule: null,
            },
            reviews: { nodes: [] },
            files: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ viewerViewedState: 'UNVIEWED' }],
            },
          },
        },
      },
    });
    return (await ghPrCheck('acme/widgets', 7)).info?.required;
  };
  try {
    writeJson(rules, [
      { type: 'deletion' },
      { type: 'pull_request', parameters: { required_approving_review_count: 2 } },
    ]);
    assert.equal(await required(1, 'strict-rules'), 2, 'a stricter ruleset beats protection');
    assert.equal(
      await required(3, 'strict-protection'),
      3,
      'and a stricter protection beats the rules',
    );
    assert.equal(await required(null, 'rules-only'), 2);
    writeJson(rules, []);
    assert.equal(await required(1, 'protection-only'), 1);
    assert.equal(await required(null, 'neither'), null);
    assert.match(
      readFileSync(calls, 'utf8').split('\n')[0],
      /^repos\/acme\/widgets\/rules\/branches\/strict-rules\?per_page=100$/,
    );
  } finally {
    for (const name of ['FAKE_GH_CALLS', 'FAKE_GH_RULES_JSON', 'FAKE_GH_PR_JSON']) {
      delete process.env[name];
    }
    if (saved.gh === undefined) {
      delete process.env.ONCE_UPON_GH;
    } else {
      process.env.ONCE_UPON_GH = saved.gh;
    }
  }
});

test('the pulse says when a session has a request for the story, building or queued, so the panel can drop Update', async () => {
  const home = tmp('board-pulse');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const pulse = async () =>
    (
      await bridge.call<{ request: StoryRequest | null }>(
        'GET',
        '/api/stories/acme-widgets-7/pulse',
      )
    ).body.request;
  const ask = (extra: Record<string, unknown>) =>
    new Builds(home).save({
      'acme/widgets#7': {
        id: 'b1',
        repo: 'acme/widgets',
        number: 7,
        url: null,
        requested_at: '2026-10-26T18:00:00Z',
        status: 'pending',
        ...extra,
      },
    });
  assert.equal(await pulse(), null);
  ask({ mode: 'update', base_sha: 'abc' });
  assert.deepEqual(await pulse(), {
    kind: 'update',
    state: 'queued',
    requested_at: '2026-10-26T18:00:00Z',
    claimed_by: null,
    claimed_at: null,
  });
  const claimed = new Date().toISOString();
  ask({
    mode: 'rebuild',
    story: 'acme-widgets-7',
    claimed_by: 'session-a',
    claimed_at: claimed,
  });
  assert.deepEqual(await pulse(), {
    kind: 'rebuild',
    state: 'building',
    requested_at: '2026-10-26T18:00:00Z',
    claimed_by: 'session-a',
    claimed_at: claimed,
  });
  ask({ claimed_by: 'session-a', claimed_at: claimed });
  assert.equal((await pulse())?.kind, 'build');
  ask({ status: 'done', done_at: claimed });
  assert.equal(await pulse(), null, 'finished: Update can come back');
  // a fix request a session has taken counts too, and a taken one wins over a queued one
  writeJson(path.join(home, 'fixes.json'), {
    f1: {
      id: 'f1',
      story: 'acme-widgets-7',
      repo: 'acme/widgets',
      kind: 'github',
      notes: [],
      requested_at: '2026-10-26T18:05:00Z',
      status: 'pending',
      claimed_by: 'session-b',
      claimed_at: claimed,
    },
  });
  assert.deepEqual(
    [(await pulse())?.kind, (await pulse())?.state, (await pulse())?.claimed_by],
    ['fix', 'building', 'session-b'],
  );
});

test('a request belongs to its own story: PR #12’s fix is not #1’s, and another story’s rebuild is not this one’s', async () => {
  const home = tmp('board-pulse-scope');
  prStory(home, 'acme-widgets-1', 'acme/widgets', 1, 'feat/one');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/seven');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const pulse = async (id: string) =>
    (await bridge.call<{ request: StoryRequest | null }>('GET', `/api/stories/${id}/pulse`)).body
      .request;
  const fix = (number: number, url: string) => ({
    id: `f${number}`,
    story: `acme-widgets-${number}`,
    repo: 'acme/widgets',
    url,
    kind: 'github',
    notes: [],
    requested_at: '2026-10-26T18:05:00Z',
    status: 'pending',
  });
  writeJson(path.join(home, 'fixes.json'), {
    f12: fix(12, 'https://github.com/acme/widgets/pull/12'),
    f10: fix(10, 'https://github.com/acme/widgets/pull/10/files'),
  });
  assert.equal(await pulse('acme-widgets-1'), null, '#12 and #10 are not #1');
  writeJson(path.join(home, 'fixes.json'), {
    f1: { ...fix(7, 'https://github.com/acme/widgets/pull/1/files?w=1'), story: 'other-story' },
  });
  assert.equal((await pulse('acme-widgets-1'))?.kind, 'fix', 'the PR’s own number still matches');

  // a rebuild asked for another story of the PR doesn't show on this one
  new Builds(home).save({
    'acme/widgets#7': {
      id: 'b1',
      repo: 'acme/widgets',
      number: 7,
      url: null,
      requested_at: '2026-10-26T18:00:00Z',
      status: 'pending',
      mode: 'rebuild',
      story: 'acme-widgets-7-older',
    },
  });
  assert.equal(await pulse('acme-widgets-7'), null);
  new Builds(home).save({
    'acme/widgets#7': {
      id: 'b1',
      repo: 'acme/widgets',
      number: 7,
      url: null,
      requested_at: '2026-10-26T18:00:00Z',
      status: 'pending',
      mode: 'rebuild',
      story: 'acme-widgets-7',
    },
  });
  assert.equal((await pulse('acme-widgets-7'))?.kind, 'rebuild');
});

test('focusing a session: the tab is found by tty on the server, selected, and iTerm raised', async () => {
  const dir = tmp('board-focus');
  const log = path.join(dir, 'calls.txt');
  const it2 = path.join(dir, 'it2');
  writeFileSync(
    it2,
    `#!/bin/sh
echo "$@" >> '${log}'
if [ "$2" = list ]; then
  echo '[{"id":"TAB-1","tty":"\\\\\\\\/dev\\\\\\\\/ttys042"},{"id":"TAB-2","window_id":"win-2","tty":"\\\\\\\\/dev\\\\\\\\/ttys043"}]'
fi
`,
  );
  chmodSync(it2, 0o755);
  const raise = async () => {
    appendFileSync(log, 'raise\n');
  };
  assert.equal(await focusTab(it2, 'ttys043', raise), null);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
    'session list --json',
    'window focus win-2', // its window, then the tab in it, then iTerm over the other apps: never a new window
    'session focus TAB-2',
    'raise',
  ]);
  assert.match((await focusTab(it2, 'ttys999', raise)) as string, /no iTerm tab/);
  assert.match((await focusTab(it2, null, raise)) as string, /no terminal/);
  const failing = path.join(dir, 'it2-down');
  writeFileSync(failing, '#!/bin/sh\nexit 1\n');
  chmodSync(failing, 0o755);
  assert.match((await focusTab(failing, 'ttys043', raise)) as string, /did not answer/);
});

test('POST /api/board/focus takes the board key, a live session id and nothing else', async () => {
  const home = tmp('board-focus-route');
  const sessions = tmp('board-sessions');
  registry(sessions, process.pid, { status: 'busy' }, procStartOf(process.pid));
  const it2 = path.join(tmp('board-it2'), 'it2');
  writeFileSync(it2, '#!/bin/sh\nexit 0\n');
  chmodSync(it2, 0o755);
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: it2,
    board_status_source: 'iterm',
  });
  const bridge = await startBridge({ home });
  open.push(bridge);
  const post = (key: string, body: unknown) =>
    bridge.call('POST', '/api/board/focus', body, { Authorization: `Bearer ${key}` });
  const key = boardKey(TOKEN);
  assert.equal((await post(key, {})).status, 400);
  assert.equal((await post(key, { session: '../etc' })).status, 400);
  assert.equal((await post(key, { session: 'not-a-live-session' })).status, 404);
  // a live session whose process has no terminal (this test's) has no tab to raise
  assert.equal((await post(key, { session: fullId(process.pid) })).status, 409);
  // another page's key doesn't reach it
  assert.equal((await post(pageKey(TOKEN, 'x'), { session: fullId(process.pid) })).status, 403);
  // and with iTerm turned off in the settings there is nothing to do
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_status_source: 'registry',
  });
  assert.equal((await post(key, { session: fullId(process.pid) })).status, 409);
});

/** A request with a Host the test chooses (fetch won't let a script set it): status, body text and headers. */
function rawRequest(
  base: string,
  method: string,
  route: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: route,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode as number, text, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('the bridge answers a proxy’s allowed host names, keeps the key in an HttpOnly cookie, and nothing else gets in', async () => {
  const { bridge } = await boardBridge();
  const name = 'once-upon.test';
  const origin = `https://${name}`;
  const asHost = (headers: Record<string, string> = {}) => ({ Host: name, ...headers });
  const board = boardKey(TOKEN);

  // names that are not allowed are refused (DNS rebinding), exactly: no suffix or prefix tricks
  for (const bad of [
    'evil.test',
    'once-upon.test.evil.com',
    'xonce-upon.test',
    'once-upon.test:4823',
  ]) {
    assert.equal((await rawRequest(bridge.base, 'GET', '/board/', { Host: bad })).status, 421, bad);
  }
  assert.equal((await rawRequest(bridge.base, 'GET', '/board/', asHost())).status, 200);
  assert.equal(
    (await rawRequest(bridge.base, 'GET', '/board/', { Host: 'once-upon.fidev.net' })).status,
    200,
  );
  assert.equal(
    (await rawRequest(bridge.base, 'GET', '/board/', asHost({ Origin: 'https://evil.test' })))
      .status,
    403,
  );

  // no cookie, no key: refused
  assert.equal((await rawRequest(bridge.base, 'GET', '/api/board', asHost())).status, 401);

  // the page hands over its key: only the board's, only from that host's own page
  const start = (key: string, headers: Record<string, string>) =>
    rawRequest(bridge.base, 'POST', '/auth/session', headers, { key });
  assert.equal((await start(board, asHost())).status, 403, 'no Origin');
  assert.equal((await start(board, asHost({ Origin: 'https://evil.test' }))).status, 403);
  assert.equal(
    (await start(TOKEN, asHost({ Origin: origin }))).status,
    403,
    'the bridge token is not a page key',
  );
  assert.equal(
    (await start(pageKey(TOKEN, 'x'), asHost({ Origin: origin }))).status,
    403,
    'nor is a story’s',
  );
  assert.equal((await start('page.wrong', asHost({ Origin: origin }))).status, 403);
  const set = await start(board, asHost({ Origin: origin }));
  assert.equal(set.status, 200);
  const cookie = [set.headers['set-cookie']].flat()[0] as string;
  assert.match(cookie, /^__Host-ou-board=page\./);
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) {
    assert.ok(cookie.includes(attribute), attribute);
  }
  assert.ok(!cookie.includes('Domain'), 'the cookie belongs to the host alone');
  // plain http is let in, but the browser would refuse the Secure cookie there, so none is offered
  const plain = await start(board, asHost({ Origin: `http://${name}` }));
  assert.equal(plain.status, 200);
  assert.deepEqual(JSON.parse(plain.text), { cookie: false });
  assert.equal(plain.headers['set-cookie'], undefined);
  const boardCookie = cookie.split(';')[0];

  // on the bridge's own address there is no cookie to set
  const direct = await rawRequest(
    bridge.base,
    'POST',
    '/auth/session',
    { Origin: bridge.base },
    { key: board },
  );
  assert.deepEqual(JSON.parse(direct.text), { cookie: false });
  assert.equal(direct.headers['set-cookie'], undefined);

  // with the cookie the board loads, and the cookie reaches only the board's routes
  const withCookie = (route: string, cookies: string, extra: Record<string, string> = {}) =>
    rawRequest(bridge.base, 'GET', route, asHost({ Cookie: cookies, ...extra }));
  assert.equal((await withCookie('/api/board', boardCookie)).status, 200);
  assert.equal((await withCookie('/api/stories', boardCookie)).status, 403);
  assert.equal((await withCookie('/api/board', 'x=1; __Host-ou-board=page.nope')).status, 403);

  // a write by cookie needs an allowed Origin; the header key works as before
  const post = (headers: Record<string, string>) =>
    rawRequest(bridge.base, 'POST', '/api/board/focus', asHost(headers), {});
  assert.equal((await post({ Cookie: boardCookie })).status, 403);
  assert.equal((await post({ Cookie: boardCookie, Origin: 'https://evil.test' })).status, 403);
  assert.equal(
    (await post({ Cookie: boardCookie, Origin: origin })).status,
    400,
    'in: it reaches the route',
  );
  assert.equal(
    (await post({ Authorization: `Bearer ${board}` })).status,
    400,
    'a header key needs no Origin',
  );
});

test('the page drops its key only once a call by cookie alone has worked', async () => {
  const saved = {
    fetch: globalThis.fetch,
    location: globalThis.location,
    history: globalThis.history,
  };
  const scenario = async (name: string, session: unknown, probeStatus: number) => {
    const replaced: string[] = [];
    const calls: string[] = [];
    Object.assign(globalThis, {
      location: { hash: '#key=page.abc&repo=acme%2Fwidgets', pathname: '/board/', search: '' },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url),
      },
      fetch: async (url: string) => {
        calls.push(url);
        return url === '/auth/session'
          ? Response.json(session)
          : new Response('{}', { status: probeStatus });
      },
    });
    // a fresh copy of the module each time, since it keeps whether the cookie is in use
    const auth = await import(`../../web/public/local/auth.ts?${name}` as string);
    await auth.startAuth('page.abc', '/api/board');
    return { header: auth.authHeader('page.abc'), replaced, calls };
  };
  try {
    const worked = await scenario('worked', { cookie: true }, 200);
    assert.deepEqual(worked.header, {}, 'the cookie carries it');
    assert.deepEqual(worked.replaced, ['/board/#repo=acme%2Fwidgets']);
    assert.deepEqual(worked.calls, ['/auth/session', '/api/board']);

    const refused = await scenario('refused', { cookie: true }, 401);
    assert.deepEqual(
      refused.header,
      { Authorization: 'Bearer page.abc' },
      'the browser kept no cookie',
    );
    assert.deepEqual(refused.replaced, [], 'so the key stays in the address bar');

    const none = await scenario('none', { cookie: false }, 200);
    assert.deepEqual(none.header, { Authorization: 'Bearer page.abc' });
    assert.deepEqual(none.replaced, []);
    assert.deepEqual(none.calls, ['/auth/session'], 'no cookie, nothing to check');
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('allowed_hosts in config.json decides the names, and only those', async () => {
  const { home, bridge } = await boardBridge();
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: path.join(home, 'none'),
    allowed_hosts: ['board.example.test', 'bad host', 'UPPER.test'],
  });
  const get = (host: string) => rawRequest(bridge.base, 'GET', '/board/', { Host: host });
  assert.equal((await get('board.example.test')).status, 200);
  assert.equal((await get('upper.test')).status, 200, 'names compare in lower case');
  assert.equal(
    (await get('once-upon.test')).status,
    421,
    'the defaults are replaced, not added to',
  );
});

test('the extension asks the bridge for a fresh page link, on the proxy’s address with ?public=1', async () => {
  const { home, bridge } = await boardBridge();
  const link = async (route: string) => (await bridge.call<{ url: string }>('GET', route)).body.url;
  // as the page's own tab would: the bridge's address
  assert.equal(await link('/api/board/link'), `${bridge.base}/board/#key=${boardKey(TOKEN)}`);
  // the extension's ask: the proxy's name, which sets the cookie in its browser
  assert.equal(
    await link('/api/board/link?public=1'),
    `https://once-upon.test/board/#key=${boardKey(TOKEN)}`,
  );
  // and when no proxy name is set, the bridge's own address
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: path.join(home, 'none'),
    public_host: 'none',
  });
  assert.equal(
    await link('/api/board/link?public=1'),
    `${bridge.base}/board/#key=${boardKey(TOKEN)}`,
  );
});

test('a public host that does not resolve to this machine is not offered (a setup with no proxy gets 127.0.0.1)', async () => {
  const saved = process.env.ONCE_UPON_NO_HOST_CHECK;
  delete process.env.ONCE_UPON_NO_HOST_CHECK;
  try {
    const { home, bridge } = await boardBridge();
    writeJson(path.join(home, 'config.json'), {
      board_sessions_dir: path.join(home, 'none'),
      allowed_hosts: ['nowhere.invalid'],
    });
    const { body } = await bridge.call<{ url: string }>('GET', '/api/board/link?public=1');
    assert.equal(body.url, `${bridge.base}/board/#key=${boardKey(TOKEN)}`);
    // a name set in config.json is used as set, resolvable or not
    writeJson(path.join(home, 'config.json'), {
      board_sessions_dir: path.join(home, 'none'),
      allowed_hosts: ['nowhere.invalid'],
      public_host: 'nowhere.invalid',
    });
    const set = await bridge.call<{ url: string }>('GET', '/api/board/link?public=1');
    assert.equal(set.body.url, `https://nowhere.invalid/board/#key=${boardKey(TOKEN)}`);
    const { resolvesHere } = await import('../src/services/pages/address.ts');
    assert.equal(await resolvesHere('localhost'), true);
    assert.equal(await resolvesHere('nowhere.invalid'), false);
  } finally {
    if (saved !== undefined) {
      process.env.ONCE_UPON_NO_HOST_CHECK = saved;
    }
  }
});

test('the voice session: read from Larmor’s folder, status from its files, nothing when it is off', () => {
  const dir = tmp('board-voice');
  assert.equal(readVoice(dir), null, 'no session file');
  const session = (extra: Record<string, unknown>) =>
    writeJson(path.join(dir, 'session'), { on: true, session_id: 'abc12345-aaaa', ...extra });
  session({ on: false });
  assert.equal(readVoice(dir), null, 'voice is off');
  writeJson(path.join(dir, 'session'), { on: true });
  assert.equal(readVoice(dir), null, 'no session named');
  session({ last_listen: 1000, last_speak: 990 });
  assert.deepEqual(readVoice(dir), {
    session: 'abc12345-aaaa',
    on: true,
    name: null,
    away: false,
    phoneOn: false,
    paused: false,
    lastListen: 1000000,
    lastSpeak: 990000,
  });
  writeFileSync(path.join(dir, 'voice-session-name'), 'clarifi-f9\n');
  assert.equal(readVoice(dir)?.name, 'clarifi-f9');
  const files = readVoice(dir) as NonNullable<ReturnType<typeof readVoice>>;
  const now = 1000000 + 5000;
  assert.equal(voiceStatus(files, false, now), 'listening', 'it asked last and nothing is busy');
  assert.equal(voiceStatus({ ...files, lastSpeak: 1004000 }, false, now), 'speaking');
  assert.equal(
    voiceStatus({ ...files, lastSpeak: 1004000 }, false, now + 60000),
    'listening',
    'idle and a while since it spoke',
  );
  assert.equal(voiceStatus({ ...files, lastSpeak: 1004000 }, true, now + 60000), 'working');
  assert.equal(voiceStatus(files, true, now), 'working', 'busy is working');
  assert.equal(voiceStatus({ ...files, on: false }, false, now), 'ended', 'ended wins over all');
  writeFileSync(path.join(dir, 'paused'), '');
  assert.equal(voiceStatus(readVoice(dir) as typeof files, false, now), 'paused');
  writeJson(path.join(dir, 'away'), { on: true, since: 1, by: 'menu' });
  assert.equal(
    voiceStatus(readVoice(dir) as typeof files, false, now),
    'paused',
    'paused wins over away, so Resume is offered',
  );
  rmSync(path.join(dir, 'paused'));
  assert.equal(voiceStatus(readVoice(dir) as typeof files, false, now), 'away');
});

test('the voice session counts as today by its last activity, at the local midnight edge, in any time zone', () => {
  const dir = tmp('board-voice-midnight');
  const midnight = new Date(NOW);
  midnight.setHours(0, 0, 0, 0);
  const stamp = (offsetSeconds: number) => midnight.getTime() / 1000 + offsetSeconds;
  const noon = midnight.getTime() + 12 * 3600 * 1000;
  const write = (started: number, session: Record<string, unknown>) => {
    writeJson(path.join(dir, 'last-voice.json'), {
      session_id: 'abc12345-aaaa',
      cwd: '/x',
      at: started,
    });
    writeJson(path.join(dir, 'session'), session);
  };
  // ended after midnight, started before it: today
  write(stamp(-3600), { on: false, since: stamp(60) });
  assert.equal(readVoice(dir, noon)?.on, false);
  // started and ended before midnight: yesterday's, gone
  write(stamp(-7200), { on: false, since: stamp(-1) });
  assert.equal(readVoice(dir, noon), null);
  // started just after midnight, ended later today
  write(stamp(1), { on: false, since: stamp(3600) });
  assert.equal(readVoice(dir, noon)?.session, 'abc12345-aaaa');
  // still on, started yesterday: on is always shown
  write(stamp(-86400), { on: true, session_id: 'abc12345-aaaa' });
  assert.equal(readVoice(dir, noon)?.on, true);
  // tomorrow, with nothing since: gone
  write(stamp(1), { on: false, since: stamp(3600) });
  assert.equal(readVoice(dir, noon + 24 * 3600 * 1000), null);
});

test('the voice session is pinned above the columns, off every card, with its agents keeping theirs', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const voiceDir = tmp('board-voice');
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  const [voice, other] = [liveChild(), liveChild()];
  after(() => [voice, other].forEach((child) => child.stop()));
  const sid = (child: { pid: number }) => String(child.pid).padStart(8, '0');
  const checkout = checkoutOf('widgets', 'main');
  registry(
    sessions,
    voice.pid,
    { cwd: checkout, name: 'clarifi-f9', status: 'busy' },
    voice.procStart,
  );
  registry(sessions, other.pid, { cwd: checkout, name: 'plain-one' }, other.procStart);
  writeFileSync(
    ledger,
    [
      `- [running] sid:${sid(voice)} lane:elsewhere helper-one (sonnet, low) — a task — started 2:50 PM ET, 10/26`,
      `- [waiting] sid:${sid(voice)} helper-two — 2:55 PM ET, 10/26 — needs Eric: pick — notes/x.md`,
      `- [done] sid:${sid(voice)} helper-three — 2:56 PM ET, 10/26 — done`,
      `- [review] sid:${sid(voice)} helper-four (sonnet, low) — story abc up, two chapters — 2:57 PM ET, 10/26`,
      // left behind more than a day ago: no longer counted
      `- [review] sid:${sid(voice)} helper-five — story old — 9:00 AM ET, 10/24`,
      `- [waiting] sid:${sid(voice)} helper-six — 9:00 AM ET, 10/24 — needs Eric: long ago — notes/y.md`,
      `- [running] sid:${sid(other)} not-the-voice (sonnet, low) — a task — started 2:50 PM ET, 10/26`,
    ].join('\n'),
  );
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: fullId(voice.pid),
    last_listen: 5,
    last_speak: 4,
  });
  writeFileSync(path.join(voiceDir, 'voice-session-name'), 'clarifi-f9\n');
  // what it said (each line at its latest state; another session's lines left out) and what you said since it first spoke
  const wall = (minutes: number) => NOW.getTime() / 1000 - minutes * 60;
  writeFileSync(
    path.join(voiceDir, 'spoken.jsonl'),
    [
      {
        id: 'm1',
        wall: wall(5),
        text: 'One sec, checking.',
        session_id: fullId(voice.pid),
        status: 'queued',
      },
      {
        id: 'm1',
        wall: wall(5),
        text: 'One sec, checking.',
        session_id: fullId(voice.pid),
        status: 'spoken',
      },
      {
        id: 'm2',
        wall: wall(4),
        text: 'Not this one.',
        session_id: 'someone-else',
        status: 'spoken',
      },
      {
        id: 'm3',
        wall: wall(2),
        text: 'It is green.',
        session_id: fullId(voice.pid),
        status: 'spoken',
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );
  writeFileSync(
    path.join(voiceDir, 'turns.jsonl'),
    [
      {
        type: 'turn',
        channel: 'mic',
        text: 'Before it spoke.',
        is_final: true,
        wall_clock: wall(9),
      },
      { type: 'turn', channel: 'mic', text: 'Is it green?', is_final: true, wall_clock: wall(3) },
      { type: 'turn', channel: 'mic', text: 'Is it', is_final: false, wall_clock: wall(3) },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );
  // its status line's copy: the voice card shows its context use, and the board the usage limits
  writeJson(path.join(home, 'statusline', `${fullId(voice.pid)}.json`), {
    at: NOW.getTime() / 1000 - 30,
    context: 37,
    rate_limits: { five_hour: { used_percentage: 91, resets_at: NOW.getTime() / 1000 + 3600 } },
  });
  const settings = {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
    board_ledger_time_zone: 'UTC',
  };
  writeJson(path.join(home, 'config.json'), { ...settings, board_voice_dir: voiceDir });
  const make = () =>
    new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying({}),
      now: () => NOW,
    });
  const data = await make().snapshot();
  const cards = data.lanes.flatMap((lane) => lane.cards);
  assert.equal(
    cards.find((card) => card.id === fullId(voice.pid)),
    undefined,
    'not on a card',
  );
  assert.ok(
    cards.find((card) => card.id === fullId(other.pid)),
    'other sessions are',
  );
  assert.deepEqual(data.voice, {
    name: 'clarifi-f9',
    title: 'clarifi-f9',
    repo: 'acme/widgets',
    lane: 'acme/widgets',
    branch: 'main',
    status: 'working',
    since: data.voice?.since,
    agents: { running: 1, waiting: 1, review: 1 },
    session: fullId(voice.pid),
    can_focus: false,
    context: 37,
    lines: [
      { who: 'voice', text: 'One sec, checking.', at: wall(5) * 1000 },
      { who: 'you', text: 'Is it green?', at: wall(3) * 1000 },
      { who: 'voice', text: 'It is green.', at: wall(2) * 1000 },
    ],
  });
  assert.deepEqual(data.usage, {
    five_hour: { percent: 91, resets_at: new Date(NOW.getTime() + 3600 * 1000).toISOString() },
    seven_day: null,
    at: new Date(NOW.getTime() - 30 * 1000).toISOString(),
  });
  // its agents keep their own cards, still "from" the voice session
  const helper = cards.find((card) => card.id === `agent:${sid(voice)}:helper-two`);
  assert.equal(helper?.column, 'waiting');
  assert.equal(helper?.parent, 'Voice session', 'named for what it is, not its tab title');
  assert.equal(helper?.lane, 'acme/widgets', 'in its parent’s lane');
  assert.equal(
    cards.find((card) => card.id === `agent:${sid(voice)}:helper-one`)?.lane,
    'elsewhere',
  );
  // with the setting unset, voice mode is not looked at: the session is a card like any other
  writeJson(path.join(home, 'config.json'), settings);
  const plain = await make().snapshot();
  assert.equal(plain.voice, null);
  assert.ok(
    plain.lanes.flatMap((lane) => lane.cards).find((card) => card.id === fullId(voice.pid)),
  );
  // and voice off in its own files: the same
  writeJson(path.join(home, 'config.json'), { ...settings, board_voice_dir: voiceDir });
  writeJson(path.join(voiceDir, 'session'), { on: false, session_id: fullId(voice.pid) });
  assert.equal((await make().snapshot()).voice, null, 'voice is off and was never started today');
  // off, but it started today (last-voice.json, which outlives `session`'s id): the panel stays, as ended
  // (times are from the local midnight before NOW, so the case holds in any time zone)
  const midnight = new Date(NOW);
  midnight.setHours(0, 0, 0, 0);
  const lastVoice = (secondsAfterMidnight: number) =>
    writeJson(path.join(voiceDir, 'last-voice.json'), {
      session_id: fullId(voice.pid),
      cwd: '/x',
      at: midnight.getTime() / 1000 + secondsAfterMidnight,
    });
  writeJson(path.join(voiceDir, 'session'), { on: false, since: 1 });
  lastVoice(1);
  const ended = (await make().snapshot()).voice;
  assert.equal(ended?.status, 'ended');
  assert.equal(ended?.session, fullId(voice.pid));
  assert.equal(ended?.name, 'clarifi-f9');
  writeFileSync(path.join(voiceDir, 'paused'), '');
  assert.equal((await make().snapshot()).voice?.status, 'ended', 'ended wins over paused');
  // yesterday's voice is gone
  lastVoice(-3 * 24 * 3600);
  assert.equal((await make().snapshot()).voice, null);
  // voice on again and paused: the panel stays, as paused
  writeJson(path.join(voiceDir, 'session'), { on: true, session_id: fullId(voice.pid) });
  assert.equal((await make().snapshot()).voice?.status, 'paused');
});

/** The claim tests' world: PR 7 on acme/widgets feat/x (a story), a card started on that branch, and `ledger` lines. */
function claimWorld(ledgerText: string, now: Date = NOW) {
  const home = tmp('claim-board-home');
  const ledger = path.join(tmp('claim-board-notes'), 'ledger.md');
  writeFileSync(ledger, ledgerText);
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: tmp('claim-board-sessions'),
    board_ledger_time_zone: 'UTC',
  });
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  const store = new BacklogStore(home);
  const cards = async (): Promise<BoardCard[]> =>
    (
      await new Board(
        home,
        new StoryStore({ home }),
        fakeWatcher([prInfo(7, { branch: 'feat/x' })]).watcher,
        new Builds(home),
        { source: sourceSaying({}), now: () => now },
      ).snapshot()
    ).lanes.flatMap((lane) => lane.cards);
  return { home, ledger, store, cards };
}
const CLAIM_WHILE_RUNNING = '2026-10-26T18:35:00Z';
const holders = (cards: BoardCard[], name: string) =>
  cards.filter((card) => card.agents.some((agent) => agent.name === name));

test('a claimed agent on its branch’s card sets that card’s column whatever it is doing (running, at its plan, asking)', async () => {
  const running = `- [running] sid:54736864 builder (sonnet, high) — build — started 2:30 PM ET, 10/26\n`;
  const cases: [string, string, string][] = [
    ['running', running, 'working'],
    [
      'at its plan',
      running + '- [plan] sid:54736864 builder — 2:40 PM ET, 10/26 — plan ready — notes/p.md\n',
      'checks',
    ],
    [
      'asking',
      running +
        '- [waiting] sid:54736864 builder — 2:40 PM ET, 10/26 — needs you: which one — notes/p.md\n',
      'waiting',
    ],
  ];
  for (const [what, text, column] of cases) {
    const { store, cards } = claimWorld(text);
    const item = store.add({ title: 'Build x', repo: 'acme/widgets' });
    store.start(item.id, { branch: 'feat/x', repo: 'acme/widgets' });
    claimAt(store, item.id, 'builder', CLAIM_WHILE_RUNNING);
    const all = await cards();
    const pr = all.find((card) => card.id === 'pr:acme/widgets#7') as BoardCard;
    assert.equal(pr.column, column, `${what}: the PR card is in ${column}`);
    assert.deepEqual(
      holders(all, 'builder'),
      [pr],
      `${what}: the agent is on the PR card and nowhere else`,
    );
    assert.equal(pr.from_backlog?.[0].id, item.id);
    assert.equal(all.filter((card) => card.kind === 'agent').length, 0, `${what}: no agent card`);
  }
});

test('after the card is marked done a claimed agent shows once, not on the landed card and on its own', async () => {
  const text =
    `- [running] sid:54736864 builder (sonnet, high) — build — started 2:30 PM ET, 10/26\n` +
    `- [done] sid:54736864 builder — 2:50 PM ET, 10/26 — committed on feat/x, tests green — notes/p.md\n`;
  const { store, cards } = claimWorld(text);
  const item = store.add({ title: 'Build x', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'feat/x', repo: 'acme/widgets' });
  claimAt(store, item.id, 'builder', CLAIM_WHILE_RUNNING);
  // before it lands: on the PR card, held out of its own card
  assert.equal(holders(await cards(), 'builder').length, 1);
  store.done(item.id, { sha: 'abc1234', by: 'deploy-local' });
  const all = await cards();
  assert.equal(holders(all, 'builder').length, 1, 'once, in Done');
  assert.equal(
    holders(all, 'builder')[0].kind,
    'agent',
    'on its own finished card, the claim being over',
  );
});

test('a claim is for one run: a rerun of the same agent under the same name does not pull the finished card back', async () => {
  const text =
    `- [running] sid:54736864 ou-build (sonnet, high) — build — started 2:30 PM ET, 10/26\n` +
    `- [done] sid:54736864 ou-build — 3:50 PM ET, 10/26 — committed abc1234 — notes/p.md\n` +
    `- [running] sid:54736864 ou-build (sonnet, high) — fix other things — started 4:00 PM ET, 10/26\n`;
  const { store, cards } = claimWorld(text, new Date('2026-10-26T20:30:00Z'));
  const item = store.add({ title: 'The first job', repo: 'acme/gadgets' });
  claimAt(store, item.id, 'ou-build', '2026-10-26T18:40:00Z');
  const all = await cards();
  const card = all.find((one) => one.backlog?.id === item.id) as BoardCard;
  assert.equal(card.column, 'done', 'the first run finished: the card does not go back to Working');
  assert.equal(card.agents[0].state, 'done');
  const own = all.filter((one) => one.kind === 'agent');
  assert.equal(own.length, 1, 'the rerun has its own card');
  assert.equal(own[0].column, 'working');
  // and it holds no build slot of that card's: claimed keys come from the current run only
  const second = store.add({ title: 'The second job', repo: 'acme/gadgets' });
  claimAt(store, second.id, 'ou-build', '2026-10-26T20:05:00Z');
  const both = await cards();
  assert.equal(both.find((one) => one.backlog?.id === second.id)?.column, 'working');
  assert.equal(both.find((one) => one.backlog?.id === item.id)?.column, 'done');
  assert.equal(both.filter((one) => one.kind === 'agent').length, 0, 'now it is the second card’s');
});

test('claiming before the agent’s ledger line, with an older finished run of that name, leaves the card Working and pending', async () => {
  const text =
    `- [running] sid:54736864 ou-late (sonnet, high) — old job — started 2:30 PM ET, 10/20\n` +
    `- [done] sid:54736864 ou-late — 3:00 PM ET, 10/20 — committed abc1234 — notes/p.md\n`;
  const now = new Date();
  const { store, cards } = claimWorld(text, now);
  const item = store.add({ title: 'A new job', repo: 'acme/gadgets' });
  store.claim(item.id, { agent: 'ou-late' });
  const card = (await cards()).find((one) => one.backlog?.id === item.id) as BoardCard;
  assert.ok(card, 'the card is on the board');
  assert.equal(card.column, 'working');
  assert.equal(card.backlog?.claim?.pending, true);
});

test('POST /api/board/voice/pause makes and removes Larmor’s paused file, only with voice on and the board key', async () => {
  const home = tmp('board-voice-pause');
  const voiceDir = tmp('board-voice');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const post = (body: unknown, key = boardKey(TOKEN)) =>
    bridge.call('POST', '/api/board/voice/pause', body, { Authorization: `Bearer ${key}` });
  const paused = path.join(voiceDir, 'paused');
  assert.equal((await post({ paused: true })).status, 400, 'board_voice_dir is not set');
  writeJson(path.join(home, 'config.json'), { board_voice_dir: voiceDir });
  assert.equal((await post({})).status, 400, 'paused is needed');
  assert.equal((await post({ paused: 'yes' })).status, 400);
  // voice is off: nothing to pause
  writeJson(path.join(voiceDir, 'session'), { on: false, since: 1 });
  assert.equal((await post({ paused: true })).status, 409);
  assert.equal(existsSync(paused), false);
  writeJson(path.join(voiceDir, 'session'), { on: true, session_id: 'abc12345-aaaa' });
  assert.equal((await post({ paused: true })).status, 200);
  assert.equal(existsSync(paused), true);
  assert.equal((await post({ paused: true })).status, 200, 'pausing twice is fine');
  assert.equal((await post({ paused: false })).status, 200);
  assert.equal(existsSync(paused), false);
  assert.equal((await post({ paused: false })).status, 200, 'resuming when not paused is fine');
  // resume works after voice ended too
  writeFileSync(paused, '');
  writeJson(path.join(voiceDir, 'session'), { on: false, since: 1 });
  assert.equal((await post({ paused: false })).status, 200);
  assert.equal(existsSync(paused), false);
  // another page's key doesn't reach it
  assert.equal((await post({ paused: true }, pageKey(TOKEN, 'x'))).status, 403);
});

test('phone mode is the away file read as Larmor’s read_away reads it, and it is only “away” while voice is on', () => {
  const dir = tmp('board-voice-away');
  writeJson(path.join(dir, 'session'), { on: true, session_id: 'abc12345-aaaa' });
  const away = path.join(dir, 'away');
  const read = () => readVoice(dir) as NonNullable<ReturnType<typeof readVoice>>;
  assert.equal(read().phoneOn, false, 'no file');
  writeJson(away, { on: true, since: 1, by: 'menu', keep_mac_mic: false });
  assert.deepEqual([read().phoneOn, read().away], [true, true]);
  writeJson(away, { on: false, since: 1 });
  assert.deepEqual([read().phoneOn, read().away], [false, false], 'on:false is off');
  // anything else is off, as Larmor's read_away has it: an object whose `on` is truthy
  for (const text of [
    '',
    'junk',
    '[]',
    '{}',
    '{"on": null}',
    '{"on": 0}',
    '{"on": ""}',
    '[{"on": true}]',
  ]) {
    writeFileSync(away, text);
    assert.equal(read().phoneOn, false, text || '(empty)');
  }
  for (const text of ['{"on": 1}', '{"on": "yes"}', '{"on": [1]}']) {
    writeFileSync(away, text);
    assert.equal(read().phoneOn, true, text);
  }
  writeJson(away, { on: true });
  writeJson(path.join(dir, 'session'), { on: false, since: 2 });
  writeJson(path.join(dir, 'last-voice.json'), {
    session_id: 'abc12345-aaaa',
    cwd: '/x',
    at: Date.now() / 1000,
  });
  assert.deepEqual(
    [read().phoneOn, read().away],
    [true, false],
    'voice ended: phone mode is the file, away is voice on',
  );
});

test('the phone bridge counts as running when its local sink port (phone.json, else 8171) accepts a connection', async () => {
  const dir = tmp('board-voice-bridge');
  assert.equal(sinkPort(dir), 8171, 'Larmor’s default');
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  writeJson(path.join(dir, 'phone.json'), { sink_port: port });
  assert.equal(sinkPort(dir), port);
  forgetProbes();
  assert.equal(await bridgeUp(dir), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await bridgeUp(dir), true, 'the answer is kept for a moment');
  forgetProbes();
  assert.equal(await bridgeUp(dir), false, 'nothing listens now');
  writeJson(path.join(dir, 'phone.json'), { sink_port: 'x' });
  assert.equal(sinkPort(dir), 8171);
});

/** A Larmor checkout whose venv python is a script that records its arguments and prints voice_ctl's one-line answer. */
function fakeLarmor(): string {
  const larmor = tmp('board-larmor');
  mkdirSync(path.join(larmor, '.venv-app', 'bin'), { recursive: true });
  mkdirSync(path.join(larmor, 'app'), { recursive: true });
  writeFileSync(path.join(larmor, 'app', 'voice_ctl.py'), '');
  const python = path.join(larmor, '.venv-app', 'bin', 'python');
  writeFileSync(
    python,
    `#!/bin/sh
echo "$@" >> calls.log
if [ -f slow ]; then sleep 1; fi
if [ -f silent ]; then echo "Traceback (most recent call last):" >&2; echo "ModuleNotFoundError: No module named 'rumps'" >&2; exit 3; fi
if [ -f refuse ] && [ "$2" = phone-on ]; then
  echo '{"ok": false, "why": "The phone isn'"'"'t paired yet. Pair it first.", "away": false, "bridge": false}'
  exit 0
fi
if [ -f refuse ] && [ "$2" = start ]; then
  echo '{"ok": false, "why": "Voice is already on in another session", "away": false, "bridge": false, "voice": {"on": true, "paused": false}}'
  exit 0
fi
case "$2" in
  start) echo '{"ok": true, "why": "", "away": false, "bridge": false, "voice": {"on": true, "paused": false}}';;
  phone-on) echo 'noise before the answer'; echo '{"ok": true, "why": "", "away": true, "bridge": true}';;
  *) echo '{"ok": true, "why": "", "away": false, "bridge": false}';;
esac
`,
  );
  chmodSync(python, 0o755);
  return larmor;
}

test('waitBridgeDown waits for the bridge to stop listening, and gives up when it does not', async () => {
  const dir = tmp('board-voice-down');
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  writeJson(path.join(dir, 'phone.json'), {
    sink_port: (server.address() as { port: number }).port,
  });
  forgetProbes();
  assert.equal(await bridgeUp(dir), true);
  assert.equal(await waitBridgeDown(dir, 200), true, 'still listening when the time is up');
  setTimeout(() => server.close(), 300);
  assert.equal(
    await waitBridgeDown(dir, 3000),
    false,
    'it went down, though the probe had cached “up”',
  );
});

test('the phone buttons need the checkout’s venv python and app/voice_ctl.py', () => {
  const larmor = fakeLarmor();
  assert.equal(phoneReady(larmor), true);
  rmSync(path.join(larmor, 'app', 'voice_ctl.py'));
  assert.equal(phoneReady(larmor), false, 'no script');
  assert.equal(phoneReady(tmp('board-no-larmor')), false);
});

test('runVoiceCtl runs only the phone, start and stop commands, from the checkout, and reads the last line it prints', async () => {
  const larmor = fakeLarmor();
  assert.throws(() => runVoiceCtl(larmor, 'status' as PhoneCommand), /not an allowed/);
  assert.throws(() => runVoiceCtl(larmor, 'pause' as PhoneCommand), /not an allowed/);
  // a session id goes to start alone, and only in an id's own shape
  assert.throws(() => runVoiceCtl(larmor, 'stop', 'sess-1'), /not an allowed/);
  assert.throws(() => runVoiceCtl(larmor, 'start', '--help'), /not an allowed/);
  assert.throws(() => runVoiceCtl(larmor, 'start', 'a b; rm'), /not an allowed/);
  assert.deepEqual(await runVoiceCtl(larmor, 'start', 'sess-1'), {
    ok: true,
    why: '',
    away: false,
    bridge: false,
    voiceOn: true,
  });
  assert.deepEqual(await runVoiceCtl(larmor, 'stop'), {
    ok: true,
    why: '',
    away: false,
    bridge: false,
    voiceOn: false,
  });
  rmSync(path.join(larmor, 'calls.log'));
  assert.deepEqual(await runVoiceCtl(larmor, 'phone-on'), {
    ok: true,
    why: '',
    away: true,
    bridge: true,
    voiceOn: false,
  });
  assert.equal(readFileSync(path.join(larmor, 'calls.log'), 'utf8'), 'app/voice_ctl.py phone-on\n');
  writeFileSync(path.join(larmor, 'silent'), '');
  await assert.rejects(
    runVoiceCtl(larmor, 'bridge-stop'),
    /voice_ctl bridge-stop failed: ModuleNotFoundError: No module named 'rumps'/,
    'stderr’s last line is the reason',
  );
  await assert.rejects(
    runVoiceCtl(tmp('board-no-larmor'), 'phone-off'),
    /voice_ctl phone-off failed/,
  );
});

test('the phone state: null without a ready board_larmor_dir, else phone mode from the file and the bridge from its port, with voice on or not', async () => {
  const home = tmp('board-voice-phone');
  const sessions = tmp('board-sessions');
  const voiceDir = tmp('board-voice');
  const child = liveChild();
  after(() => child.stop());
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  registry(sessions, child.pid, { status: 'idle' }, child.procStart);
  writeJson(path.join(voiceDir, 'session'), { on: true, session_id: fullId(child.pid) });
  const settings = {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
    board_voice_dir: voiceDir,
  };
  const make = () =>
    new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying({}),
      now: () => NOW,
    });
  writeJson(path.join(home, 'config.json'), settings);
  const noCheckout = await make().snapshot();
  assert.equal(noCheckout.phone, null, 'no checkout to ask');
  assert.equal(noCheckout.voice_start, null, 'nor to start voice with');
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  writeJson(path.join(voiceDir, 'phone.json'), {
    sink_port: (server.address() as { port: number }).port,
  });
  const larmorDir = fakeLarmor();
  writeJson(path.join(home, 'config.json'), { ...settings, board_larmor_dir: larmorDir });
  forgetProbes();
  assert.deepEqual((await make().snapshot()).phone, { on: false, bridge: true });
  // Start voice: the live sessions with whether each is at its prompt, and the last voice session when it is still live
  const started = (await make().snapshot()).voice_start;
  assert.equal(started?.last, null, 'no last-voice.json yet');
  assert.deepEqual(
    started?.candidates.map((one) => [one.id, one.idle]),
    [[fullId(child.pid), true]],
  );
  writeJson(path.join(voiceDir, 'last-voice.json'), { session_id: fullId(child.pid), at: 1 });
  assert.equal((await make().snapshot()).voice_start?.last?.id, fullId(child.pid));
  writeJson(path.join(voiceDir, 'last-voice.json'), { session_id: 'gone-session', at: 1 });
  assert.equal(
    (await make().snapshot()).voice_start?.last,
    null,
    'a session that ended is not offered',
  );
  rmSync(path.join(voiceDir, 'last-voice.json'));
  writeJson(path.join(home, 'config.json'), {
    ...settings,
    board_larmor_dir: tmp('board-larmor-bare'),
  });
  assert.equal((await make().snapshot()).phone, null, 'no venv or voice_ctl there, no buttons');
  writeJson(path.join(home, 'config.json'), { ...settings, board_larmor_dir: larmorDir });
  writeJson(path.join(voiceDir, 'away'), { on: true, since: 1, by: 'phone' });
  assert.equal((await make().snapshot()).voice?.status, 'away');
  assert.deepEqual((await make().snapshot()).phone, { on: true, bridge: true });
  await new Promise((resolve) => server.close(resolve));
  forgetProbes();
  assert.deepEqual((await make().snapshot()).phone, { on: true, bridge: false });
  // the buttons do not depend on voice: with voice never started today there is no panel, and the phone state is there
  writeJson(path.join(voiceDir, 'session'), { on: false, since: 1 });
  const quiet = await make().snapshot();
  assert.equal(quiet.voice, null);
  assert.deepEqual(quiet.phone, { on: true, bridge: false });
});

test('POST /api/board/voice/phone and /phone/bridge-stop ask Larmor’s voice_ctl, voice on or not, with the board key', async () => {
  const home = tmp('board-voice-phone-post');
  const voiceDir = tmp('board-voice');
  // The phone bridge's port: without phone.json the probe falls back to Larmor's default, which a Larmor running on this Mac holds. Port 1 has no listener.
  writeJson(path.join(voiceDir, 'phone.json'), { sink_port: 1 });
  const larmor = fakeLarmor();
  const bridge = await startBridge({ home });
  open.push(bridge);
  const post = (route: string, body: unknown, key = boardKey(TOKEN)) =>
    bridge.call('POST', `/api/board/voice/${route}`, body, { Authorization: `Bearer ${key}` });
  const calls = () =>
    existsSync(path.join(larmor, 'calls.log'))
      ? readFileSync(path.join(larmor, 'calls.log'), 'utf8')
      : '';
  assert.equal((await post('phone', { on: true })).status, 400, 'no folders are set');
  writeJson(path.join(home, 'config.json'), { board_voice_dir: voiceDir });
  assert.equal((await post('phone', { on: true })).status, 400, 'board_larmor_dir is not set');
  writeJson(path.join(home, 'config.json'), {
    board_voice_dir: voiceDir,
    board_larmor_dir: tmp('board-larmor-bare'),
  });
  assert.equal((await post('phone', { on: false })).status, 400, 'no venv or voice_ctl to run');
  writeJson(path.join(home, 'config.json'), {
    board_voice_dir: voiceDir,
    board_larmor_dir: larmor,
  });
  assert.equal((await post('phone', {})).status, 400, 'on is needed');
  assert.equal((await post('phone', { on: 'yes' })).status, 400);
  // phone mode does not need voice: with voice off Larmor is asked all the same
  writeJson(path.join(voiceDir, 'session'), { on: false, since: 1 });
  const turned = await post('phone', { on: true });
  assert.equal(turned.status, 200);
  assert.deepEqual(JSON.parse(turned.text), { ok: true, on: true, bridge: true });
  assert.equal(calls(), 'app/voice_ctl.py phone-on\n');
  assert.equal((await post('phone', { on: false })).status, 200);
  const stopped = await post('phone/bridge-stop', {});
  assert.equal(stopped.status, 200);
  assert.deepEqual(JSON.parse(stopped.text), { ok: true, on: false, bridge: false });
  assert.equal(
    calls(),
    'app/voice_ctl.py phone-on\napp/voice_ctl.py phone-off\napp/voice_ctl.py bridge-stop\n',
  );
  // Larmor refuses (not paired, firewall, wrong network): its reason comes back as a 409
  writeJson(path.join(voiceDir, 'session'), { on: true, session_id: 'abc12345-aaaa' });
  writeFileSync(path.join(larmor, 'refuse'), '');
  const refused = await post('phone', { on: true });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /isn.t paired yet/);
  // no answer from voice_ctl at all
  writeFileSync(path.join(larmor, 'silent'), '');
  assert.equal((await post('phone/bridge-stop', {})).status, 502);
  // one call at a time: while Larmor works on the first, the second is refused
  rmSync(path.join(larmor, 'silent'));
  rmSync(path.join(larmor, 'refuse'));
  writeFileSync(path.join(larmor, 'slow'), '');
  const first = post('phone', { on: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await post('phone', { on: false });
  assert.equal(second.status, 409);
  assert.match(second.text, /still working/);
  assert.equal((await first).status, 200);
  assert.equal((await post('phone', { on: false })).status, 200, 'free again');
  // another page's key doesn't reach them
  assert.equal((await post('phone', { on: true }, pageKey(TOKEN, 'x'))).status, 403);
  assert.equal((await post('phone/bridge-stop', {}, pageKey(TOKEN, 'x'))).status, 403);
});

test('the voice state: a pause file shows with voice off, only interactive sessions can take Start, and a dead owner means voice is off', async () => {
  const home = tmp('board-voice-facts');
  const sessions = tmp('board-sessions');
  const voiceDir = tmp('board-voice');
  writeJson(path.join(voiceDir, 'phone.json'), { sink_port: 1 }); // not Larmor's default port, which a live Larmor holds
  const [shown, headless] = [liveChild(), liveChild()];
  after(() => {
    shown.stop();
    headless.stop();
  });
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  registry(sessions, shown.pid, { status: 'idle', kind: 'interactive' }, shown.procStart);
  registry(sessions, headless.pid, { status: 'idle', kind: 'sdk-cli' }, headless.procStart);
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
    board_voice_dir: voiceDir,
    board_larmor_dir: fakeLarmor(),
  });
  const snap = () =>
    new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying({}),
      now: () => NOW,
    }).snapshot();
  assert.equal((await snap()).voice_paused, false);
  assert.deepEqual(
    (await snap()).voice_start?.candidates.map((one) => one.id),
    [fullId(shown.pid)],
    'a session that is not interactive is not offered',
  );
  // a pause left behind: voice is off (no session file), and the page can still Resume
  writeFileSync(path.join(voiceDir, 'paused'), '');
  const left = await snap();
  assert.equal(left.voice, null);
  assert.equal(left.voice_paused, true);
  // voice on in a live owner, then the owner dies: the file still says on, Larmor counts it as off
  const owner = liveChild();
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: fullId(shown.pid),
    owner: owner.pid,
  });
  assert.equal((await snap()).voice?.status, 'paused');
  owner.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await snap()).voice, null, 'owner gone: voice is off');
});

test('POST /api/board/voice/start and /stop ask Larmor’s voice_ctl with the board key, one at a time, and carry its refusal', async () => {
  const home = tmp('board-voice-start-post');
  const voiceDir = tmp('board-voice');
  const larmor = fakeLarmor();
  const bridge = await startBridge({ home });
  open.push(bridge);
  const post = (route: string, body: unknown, key = boardKey(TOKEN)) =>
    bridge.call('POST', `/api/board/voice/${route}`, body, { Authorization: `Bearer ${key}` });
  const calls = () => readFileSync(path.join(larmor, 'calls.log'), 'utf8');
  assert.equal((await post('start', {})).status, 400, 'no folders are set');
  writeJson(path.join(home, 'config.json'), {
    board_voice_dir: voiceDir,
    board_larmor_dir: larmor,
  });
  const bad = await post('start', { session: '--help' });
  assert.equal(bad.status, 400, bad.text);
  assert.equal((await post('start', { session: 5 })).status, 400);
  const started = await post('start', { session: 'sess-1' });
  assert.equal(started.status, 200);
  assert.deepEqual(JSON.parse(started.text), { ok: true, voice: true });
  assert.equal((await post('start', {})).status, 200, 'the session is optional');
  const stopped = await post('stop', {});
  assert.equal(stopped.status, 200);
  assert.deepEqual(JSON.parse(stopped.text), { ok: true, voice: false });
  assert.equal(
    calls(),
    'app/voice_ctl.py start sess-1\napp/voice_ctl.py start\napp/voice_ctl.py stop\n',
  );
  writeFileSync(path.join(larmor, 'refuse'), '');
  const refused = await post('start', { session: 'sess-1' });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /already on in another session/);
  rmSync(path.join(larmor, 'refuse'));
  // one call at a time across start, stop and the phone buttons
  writeFileSync(path.join(larmor, 'slow'), '');
  const first = post('start', {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await post('stop', {})).status, 409);
  assert.equal((await first).status, 200);
  assert.equal((await post('start', {}, pageKey(TOKEN, 'x'))).status, 403);
  assert.equal((await post('stop', {}, pageKey(TOKEN, 'x'))).status, 403);
});

test('Stop phone bridge holds the one-call guard until the bridge is down', async () => {
  const home = tmp('board-bridge-down-guard');
  const voiceDir = tmp('board-voice');
  const larmor = fakeLarmor();
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  writeJson(path.join(voiceDir, 'phone.json'), {
    sink_port: (server.address() as { port: number }).port,
  });
  forgetProbes();
  const bridge = await startBridge({ home });
  open.push(bridge);
  writeJson(path.join(home, 'config.json'), {
    board_voice_dir: voiceDir,
    board_larmor_dir: larmor,
  });
  const post = (route: string, body: unknown) =>
    bridge.call('POST', `/api/board/voice/${route}`, body, {
      Authorization: `Bearer ${boardKey(TOKEN)}`,
    });
  const stopping = post('phone/bridge-stop', {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    (await post('phone', { on: true })).status,
    409,
    'still waiting for the bridge to go',
  );
  setTimeout(() => server.close(), 200);
  assert.equal((await stopping).status, 200);
  assert.equal((await post('phone', { on: false })).status, 200, 'free once it is down');
});

test('Board.setVoicePaused drops the kept snapshot, so the refresh right after Pause or Resume sees it', async () => {
  const home = tmp('board-voice-pause-cache');
  const sessions = tmp('board-sessions');
  const voiceDir = tmp('board-voice');
  const child = liveChild();
  after(() => child.stop());
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  registry(sessions, child.pid, { status: 'idle' }, child.procStart);
  writeJson(path.join(voiceDir, 'session'), { on: true, session_id: fullId(child.pid) });
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
    board_voice_dir: voiceDir,
  });
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  assert.notEqual((await board.snapshot()).voice?.status, 'paused');
  board.setVoicePaused(true);
  assert.equal((await board.snapshot()).voice?.status, 'paused');
  board.setVoicePaused(false);
  assert.notEqual((await board.snapshot()).voice?.status, 'paused');
});

test('snapshot is single-flight: callers during a build share it, and the cache fills when it finishes', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
  });
  let started = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const source: StatusSource = {
    name: 'iterm',
    statuses: async () => {
      started += 1;
      await gate;
      return new Map();
    },
  };
  let clock = NOW.getTime();
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source,
    now: () => new Date(clock),
  });
  // a poll slower than the 3 s interval: later callers, even after the cache time has passed, join the build
  const first = board.snapshot();
  clock += 3000;
  const second = board.snapshot();
  clock += 3000;
  const third = board.snapshot();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started, 1, 'one build for all three');
  release();
  const [one, two, three] = await Promise.all([first, second, third]);
  assert.equal(two, one);
  assert.equal(three, one);
  assert.equal(started, 1);
  // the cache was set when the build finished, stamped with the time the build began
  clock = NOW.getTime() + 1000;
  assert.equal(await board.snapshot(), one, 'within the cache time of the build that began');
  clock = NOW.getTime() + 2500;
  assert.notEqual(await board.snapshot(), one, 'past it, a new build');
  assert.equal(started, 2);
});

test('a session’s repo is looked up without holding the snapshot: it goes on, and a later snapshot has it', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  writeFileSync(ledger, '');
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
  });
  const child = liveChild();
  after(() => child.stop());
  const folder = tmp('hung-mount');
  registry(sessions, child.pid, { cwd: folder, name: 'plain' }, child.procStart);
  let answer: (repo: string | null) => void = () => {};
  let pending: Promise<string | null> | null = null;
  const asked: string[] = [];
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    repoOf: (cwd) => {
      asked.push(cwd);
      pending ??= new Promise((resolve) => (answer = resolve));
      return pending;
    },
  });
  const began = Date.now();
  const lanes = (await board.snapshot()).lanes;
  assert.ok(Date.now() - began < 3000, 'did not wait for the lookup to finish');
  assert.deepEqual(asked, [folder]);
  assert.equal(lanes[0].cards[0].repo, null);
  assert.equal(lanes[0].cards[0].lane, path.basename(folder), 'the folder’s name for now');
  answer('acme/widgets');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const found = (await board.snapshot()).lanes[0].cards[0];
  assert.equal(found.repo, 'acme/widgets', 'the next snapshot has it, not the kept one');
  assert.equal(found.lane, 'acme/widgets');
});

test('the process tree says which session runs a listener', () => {
  const parents = new Map([
    [500, 400], // the wait, run by a shell
    [400, 300], // the shell, run by Claude Code
    [300, 1],
  ]);
  const sessions = new Map([[300, 'session-a']]);
  assert.equal(sessionOfPid(500, parents, sessions), 'session-a');
  assert.equal(sessionOfPid(300, parents, sessions), 'session-a');
  assert.equal(sessionOfPid(600, parents, sessions), null, 'no such process');
  assert.equal(sessionOfPid(500, new Map(), sessions), null, 'ps could not say');
  const loop = new Map([
    [1, 2],
    [2, 1],
  ]);
  assert.equal(sessionOfPid(1, loop, sessions), null, 'a loop ends');
});

test('a handling listener, whose wait has exited, finds its session again', () => {
  const live = [
    { session: 'session-a', pid: 300 },
    { session: 'session-b', pid: 310 },
  ] as LiveSession[];
  const sessions = new Map([
    [300, 'session-a'],
    [310, 'session-b'],
  ]);
  const handling = (extra: Partial<Listener> = {}) =>
    ({ consumer: 'repo-acme-widgets', pid: 500, state: 'handling', ...extra }) as Listener;
  // the wait ran in session-a, so its handling beat (pid gone from ps) is session-a's
  const memory = new Map<string, string>();
  const parents = new Map([[500, 300]]);
  adoptHandlers([handling({ state: 'waiting' })], live, parents, sessions, memory);
  assert.equal(memory.get('repo-acme-widgets'), 'session-a');
  const later = new Map<number, number>();
  adoptHandlers([handling()], live, later, sessions, memory);
  assert.equal(sessionOfPid(500, later, sessions), 'session-a');
  // nothing remembered: it stays unplaced; a session that is gone is forgotten
  // after a bridge restart (nothing remembered) a beat that names a live session says which it is
  const named = new Map<number, number>();
  adoptHandlers([handling({ session: 'session-b' })], live, named, sessions, new Map());
  assert.equal(sessionOfPid(500, named, sessions), 'session-b');
  const stale = new Map<number, number>();
  adoptHandlers([handling({ session: 'session-z' })], live, stale, sessions, new Map());
  assert.equal(sessionOfPid(500, stale, sessions), null, 'a session that is gone');
  const unknown = new Map<number, number>();
  adoptHandlers([handling()], live, unknown, sessions, new Map());
  assert.equal(sessionOfPid(500, unknown, sessions), null);
  const gone = new Map([['repo-acme-widgets', 'session-z']]);
  const none = new Map<number, number>();
  adoptHandlers([handling()], live, none, sessions, gone);
  assert.equal(sessionOfPid(500, none, sessions), null);
  assert.equal(gone.size, 0);
});

test('the listener history keeps recent repos, and when a stretch of listening began', () => {
  const home = tmp('board-history');
  const day = 24 * 3600 * 1000;
  const start = Date.parse('2026-10-20T12:00:00Z');
  noteListener(home, 'Acme/Widgets', 'repo-acme-widgets', start);
  noteListener(home, 'Acme/Widgets', 'repo-acme-widgets', start + 30 * 1000); // within the gap: the same stretch
  let entry = readHistory(home, start + 60 * 1000)['acme/widgets'];
  assert.equal(entry.started_at, new Date(start).toISOString());
  assert.equal(entry.repo, 'Acme/Widgets');
  noteListener(home, 'Acme/Widgets', 'repo-acme-widgets', start + 3 * 3600 * 1000); // hours later: a new stretch
  entry = readHistory(home, start + 3 * 3600 * 1000)['acme/widgets'];
  assert.equal(entry.started_at, new Date(start + 3 * 3600 * 1000).toISOString());
  assert.ok(
    readHistory(home, start + 3 * 3600 * 1000 + 6 * day)['acme/widgets'],
    'six days on: still there',
  );
  assert.equal(
    readHistory(home, start + 3 * 3600 * 1000 + 8 * day)['acme/widgets'],
    undefined,
    'a week on: gone',
  );
});

test('a repo listener stops when no page has shown its stories for the window, and when the board says so', () => {
  const home = tmp('board-stop');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  prStory(home, 'other-thing-1', 'other/thing', 1, 'feat/y');
  const stories = new StoryStore({ home });
  const window = 10 * 60 * 1000;
  const start = Date.parse('2026-10-26T12:00:00Z');
  const ask = (now: number, extra: Record<string, unknown> = {}) =>
    repoStopReason({
      home,
      stories,
      repo: 'acme/widgets',
      consumer: 'c',
      startedAt: start,
      idleMs: window,
      now,
      ...extra,
    });
  assert.equal(ask(start + 5 * 60 * 1000), null, 'inside the window');
  assert.match(
    ask(start + 11 * 60 * 1000) as string,
    /no page has shown one of its stories for 10 minutes/,
  );
  // a page showing one of the repo's stories restarts the window; another repo's story does not
  writeJson(path.join(home, 'state', 'other-thing-1', 'seen.json'), {
    at: new Date(start + 9 * 60 * 1000).toISOString(),
  });
  assert.ok(ask(start + 11 * 60 * 1000), 'another repo’s page does not count');
  writeJson(path.join(home, 'state', 'acme-widgets-7', 'seen.json'), {
    at: new Date(start + 9 * 60 * 1000).toISOString(),
  });
  assert.equal(ask(start + 11 * 60 * 1000), null);
  assert.ok(ask(start + 20 * 60 * 1000));
  // a fix request or a build the listener holds keeps it going
  writeJson(path.join(home, 'fixes.json'), {
    f1: {
      id: 'f1',
      story: 'acme-widgets-7',
      repo: 'acme/widgets',
      kind: 'github',
      notes: [],
      requested_at: 'x',
      status: 'pending',
      claimed_by: 'c',
      claimed_at: 'x',
    },
  });
  assert.equal(ask(start + 20 * 60 * 1000), null, 'a fix request in hand');
  // the board's Stop listening: a request after the wait started ends it, one before does not
  assert.equal(stopRequested(home, 'acme/widgets', start), null);
  requestStop(home, 'Acme/Widgets', start + 1000);
  assert.equal(stopRequested(home, 'acme/widgets', start), 'stopped from the board');
  assert.equal(
    stopRequested(home, 'acme/widgets', start + 2000),
    null,
    'a wait started after it is not affected',
  );
  assert.equal(stopRequested(home, 'other/thing', start), null);
});

test('`once-upon wait --repo` stops itself when idle and when the board asks, says so, and logs it', async () => {
  const home = tmp('board-wait');
  writeJson(path.join(home, 'config.json'), {
    port: 48997,
    token: TOKEN,
    listen_idle_minutes: 0.02,
  });
  const idle = await runCli(home, ['wait', '--repo', 'acme/widgets', '--timeout', '30']);
  assert.equal(idle.code, 0);
  assert.match(
    idle.stdout,
    /Stopped listening for acme\/widgets: no page has shown one of its stories for 1 second/,
  );
  assert.match(idle.stdout, /Don't start this wait again/);
  assert.match(
    readFileSync(path.join(home, 'listeners.log'), 'utf8'),
    /stopped listening for acme\/widgets: no page has shown/,
  );
  const json = await runCli(home, ['wait', '--repo', 'acme/widgets', '--timeout', '30', '--json']);
  assert.equal(JSON.parse(json.stdout.trim().split('\n').pop() as string).type, 'listen_stopped');
  // the listener's own history notes the repo
  assert.ok(readHistory(home)['acme/widgets']);
  // --no-auto-stop turns it off: the wait runs to its timeout instead
  const kept = await runCli(home, [
    'wait',
    '--repo',
    'acme/widgets',
    '--timeout',
    '3',
    '--no-auto-stop',
  ]);
  assert.equal(kept.code, 2);
  // the board's stop request ends a wait that would otherwise go on
  writeJson(path.join(home, 'config.json'), { port: 48997, token: TOKEN, listen_idle_minutes: 60 });
  const before = Date.now();
  const waiting = runCli(home, ['wait', '--repo', 'acme/widgets', '--timeout', '30']);
  // the wait's first beat says it has started (the stop only reaches waits that started before it)
  const listenersDir = path.join(home, 'listeners');
  const beatFresh = () =>
    existsSync(listenersDir) &&
    readdirSync(listenersDir).some((name) => {
      try {
        return (
          Date.parse(JSON.parse(readFileSync(path.join(listenersDir, name), 'utf8')).at) >= before
        );
      } catch {
        return false;
      }
    });
  for (let i = 0; i < 600 && !beatFresh(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(beatFresh(), 'the wait started');
  requestStop(home, 'acme/widgets');
  const stopped = await waiting;
  assert.match(stopped.stdout, /Stopped listening for acme\/widgets: stopped from the board/);
  assert.match(readFileSync(path.join(home, 'listeners.log'), 'utf8'), /stopped from the board/);
});

test('typing a line into a session’s tab: found by tty, run with Enter', async () => {
  const dir = tmp('board-type');
  const log = path.join(dir, 'calls.txt');
  const it2 = path.join(dir, 'it2');
  writeFileSync(
    it2,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ "$2" = list ]; then
  echo '[{"id":"TAB-2","tty":"\\\\\\\\/dev\\\\\\\\/ttys043"}]'
fi
`,
  );
  chmodSync(it2, 0o755);
  assert.equal(await typeLine(it2, 'ttys043', '/once-upon-listen acme/widgets'), null);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
    'session list --json',
    'session run /once-upon-listen acme/widgets --session TAB-2',
  ]);
  assert.match((await typeLine(it2, 'ttys999', 'x')) as string, /no iTerm tab/);
  assert.match((await typeLine(it2, null, 'x')) as string, /no iTerm tab/);
});

test('POST /api/board/type and /stop-listening: the board key, a live idle session in the right repo, nothing else', async () => {
  const home = tmp('board-type-route');
  const sessions = tmp('board-sessions');
  const checkout = checkoutOf('widgets', 'main');
  registry(sessions, process.pid, { cwd: checkout, status: 'busy' }, procStartOf(process.pid));
  registry(sessions, process.ppid, { cwd: checkout, name: 'idle-one' });
  const it2 = path.join(tmp('board-it2'), 'it2');
  writeFileSync(it2, "#!/bin/sh\necho '[]'\n");
  chmodSync(it2, 0o755);
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: it2,
    board_status_source: 'iterm',
  });
  const bridge = await startBridge({ home });
  open.push(bridge);
  const post = (route: string, body: unknown, key = boardKey(TOKEN)) =>
    bridge.call('POST', route, body, { Authorization: `Bearer ${key}` });
  assert.equal((await post('/api/board/type', {})).status, 400);
  assert.equal(
    (await post('/api/board/type', { kind: 'rm', session: fullId(process.pid) })).status,
    400,
  );
  assert.equal(
    (await post('/api/board/type', { kind: 'listen', session: 'nope', repo: 'acme/widgets' }))
      .status,
    404,
  );
  const busy = await post('/api/board/type', {
    kind: 'listen',
    session: fullId(process.pid),
    repo: 'acme/widgets',
  });
  assert.equal(busy.status, 409);
  assert.match(busy.text, /session busy/);
  const wrongRepo = await post('/api/board/type', {
    kind: 'listen',
    session: fullId(process.ppid),
    repo: 'acme/gadgets',
  });
  assert.match(wrongRepo.text, /not in a checkout of acme\/gadgets/);
  assert.equal(
    (
      await post('/api/board/type', {
        kind: 'listen',
        session: fullId(process.ppid),
        repo: 'not a repo',
      })
    ).status,
    400,
  );
  const nothing = await post('/api/board/type', { kind: 'build', session: fullId(process.ppid) });
  assert.match(nothing.text, /nothing to build/);
  // a session whose tab can't be found is not typed into
  const noTab = await post('/api/board/type', {
    kind: 'listen',
    session: fullId(process.ppid),
    repo: 'acme/widgets',
  });
  assert.equal(noTab.status, 409);
  assert.match(noTab.text, /no iTerm tab/);
  for (const key of [pageKey(TOKEN, 'x')]) {
    assert.equal(
      (await post('/api/board/type', { kind: 'listen', session: 's', repo: 'a/b' }, key)).status,
      403,
    );
    assert.equal((await post('/api/board/stop-listening', { repo: 'a/b' }, key)).status, 403);
  }
  // stop: a request for the repo, which a wait that started before it sees
  assert.equal((await post('/api/board/stop-listening', { repo: 'bad repo' })).status, 400);
  const before = Date.now();
  assert.equal((await post('/api/board/stop-listening', { repo: 'acme/widgets' })).status, 200);
  assert.equal(stopRequested(home, 'acme/widgets', before - 1000), 'stopped from the board');
});

test('listeners on the board: a story’s listener marks its card, repos get a lane, Build story picks an idle session', async () => {
  const home = tmp('board-listeners');
  const sessions = tmp('board-sessions');
  const children = [liveChild(), liveChild(), liveChild(), liveChild()];
  after(() => children.forEach((child) => child.stop()));
  const [onStory, onBuild, busyOne, inGadgets] = children;
  const widgetsX = checkoutOf('widgets', 'feat/x');
  const widgetsY = checkoutOf('widgets', 'feat/y');
  const widgetsZ = checkoutOf('widgets', 'feat/z');
  const gadgets = checkoutOf('gadgets', 'main');
  registry(sessions, onStory.pid, { cwd: widgetsX, name: 'story-one' }, onStory.procStart);
  registry(sessions, onBuild.pid, { cwd: widgetsY, name: 'build-one' }, onBuild.procStart);
  registry(
    sessions,
    busyOne.pid,
    { cwd: widgetsZ, name: 'busy-one', status: 'busy' },
    busyOne.procStart,
  );
  registry(sessions, inGadgets.pid, { cwd: gadgets, name: 'gadgets-one' }, inGadgets.procStart);
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  // two live listeners (beats the wait writes): one for the story, one for the repo; and a repo that listened two days ago
  const beat = (consumer: string, extra: Record<string, unknown>) =>
    writeJson(path.join(home, 'listeners', `${consumer}.json`), {
      consumer,
      pid: process.pid,
      state: 'waiting',
      at: NOW.toISOString(),
      ...extra,
    });
  beat('story-acme-widgets-7', { story: 'acme-widgets-7' });
  beat('repo-acme-widgets', { repo: 'acme/widgets' });
  writeJson(path.join(home, 'listener-history.json'), {
    'acme/gadgets': {
      repo: 'acme/gadgets',
      consumer: 'repo-acme-gadgets',
      started_at: new Date(NOW.getTime() - 2 * 24 * 3600 * 1000).toISOString(),
      last_seen: new Date(NOW.getTime() - 2 * 24 * 3600 * 1000).toISOString(),
    },
    'old/repo': {
      repo: 'old/repo',
      consumer: 'c',
      started_at: '2026-10-01T00:00:00Z',
      last_seen: '2026-10-01T00:00:00Z',
    },
  });
  writeJson(path.join(home, 'handed.json'), {
    q1: {
      consumer: 'repo-acme-widgets',
      at: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
    },
  });
  const { watcher } = fakeWatcher(
    [
      prInfo(7, { branch: 'feat/x' }),
      prInfo(30, { branch: 'feat/y' }),
      prInfo(31, { branch: 'feat/z' }),
    ],
    {
      'acme/widgets@feat/y': { number: 30, state: 'open', merged_at: null },
      'acme/widgets@feat/z': { number: 31, state: 'open', merged_at: null },
    },
  );
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({
      [String(onStory.pid).padStart(8, '0')]: { status: 'done', detail: null },
      [String(onBuild.pid).padStart(8, '0')]: { status: 'done', detail: null },
      [String(inGadgets.pid).padStart(8, '0')]: { status: 'done', detail: null },
    }),
    now: () => NOW,
  });
  const data = await board.snapshot();
  const cards = data.lanes.flatMap((lane) => lane.cards);
  const card = (id: string) => cards.find((found) => found.id === id) as BoardCard;

  // the story's own listener: a mark on its card (the wait's process is this test's, so no session is found)
  assert.equal(card('pr:acme/widgets#7').listening?.consumer, 'story-acme-widgets-7');
  assert.equal(card('pr:acme/widgets#30').listening, null);

  // Build story: only where there is a session and a PR or branch but no story; the idle mapped session is picked, a busy one blocks it
  assert.equal(card('pr:acme/widgets#7').build, null, 'it has a story');
  assert.deepEqual(card('pr:acme/widgets#30').build, {
    session: fullId(onBuild.pid),
    prompt: '/once-upon https://github.com/acme/widgets/pull/30',
    blocked: null,
  });
  assert.deepEqual(card('pr:acme/widgets#31').build, {
    session: null,
    prompt: '/once-upon https://github.com/acme/widgets/pull/31',
    blocked: 'no iTerm tab',
  });
  assert.equal(card(fullId(inGadgets.pid)).build, null, 'a session alone has no branch to build');

  // the Listeners lane: the repo with a listener first, then the one from the last week; not the one from long ago
  assert.deepEqual(
    data.listeners.map((entry) => [entry.repo, !!entry.active]),
    [
      ['acme/widgets', true],
      ['acme/gadgets', false],
    ],
  );
  const [widgets, gadgetsRow] = data.listeners;
  assert.equal(widgets.active?.consumer, 'repo-acme-widgets');
  assert.equal(widgets.active?.state, 'waiting');
  assert.equal(
    widgets.active?.last_handled_at,
    new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
  );
  assert.ok(widgets.active?.since, 'the board noted when it began');
  assert.equal(gadgetsRow.last_seen, new Date(NOW.getTime() - 2 * 24 * 3600 * 1000).toISOString());
  // Start listening offers an idle session in that repo whose tab is known
  assert.deepEqual(
    gadgetsRow.candidates.map((candidate) => [candidate.id, candidate.title, candidate.status]),
    [[fullId(inGadgets.pid), 'Tab title', 'done']],
  );
  assert.deepEqual(
    widgets.candidates.map((candidate) => candidate.id).sort(),
    [fullId(onStory.pid), fullId(onBuild.pid)].sort(),
    'the busy session is not offered',
  );
});

/** A process that runs a child, as a Claude Code session runs a `once-upon wait`: the parent's pid and the child's. */
function parentWithChild(): Promise<{
  parent: number;
  child: number;
  procStart: string;
  stop: () => void;
}> {
  const shell = spawn('sh', ['-c', 'sleep 60 & echo $!; wait']);
  return new Promise((resolve) => {
    shell.stdout.once('data', (chunk) => {
      resolve({
        parent: shell.pid as number,
        child: Number(String(chunk).trim()),
        procStart: procStartOf(shell.pid as number),
        stop: () => {
          shell.kill();
          try {
            process.kill(Number(String(chunk).trim()));
          } catch {
            /* gone already */
          }
        },
      });
    });
  });
}

test('a session that listens is in the Listeners lane alone, busy or not, and is a card only for other work', async () => {
  const tree = await parentWithChild();
  after(() => tree.stop());
  const sid = String(tree.parent).padStart(8, '0');
  const checkout = checkoutOf('widgets', 'main');
  type Case = {
    registry?: Record<string, unknown>;
    beat?: Record<string, unknown>;
    tasks?: number;
    status?: 'working' | 'waiting';
    ledger?: string;
  };
  const world = async (variant: Case) => {
    const home = tmp('board-quiet');
    const sessions = tmp('board-sessions');
    registry(
      sessions,
      tree.parent,
      { cwd: checkout, name: 'listener-one', ...variant.registry },
      tree.procStart,
    );
    const ledger = path.join(tmp('board-notes'), 'ledger.md');
    writeFileSync(ledger, variant.ledger ?? '');
    writeJson(path.join(home, 'config.json'), {
      board_sessions_dir: sessions,
      board_ledger_file: ledger,
      board_ledger_time_zone: 'UTC',
    });
    writeJson(path.join(home, 'listeners', 'repo-acme-widgets.json'), {
      consumer: 'repo-acme-widgets',
      pid: tree.child,
      state: 'waiting',
      at: NOW.toISOString(),
      repo: 'acme/widgets',
      ...variant.beat,
    });
    const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying({
        [sid]: {
          status: variant.status ?? ('working' as const),
          // the wording is nobody's business: the count is what iTerm's `background_tasks` says
          detail: 'zzz reworded status line',
          tasks: variant.tasks ?? 1,
        },
      }),
      now: () => NOW,
    });
    const data = await board.snapshot();
    return { data, cards: data.lanes.flatMap((lane) => lane.cards) };
  };
  const mine = (cards: BoardCard[]) =>
    cards.filter((card) => card.sessions.some((session) => session.id === fullId(tree.parent)));

  // only its wait is running: no card, and the lane names the session, not busy
  const quiet = await world({});
  assert.equal(mine(quiet.cards).length, 0, 'no card');
  assert.equal(quiet.data.listeners[0].repo, 'acme/widgets');
  assert.equal(quiet.data.listeners[0].active?.session, fullId(tree.parent));
  assert.equal(quiet.data.listeners[0].active?.title, 'Tab title');
  assert.equal(quiet.data.listeners[0].active?.busy, false, 'not busy');
  // it picked up a request (the wait handed it over): still only in the lane, which says it is busy
  const handling = await world({ beat: { state: 'handling' } });
  assert.equal(mine(handling.cards).length, 0, 'handling a request: no card');
  assert.equal(handling.data.listeners[0].active?.session, fullId(tree.parent));
  assert.equal(handling.data.listeners[0].active?.busy, true);
  // a turn is running (answering): no card, busy in the lane
  const busy = await world({ registry: { status: 'busy' } });
  assert.equal(mine(busy.cards).length, 0, 'a turn is running: no card');
  assert.equal(busy.data.listeners[0].active?.session, fullId(tree.parent), 'still in the lane');
  assert.equal(busy.data.listeners[0].active?.busy, true);
  // a background task besides its wait: no card, busy in the lane
  const tasks = await world({ tasks: 2 });
  assert.equal(mine(tasks.cards).length, 0, 'another task: no card');
  assert.equal(tasks.data.listeners[0].active?.busy, true);
  // real other work stays a card: a subagent in the ledger, a tab waiting on you
  const withAgent = await world({
    ledger: `- [running] sid:${sid} helper (sonnet, low) — a task — started 2:50 PM ET, 10/26`,
  });
  assert.equal(mine(withAgent.cards).length, 1, 'a subagent is running: a card');
  assert.equal(mine((await world({ status: 'waiting' })).cards).length, 1, 'waiting on you');
  // no listener at all: an ordinary card
  const none = await (async () => {
    const home = tmp('board-no-wait');
    const sessions = tmp('board-sessions');
    registry(sessions, tree.parent, { cwd: checkout, name: 'plain' }, tree.procStart);
    writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
    const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying({ [sid]: { status: 'working', detail: 'zzz', tasks: 1 } }),
      now: () => NOW,
    });
    return (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  })();
  assert.equal(mine(none).length, 1, 'no listener: a card');
});

test('[plan] and [fixing] are ledger statuses: a later [running] or [done] clears them, and a reviewer is a running review-* agent', () => {
  const agents = parseLedger(
    [
      '- [running] sid:aaaaaaaa lane:widgets builder (sonnet, high) — build feat/x → notes/p.md — started 10:18 AM ET, 10/26',
      '- [plan] sid:aaaaaaaa lane:widgets builder — 10:30 AM ET, 10/26 — plan ready: three steps — notes/p.md',
      '- [running] sid:aaaaaaaa lane:widgets review-x (opus, default) — review of feat/x — started 10:40 AM ET, 10/26',
      '- [done] sid:aaaaaaaa lane:widgets review-x — 10:50 AM ET, 10/26 — 9 findings (0 high, 2 med, 7 low), notes/r.md',
      '- [fixing] sid:aaaaaaaa lane:widgets review-x — 10:55 AM ET, 10/26 — 5 findings — notes/r.md',
      '- [plan] sid:aaaaaaaa planner — 11:00 AM ET, 10/26 — plan ready',
      '- [running] sid:aaaaaaaa planner — 11:05 AM ET, 10/26 — plan checked, building',
      '- [running] sid:aaaaaaaa review-y (opus, default) — review of PR #4 — started 11:10 AM ET, 10/26',
      '- [fixing] sid:aaaaaaaa fixer — 11:15 AM ET, 10/26 — fixing the clear bugs',
    ].join('\n'),
    NOW,
  );
  const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent]));
  assert.equal(byName['builder'].state, 'plan');
  assert.equal(byName['builder'].ended?.toISOString(), '2026-10-26T14:30:00.000Z');
  assert.equal(byName['builder'].outcome, 'plan ready: three steps');
  assert.equal(
    byName['builder'].task,
    'build feat/x → notes/p.md',
    'the task from its running line is kept',
  );
  assert.equal(byName['review-x'].state, 'fixing');
  assert.equal(byName['planner'].state, 'running');
  assert.deepEqual(gateOf(byName['builder']), { kind: 'plan', findings: null });
  assert.deepEqual(gateOf(byName['review-x']), { kind: 'fixing', findings: 5 });
  assert.deepEqual(gateOf(byName['fixer']), { kind: 'fixing', findings: null });
  assert.deepEqual(gateOf(byName['review-y']), { kind: 'review', findings: null });
  assert.equal(
    gateOf(byName['planner']),
    null,
    'a running agent that is not a reviewer is not at a gate',
  );
  const done = parseLedger(
    '- [running] sid:aaaaaaaa review-x — t — started 10:40 AM ET, 10/26\n- [done] sid:aaaaaaaa review-x — 10:50 AM ET, 10/26 — 2 findings',
    NOW,
  );
  assert.equal(gateOf(done[0]), null, 'a finished reviewer is not at a gate');
});

test('an agent that says [review] puts a card with no PR in Ready, never Waiting; a real question still wins', () => {
  const none = { sessions: [], agents: [], pr: null, story: null };
  const review = { status: 'waiting' as const, state: 'waiting' as const, review: true };
  assert.equal(columnOf({ ...none, agents: [review] }), 'ready');
  assert.equal(
    columnOf({ ...none, agents: [review, { status: 'waiting', state: 'waiting' }] }),
    'waiting',
  );
  assert.equal(
    columnOf({ ...none, agents: [review], sessions: [{ status: 'waiting' }] }),
    'waiting',
  );
  assert.equal(
    columnOf({ ...none, agents: [review, { status: 'working', state: 'running' }] }),
    'working',
  );
  assert.equal(columnOf({ ...none, agents: [{ status: 'waiting', state: 'waiting' }] }), 'waiting');
});

test('a story marked reviewed takes a card out of Ready even while an agent says [review]; an unreviewed one stays; a PR ignores it', () => {
  const review = { status: 'waiting' as const, state: 'waiting' as const, review: true };
  const none = { sessions: [], agents: [review], pr: null };
  const story = { reviewed: false, manualReviewedAt: null, unread: false, local: true };
  assert.equal(columnOf({ ...none, story }), 'ready');
  assert.equal(columnOf({ ...none, story: { ...story, reviewed: true } }), 'idle');
  assert.equal(columnOf({ ...none, story: { ...story, reviewed: true, approved: true } }), 'ship');
  assert.equal(
    columnOf({
      ...none,
      story: { ...story, unread: true },
      pr: prInfo(7, { review_requested: false }),
    }),
    'pr_open',
  );
});

test('Agent checks sits under Waiting and above Working in the first-match order', () => {
  const none = { sessions: [], agents: [], pr: null, story: null };
  const gate = (kind: 'plan' | 'review' | 'fixing') => ({
    status: 'working' as const,
    state: kind === 'review' ? ('running' as const) : kind,
    gate: { kind, findings: null },
  });
  for (const kind of ['plan', 'review', 'fixing'] as const) {
    assert.equal(columnOf({ ...none, agents: [gate(kind)] }), 'checks', kind);
    // the session is busy while it checks the plan or fixes the findings, and the card is still at the gate
    assert.equal(
      columnOf({ ...none, agents: [gate(kind)], sessions: [{ status: 'working' }] }),
      'checks',
    );
    assert.equal(
      columnOf({ ...none, agents: [gate(kind), { status: 'working', state: 'running' }] }),
      'checks',
    );
    // the user being needed still wins
    assert.equal(
      columnOf({ ...none, agents: [gate(kind)], sessions: [{ status: 'waiting' }] }),
      'waiting',
    );
    assert.equal(
      columnOf({ ...none, agents: [gate(kind), { status: 'waiting', state: 'waiting' }] }),
      'waiting',
    );
  }
  // an agent that is just running, or a finished reviewer, is not a gate
  assert.equal(
    columnOf({ ...none, agents: [{ status: 'working', state: 'running', gate: null }] }),
    'working',
  );
  assert.equal(
    columnOf({ ...none, agents: [{ status: 'done', state: 'done', gate: null }] }),
    'idle',
  );
});

/** A wall-clock time on 10/26 in ET (EDT, UTC-4), for the registry's `at`. */
const etAt = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 26, hour + 4, minute));

test('the board: Agent checks holds a PR card with a gated agent in it, an agent card for one with no card, and Waiting still wins', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  const children = [liveChild(), liveChild(), liveChild()];
  after(() => children.forEach((child) => child.stop()));
  const [launcher, onStory, onY] = children;
  const sid = (child: { pid: number }) => String(child.pid).padStart(8, '0');
  const gadgets = checkoutOf('gadgets', 'main');
  const widgetsX = checkoutOf('widgets', 'feat/x');
  const widgetsY = checkoutOf('widgets', 'feat/y');
  // the launching session is in another repo, on its default branch; the work is on feat/x (a story) and feat/y (a PR)
  registry(
    sessions,
    launcher.pid,
    { cwd: gadgets, name: 'launcher', status: 'busy' },
    launcher.procStart,
  );
  registry(
    sessions,
    onStory.pid,
    { cwd: widgetsX, name: 'story-one', status: 'busy' },
    onStory.procStart,
  );
  registry(sessions, onY.pid, { cwd: widgetsY, name: 'branch-y' }, onY.procStart);
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  // registered agents: a plan and a running reviewer for PR 7, launched by a session that is not on its branch
  const registered = new AgentRegistry(home);
  const launched = { sid: sid(launcher), lane: 'widgets', repo: 'acme/widgets' };
  registered.start({
    ...launched,
    name: 'builder',
    kind: 'author',
    task: 'build on feat/x → notes/p.md',
    branch: 'feat/x',
    at: etAt(14, 0),
  });
  registered.state('builder', {
    state: 'plan',
    outcome: 'plan ready: three steps',
    notes: 'notes/p.md',
    at: etAt(14, 10),
  });
  registered.start({
    ...launched,
    name: 'review-seven',
    kind: 'critic',
    task: 'review of PR #7 diff',
    pr: 7,
    at: etAt(14, 20),
  });
  // findings being fixed on feat/y, and a reviewer for a branch that has no card
  registered.start({
    ...launched,
    name: 'review-why',
    kind: 'critic',
    task: 'review of feat/y diff',
    branch: 'feat/y',
    at: etAt(14, 0),
  });
  registered.state('review-why', {
    state: 'fixing',
    findings: 3,
    outcome: '3 findings',
    notes: 'notes/r.md',
    at: etAt(14, 30),
  });
  registered.start({
    ...launched,
    lane: 'elsewhere',
    name: 'review-lost',
    kind: 'critic',
    task: 'review of feat/none',
    branch: 'feat/none',
    at: etAt(14, 40),
  });
  // a finished reviewer is not at a gate
  registered.start({
    ...launched,
    name: 'review-old',
    kind: 'critic',
    task: 'review',
    at: etAt(13, 0),
  });
  registered.finish('review-old', { outcome: '4 findings', findings: 4, at: etAt(13, 5) });
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
  });
  const { watcher } = fakeWatcher(
    [prInfo(7, { branch: 'feat/x' }), prInfo(9, { branch: 'feat/y' })],
    { 'acme/widgets@feat/y': { number: 9, state: 'open', merged_at: null } },
  );
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  const data = await board.snapshot();
  const cards = data.lanes.flatMap((lane) => lane.cards);
  const card = (id: string) => cards.find((found) => found.id === id) as BoardCard;

  const seven = card('pr:acme/widgets#7');
  assert.equal(
    seven.column,
    'checks',
    'its session is busy, but a plan and a reviewer are at their gates',
  );
  assert.deepEqual(
    seven.agents.map((agent) => [agent.name, agent.state, agent.gate?.kind]),
    [
      ['builder', 'plan', 'plan'],
      ['review-seven', 'running', 'review'],
    ],
  );
  assert.equal(seven.detail, 'plan check, agent review · review-seven');
  assert.equal(
    seven.since,
    '2026-10-26T18:10:00.000Z',
    'the earliest of the plan time and the review start',
  );
  assert.equal(card(`agent:${sid(launcher)}:builder`), undefined, 'nested, not a card of its own');

  // the findings are being fixed on feat/y, whose session is idle
  const why = card('pr:acme/widgets#9');
  assert.equal(why.column, 'checks');
  assert.deepEqual(
    why.agents.map((agent) => agent.gate),
    [{ kind: 'fixing', findings: 3 }],
  );

  // a gated agent whose registered branch has no card has a card of its own, in the column, on its tag's lane
  const lost = card(`agent:${sid(launcher)}:review-lost`);
  assert.equal(lost.column, 'checks');
  assert.equal(lost.lane, 'elsewhere');
  assert.equal(lost.parent, 'launcher');
  assert.equal(card(`agent:${sid(launcher)}:review-old`), undefined);
  // the launching session's own card is its own business
  assert.equal(card(fullId(launcher.pid)).column, 'working');

  // the user being needed still wins: a card whose session, or agent, is waiting on you is in Waiting whatever gate is on it
  registered.state('builder', {
    state: 'waiting',
    outcome: 'needs Eric: pick A or B',
    notes: 'notes/p.md',
    at: etAt(14, 50),
  });
  const later = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({ [sid(onStory)]: { status: 'waiting', detail: 'asked you something' } }),
    now: () => new Date(NOW.getTime() + 5000),
  });
  const afterwards = (await later.snapshot()).lanes.flatMap((lane) => lane.cards);
  const found = (id: string) => afterwards.find((one) => one.id === id);
  assert.equal(
    found(`agent:${sid(launcher)}:builder`),
    undefined,
    'a registered agent stays in its card',
  );
  assert.equal(found('pr:acme/widgets#7')?.column, 'waiting');
  assert.equal(
    found('pr:acme/widgets#7')?.agents.find((one) => one.name === 'builder')?.state,
    'waiting',
  );
  assert.equal(found('pr:acme/widgets#9')?.column, 'checks');
});

test('an agent parked on your story review is ready for review, not waiting; a question still waits', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  const launcher = liveChild();
  after(() => launcher.stop());
  const sid = String(launcher.pid).padStart(8, '0');
  registry(
    sessions,
    launcher.pid,
    { cwd: checkoutOf('gadgets', 'main'), name: 'launcher' },
    launcher.procStart,
  );
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  const registered = new AgentRegistry(home);
  registered.start({
    sid,
    lane: 'widgets',
    repo: 'acme/widgets',
    name: 'on-pr',
    kind: 'author',
    task: 'build on PR #7',
    pr: 7,
    at: etAt(13, 0),
  });
  registered.state('on-pr', {
    state: 'review',
    outcome: 'story up on PR #7',
    notes: 'notes/a.md',
    at: etAt(14, 0),
  });
  writeFileSync(
    ledger,
    [
      `- [review] sid:${sid} lane:elsewhere on-nothing — 2:10 PM ET, 10/26 — story up — notes/b.md`,
      `- [waiting] sid:${sid} lane:elsewhere asker — 2:20 PM ET, 10/26 — needs Eric: pick A or B`,
    ].join('\n'),
  );
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
  });
  const { watcher } = fakeWatcher([prInfo(7, { branch: 'feat/x' })], {});
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  const card = (id: string) => cards.find((found) => found.id === id) as BoardCard;
  const seven = card('pr:acme/widgets#7');
  assert.notEqual(seven.column, 'waiting', 'a story to review is not a question');
  assert.deepEqual(
    seven.agents.map((agent) => [agent.name, agent.review]),
    [['on-pr', true]],
    'nested in the card its registered PR names',
  );
  assert.equal(card(`agent:${sid}:on-pr`), undefined);
  const lone = card(`agent:${sid}:on-nothing`);
  assert.equal(lone.column, 'ready');
  assert.equal(lone.detail, 'story up');
  assert.equal(card(`agent:${sid}:asker`).column, 'waiting');
});

test('a [review] agent naming a no-PR branch sits in its Ready card; one left a day behind is gone', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  const launcher = liveChild();
  after(() => launcher.stop());
  const sid = String(launcher.pid).padStart(8, '0');
  registry(
    sessions,
    launcher.pid,
    { cwd: checkoutOf('gadgets', 'main'), name: 'launcher' },
    launcher.procStart,
  );
  localStory(home, 'local-feat-x', checkoutOf('widgets', 'feat/x'), 'feat/x');
  const registered = new AgentRegistry(home);
  registered.start({
    sid,
    lane: 'widgets',
    repo: 'acme/widgets',
    name: 'on-x',
    kind: 'author',
    task: 'build on feat/x',
    branch: 'feat/x',
    at: etAt(13, 0),
  });
  registered.state('on-x', {
    state: 'review',
    outcome: 'story up on feat/x, two chapters',
    at: etAt(14, 30),
  });
  writeFileSync(
    ledger,
    [
      `- [review] sid:${sid} lane:widgets lost-review — story up — 2:30 PM ET, 10/24`,
      `- [waiting] sid:${sid} lane:widgets lost-question — 2:30 PM ET, 10/24 — needs Eric: long ago`,
    ].join('\n'),
  );
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
  });
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  const work = cards.find((card) => card.id === 'branch:acme/widgets@feat/x') as BoardCard;
  assert.equal(work.column, 'ready');
  assert.deepEqual(
    work.agents.map((agent) => [agent.name, agent.review]),
    [['on-x', true]],
  );
  assert.equal(
    cards.some((card) => card.agents.some((agent) => agent.name.startsWith('lost-'))),
    false,
  );
});

test('a plan or fixing line that has sat a day is marked stale', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  const child = liveChild();
  after(() => child.stop());
  const sid = String(child.pid).padStart(8, '0');
  registry(
    sessions,
    child.pid,
    { cwd: checkoutOf('widgets', 'main'), name: 'launcher' },
    child.procStart,
  );
  writeFileSync(
    ledger,
    [
      `- [plan] sid:${sid} lane:widgets old-plan — 9:00 AM ET, 10/24 — plan ready`,
      `- [fixing] sid:${sid} lane:widgets review-fresh — 2:30 PM ET, 10/26 — 2 findings`,
    ].join('\n'),
  );
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
  });
  const board = new Board(home, new StoryStore({ home }), fakeWatcher().watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  const stale = cards.find((found) => found.title === 'old-plan');
  assert.equal(stale?.column, 'checks');
  assert.equal(stale?.agents[0].stale, true);
  assert.equal(cards.find((found) => found.title === 'review-fresh')?.agents[0].stale, false);
});

test('the Blank strip: sessions with no prompt yet are chips by place, not cards; a prompt, or a busy or waiting tab, makes a card', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const children = Array.from({ length: 7 }, () => liveChild());
  after(() => children.forEach((child) => child.stop()));
  const [blankA, blankB, blankC, used, busyBlank, waitingBlank, onPr] = children;
  const sid = (child: { pid: number }) => String(child.pid).padStart(8, '0');
  const widgets = checkoutOf('widgets', 'main');
  const gadgets = checkoutOf('gadgets', 'main');
  const folder = tmp('board-plain-folder');
  const widgetsY = checkoutOf('widgets', 'feat/y');
  const blank = { blank: true };
  // two blank sessions in one checkout, one in another repo, one in a folder that is no repo, and one on a branch with a PR
  registry(sessions, blankA.pid, { cwd: widgets, name: 'b-one' }, blankA.procStart, blank);
  registry(sessions, blankB.pid, { cwd: widgets, name: 'a-two' }, blankB.procStart, blank);
  registry(sessions, blankC.pid, { cwd: gadgets, name: 'g-one' }, blankC.procStart, blank);
  registry(sessions, used.pid, { cwd: folder, name: 'has-prompt' }, used.procStart);
  registry(
    sessions,
    busyBlank.pid,
    { cwd: gadgets, name: 'busy-blank', status: 'busy' },
    busyBlank.procStart,
    blank,
  );
  registry(
    sessions,
    waitingBlank.pid,
    { cwd: gadgets, name: 'waiting-blank' },
    waitingBlank.procStart,
    blank,
  );
  registry(sessions, onPr.pid, { cwd: widgetsY, name: 'on-pr' }, onPr.procStart, blank);
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  writeJson(path.join(home, 'listener-history.json'), {
    'acme/gadgets': {
      repo: 'acme/gadgets',
      consumer: 'repo-acme-gadgets',
      started_at: new Date(NOW.getTime() - 3600000).toISOString(),
      last_seen: new Date(NOW.getTime() - 3600000).toISOString(),
    },
  });
  const { watcher } = fakeWatcher([prInfo(9, { branch: 'feat/y' })], {
    'acme/widgets@feat/y': { number: 9, state: 'open', merged_at: null },
  });
  let now = NOW;
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({
      [sid(blankA)]: { status: 'done', detail: null },
      [sid(blankC)]: { status: 'done', detail: null },
      [sid(waitingBlank)]: { status: 'waiting', detail: 'asked you something' },
    }),
    now: () => now,
  });
  const data = await board.snapshot();
  const cards = data.lanes.flatMap((lane) => lane.cards);
  const ids = cards.map((found) => found.id);
  for (const gone of [blankA, blankB, blankC]) {
    assert.ok(!ids.includes(fullId(gone.pid)), `${sid(gone)} is a chip, not a card`);
  }
  assert.deepEqual(
    data.blank.map((group) => [
      group.name,
      group.sessions.map((one) => [one.title, one.can_focus]),
    ]),
    [
      // a tab known for b-one and g-one only; a-two comes first by title
      ['gadgets', [['Tab title', true]]],
      [
        'widgets',
        [
          ['a-two', false],
          ['Tab title', true],
        ],
      ],
    ],
  );
  assert.equal(data.blank[1].sessions[1].id, fullId(blankA.pid));
  // a prompt, a busy tab, a waiting tab: cards as always
  assert.equal(cards.find((found) => found.id === fullId(used.pid))?.column, 'idle');
  assert.equal(cards.find((found) => found.id === fullId(busyBlank.pid))?.column, 'working');
  assert.equal(cards.find((found) => found.id === fullId(waitingBlank.pid))?.column, 'waiting');
  // on a branch with a PR it stays in that PR's card
  const work = cards.find((found) => found.id === 'pr:acme/widgets#9');
  assert.deepEqual(
    work?.sessions.map((one) => one.id),
    [fullId(onPr.pid)],
  );
  assert.ok(
    !data.blank.flatMap((group) => group.sessions).some((one) => one.id === fullId(onPr.pid)),
  );
  // a blank session that can be typed into is still a candidate for Start listening
  assert.deepEqual(
    data.listeners.find((entry) => entry.repo === 'acme/gadgets')?.candidates.map((one) => one.id),
    [fullId(blankC.pid)],
  );

  // as soon as it has a prompt it is a card (the file grew, so it is read again)
  const file = path.join(
    CLAUDE_DIR,
    'projects',
    widgets.replace(/[^A-Za-z0-9]/g, '-'),
    `${fullId(blankB.pid)}.jsonl`,
  );
  appendFileSync(
    file,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'start on the fix' } }) + '\n',
  );
  now = new Date(NOW.getTime() + 5000);
  const next = await board.snapshot();
  assert.equal(
    next.lanes.flatMap((lane) => lane.cards).find((found) => found.id === fullId(blankB.pid))?.kind,
    'session',
  );
  assert.deepEqual(
    next.blank.find((group) => group.name === 'widgets')?.sessions.map((one) => one.id),
    [fullId(blankA.pid)],
  );
});

test('the Blank check reads transcripts from board_projects_dir', () => {
  const home = tmp('board-settings');
  assert.equal(readSettings(home).board.projectsDir, path.join(CLAUDE_DIR, 'projects'));
  writeJson(path.join(home, 'config.json'), { board_projects_dir: '/x/projects' });
  assert.equal(readSettings(home).board.projectsDir, '/x/projects');
});

// ---------- local stories beside the PR stories

/** A local story as `once-upon local` writes it, in a checkout's .once-upon folder (here the story home), with what a test changes. */
function localStory(
  home: string,
  id: string,
  repoPath: string,
  branch: string | null,
  extra: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
) {
  writeJson(path.join(home, id, 'meta.json'), {
    kind: 'local',
    repo_path: repoPath,
    repo_name: path.basename(repoPath),
    base: 'origin/main',
    head: 'HEAD',
    branch,
    title: `Local ${id}`,
    ...extra,
  });
  writeJson(path.join(home, id, 'chapters.json'), { title: `Story of ${id}`, chapters: [] });
  for (const [name, value] of Object.entries(state)) {
    writeJson(path.join(home, 'state', id, name), value);
  }
}

test('the bridge lists local stories beside the PR stories: Mark reviewed, a story left by the retired turn capture left out', async () => {
  const home = tmp('board-inbox');
  const widgets = checkoutOf('widgets', 'feat/x');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  localStory(home, 'local-widgets-feat-x', widgets, 'feat/x');
  localStory(
    home,
    'local-widgets-seen',
    widgets,
    'feat/seen',
    {},
    {
      'reviewed.json': { at: '2026-10-26T14:00:00Z', by: 'manual' },
    },
  );
  // a story the retired turn capture left carries `turn`, and is not listed
  localStory(home, 'turn-abc', widgets, null, { turn: 'abc', title: 'widgets: a turn' });
  const bridge = await startBridge({ home });
  open.push(bridge);

  const list = storyList(bridge);
  assert.deepEqual(
    list.local_stories
      .map((story) => [story.id, story.repo, story.branch, story.title, story.reviewed_at !== null])
      .sort(),
    [
      ['local-widgets-feat-x', 'acme/widgets', 'feat/x', 'Story of local-widgets-feat-x', false],
      ['local-widgets-seen', 'acme/widgets', 'feat/seen', 'Story of local-widgets-seen', true],
    ],
    'both local stories, not the one a turn made',
  );
  assert.deepEqual(
    list.stories.map((story) => story.id),
    ['acme-widgets-7'],
    'PR stories are as before',
  );
  // Mark reviewed, the way a PR story is, and unmark
  assert.ok(markReviewed(bridge, 'local-widgets-feat-x')?.reviewed_at);
  assert.equal(storyList(bridge).local_stories.filter((story) => !story.reviewed_at).length, 0);
  markReviewed(bridge, 'local-widgets-feat-x', false);
  const undone = storyList(bridge);
  assert.equal(
    undone.local_stories.find((story) => story.id === 'local-widgets-feat-x')?.reviewed_at,
    null,
  );
  assert.equal(markReviewed(bridge, 'turn-abc'), null);
  // the board key hands out the same link
  const asBoard = await bridge.call(
    'POST',
    '/api/board/open-story',
    { story: 'local-widgets-feat-x' },
    { Authorization: `Bearer ${boardKey(TOKEN)}` },
  );
  assert.equal(asBoard.status, 200);
  assert.equal(
    (
      await bridge.call(
        'POST',
        '/api/board/open-story',
        { story: 'turn-abc' },
        { Authorization: `Bearer ${boardKey(TOKEN)}` },
      )
    ).status,
    404,
  );
});

test('local stories older than the story window are not listed', () => {
  const home = tmp('board-inbox');
  const widgets = checkoutOf('widgets', 'feat/x');
  localStory(home, 'local-old', widgets, 'feat/old');
  const old = new Date(NOW.getTime() - 40 * 24 * 3600 * 1000);
  for (const file of ['meta.json', 'chapters.json']) {
    utimesSync(path.join(home, 'local-old', file), old, old);
  }
  localStory(home, 'local-new', widgets, 'feat/new');
  const found = localStories(new StoryStore({ home }), { now: Date.now() });
  assert.deepEqual(
    found.map((story) => story.id),
    ['local-new'],
  );
});

const metaOf = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>;

test('a local story’s built time is when it was told: a refresh of its diff is not a rebuild', async () => {
  const home = tmp('board-inbox');
  const { repo, base } = localRepo();
  const first = createLocalStory({ home, repo, base, head: 'HEAD' });
  const store = new StoryStore({ home });
  const told = metaOf(first.dir).built_at as string;
  assert.ok(told, 'once-upon local records it');
  assert.equal(localStories(store)[0].built_at, told);
  // HEAD moves and a page remakes local.diff and meta.json: newer files, the same story
  await new Promise((resolve) => setTimeout(resolve, 15));
  writeFileSync(path.join(repo, 'one.txt'), 'a\nB\nc\nd\ne\n');
  git(repo, 'commit', '-q', '-am', 'one more');
  const raw = metaOf(first.dir);
  const refreshed = refreshLocal(first.dir, raw as unknown as LocalMeta);
  assert.notEqual(refreshed.head_oid, raw.head_oid, 'the diff was remade');
  assert.ok(Number(store.list()[0].version) > Date.parse(told), 'the folder looks newer');
  assert.equal(refreshed.built_at, told, 'the refresh keeps it');
  assert.equal(localStories(store)[0].built_at, told, 'so it is not a new build');
  // a rebuild (once-upon local again) is
  await new Promise((resolve) => setTimeout(resolve, 15));
  createLocalStory({ home, repo, base, head: 'HEAD', id: first.id });
  const rebuilt = localStories(store)[0].built_at;
  assert.ok(Date.parse(rebuilt) > Date.parse(told), 'a rebuild is a new build');
  // a story made before built_at was kept falls back to its files' time
  const old = new Date(NOW.getTime() - 40 * 24 * 3600 * 1000);
  const meta = metaOf(first.dir);
  delete meta.built_at;
  writeJson(path.join(first.dir, 'meta.json'), meta);
  for (const file of ['meta.json', 'chapters.json', 'local.diff']) {
    utimesSync(path.join(first.dir, file), old, old);
  }
  assert.deepEqual(
    localStories(store, { now: Date.now() }),
    [],
    'older than the window by its files',
  );
});

test('the board: a local story puts its branch in Ready for your review, rebuilt after you opened it too, and makes a branch-only card', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const [onX] = [liveChild()];
  after(() => onX.stop());
  const widgetsX = checkoutOf('widgets', 'feat/x');
  const widgetsMain = checkoutOf('widgets', 'main');
  const elsewhere = tmp('board-no-repo');
  // a session on feat/x, which has a local story; no PR
  registry(sessions, onX.pid, { cwd: widgetsX, name: 'on-x' }, onX.procStart);
  localStory(home, 'local-feat-x', widgetsX, 'feat/x');
  // branch-only cards: unreviewed, and reviewed then rebuilt; and ones that give no card
  localStory(home, 'local-feat-new', widgetsMain, 'feat/new');
  const opened = { 'position.json': { at: '2026-10-26T10:00:00Z' } }; // opened before it was built (the file was written now)
  localStory(home, 'local-feat-rebuilt', widgetsMain, 'feat/rebuilt', {}, opened);
  const byHand = { 'reviewed.json': { at: '2026-10-26T14:00:00Z', by: 'manual' } };
  localStory(
    home,
    'local-feat-done',
    widgetsMain,
    'feat/done',
    {},
    { ...byHand, 'position.json': { at: '2099-01-01T00:00:00Z' } },
  );
  // commits on a default branch, or a range with no branch: a card of their own while they wait for review
  localStory(home, 'local-main', widgetsMain, 'main');
  localStory(home, 'local-detached', widgetsMain, null);
  localStory(
    home,
    'local-main-done',
    widgetsMain,
    'main',
    {},
    {
      ...byHand,
      'position.json': { at: '2099-01-01T00:00:00Z' },
    },
  );
  localStory(home, 'local-norepo', elsewhere, 'feat/y'); // no GitHub repo: no card
  localStory(home, 'turn-abc', widgetsMain, null, { turn: 'abc' });
  // a PR story on feat/pr wins over a local one of the same branch
  prStory(home, 'acme-widgets-5', 'acme/widgets', 5, 'feat/pr');
  localStory(home, 'local-feat-pr', widgetsMain, 'feat/pr');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const { watcher } = fakeWatcher([prInfo(5, { branch: 'feat/pr' })]);
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  const byId = Object.fromEntries(cards.map((found) => [found.id, found]));
  assert.deepEqual(Object.fromEntries(cards.map((found) => [found.id, found.column])), {
    'branch:acme/widgets@feat/x': 'ready', // the session joins it; the story is unreviewed
    'branch:acme/widgets@feat/new': 'ready',
    'branch:acme/widgets@feat/rebuilt': 'ready', // rebuilt since you opened it: a local story is never in Back to you
    'pr:acme/widgets#5': 'pr_open', // the PR story on the branch wins, on GitHub's side
    'story:local-main': 'ready',
    'story:local-detached': 'ready',
  });
  const withSession = byId['branch:acme/widgets@feat/x'];
  assert.equal(withSession.kind, 'work');
  assert.deepEqual(
    withSession.sessions.map((one) => one.title),
    ['on-x'],
  );
  assert.equal(withSession.pr, null);
  assert.deepEqual(withSession.story, {
    id: 'local-feat-x',
    kind: 'local',
    url: null,
    reviewed: false,
    unread: false,
    unread_answers: 0,
    approved_at: null,
    ship: null,
  });
  assert.equal(withSession.lane, 'acme/widgets');
  assert.equal(withSession.build, null, 'it has a story: nothing to build');
  const branchOnly = byId['branch:acme/widgets@feat/new'];
  assert.equal(branchOnly.title, 'Story of local-feat-new');
  assert.equal(branchOnly.branch, 'feat/new');
  assert.equal(branchOnly.sessions.length, 0);
  assert.ok(branchOnly.since, 'ready since it was built');
  assert.equal(byId['branch:acme/widgets@feat/rebuilt'].story?.unread, true);
  assert.equal(
    byId['pr:acme/widgets#5'].story?.id,
    'acme-widgets-5',
    'a PR story is the card’s story',
  );
  assert.equal(byId['pr:acme/widgets#5'].story?.kind, 'pr');
  // a reviewed one, no repo and a story left by turn capture are not cards
  for (const gone of ['feat/done', 'feat/y']) {
    assert.ok(!cards.some((found) => found.branch === gone), gone);
  }
  assert.ok(!cards.some((found) => found.id === 'story:local-main-done'), 'reviewed: no card');
  assert.equal(cards.length, 6, 'the six above, nothing else');
});

test('the board: a session on a branch whose PR merged long ago is a card of its own, not on the branch’s old local story', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const child = liveChild();
  after(() => child.stop());
  const checkout = checkoutOf('widgets', 'feat/old');
  registry(sessions, child.pid, { cwd: checkout, name: 'new-work' }, child.procStart);
  localStory(home, 'local-feat-old', checkout, 'feat/old');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const mergedAt = new Date(NOW.getTime() - 5 * 24 * 3600 * 1000).toISOString();
  const { watcher } = fakeWatcher([], {
    'acme/widgets@feat/old': { number: 9, state: 'merged', merged_at: mergedAt },
  });
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: registrySource,
    now: () => NOW,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  assert.deepEqual(
    cards.map((found) => [found.kind, found.title]),
    [['session', 'new-work']],
  );
});

test('a session card is titled by its tab, else the title in its transcript, else the registry’s name', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const [tabbed, untabbed, untitled] = [liveChild(), liveChild(), liveChild()];
  after(() => [tabbed, untabbed, untitled].forEach((child) => child.stop()));
  const cwd = tmp('board-titles');
  for (const [child, name] of [
    [tabbed, 'tabbed'],
    [untabbed, 'untabbed'],
    [untitled, 'untitled'],
  ] as const) {
    registry(sessions, child.pid, { cwd, name }, child.procStart);
  }
  for (const child of [tabbed, untabbed]) {
    transcript(cwd, fullId(child.pid), [
      ...usedLines(fullId(child.pid)),
      { type: 'ai-title', aiTitle: 'Transcript title', sessionId: fullId(child.pid) },
    ]);
  }
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({
      [String(tabbed.pid).padStart(8, '0')]: { status: 'done', detail: null },
    }),
    now: () => NOW,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  const title = (pid: number) => cards.find((found) => found.id === fullId(pid))?.title;
  assert.equal(title(tabbed.pid), 'Tab title');
  assert.equal(title(untabbed.pid), 'Transcript title');
  assert.equal(title(untitled.pid), 'untitled');
  // when it went quiet comes from the registry, which the tab's status can't move: Done or Idle on the page
  const resting = cards.find((found) => found.id === fullId(untitled.pid))?.sessions[0];
  assert.equal(resting?.rested_at, new Date(NOW.getTime() - 600000).toISOString());
});

test('a started item on the voice session’s or a listening session’s branch says so, and stays past the day', () => {
  const store = new BacklogStore(tmp('board-backlog-cardless'));
  const onVoice = store.add({ title: 'Voice idea', repo: 'acme/widgets' });
  store.start(onVoice.id, { branch: 'feat/voice' });
  const alone = store.add({ title: 'Nobody on it', repo: 'acme/widgets' });
  store.start(alone.id, { branch: 'feat/alone' });
  const later = Date.now() + 2 * 24 * 3600 * 1000;
  const cardless = [{ repo: 'acme/widgets', branch: 'feat/voice', label: 'Voice session' }];
  const started = (now: number) =>
    backlogCards(store.items(), [], now, cardless).map((card) => [
      card.title,
      card.backlog?.started?.on,
    ]);
  assert.deepEqual(started(Date.now()), [
    ['Voice idea', 'Voice session'],
    ['Nobody on it', null],
  ]);
  assert.deepEqual(
    started(later),
    [['Voice idea', 'Voice session']],
    'only the one with no session drops after a day',
  );
});

test('a started backlog item rides on a live session’s card on its new branch, before any PR or story', async () => {
  const home = tmp('board-backlog-session');
  const sessions = tmp('board-backlog-sessions');
  const child = liveChild();
  after(() => child.stop());
  const checkout = checkoutOf('widgets', 'feat/new-idea');
  registry(
    sessions,
    child.pid,
    { cwd: checkout, name: 'idea-one', status: 'busy' },
    child.procStart,
  );
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const store = new BacklogStore(home);
  const item = store.add({ title: 'The new idea', repo: 'acme/widgets' });
  const board = () =>
    new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: registrySource,
      now: () => NOW,
    });
  const find = async () => {
    const cards = (await board().snapshot()).lanes.flatMap((lane) => lane.cards);
    return { cards, session: cards.find((found) => found.kind === 'session') as BoardCard };
  };
  // not started: a card in Backlog, and the session's card is its own
  let seen = await find();
  assert.equal(seen.session.branch, 'feat/new-idea', 'a session card, not a work card');
  assert.equal(seen.session.from_backlog, undefined);
  assert.ok(seen.cards.some((found) => found.column === 'backlog'));
  // started on that branch: no backlog card (not even "no session yet"), and the session's card says where it came from
  store.start(item.id, { branch: 'feat/new-idea', repo: 'acme/widgets' });
  seen = await find();
  assert.deepEqual(seen.session.from_backlog, [{ id: item.id, title: 'The new idea' }]);
  assert.ok(!seen.cards.some((found) => found.column === 'backlog'));
  assert.equal(seen.session.column, 'working', 'its column is the session’s own');
});

/** A local story whose checkout is a real repo (an origin of acme/<name>), told at `builtAt`, with the given heads. */
function builtLocal(
  home: string,
  id: string,
  checkout: string,
  branch: string,
  builtAt: string,
  extra: Record<string, unknown> = {},
  state: Record<string, unknown> = {},
) {
  localStory(home, id, checkout, branch, { built_at: builtAt, ...extra }, state);
}

const DAY = 24 * 3600 * 1000;
const iso = (time: number) => new Date(time).toISOString();
const reviewedBy = (home: string, id: string) =>
  new StoryStore({ home }).readState<{ at: string | null; by: string } | null>(
    id,
    'reviewed.json',
    null,
  )?.by ?? null;

test('local stories: nothing opened, read, marked or rebuilt for 3 days is done (idle), computed and never written; a hand mark or unmark wins', () => {
  assert.equal(LOCAL_IDLE_DAYS, 3);
  const home = tmp('local-idle');
  const widgets = checkoutOf('widgets', 'feat/x');
  const now = Date.parse('2026-10-28T15:00:00Z');
  builtLocal(home, 'local-quiet', widgets, 'feat/quiet', iso(now - 4 * DAY));
  builtLocal(home, 'local-recent', widgets, 'feat/recent', iso(now - 2 * DAY));
  // opened a day ago: the clock runs from then
  builtLocal(
    home,
    'local-opened',
    widgets,
    'feat/opened',
    iso(now - 5 * DAY),
    {},
    {
      'position.json': { at: iso(now - DAY) },
    },
  );
  // unmarked by hand: left alone, however quiet
  builtLocal(
    home,
    'local-unmarked',
    widgets,
    'feat/unmarked',
    iso(now - 6 * DAY),
    {},
    {
      'reviewed.json': { at: null, by: 'manual' },
    },
  );
  builtLocal(
    home,
    'local-hand',
    widgets,
    'feat/hand',
    iso(now - 6 * DAY),
    {},
    {
      'reviewed.json': { at: iso(now - 5 * DAY), by: 'manual' },
    },
  );
  const byId = Object.fromEntries(
    localStories(new StoryStore({ home }), { now }).map((story) => [story.id, story]),
  );
  assert.equal(byId['local-quiet'].reviewed_by, 'idle');
  assert.equal(byId['local-quiet'].reviewed_at, iso(now - DAY), 'done since the cutoff passed');
  assert.equal(byId['local-recent'].reviewed_at, null);
  assert.equal(byId['local-opened'].reviewed_at, null);
  assert.equal(byId['local-unmarked'].reviewed_at, null);
  assert.equal(byId['local-hand'].reviewed_by, 'manual');
  assert.equal(reviewedBy(home, 'local-quiet'), null, 'idle is worked out, not written');
  // a day later the opened one has gone quiet too
  const later = localStories(new StoryStore({ home }), { now: now + 2 * DAY + 1 });
  assert.equal(later.find((story) => story.id === 'local-opened')?.reviewed_by, 'idle');
  assert.equal(later.find((story) => story.id === 'local-unmarked')?.reviewed_at, null);
});

test('local stories: a branch with a PR (open or merged) is done by pr, a default branch is not asked, a hand mark or unmark is left alone', async () => {
  const home = tmp('local-pr');
  const widgets = checkoutOf('widgets', 'feat/x');
  const now = Date.now();
  const built = iso(now - 1000);
  builtLocal(home, 'local-open', widgets, 'feat/open', built);
  builtLocal(home, 'local-merged', widgets, 'feat/merged', built);
  builtLocal(home, 'local-none', widgets, 'feat/none', built);
  builtLocal(home, 'local-main', widgets, 'main', built);
  builtLocal(
    home,
    'local-unmarked',
    widgets,
    'feat/open2',
    built,
    {},
    {
      'reviewed.json': { at: null, by: 'manual' },
    },
  );
  const asked: string[] = [];
  const answers: Record<string, BranchPr | null> = {
    'acme/widgets@feat/open': { number: 1, state: 'open', merged_at: null },
    'acme/widgets@feat/merged': { number: 2, state: 'merged', merged_at: built },
    'acme/widgets@feat/open2': { number: 3, state: 'open', merged_at: null },
  };
  const stories = new StoryStore({ home });
  const review = new AutoReview(
    stories,
    async () => ({ merged: false, why: null }),
    60000,
    async (repo, branch) => {
      asked.push(`${repo}@${branch}`);
      return answers[`${repo}@${branch}`] ?? null;
    },
  );
  const list = () => localEntries(stories, { now });
  review.kickLocal(list(), now); // asks GitHub; it answers a moment later
  await review.idle();
  assert.equal(reviewedBy(home, 'local-open'), null, 'not on the first ask');
  review.kickLocal(list(), now);
  await review.idle();
  assert.equal(reviewedBy(home, 'local-open'), 'pr');
  assert.equal(reviewedBy(home, 'local-merged'), 'pr');
  assert.equal(reviewedBy(home, 'local-none'), null);
  assert.equal(reviewedBy(home, 'local-main'), null);
  assert.ok(!asked.includes('acme/widgets@main'), 'a default branch has no PR to ask for');
  const unmarked = stories.readState<{ at: string | null } | null>(
    'local-unmarked',
    'reviewed.json',
    null,
  );
  assert.equal(unmarked?.at, null, 'an unmark by hand is left alone');
  assert.ok(!asked.includes('acme/widgets@feat/open2'), 'it is not even asked about');
  const inbox = localStories(stories, { now });
  assert.equal(inbox.find((story) => story.id === 'local-open')?.reviewed_by, 'pr');
});

test('local stories: a head already in origin’s default branch is done by delivered; a head not there, a missing ref, or a story with no commits of its own is not', async () => {
  const home = tmp('local-delivered');
  const repo = tmp('local-delivered-repo');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'merged work');
  const merged = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', merged);
  git(repo, 'checkout', '-q', '-b', 'feat/unmerged');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'not merged');
  const unmerged = git(repo, 'rev-parse', 'HEAD');
  const bare = tmp('local-delivered-bare'); // no origin ref at all
  git(bare, 'init', '-q', '-b', 'main');
  git(bare, 'remote', 'add', 'origin', 'git@github.com:acme/gadgets.git');
  git(bare, 'commit', '-q', '--allow-empty', '-m', 'only');
  const only = git(bare, 'rev-parse', 'HEAD');
  const now = Date.now();
  const built = iso(now - 1000);
  builtLocal(home, 'local-in', repo, 'main', built, { base_oid: base, head_oid: merged });
  builtLocal(home, 'local-out', repo, 'feat/unmerged', built, {
    base_oid: base,
    head_oid: unmerged,
  });
  builtLocal(home, 'local-norefs', bare, 'main', built, {
    base_oid: only.slice(0, 1).repeat(40),
    head_oid: only,
  });
  builtLocal(home, 'local-empty', repo, 'main', built, { base_oid: merged, head_oid: merged });
  builtLocal(home, 'local-nohead', repo, 'main', built, {});
  const stories = new StoryStore({ home });
  const review = new AutoReview(
    stories,
    async () => ({ merged: false, why: null }),
    60000,
    async () => null,
  );
  review.kickLocal(localEntries(stories, { now }), now);
  await review.idle();
  assert.equal(reviewedBy(home, 'local-in'), 'delivered');
  assert.equal(reviewedBy(home, 'local-out'), null);
  assert.equal(
    reviewedBy(home, 'local-norefs'),
    null,
    'git answers 128 for a missing ref: not done',
  );
  assert.equal(reviewedBy(home, 'local-empty'), null);
  assert.equal(reviewedBy(home, 'local-nohead'), null);
});

test('local stories: commits rewritten and pushed straight to the default branch are delivered, only with the base in it, no ref holding the head, and nothing unpushed', async () => {
  const home = tmp('local-rewritten');
  const now = Date.now();
  const built = iso(now - 1000);
  /** A checkout whose story commit was then amended; `push` says whether the amended commit is origin's tip. */
  const checkoutOf = (name: string, push: boolean) => {
    const repo = tmp(`local-rewritten-${name}`);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', base);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'the story commit');
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '--amend', '-m', 'the story commit, reworded');
    if (push) {
      git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    }
    return { repo, base, head };
  };
  const pushed = checkoutOf('pushed', true);
  const unpushed = checkoutOf('unpushed', false);
  const feature = checkoutOf('feature', true);
  builtLocal(home, 'local-rewritten', pushed.repo, 'main', built, {
    base_oid: pushed.base,
    head_oid: pushed.head,
  });
  builtLocal(home, 'local-unpushed', unpushed.repo, 'main', built, {
    base_oid: unpushed.base,
    head_oid: unpushed.head,
  });
  builtLocal(home, 'local-feature', feature.repo, 'feat/branch', built, {
    base_oid: feature.base,
    head_oid: feature.head,
  });
  const stories = new StoryStore({ home });
  const review = new AutoReview(
    stories,
    async () => ({ merged: false, why: null }),
    60000,
    async () => null,
  );
  review.kickLocal(localEntries(stories, { now }), now);
  await review.idle();
  assert.equal(reviewedBy(home, 'local-rewritten'), 'delivered');
  assert.equal(reviewedBy(home, 'local-unpushed'), null, 'the amended commit is not pushed yet');
  assert.equal(reviewedBy(home, 'local-feature'), null, 'a branch story is the PR’s to clear');
});

test('the board: a local story rebuilt after you opened it stays in Ready, and one a check marked done (pr, delivered, idle) stays done through a rebuild', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const widgets = checkoutOf('widgets', 'main');
  const opened = { 'position.json': { at: '2026-10-26T10:00:00Z' } }; // before it was built (the file is made now)
  const marked = (reason: string) => ({
    'reviewed.json': { at: '2026-10-26T11:00:00Z', by: reason },
    ...opened,
  });
  localStory(home, 'local-hand', widgets, 'feat/hand', {}, marked('manual'));
  localStory(home, 'local-pr', widgets, 'feat/pr', {}, marked('pr'));
  localStory(home, 'local-delivered', widgets, 'feat/delivered', {}, marked('delivered'));
  localStory(home, 'local-idle', widgets, 'feat/idle', {}, opened);
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const { watcher, asked } = fakeWatcher();
  const later = new Date(Date.now() + 5 * DAY); // idle by then: a rebuild is what would have brought it back
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => later,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  assert.deepEqual(
    Object.fromEntries(cards.map((found) => [found.id, [found.column, found.story?.unread]])),
    { 'branch:acme/widgets@feat/hand': ['ready', true] },
    'a hand mark does not survive a rebuild; the three automatic ones do',
  );
  assert.deepEqual(asked.locals.sort(), [
    'local-delivered',
    'local-hand',
    'local-idle',
    'local-pr',
  ]);
});

test('the board: an unread answer keeps a reviewed local story in Ready and sends a PR card to Back to you, until it is read', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const widgets = checkoutOf('widgets', 'main');
  // reviewed by hand and opened long after it was built: no card, but for the answer
  const done = {
    'reviewed.json': { at: '2026-10-26T14:00:00Z', by: 'manual' },
    'position.json': { at: '2099-01-01T00:00:00Z' },
  };
  localStory(home, 'local-answered', widgets, 'feat/answered', {}, done);
  localStory(home, 'local-quiet', widgets, 'feat/quiet', {}, done);
  prStory(home, 'acme-widgets-5', 'acme/widgets', 5, 'feat/pr');
  const inbox = new Inbox(home);
  for (const story of ['local-answered', 'acme-widgets-5']) {
    inbox.append({ type: 'question', id: `q_${story}`, story, text: 'Why?', step: 1 });
    inbox.append({ type: 'answer', question: `q_${story}`, story, text: 'Because.' });
  }
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const snapshot = async () => {
    const { watcher } = fakeWatcher([prInfo(5, { branch: 'feat/pr' })]);
    const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
      source: sourceSaying({}),
      now: () => NOW,
    });
    const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
    return Object.fromEntries(cards.map((found) => [found.id, found]));
  };
  let byId = await snapshot();
  assert.equal(byId['branch:acme/widgets@feat/answered'].column, 'ready');
  assert.equal(byId['branch:acme/widgets@feat/answered'].story?.unread_answers, 1);
  assert.equal(byId['pr:acme/widgets#5'].column, 'back');
  assert.equal(byId['pr:acme/widgets#5'].story?.unread_answers, 1);
  assert.equal(byId['branch:acme/widgets@feat/quiet'], undefined, 'no answer, nothing to review');

  markQuestions(home, 'local-answered', 'read', ['q_local-answered']);
  markQuestions(home, 'acme-widgets-5', 'read', ['q_acme-widgets-5']);
  byId = await snapshot();
  assert.equal(byId['branch:acme/widgets@feat/answered'], undefined, 'read: the card goes');
  assert.equal(byId['pr:acme/widgets#5'].column, 'pr_open');
  assert.equal(byId['pr:acme/widgets#5'].story?.unread_answers, 0);
});

test('POST /api/board/reviewed: the board page marks a local story reviewed or unmarked, a PR story is a 404, and a story page’s key does not reach it', async () => {
  const home = tmp('board-reviewed');
  const widgets = checkoutOf('widgets', 'feat/x');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  localStory(home, 'local-feat-x', widgets, 'feat/x');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const asBoard = (body: unknown) =>
    bridge.call('POST', '/api/board/reviewed', body, {
      Authorization: `Bearer ${boardKey(TOKEN)}`,
    });
  assert.equal((await asBoard({ story: 'local-feat-x' })).status, 200);
  assert.equal(reviewedBy(home, 'local-feat-x'), 'manual');
  assert.equal((await asBoard({ story: 'local-feat-x', reviewed: false })).status, 200);
  assert.equal(
    new StoryStore({ home }).readState<{ at: string | null } | null>(
      'local-feat-x',
      'reviewed.json',
      null,
    )?.at,
    null,
  );
  assert.equal((await asBoard({ story: 'acme-widgets-7' })).status, 404);
  assert.equal((await asBoard({ story: 'nope' })).status, 404);
  const asStory = await bridge.call(
    'POST',
    '/api/board/reviewed',
    { story: 'local-feat-x' },
    { Authorization: `Bearer ${pageKey(TOKEN, 'local-feat-x')}` },
  );
  assert.equal(asStory.status, 403);
});

test('once-upon reviewed marks a local story reviewed, --undo unmarks it, and a PR story or an unknown id is refused', async () => {
  const home = tmp('cli-reviewed');
  const widgets = checkoutOf('widgets', 'feat/x');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  localStory(home, 'local-feat-x', widgets, 'feat/x');
  const marked = await runCli(home, ['reviewed', 'local-feat-x']);
  assert.equal(marked.code, 0, marked.stderr);
  assert.match(marked.stdout, /local-feat-x marked reviewed/);
  assert.equal(reviewedBy(home, 'local-feat-x'), 'manual');
  const undone = await runCli(home, ['reviewed', 'local-feat-x', '--undo']);
  assert.equal(undone.code, 0, undone.stderr);
  assert.match(undone.stdout, /not reviewed/);
  assert.equal(
    reviewedBy(home, 'local-feat-x'),
    'manual',
    'an unmark is kept: {at: null, by: manual}',
  );
  const flagFirst = await runCli(home, ['reviewed', '--undo', 'local-feat-x']);
  assert.equal(flagFirst.code, 0, flagFirst.stderr);
  for (const args of [['reviewed'], ['reviewed', 'acme-widgets-7'], ['reviewed', 'nope']]) {
    assert.notEqual((await runCli(home, args)).code, 0, args.join(' '));
  }
});

/** A fake it2 that lists no tabs, so statuses fall back to the registry's. */
function fakeIt2(): string {
  const it2 = path.join(tmp('board-it2'), 'it2');
  writeFileSync(it2, "#!/bin/sh\necho '[]'\n");
  chmodSync(it2, 0o755);
  return it2;
}

/** A voice folder saying voice is on in this session (it spoke a minute ago), named for the voice session. */
function voiceOnIn(sessionId: string): string {
  const voiceDir = tmp('board-voice');
  writeJson(path.join(voiceDir, 'session'), { on: true, session_id: sessionId });
  writeFileSync(path.join(voiceDir, 'voice-session-name'), 'clarifi-da\n');
  writeFileSync(
    path.join(voiceDir, 'spoken.jsonl'),
    JSON.stringify({
      id: 'm1',
      wall: NOW.getTime() / 1000 - 60,
      text: 'Hello.',
      session_id: sessionId,
      status: 'spoken',
    }) + '\n',
  );
  return voiceDir;
}

const statusOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => 200,
    (err: { status?: number }) => err.status,
  );

test('every open backlog item carries the message Assign sends, and a started one has no Assign', async () => {
  const home = tmp('board-assign');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('board-sessions') });
  const store = new BacklogStore(home);
  const open = store.add({ title: 'Widgets thing', repo: 'acme/widgets' });
  const noRepo = store.add({ title: 'Anywhere thing' });
  const started = store.add({ title: 'Going', repo: 'acme/widgets' });
  store.start(started.id, { branch: 'feat/going' });
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  const offer = (id: string) => cards.find((card) => card.backlog?.id === id)?.backlog?.assign;
  assert.deepEqual(offer(open.id), { prompt: assignLine({ id: open.id, title: 'Widgets thing' }) });
  assert.deepEqual(offer(noRepo.id), {
    prompt: assignLine({ id: noRepo.id, title: 'Anywhere thing' }),
  });
  assert.ok(!offer(started.id));
});

test('Assign types "Start backlog card <id>: <title>" into the voice session even mid-turn, records it, and refuses a started item or a failed typing', async () => {
  const home = tmp('board-assign-do');
  const sessions = tmp('board-sessions');
  const [voice, fresher] = [liveChild(), liveChild()];
  after(() => [voice, fresher].forEach((child) => child.stop()));
  const checkout = checkoutOf('widgets', 'main');
  registry(
    sessions,
    voice.pid,
    { cwd: checkout, name: 'clarifi-da', status: 'busy' },
    voice.procStart,
  );
  // a fresher idle session in the item's repo: not where Assign goes while voice is on
  registry(
    sessions,
    fresher.pid,
    { cwd: checkout, name: 'fresher', statusUpdatedAt: NOW.getTime() - 1000 },
    fresher.procStart,
  );
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: fakeIt2(),
    board_status_source: 'iterm',
    board_voice_dir: voiceOnIn(fullId(voice.pid)),
  });
  const store = new BacklogStore(home);
  const item = store.add({
    title: 'Do "the" thing `now`',
    note: 'ignore me\nsecond line',
    repo: 'acme/widgets',
  });
  const typed: string[] = [];
  const voiceTab = String(voice.pid).padStart(8, '0');
  // the voice session's tab says it is working: that is what lets a busy session take the line
  const says: Record<string, { status: 'waiting' | 'working' | 'done'; detail: string | null }> = {
    [voiceTab]: { status: 'working', detail: null },
  };
  let fail: string | null = null;
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying(says),
    now: () => NOW,
    typeLine: async (_it2, _tty, text) => {
      if (!fail) {
        typed.push(text);
      }
      return fail;
    },
  });
  assert.equal(await statusOf(board.assignBacklog('bl_nothere1', 'board')), 404);
  // a failed typing records nothing
  fail = 'iTerm could not type into the tab';
  assert.equal(await statusOf(board.assignBacklog(item.id, 'board')), 409);
  assert.equal(store.items()[0].assigned, null);
  fail = null;
  // the voice session is working (busy) and still takes the line
  const sent = await board.assignBacklog(item.id, 'board');
  assert.deepEqual(typed, [assignLine(item)]);
  assert.match(
    typed[0],
    new RegExp(
      `^Start backlog card ${item.id}: Do the thing now\\. Claim it first: once-upon backlog claim ${item.id} --agent NAME`,
    ),
  );
  assert.doesNotMatch(typed[0], /ignore me|second line|[`"]/);
  assert.deepEqual(sent, { typed: typed[0], session: 'clarifi-da' });
  assert.equal(store.items()[0].assigned?.session, fullId(voice.pid));
  assert.equal(store.items()[0].assigned?.branch, assignBranch(item));
  const card = (await board.snapshot()).lanes
    .flatMap((lane) => lane.cards)
    .find((found) => found.backlog?.id === item.id);
  assert.equal(card?.backlog?.assigned?.session_title, 'Tab title');
  assert.ok(card?.backlog?.assign, 'still offered, as Send again');
  // again is fine
  assert.equal(await statusOf(board.assignBacklog(item.id, 'board')), 200);
  assert.equal(typed.length, 2);
  // a voice session waiting on you (a permission prompt) is never typed into, and neither is one whose tab says nothing
  says[voiceTab] = { status: 'waiting', detail: null };
  assert.equal(await statusOf(board.assignBacklog(item.id, 'board')), 409, 'waiting');
  delete says[voiceTab];
  assert.equal(await statusOf(board.assignBacklog(item.id, 'board')), 409, 'no status for the tab');
  assert.equal(typed.length, 2);
  // started: no more assigning
  store.start(item.id, { branch: assignBranch(item) });
  assert.equal(await statusOf(board.assignBacklog(item.id, 'board')), 409);
  assert.equal(typed.length, 2);
});

test('with no voice session, Assign goes to the most recent live interactive session, and only if it is at its prompt', async () => {
  const home = tmp('board-assign-fallback');
  const sessions = tmp('board-sessions');
  const [older, newer] = [liveChild(), liveChild()];
  after(() => [older, newer].forEach((child) => child.stop()));
  const checkout = checkoutOf('widgets', 'main');
  registry(sessions, older.pid, { cwd: checkout, name: 'older' }, older.procStart);
  registry(
    sessions,
    newer.pid,
    { cwd: checkout, name: 'newer', statusUpdatedAt: NOW.getTime() - 1000 },
    newer.procStart,
  );
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: fakeIt2(),
    board_status_source: 'iterm',
  });
  const item = new BacklogStore(home).add({ title: 'Thing', repo: 'acme/widgets' });
  const typed: string[] = [];
  const make = (dir: string) =>
    new Board(dir, new StoryStore({ home: dir }), noPrWatcher, new Builds(dir), {
      source: sourceSaying({}),
      now: () => NOW,
      typeLine: async (_it2, _tty, text) => {
        typed.push(text);
        return null;
      },
    });
  const board = make(home);
  assert.equal((await board.assignBacklog(item.id, 'board')).session, 'newer');
  assert.equal(typed.length, 1);
  registry(
    sessions,
    newer.pid,
    { cwd: checkout, name: 'newer', status: 'busy', statusUpdatedAt: NOW.getTime() - 1000 },
    newer.procStart,
  );
  assert.equal(await statusOf(board.assignBacklog(item.id, 'board')), 409, 'busy: refused');
  assert.equal(typed.length, 1);
  // no live session at all
  const empty = tmp('board-home-empty');
  writeJson(path.join(empty, 'config.json'), {
    board_sessions_dir: tmp('board-sessions'),
    board_it2_path: fakeIt2(),
    board_status_source: 'iterm',
  });
  const lonely = new BacklogStore(empty).add({ title: 'Thing' });
  assert.equal(await statusOf(make(empty).assignBacklog(lonely.id, 'board')), 409);
  assert.equal(typed.length, 1);
});

test('Assign’s fallback leaves out an ended voice session and a session that listens', async () => {
  const home = tmp('board-assign-apart');
  const sessions = tmp('board-sessions');
  const voiceDir = tmp('board-voice');
  const tree = await parentWithChild();
  const [free, ended] = [liveChild(), liveChild()];
  after(() => {
    tree.stop();
    [free, ended].forEach((child) => child.stop());
  });
  const checkout = checkoutOf('widgets', 'main');
  registry(
    sessions,
    free.pid,
    { cwd: checkout, name: 'free', statusUpdatedAt: NOW.getTime() - 5000 },
    free.procStart,
  );
  registry(
    sessions,
    ended.pid,
    { cwd: checkout, name: 'was-voice', statusUpdatedAt: NOW.getTime() - 2000 },
    ended.procStart,
  );
  // the newest session runs a listener
  registry(
    sessions,
    tree.parent,
    { cwd: checkout, name: 'listener', statusUpdatedAt: NOW.getTime() - 1000 },
    tree.procStart,
  );
  writeJson(path.join(home, 'listeners', 'repo-acme-widgets.json'), {
    consumer: 'repo-acme-widgets',
    pid: tree.child,
    state: 'waiting',
    at: NOW.toISOString(),
    repo: 'acme/widgets',
  });
  // voice ended earlier today in `ended`: the card stays pinned, as ended
  const midnight = new Date(NOW);
  midnight.setHours(0, 0, 0, 0);
  writeJson(path.join(voiceDir, 'session'), { on: false, since: 1 });
  writeJson(path.join(voiceDir, 'last-voice.json'), {
    session_id: fullId(ended.pid),
    cwd: '/x',
    at: midnight.getTime() / 1000 + 1,
  });
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_voice_dir: voiceDir,
    board_it2_path: fakeIt2(),
    board_status_source: 'iterm',
  });
  const item = new BacklogStore(home).add({ title: 'Thing', repo: 'acme/widgets' });
  const typed: string[] = [];
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    typeLine: async (_it2, _tty, text) => {
      typed.push(text);
      return null;
    },
  });
  assert.equal((await board.snapshot()).voice?.status, 'ended');
  assert.equal((await board.assignBacklog(item.id, 'board')).session, 'free');
  assert.equal(typed.length, 1);
});

test('POST /api/board/backlog/assign: the board key only, an item id and nothing else', async () => {
  const home = tmp('board-assign-route');
  const sessions = tmp('board-sessions');
  const checkout = checkoutOf('widgets', 'main');
  registry(sessions, process.ppid, { cwd: checkout, name: 'idle-one' });
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: fakeIt2(),
    board_status_source: 'iterm',
  });
  const item = new BacklogStore(home).add({ title: 'Thing', repo: 'acme/widgets' });
  const bridge = await startBridge({ home });
  open.push(bridge);
  const post = (body: unknown, key = boardKey(TOKEN)) =>
    bridge.call('POST', '/api/board/backlog/assign', body, { Authorization: `Bearer ${key}` });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ id: 'not an id' })).status, 400);
  assert.equal((await post({ id: 'bl_nothere1' })).status, 404);
  // a live idle session whose tab can't be found is not typed into, and nothing is recorded
  const noTab = await post({ id: item.id, prompt: 'rm -rf /', title: 'x' });
  assert.equal(noTab.status, 409);
  assert.equal(new BacklogStore(home).items()[0].assigned, null);
  for (const key of [pageKey(TOKEN, 'x')]) {
    assert.equal((await post({ id: item.id }, key)).status, 403);
  }
});

test('the board: a PR card whose branch has a local story shows how many commits it is ahead of GitHub, and a PR with no local story is left alone', async () => {
  const home = tmp('board-home');
  const widgets = checkoutOf('widgets', 'main');
  prStory(home, 'acme-widgets-5', 'acme/widgets', 5, 'feat/pr');
  localStory(home, 'local-feat-pr', widgets, 'feat/pr');
  prStory(home, 'acme-widgets-6', 'acme/widgets', 6, 'feat/lonely');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/level');
  localStory(home, 'local-feat-level', widgets, 'feat/level');
  writeJson(path.join(home, 'config.json'), {});
  const { watcher } = fakeWatcher([
    prInfo(5, { branch: 'feat/pr' }),
    prInfo(6, { branch: 'feat/lonely' }),
    prInfo(7, { branch: 'feat/level' }),
  ]);
  const looked: string[] = [];
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
    aheadOf: async (checkout, branch) => {
      looked.push(`${checkout}@${branch}`);
      return branch === 'feat/pr' ? 2 : 0;
    },
  });
  const cardsOf = async () =>
    Object.fromEntries(
      (await board.snapshot()).lanes.flatMap((lane) => lane.cards).map((card) => [card.id, card]),
    );
  const first = await cardsOf();
  assert.ok(
    !first['pr:acme/widgets#5'].ahead,
    'the look runs in the background, the snapshot does not wait',
  );
  await new Promise((resolve) => setImmediate(resolve));
  const cards = await cardsOf();
  assert.deepEqual(cards['pr:acme/widgets#5'].ahead, { count: 2, story: 'local-feat-pr' });
  assert.ok(
    !cards['pr:acme/widgets#6'].ahead,
    'no local story of that branch: the board leaves it alone',
  );
  assert.ok(!cards['pr:acme/widgets#7'].ahead, 'nothing ahead: no badge');
  assert.deepEqual([...new Set(looked)].sort(), [`${widgets}@feat/level`, `${widgets}@feat/pr`]);
});

test('the panel’s Start listening: idle sessions in the repo (no voice session), then the repo’s or the story’s line typed, every refusal as the board has it', async () => {
  const home = tmp('board-panel-listen');
  const sessions = tmp('board-sessions');
  const [idle, busy, other] = [liveChild(), liveChild(), liveChild()];
  after(() => [idle, busy, other].forEach((child) => child.stop()));
  const widgets = checkoutOf('widgets', 'main');
  registry(sessions, idle.pid, { cwd: widgets, name: 'idle' }, idle.procStart);
  registry(sessions, busy.pid, { cwd: widgets, name: 'busy', status: 'busy' }, busy.procStart);
  registry(
    sessions,
    other.pid,
    { cwd: checkoutOf('gadgets', 'main'), name: 'other' },
    other.procStart,
  );
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: fakeIt2(),
    board_status_source: 'iterm',
  });
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  const typed: string[] = [];
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying(
      Object.fromEntries(
        [idle, other].map((child) => [
          String(child.pid).padStart(8, '0'),
          { status: 'done' as const, detail: null },
        ]),
      ),
    ),
    now: () => NOW,
    typeLine: async (_it2, _tty, text) => {
      typed.push(text);
      return null;
    },
  });
  const status = async (promise: Promise<unknown>) =>
    promise.then(
      () => 200,
      (err: { status?: number }) => err.status,
    );
  // who may be typed into, per repo; a bad repo is the caller's
  assert.deepEqual(
    (await board.listenSessions('acme/widgets')).map((one) => one.id),
    [fullId(idle.pid)],
    'idle and in the repo: not the busy one, not the gadgets one',
  );
  assert.deepEqual(
    (await board.listenSessions('Acme/Gadgets')).map((one) => one.id),
    [fullId(other.pid)],
    'a repo name matches in any case',
  );
  assert.deepEqual(await board.listenSessions('acme/nothing'), []);
  assert.equal(await status(board.listenSessions('not a repo')), 400);
  // the story's repo
  assert.equal(board.storyRepoOf('acme-widgets-7'), 'acme/widgets');
  assert.throws(() => board.storyRepoOf('nope'), /no story/);
  // a repo's line, then one story's line: the same text as the panel's copy buttons
  assert.equal(
    await board.type('listen', fullId(idle.pid), 'acme/widgets'),
    '/once-upon-listen acme/widgets',
  );
  assert.equal(
    await board.type('listen', fullId(idle.pid), null, 'acme-widgets-7'),
    '/once-upon-listen --story acme-widgets-7',
  );
  assert.deepEqual(typed, [
    '/once-upon-listen acme/widgets',
    '/once-upon-listen --story acme-widgets-7',
  ]);
  assert.equal(
    listenStoryPromptFor('acme-widgets-7'),
    listenPrompt({ story: 'acme-widgets-7' }).prompt,
    'the board types the status API’s story prompt',
  );
  // refusals type nothing: busy, another repo's session, an unknown or odd story id, no repo
  typed.length = 0;
  assert.equal(await status(board.type('listen', fullId(busy.pid), null, 'acme-widgets-7')), 409);
  assert.equal(await status(board.type('listen', fullId(other.pid), null, 'acme-widgets-7')), 409);
  assert.equal(await status(board.type('listen', fullId(idle.pid), null, 'nope')), 404);
  assert.equal(await status(board.type('listen', fullId(idle.pid), null, 'a b; rm')), 400);
  assert.equal(await status(board.type('listen', fullId(idle.pid), null)), 400);
  assert.deepEqual(typed, []);
});

test('listenCandidates leaves out the sessions it is told to skip, and the ones with no tab or another repo', () => {
  const view = (id: string, focus: boolean, since: string | null) =>
    ({ id, title: id, status: 'idle', since, focus }) as unknown as BoardSession;
  const input = {
    idle: new Set(['a', 'b', 'voice', 'notab', 'gadgets']),
    sessions: new Map([
      ['a', view('a', true, '2026-10-26T18:00:00Z')],
      ['b', view('b', true, '2026-10-26T18:30:00Z')],
      ['voice', view('voice', true, '2026-10-26T18:59:00Z')],
      ['notab', view('notab', false, null)],
      ['gadgets', view('gadgets', true, null)],
    ]),
    repoOf: new Map([
      ['a', 'acme/widgets'],
      ['b', 'acme/widgets'],
      ['voice', 'acme/widgets'],
      ['notab', 'acme/widgets'],
      ['gadgets', 'acme/gadgets'],
    ]),
    apart: new Set(['voice']),
  } as unknown as ListeningInput;
  assert.deepEqual(
    listenCandidates('acme/widgets', input, new Set(['b'])).map((one) => one.id),
    ['a'],
    'a session the caller skips is left out too',
  );
  assert.deepEqual(
    listenCandidates('acme/widgets', input).map((one) => one.id),
    ['b', 'a'],
    'freshest first; the voice session and the sessions that already listen (apart) are never offered, anywhere',
  );
  assert.deepEqual(
    listenCandidates('acme/widgets', { ...input, apart: new Set() }).map((one) => one.id),
    ['voice', 'b', 'a'],
    'with nothing apart, everyone idle in the repo',
  );
});

test('Start listening and Assign leave out the voice session and a session that already listens: one rule on the lane, the panel and the story routes', async () => {
  const home = tmp('board-listen-apart');
  const sessions = tmp('board-sessions');
  const voiceDir = tmp('board-voice');
  const tree = await parentWithChild();
  const [free, voice] = [liveChild(), liveChild()];
  after(() => {
    tree.stop();
    [free, voice].forEach((child) => child.stop());
  });
  const widgets = checkoutOf('widgets', 'main');
  registry(sessions, free.pid, { cwd: widgets, name: 'free' }, free.procStart);
  registry(sessions, voice.pid, { cwd: widgets, name: 'voice' }, voice.procStart);
  // idle at its prompt, with a wait of its own running under it
  registry(sessions, tree.parent, { cwd: widgets, name: 'listener' }, tree.procStart);
  writeJson(path.join(voiceDir, 'session'), {
    on: true,
    session_id: fullId(voice.pid),
    last_listen: 5,
    last_speak: 4,
  });
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_voice_dir: voiceDir,
    board_it2_path: fakeIt2(),
    board_status_source: 'iterm',
  });
  writeJson(path.join(home, 'listeners', 'repo-acme-widgets.json'), {
    consumer: 'repo-acme-widgets',
    pid: tree.child,
    state: 'waiting',
    at: NOW.toISOString(),
    repo: 'acme/widgets',
  });
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  new BacklogStore(home).add({ title: 'Do a thing', repo: 'acme/widgets' });
  const done = { status: 'done' as const, detail: null };
  const typed: string[] = [];
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying(
      Object.fromEntries(
        [free.pid, voice.pid, tree.parent].map((pid) => [String(pid).padStart(8, '0'), done]),
      ),
    ),
    now: () => NOW,
    typeLine: async (_it2, _tty, text) => {
      typed.push(text);
      return null;
    },
  });
  const data = await board.snapshot();
  assert.deepEqual(
    (await board.listenSessions('acme/widgets')).map((one) => one.id),
    [fullId(free.pid)],
    'the panel: not the voice session, not the one that listens',
  );
  assert.deepEqual(
    data.listeners.find((entry) => entry.repo === 'acme/widgets')?.candidates.map((one) => one.id),
    [fullId(free.pid)],
    'the lane agrees',
  );
  const item = data.lanes.flatMap((lane) => lane.cards).find((card) => card.backlog)
    ?.backlog as NonNullable<BoardCard['backlog']>;
  assert.ok(item.assign, 'Assign no longer picks a session: the voice session takes it');
  // typing re-checks the rule against a fresh look, so a stale chooser or a direct call cannot reach them either
  const status = (promise: Promise<unknown>) =>
    promise.then(
      () => 200,
      (err: { status?: number }) => err.status,
    );
  for (const id of [fullId(voice.pid), fullId(tree.parent)]) {
    assert.equal(await status(board.type('listen', id, 'acme/widgets')), 409, id);
    assert.equal(await status(board.type('listen', id, null, 'acme-widgets-7')), 409, id);
  }
  assert.deepEqual(typed, [], 'nothing was typed into either');
  assert.equal(
    await board.type('listen', fullId(free.pid), 'acme/widgets'),
    '/once-upon-listen acme/widgets',
  );
  assert.deepEqual(typed, ['/once-upon-listen acme/widgets']);
});

test('a local story whose checkout has no origin finds sessions in that checkout; without iTerm Start listening says so', async () => {
  const home = tmp('board-listen-bare');
  const sessions = tmp('board-sessions');
  const [inBare, inWidgets] = [liveChild(), liveChild()];
  after(() => [inBare, inWidgets].forEach((child) => child.stop()));
  const bare = tmp('board-no-remote');
  git(bare, 'init', '-q', '-b', 'main');
  registry(sessions, inBare.pid, { cwd: path.join(bare), name: 'bare' }, inBare.procStart);
  registry(
    sessions,
    inWidgets.pid,
    { cwd: checkoutOf('widgets', 'main'), name: 'widgets' },
    inWidgets.procStart,
  );
  localStory(home, 'local-bare', bare, 'main');
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: fakeIt2(),
    board_status_source: 'iterm',
  });
  const typed: string[] = [];
  const done = { status: 'done' as const, detail: null };
  const make = () =>
    new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying(
        Object.fromEntries(
          [inBare.pid, inWidgets.pid].map((pid) => [String(pid).padStart(8, '0'), done]),
        ),
      ),
      now: () => NOW,
      typeLine: async (_it2, _tty, text) => {
        typed.push(text);
        return null;
      },
    });
  const board = make();
  const found = await board.storyListenSessions('local-bare');
  assert.equal(found.repo, null);
  assert.deepEqual(
    found.sessions.map((one) => one.id),
    [fullId(inBare.pid)],
    'by the story’s checkout',
  );
  assert.equal(
    await board.type('listen', fullId(inBare.pid), null, 'local-bare'),
    '/once-upon-listen --story local-bare',
  );
  await assert.rejects(
    board.type('listen', fullId(inWidgets.pid), null, 'local-bare'),
    /not in .*board-no-remote/,
    'a session elsewhere is refused',
  );
  assert.deepEqual(typed, ['/once-upon-listen --story local-bare']);
  // no iTerm: nothing can be typed into, and the page is told so rather than to click again
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_status_source: 'registry',
  });
  await assert.rejects(make().listenSessions('acme/widgets'), /needs iTerm/);
  await assert.rejects(make().storyListenSessions('local-bare'), /needs iTerm/);
});

test('a story’s own listen routes: the local page’s full key and the token reach them, the read-only key, the board key and another story’s key do not', async () => {
  const home = tmp('story-listen-routes');
  const sessions = tmp('board-sessions');
  mkdirSync(sessions, { recursive: true });
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: fakeIt2(),
    board_status_source: 'iterm',
  });
  const widgets = checkoutOf('widgets', 'feat/x');
  const bare = tmp('board-no-remote');
  git(bare, 'init', '-q', '-b', 'main');
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  localStory(home, 'local-feat-x', widgets, 'feat/x');
  localStory(home, 'local-bare', bare, 'main');
  localStory(home, 'local-nowhere', '', 'main');
  const bridge = await startBridge({ home });
  open.push(bridge);
  const viaKey = (method: 'GET' | 'POST', route: string, key: string, body?: unknown) =>
    bridge.call<{ repo?: string; sessions?: unknown[]; error?: string }>(method, route, body, {
      Authorization: `Bearer ${key}`,
    });
  for (const key of [TOKEN, pageKey(TOKEN, 'local-feat-x')]) {
    const got = await viaKey('GET', '/api/stories/local-feat-x/listen', key);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, { repo: 'acme/widgets', sessions: [] });
    // reached: the board looks for the session and finds none
    for (const scope of ['repo', 'story']) {
      const sent = await viaKey('POST', '/api/stories/local-feat-x/listen', key, {
        session: 'nope',
        scope,
      });
      assert.equal(sent.status, 404, scope);
      assert.match(String(sent.body.error), /no live Claude Code session/);
    }
    assert.equal((await viaKey('POST', '/api/stories/local-feat-x/listen', key, {})).status, 400);
    assert.equal(
      (await viaKey('POST', '/api/stories/local-feat-x/listen', key, { session: 'a b; rm' }))
        .status,
      400,
      'no text to type',
    );
  }
  // a PR story, by the extension's token
  assert.equal(
    (await viaKey('GET', '/api/stories/acme-widgets-7/listen', TOKEN)).body.repo,
    'acme/widgets',
  );
  // a local story whose checkout has no origin finds sessions by the checkout: the story's own listener can be asked for,
  // the repo's cannot, and with no checkout either there is nothing to find a session by
  const bareList = await viaKey('GET', '/api/stories/local-bare/listen', TOKEN);
  assert.deepEqual([bareList.status, bareList.body], [200, { repo: null, sessions: [] }]);
  assert.equal(
    (
      await viaKey('POST', '/api/stories/local-bare/listen', TOKEN, {
        session: 'nope',
        scope: 'story',
      })
    ).status,
    404,
    'reached: the session is looked for',
  );
  assert.equal(
    (await viaKey('POST', '/api/stories/local-bare/listen', TOKEN, { session: 'nope' })).status,
    400,
    "no repo, so no repo's listener",
  );
  assert.equal((await viaKey('GET', '/api/stories/local-nowhere/listen', TOKEN)).status, 400);
  // a read-only link never types into a terminal; neither do the board's key or another story's
  for (const key of [
    viewKey(TOKEN, 'local-feat-x'),
    boardKey(TOKEN),
    pageKey(TOKEN, 'local-bare'),
  ]) {
    assert.equal((await viaKey('GET', '/api/stories/local-feat-x/listen', key)).status, 403);
    assert.equal(
      (await viaKey('POST', '/api/stories/local-feat-x/listen', key, { session: 'x' })).status,
      403,
    );
  }
});

test('GET /api/board/listen-sessions: the board key or the token, a repo or a story, nothing from the other pages’ keys', async () => {
  const home = tmp('board-listen-sessions-route');
  const sessions = tmp('board-sessions');
  mkdirSync(sessions, { recursive: true });
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: fakeIt2(),
    board_status_source: 'iterm',
  });
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7);
  const bridge = await startBridge({ home });
  open.push(bridge);
  const get = (route: string, key: string) =>
    bridge.call<{ repo: string; sessions: unknown[] }>('GET', route, undefined, {
      Authorization: `Bearer ${key}`,
    });
  for (const key of [TOKEN, boardKey(TOKEN)]) {
    const byRepo = await get('/api/board/listen-sessions?repo=acme/widgets', key);
    assert.equal(byRepo.status, 200);
    assert.deepEqual(byRepo.body, { repo: 'acme/widgets', sessions: [] });
    const byStory = await get('/api/board/listen-sessions?story=acme-widgets-7', key);
    assert.deepEqual(byStory.body, { repo: 'acme/widgets', sessions: [] }, "the story's own repo");
  }
  assert.equal((await get('/api/board/listen-sessions', TOKEN)).status, 400);
  assert.equal((await get('/api/board/listen-sessions?repo=not%20a%20repo', TOKEN)).status, 400);
  assert.equal((await get('/api/board/listen-sessions?story=nope', TOKEN)).status, 404);
  for (const key of [pageKey(TOKEN, 'acme-widgets-7')]) {
    assert.equal(
      (await get('/api/board/listen-sessions?repo=acme/widgets', key)).status,
      403,
      "the board's route",
    );
  }
});

test('a standing helper is a row at the bottom, never a card: gone with its session, when finished, or after 8 hours idle', async () => {
  const tree = await parentWithChild();
  after(() => tree.stop());
  const sid = String(tree.parent).padStart(8, '0');
  const ago = (hours: number, minutes = 0) =>
    new Date(NOW.getTime() - (hours * 60 + minutes) * 60000);
  type Setup = (registered: AgentRegistry) => void;
  const world = async (setup: Setup, live = true, ledgerLines: string[] = []) => {
    const home = tmp('board-helpers');
    const sessions = tmp('board-sessions');
    if (live) {
      registry(sessions, tree.parent, { cwd: checkoutOf('widgets', 'main') }, tree.procStart);
    }
    const ledger = path.join(tmp('board-notes'), 'ledger.md');
    writeFileSync(ledger, ledgerLines.join('\n'));
    setup(new AgentRegistry(home));
    writeJson(path.join(home, 'config.json'), {
      board_sessions_dir: sessions,
      board_ledger_file: ledger,
      board_ledger_time_zone: 'UTC',
    });
    const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying({ [sid]: { status: 'done', detail: null } }),
      now: () => NOW,
    });
    const data = await board.snapshot();
    return { data, cards: data.lanes.flatMap((lane) => lane.cards) };
  };
  const agentCards = (cards: BoardCard[], name = 'backlog-clerk') =>
    cards.filter((card) => card.agents.some((agent) => agent.name === name));
  // the registered field is all that says so: a task and a name that mean nothing
  const clerk = (registered: AgentRegistry, task = 'card ops') =>
    registered.start({
      name: 'backlog-clerk',
      sid,
      kind: 'helper',
      standing: true,
      task,
      at: ago(6),
    });

  const shown = await world((registered) => {
    clerk(registered);
    registered.state('backlog-clerk', { state: 'waiting', outcome: 'ready', at: ago(0, 30) });
  });
  assert.equal(shown.data.helpers.length, 1);
  const [helper] = shown.data.helpers;
  assert.equal(helper.name, 'backlog-clerk');
  assert.equal(helper.state, 'waiting');
  assert.equal(helper.session, fullId(tree.parent));
  assert.equal(helper.last_request_at, ago(0, 30).toISOString());
  assert.equal(agentCards(shown.cards).length, 0, 'no card, so not in Waiting or Done');

  assert.equal((await world(clerk)).data.helpers[0].state, 'handling', 'running: handling one');
  // a finish ends it (and it does not turn into a Done card either)
  const done = await world((registered) => {
    clerk(registered);
    registered.finish('backlog-clerk', { state: 'done', outcome: 'shut down', at: ago(0, 20) });
  });
  assert.equal(done.data.helpers.length, 0);
  assert.equal(agentCards(done.cards).length, 0);
  // restarted without --standing, it is in the row again
  const resumed = await world((registered) => {
    clerk(registered);
    registered.finish('backlog-clerk', { state: 'done', at: ago(0, 20) });
    registered.start({ name: 'backlog-clerk', sid, task: 'card ops again', at: ago(0, 10) });
  });
  assert.equal(resumed.data.helpers[0]?.name, 'backlog-clerk', 'standing carries over a restart');
  // its session is gone
  const gone = await world(clerk, false);
  assert.equal(gone.data.helpers.length, 0, 'session ended');
  assert.equal(agentCards(gone.cards).length, 0);
  // nobody has asked it anything for more than 8 hours
  const idle = await world((registered) => {
    registered.start({
      name: 'backlog-clerk',
      sid,
      kind: 'helper',
      standing: true,
      task: 'x',
      at: ago(9),
    });
  });
  assert.equal(idle.data.helpers.length, 0, 'idle 8h');
  // a helper by kind alone, and a ledger agent saying "standing helper", are ordinary agents: a card, no row
  const plain = await world(
    (registered) => {
      registered.start({ name: 'deploy-x', sid, kind: 'helper', task: 'ff deploy x', at: ago(1) });
    },
    true,
    [
      `- [running] sid:${sid} backlog-clerk (sonnet, low) — standing helper for backlog card ops — started 1:00 PM ET, 10/26`,
      `- [running] sid:${sid} tagged-one (sonnet) — [helper] card ops — started 1:00 PM ET, 10/26`,
    ],
  );
  assert.equal(
    plain.data.helpers.length,
    0,
    'neither the kind nor the task text puts it in the row',
  );
  assert.equal(agentCards(plain.cards, 'deploy-x').length, 1, 'a one-shot helper is a card');
  assert.equal(
    agentCards(plain.cards, 'backlog-clerk').length,
    1,
    'prose does not make it standing',
  );
  assert.equal(agentCards(plain.cards, 'tagged-one').length, 1);
});

test('only a lane tag is resolved to an owner/name: an agent on its parent’s folder lane stays there', async () => {
  const home = tmp('board-folder-lane');
  const sessions = tmp('board-folder-lane-sessions');
  const parent = liveChild();
  after(() => parent.stop());
  registry(sessions, parent.pid, { cwd: '/tmp/somewhere/foo' }, parent.procStart);
  const sid = String(parent.pid).padStart(8, '0');
  const ledger = path.join(tmp('board-folder-lane-notes'), 'ledger.md');
  writeFileSync(
    ledger,
    [
      `- [running] sid:${sid} folder-agent (sonnet, low) — a one-off task — started 1:00 PM ET, 10/26`,
      `- [running] sid:${sid} lane:foo tagged-agent (sonnet, low) — a one-off task — started 1:00 PM ET, 10/26`,
    ].join('\n'),
  );
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_ledger_file: ledger,
    board_ledger_time_zone: 'UTC',
  });
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({ [sid]: { status: 'done', detail: null } }),
    now: () => NOW,
    repoOf: async () => null,
  });
  board.addBacklog({ title: 'In eric/foo', repo: 'eric/foo', by: 'board' });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  const lane = (title: string) => cards.find((card) => card.title === title)?.lane;
  assert.equal(lane('tagged-agent'), 'eric/foo', 'a tag is the short name of the one repo');
  assert.equal(lane('folder-agent'), 'foo', 'a folder lane is already a key');
});

test('Build story types the clicked card’s own request, though two cards build in the same session', async () => {
  const home = tmp('board-type-card');
  const sessions = tmp('board-sessions');
  const launcher = liveChild();
  after(() => launcher.stop());
  registry(sessions, launcher.pid, { cwd: tmp('dev'), name: 'root' }, launcher.procStart);
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: fakeIt2(),
    board_status_source: 'iterm',
  });
  const id = fullId(launcher.pid);
  const request = (branch: string) =>
    `Build the Once Upon story of the unpushed commits on branch ${branch} in /wt/${branch}`;
  // the root session launched both authors: both Ready cards build in it
  const built = (name: string, branch: string) =>
    ({
      id: `agent:aaaaaaaa:${name}`,
      build: { session: id, prompt: request(branch), blocked: null },
    }) as BoardCard;
  const feed: SessionsFeed = {
    snapshot: async () =>
      ({
        lanes: [{ key: 'x', name: 'x', cards: [built('one', 'one'), built('two', 'two')] }],
      }) as unknown as BoardData,
    listening: () => null,
    invalidate: () => {},
  };
  const typed: string[] = [];
  const service = new Sessions(home, new StoryStore({ home }), feed, {
    typeLine: async (_it2, _tty, text) => {
      typed.push(text);
      return null;
    },
    source: sourceSaying({}),
  });
  await service.type('build', id, null, null, 'agent:aaaaaaaa:two');
  assert.deepEqual(typed, [request('two')]);
  await assert.rejects(
    service.type('build', id, null, null, 'agent:aaaaaaaa:gone'),
    /nothing to build/,
  );
  assert.equal(typed.length, 1);
});

test('POST /api/board/review: a session’s branch becomes a storyless review over its merge-base, and its page link comes back', async () => {
  const home = tmp('board-review');
  const sessions = tmp('board-sessions');
  const fixture = worktreeFixture();
  const dir = fixture.add('feat/x');
  fixture.commit(dir, 'x one');
  // origin's main is where feat/x began; main has moved on since, so the base is the merge-base, not main's tip
  const forkPoint = git(fixture.main, 'rev-parse', 'HEAD');
  git(fixture.main, 'update-ref', 'refs/remotes/origin/main', forkPoint);
  fixture.commit(fixture.main, 'main later', 3);
  const child = liveChild();
  after(() => child.stop());
  registry(sessions, child.pid, { cwd: dir, name: 'on-x' }, child.procStart);
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const bridge = await startBridge({ home });
  open.push(bridge);
  const cardOnX = async () =>
    (await bridge.call<BoardData>('GET', '/api/board')).body.lanes
      .flatMap((lane) => lane.cards)
      .find((one) => one.branch === 'feat/x') as BoardCard;
  const post = (body: unknown, key = boardKey(TOKEN)) =>
    bridge.call<{ url: string; story: string }>('POST', '/api/board/review', body, {
      Authorization: `Bearer ${key}`,
    });
  const before = await cardOnX();
  assert.deepEqual(before.review, { branch: 'feat/x', path: dir });
  assert.equal((await post({ card: before.id }, pageKey(TOKEN, 'x'))).status, 403);
  assert.equal((await post({ card: 'branch:nope@nope' })).status, 404);

  // the path is the card's, never the body's
  const made = await post({ card: before.id, path: '/etc', branch: 'main' });
  assert.equal(made.status, 200, made.text);
  const { story, url } = made.body;
  assert.match(url, new RegExp(`/local/${story}/`));
  const folder = path.join(dir, '.once-upon', story);
  const meta = JSON.parse(readFileSync(path.join(folder, 'meta.json'), 'utf8'));
  assert.equal(meta.base, forkPoint);
  assert.equal(meta.head, 'feat/x');
  assert.equal(meta.branch, 'feat/x', 'a branch, so Create pull request is offered');
  assert.equal(
    JSON.parse(readFileSync(path.join(folder, 'chapters.json'), 'utf8')).mode,
    'by-folder',
  );
  assert.match(readFileSync(path.join(folder, 'local.diff'), 'utf8'), /changed-x one/);
  assert.doesNotMatch(readFileSync(path.join(folder, 'local.diff'), 'utf8'), /main later/);

  // the branch has its story now: a work card with Open story, and Build story still tells one. Review stays while
  // the story is storyless, so a branch that moved on can be reviewed again
  const reviewed = await cardOnX();
  assert.equal(reviewed.kind, 'work');
  assert.equal(reviewed.story?.id, story);
  assert.equal(reviewed.story?.storyless, true);
  assert.deepEqual(reviewed.review, { branch: 'feat/x', path: dir });
  assert.ok(reviewed.build, 'Build story is still offered on a storyless review');
  fixture.commit(dir, 'x two', 2);
  const again = await post({ card: reviewed.id });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.story, story, 'the same story');
  const repinned = JSON.parse(readFileSync(path.join(folder, 'meta.json'), 'utf8'));
  assert.equal(repinned.head_oid, git(dir, 'rev-parse', 'HEAD'), 're-pinned to the new tip');
  assert.match(readFileSync(path.join(folder, 'local.diff'), 'utf8'), /changed-x two/);
});
