/**
 * One piece of work, one card (bl_mwe3xfg6b0c05a). Work and its card are joined when the card is written (`backlog add --branch`
 * adopts an implicit card with a run open on that branch), and `backlog drop` of a card with an open run is refused unless `--into` moves the runs to another card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runCli, tmp, writeJson } from './helpers.ts';
import { Board, noPrWatcher } from '@once-upon-a-diff/board/board';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { cardRunProblems } from '@once-upon-a-diff/state/queues/backlog/phase';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { strictAgentEvent } from '@once-upon-a-diff/contracts/files/strict';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';

const SID = 'abcdef01';
const env = { CLAUDE_CODE_SESSION_ID: `${SID}-1111-4222-8333-444444444444` };
const REPO = 'acme/widgets';

const agent = (home: string, ...args: string[]) => runCli(home, ['agent', ...args], env);
const backlog = (home: string, ...args: string[]) => runCli(home, ['backlog', ...args], env);
const start = async (home: string, ...args: string[]) => {
  const done = await agent(home, 'start', ...args);
  assert.equal(done.code, 0, done.stderr);
  const [id, run, card] = done.stdout.trim().split(' ');
  return { id, run, card };
};
const add = async (home: string, title: string, branch: string | null, repo = REPO) => {
  const done = await backlog(
    home,
    'add',
    title,
    '--note',
    `${title}: the note`,
    '--repo',
    repo,
    ...(branch ? ['--branch', branch] : []),
  );
  assert.equal(done.code, 0, done.stderr);
  return done.stdout.trim().split(' ')[0];
};
const boardOf = (home: string) => {
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('dup-sessions') });
  return new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => new Date(),
  });
};
const cardsOf = async (home: string): Promise<BoardCard[]> =>
  (await boardOf(home).snapshot()).lanes.flatMap((lane) => lane.cards);
/** The cards that are the backlog card, or carry it as `from_backlog`. */
const mine = (cards: BoardCard[], id: string) =>
  cards.filter(
    (card) => card.backlog?.id === id || card.from_backlog?.some((one) => one.id === id),
  );
const names = (card: BoardCard) => card.agents.map((one) => one.name).sort();
const rows = (home: string) =>
  readFileSync(path.join(home, 'backlog.jsonl'), 'utf8').trim().split('\n');

/** An ad-hoc author that built on `branch`, and its critic, on one implicit card. */
async function adhoc(home: string, branch: string, author = 'ou-dup', critic = 'review-dup') {
  const built = await start(
    home,
    author,
    '--role',
    'author',
    '--repo',
    REPO,
    '--branch',
    branch,
    '--task',
    'build it',
  );
  assert.equal((await agent(home, 'finish', author, '--commit', 'abc1234')).code, 0);
  const review = await agent(
    home,
    'start',
    critic,
    '--role',
    'critic',
    '--card',
    built.card,
    '--task',
    'review',
  );
  assert.equal(review.code, 0, review.stderr);
  return built.card;
}

test('work first, then card: backlog add on the branch adopts the open implicit card with its title and note, and says so', async () => {
  const home = tmp('dup-work-first');
  const implicitId = await adhoc(home, 'dup-a');
  assert.ok(implicitId.startsWith('bl_'));
  const done = await backlog(
    home,
    'add',
    'Fix the widget',
    '--note',
    'The note',
    '--repo',
    REPO,
    '--branch',
    'dup-a',
  );
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, new RegExp(`${implicitId}.*joined`));
  const adds = rows(home)
    .map((row) => JSON.parse(row))
    .filter((row) => row.op === 'add');
  assert.equal(adds.length, 1, 'one card in backlog.jsonl');
  assert.equal(adds[0].id, implicitId, 'under the implicit id, as adopt writes it');
  // (the card was stored by the start, ADR-29: the add is that one, and the typed title and note are an edit after the link that lists it)
  const [listed] = new BacklogStore(home).listed();
  assert.equal(listed.id, implicitId);
  assert.equal(listed.title, 'Fix the widget');
  assert.equal(listed.note, 'The note');
  const found = mine(await cardsOf(home), implicitId);
  assert.equal(found.length, 1, 'one card on the board');
  assert.equal((await cardsOf(home)).filter((card) => card.kind === 'agent').length, 0);
  assert.equal(found[0].title, 'Fix the widget');
  assert.deepEqual(names(found[0]), ['ou-dup', 'review-dup']);
});

