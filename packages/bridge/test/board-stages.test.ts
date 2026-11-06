import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, startBridge, TOKEN, type TestBridge } from './helpers.ts';
import { Board, noPrWatcher, type PrWatcher } from '@once-upon-a-diff/board/board';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { boardKey } from '@once-upon-a-diff/state/records/page-links/page-key';
import type { StatusSource } from '@once-upon-a-diff/adapters/status-source';

const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

const NOW = new Date('2026-10-26T19:00:00Z');

/** What stays true of Board after its build moved into stages (src/board/stages/): the two things a failed build must leave alone. */
test('a build that throws leaves what the board remembers (sessions seen, the listening input) as it was', async () => {
  const home = tmp('stages-home');
  const sessions = tmp('stages-sessions');
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  }).trim();
  writeJson(path.join(sessions, `${process.pid}.json`), {
    pid: process.pid,
    sessionId: 'stage-session-aaaa',
    cwd: '/tmp/stages/widgets',
    name: 'stage-one',
    status: 'busy',
    startedAt: NOW.getTime() - 3600000,
    statusUpdatedAt: NOW.getTime() - 600000,
    procStart,
  });
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  // a PR story, so the build makes a work card (and asks the watcher about it) after the sessions are placed
  writeJson(path.join(home, 'acme-widgets-7', 'meta.json'), {
    kind: 'github',
    repo: 'acme/widgets',
    number: 7,
    pr_title: 'PR 7',
    head_ref: 'feat/x',
  });
  writeJson(path.join(home, 'acme-widgets-7', 'chapters.json'), { title: 'Story 7', chapters: [] });
  let failing = false;
  const watcher: PrWatcher = {
    ...noPrWatcher,
    kickInfo: () => {
      if (failing) {
        throw new Error('GitHub watcher broke');
      }
    },
  };
  const source: StatusSource = {
    name: 'iterm',
    statuses: async () => new Map(),
  };
  let clock = NOW;
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source,
    now: () => clock,
  });
  const kept = () => board as unknown as { seen: Map<string, unknown>; listeningNow: unknown };

  await board.snapshot();
  const seenBefore = [...kept().seen.entries()];
  const listeningBefore = kept().listeningNow;
  assert.equal(seenBefore.length, 1, 'the live session is remembered');
  assert.ok(listeningBefore, 'the listening input is kept');

  failing = true;
  clock = new Date(NOW.getTime() + 60000); // past the kept answer
  await assert.rejects(board.snapshot(), /GitHub watcher broke/);
  assert.deepEqual(
    [...kept().seen.entries()],
    seenBefore,
    'seen is as the last good build left it',
  );
  assert.equal(kept().listeningNow, listeningBefore, 'so is the listening input');

  failing = false;
  clock = new Date(NOW.getTime() + 120000);
  assert.ok(await board.snapshot(), 'and the next build works');
  assert.notEqual(kept().listeningNow, listeningBefore, 'and replaces them');
});

test('GET /api/board/listen-sessions?story=: a story with no repo or checkout falls back to the repo asked for, and is a 400 without one', async () => {
  const home = tmp('stages-listen');
  const sessions = tmp('stages-sessions');
  const it2 = path.join(tmp('stages-it2'), 'it2');
  writeFileSync(it2, "#!/bin/sh\necho '[]'\n");
  chmodSync(it2, 0o755);
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: sessions,
    board_it2_path: it2,
    board_status_source: 'iterm',
  });
  // a local story whose meta names no checkout, so it has no repo and no folder to find sessions in
  writeJson(path.join(home, 'local-nowhere', 'meta.json'), {
    kind: 'local',
    repo_path: '',
    repo_name: 'nowhere',
    base: 'origin/main',
    head: 'HEAD',
    branch: 'main',
    title: 'Local nowhere',
  });
  writeJson(path.join(home, 'local-nowhere', 'chapters.json'), { title: 'Story', chapters: [] });
  const bridge = await startBridge({ home });
  open.push(bridge);
  const get = (route: string) =>
    bridge.call<{ repo?: string; sessions?: unknown[]; error?: string }>('GET', route, undefined, {
      Authorization: `Bearer ${boardKey(TOKEN)}`,
    });
  const bare = await get('/api/board/listen-sessions?story=local-nowhere');
  assert.equal(bare.status, 400);
  assert.match(bare.body.error as string, /no repo or checkout/);
  const fallback = await get('/api/board/listen-sessions?story=local-nowhere&repo=acme/widgets');
  assert.equal(fallback.status, 200);
  assert.deepEqual(fallback.body, { repo: 'acme/widgets', sessions: [] });
});
