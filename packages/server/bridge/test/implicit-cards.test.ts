/**
 * Implicit cards (ADR-27): work that did not start in the backlog is its own card, and the card lives in agents.jsonl only. A start
 * with no `--card` mints an `ic_` id on its start row (one row, one file: backlog.jsonl is not written), a restart of the same name
 * goes on it, a critic of that work names it, and `backlog adopt` makes it a real card with the same id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { runCli, tmp, writeJson } from './helpers.ts';
import { Board, noPrWatcher } from '@once-upon-a-diff/board/board';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import type { BoardCard } from '@once-upon-a-diff/contracts/types';

const SID = 'abcdef01';
const env = { CLAUDE_CODE_SESSION_ID: `${SID}-1111-4222-8333-444444444444` };
const IMPLICIT = /^ic_[a-z0-9]{6,24}$/;

const agent = (home: string, ...args: string[]) => runCli(home, ['agent', ...args], env);
const backlog = (home: string, ...args: string[]) => runCli(home, ['backlog', ...args], env);
/** `agent start` as the CLI answers it: id, run and, for an implicit card, its id. */
const start = async (home: string, ...args: string[]) => {
  const done = await agent(home, 'start', ...args);
  assert.equal(done.code, 0, done.stderr);
  const [id, run, card] = done.stdout.trim().split(' ');
  return { id, run, card };
};
const cardOf = (home: string, name: string) =>
  new AgentRegistry(home)
    .events()
    .filter((one) => one.op === 'start' && one.name === name)
    .map((one) => one.card);

test('a start with no card mints an ic_ card on its one start row and writes nothing to backlog.jsonl', async () => {
  const home = tmp('implicit-mint');
  const first = await start(home, 'look-it-up', '--kind', 'research', '--task', 'look it up');
  assert.match(first.card, IMPLICIT);
  assert.deepEqual(cardOf(home, 'look-it-up'), [first.card]);
  assert.equal(
    existsSync(path.join(home, 'backlog.jsonl')),
    false,
    'the card has no row of its own',
  );
  // the same for a helper and an author, each its own card
  const helper = await start(home, 'a-helper', '--kind', 'helper', '--task', 'help');
  const author = await start(
    home,
    'ou-adhoc',
    '--role',
    'author',
    '--branch',
    'adhoc',
    '--task',
    'build',
  );
  assert.notEqual(helper.card, first.card);
  assert.notEqual(author.card, helper.card);
  assert.equal(existsSync(path.join(home, 'backlog.jsonl')), false);
});

test('a restart of the same name goes on its implicit card, and --new-card mints another', async () => {
  const home = tmp('implicit-reuse');
  const first = await start(home, 'a-helper', '--kind', 'helper', '--task', 'one');
  assert.equal((await agent(home, 'finish', 'a-helper')).code, 0);
  const again = await start(home, 'a-helper', '--task', 'two');
  assert.equal(again.card, first.card, 'a follow-up is the same piece of work');
  assert.equal((await agent(home, 'finish', 'a-helper')).code, 0);
  const fresh = await start(home, 'a-helper', '--new-card', '--task', 'three');
  assert.notEqual(fresh.card, first.card);
  assert.match(fresh.card, IMPLICIT);
});

test('a critic of ad-hoc work names its card, which needs a branch; a critic with no card is still refused', async () => {
  const home = tmp('implicit-critic');
  const author = await start(
    home,
    'ou-adhoc',
    '--role',
    'author',
    '--branch',
    'adhoc-x',
    '--task',
    'build it',
  );
  assert.equal((await agent(home, 'finish', 'ou-adhoc')).code, 0);
  // thirty minutes or a day later, the card still takes its critic
  const critic = await agent(
    home,
    'start',
    'review-adhoc',
    '--role',
    'critic',
    '--card',
    author.card,
    '--task',
    'review',
  );
  assert.equal(critic.code, 0, critic.stderr);
  const [row] = new AgentRegistry(home).events().filter((one) => one.name === 'review-adhoc');
  assert.equal(row.card, author.card);
  assert.equal(row.branch, 'adhoc-x', 'the card’s branch is the critic’s');
  const none = await agent(home, 'start', 'review-none', '--kind', 'critic', '--task', 'review');
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /--card/);
});