test('a card that matches no open implicit card is a plain add: another branch, another repo, or work that is over', async () => {
  const home = tmp('dup-plain-add');
  await adhoc(home, 'dup-a');
  const other = await add(home, 'Other branch', 'dup-other');
  const elsewhere = await add(home, 'Other repo', 'dup-a', 'acme/gadgets');
  assert.ok(other.startsWith('bl_') && elsewhere.startsWith('bl_'));
  assert.equal((await agent(home, 'finish', 'review-dup', '--findings', '0')).code, 0);
  const reused = await add(home, 'Added after the work', 'dup-a');
  assert.ok(
    reused.startsWith('bl_'),
    'a branch name reused after the work finished is its own card',
  );
  const cards = await cardsOf(home);
  for (const id of [other, elsewhere, reused]) {
    const found = mine(cards, id);
    assert.equal(found.length, 1, id);
    assert.equal(found[0].kind, 'backlog', `${id} is its own card in Backlog`);
  }
  assert.equal(
    cards.filter((card) => card.kind === 'agent').length,
    1,
    'the work is still its card',
  );
});

test('a card added on a default branch is a plain add, even with an author open on that branch', async () => {
  const home = tmp('dup-defaults');
  const main = await adhoc(home, 'main');
  assert.ok(main.startsWith('bl_'));
  const added = await add(home, 'On main', 'main');
  assert.ok(added.startsWith('bl_'), 'no adopting of the implicit card on main');
  assert.equal(mine(await cardsOf(home), added).length, 1);
  assert.ok(
    !new BacklogStore(home).listed().some((one) => one.id === main),
    'the implicit card was not adopted',
  );
});

test('doctor names each existing duplicate pair and the drop --into that merges it; it merges nothing', async () => {
  const home = tmp('dup-doctor');
  const implicitId = await adhoc(home, 'dup-a');
  // the duplicate as it was made before a join happened at write time: a bl_ card written by hand
  const store = new BacklogStore(home);
  const twin = store.add({ title: 'The twin', repo: REPO, branch: 'dup-a' });
  const lone = store.add({ title: 'On another branch', repo: REPO, branch: 'dup-other' });
  const before = rows(home).length;
  const done = await runCli(home, ['doctor'], env);
  const text = `${done.stdout}${done.stderr}`;
  assert.match(text, new RegExp(`${twin.id}.*${implicitId}`));
  assert.match(text, new RegExp(`backlog drop ${twin.id} --into ${implicitId}`));
  assert.doesNotMatch(text, new RegExp(`drop ${lone.id}`));
  assert.equal(rows(home).length, before, 'doctor merged nothing');
});

test('backlog drop refuses a card with an open run and names --into; nothing is written', async () => {
  const home = tmp('dup-drop-refused');
  const open = await add(home, 'Has an open run', 'dup-b');
  assert.equal((await backlog(home, 'claim', open, '--agent', 'ou-y')).code, 0);
  assert.equal(
    (await agent(home, 'start', 'ou-y', '--role', 'author', '--card', open, '--task', 't')).code,
    0,
  );
  const before = rows(home).length;
  const runsBefore = new AgentRegistry(home).events().length;
  const refused = await backlog(home, 'drop', open);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /--into/);
  assert.match(refused.stderr, /open run/);
  assert.equal(rows(home).length, before, 'backlog.jsonl is as it was');
  assert.equal(new AgentRegistry(home).events().length, runsBefore);
});

