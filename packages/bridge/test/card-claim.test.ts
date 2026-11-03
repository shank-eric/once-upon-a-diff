import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claimAt, runCli, tmp, writeJson } from './helpers.ts';
import { Board, noPrWatcher } from '../src/services/board/board.ts';
import { BacklogStore, backlogCards } from '../src/services/backlog/backlog.ts';
import { CLAIM_GRACE_HOURS, claimedAgents } from '../src/services/backlog/claims.ts';
import { startedLinks } from '../src/services/backlog/backlog-links.ts';
import { builderSlots } from '../src/services/board/stages/agents.ts';
import { parseLedger } from '../src/services/ledger/ledger.ts';
import { registrySource } from '../src/services/sessions/sources.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import type { BoardCard } from '@once-upon-a-diff/shared/types';

const NOW = new Date('2026-10-26T19:00:00Z');
const RUNNING = (name: string, task = 'do a thing', sid = '54736864') =>
  `- [running] sid:${sid} ${name} (sonnet, high) — ${task} — started 2:30 PM ET, 10/26\n`;

function world(ledgerText: string) {
  const home = tmp('claim-home');
  const ledger = path.join(tmp('claim-notes'), 'ledger.md');
  writeFileSync(ledger, ledgerText);
  writeJson(path.join(home, 'config.json'), {
    board_sessions_dir: tmp('claim-sessions'),
    board_ledger_file: ledger,
    board_progress_file: path.join(path.dirname(ledger), 'progress.md'),
    board_ledger_time_zone: 'UTC',
  });
  const cards = async (now = NOW): Promise<BoardCard[]> =>
    (
      await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
        source: registrySource,
        now: () => now,
      }).snapshot()
    ).lanes.flatMap((lane) => lane.cards);
  return { home, ledger, cards, store: new BacklogStore(home) };
}

test('a claim event folds: the latest wins, reopen clears it, a dropped item cannot be claimed', () => {
  const store = new BacklogStore(tmp('claim-fold'));
  const item = store.add({ title: 'A thing', repo: 'acme/widgets' });
  assert.equal(item.claim, null);
  const first = store.claim(item.id, { agent: 'ou-one', sid: '54736864', by: 'main' });
  assert.equal(first.claim?.agent, 'ou-one');
  assert.equal(first.claim?.sid, '54736864');
  assert.equal(first.state, 'open', 'a claim alone does not start it');
  assert.equal(store.claim(item.id, { agent: 'ou-two' }).claim?.agent, 'ou-two');
  // one agent may hold several cards
  const other = store.add({ title: 'Another', repo: 'acme/widgets' });
  assert.equal(store.claim(other.id, { agent: 'ou-two' }).claim?.agent, 'ou-two');
  assert.throws(() => store.claim(item.id, { agent: 'two words' }), /not valid/);
  assert.throws(() => store.claim(item.id, { agent: '' }), /agent/);
  assert.throws(() => store.claim('bl_nothere1', { agent: 'ou-x' }), /no backlog item/);
  store.drop(item.id);
  assert.throws(() => store.claim(item.id, { agent: 'ou-x' }), /dropped/);
  assert.equal(store.reopen(item.id).claim, null);
  // an event line is append-only: the claim is its own op
  const lines = readFileSync(store.file, 'utf8').trim().split('\n');
  assert.ok(lines.some((line) => JSON.parse(line).op === 'claim'));
});

test('an edited card can be claimed, and a claimed card can be edited: both events fold', () => {
  const store = new BacklogStore(tmp('claim-edit'));
  const item = store.add({ title: 'First title', note: 'old note', repo: 'acme/widgets' });
  store.edit(item.id, { title: 'Better title', repo: 'acme/gadgets' });
  const claimed = store.claim(item.id, { agent: 'ou-editor', sid: '54736864' });
  assert.equal(claimed.title, 'Better title');
  assert.equal(claimed.repo, 'acme/gadgets');
  assert.equal(claimed.note, 'old note');
  assert.equal(claimed.claim?.agent, 'ou-editor');
  // edit after the claim keeps the claim
  const again = store.edit(item.id, { note: 'new note' });
  assert.equal(again.note, 'new note');
  assert.equal(again.claim?.agent, 'ou-editor');
  assert.equal(again.title, 'Better title');
  // a drop and a reopen clear the claim and go back to the edited repo
  store.drop(item.id);
  const back = store.reopen(item.id);
  assert.equal(back.claim, null);
  assert.equal(back.repo, 'acme/gadgets');
});

