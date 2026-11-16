import '@once-upon-a-diff/test-kit/env';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { registerRuns } from '@once-upon-a-diff/state/test/helpers';
import {
  NOW,
  checkoutOf,
  fullId,
  liveChild,
  prStory,
  registry,
} from '@once-upon-a-diff/state/test/board-fixtures';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { Board, noPrWatcher } from '../src/board.ts';
import { sourceSaying } from './board-fixtures.ts';
import { endGoneSelfRuns, openSessions, selfSessions } from '../src/stages/self-runs.ts';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';

const run = (sid: string, name: string, state: LedgerAgent['state']): LedgerAgent => ({
  sid,
  name,
  state,
  model: null,
  modelName: null,
  task: 't',
  started: new Date('2026-11-16T14:00:00Z'),
  ended: state === 'done' ? new Date('2026-11-16T14:30:00Z') : null,
  outcome: null,
  kind: 'author',
  lastEvent: new Date('2026-11-16T14:10:00Z'),
});

test('a session is registered once it has a self run, open while one is', () => {
  const agents = [
    run('aaaaaaa1', 'self-111111', 'done'),
    run('bbbbbbb2', 'self-222222', 'running'),
    run('ccccccc3', 'ou-plain', 'running'),
  ];
  const { registered, open } = selfSessions(agents);
  assert.deepEqual([...registered], ['aaaaaaa1', 'bbbbbbb2']);
  assert.deepEqual([...open], ['bbbbbbb2']);
});

test('an open self run of a session that is gone reads stopped at its last sign of life; an empty scan changes nothing', () => {
  const agents = [
    run('aaaaaaa1', 'self-111111', 'running'),
    run('bbbbbbb2', 'self-222222', 'running'),
    run('aaaaaaa1', 'ou-plain', 'running'),
  ];
  const seen = endGoneSelfRuns(agents, ['bbbbbbb2']);
  assert.deepEqual(
    seen.map((one) => one.state),
    ['stopped', 'running', 'running'],
  );
  assert.equal(seen[0].ended?.toISOString(), '2026-11-16T14:10:00.000Z');
  assert.equal(agents[0].state, 'running', 'the board never rewrites what it was given');
  assert.equal(endGoneSelfRuns(agents, []), agents);
});

/** A board with one live session and a card whose self run belongs to another, unregistered session. */
async function boardWithGoneSelfRun(extra?: (dir: string) => () => void) {
  const home = tmp('self-gone-board-home');
  const sessions = tmp('self-gone-board-sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Its session closed', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'feat/self-gone', repo: 'acme/widgets' });
  registerRuns(home, {
    sid: 'eeeeeeee',
    name: 'self-eeeee1',
    kind: 'author',
    card: item.id,
    branch: 'feat/self-gone',
    repo: 'acme/widgets',
    started: new Date(NOW.getTime() - 3600000),
  });
  const live = liveChild();
  registry(sessions, live.pid, {}, live.procStart);
  const cleanup = extra?.(sessions);
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  const text = JSON.stringify(await board.snapshot());
  live.stop();
  cleanup?.();
  return text;
}

test('the board shows a self run stopped when its session is not among the live ones', async () => {
  assert.match(await boardWithGoneSelfRun(), /its session ended/);
});

test('a live session whose registry file could not be read is unknown, not gone, so its self run is left open', async () => {
  const text = await boardWithGoneSelfRun((dir) => {
    // the rewrite Claude Code does on every busy/idle change, caught mid-write, of a process that runs
    const other = liveChild();
    writeFileSync(path.join(dir, `${other.pid}.json`), '{"pid": 1, "sessionId": "eeeeeeee-aa');
    return other.stop;
  });
  assert.doesNotMatch(text, /its session ended/);
});

