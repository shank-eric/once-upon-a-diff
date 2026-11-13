import '@once-upon-a-diff/test-kit/env';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { git } from '@once-upon-a-diff/test-kit/git';
import { registerRuns, type AgentRun } from '@once-upon-a-diff/state/test/helpers';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { Sessions, type SessionsFeed } from '@once-upon-a-diff/core/features/sessions/sessions';
import { Board, liveSessions, noPrWatcher } from '../src/board.ts';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import {
  listenCandidates,
  listenStoryPromptFor,
  type ListeningInput,
} from '@once-upon-a-diff/core/features/sessions/listening';
import { adoptHandlers, sessionOfPid } from '@once-upon-a-diff/core/features/listeners/board-view';
import { listenPrompt, type Listener } from '@once-upon-a-diff/state/records/listeners/listeners';
import { type LiveSession } from '@once-upon-a-diff/adapters/claude-sessions/live-sessions';
import { noteListener, readHistory } from '@once-upon-a-diff/state/records/listeners/history';
import {
  repoStopReason,
  requestStop,
  stopRequested,
} from '@once-upon-a-diff/core/features/listeners/auto-stop';
import { focusTab, itermSource, typeLine } from '@once-upon-a-diff/adapters/iterm';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import {
  type BoardCard,
  type BoardData,
  type BoardSession,
} from '@once-upon-a-diff/contracts/types';
import {
  NOW,
  checkoutOf,
  fakeIt2,
  fakeLarmor,
  fullId,
  liveChild,
  localStory,
  prStory,
  procStartOf,
  registry,
} from '@once-upon-a-diff/state/test/board-fixtures';
import { etAt, fakeWatcher, parentWithChild, prInfo, sourceSaying } from './board-fixtures.ts';

/** A pid that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid as number;
}

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

test('live sessions: oldest start first, then lowest pid, a session with no start last, whatever order the files list in', async () => {
  const dir = tmp('board-session-order');
  const children = [liveChild(), liveChild(), liveChild(), liveChild()];
  after(() => children.forEach((child) => child.stop()));
  // by pid, whatever the machine handed out (a pid can wrap round)
  const [low, second, third, high] = [...children].sort((first, other) => first.pid - other.pid);
  const start = NOW.getTime() - 3600000;
  // readdir lists these by file name as strings ("1", "100", "2", "99"), which is neither the pids' order nor the start order,
  // and "100" before "99" is the digit boundary a real pid pair crosses
  const files: [string, { pid: number; procStart: string }, number | undefined][] = [
    ['1', low, start + 3000], // started last
    ['99', second, start], // started first, lower pid than `high`
    ['2', third, undefined], // no start recorded
    ['100', high, start], // same start as `second`
  ];
  for (const [name, child, startedAt] of files) {
    writeJson(path.join(dir, `${name}.json`), {
      pid: child.pid,
      sessionId: fullId(child.pid),
      cwd: '/tmp/somewhere/widgets',
      status: 'idle',
      procStart: child.procStart,
      ...(startedAt === undefined ? {} : { startedAt }),
    });
  }
  const expected = [second, high, low, third].map((child) => child.pid);
  for (let poll = 0; poll < 2; poll++) {
    assert.deepEqual(
      (await liveSessions(dir)).map((session) => session.pid),
      expected,
      `poll ${poll + 1}: same order every time`,
    );
  }
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
  // the repo listener's own heartbeat notes it (the board only reads the history)
  noteListener(home, 'acme/widgets', 'repo-acme-widgets', NOW.getTime());
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
  assert.ok(widgets.active?.since, 'the listener noted when it began');
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
    agents?: AgentRun[];
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
    registerRuns(home, ...(variant.agents ?? []));
    writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
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
  // real other work stays a card: a running subagent, a tab waiting on you
  const withAgent = await world({
    agents: [{ sid, name: 'helper', started: etAt(14, 50) }],
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
    owner: process.pid,
    last_listen: 5,
    last_speak: 4,
  });
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_larmor_dir: fakeLarmor(voiceDir),
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
