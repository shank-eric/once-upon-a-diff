import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, git, registerRuns } from './helpers.ts';
import { Board, noPrWatcher } from '../src/orchestration/board/board.ts';
import { BacklogStore } from '../src/queues/backlog/backlog.ts';
import { checkoutsOf, pathsIn, type CheckoutFacts } from '../src/records/worktrees/checkouts.ts';
import { registrySource } from '../src/features/sessions/sources.ts';
import { StoryStore } from '../src/records/stories/store.ts';
import { Builds } from '../src/queues/requests/builds.ts';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';

test('pathsIn takes absolute and ~/ paths from a task, and leaves dates, urls, and/or and relative paths', () => {
  const task =
    'Build in ~/Development/SideProjects/larmor-worktrees/hold-while-talking, per /tmp/notes/plan.md. ' +
    'See https://github.com/acme/widgets/pull/9 on 10/28 (and/or src/board/board.ts). Also ~/.once-upon and /etc.';
  assert.deepEqual(pathsIn(task, '/home/eric'), [
    '/home/eric/Development/SideProjects/larmor-worktrees/hold-while-talking',
    '/tmp/notes/plan.md',
  ]);
  assert.deepEqual(pathsIn(null), []);
});

const facts = (extra: Partial<CheckoutFacts> = {}): CheckoutFacts => ({
  sessionDirs: [],
  agentTasks: [],
  seenDirs: [],
  dirOf: (candidate) => candidate,
  repoOf: async () => null,
  fallback: () => null,
  ...extra,
});

test('checkoutsOf keeps the folders whose origin is the repo, from sessions, agent tasks and seen checkouts; the fallback only when none', async () => {
  const remotes: Record<string, string> = {
    '/dev/widgets': 'Acme/Widgets',
    '/dev/widgets-worktrees/feature': 'acme/widgets',
    '/dev/seen-widgets': 'acme/widgets',
    '/dev/gadgets': 'acme/gadgets',
  };
  const found = await checkoutsOf(
    'acme/widgets',
    facts({
      sessionDirs: ['/dev/widgets/src', '/dev/gadgets'],
      agentTasks: ['work in /dev/widgets-worktrees/feature now', null, 'in /dev/gadgets'],
      seenDirs: ['/dev/seen-widgets', '/dev/gone'],
      repoOf: async (dir) => remotes[dir] ?? null,
      fallback: () => '/dev/fallback',
    }),
  );
  // /dev/widgets/src has no origin of its own in this fake, so only folders the lookup knows are kept
  assert.deepEqual(found.sort(), ['/dev/seen-widgets', '/dev/widgets-worktrees/feature']);
  const none = await checkoutsOf(
    'acme/widgets',
    facts({
      sessionDirs: ['/dev/gadgets'],
      repoOf: async (dir) => remotes[dir] ?? null,
      fallback: () => '/dev/fallback',
    }),
  );
  assert.deepEqual(none, ['/dev/fallback']);
  assert.deepEqual(await checkoutsOf('acme/widgets', facts()), []);
  // a lookup that throws leaves that folder out
  assert.deepEqual(
    await checkoutsOf(
      'acme/widgets',
      facts({
        sessionDirs: ['/dev/widgets'],
        repoOf: async () => {
          throw new Error('hung');
        },
      }),
    ),
    [],
  );
});

test('the board finds a started card’s worktree from its agent’s task path, with no recorded checkout and no checkout_dirs match', async () => {
  const sessions = tmp('checkouts-sessions');
  const parent = tmp('checkouts-repo');
  const checkout = path.join(parent, 'oddly-named-folder');
  mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  writeFileSync(path.join(checkout, 'a.txt'), 'a\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'base');
  // the worktree's folder is not named for the branch, so nothing but the path in the task ties it to the checkout
  const tree = path.join(parent, 'oddly-named-folder-worktrees', 'folder-x');
  mkdirSync(path.dirname(tree));
  git(checkout, 'worktree', 'add', '-q', tree, '-b', 'pick-me');
  const worktreesOf = async (task: string | null) => {
    const home = tmp('checkouts-board');
    if (task) {
      registerRuns(home, {
        sid: '54736864',
        name: 'builder-one',
        kind: 'author',
        task,
        started: '2026-10-26T18:30:00Z',
      });
    }
    writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
    const store = new BacklogStore(home);
    const item = store.add({ title: 'Pick me', repo: 'acme/widgets' });
    store.start(item.id, { branch: 'pick-me', repo: 'acme/widgets', by: 'someone' });
    const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: registrySource,
      now: () => new Date('2026-10-26T19:00:00Z'),
    });
    const card = (await board.snapshot()).lanes
      .flatMap((lane) => lane.cards)
      .find((one: BoardCard) => one.backlog?.id === item.id);
    return card?.backlog?.started?.links?.worktrees.map((one) => one.name);
  };
  assert.deepEqual(await worktreesOf(`build in ${tree}`), ['folder-x']);
  // from a file under it too
  assert.deepEqual(await worktreesOf(`edit ${path.join(tree, 'a.txt')}`), ['folder-x']);
  assert.deepEqual(await worktreesOf(null), [], 'without that, the checkout is not known');
});