test('openSessions holds the first 8 of every session with a work run (author, fixer) open, no other kind', () => {
  const agents = [
    run('aaaaaaa1', 'self-111111', 'done'),
    run('bbbbbbb2', 'ou-plain', 'running'),
    run('ccccccc3', 'ou-waiting', 'waiting'),
    run('ddddddd4', 'ou-done', 'done'),
    { ...run('eeeeeee5', 'ou-research', 'running'), kind: 'research' as const },
    { ...run('fffffff6', 'ou-helper', 'running'), kind: 'helper' as const },
    { ...run('ggggggg7', 'ou-critic', 'running'), kind: 'critic' as const },
    { ...run('hhhhhhh8', 'ou-fixer', 'fixing'), role: 'fixer' as const },
  ];
  assert.deepEqual([...openSessions(agents)].sort(), ['bbbbbbb2', 'ccccccc3', 'hhhhhhh8']);
});

/** One busy session `busy` (a live child, iTerm says working) and one idle, each in `cwd`; `setup` adds runs, a story, a bad file. */
async function thinkingWorld(opts: {
  cwd?: string;
  prep?: (home: string, sid: string, sessions: string) => void;
  say?: 'working' | 'waiting';
  name?: string;
}) {
  const home = tmp('thinking-home');
  const sessions = tmp('thinking-sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const busy = liveChild();
  const idle = liveChild();
  const sid = String(busy.pid).padStart(8, '0');
  const cwd = opts.cwd ?? tmp('thinking-no-repo');
  registry(sessions, busy.pid, { cwd, name: 'busy-one' }, busy.procStart);
  registry(sessions, idle.pid, { cwd: tmp('thinking-idle'), name: 'idle-one' }, idle.procStart);
  opts.prep?.(home, sid, sessions);
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({ [sid]: { status: opts.say ?? 'working', detail: null } }),
    now: () => NOW,
  });
  const data = await board.snapshot();
  busy.stop();
  idle.stop();
  const cards = data.lanes.flatMap((lane) => lane.cards);
  const cardOf = (child: { pid: number }) =>
    cards.find((card) => card.sessions.some((one) => one.id === fullId(child.pid)));
  return {
    data,
    cards,
    busyCard: cardOf(busy),
    idleCard: cardOf(idle),
    busyId: fullId(busy.pid),
    sid,
  };
}

test('a busy session with no run and no work card is Thinking; an idle one is not', async () => {
  const { busyCard, idleCard, busyId } = await thinkingWorld({});
  assert.equal(busyCard?.column, 'thinking');
  assert.equal(busyCard?.sessions.find((one) => one.id === busyId)?.thinking, true);
  assert.notEqual(idleCard?.column, 'thinking');
  assert.equal(idleCard?.sessions[0].thinking, undefined);
});

test('a busy session whose only run is finished is Thinking', async () => {
  const { busyCard } = await thinkingWorld({
    prep: (home, sid) => {
      registerRuns(home, {
        sid,
        name: 'ou-old',
        started: new Date(NOW.getTime() - 7200000),
        now: { state: 'done', at: new Date(NOW.getTime() - 3600000), outcome: 'ok' },
      });
    },
  });
  assert.equal(busyCard?.column, 'thinking');
});

test('a busy session with a run open under its sid is not Thinking', async () => {
  const { busyCard } = await thinkingWorld({
    prep: (home, sid) => {
      registerRuns(home, {
        sid,
        name: 'ou-open',
        kind: 'author',
        started: new Date(NOW.getTime() - 60000),
      });
    },
  });
  assert.notEqual(busyCard?.column, 'thinking');
  assert.equal(busyCard?.sessions[0].thinking, undefined);
});

test('a busy session whose only open run under its sid is a research or helper run is Thinking', async () => {
  for (const kind of ['research', 'helper'] as const) {
    const { busyCard } = await thinkingWorld({
      prep: (home, sid) => {
        registerRuns(home, {
          sid,
          name: `ou-${kind}`,
          kind,
          started: new Date(NOW.getTime() - 60000),
        });
      },
    });
    assert.equal(busyCard?.column, 'thinking', kind);
    assert.equal(busyCard?.sessions[0].thinking, true, kind);
  }
});

