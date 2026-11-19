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
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { BacklogItem } from '@once-upon-a-diff/state/queues/backlog/types';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { Board, noPrWatcher } from '../src/board.ts';
import { sourceSaying } from './board-fixtures.ts';
import { sessionHomes } from '../src/stages/self-runs.ts';

const CUTOFF = 30 * 60000;
const NOW_MS = NOW.getTime();
const ago = (minutes: number) => new Date(NOW_MS - minutes * 60000);

const run = (
  sid: string,
  name: string,
  state: LedgerAgent['state'],
  over: Partial<LedgerAgent> = {},
): LedgerAgent => ({
  sid,
  name,
  state,
  model: null,
  modelName: null,
  task: 't',
  started: ago(120),
  ended: state === 'done' ? ago(10) : null,
  outcome: null,
  kind: 'author',
  repo: 'acme/widgets',
  branch: 'feat/k12',
  card: 'ic_card00000001',
  lastEvent: ago(10),
  ...over,
});

const item = (over: Partial<BacklogItem>): BacklogItem =>
  ({
    id: 'bl_item0000001',
    repo: 'acme/widgets',
    branch: 'feat/item',
    state: 'started',
    landed_at: null,
    ...over,
  }) as BacklogItem;

const homes = (agents: LedgerAgent[], items: BacklogItem[] = []) =>
  sessionHomes(agents, items, NOW_MS, CUTOFF);

test('a session’s open runs on one card place it there, a parked one included', () => {
  for (const state of ['running', 'plan', 'fixing', 'waiting'] as const) {
    const found = homes([run('aaaaaaa1', 'ou-one', state, { ended: null })]).get('aaaaaaa1');
    assert.deepEqual(found, { card: 'ic_card00000001', repo: 'acme/widgets', branch: 'feat/k12' });
  }
});

test('a session whose open runs name two cards, or whose only run names none, has no home', () => {
  const two = [
    run('aaaaaaa1', 'ou-one', 'running', { ended: null }),
    run('aaaaaaa1', 'ou-two', 'running', { ended: null, card: 'ic_card00000002' }),
  ];
  assert.equal(homes(two).size, 0);
  assert.equal(homes([run('aaaaaaa1', 'ou-one', 'running', { card: null })]).size, 0);
});

test('with no run open, the latest carded run counts while it is inside the wait and not after', () => {
  const finished = (minutes: number) =>
    run('aaaaaaa1', 'ou-one', 'done', { ended: ago(minutes), lastEvent: ago(minutes) });
  assert.ok(homes([finished(29)]).has('aaaaaaa1'), 'just inside');
  assert.ok(!homes([finished(30)]).has('aaaaaaa1'), 'at the cutoff it is over');
  assert.ok(!homes([finished(31)]).has('aaaaaaa1'), 'just outside');
});

test('open runs win over a newer finished run on another card, and only the latest card counts when none is open', () => {
  const agents = [
    run('aaaaaaa1', 'ou-open', 'running', {
      ended: null,
      card: 'ic_card00000002',
      branch: 'feat/b',
      lastEvent: ago(20),
    }),
    run('aaaaaaa1', 'ou-newer', 'done', { lastEvent: ago(1), ended: ago(1) }),
  ];
  assert.equal(homes(agents).get('aaaaaaa1')?.branch, 'feat/b');
  const none = [
    run('bbbbbbb2', 'ou-old', 'done', {
      card: 'ic_card00000002',
      branch: 'feat/b',
      ended: ago(20),
      lastEvent: ago(20),
    }),
    run('bbbbbbb2', 'ou-new', 'done', { ended: ago(5), lastEvent: ago(5) }),
  ];
  assert.equal(homes(none).get('bbbbbbb2')?.branch, 'feat/k12');
});