test('a critic or storyteller on a card with no branch is refused, whether the card is implicit or in the backlog', async () => {
  const home = tmp('implicit-nobranch');
  const helper = await start(home, 'a-scout', '--kind', 'helper', '--task', 'look');
  const noBranch = await agent(
    home,
    'start',
    'review-x',
    '--role',
    'critic',
    '--card',
    helper.card,
    '--task',
    'review',
  );
  assert.notEqual(noBranch.code, 0);
  assert.match(noBranch.stderr, /no branch/);
  const story = await agent(
    home,
    'start',
    'tell-x',
    '--role',
    'storyteller',
    '--card',
    helper.card,
    '--task',
    'story',
  );
  assert.notEqual(story.code, 0);
  assert.match(story.stderr, /no branch/);
  // the kind alone (no --role) is checked the same way: no card is refused, and a card with no branch has nothing to tell
  const bareKind = await agent(home, 'start', 'tell-y', '--kind', 'storyteller', '--task', 'story');
  assert.notEqual(bareKind.code, 0);
  assert.match(bareKind.stderr, /--card/);
  const kindNoBranch = await agent(
    home,
    'start',
    'tell-z',
    '--kind',
    'storyteller',
    '--card',
    helper.card,
    '--task',
    'story',
  );
  assert.notEqual(kindNoBranch.code, 0);
  assert.match(kindNoBranch.stderr, /no branch/);
  const card = new BacklogStore(home).add({ title: 'Open card', repo: 'acme/widgets' });
  const open = await agent(
    home,
    'start',
    'review-y',
    '--role',
    'critic',
    '--card',
    card.id,
    '--task',
    'review',
  );
  assert.notEqual(open.code, 0);
  assert.match(open.stderr, /no branch/);
});

test('a typed --card ic_ id that no run minted is refused, and an author with a role needs a card or a branch', async () => {
  const home = tmp('implicit-typo');
  const typo = await agent(
    home,
    'start',
    'x',
    '--kind',
    'helper',
    '--card',
    'ic_abcdef123456',
    '--task',
    'x',
  );
  assert.notEqual(typo.code, 0);
  assert.match(typo.stderr, /no backlog card/);
  const bare = await agent(home, 'start', 'ou-bare', '--role', 'author', '--task', 'build');
  assert.notEqual(bare.code, 0);
  assert.match(bare.stderr, /--branch/);
  // an author with the old --kind and no branch still registers (old briefs)
  assert.equal(
    (await agent(home, 'start', 'ou-old', '--kind', 'author', '--task', 'build')).code,
    0,
  );
});

test('backlog list hides implicit cards; --implicit lists the live ones and --all marks every one', async () => {
  const home = tmp('implicit-list');
  new BacklogStore(home).add({ title: 'A real card', repo: 'acme/widgets' });
  const live = await start(home, 'a-live', '--kind', 'helper', '--task', 'working on a thing');
  const over = await start(home, 'a-over', '--kind', 'helper', '--task', 'all done');
  assert.equal((await agent(home, 'finish', 'a-over')).code, 0);
  const plain = (await backlog(home, 'list')).stdout;
  assert.match(plain, /A real card/);
  assert.doesNotMatch(plain, /ic_/);
  const only = (await backlog(home, 'list', '--implicit')).stdout;
  assert.match(only, new RegExp(live.card));
  assert.doesNotMatch(only, new RegExp(over.card));
  assert.doesNotMatch(only, /A real card/);
  const all = (await backlog(home, 'list', '--implicit', '--all')).stdout;
  assert.match(all, new RegExp(over.card));
  const everything = (await backlog(home, 'list', '--all')).stdout;
  assert.match(everything, /A real card/);
  assert.match(everything, new RegExp(live.card));
  assert.match(everything, /implicit/);
  const shown = JSON.parse((await backlog(home, 'show', live.card)).stdout);
  assert.equal(shown.id, live.card);
  assert.equal(shown.implicit, true);
  assert.equal(shown.title, 'working on a thing');
  const edit = await backlog(home, 'claim', live.card, '--agent', 'x');
  assert.notEqual(edit.code, 0);
  assert.match(edit.stderr, /adopt/);
});

