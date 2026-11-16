import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { CLAUDE_DIR } from '@once-upon-a-diff/test-kit/env';
import { claimAt, registerRuns, type AgentRun } from '@once-upon-a-diff/state/test/helpers';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { Board, noPrWatcher } from '../src/board.ts';
import { columnOf, isBackToYou } from '../src/columns.ts';
import { BacklogStore, backlogCards } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import { gateOf } from '@once-upon-a-diff/state/records/agents/ledger';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { type BoardCard } from '@once-upon-a-diff/contracts/types';
import {
  NOW,
  checkoutOf,
  fullId,
  liveChild,
  localStory,
  prStory,
  registry,
  transcript,
  usedLines,
} from '@once-upon-a-diff/state/test/board-fixtures';
import { etAt, fakeWatcher, parentWithChild, prInfo, sourceSaying } from './board-fixtures.ts';

/** The claim tests' world: PR 7 on acme/widgets feat/x (a story), a card started on that branch, and registered runs. */
function claimWorld(runs: AgentRun[], now: Date = NOW) {
  const home = tmp('claim-board-home');
  registerRuns(home, ...runs);
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('claim-board-sessions') });
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  const store = new BacklogStore(home);
  const cards = async (): Promise<BoardCard[]> =>
    (
      await new Board(
        home,
        new StoryStore({ home }),
        fakeWatcher([prInfo(7, { branch: 'feat/x' })]).watcher,
        new Builds(home),
        { source: sourceSaying({}), now: () => now },
      ).snapshot()
    ).lanes.flatMap((lane) => lane.cards);
  return { home, store, cards };
}

const CLAIM_WHILE_RUNNING = '2026-10-26T18:35:00Z';

const holders = (cards: BoardCard[], name: string) =>
  cards.filter((card) => card.agents.some((agent) => agent.name === name));

test('columns follow the work to merge: waiting and working first, then merged, ready, back to you, PR open', () => {
  const none = { sessions: [], agents: [], pr: null, story: null };
  const open = prInfo(1);
  const unseen = { reviewed: false, manualReviewedAt: null, unread: false };
  assert.equal(columnOf({ ...none, sessions: [{ status: 'waiting' }], pr: open }), 'waiting');
  assert.equal(columnOf({ ...none, agents: [{ status: 'waiting', state: 'waiting' }] }), 'waiting');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'working' }], story: unseen }), 'working');
  assert.equal(columnOf({ ...none, agents: [{ status: 'working', state: 'running' }] }), 'working');
  assert.equal(columnOf({ ...none, pr: prInfo(1, { state: 'merged' }), story: unseen }), 'done');
  assert.equal(columnOf({ ...none, story: unseen }), 'ready');
  // a PR is the GitHub side, whoever wrote it and whatever story it has: never Ready for your review
  assert.equal(columnOf({ ...none, pr: open, story: unseen }), 'pr_open');
  assert.equal(columnOf({ ...none, pr: open, story: { ...unseen, local: true } }), 'pr_open');
  assert.equal(
    columnOf({ ...none, pr: open, story: { ...unseen, local: true, unread: true } }),
    'pr_open',
  );
  // a local story is never in Back to you: unread or not, reviewed or not, it waits in Ready
  const local = { ...unseen, local: true };
  assert.equal(columnOf({ ...none, story: { ...local, unread: true } }), 'ready');
  assert.equal(columnOf({ ...none, story: { ...local, reviewed: true, unread: true } }), 'ready');
  assert.equal(columnOf({ ...none, story: local }), 'ready');
  assert.equal(columnOf({ ...none, story: { ...local, reviewed: true } }), 'idle');
  assert.equal(columnOf({ ...none, pr: open, story: { ...unseen, unread: true } }), 'back');
  // an unread answer to your question: Ready while there is no PR, Back to you once there is one, local story or not
  const answered = { ...unseen, reviewed: true, answered: 1 };
  assert.equal(columnOf({ ...none, story: { ...answered, local: true } }), 'ready');
  assert.equal(columnOf({ ...none, pr: open, story: answered }), 'back');
  assert.equal(columnOf({ ...none, pr: open, story: { ...answered, local: true } }), 'back');
  assert.equal(columnOf({ ...none, pr: open, story: { ...answered, answered: 0 } }), 'pr_open');
  assert.equal(columnOf({ ...none, pr: { ...open, state: 'merged' }, story: answered }), 'done');
  assert.equal(
    columnOf({ ...none, sessions: [{ status: 'working' }], pr: open, story: answered }),
    'working',
  );
  assert.equal(columnOf({ ...none, pr: open }), 'pr_open');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'idle' }], pr: open }), 'pr_open');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'idle' }] }), 'idle');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'error' }] }), 'error');
  assert.equal(columnOf({ ...none, agents: [{ status: 'error', state: 'failed' }] }), 'waiting');
  // back to you: others newer than your last activity (a review or comment of yours, or a story you marked by hand)
  const later = { viewer_at: '2026-10-26T10:00:00Z', others_at: '2026-10-26T11:00:00Z' };
  assert.equal(columnOf({ ...none, pr: prInfo(1, later) }), 'back');
  const caughtUp = prInfo(1, { ...later, viewer_at: '2026-10-26T12:00:00Z' });
  assert.equal(columnOf({ ...none, pr: caughtUp }), 'pr_open');
  const byHand = {
    reviewed: true,
    manualReviewedAt: Date.parse('2026-10-26T10:30:00Z'),
    unread: false,
  };
  assert.equal(
    columnOf({ ...none, pr: prInfo(1, { others_at: later.others_at }), story: byHand }),
    'back',
  );
  const older = prInfo(1, { others_at: '2026-10-26T09:00:00Z' });
  assert.equal(columnOf({ ...none, pr: older, story: byHand }), 'pr_open');
  // no sign of your activity: nothing to compare with, so not back to you
  assert.equal(columnOf({ ...none, pr: prInfo(1, { others_at: later.others_at }) }), 'pr_open');
  assert.equal(isBackToYou({ pr: null, story: null }), false);
  // a story built after you last opened it is back to you; one you never opened is ready for review
  assert.equal(columnOf({ ...none, pr: open, story: { ...unseen, unread: true } }), 'back');
  assert.equal(columnOf({ ...none, pr: open, story: { ...byHand, unread: true } }), 'back');
  assert.equal(columnOf({ ...none, pr: open, story: { ...unseen, reviewed: true } }), 'pr_open');
  // GitHub waiting on your review is back to you; a session building for the PR is working
  assert.equal(columnOf({ ...none, pr: prInfo(1, { review_requested: true }) }), 'back');
  assert.equal(columnOf({ ...none, pr: open, story: unseen, building: true }), 'working');
  assert.equal(columnOf({ ...none, sessions: [{ status: 'waiting' }], building: true }), 'waiting');
});