test('a dropped or landed item, and a card with no branch, give no home; a stored item answers with its own repo and branch', () => {
  const agents = [run('aaaaaaa1', 'ou-one', 'running', { ended: null, card: 'bl_item0000001' })];
  assert.deepEqual(homes(agents, [item({})]).get('aaaaaaa1'), {
    card: 'bl_item0000001',
    repo: 'acme/widgets',
    branch: 'feat/item',
  });
  assert.equal(homes(agents, [item({ state: 'dropped' })]).size, 0);
  assert.equal(homes(agents, [item({ landed_at: '2026-10-26T18:00:00Z' })]).size, 0);
  assert.equal(homes(agents, [item({ branch: null })]).size, 0);
  const branchless = [run('aaaaaaa1', 'ou-one', 'running', { ended: null, branch: null })];
  assert.equal(homes(branchless).size, 0);
});

/** One busy session in `cwd` (a checkout on `develop`) and what `prep` registers or stores for it. */
async function world(opts: {
  prep: (home: string, sid: string, sessions: string) => void;
  cwd?: string;
  /** a second busy session, in this checkout */
  also?: string;
}) {
  const home = tmp('homes-home');
  const sessions = tmp('homes-sessions');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const child = liveChild();
  const sid = String(child.pid).padStart(8, '0');
  registry(
    sessions,
    child.pid,
    { cwd: opts.cwd ?? checkoutOf('widgets', 'develop'), name: 'main-checkout', status: 'busy' },
    child.procStart,
  );
  const second = opts.also ? liveChild() : null;
  if (second) {
    registry(
      sessions,
      second.pid,
      { cwd: opts.also, name: 'item-checkout', status: 'busy' },
      second.procStart,
    );
  }
  opts.prep(home, sid, sessions);
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({ [sid]: { status: 'working', detail: null } }),
    now: () => NOW,
  });
  const data = await board.snapshot();
  child.stop();
  second?.stop();
  const cards = data.lanes.flatMap((lane) => lane.cards);
  return {
    cards,
    card: cards.find((card) => card.sessions.some((one) => one.id === fullId(child.pid))),
    id: fullId(child.pid),
    alsoId: second ? fullId(second.pid) : null,
    sid,
  };
}

const startedAgo = (minutes: number) => new Date(NOW_MS - minutes * 60000);

test('a session on develop with a fixer and a critic open on a card whose branch has a story joins that work card', async () => {
  const { card, cards, id } = await world({
    prep: (home, sid) => {
      prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/k12');
      registerRuns(
        home,
        {
          sid,
          name: 'fix-k12',
          kind: 'author',
          card: 'ic_k12card000001',
          repo: 'acme/widgets',
          branch: 'feat/k12',
          started: startedAgo(5),
        },
        {
          sid,
          name: 'review-k12',
          kind: 'critic',
          card: 'ic_k12card000001',
          repo: 'acme/widgets',
          branch: 'feat/k12',
          started: startedAgo(4),
        },
      );
    },
  });
  assert.equal(card?.kind, 'work');
  assert.equal(card?.story?.id, 'acme-widgets-7');
  assert.ok(card?.sessions.some((one) => one.id === id));
  assert.equal(cards.filter((one) => one.kind === 'session').length, 0, 'no card of its own');
});

test('all its runs finished a few minutes ago (the 11/19 shape) still joins; past the wait it is a card of its own', async () => {
  const finished = (minutes: number) => (home: string, sid: string) => {
    prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/k12');
    registerRuns(home, {
      sid,
      name: 'story-k12',
      kind: 'storyteller',
      card: 'ic_k12card000001',
      repo: 'acme/widgets',
      branch: 'feat/k12',
      started: startedAgo(minutes + 2),
      now: { state: 'done', at: startedAgo(minutes), outcome: 'ok' },
    });
  };
  const soon = await world({ prep: finished(5) });
  assert.equal(soon.card?.kind, 'work');
  const late = await world({ prep: finished(45) });
  assert.equal(late.card?.kind, 'session');
  assert.equal(late.card?.branch, 'develop');
});