test('a busy session whose card has a started backlog item keeps it Working', async () => {
  const checkout = checkoutOf('widgets', 'feat/item');
  const { busyCard, busyId } = await thinkingWorld({
    cwd: checkout,
    prep: (home) => {
      const store = new BacklogStore(home);
      const item = store.add({ title: 'The item', repo: 'acme/widgets' });
      store.start(item.id, { branch: 'feat/item', repo: 'acme/widgets' });
    },
  });
  assert.equal(busyCard?.kind, 'session');
  assert.equal(busyCard?.column, 'working');
  assert.equal(busyCard?.sessions.find((one) => one.id === busyId)?.thinking, undefined);
});

test('a busy session whose card has another session’s run riding on it keeps it Working', async () => {
  const checkout = checkoutOf('widgets', 'feat/ride');
  const { busyCard, busyId } = await thinkingWorld({
    cwd: checkout,
    prep: (home) => {
      registerRuns(home, {
        sid: 'ffffffff',
        name: 'ou-rider',
        kind: 'author',
        card: 'ic_ridercard123',
        repo: 'acme/widgets',
        branch: 'feat/ride',
        started: new Date(NOW.getTime() - 7200000),
        now: { state: 'done', at: new Date(NOW.getTime() - 600000), outcome: 'ok' },
      });
    },
  });
  assert.equal(busyCard?.kind, 'session');
  assert.equal(busyCard?.agents.length, 1, 'the run rides on the session card');
  assert.equal(busyCard?.column, 'working');
  assert.equal(busyCard?.sessions.find((one) => one.id === busyId)?.thinking, undefined);
});

test('a busy session on a work card stays on it and keeps the card Working', async () => {
  const checkout = checkoutOf('widgets', 'feat/x');
  const { busyCard, busyId } = await thinkingWorld({
    cwd: checkout,
    prep: (home) => prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x'),
  });
  assert.equal(busyCard?.column, 'working');
  assert.equal(busyCard?.story?.id, 'acme-widgets-7');
  assert.equal(busyCard?.sessions.find((one) => one.id === busyId)?.thinking, undefined);
});

test('an unusable registry file beside a busy session puts nothing in Thinking', async () => {
  const { busyCard } = await thinkingWorld({
    prep: (_home, _sid, sessions) => {
      const other = liveChild();
      after(other.stop);
      writeFileSync(
        path.join(sessions, `${other.pid}.json`),
        '{"pid": 1, "sessionId": "eeeeeeee-aa',
      );
    },
  });
  assert.notEqual(busyCard?.column, 'thinking');
});

test('an unusable registry file also stops a registered session being Thinking', async () => {
  const { busyCard } = await thinkingWorld({
    prep: (home, sid, sessions) => {
      registerRuns(home, {
        sid,
        name: `self-${sid.slice(0, 6)}`,
        started: new Date(NOW.getTime() - 7200000),
        now: { state: 'done', at: new Date(NOW.getTime() - 3600000), outcome: 'ok' },
      });
      const other = liveChild();
      after(other.stop);
      writeFileSync(
        path.join(sessions, `${other.pid}.json`),
        '{"pid": 1, "sessionId": "eeeeeeee-aa',
      );
    },
  });
  assert.notEqual(busyCard?.column, 'thinking');
});

test('a registered busy session with no run open stays Thinking when the scan is sound', async () => {
  const { busyCard } = await thinkingWorld({
    prep: (home, sid) => {
      registerRuns(home, {
        sid,
        name: `self-${sid.slice(0, 6)}`,
        started: new Date(NOW.getTime() - 7200000),
        now: { state: 'done', at: new Date(NOW.getTime() - 3600000), outcome: 'ok' },
      });
    },
  });
  assert.equal(busyCard?.column, 'thinking');
});

test('a busy editor session is in the editors strip, never Thinking', async () => {
  const { cards, data, busyId } = await thinkingWorld({
    prep: (home, sid) => {
      new AgentRegistry(home).start({
        name: 'editor-one',
        sid,
        session: `${sid}-aaaa-bbbb-cccc-dddddddddddd`,
        kind: 'editor',
        task: 'queue',
        slots: 2,
        at: new Date(NOW.getTime() - 3600000),
      });
    },
  });
  assert.equal(
    cards.some((card) => card.sessions.some((one) => one.id === busyId)),
    false,
  );
  assert.equal(JSON.stringify(data.editors).includes(busyId), true);
});