test('backlog adopt writes one add with the same id and the runs now name a real card', async () => {
  const home = tmp('implicit-adopt');
  const author = await start(
    home,
    'ou-adhoc',
    '--role',
    'author',
    '--repo',
    'acme/widgets',
    '--branch',
    'adhoc-x',
    '--task',
    'build the thing with more detail',
  );
  const before = existsSync(path.join(home, 'backlog.jsonl'));
  assert.equal(before, false);
  const adopted = await backlog(home, 'adopt', author.card);
  assert.equal(adopted.code, 0, adopted.stderr);
  const events = readFileSync(path.join(home, 'backlog.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.op),
    ['add', 'start'],
    'the add, and the start a card with a branch gets',
  );
  assert.equal(events[0].id, author.card);
  assert.equal(events[0].title, 'build the thing with more detail');
  assert.equal(events[0].repo, 'acme/widgets');
  assert.equal(events[0].branch, 'adhoc-x');
  assert.equal(events[1].branch, 'adhoc-x');
  const [item] = new BacklogStore(home).items();
  assert.equal(item.id, author.card);
  assert.equal(item.state, 'started', 'work under way: no Assign');
  // it is a card now: listed, no longer implicit, and the run is still its run
  assert.match((await backlog(home, 'list', '--all')).stdout, new RegExp(author.card));
  assert.equal((await backlog(home, 'list', '--implicit')).stdout.includes(author.card), false);
  assert.equal(new AgentRegistry(home).agents()[0].card, author.card);
  // adopting again, a real card or an unknown id is refused
  assert.match((await backlog(home, 'adopt', author.card)).stderr, /already a card/);
  assert.match((await backlog(home, 'adopt', 'ic_nosuchcard12')).stderr, /no (such )?card/);
  // a card that was adopted and then dropped takes no more runs (the backlog is asked first)
  await backlog(home, 'drop', author.card);
  const late = await agent(
    home,
    'start',
    'review-late',
    '--role',
    'critic',
    '--card',
    author.card,
    '--task',
    'review',
  );
  assert.notEqual(late.code, 0);
  assert.match(late.stderr, /dropped/);
});

test('an implicit card with no branch is adopted as one open card: one write, no start', async () => {
  const home = tmp('implicit-adopt-nobranch');
  const helper = await start(home, 'a-scout', '--kind', 'helper', '--task', 'look at the thing');
  assert.equal((await backlog(home, 'adopt', helper.card, '--title', 'Look at the thing')).code, 0);
  const events = readFileSync(path.join(home, 'backlog.jsonl'), 'utf8').trim().split('\n');
  assert.equal(events.length, 1);
  const [item] = new BacklogStore(home).items();
  assert.equal(item.title, 'Look at the thing');
  assert.equal(item.state, 'open');
});

const cardsOf = async (home: string): Promise<BoardCard[]> => {
  const sessions = tmp('implicit-live');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const data = await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => new Date(),
  }).snapshot();
  return data.lanes.flatMap((lane) => lane.cards);
};

test('the board shows an ad-hoc author and its critic as one agent card', async () => {
  const home = tmp('implicit-board');
  const author = await start(
    home,
    'ou-adhoc',
    '--role',
    'author',
    '--repo',
    'acme/widgets',
    '--branch',
    'adhoc-x',
    '--task',
    'build it',
  );
  assert.equal((await agent(home, 'finish', 'ou-adhoc', '--commit', 'abc1234')).code, 0);
  assert.equal(
    (
      await agent(
        home,
        'start',
        'review-adhoc',
        '--role',
        'critic',
        '--card',
        author.card,
        '--task',
        'review',
      )
    ).code,
    0,
  );
  const cards = (await cardsOf(home)).filter((card) => card.kind !== 'session');
  const agentCards = cards.filter((card) => card.kind === 'agent');
  assert.equal(agentCards.length, 1, 'one card for the one piece of work');
  assert.deepEqual(agentCards[0].agents.map((one) => one.name).sort(), [
    'ou-adhoc',
    'review-adhoc',
  ]);
  assert.equal(agentCards[0].id, `agent:${SID}:ou-adhoc`);
  assert.equal(
    cards.some((card) => card.kind === 'backlog'),
    false,
  );
  assert.equal(statSync(home).isDirectory(), true);
});

test('Finish on the combined card clears the card’s other finished runs, so the critic does not come back as a card of its own', async () => {
  const home = tmp('implicit-finish');
  const author = await start(
    home,
    'ou-adhoc',
    '--role',
    'author',
    '--repo',
    'acme/widgets',
    '--branch',
    'adhoc-x',
    '--task',
    'build it',
  );
  assert.equal((await agent(home, 'finish', 'ou-adhoc', '--commit', 'abc1234')).code, 0);
  assert.equal(
    (
      await agent(
        home,
        'start',
        'review-adhoc',
        '--role',
        'critic',
        '--card',
        author.card,
        '--task',
        'review',
      )
    ).code,
    0,
  );
  assert.equal((await agent(home, 'finish', 'review-adhoc', '--findings', '0')).code, 0);
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('implicit-finish-live') });
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => new Date(),
  });
  const agentCards = async () =>
    (await board.snapshot()).lanes
      .flatMap((lane) => lane.cards)
      .filter((card) => card.kind === 'agent')
      .map((card) => [card.id, card.agents.map((one) => one.name).sort()]);
  assert.deepEqual(await agentCards(), [[`agent:${SID}:ou-adhoc`, ['ou-adhoc', 'review-adhoc']]]);
  board.finishAgent(SID, 'ou-adhoc');
  assert.deepEqual(await agentCards(), [], 'one Finish clears the piece of work');
});