test('an agent whose run names a card sets that card’s column whatever it is doing (running, at its plan, asking)', async () => {
  const running: AgentRun = {
    sid: '54736864',
    name: 'builder',
    kind: 'author',
    task: 'build',
    started: etAt(14, 30),
  };
  const cases: [string, AgentRun, string][] = [
    ['running', running, 'working'],
    [
      'at its plan',
      { ...running, now: { state: 'plan', at: etAt(14, 40), outcome: 'plan ready' } },
      'checks',
    ],
    [
      'asking',
      { ...running, now: { state: 'waiting', at: etAt(14, 40), outcome: 'needs you: which one' } },
      'waiting',
    ],
  ];
  for (const [what, run, column] of cases) {
    const { home, store, cards } = claimWorld([]);
    const item = store.add({ title: 'Build x', repo: 'acme/widgets' });
    store.start(item.id, { branch: 'feat/x', repo: 'acme/widgets' });
    claimAt(store, item.id, 'builder', CLAIM_WHILE_RUNNING);
    registerRuns(home, { ...run, card: item.id });
    const all = await cards();
    const pr = all.find((card) => card.id === 'pr:acme/widgets#7') as BoardCard;
    assert.equal(pr.column, column, `${what}: the PR card is in ${column}`);
    assert.deepEqual(
      holders(all, 'builder'),
      [pr],
      `${what}: the agent is on the PR card and nowhere else`,
    );
    assert.equal(pr.from_backlog?.[0].id, item.id);
    assert.equal(all.filter((card) => card.kind === 'agent').length, 0, `${what}: no agent card`);
  }
});

test('after the card is marked done an agent whose run names it shows once, on the landed card', async () => {
  const { home, store, cards } = claimWorld([]);
  const item = store.add({ title: 'Build x', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'feat/x', repo: 'acme/widgets' });
  claimAt(store, item.id, 'builder', CLAIM_WHILE_RUNNING);
  registerRuns(home, {
    sid: '54736864',
    name: 'builder',
    kind: 'author',
    task: 'build',
    started: etAt(14, 30),
    now: { state: 'done', at: etAt(14, 50), outcome: 'committed on feat/x, tests green' },
    card: item.id,
  });
  // before it lands: on the PR card
  assert.equal(holders(await cards(), 'builder').length, 1);
  store.done(item.id, { sha: 'abc1234', by: 'deploy-local' });
  const all = await cards();
  assert.equal(holders(all, 'builder').length, 1, 'once, in Done');
  assert.equal(
    holders(all, 'builder')[0].id,
    'pr:acme/widgets#7',
    'on the card its run names, which is the landed card',
  );
  assert.equal(all.filter((card) => card.kind === 'agent').length, 0, 'no card of its own');
});

test('a claim finds no run: a finished card stays Done beside a cardless run, and a claimed card is Working through a run naming it', async () => {
  const build: AgentRun = {
    sid: '54736864',
    name: 'ou-build',
    kind: 'author',
    started: etAt(14, 30),
  };
  const { home, store, cards } = claimWorld([], new Date('2026-10-26T20:15:00Z'));
  const item = store.add({ title: 'The first job', repo: 'acme/gadgets' });
  claimAt(store, item.id, 'ou-build', '2026-10-26T17:00:00Z');
  registerRuns(
    home,
    {
      ...build,
      task: 'build',
      card: item.id,
      now: { state: 'done', at: etAt(15, 50), outcome: 'committed abc1234' },
    },
    {
      ...build,
      name: 'ou-other',
      task: 'fix other things',
      started: etAt(16, 0),
      branch: 'fix/other',
    },
  );
  const all = await cards();
  const card = all.find((one) => one.backlog?.id === item.id) as BoardCard;
  assert.equal(card.column, 'done', 'the first run finished: the card does not go back to Working');
  assert.equal(card.agents[0].state, 'done');
  const own = all.filter((one) => one.kind === 'agent');
  assert.equal(own.length, 1, 'the other run names no card: a card of its own');
  assert.equal(own[0].column, 'working');
  // a second card claimed by the same name is Working only through a run that names it
  const second = store.add({ title: 'The second job', repo: 'acme/gadgets' });
  claimAt(store, second.id, 'ou-build', '2026-10-26T20:05:00Z');
  const pending = await cards();
  assert.equal(pending.find((one) => one.backlog?.id === second.id)?.column, 'working', 'pending');
  registerRuns(home, { ...build, task: 'second', card: second.id, started: etAt(16, 10) });
  const both = await cards();
  assert.equal(both.find((one) => one.backlog?.id === second.id)?.column, 'working');
  assert.equal(both.find((one) => one.backlog?.id === item.id)?.column, 'done');
});