test('a card whose runs are all over drops with no --into: a failed author, a finished critic, and the board Drop', async () => {
  const home = tmp('dup-drop-over');
  const failed = await add(home, 'The author failed', 'dup-a');
  assert.equal((await backlog(home, 'claim', failed, '--agent', 'ou-f')).code, 0);
  assert.equal(
    (await agent(home, 'start', 'ou-f', '--role', 'author', '--card', failed, '--task', 't')).code,
    0,
  );
  assert.equal(
    (await agent(home, 'finish', 'ou-f', '--state', 'failed', '--outcome', 'no luck')).code,
    0,
  );
  const dropped = await backlog(home, 'drop', failed);
  assert.equal(dropped.code, 0, dropped.stderr);
  const critic = await add(home, 'Has a finished critic', 'dup-b');
  assert.equal(
    (await agent(home, 'start', 'review-x', '--role', 'critic', '--card', critic, '--task', 'r'))
      .code,
    0,
  );
  assert.equal((await agent(home, 'finish', 'review-x', '--findings', '0')).code, 0);
  const viaBoard = await add(home, 'Dropped from the board', 'dup-c');
  assert.equal((await backlog(home, 'claim', viaBoard, '--agent', 'ou-g')).code, 0);
  assert.equal(
    (await agent(home, 'start', 'ou-g', '--role', 'author', '--card', viaBoard, '--task', 't'))
      .code,
    0,
  );
  assert.equal(
    (await agent(home, 'finish', 'ou-g', '--state', 'failed', '--outcome', 'stuck')).code,
    0,
  );
  assert.equal(boardOf(home).dropBacklog(viaBoard, 'board').state, 'dropped');
  assert.equal((await backlog(home, 'drop', critic)).code, 0);
  const states = new BacklogStore(home).items().map((one) => one.state);
  assert.deepEqual(states, ['dropped', 'dropped', 'dropped']);
});

test('backlog drop refuses an implicit card with an open run, and takes one whose runs are all finished', async () => {
  const home = tmp('dup-drop-implicit');
  const live = await start(home, 'a-scout', '--kind', 'research', '--task', 'look');
  const refused = await backlog(home, 'drop', live.card);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /--into/);
  assert.equal(new BacklogStore(home).listed().length, 0, 'not adopted, not dropped');
  assert.equal((await agent(home, 'finish', 'a-scout')).code, 0);
  const done = await backlog(home, 'drop', live.card);
  assert.equal(done.code, 0, done.stderr);
});

test('the board Drop button refuses a card that has runs the same way', async () => {
  const home = tmp('dup-button');
  const id = await add(home, 'Has a run', 'dup-a');
  assert.equal((await backlog(home, 'claim', id, '--agent', 'ou-x')).code, 0);
  assert.equal(
    (await agent(home, 'start', 'ou-x', '--role', 'author', '--card', id, '--task', 't')).code,
    0,
  );
  const board = boardOf(home);
  assert.throws(() => board.dropBacklog(id, 'board'), /--into/);
  assert.equal(new BacklogStore(home).items()[0].state, 'open');
  const empty = await add(home, 'No runs', 'dup-c');
  assert.equal(board.dropBacklog(empty, 'board').state, 'dropped');
});