test('claimedAgents: the newest ledger line of the claimed name, pinned by sid when the claim has one', () => {
  const store = new BacklogStore(tmp('claim-resolve'));
  const item = store.add({ title: 'A thing' });
  const agents = parseLedger(
    RUNNING('ou-one', 'x', 'aaaaaaaa') + RUNNING('ou-one', 'y', 'bbbbbbbb'),
    NOW,
    'UTC',
  );
  store.claim(item.id, { agent: 'ou-one', sid: 'aaaaaaaa' });
  assert.equal(claimedAgents(store.items(), agents).get(item.id)?.sid, 'aaaaaaaa');
  store.claim(item.id, { agent: 'ou-missing' });
  assert.equal(claimedAgents(store.items(), agents).has(item.id), false);
  assert.ok(CLAIM_GRACE_HOURS > 0);
});

test('startedLinks finds its agent only through the claim: not by `by`, a folder name or the task text', () => {
  const store = new BacklogStore(tmp('claim-links'));
  const made = store.add({ title: 'T', repo: 'acme/widgets' });
  store.start(made.id, { branch: 'kill-inbox', by: 'ou-kill-inbox' });
  const agents = parseLedger(
    RUNNING('ou-kill-inbox', 'build in widgets-worktrees/kill-inbox') + RUNNING('kill-inbox'),
    NOW,
    'UTC',
  );
  const facts = {
    worktrees: new Map(),
    sessions: [],
    agents,
    beats: new Map(),
    merged: () => null,
  };
  assert.equal(startedLinks(store.items()[0], facts)?.agent, null);
  store.claim(made.id, { agent: 'ou-kill-inbox' });
  assert.equal(startedLinks(store.items()[0], facts)?.agent?.name, 'ou-kill-inbox');
});

test('a claimed card is ONE Working card with its agent, and the agent has no card of its own', async () => {
  const { store, cards, ledger } = world(RUNNING('ou-scout', 'research the thing'));
  writeFileSync(
    path.join(path.dirname(ledger), 'progress.md'),
    '- 2:40 PM ou-scout 2/6 plan: plan written\n',
  );
  const item = store.add({ title: 'Research the thing', repo: 'acme/widgets' });
  store.claim(item.id, { agent: 'ou-scout' });
  const all = await cards();
  assert.equal(all.filter((card) => card.kind === 'agent').length, 0, 'no duplicate agent card');
  const mine = all.filter((card) => card.backlog?.id === item.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].column, 'working');
  assert.deepEqual(
    mine[0].agents.map((agent) => agent.name),
    ['ou-scout'],
  );
  assert.equal(mine[0].backlog?.claim?.agent, 'ou-scout');
  assert.equal(mine[0].backlog?.claim?.pending, false);
  assert.equal(mine[0].backlog?.agent?.links.agent?.beat?.step, 'plan');
  assert.equal(mine[0].backlog?.assign, null, 'a claimed card is not offered to Assign');
});

test('an unclaimed agent with `card bl_x` in its task, its `by` name or its folder name does NOT link', async () => {
  const { store, cards, ledger } = world('');
  const item = store.add({ title: 'Look into it', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'look-into', repo: 'acme/widgets', by: 'ou-look' });
  const open = store.add({ title: 'Open card', repo: 'acme/widgets' });
  writeFileSync(
    ledger,
    RUNNING('ou-text', `card ${open.id} research`) + RUNNING('ou-look') + RUNNING('look-into'),
  );
  const all = await cards();
  const card = all.find((one) => one.backlog?.id === open.id);
  assert.equal(card?.column, 'backlog');
  assert.equal(card?.backlog?.agent, null);
  assert.equal(card?.backlog?.claim, null);
  assert.equal(
    all.filter((one) => one.kind === 'agent').length,
    3,
    'each agent keeps its own card',
  );
  const started = all.find((one) => one.backlog?.id === item.id);
  assert.equal(started?.backlog?.started?.links?.agent, null);
});