test('claiming before the agent’s run starts, with an older finished run of that name, leaves the card Working and pending', async () => {
  const now = new Date();
  const { store, cards } = claimWorld(
    [
      {
        sid: '54736864',
        name: 'ou-late',
        kind: 'author',
        task: 'old job',
        started: '2026-10-20T18:30:00Z',
        now: { state: 'done', at: '2026-10-20T19:00:00Z', outcome: 'committed abc1234' },
      },
    ],
    now,
  );
  const item = store.add({ title: 'A new job', repo: 'acme/gadgets' });
  store.claim(item.id, { agent: 'ou-late' });
  const card = (await cards()).find((one) => one.backlog?.id === item.id) as BoardCard;
  assert.ok(card, 'the card is on the board');
  assert.equal(card.column, 'working');
  assert.equal(card.backlog?.claim?.pending, true);
});

test('plan and fixing are gates until the run goes on, and a running critic is one too', () => {
  const tenAm = (minute: number) => new Date(Date.UTC(2026, 9, 26, 14, minute));
  const registry = registerRuns(
    tmp('board-gates'),
    { sid: 'aaaaaaaa', name: 'builder', kind: 'author', started: tenAm(18) },
    { sid: 'aaaaaaaa', name: 'review-x', kind: 'critic', started: tenAm(40) },
    { sid: 'aaaaaaaa', name: 'planner', kind: 'author', started: tenAm(50) },
    { sid: 'aaaaaaaa', name: 'review-name', kind: 'helper', started: tenAm(50) },
  );
  registry.state('builder', { state: 'plan', outcome: 'plan ready: three steps', at: tenAm(30) });
  registry.state('review-x', { state: 'fixing', findings: 5, at: tenAm(55) });
  registry.state('planner', { state: 'plan', outcome: 'plan ready', at: tenAm(56) });
  registry.state('planner', { state: 'running', at: tenAm(57) });
  const byName = Object.fromEntries(registry.agents().map((agent) => [agent.name, agent]));
  assert.deepEqual(gateOf(byName['builder']), { kind: 'plan', findings: null });
  assert.deepEqual(gateOf(byName['review-x']), { kind: 'fixing', findings: 5 });
  assert.equal(gateOf(byName['planner']), null, 'running again: past its plan');
  assert.equal(gateOf(byName['review-name']), null, 'a name is not a kind');
  registry.state('review-x', { state: 'running', at: tenAm(58) });
  assert.deepEqual(gateOf(registry.agents().find((one) => one.name === 'review-x')!), {
    kind: 'review',
    findings: null,
  });
  registry.finish('review-x', { findings: 2, at: tenAm(59) });
  assert.equal(
    gateOf(registry.agents().find((one) => one.name === 'review-x')!),
    null,
    'a finished critic is not at a gate',
  );
});

test('an agent that says [review] puts a card with no PR in Ready, never Waiting; a real question still wins', () => {
  const none = { sessions: [], agents: [], pr: null, story: null };
  const review = { status: 'waiting' as const, state: 'waiting' as const, review: true };
  assert.equal(columnOf({ ...none, agents: [review] }), 'ready');
  assert.equal(
    columnOf({ ...none, agents: [review, { status: 'waiting', state: 'waiting' }] }),
    'waiting',
  );
  assert.equal(
    columnOf({ ...none, agents: [review], sessions: [{ status: 'waiting' }] }),
    'waiting',
  );
  assert.equal(
    columnOf({ ...none, agents: [review, { status: 'working', state: 'running' }] }),
    'working',
  );
  assert.equal(columnOf({ ...none, agents: [{ status: 'waiting', state: 'waiting' }] }), 'waiting');
});

test('a story marked reviewed takes a card out of Ready even while an agent says [review]; an unreviewed one stays; a PR ignores it', () => {
  const review = { status: 'waiting' as const, state: 'waiting' as const, review: true };
  const none = { sessions: [], agents: [review], pr: null };
  const story = { reviewed: false, manualReviewedAt: null, unread: false, local: true };
  assert.equal(columnOf({ ...none, story }), 'ready');
  assert.equal(columnOf({ ...none, story: { ...story, reviewed: true } }), 'idle');
  assert.equal(columnOf({ ...none, story: { ...story, reviewed: true, approved: true } }), 'ship');
  assert.equal(
    columnOf({
      ...none,
      story: { ...story, unread: true },
      pr: prInfo(7, { review_requested: false }),
    }),
    'pr_open',
  );
});

