import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { request, type IncomingHttpHeaders } from 'node:http';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  tmp,
  git,
  localRepo,
  writeJson,
  startBridge,
  runCli,
  TOKEN,
  type TestBridge,
} from './helpers.ts';
import { Builds } from '../src/inbox/builds.ts';
import { Board, liveSessions, noPrWatcher, type PrWatcher } from '../src/board/board.ts';
import { columnOf, isBackToYou } from '../src/board/columns.ts';
import { readVoice, voiceStatus } from '../src/board/voice.ts';
import { sessionOfPid } from '../src/board/listening.ts';
import { noteListener, readHistory } from '../src/listeners/history.ts';
import { repoStopReason, requestStop, stopRequested } from '../src/listeners/auto-stop.ts';
import { laneForAgent, tiedToParent } from '../src/board/agent-home.ts';
import type { LedgerAgent } from '../src/board/ledger.ts';
import { parseLedger, parseLedgerTime, parseProgress } from '../src/board/ledger.ts';
import {
  findIt2,
  focusTab,
  itermSource,
  pickSource,
  registrySource,
  typeLine,
} from '../src/board/sources.ts';
import { boardKey, inboxKey, pageKey } from '../src/server/page-key.ts';
import { readSettings } from '../src/config/settings.ts';
import type { StatusSource } from '../src/board/sources.ts';
import {
  ghBranchCheck,
  ghPrCheck,
  ghRequestedCheck,
  mergeSummary,
  type BranchPr,
} from '../src/review-inbox/auto-review.ts';
import { StoryStore } from '../src/stories/store.ts';
import type {
  BoardCard,
  BoardData,
  PrInfo,
  StoryRequest,
  InboxList,
} from '@once-upon-a-diff/shared/types';

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

