import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { registerRuns } from '@once-upon-a-diff/state/test/helpers';
import { NOW, liveChild, registry } from '@once-upon-a-diff/state/test/board-fixtures';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { Board, noPrWatcher } from '../src/board.ts';
import { sourceSaying } from './board-fixtures.ts';
import { endGoneSelfRuns, selfSessions } from '../src/stages/self-runs.ts';
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