test('a started backlog item with no story: the session card sits on the item’s branch and carries it and its runs', async () => {
  const { card, id } = await world({
    prep: (home, sid) => {
      const store = new BacklogStore(home);
      const made = store.add({ title: 'The item', repo: 'acme/widgets' });
      store.start(made.id, { branch: 'feat/item', repo: 'acme/widgets' });
      registerRuns(home, {
        sid,
        name: 'ou-item',
        kind: 'author',
        card: made.id,
        repo: 'acme/widgets',
        branch: 'feat/item',
        started: startedAgo(3),
      });
    },
  });
  assert.equal(card?.kind, 'session');
  assert.equal(card?.branch, 'feat/item');
  assert.equal(card?.from_backlog?.[0]?.title, 'The item');
  assert.equal(card?.agents.length, 1, 'the run rides on it');
  assert.equal(card?.column, 'working');
  assert.equal(card?.sessions[0].id, id);
  assert.equal(card?.sessions[0].branch, 'develop', 'the session view keeps its own checkout');
});

test('an open self run on a card (agent start --self --card) places the session there', async () => {
  const { card } = await world({
    prep: (home, sid) => {
      prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/k12');
      registerRuns(home, {
        sid,
        name: `self-${sid.slice(0, 6)}`,
        kind: 'author',
        card: 'ic_k12card000001',
        repo: 'acme/widgets',
        branch: 'feat/k12',
        started: startedAgo(5),
      });
    },
  });
  assert.equal(card?.kind, 'work');
  assert.equal(card?.story?.id, 'acme-widgets-7');
});

test('a card in another repo is joined too, in that repo’s lane', async () => {
  const { card } = await world({
    prep: (home, sid) => {
      prStory(home, 'acme-gadgets-9', 'acme/gadgets', 9, 'feat/g');
      registerRuns(home, {
        sid,
        name: 'ou-gadget',
        kind: 'author',
        card: 'ic_gadgetcard001',
        repo: 'acme/gadgets',
        branch: 'feat/g',
        started: startedAgo(5),
      });
    },
  });
  assert.equal(card?.kind, 'work');
  assert.equal(card?.lane, 'acme/gadgets');
});

test('open runs on two cards leave the session on a card of its own', async () => {
  const { card } = await world({
    prep: (home, sid) => {
      prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/k12');
      registerRuns(
        home,
        {
          sid,
          name: 'ou-a',
          kind: 'author',
          card: 'ic_k12card000001',
          repo: 'acme/widgets',
          branch: 'feat/k12',
          started: startedAgo(5),
        },
        {
          sid,
          name: 'ou-b',
          kind: 'author',
          card: 'ic_other0000001',
          repo: 'acme/widgets',
          branch: 'feat/other',
          started: startedAgo(5),
        },
      );
    },
  });
  assert.equal(card?.kind, 'session');
  assert.equal(card?.branch, 'develop');
});

test('a session with no run naming a card is unchanged', async () => {
  const { card } = await world({
    prep: (home, sid) => {
      prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/k12');
      registerRuns(home, { sid, name: 'ou-plain', kind: 'author', started: startedAgo(5) });
    },
  });
  assert.equal(card?.kind, 'session');
});

test('an unusable registry file beside the session changes nothing: it keeps its own card', async () => {
  const { card } = await world({
    prep: (home, sid, sessions) => {
      prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/k12');
      registerRuns(home, {
        sid,
        name: 'ou-open',
        kind: 'author',
        card: 'ic_k12card000001',
        repo: 'acme/widgets',
        branch: 'feat/k12',
        started: startedAgo(5),
      });
      const other = liveChild();
      after(other.stop);
      writeFileSync(
        path.join(sessions, `${other.pid}.json`),
        '{"pid": 1, "sessionId": "eeeeeeee-aa',
      );
    },
  });
  assert.equal(card?.kind, 'session');
});