/** A registry file the way Claude Code writes it. */
function registry(
  dir: string,
  pid: number,
  extra: Record<string, unknown> = {},
  procStart: string | null = null,
) {
  writeJson(path.join(dir, `${pid}.json`), {
    pid,
    sessionId: `${String(pid).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`,
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
  says: Record<string, { status: 'waiting' | 'working' | 'done'; detail: string | null }>,
): StatusSource => ({
  name: 'iterm',
  statuses: async (sessions) =>
    new Map(
      sessions.flatMap((session) => {
        const found = says[session.session.slice(0, 8)];
        return found ? [[session.session, { ...found, title: 'Tab title' }] as const] : [];
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

test('columns follow the work to merge: waiting and working first, then merged, ready, back to you, PR open', () => {
  const none = { sessions: [], agents: [], pr: null, story: null };
  const open = prInfo(1);
  const unseen = { reviewed: false, manualReviewedAt: null, unread: false };
  assert.equal(columnOf({ ...none, sessions: [{ status: 'waiting' }], pr: open }), 'waiting');
  assert.equal(columnOf({ ...none, agents: [{ status: 'waiting', state: 'waiting' }] }), 'waiting');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'working' }], story: unseen }), 'working');
  assert.equal(columnOf({ ...none, agents: [{ status: 'working', state: 'running' }] }), 'working');
  assert.equal(columnOf({ ...none, pr: prInfo(1, { state: 'merged' }), story: unseen }), 'done');
  assert.equal(columnOf({ ...none, pr: open, story: unseen }), 'ready');
  assert.equal(columnOf({ ...none, pr: open }), 'pr_open');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'idle' }], pr: open }), 'pr_open');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'idle' }] }), 'idle');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'error' }] }), 'error');
  assert.equal(columnOf({ ...none, agents: [{ status: 'error', state: 'failed' }] }), 'error');
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
  // 11 you reviewed and read, nothing is new, 17 you reviewed but it was rebuilt since, 12 merged two hours ago,
  // 13 merged three days ago, 14 is someone else's PR with a story built for you, 15 has not been described by GitHub yet
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  prStory(home, 'acme-widgets-8', 'acme/widgets', 8, 'feat/z');
  prStory(home, 'acme-widgets-14', 'acme/widgets', 14, 'feat/theirs');
  prStory(home, 'acme-widgets-15', 'acme/widgets', 15, 'feat/unknown');
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
    'merged.json': { at: hoursAgo(1), why: 'merged', merged_at: hoursAgo(2) },
  });
  prStory(home, 'acme-widgets-13', 'acme/widgets', 13, 'feat/thirteen', {
    'merged.json': { at: hoursAgo(71), why: 'merged', merged_at: hoursAgo(72) },
  });

  writeFileSync(
    ledger,
    [
      `- [running] sid:${sid(onStory)} nested-one (sonnet, low) — nested task on feat/x — started 2:50 PM ET, 10/26`,
      `- [done] sid:${sid(onStory)} nested-done — 2:40 PM ET, 10/26 — it finished`,
      `- [done] sid:${sid(onStory)} nested-old — 7:40 AM ET, 10/26 — hours ago`,
      `- [running] sid:${sid(onStory)} lane:cross-cutting tagged-one (sonnet, high) — tagged task — started 2:55 PM ET, 10/26`,
      `- [running] sid:${sid(onStory)} pr-agent (sonnet, low) — review fixes for PR #7 — started 2:51 PM ET, 10/26`,
      `- [running] sid:${sid(onStory)} wt-agent (sonnet, low) — refactor in widgets-worktrees/refactor — started 2:52 PM ET, 10/26`,
      `- [running] sid:${sid(onStory)} crosscut-note (sonnet, low) — notes for the Cross Cutting plan — started 2:53 PM ET, 10/26`,
      `- [waiting] sid:${sid(onMain)} needs-answer — 2:45 PM ET, 10/26 — needs Eric: pick A or B — notes/x.md`,
      '- [running] sid:deadbeef orphan (sonnet, high) — no parent — started 2:57 PM ET, 10/26',
      '- [failed] sid:deadbeef broke — 2:58 PM ET, 10/26 — exploded',
      '- [stopped] sid:deadbeef stopped-one — 2:59 PM ET, 10/26 — asked to stop',
    ].join('\n'),
  );
  writeFileSync(
    progress,
    '- 2:52 PM nested-one 3/6 code: writing\n- 2:56 PM tagged-one 1/6 read: reading\n',
  );
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
      prInfo(9, { branch: 'feat/y', checks: 'pending' }),
      prInfo(10, { viewer_at: '2026-10-26T13:00:00Z', others_at: '2026-10-26T15:00:00Z' }),
      prInfo(11, { others_at: '2026-10-26T13:00:00Z' }),
      prInfo(12, { state: 'merged', merged_at: hoursAgo(2) }),
    ],
    {
      'acme/widgets@feat/y': { number: 9, state: 'open', merged_at: null },
      'acme/widgets@old/merged': { number: 3, state: 'merged', merged_at: null },
    },
    // 19 is someone else's PR GitHub is waiting on your review for
    [{ repo: 'acme/widgets', number: 19 }],
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
    'pr:acme/widgets#8': 'ready',
    'pr:acme/widgets#10': 'back', // an open thread asks something of you
    'pr:acme/widgets#11': 'pr_open',
    'pr:acme/widgets#17': 'back', // rebuilt since you last opened it
    'pr:acme/widgets#18': 'working', // a session is fixing the code
    'pr:acme/widgets#16': 'working', // a session is building its story, whatever branch it is on
    'pr:acme/widgets#14': 'ready', // someone else's PR, with a story built for you
    'pr:acme/widgets#15': 'ready',
    'pr:acme/widgets#19': 'back', // GitHub is waiting on your review
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
  });
  assert.equal(card('pr:acme/widgets#13'), undefined, 'merged three days ago: gone');
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
  assert.equal(card('pr:acme/widgets#14').pr?.mine, false);
  // a finished agent (done, stopped or failed) has no card of its own, not even in the Idle lane
  for (const name of ['nested-old', 'nested-done']) {
    assert.equal(card(`agent:${sid(onStory)}:${name}`), undefined, name);
  }
  assert.equal(card('agent:deadbeef:stopped-one'), undefined);
  assert.equal(card('agent:deadbeef:broke'), undefined);
  // sessions on a branch whose PR merged are not lumped into one card named for it: one card each, by session title
  assert.equal(card(fullId(staleOne.pid)).kind, 'session');
  assert.equal(card(fullId(staleOne.pid)).title, 'stale-one');
  assert.equal(card(fullId(staleTwo.pid)).title, 'Tab title');
  assert.equal(card(fullId(staleOne.pid)).branch, 'old/merged');
  assert.equal(cards.filter((found) => found.branch === 'old/merged').length, 2);
  // a subagent's lane: its tag, else the repo its task names (a worktree path, or a lane's name), else its parent's
  assert.equal(card(`agent:${sid(onStory)}:wt-agent`).lane, 'widgets');
  assert.equal(card(`agent:${sid(onStory)}:crosscut-note`).lane, 'cross-cutting');
  assert.equal(card(`agent:${sid(onMain)}:needs-answer`).lane, 'gadgets');
  assert.equal(card('agent:deadbeef:orphan').lane, 'No live session');
  assert.equal(card(`agent:${sid(onStory)}:wt-agent`).parent, 'story-one');
  assert.deepEqual(
    data.lanes.map((lane) => lane.name).filter((name) => !name.startsWith('once-upon-')),
    ['cross-cutting', 'gadgets', 'No live session', 'widgets'],
  );
  assert.equal(card('pr:acme/widgets#9').lane, 'widgets');

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
    'only agents that say they work on the same branch or PR are nested; the rest have their own cards',
  );
  assert.deepEqual(working.agents[0].beat, { n: 3, of: 6, step: 'code', note: 'writing' });
  assert.deepEqual(working.pr, seven);
  assert.deepEqual(working.story?.reviewed, false);
  // the card's unreviewed story
  assert.deepEqual(working.inbox, { stories: 1, repo: 'acme/widgets' });

  const asking = card('pr:acme/widgets#9');
  assert.equal(asking.story, null);
  assert.equal(asking.detail, 'asked you a question');
  assert.equal(asking.sessions[0].title, 'Tab title');
  assert.equal(asking.pr?.checks, 'pending');

  const ready = card('pr:acme/widgets#8');
  assert.equal(ready.title, 'PR 8');
  assert.equal(ready.story?.reviewed, false);
  assert.equal(ready.sessions.length, 0);
  assert.ok(ready.since);

  assert.equal(card('pr:acme/widgets#12').since, hoursAgo(2));
  assert.equal(card('pr:acme/widgets#12').story, null);

  const main = card(fullId(onMain.pid));
  assert.equal(main.kind, 'session');
  assert.equal(main.branch, 'main');
  assert.equal(main.lane, 'gadgets');
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
        live.map((session) => [session.session, { status: state, detail: null, title: null }]),
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
  assert.equal(unset.doneHours, 4);
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
  echo '{"status":"waiting","detail":"needs you"}'
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

  const inbox = await withKey(key, '/api/board/inbox-link?repo=acme/widgets');
  assert.equal(
    (inbox.body as { url: string }).url,
    `${bridge.base}/inbox/#key=${inboxKey(TOKEN)}&repo=acme%2Fwidgets`,
  );
  assert.ok(
    !(await withKey(key, '/api/board/inbox-link?repo=a%20b')).text.includes('repo='),
    'a bad repo name is dropped',
  );
  for (const route of [
    '/api/inbox',
    '/api/inbox/link',
    '/api/board/link',
    '/api/stories',
    '/api/prefs',
  ]) {
    assert.equal((await withKey(key, route)).status, 403, route);
  }
  // links only step down: the inbox page's key gets the board's address with no key in it, and nothing more of the
  // board; a story's key neither. The bridge's token (the extension, the CLI) is handed the board's key.
  const fromInbox = await withKey(inboxKey(TOKEN), '/api/board/link');
  assert.equal((fromInbox.body as { url: string }).url, `${bridge.base}/board/`);
  assert.ok(!fromInbox.text.includes(key) && !fromInbox.text.includes('key='), 'no board key');
  const withToken = await bridge.call<{ url: string }>('GET', '/api/board/link');
  assert.equal(withToken.body.url, `${bridge.base}/board/#key=${key}`);
  // no route an inbox key reaches answers with the board's key (or anything it could make one from)
  for (const route of [
    '/api/board/link',
    '/api/board/link?public=1',
    '/api/inbox',
    '/api/inbox/link',
  ]) {
    const got = await withKey(inboxKey(TOKEN), route);
    assert.ok(!got.text.includes(key), `${route} leaks no board key`);
  }
  for (const route of ['/api/board', '/api/board/inbox-link', '/api/board/inbox-link?repo=a/b']) {
    assert.equal((await withKey(inboxKey(TOKEN), route)).status, 403, `${route} is the board's`);
  }
  for (const [method, route] of [
    ['POST', '/api/board/type'],
    ['POST', '/api/board/focus'],
    ['POST', '/api/board/stop-listening'],
  ] as const) {
    assert.equal(
      (await bridge.call(method, route, {}, { Authorization: `Bearer ${inboxKey(TOKEN)}` })).status,
      403,
      `${route} is the board's`,
    );
  }
  assert.equal((await withKey(inboxKey(TOKEN), '/api/board')).status, 403);
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