test('Agent checks sits under Waiting and above Working in the first-match order', () => {
  const none = { sessions: [], agents: [], pr: null, story: null };
  const gate = (kind: 'plan' | 'review' | 'fixing') => ({
    status: 'working' as const,
    state: kind === 'review' ? ('running' as const) : kind,
    gate: { kind, findings: null },
  });
  for (const kind of ['plan', 'review', 'fixing'] as const) {
    assert.equal(columnOf({ ...none, agents: [gate(kind)] }), 'checks', kind);
    // the session is busy while it checks the plan or fixes the findings, and the card is still at the gate
    assert.equal(
      columnOf({ ...none, agents: [gate(kind)], sessions: [{ status: 'working' }] }),
      'checks',
    );
    assert.equal(
      columnOf({ ...none, agents: [gate(kind), { status: 'working', state: 'running' }] }),
      'checks',
    );
    // the user being needed still wins
    assert.equal(
      columnOf({ ...none, agents: [gate(kind)], sessions: [{ status: 'waiting' }] }),
      'waiting',
    );
    assert.equal(
      columnOf({ ...none, agents: [gate(kind), { status: 'waiting', state: 'waiting' }] }),
      'waiting',
    );
  }
  // an agent that is just running, or a finished reviewer, is not a gate
  assert.equal(
    columnOf({ ...none, agents: [{ status: 'working', state: 'running', gate: null }] }),
    'working',
  );
  assert.equal(
    columnOf({ ...none, agents: [{ status: 'done', state: 'done', gate: null }] }),
    'idle',
  );
});

test('the board: Agent checks holds a PR card with a gated agent in it, an agent card for one with no card, and Waiting still wins', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const ledger = path.join(tmp('board-notes'), 'ledger.md');
  const children = [liveChild(), liveChild(), liveChild()];
  after(() => children.forEach((child) => child.stop()));
  const [launcher, onStory, onY] = children;
  const sid = (child: { pid: number }) => String(child.pid).padStart(8, '0');
  const gadgets = checkoutOf('gadgets', 'main');
  const widgetsX = checkoutOf('widgets', 'feat/x');
  const widgetsY = checkoutOf('widgets', 'feat/y');
  // the launching session is in another repo, on its default branch; the work is on feat/x (a story) and feat/y (a PR)
  registry(
    sessions,
    launcher.pid,
    { cwd: gadgets, name: 'launcher', status: 'busy' },
    launcher.procStart,
  );
  registry(
    sessions,
    onStory.pid,
    { cwd: widgetsX, name: 'story-one', status: 'busy' },
    onStory.procStart,
  );
  registry(sessions, onY.pid, { cwd: widgetsY, name: 'branch-y' }, onY.procStart);
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  // registered agents on implicit cards: a plan and a running reviewer for PR 7, launched by a session that is not on its branch
  const registered = new AgentRegistry(home);
  const launched = { sid: sid(launcher), repo: 'acme/widgets' };
  registered.start({
    ...launched,
    name: 'builder',
    kind: 'author',
    task: 'build on feat/x → notes/p.md',
    card: 'ic_featxwork1',
    branch: 'feat/x',
    at: etAt(14, 0),
  });
  registered.state('builder', {
    state: 'plan',
    outcome: 'plan ready: three steps',
    notes: 'notes/p.md',
    at: etAt(14, 10),
  });
  registered.start({
    ...launched,
    name: 'review-seven',
    kind: 'critic',
    task: 'review of PR #7 diff',
    card: 'ic_featxwork1',
    branch: 'feat/x',
    at: etAt(14, 20),
  });
  // findings being fixed on feat/y, and a reviewer for a branch that has no card
  registered.start({
    ...launched,
    name: 'review-why',
    kind: 'critic',
    task: 'review of feat/y diff',
    card: 'ic_featywork1',
    branch: 'feat/y',
    at: etAt(14, 0),
  });
  registered.state('review-why', {
    state: 'fixing',
    findings: 3,
    outcome: '3 findings',
    notes: 'notes/r.md',
    at: etAt(14, 30),
  });
  registered.start({
    ...launched,
    name: 'review-lost',
    kind: 'critic',
    task: 'review of feat/none',
    card: 'ic_featnone01',
    branch: 'feat/none',
    at: etAt(14, 40),
  });
  // a finished reviewer is not at a gate
  registered.start({
    ...launched,
    name: 'review-old',
    kind: 'critic',
    task: 'review',
    at: etAt(13, 0),
  });
  registered.finish('review-old', { outcome: '4 findings', findings: 4, at: etAt(13, 5) });
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_sessions_dir: sessions,
  });
  const { watcher } = fakeWatcher(
    [prInfo(7, { branch: 'feat/x' }), prInfo(9, { branch: 'feat/y' })],
    { 'acme/widgets@feat/y': { number: 9, state: 'open', merged_at: null } },
  );
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  const data = await board.snapshot();
  const cards = data.lanes.flatMap((lane) => lane.cards);
  const card = (id: string) => cards.find((found) => found.id === id) as BoardCard;

  const seven = card('pr:acme/widgets#7');
  assert.equal(
    seven.column,
    'checks',
    'its session is busy, but a plan and a reviewer are at their gates',
  );
  assert.deepEqual(
    seven.agents.map((agent) => [agent.name, agent.state, agent.gate?.kind]),
    [
      ['builder', 'plan', 'plan'],
      ['review-seven', 'running', 'review'],
    ],
  );
  assert.equal(seven.detail, 'plan check, agent review · review-seven');
  assert.equal(
    seven.since,
    '2026-10-26T18:10:00.000Z',
    'the earliest of the plan time and the review start',
  );
  assert.equal(card(`agent:${sid(launcher)}:builder`), undefined, 'nested, not a card of its own');

  // the findings are being fixed on feat/y, whose session is idle
  const why = card('pr:acme/widgets#9');
  assert.equal(why.column, 'checks');
  assert.deepEqual(
    why.agents.map((agent) => agent.gate),
    [{ kind: 'fixing', findings: 3 }],
  );

  // a gated agent whose registered branch has no card has a card of its own, in the column, on its parent's lane
  const lost = card(`agent:${sid(launcher)}:review-lost`);
  assert.equal(lost.column, 'checks');
  assert.equal(lost.lane, 'acme/widgets');
  assert.equal(lost.parent, 'launcher');
  assert.equal(card(`agent:${sid(launcher)}:review-old`), undefined);
  // the launching session's own card is its own business
  assert.equal(card(fullId(launcher.pid)).column, 'working');

  // the user being needed still wins: a card whose session, or agent, is waiting on you is in Waiting whatever gate is on it
  registered.state('builder', {
    state: 'waiting',
    outcome: 'needs Eric: pick A or B',
    notes: 'notes/p.md',
    at: etAt(14, 50),
  });
  const later = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({ [sid(onStory)]: { status: 'waiting', detail: 'asked you something' } }),
    now: () => new Date(NOW.getTime() + 5000),
  });
  const afterwards = (await later.snapshot()).lanes.flatMap((lane) => lane.cards);
  const found = (id: string) => afterwards.find((one) => one.id === id);
  assert.equal(
    found(`agent:${sid(launcher)}:builder`),
    undefined,
    'a registered agent stays in its card',
  );
  assert.equal(found('pr:acme/widgets#7')?.column, 'waiting');
  assert.equal(
    found('pr:acme/widgets#7')?.agents.find((one) => one.name === 'builder')?.state,
    'waiting',
  );
  assert.equal(found('pr:acme/widgets#9')?.column, 'checks');
});

