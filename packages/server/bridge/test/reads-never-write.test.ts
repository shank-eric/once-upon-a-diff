/**
 * ADR-26 "reads never write": a board read and a read-only CLI command leave the home as it was, and the writers make the
 * home (owner-only) themselves, also when it is not there yet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { runCli, tmp, writeJson } from './helpers.ts';
import { listenersLane } from '@once-upon-a-diff/core/features/listeners/board-view';
import { markFinished } from '@once-upon-a-diff/adapters/stores/finished-agents';
import { noteAsking } from '@once-upon-a-diff/state/queues/requests/conversation';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import type { Listener } from '@once-upon-a-diff/state/records/listeners/listeners';

const modeOf = (file: string) => (statSync(file).mode & 0o777).toString(8);
const listing = (home: string) => readdirSync(home).sort();

test('the board’s Listeners lane reads the history and writes nothing', () => {
  const home = tmp('reads-lane');
  const now = Date.parse('2026-11-06T15:00:00.000Z');
  const live = {
    consumer: 'repo-acme-widgets',
    pid: 1,
    state: 'waiting',
    at: new Date(now).toISOString(),
    age_s: 0,
    live: true,
    question: null,
    questions: [],
    repo: 'acme/widgets',
    story: null,
    session: null,
    no_relay: false,
    builds: false,
    fixes: false,
  } as Listener;
  const rows = listenersLane([live], {
    home,
    now,
    parents: new Map<number, number>(),
    sessionByPid: new Map<number, string>(),
    sessions: new Map(),
    busy: new Set<string>(),
    candidatesFor: () => [],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(listing(home), [], 'a board read wrote into the home');
});

test('read-only commands leave a home’s files and mode alone, and make no config.json', async () => {
  const home = tmp('reads-cli');
  chmodSync(home, 0o755);
  for (const args of [['agent', 'list'], ['backlog', 'list'], ['doctor']]) {
    await runCli(home, args);
    assert.equal(modeOf(home), '755', `${args.join(' ')} changed the home's mode`);
    assert.deepEqual(listing(home), [], `${args.join(' ')} wrote into the home`);
  }
});

test('the commands that hand out the token still make the home and config.json', async () => {
  const home = path.join(tmp('reads-token'), 'once-upon');
  const run = await runCli(home, ['token']);
  assert.equal(run.code, 0);
  assert.match(run.stdout.trim(), /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(modeOf(home), '700');
  assert.equal(modeOf(path.join(home, 'config.json')), '600');
});

test('a first write to a home that is not there yet makes it owner-only, whichever writer it is', async () => {
  const parent = tmp('reads-fresh');
  const fresh = (name: string) => path.join(parent, name);
  const made = async (name: string, run: (home: string) => unknown) => {
    const home = fresh(name);
    await run(home);
    assert.equal(modeOf(home), '700', `${name}: the home is not owner-only`);
  };
  await made('agent-start', async (home) => {
    const run = await runCli(home, [
      'agent',
      'start',
      'one',
      '--kind',
      'helper',
      '--task',
      'a task',
      '--sid',
      'abcd1234',
    ]);
    assert.equal(run.code, 0, run.stderr);
  });
  await made('backlog-add', async (home) => {
    const run = await runCli(home, ['backlog', 'add', 'something for later']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(modeOf(path.join(home, 'backlog.jsonl')), '600');
  });
  await made('wait-repo', async (home) => {
    await runCli(home, ['wait', '--repo', 'acme/widgets', '--timeout', '1']); // a timeout may exit non-zero: what it wrote is the check
    assert.ok(existsSync(path.join(home, 'listener-history.json')));
  });
  await made('builds', (home) => new Builds(home).save({}));
  await made('asking', (home) => noteAsking(home, 'q1', 'looking', null));
  await made('finished', (home) => markFinished(home, 'abcd1234:one', Date.now()));
});

test('`agent sweep` removes a gone session’s day-old status line file; the board’s read does not', async () => {
  const home = tmp('reads-sweep');
  const sessions = tmp('reads-sweep-sessions'); // no live session
  writeJson(path.join(home, 'config.json'), {
    port: 48999,
    token: 'x'.repeat(24),
    board_sessions_dir: sessions,
  });
  const dir = path.join(home, 'statusline');
  mkdirSync(dir);
  const file = path.join(dir, '33333333-aaaa-bbbb-cccc-dddddddddddd.json');
  writeFileSync(file, JSON.stringify({ at: 1, context: 5 }));
  const old = new Date(Date.now() - 2 * 86400 * 1000);
  utimesSync(file, old, old);
  const run = await runCli(home, ['agent', 'sweep']);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /1 status line file\(s\) of gone sessions removed/);
  assert.equal(existsSync(file), false);
});