test('the review inbox lists built PR stories, and Mark reviewed works on them', async () => {
  const home = tmp('board-inbox');
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
  const asInbox = (method: string, route: string, body?: unknown) =>
    bridge.call(method, route, body, { Authorization: `Bearer ${inboxKey(TOKEN)}` });

  const list = (await asInbox('GET', '/api/inbox')).body as InboxList;
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
  assert.deepEqual(list.repos.map((repo) => [repo.repo, repo.unreviewed]).sort(), [
    ['acme/gadgets', 1],
    ['acme/widgets', 1],
  ]);
  const filtered = (await asInbox('GET', '/api/inbox?repo=acme/widgets')).body as InboxList;
  assert.deepEqual(
    filtered.stories.map((story) => story.id),
    ['acme-widgets-7'],
  );

  const marked = await asInbox('POST', '/api/inbox/reviewed', { story: 'acme-widgets-7' });
  assert.equal(marked.status, 200);
  assert.ok((marked.body as { story: { reviewed_at: string } }).story.reviewed_at);
  const after = (await asInbox('GET', '/api/inbox')).body as InboxList;
  assert.equal(after.repos.find((repo) => repo.repo === 'acme/widgets')?.unreviewed, 0);
  await asInbox('POST', '/api/inbox/reviewed', { story: 'acme-widgets-7', reviewed: false });
  const undone = (await asInbox('GET', '/api/inbox')).body as InboxList;
  assert.equal(undone.stories.find((story) => story.id === 'acme-widgets-7')?.reviewed_at, null);
  for (const id of ['local-x', 'nope', '../x']) {
    assert.equal((await asInbox('POST', '/api/inbox/reviewed', { story: id })).status, 404, id);
  }
});