test('an agent parked on your story review is ready for review, not waiting; a question still waits', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const launcher = liveChild();
  after(() => launcher.stop());
  const sid = String(launcher.pid).padStart(8, '0');
  registry(
    sessions,
    launcher.pid,
    { cwd: checkoutOf('gadgets', 'main'), name: 'launcher' },
    launcher.procStart,
  );
  prStory(home, 'acme-widgets-7', 'acme/widgets', 7, 'feat/x');
  const registered = new AgentRegistry(home);
  registered.start({
    sid,
    lane: 'widgets',
    repo: 'acme/widgets',
    name: 'on-pr',
    kind: 'author',
    task: 'build on PR #7',
    card: 'ic_onprwork01',
    branch: 'feat/x',
    at: etAt(13, 0),
  });
  registered.state('on-pr', {
    state: 'review',
    outcome: 'story up on PR #7',
    notes: 'notes/a.md',
    at: etAt(14, 0),
  });
  registerRuns(
    home,
    {
      sid,
      name: 'on-nothing',
      lane: 'elsewhere',
      started: etAt(14, 0),
      now: { state: 'review', at: etAt(14, 10), outcome: 'story up', notes: 'notes/b.md' },
    },
    {
      sid,
      name: 'asker',
      lane: 'elsewhere',
      started: etAt(14, 0),
      now: { state: 'waiting', at: etAt(14, 20), outcome: 'needs Eric: pick A or B' },
    },
  );
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const { watcher } = fakeWatcher([prInfo(7, { branch: 'feat/x' })], {});
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  const card = (id: string) => cards.find((found) => found.id === id) as BoardCard;
  const seven = card('pr:acme/widgets#7');
  assert.notEqual(seven.column, 'waiting', 'a story to review is not a question');
  assert.deepEqual(
    seven.agents.map((agent) => [agent.name, agent.review]),
    [['on-pr', true]],
    'nested in the PR card its implicit card’s branch names',
  );
  assert.equal(card(`agent:${sid}:on-pr`), undefined);
  const lone = card(`agent:${sid}:on-nothing`);
  assert.equal(lone.column, 'ready');
  assert.equal(lone.detail, 'story up');
  assert.equal(card(`agent:${sid}:asker`).column, 'waiting');
});

test('a [review] agent naming a no-PR branch sits in its Ready card; one left a day behind is gone', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const launcher = liveChild();
  after(() => launcher.stop());
  const sid = String(launcher.pid).padStart(8, '0');
  registry(
    sessions,
    launcher.pid,
    { cwd: checkoutOf('gadgets', 'main'), name: 'launcher' },
    launcher.procStart,
  );
  localStory(home, 'local-feat-x', checkoutOf('widgets', 'feat/x'), 'feat/x');
  const registered = new AgentRegistry(home);
  registered.start({
    sid,
    lane: 'widgets',
    repo: 'acme/widgets',
    name: 'on-x',
    kind: 'author',
    task: 'build on feat/x',
    card: 'ic_onxwork0001',
    branch: 'feat/x',
    at: etAt(13, 0),
  });
  registered.state('on-x', {
    state: 'review',
    outcome: 'story up on feat/x, two chapters',
    at: etAt(14, 30),
  });
  const twoDaysBack = new Date(Date.UTC(2026, 9, 24, 18, 30)); // 2:30 PM ET, 10/24
  registerRuns(
    home,
    {
      sid,
      name: 'lost-review',
      lane: 'widgets',
      started: twoDaysBack,
      now: { state: 'review', at: twoDaysBack, outcome: 'story up' },
    },
    {
      sid,
      name: 'lost-question',
      lane: 'widgets',
      started: twoDaysBack,
      now: { state: 'waiting', at: twoDaysBack, outcome: 'needs Eric: long ago' },
    },
  );
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  const work = cards.find((card) => card.id === 'branch:acme/widgets@feat/x') as BoardCard;
  assert.equal(work.column, 'ready');
  assert.deepEqual(
    work.agents.map((agent) => [agent.name, agent.review]),
    [['on-x', true]],
  );
  assert.equal(
    cards.some((card) => card.agents.some((agent) => agent.name.startsWith('lost-'))),
    false,
  );
});