test('a claim whose agent is not in the ledger yet is Working, pending, for CLAIM_GRACE_HOURS', async () => {
  const { store, cards } = world('');
  const item = store.add({ title: 'Waiting for its agent', repo: 'acme/widgets' });
  store.claim(item.id, { agent: 'ou-late' });
  const real = new Date();
  const pending = (await cards(real)).find((one) => one.backlog?.id === item.id);
  assert.equal(pending?.column, 'working');
  assert.equal(pending?.backlog?.claim?.pending, true);
  const later = new Date(real.getTime() + (CLAIM_GRACE_HOURS + 1) * 3600 * 1000);
  const back = (await cards(later)).find((one) => one.backlog?.id === item.id);
  assert.equal(back?.column, 'backlog');
  assert.equal(back?.backlog?.claim, null);
});

test('a claimed agent that fails sends its card back to Backlog, tried', async () => {
  const { store, cards, ledger } = world(RUNNING('ou-scout'));
  const item = store.add({ title: 'Try it', repo: 'acme/widgets' });
  claimAt(store, item.id, 'ou-scout', '2026-10-26T18:35:00Z');
  writeFileSync(
    ledger,
    RUNNING('ou-scout') + '- [failed] sid:54736864 ou-scout — 2:45 PM ET, 10/26 — gave up\n',
  );
  const back = (await cards()).find((one) => one.backlog?.id === item.id);
  assert.equal(back?.column, 'backlog');
  assert.equal(back?.backlog?.agent?.tried, true);
  assert.equal((await cards()).filter((one) => one.kind === 'agent').length, 0);
});

test('a claimed agent on a card whose branch has a work card rides on that card, with the agent in it', () => {
  const store = new BacklogStore(tmp('claim-rides'));
  const item = store.add({ title: 'Build it', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'build-it' });
  store.claim(item.id, { agent: 'ou-build' });
  const agent = parseLedger(RUNNING('ou-build'), NOW, 'UTC')[0];
  const view = { name: 'ou-build', state: 'running' } as BoardCard['agents'][number];
  const workCard = {
    id: 'work:1',
    kind: 'work',
    repo: 'acme/widgets',
    branch: 'build-it',
    pr: null,
    story: null,
    agents: [],
    sessions: [],
    title: 'x',
  } as unknown as BoardCard;
  assert.ok(agent);
  const shown = backlogCards(
    store.items(),
    [workCard],
    NOW.getTime(),
    [],
    new Map(),
    new Map([[item.id, view]]),
  );
  assert.deepEqual(shown, []);
  assert.deepEqual(workCard.agents, [view]);
  assert.equal(workCard.from_backlog?.[0].id, item.id);
});

test('builder slots are the running agents that hold a claim, one slot per agent', () => {
  const agents = parseLedger(
    RUNNING('build-a', 'card bl_aaaaaa111 text only') +
      RUNNING('build-b', 'two cards') +
      RUNNING('build-c', 'one card') +
      RUNNING('build-x', 'claims in another session', 'ffffffff') +
      '- [done] sid:54736864 build-d — 2:56 PM ET, 10/26 — ok\n',
    NOW,
    'UTC',
  );
  const pin = { view: { id: '54736864-aaaa' } } as never;
  const held = new Set([
    '54736864:build-b',
    '54736864:build-c',
    'ffffffff:build-x',
    '54736864:build-d',
  ]);
  const slots = builderSlots(agents, pin, 3, NOW.getTime(), held);
  assert.deepEqual(
    slots?.running.map((one) => one.name),
    ['build-b', 'build-c'],
  );
  assert.equal(slots?.free, 1);
  assert.equal(builderSlots(agents, null, 3, NOW.getTime(), held), null);
});

test('`backlog claim` writes the claim, and --branch also starts the card', async () => {
  const home = tmp('claim-cli');
  const store = new BacklogStore(home);
  const item = store.add({ title: 'Claim me', repo: 'acme/widgets' });
  const run = (...args: string[]) => runCli(home, ['backlog', ...args]);
  assert.equal((await run('claim', item.id, '--agent', 'ou-claimer', '--sid', '54736864')).code, 0);
  assert.equal(store.items()[0].claim?.agent, 'ou-claimer');
  assert.equal(store.items()[0].claim?.sid, '54736864');
  assert.equal(store.items()[0].state, 'open');
  assert.equal(
    (await run('claim', item.id, '--agent', 'ou-claimer', '--branch', 'claim-me')).code,
    0,
  );
  assert.equal(store.items()[0].state, 'started');
  assert.equal(store.items()[0].branch, 'claim-me');
  assert.equal(store.items()[0].started_by, 'ou-claimer');
  const missing = await run('claim', item.id);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /agent/);
});