// ---------- the inbox marks a PR story reviewed when GitHub says you have

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

test('a PR story you reviewed or finished Viewing is marked in the inbox, with why; a manual unmark sticks', async () => {
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
  const asInbox = (method: string, route: string, body?: unknown) =>
    bridge.call(method, route, body, { Authorization: `Bearer ${inboxKey(TOKEN)}` });
  const stories = async () =>
    Object.fromEntries(
      ((await asInbox('GET', '/api/inbox')).body as InboxList).stories.map((story) => [
        story.number,
        [!!story.reviewed_at, story.reviewed_by],
      ]),
    );

  // 4 is unmarked by hand before GitHub is asked: that decision stays
  await asInbox('POST', '/api/inbox/reviewed', { story: 'acme-widgets-4', reviewed: false });
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
  await asInbox('POST', '/api/inbox/reviewed', { story: 'acme-widgets-1', reviewed: false });
  await asInbox('POST', '/api/inbox/reviewed', { story: 'acme-widgets-3' });
  await stories();
  await bridge.server.autoReview.idle();
  assert.deepEqual(await stories(), {
    1: [false, null],
    2: [true, 'all viewed'],
    3: [true, 'manual'],
    4: [false, null],
  });
});

test('a PR story whose PR has merged, or closed with its branch deleted, leaves the inbox and the board count; a closed one with its branch stays', async () => {
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
  const asInbox = (method: string, route: string) =>
    bridge.call(method, route, undefined, { Authorization: `Bearer ${inboxKey(TOKEN)}` });
  const ids = async () => {
    const list = (await asInbox('GET', '/api/inbox')).body as InboxList;
    return [list.stories.map((story) => story.id).sort(), list.repos[0]?.unreviewed];
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
  const asInbox = (method: string, route: string) =>
    bridge.call(method, route, undefined, { Authorization: `Bearer ${inboxKey(TOKEN)}` });
  const list = async () => (await asInbox('GET', '/api/inbox')).body as InboxList;
  const marks = async () => {
    await asInbox('GET', '/api/inbox');
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
  const asInbox = (method: string, route: string) =>
    bridge.call(method, route, undefined, { Authorization: `Bearer ${inboxKey(TOKEN)}` });
  await asInbox('GET', '/api/inbox');
  await bridge.server.autoReview.idle();
  const stories = ((await asInbox('GET', '/api/inbox')).body as InboxList).stories;
  assert.deepEqual(Object.fromEntries(stories.map((story) => [story.number, story.reviewed_by])), {
    1: 'all viewed',
    2: null,
  });
});

test('the board and the inbox share one check per PR, in either order, and the answer reaches every story of the PR', async () => {
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
  const asInbox = (method: string, route: string) =>
    bridge.call(method, route, undefined, { Authorization: `Bearer ${inboxKey(TOKEN)}` });
  const marks = async () => {
    const stories = ((await asInbox('GET', '/api/inbox')).body as InboxList).stories;
    await review.idle();
    return stories.length;
  };

  // the board asks about 1 and 2 first: the inbox poll in the same window neither asks again nor loses the answer
  review.kickInfo('acme/widgets', 1);
  review.kickInfo('acme/widgets', 2);
  assert.equal(await marks(), 3);
  assert.deepEqual(asked.sort(), [1, 2], 'one check per PR');
  const after = ((await asInbox('GET', '/api/inbox')).body as InboxList).stories;
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

  // the inbox first, then the board in the same window
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
  await other.call('GET', '/api/inbox', undefined, { Authorization: `Bearer ${inboxKey(TOKEN)}` });
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
      { number: 3, state: 'merged', merged_at: '2026-10-01T00:00:00Z' },
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
      { number: 4, state: 'merged', merged_at: '2026-10-03T00:00:00Z' },
    );
    assert.equal(await ask([], [node(9, stray, mine, '2026-10-09T00:00:00Z')]), null);
    assert.equal(
      await ask([], [node(9, '0'.repeat(40), mine, '2026-10-09T00:00:00Z')]),
      null,
      'a head commit this checkout has never seen',
    );
    // open and merged are asked for separately, up to 100 each, with the head repository and commit
    const query = calls()[0].find((arg) => arg.startsWith('query=')) as string;
    assert.match(query, /open:pullRequests\(headRefName:\$branch,first:100,states:\[OPEN\]/);
    assert.match(query, /merged:pullRequests\(headRefName:\$branch,first:100,states:\[MERGED\]/);
    assert.match(query, /headRefOid headRepository\{nameWithOwner\}/);
  });
});

test('the review-requested search and PrInfo.review_requested both count only requests made of you by name', async () => {
  await withFakeGh(tmp('requested'), async ({ answer, calls }) => {
    writeJson(answer, {
      data: {
        search: {
          nodes: [{ number: 4, repository: { nameWithOwner: 'acme/widgets' } }, {}],
        },
      },
    });
    assert.deepEqual(await ghRequestedCheck(), [{ repo: 'acme/widgets', number: 4 }]);
    const query = calls()[0].find((arg) => arg.startsWith('query=')) as string;
    assert.match(query, /user-review-requested:@me/);
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
  // the other pages' keys don't reach it
  assert.equal((await post(inboxKey(TOKEN), { session: fullId(process.pid) })).status, 403);
  assert.equal((await post(pageKey(TOKEN, 'x'), { session: fullId(process.pid) })).status, 403);
  // and with iTerm turned off in the settings there is nothing to do
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_status_source: 'registry',
  });
  assert.equal((await post(key, { session: fullId(process.pid) })).status, 409);
});

test('where an agent goes: nested only when tied to its parent’s branch or PR, else its own card on its own lane', () => {
  const agent = (extra: Partial<LedgerAgent> = {}): LedgerAgent => ({
    sid: 'aaaaaaaa',
    name: 'helper',
    state: 'running',
    lane: null,
    model: null,
    task: null,
    started: null,
    ended: null,
    outcome: null,
    ...extra,
  });
  const work = {
    kind: 'work',
    lane: 'widgets',
    branch: 'feat/x',
    pr: { number: 7 },
  } as unknown as BoardCard;
  const sessionOnly = {
    kind: 'session',
    lane: 'widgets',
    branch: null,
    pr: null,
  } as unknown as BoardCard;
  assert.equal(tiedToParent(agent({ task: 'fix the thing on feat/x' }), work), true);
  assert.equal(tiedToParent(agent({ task: 'review PR #7' }), work), true);
  assert.equal(
    tiedToParent(agent({ task: 'see https://github.com/acme/widgets/pull/7' }), work),
    true,
  );
  assert.equal(
    tiedToParent(agent({ task: 'review PR #70' }), work),
    false,
    'a longer number is another PR',
  );
  assert.equal(tiedToParent(agent({ task: 'something else' }), work), false);
  assert.equal(
    tiedToParent(agent({ task: 'on feat/x', lane: 'elsewhere' }), work),
    false,
    'a tag for another lane',
  );
  assert.equal(tiedToParent(agent({ task: 'on feat/x', lane: 'Widgets' }), work), true);
  assert.equal(
    tiedToParent(agent({ task: 'on feat/x' }), sessionOnly),
    false,
    'a session alone has no branch to share',
  );
  const onBranch = (branch: string, task: string) =>
    tiedToParent(agent({ task }), { ...work, branch } as unknown as BoardCard);
  for (const short of ['ui', 'docs', 'test']) {
    assert.equal(
      onBranch(short, `run the build ${short}s`),
      false,
      `${short} inside a longer word`,
    );
    assert.equal(
      onBranch(short, `work on ${short}-kit`),
      false,
      `${short} as a prefix of a branch`,
    );
    assert.equal(onBranch(short, `see feat/${short}`), false, `${short} as the tail of a path`);
    assert.equal(onBranch(short, `see ${short}/more`), false, `${short} as the head of a path`);
    assert.equal(onBranch(short, `read v1.${short} notes`), false, `${short} after a dot`);
    assert.equal(
      onBranch(short, `fix the ${short}.md file`),
      false,
      `${short} before a dot and a word`,
    );
    assert.equal(onBranch(short, `fix the ${short}`), true, `${short} at the end`);
    assert.equal(onBranch(short, `${short}: fix the thing`), true, `${short} at the start`);
    assert.equal(onBranch(short, `on the "${short}" branch, then (${short}), ok`), true);
    assert.equal(onBranch(short, `finish the ${short}. Then stop`), true, 'a sentence period');
  }
  assert.equal(onBranch('feat/x', 'fix the thing on feat/x-2'), false, 'a longer branch path');
  assert.equal(onBranch('feat/x', 'on origin/feat/x'), false, 'a remote path');
  assert.equal(onBranch('feat/x', 'work on feat/x, then feat/y'), true);
  assert.equal(onBranch('stack/4-agent-board', 'fix stack/4-agent-board.'), true);
  assert.equal(onBranch('release/1.2', 'cut release/1.2 today'), true, 'a dot inside the branch');
  assert.equal(
    onBranch('release/1.2', 'cut release/1x2 today'),
    false,
    'the dot is not a wildcard',
  );
  assert.equal(onBranch('FEAT/X', 'on feat/x'), true, 'case does not matter');
  const lanes = ['widgets', 'once-upon', 'SDK'];
  assert.equal(laneForAgent(agent({ lane: 'tagged' }), lanes, 'parent', 'none'), 'tagged');
  assert.equal(
    laneForAgent(agent({ task: 'in widgets-worktrees/x' }), lanes, 'parent', 'none'),
    'widgets',
  );
  assert.equal(
    laneForAgent(agent({ task: 'Once Upon a Diff review inbox' }), lanes, 'parent', 'none'),
    'once-upon',
  );
  assert.equal(laneForAgent(agent({ task: 'the SDK build' }), lanes, 'parent', 'none'), 'SDK');
  assert.equal(laneForAgent(agent({ task: 'sdkish thing' }), lanes, 'parent', 'none'), 'parent');
  assert.equal(laneForAgent(agent({ task: 'nothing' }), lanes, null, 'none'), 'none');
  // a lane whose name has no letters or digits matches nothing, instead of every task
  for (const empty of ['/', '--', '']) {
    const odd = [empty, ...lanes];
    assert.equal(laneForAgent(agent({ task: 'fix the build' }), odd, 'parent', 'none'), 'parent');
    assert.equal(
      laneForAgent(agent({ task: 'in --worktrees/x' }), odd, 'parent', 'none'),
      'parent',
    );
  }
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
  const inbox = inboxKey(TOKEN);

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

  // the page hands over its key: only the inbox's or the board's, only from that host's own page
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
  const inboxSet = await start(inbox, asHost({ Origin: origin }));
  const inboxCookie = ([inboxSet.headers['set-cookie']].flat()[0] as string).split(';')[0];
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

  // with the cookie the board loads, and each page's cookie reaches only its own routes
  const withCookie = (route: string, cookies: string, extra: Record<string, string> = {}) =>
    rawRequest(bridge.base, 'GET', route, asHost({ Cookie: cookies, ...extra }));
  assert.equal((await withCookie('/api/board', boardCookie)).status, 200);
  assert.equal(
    (await withCookie('/api/board', inboxCookie)).status,
    403,
    'the inbox cookie is not the board’s',
  );
  assert.equal((await withCookie('/api/inbox', boardCookie)).status, 403);
  assert.equal((await withCookie('/api/inbox', inboxCookie)).status, 200);
  assert.equal((await withCookie('/api/stories', boardCookie)).status, 403);
  // both cookies ride along on every request, and the route picks the one it takes
  const both = `${boardCookie}; ${inboxCookie}`;
  assert.equal((await withCookie('/api/board', both)).status, 200);
  assert.equal((await withCookie('/api/inbox', both)).status, 200);
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

  // the other page's link is made on the address the page was opened on, so it gets its own cookie there
  const link = await withCookie('/api/board/inbox-link?repo=acme/widgets', boardCookie);
  assert.equal(JSON.parse(link.text).url, `${origin}/inbox/#key=${inbox}&repo=acme%2Fwidgets`);
  // the way back is the board's address alone: the board's own cookie connects it there
  const back = await withCookie('/api/board/link', inboxCookie);
  assert.equal(JSON.parse(back.text).url, `${origin}/board/`);
  assert.ok(!back.text.includes(board));
  const onLoopback = await bridge.call<{ url: string }>('GET', '/api/board/link', undefined, {
    Authorization: `Bearer ${inbox}`,
  });
  assert.equal(onLoopback.body.url, `${bridge.base}/board/`);
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
    const auth = await import(`../public/local/auth.ts?${name}` as string);
    await auth.startAuth('page.abc', '/api/board/inbox-link');
    return { header: auth.authHeader('page.abc'), replaced, calls };
  };
  try {
    const worked = await scenario('worked', { cookie: true }, 200);
    assert.deepEqual(worked.header, {}, 'the cookie carries it');
    assert.deepEqual(worked.replaced, ['/board/#repo=acme%2Fwidgets']);
    assert.deepEqual(worked.calls, ['/auth/session', '/api/board/inbox-link']);

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
  assert.equal(await link('/api/inbox/link'), `${bridge.base}/inbox/#key=${inboxKey(TOKEN)}`);
  // the extension's ask: the proxy's name, which sets the cookie in its browser
  assert.equal(
    await link('/api/board/link?public=1'),
    `https://once-upon.test/board/#key=${boardKey(TOKEN)}`,
  );
  assert.equal(
    await link('/api/inbox/link?public=1&repo=acme/widgets'),
    `https://once-upon.test/inbox/#key=${inboxKey(TOKEN)}&repo=acme%2Fwidgets`,
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
    const { resolvesHere } = await import('../src/server/address.ts');
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
    name: null,
    away: false,
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
  writeFileSync(path.join(dir, 'paused'), '');
  assert.equal(voiceStatus(readVoice(dir) as typeof files, false, now), 'paused');
  writeFileSync(path.join(dir, 'away'), '');
  assert.equal(
    voiceStatus(readVoice(dir) as typeof files, false, now),
    'away',
    'away wins over paused',
  );
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
    lane: 'widgets',
    branch: 'main',
    status: 'working',
    since: data.voice?.since,
    agents: { running: 1, waiting: 1 },
    session: fullId(voice.pid),
    can_focus: false,
  });
  // its agents keep their own cards, still "from" the voice session
  const helper = cards.find((card) => card.id === `agent:${sid(voice)}:helper-two`);
  assert.equal(helper?.column, 'waiting');
  assert.equal(helper?.parent, 'Voice session', 'named for what it is, not its tab title');
  assert.equal(helper?.lane, 'widgets', 'in its parent’s lane');
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
  assert.equal((await make().snapshot()).voice, null);
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
  assert.equal(found.lane, 'widgets');
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
  const waiting = runCli(home, ['wait', '--repo', 'acme/widgets', '--timeout', '30']);
  await new Promise((resolve) => setTimeout(resolve, 1500));
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
  for (const key of [inboxKey(TOKEN), pageKey(TOKEN, 'x')]) {
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

test('a session whose only activity is a repo listener is in the Listeners lane alone, and is a card while it works', async () => {
  const tree = await parentWithChild();
  after(() => tree.stop());
  const sid = String(tree.parent).padStart(8, '0');
  const checkout = checkoutOf('widgets', 'main');
  type Case = {
    registry?: Record<string, unknown>;
    beat?: Record<string, unknown>;
    detail?: string;
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
        [sid]: { status: 'working', detail: variant.detail ?? '1 background task running' },
      }),
      now: () => NOW,
    });
    const data = await board.snapshot();
    return { data, cards: data.lanes.flatMap((lane) => lane.cards) };
  };
  const mine = (cards: BoardCard[]) =>
    cards.filter((card) => card.sessions.some((session) => session.id === fullId(tree.parent)));

  // only its wait is running: no card, and the lane names the session
  const quiet = await world({});
  assert.equal(mine(quiet.cards).length, 0, 'no card');
  assert.equal(quiet.data.listeners[0].repo, 'acme/widgets');
  assert.equal(quiet.data.listeners[0].active?.session, fullId(tree.parent));
  assert.equal(quiet.data.listeners[0].active?.title, 'Tab title');
  // it picked up a request: the wait handed it over, or its turn is running
  assert.equal(
    mine((await world({ beat: { state: 'handling' } })).cards).length,
    1,
    'handling a request',
  );
  const busy = await world({ registry: { status: 'busy' } });
  assert.equal(mine(busy.cards)[0]?.column, 'working', 'a turn is running');
  assert.equal(
    busy.data.listeners[0].active?.session,
    fullId(tree.parent),
    'and it is still in the lane',
  );
  // something besides its wait is running
  assert.equal(
    mine((await world({ detail: '2 background tasks running' })).cards).length,
    1,
    'another task',
  );
  const withAgent = await world({
    ledger: `- [running] sid:${sid} helper (sonnet, low) — a task — started 2:50 PM ET, 10/26`,
  });
  assert.equal(mine(withAgent.cards).length, 1, 'a subagent is running');
  // no listener at all: an ordinary card
  const none = await (async () => {
    const home = tmp('board-no-wait');
    const sessions = tmp('board-sessions');
    registry(sessions, tree.parent, { cwd: checkout, name: 'plain' }, tree.procStart);
    writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
    const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying({ [sid]: { status: 'working', detail: '1 background task running' } }),
      now: () => NOW,
    });
    return (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  })();
  assert.equal(mine(none).length, 1, 'no listener: a card');
});