test('a plan or fixing gate that has sat a day is marked stale', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const child = liveChild();
  after(() => child.stop());
  const sid = String(child.pid).padStart(8, '0');
  registry(
    sessions,
    child.pid,
    { cwd: checkoutOf('widgets', 'main'), name: 'launcher' },
    child.procStart,
  );
  const twoDaysBack = new Date(Date.UTC(2026, 9, 24, 13, 0)); // 9:00 AM ET, 10/24
  registerRuns(
    home,
    {
      sid,
      name: 'old-plan',
      kind: 'author',
      lane: 'widgets',
      started: twoDaysBack,
      now: { state: 'plan', at: twoDaysBack, outcome: 'plan ready' },
    },
    {
      sid,
      name: 'review-fresh',
      kind: 'critic',
      lane: 'widgets',
      started: etAt(14, 0),
      now: { state: 'fixing', at: etAt(14, 30), findings: 2 },
    },
  );
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const board = new Board(home, new StoryStore({ home }), fakeWatcher().watcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => NOW,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  const stale = cards.find((found) => found.title === 'old-plan');
  assert.equal(stale?.column, 'checks');
  assert.equal(stale?.agents[0].stale, true);
  assert.equal(cards.find((found) => found.title === 'review-fresh')?.agents[0].stale, false);
});

test('the Blank strip: sessions with no prompt yet are chips by place, not cards; a prompt, or a busy or waiting tab, makes a card', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const children = Array.from({ length: 7 }, () => liveChild());
  after(() => children.forEach((child) => child.stop()));
  const [blankA, blankB, blankC, used, busyBlank, waitingBlank, onPr] = children;
  const sid = (child: { pid: number }) => String(child.pid).padStart(8, '0');
  const widgets = checkoutOf('widgets', 'main');
  const gadgets = checkoutOf('gadgets', 'main');
  const folder = tmp('board-plain-folder');
  const widgetsY = checkoutOf('widgets', 'feat/y');
  const blank = { blank: true };
  // two blank sessions in one checkout, one in another repo, one in a folder that is no repo, and one on a branch with a PR
  registry(sessions, blankA.pid, { cwd: widgets, name: 'b-one' }, blankA.procStart, blank);
  registry(sessions, blankB.pid, { cwd: widgets, name: 'a-two' }, blankB.procStart, blank);
  registry(sessions, blankC.pid, { cwd: gadgets, name: 'g-one' }, blankC.procStart, blank);
  registry(sessions, used.pid, { cwd: folder, name: 'has-prompt' }, used.procStart);
  registry(
    sessions,
    busyBlank.pid,
    { cwd: gadgets, name: 'busy-blank', status: 'busy' },
    busyBlank.procStart,
    blank,
  );
  registry(
    sessions,
    waitingBlank.pid,
    { cwd: gadgets, name: 'waiting-blank' },
    waitingBlank.procStart,
    blank,
  );
  registry(sessions, onPr.pid, { cwd: widgetsY, name: 'on-pr' }, onPr.procStart, blank);
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  writeJson(path.join(home, 'listener-history.json'), {
    'acme/gadgets': {
      repo: 'acme/gadgets',
      consumer: 'repo-acme-gadgets',
      started_at: new Date(NOW.getTime() - 3600000).toISOString(),
      last_seen: new Date(NOW.getTime() - 3600000).toISOString(),
    },
  });
  const { watcher } = fakeWatcher([prInfo(9, { branch: 'feat/y' })], {
    'acme/widgets@feat/y': { number: 9, state: 'open', merged_at: null },
  });
  let now = NOW;
  const board = new Board(home, new StoryStore({ home }), watcher, new Builds(home), {
    source: sourceSaying({
      [sid(blankA)]: { status: 'done', detail: null },
      [sid(blankC)]: { status: 'done', detail: null },
      [sid(waitingBlank)]: { status: 'waiting', detail: 'asked you something' },
    }),
    now: () => now,
  });
  const data = await board.snapshot();
  const cards = data.lanes.flatMap((lane) => lane.cards);
  const ids = cards.map((found) => found.id);
  for (const gone of [blankA, blankB, blankC]) {
    assert.ok(!ids.includes(fullId(gone.pid)), `${sid(gone)} is a chip, not a card`);
  }
  assert.deepEqual(
    data.blank.map((group) => [
      group.name,
      group.sessions.map((one) => [one.title, one.can_focus]),
    ]),
    [
      // a tab known for b-one and g-one only; a-two comes first by title
      ['gadgets', [['Tab title', true]]],
      [
        'widgets',
        [
          ['a-two', false],
          ['Tab title', true],
        ],
      ],
    ],
  );
  assert.equal(data.blank[1].sessions[1].id, fullId(blankA.pid));
  // a prompt, a busy tab, a waiting tab: cards as always
  assert.equal(cards.find((found) => found.id === fullId(used.pid))?.column, 'idle');
  assert.equal(cards.find((found) => found.id === fullId(busyBlank.pid))?.column, 'thinking');
  assert.equal(cards.find((found) => found.id === fullId(waitingBlank.pid))?.column, 'waiting');
  // on a branch with a PR it stays in that PR's card
  const work = cards.find((found) => found.id === 'pr:acme/widgets#9');
  assert.deepEqual(
    work?.sessions.map((one) => one.id),
    [fullId(onPr.pid)],
  );
  assert.ok(
    !data.blank.flatMap((group) => group.sessions).some((one) => one.id === fullId(onPr.pid)),
  );
  // a blank session that can be typed into is still a candidate for Start listening
  assert.deepEqual(
    data.listeners.find((entry) => entry.repo === 'acme/gadgets')?.candidates.map((one) => one.id),
    [fullId(blankC.pid)],
  );

  // as soon as it has a prompt it is a card (the file grew, so it is read again)
  const file = path.join(
    CLAUDE_DIR,
    'projects',
    widgets.replace(/[^A-Za-z0-9]/g, '-'),
    `${fullId(blankB.pid)}.jsonl`,
  );
  appendFileSync(
    file,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'start on the fix' } }) + '\n',
  );
  now = new Date(NOW.getTime() + 5000);
  const next = await board.snapshot();
  assert.equal(
    next.lanes.flatMap((lane) => lane.cards).find((found) => found.id === fullId(blankB.pid))?.kind,
    'session',
  );
  assert.deepEqual(
    next.blank.find((group) => group.name === 'widgets')?.sessions.map((one) => one.id),
    [fullId(blankA.pid)],
  );
});