test('a branchless helper run on its own card is no second card: the session keeps its home', () => {
  const agents = [
    run('aaaaaaa1', 'ou-crit', 'running', { ended: null, kind: 'critic' }),
    run('aaaaaaa1', 'ou-help', 'running', {
      ended: null,
      kind: 'helper',
      card: 'ic_helper000001',
      branch: null,
    }),
  ];
  assert.equal(homes(agents).get('aaaaaaa1')?.card, 'ic_card00000001');
  // a newer branchless run does not take the latest-card place from an earlier run on a card that has a branch
  const finished = [
    run('aaaaaaa1', 'ou-crit', 'done', { ended: ago(10), lastEvent: ago(10) }),
    run('aaaaaaa1', 'ou-help', 'done', {
      ended: ago(2),
      lastEvent: ago(2),
      kind: 'helper',
      card: 'ic_helper000001',
      branch: null,
    }),
  ];
  assert.equal(homes(finished).get('aaaaaaa1')?.card, 'ic_card00000001');
  // two cards that both give a place are still ambiguous
  const two = [
    run('aaaaaaa1', 'ou-one', 'running', { ended: null }),
    run('aaaaaaa1', 'ou-two', 'running', { ended: null, card: 'ic_card00000002' }),
    run('aaaaaaa1', 'ou-help', 'running', { ended: null, card: 'ic_helper000001', branch: null }),
  ];
  assert.equal(homes(two).size, 0);
});

test('a joined session and the session checked out on the card’s branch are one session card', async () => {
  const { cards, card, id, alsoId } = await world({
    also: checkoutOf('widgets', 'feat/item'),
    prep: (home, sid) => {
      const store = new BacklogStore(home);
      const made = store.add({ title: 'The item', repo: 'acme/widgets' });
      store.start(made.id, { branch: 'feat/item', repo: 'acme/widgets' });
      registerRuns(home, {
        sid,
        name: 'review-item',
        kind: 'critic',
        card: made.id,
        repo: 'acme/widgets',
        branch: 'feat/item',
        started: startedAgo(3),
      });
    },
  });
  const sessionCards = cards.filter((one) => one.kind === 'session');
  assert.equal(sessionCards.length, 1, 'one card for the branch');
  assert.equal(card, sessionCards[0]);
  assert.deepEqual(card?.sessions.map((one) => one.id).sort(), [id, alsoId].sort());
  assert.equal(card?.from_backlog?.[0]?.title, 'The item');
  assert.equal(card?.agents.length, 1);
  assert.notEqual(card?.column, 'thinking');
});

test('a joined session whose self run just finished keeps its work card Working, not Thinking', async () => {
  const { card, id } = await world({
    prep: (home, sid) => {
      prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/k12');
      registerRuns(home, {
        sid,
        name: `self-${sid.slice(0, 6)}`,
        kind: 'author',
        card: 'ic_k12card000001',
        repo: 'acme/widgets',
        branch: 'feat/k12',
        started: startedAgo(10),
        now: { state: 'done', at: startedAgo(5), outcome: 'ok' },
      });
    },
  });
  assert.equal(card?.kind, 'work');
  assert.notEqual(card?.column, 'thinking');
  assert.equal(card?.sessions.find((one) => one.id === id)?.thinking, undefined);
});

test('an open branchless helper on its own card does not stop the join', async () => {
  const { card } = await world({
    prep: (home, sid) => {
      prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/k12');
      registerRuns(
        home,
        {
          sid,
          name: 'review-k12',
          kind: 'critic',
          card: 'ic_k12card000001',
          repo: 'acme/widgets',
          branch: 'feat/k12',
          started: startedAgo(4),
        },
        {
          sid,
          name: 'look-up',
          kind: 'helper',
          card: 'ic_helper000001',
          started: startedAgo(2),
        },
      );
    },
  });
  assert.equal(card?.kind, 'work');
  assert.equal(card?.story?.id, 'acme-widgets-7');
});