test('backlog drop --into moves every run, finished and earlier ones too, onto the other card and the board shows one card', async () => {
  const home = tmp('dup-into');
  const source = await add(home, 'The duplicate', 'dup-a');
  const target = await add(home, 'The real card', 'dup-a');
  assert.equal((await backlog(home, 'claim', source, '--agent', 'ou-src')).code, 0);
  // an author restarted under its name (an earlier run), a finished critic, and a run still going
  for (const task of ['one', 'two']) {
    assert.equal(
      (await agent(home, 'start', 'ou-src', '--role', 'author', '--card', source, '--task', task))
        .code,
      0,
    );
    if (task === 'one') {
      assert.equal((await agent(home, 'finish', 'ou-src')).code, 0);
    }
  }
  assert.equal(
    (await agent(home, 'start', 'review-src', '--role', 'critic', '--card', source, '--task', 'r'))
      .code,
    0,
  );
  assert.equal((await agent(home, 'finish', 'review-src', '--findings', '0')).code, 0);
  const eventsBefore = new AgentRegistry(home).events().length;

  const moved = await backlog(home, 'drop', source, '--into', target);
  assert.equal(moved.code, 0, moved.stderr);
  assert.match(moved.stdout, new RegExp(`${source} dropped`));
  assert.match(moved.stdout, /moved 3 runs/);
  const agents = new AgentRegistry(home).agents();
  const runs = agents.flatMap((one) => [...(one.earlier ?? []), one]);
  assert.equal(runs.length, 3);
  assert.ok(runs.every((one) => one.card === target));
  const events = new AgentRegistry(home).events();
  const cardEvents = events.slice(eventsBefore);
  assert.equal(cardEvents.length, 3);
  assert.ok(cardEvents.every((one) => one.op === 'card' && one.card === target && one.run));
  for (const one of cardEvents) {
    assert.deepEqual(strictAgentEvent({ v: 1, ...one }), []);
  }
  const store = new BacklogStore(home);
  assert.equal(store.items().find((one) => one.id === source)?.state, 'dropped');
  assert.deepEqual(cardRunProblems(store.items(), agents, Date.now()), []);
  // one card with every run on it
  const cards = await cardsOf(home);
  assert.equal(mine(cards, source).length, 0);
  const found = mine(cards, target);
  assert.equal(found.length, 1);
  assert.deepEqual(names(found[0]), ['ou-src', 'review-src']);
  // the move is no run's own doing: the run is not alive for it
  assert.equal(agents.find((one) => one.name === 'ou-src')?.state, 'running');
  // again: nothing left on the dropped card, and a dropped card cannot be dropped into
  assert.notEqual((await backlog(home, 'drop', source, '--into', target)).code, 0);
});

test('backlog drop --into refuses itself, an unknown card, a dropped or landed one and another repo; into an implicit card needs no adopt', async () => {
  const home = tmp('dup-into-refused');
  const source = await add(home, 'Source', 'dup-a');
  assert.equal((await backlog(home, 'claim', source, '--agent', 'ou-src')).code, 0);
  assert.equal(
    (await agent(home, 'start', 'ou-src', '--role', 'author', '--card', source, '--task', 't'))
      .code,
    0,
  );
  const gone = await add(home, 'Gone', 'dup-b');
  assert.equal((await backlog(home, 'drop', gone)).code, 0);
  const landed = await add(home, 'Landed', null);
  assert.equal((await backlog(home, 'start', landed, '--branch', 'dup-c')).code, 0);
  assert.equal((await backlog(home, 'done', landed, '--sha', 'abc1234')).code, 0);
  const elsewhere = await add(home, 'Elsewhere', 'dup-d', 'acme/gadgets');
  for (const [target, why] of [
    [source, /itself|same card/],
    ['bl_nosuchcard12', /no (such )?(card|backlog item)/],
    [gone, /dropped/],
    [landed, /landed|done/],
    [elsewhere, /repo/],
  ] as const) {
    const refused = await backlog(home, 'drop', source, '--into', target);
    assert.notEqual(refused.code, 0, target);
    assert.match(refused.stderr, why, target);
  }
  assert.equal(new BacklogStore(home).items().find((one) => one.id === source)?.state, 'open');
  // an implicit card takes the runs with no adopt
  const helper = await start(home, 'a-scout', '--kind', 'helper', '--repo', REPO, '--task', 'look');
  const into = await backlog(home, 'drop', source, '--into', helper.card);
  assert.equal(into.code, 0, into.stderr);
  assert.equal(
    new AgentRegistry(home).agents().find((one) => one.name === 'ou-src')?.card,
    helper.card,
  );
  assert.equal(
    new BacklogStore(home).listed().some((one) => one.id === helper.card),
    false,
  );
});

test('an implicit card dropped into another moves its runs and is not adopted', async () => {
  const home = tmp('dup-into-implicit');
  const target = await add(home, 'The card', 'dup-other');
  const implicitId = await adhoc(home, 'dup-a');
  const moved = await backlog(home, 'drop', implicitId, '--into', target);
  assert.equal(moved.code, 0, moved.stderr);
  assert.equal(
    new BacklogStore(home).listed().some((one) => one.id === implicitId),
    false,
  );
  const found = mine(await cardsOf(home), target);
  assert.equal(found.length, 1);
  assert.deepEqual(names(found[0]), ['ou-dup', 'review-dup']);
});
