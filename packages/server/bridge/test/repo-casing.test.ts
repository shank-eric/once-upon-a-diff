import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmp, writeJson, runCli, startBridge, TOKEN } from './helpers.ts';
import { boardKey } from '@once-upon-a-diff/state/records/page-links/page-key';
import { git } from '@once-upon-a-diff/test-kit/git';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { canonicalCasing } from '@once-upon-a-diff/foundation/repos';
import { Board, noPrWatcher } from '@once-upon-a-diff/board/board';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { groupLanes } from '@once-upon-a-diff/board/stages/lanes';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';

// 11/20: two cards were added as everfi/everfi-frontend beside the others' EverFi/everfi-frontend, and would not drag above them.
// A card's repo is stored in the casing the checkout's origin or the other cards use, and the board compares repos without case.

const CANONICAL = 'EverFi/everfi-frontend';

/** A temp folder that is a git checkout whose origin is `remote` (no network: nothing is fetched). */
function checkoutOf(remote: string): string {
  const dir = tmp('casing-checkout');
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

test('canonicalCasing: origin first, then the most used card spelling, else as typed', () => {
  assert.equal(canonicalCasing('everfi/everfi-frontend', { origin: CANONICAL }), CANONICAL);
  assert.equal(
    canonicalCasing('everfi/everfi-frontend', {
      origin: 'acme/widgets',
      cardRepos: ['EVERFI/everfi-frontend', CANONICAL, CANONICAL, null],
    }),
    CANONICAL,
  );
  assert.equal(canonicalCasing('acme/widgets', { cardRepos: [CANONICAL] }), 'acme/widgets');
  // a spelling a card already has exactly stays, even when another spelling is used on more cards
  assert.equal(
    canonicalCasing('everfi/everfi-frontend', {
      cardRepos: ['everfi/everfi-frontend', CANONICAL, CANONICAL],
    }),
    'everfi/everfi-frontend',
  );
  assert.equal(canonicalCasing('', { origin: CANONICAL }), '');
  assert.equal(canonicalCasing(null, { origin: CANONICAL }), null);
});

test('backlog add with a lower-case repo stores the canonical name from the checkout origin', async () => {
  const home = tmp('casing-origin');
  const checkout = checkoutOf(`git@github.com:${CANONICAL}.git`);
  const added = await runCli(
    home,
    ['backlog', 'add', 'Typed lower', '--repo', 'everfi/everfi-frontend'],
    {},
    checkout,
  );
  assert.equal(added.code, 0, added.stderr);
  assert.deepEqual(
    new BacklogStore(home).listed().map((item) => item.repo),
    [CANONICAL],
  );
});

test('add, edit, start and claim keep the canonical name of the cards already there', async () => {
  const home = tmp('casing-cards');
  const store = new BacklogStore(home);
  store.add({ title: 'One', repo: CANONICAL, by: 'test' });
  store.add({ title: 'Two', repo: CANONICAL, by: 'test' });
  const elsewhere = tmp('casing-elsewhere');
  const run = (...args: string[]) => runCli(home, ['backlog', ...args], {}, elsewhere);

  const added = await run('add', 'Three', '--repo', 'everfi/everfi-frontend');
  assert.equal(added.code, 0, added.stderr);
  const three = store.listed().find((item) => item.title === 'Three');
  assert.equal(three?.repo, CANONICAL);

  const other = store.add({ title: 'Other', repo: 'acme/widgets', by: 'test' });
  const edited = await run('edit', other.id, '--repo', 'EVERFI/Everfi-Frontend');
  assert.equal(edited.code, 0, edited.stderr);
  assert.equal(store.listed().find((item) => item.id === other.id)?.repo, CANONICAL);

  const bare = store.add({ title: 'Bare', by: 'test' });
  const started = await run(
    'start',
    bare.id,
    '--branch',
    'feat/bare',
    '--repo',
    'everfi/EVERFI-frontend',
  );
  assert.equal(started.code, 0, started.stderr);
  assert.equal(store.listed().find((item) => item.id === bare.id)?.repo, CANONICAL);

  const open = store.add({ title: 'Open', by: 'test' });
  const claimed = await run(
    'claim',
    open.id,
    '--agent',
    'casing-author',
    '--branch',
    'feat/open',
    '--repo',
    'everfi/everfi-frontend',
  );
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.equal(store.listed().find((item) => item.id === open.id)?.repo, CANONICAL);
});

test('agent start takes the canonical name for a repo typed in another case', async () => {
  const home = tmp('casing-agent');
  const store = new BacklogStore(home);
  store.add({ title: 'One', repo: CANONICAL, by: 'test' });
  const started = await runCli(
    home,
    [
      'agent',
      'start',
      'casing-run',
      '--sid',
      'abcd1234',
      '--kind',
      'helper',
      '--task',
      'look',
      '--repo',
      'everfi/everfi-frontend',
      '--branch',
      'feat/casing',
    ],
    {},
    tmp('casing-agent-cwd'),
  );
  assert.equal(started.code, 0, started.stderr);
  const listed = await runCli(
    home,
    ['backlog', 'list', '--implicit', '--all', '--json'],
    {},
    tmp('casing-agent-cwd2'),
  );
  assert.equal(listed.code, 0, listed.stderr);
  const repos = (JSON.parse(listed.stdout) as { repo: string | null }[]).map((one) => one.repo);
  assert.deepEqual(repos, [CANONICAL]);
});

const card = (repo: string, id: string): BoardCard =>
  ({ id, kind: 'work', title: id, repo, lane: repo, column: 'backlog' }) as unknown as BoardCard;

test('the board groups cards whose repos differ only in case into one lane', async () => {
  assert.deepEqual(
    groupLanes([card('everfi/everfi-frontend', 'a'), card(CANONICAL, 'b')]).map((lane) => [
      lane.name,
      lane.cards.map((one) => one.id),
    ]),
    [['everfi-frontend', ['a', 'b']]],
  );

  const home = tmp('casing-board');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('casing-board-sessions') });
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => new Date('2026-11-20T15:00:00.000Z'),
    repoOf: async () => null,
  });
  board.addBacklog({ title: 'Lower', repo: 'everfi/everfi-frontend', by: 'board' });
  board.addBacklog({ title: 'Canonical', repo: CANONICAL, by: 'board' });
  const data = await board.snapshot();
  assert.equal(data.lanes.length, 1);
  assert.deepEqual(data.lanes[0].cards.map((one) => one.title).sort(), ['Canonical', 'Lower']);
});

test("the board's backlog add and edit routes store the canonical name of the cards already there", async () => {
  const home = tmp('casing-routes');
  const store = new BacklogStore(home);
  store.add({ title: 'One', repo: CANONICAL, by: 'test' });
  const other = store.add({ title: 'Other', repo: 'acme/widgets', by: 'test' });
  const bridge = await startBridge({ home });
  try {
    const withKey = { Authorization: `Bearer ${boardKey(TOKEN)}` };
    const added = await bridge.call(
      'POST',
      '/api/board/backlog',
      { title: 'Added', repo: 'everfi/everfi-frontend' },
      withKey,
    );
    assert.equal(added.status, 200);
    const edited = await bridge.call(
      'POST',
      '/api/board/backlog/edit',
      { id: other.id, repo: 'everfi/everfi-frontend' },
      withKey,
    );
    assert.equal(edited.status, 200);
    const repos = new Map(store.listed().map((item) => [item.title, item.repo]));
    assert.equal(repos.get('Added'), CANONICAL);
    assert.equal(repos.get('Other'), CANONICAL);
  } finally {
    await bridge.close();
  }
});