test('the Blank check reads transcripts from board_projects_dir', () => {
  const home = tmp('board-settings');
  assert.equal(readSettings(home).board.projectsDir, path.join(CLAUDE_DIR, 'projects'));
  writeJson(path.join(home, 'config.json'), { board_projects_dir: '/x/projects' });
  assert.equal(readSettings(home).board.projectsDir, '/x/projects');
});

test('a session card is titled by its tab, else the title in its transcript, else the registry’s name', async () => {
  const home = tmp('board-home');
  const sessions = tmp('board-sessions');
  const [tabbed, untabbed, untitled] = [liveChild(), liveChild(), liveChild()];
  after(() => [tabbed, untabbed, untitled].forEach((child) => child.stop()));
  const cwd = tmp('board-titles');
  for (const [child, name] of [
    [tabbed, 'tabbed'],
    [untabbed, 'untabbed'],
    [untitled, 'untitled'],
  ] as const) {
    registry(sessions, child.pid, { cwd, name }, child.procStart);
  }
  for (const child of [tabbed, untabbed]) {
    transcript(cwd, fullId(child.pid), [
      ...usedLines(fullId(child.pid)),
      { type: 'ai-title', aiTitle: 'Transcript title', sessionId: fullId(child.pid) },
    ]);
  }
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({
      [String(tabbed.pid).padStart(8, '0')]: { status: 'done', detail: null },
    }),
    now: () => NOW,
  });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  const title = (pid: number) => cards.find((found) => found.id === fullId(pid))?.title;
  assert.equal(title(tabbed.pid), 'Tab title');
  assert.equal(title(untabbed.pid), 'Transcript title');
  assert.equal(title(untitled.pid), 'untitled');
  // when it went quiet comes from the registry, which the tab's status can't move: Done or Idle on the page
  const resting = cards.find((found) => found.id === fullId(untitled.pid))?.sessions[0];
  assert.equal(resting?.rested_at, new Date(NOW.getTime() - 600000).toISOString());
});

test('a started item on the voice session’s or a listening session’s branch says so, and stays past the day', () => {
  const store = new BacklogStore(tmp('board-backlog-cardless'));
  const onVoice = store.add({ title: 'Voice idea', repo: 'acme/widgets' });
  store.start(onVoice.id, { branch: 'feat/voice' });
  const alone = store.add({ title: 'Nobody on it', repo: 'acme/widgets' });
  store.start(alone.id, { branch: 'feat/alone' });
  const later = Date.now() + 2 * 24 * 3600 * 1000;
  const cardless = [{ repo: 'acme/widgets', branch: 'feat/voice', label: 'Voice session' }];
  const started = (now: number) =>
    backlogCards(store.items(), [], now, cardless).map((card) => [
      card.title,
      card.backlog?.started?.on,
    ]);
  assert.deepEqual(started(Date.now()), [
    ['Voice idea', 'Voice session'],
    ['Nobody on it', null],
  ]);
  assert.deepEqual(
    started(later),
    [['Voice idea', 'Voice session']],
    'only the one with no session drops after a day',
  );
});

test('a started backlog item rides on a live session’s card on its new branch, before any PR or story', async () => {
  const home = tmp('board-backlog-session');
  const sessions = tmp('board-backlog-sessions');
  const child = liveChild();
  after(() => child.stop());
  const checkout = checkoutOf('widgets', 'feat/new-idea');
  registry(
    sessions,
    child.pid,
    { cwd: checkout, name: 'idea-one', status: 'busy' },
    child.procStart,
  );
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const store = new BacklogStore(home);
  const item = store.add({ title: 'The new idea', repo: 'acme/widgets' });
  const board = () =>
    new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: registrySource,
      now: () => NOW,
    });
  const find = async () => {
    const cards = (await board().snapshot()).lanes.flatMap((lane) => lane.cards);
    return { cards, session: cards.find((found) => found.kind === 'session') as BoardCard };
  };
  // not started: a card in Backlog, and the session's card is its own
  let seen = await find();
  assert.equal(seen.session.branch, 'feat/new-idea', 'a session card, not a work card');
  assert.equal(seen.session.from_backlog, undefined);
  assert.ok(seen.cards.some((found) => found.column === 'backlog'));
  // started on that branch: no backlog card (not even "no session yet"), and the session's card says where it came from
  store.start(item.id, { branch: 'feat/new-idea', repo: 'acme/widgets' });
  seen = await find();
  assert.deepEqual(seen.session.from_backlog, [{ id: item.id, title: 'The new idea' }]);
  assert.ok(!seen.cards.some((found) => found.column === 'backlog'));
  assert.equal(seen.session.column, 'working', 'its column is the session’s own');
});

