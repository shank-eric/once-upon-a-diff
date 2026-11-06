import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmp, writeJson } from './helpers.ts';
import {
  branchKey,
  branchKeyPrefix,
  branchWorkKey,
  partsFileName,
  prKey,
  prKeyPrefix,
  prWorkKey,
  repoListenerName,
  stateKeyForPr,
} from '@once-upon-a-diff/domain/ids';
import { Board, noPrWatcher } from '@once-upon-a-diff/board/board';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { listenersLane } from '@once-upon-a-diff/core/features/listeners/board-view';
import type { Listener } from '@once-upon-a-diff/state/records/listeners/listeners';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';

// Eric, 11/6: shank-eric/larmor is a typo of naveenvasou/larmor, "let's use the naveenvasou name for now". Only the reading
// changes (ids.ts REPO_ALIASES): a card, a listener, a PR or a branch typed with the typo lands on the naveenvasou repo.

test('every repo-bearing key reads the typo as naveenvasou/larmor, and a prefix matches its keys', () => {
  const typo = 'Shank-Eric/Larmor';
  assert.equal(prKey(typo, 3), 'naveenvasou/larmor#3');
  assert.equal(prWorkKey(typo, 3), 'pr:naveenvasou/larmor#3');
  assert.equal(branchKey(typo, 'feat/x'), 'naveenvasou/larmor@feat/x');
  assert.equal(branchWorkKey(typo, 'feat/x'), 'branch:naveenvasou/larmor@feat/x');
  assert.equal(stateKeyForPr(typo, 3), 'pr-naveenvasou-larmor-3');
  assert.equal(repoListenerName(typo), 'repo-naveenvasou-larmor');
  assert.equal(partsFileName(typo), 'naveenvasou-larmor.json');
  assert.ok(prKey(typo, 3).startsWith(prKeyPrefix(typo)));
  assert.ok(branchKey(typo, 'b').startsWith(branchKeyPrefix(typo)));
  assert.ok(prKey(typo, 3).startsWith(prKeyPrefix('naveenvasou/larmor')));
  // any other repo of that name is its own
  assert.equal(prKey('other/larmor', 3), 'other/larmor#3');
});

test('a card typed shank-eric/larmor is in the naveenvasou/larmor lane, one lane with the cards typed right', async () => {
  const home = tmp('alias-lane');
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: tmp('alias-lane-sessions'),
    board_status_source: 'registry',
  });
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => new Date('2026-11-06T15:00:00.000Z'),
    repoOf: async () => null,
  });
  board.addBacklog({ title: 'Typed wrong', repo: 'shank-eric/larmor', by: 'board' });
  board.addBacklog({ title: 'Typed right', repo: 'naveenvasou/larmor', by: 'board' });
  const data = await board.snapshot();
  assert.deepEqual(
    data.lanes.map((lane) => [lane.key, lane.name, lane.cards.map((card) => card.title).sort()]),
    [['naveenvasou/larmor', 'larmor', ['Typed right', 'Typed wrong']]],
  );
});

test('a listener typed shank-eric/larmor is one row, naveenvasou/larmor, with its history', () => {
  const home = tmp('alias-listeners');
  const now = Date.parse('2026-11-06T15:00:00.000Z');
  const seen = new Date(now - 3600_000).toISOString();
  // history written before the alias, under the typo's key
  writeJson(path.join(home, 'listener-history.json'), {
    'shank-eric/larmor': {
      repo: 'shank-eric/larmor',
      consumer: 'repo-shank-eric-larmor',
      started_at: seen,
      last_seen: seen,
    },
  });
  const input = {
    home,
    now,
    parents: new Map<number, number>(),
    sessionByPid: new Map<number, string>(),
    sessions: new Map(),
    busy: new Set<string>(),
    candidatesFor: () => [],
  };
  const lone = listenersLane([], input);
  assert.deepEqual(
    lone.map((row) => [row.repo, row.last_seen]),
    [['naveenvasou/larmor', seen]],
  );
  const live = {
    consumer: 'repo-shank-eric-larmor',
    pid: 1,
    state: 'waiting',
    at: new Date(now).toISOString(),
    age_s: 0,
    live: true,
    question: null,
    questions: [],
    repo: 'shank-eric/larmor',
    story: null,
    session: null,
    no_relay: false,
    builds: false,
    fixes: false,
  } as Listener;
  const rows = listenersLane([live], input);
  assert.deepEqual(
    rows.map((row) => [row.repo, !!row.active]),
    [['naveenvasou/larmor', true]],
  );
});