test('a standing helper is a row at the bottom, never a card: gone with its session, when finished, or after 8 hours idle', async () => {
  const tree = await parentWithChild();
  after(() => tree.stop());
  const sid = String(tree.parent).padStart(8, '0');
  const ago = (hours: number, minutes = 0) =>
    new Date(NOW.getTime() - (hours * 60 + minutes) * 60000);
  type Setup = (registered: AgentRegistry) => void;
  const world = async (setup: Setup, live = true) => {
    const home = tmp('board-helpers');
    const sessions = tmp('board-sessions');
    if (live) {
      registry(sessions, tree.parent, { cwd: checkoutOf('widgets', 'main') }, tree.procStart);
    }
    setup(new AgentRegistry(home));
    writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
    const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
      source: sourceSaying({ [sid]: { status: 'done', detail: null } }),
      now: () => NOW,
    });
    const data = await board.snapshot();
    return { data, cards: data.lanes.flatMap((lane) => lane.cards) };
  };
  const agentCards = (cards: BoardCard[], name = 'backlog-clerk') =>
    cards.filter((card) => card.agents.some((agent) => agent.name === name));
  // the registered field is all that says so: a task and a name that mean nothing
  const clerk = (registered: AgentRegistry, task = 'card ops') =>
    registered.start({
      name: 'backlog-clerk',
      sid,
      kind: 'helper',
      standing: true,
      task,
      at: ago(6),
    });

  const shown = await world((registered) => {
    clerk(registered);
    registered.state('backlog-clerk', { state: 'waiting', outcome: 'ready', at: ago(0, 30) });
  });
  assert.equal(shown.data.helpers.length, 1);
  const [helper] = shown.data.helpers;
  assert.equal(helper.name, 'backlog-clerk');
  assert.equal(helper.state, 'waiting');
  assert.equal(helper.session, fullId(tree.parent));
  assert.equal(helper.last_request_at, ago(0, 30).toISOString());
  assert.equal(agentCards(shown.cards).length, 0, 'no card, so not in Waiting or Done');

  assert.equal((await world(clerk)).data.helpers[0].state, 'handling', 'running: handling one');
  // a finish ends it (and it does not turn into a Done card either)
  const done = await world((registered) => {
    clerk(registered);
    registered.finish('backlog-clerk', { state: 'done', outcome: 'shut down', at: ago(0, 20) });
  });
  assert.equal(done.data.helpers.length, 0);
  assert.equal(agentCards(done.cards).length, 0);
  // restarted without --standing, it is in the row again
  const resumed = await world((registered) => {
    clerk(registered);
    registered.finish('backlog-clerk', { state: 'done', at: ago(0, 20) });
    registered.start({ name: 'backlog-clerk', sid, task: 'card ops again', at: ago(0, 10) });
  });
  assert.equal(resumed.data.helpers[0]?.name, 'backlog-clerk', 'standing carries over a restart');
  // its session is gone
  const gone = await world(clerk, false);
  assert.equal(gone.data.helpers.length, 0, 'session ended');
  assert.equal(agentCards(gone.cards).length, 0);
  // nobody has asked it anything for more than 8 hours
  const idle = await world((registered) => {
    registered.start({
      name: 'backlog-clerk',
      sid,
      kind: 'helper',
      standing: true,
      task: 'x',
      at: ago(9),
    });
  });
  assert.equal(idle.data.helpers.length, 0, 'idle 8h');
  // a helper by kind alone, and one whose task says "standing helper", are ordinary agents: a card, no row
  const plain = await world((registered) => {
    registered.start({ name: 'deploy-x', sid, kind: 'helper', task: 'ff deploy x', at: ago(1) });
    registered.start({
      name: 'backlog-clerk',
      sid,
      kind: 'helper',
      task: 'standing helper for backlog card ops',
      at: ago(2),
    });
    registered.start({
      name: 'tagged-one',
      sid,
      kind: 'helper',
      task: '[helper] card ops',
      at: ago(2),
    });
  });
  assert.equal(
    plain.data.helpers.length,
    0,
    'neither the kind nor the task text puts it in the row',
  );
  assert.equal(agentCards(plain.cards, 'deploy-x').length, 1, 'a one-shot helper is a card');
  assert.equal(
    agentCards(plain.cards, 'backlog-clerk').length,
    1,
    'prose does not make it standing',
  );
  assert.equal(agentCards(plain.cards, 'tagged-one').length, 1);
});

test('an agent is on its parent’s folder lane: a lane tag is not read, so it is never resolved to an owner/name', async () => {
  const home = tmp('board-folder-lane');
  const sessions = tmp('board-folder-lane-sessions');
  const parent = liveChild();
  after(() => parent.stop());
  registry(sessions, parent.pid, { cwd: '/tmp/somewhere/foo' }, parent.procStart);
  const sid = String(parent.pid).padStart(8, '0');
  registerRuns(
    home,
    { sid, name: 'folder-agent', task: 'a one-off task', started: etAt(13, 0) },
    { sid, name: 'tagged-agent', lane: 'foo', task: 'a one-off task', started: etAt(13, 0) },
  );
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: sessions });
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({ [sid]: { status: 'done', detail: null } }),
    now: () => NOW,
    repoOf: async () => null,
  });
  board.addBacklog({ title: 'In eric/foo', repo: 'eric/foo', by: 'board' });
  const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
  const lane = (title: string) => cards.find((card) => card.title === title)?.lane;
  assert.equal(lane('tagged-agent'), 'foo', 'a tag is not read: the parent’s lane');
  assert.equal(lane('folder-agent'), 'foo', 'a folder lane is already a key');
});
