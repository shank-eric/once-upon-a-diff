import '@once-upon-a-diff/test-kit/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson } from '@once-upon-a-diff/test-kit/files';
import { registerRuns } from '@once-upon-a-diff/state/test/helpers';
import { NOW } from '@once-upon-a-diff/state/test/board-fixtures';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { QUIET_MS } from '@once-upon-a-diff/state/records/agents/events';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { livenessKey } from '@once-upon-a-diff/adapters/claude-sessions/subagent-liveness';
import { Board, noPrWatcher } from '../src/board.ts';
import { sourceSaying } from './board-fixtures.ts';
import { endDeadRuns, runsToJudge } from '../src/stages/dead-runs.ts';

const NOW_MS = NOW.getTime();
const MIN = 60000;
const STARTED = new Date(NOW_MS - 3 * 3600000);

const run = (name: string, extra: Partial<LedgerAgent> = {}): LedgerAgent => ({
  sid: 'aaaaaaa1',
  name,
  state: 'running',
  model: null,
  modelName: null,
  task: 't',
  started: STARTED,
  ended: null,
  outcome: null,
  kind: 'author',
  lastEvent: new Date(NOW_MS - 2 * 3600000),
  ...extra,
});
const wrote = (name: string, agoMs: number, sid = 'aaaaaaa1') =>
  new Map([[livenessKey({ sid, name }), NOW_MS - agoMs]]);

test('the silence limit is 30 minutes', () => {
  assert.equal(QUIET_MS, 30 * MIN);
});

test('an author, critic, helper, research or storyteller run whose transcript is quiet is shown ended at its last sign of life', () => {
  const kinds = ['author', 'critic', 'helper', 'research', 'storyteller'] as const;
  const agents = kinds.map((kind) => run(`r-${kind}`, { kind }));
  const quiet = new Map(agents.flatMap((agent) => [...wrote(agent.name, 45 * MIN)]));
  const seen = endDeadRuns(agents, quiet, NOW_MS);
  assert.deepEqual(
    seen.map((one) => [one.state, one.outcome]),
    [
      ['failed', 'stopped without agent finish'],
      ['failed', 'stopped without agent finish'],
      ['done', 'auto-finished'],
      ['done', 'auto-finished'],
      ['done', 'auto-finished'],
    ],
  );
  assert.equal(
    seen[0].ended?.getTime(),
    NOW_MS - 15 * MIN,
    'ended QUIET_MS after the later of the two signs of life',
  );
  assert.equal(seen[0].lastEvent?.getTime(), NOW_MS - 15 * MIN, 'its stay counts from there');
  assert.equal(agents[0].state, 'running', 'the board never rewrites what it was given');
});

test('a live transcript keeps a run alive and counts as its last event, however quiet its ledger', () => {
  const kinds = ['author', 'critic', 'helper', 'research', 'storyteller'] as const;
  for (const kind of kinds) {
    const [seen] = endDeadRuns([run('r', { kind })], wrote('r', 5 * MIN), NOW_MS);
    assert.equal(seen.state, 'running', kind);
    assert.equal(seen.lastEvent?.getTime(), NOW_MS - 5 * MIN, kind);
  }
});

test('a run that beat recently stays alive though its transcript is old, and the beat is kept', () => {
  const agent = run('r', { lastEvent: new Date(NOW_MS - 5 * MIN) });
  const [seen] = endDeadRuns([agent], wrote('r', 2 * 3600000), NOW_MS);
  assert.equal(seen, agent);
});

test('a fixing run is judged; plan, waiting, review and ended runs are not', () => {
  const agents = [
    run('fixing', { state: 'fixing' }),
    run('plan', { state: 'plan' }),
    run('waiting', { state: 'waiting' }),
    run('review', { state: 'waiting', review: true }),
    run('done', { state: 'done', ended: new Date(NOW_MS - 3600000) }),
  ];
  const quiet = new Map(agents.flatMap((agent) => [...wrote(agent.name, 2 * 3600000)]));
  assert.deepEqual(
    endDeadRuns(agents, quiet, NOW_MS).map((one) => one.state),
    ['failed', 'plan', 'waiting', 'waiting', 'done'],
  );
  assert.deepEqual(
    runsToJudge(agents).map((one) => one.name),
    ['fixing'],
  );
});

test('a standing helper, an editor and a parent session`s own run are never judged', () => {
  const agents = [
    run('standing', { kind: 'helper', standing: true }),
    run('editor', { kind: 'editor' }),
    run('self-abc123'),
  ];
  const quiet = new Map(agents.flatMap((agent) => [...wrote(agent.name, 2 * 3600000)]));
  assert.deepEqual(endDeadRuns(agents, quiet, NOW_MS), agents);
  assert.deepEqual(runsToJudge(agents), []);
});

test('no entry, an empty answer, or an entry that is 0 or NaN leaves the run to the 24 hour rule', () => {
  const agent = run('r');
  assert.equal(endDeadRuns([agent], new Map(), NOW_MS)[0], agent);
  assert.equal(endDeadRuns([agent], wrote('other', 3600000), NOW_MS)[0], agent);
  for (const bad of [0, NaN, -5]) {
    const map = new Map([[livenessKey(agent), bad]]);
    assert.equal(endDeadRuns([agent], map, NOW_MS)[0], agent);
  }
});

/** A board whose one backlog card has an author run open since `STARTED`, its subagent transcript last written `transcriptAgo` ago. */
async function boardWith(opts: {
  transcriptAgo: number | null;
  beatAgo?: number;
  /** a run of this kind and no card (an agent card of its own) instead of the author on the backlog card */
  adhoc?: 'author' | 'critic' | 'helper';
  /** the board's clock, as minutes after `NOW` */
  later?: number;
}) {
  const home = tmp('dead-runs-home');
  const projects = tmp('dead-runs-projects');
  writeJson(path.join(home, 'config.json'), { board_projects_dir: projects });
  const store = new BacklogStore(home);
  const item = store.add({ title: 'A dead subagent', repo: 'acme/widgets' });
  store.start(item.id, { branch: 'feat/dead-run', repo: 'acme/widgets' });
  const sid = 'bbbbbbb2';
  registerRuns(home, {
    sid,
    name: 'dead-author',
    kind: opts.adhoc ?? 'author',
    card: opts.adhoc ? undefined : item.id,
    branch: opts.adhoc ? undefined : 'feat/dead-run',
    repo: 'acme/widgets',
    started: STARTED,
    beat: opts.beatAgo
      ? { n: 2, of: 5, step: 'code', at: new Date(NOW_MS - opts.beatAgo) }
      : undefined,
  });
  if (opts.transcriptAgo !== null) {
    const folder = path.join(projects, '-x', `${sid}-0000-0000-0000-000000000000`, 'subagents');
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'agent-1.jsonl');
    writeFileSync(file, '{}\n');
    writeFileSync(
      path.join(folder, 'agent-1.meta.json'),
      JSON.stringify({ description: 'dead-author: build it' }),
    );
    const written = new Date(NOW_MS - opts.transcriptAgo);
    utimesSync(file, written, written);
  }
  let nowMs = NOW_MS + (opts.later ?? 0) * MIN;
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: sourceSaying({}),
    now: () => new Date(nowMs),
  });
  const look = async () => {
    const cards = (await board.snapshot()).lanes.flatMap((lane) => lane.cards);
    const card = cards.find((found) => found.agents.some((agent) => agent.name === 'dead-author'));
    return { card, agent: card?.agents.find((found) => found.name === 'dead-author') };
  };
  return {
    board,
    sid,
    home,
    moveTo: (minutes: number) => {
      nowMs = NOW_MS + minutes * MIN;
    },
    ...(await look()),
    look,
  };
}

test('board: an author whose transcript went quiet leaves Working for Error; a fresh transcript keeps it in Working', async () => {
  const dead = await boardWith({ transcriptAgo: 2 * 3600000 });
  assert.equal(dead.agent?.state, 'failed');
  assert.equal(dead.agent?.outcome, 'stopped without agent finish');
  assert.equal(dead.card?.column, 'error');
  const alive = await boardWith({ transcriptAgo: MIN });
  assert.equal(alive.agent?.state, 'running');
  assert.equal(alive.card?.column, 'working');
});

test('board: with no transcript found the run stays Working until the 24 hour rule', async () => {
  const none = await boardWith({ transcriptAgo: null });
  assert.equal(none.agent?.state, 'running');
  assert.equal(none.card?.column, 'working');
});

test('board: a run that beat recently stays in Working though its transcript is old', async () => {
  const beating = await boardWith({ transcriptAgo: 2 * 3600000, beatAgo: 5 * MIN });
  assert.equal(beating.agent?.state, 'running');
  assert.equal(beating.card?.column, 'working');
});

test('board: a critic or helper agent card judged dead shows ended (Error, Done) for its stay, counted from when it went dead', async () => {
  for (const [kind, column] of [
    ['critic', 'error'],
    ['helper', 'done'],
  ] as const) {
    // last wrote 40 minutes ago: dead 10 minutes ago, so 20 of its 30 minutes of stay are left
    const dead = await boardWith({ transcriptAgo: 40 * MIN, adhoc: kind });
    assert.equal(dead.card?.column, column, kind);
    assert.equal(dead.agent?.state, kind === 'critic' ? 'failed' : 'done', kind);
    dead.moveTo(19);
    assert.ok((await dead.look()).card, `${kind}: still shown at 29 minutes after it went dead`);
    dead.moveTo(21);
    assert.equal((await dead.look()).card, undefined, `${kind}: gone after its stay`);
  }
});

test('board: a dead ad-hoc author stays in Error for its hour from when it went dead', async () => {
  // last wrote 40 minutes ago: dead 10 minutes ago
  const dead = await boardWith({ transcriptAgo: 40 * MIN, adhoc: 'author' });
  assert.equal(dead.card?.column, 'error');
  dead.moveTo(45);
  assert.ok((await dead.look()).card, 'at 55 minutes after it went dead');
  dead.moveTo(55);
  assert.equal((await dead.look()).card, undefined, 'gone after the hour');
});

test('board: Finish on an agent card the liveness rule shows dead succeeds and clears it', async () => {
  const dead = await boardWith({ transcriptAgo: 40 * MIN, adhoc: 'author' });
  assert.equal(dead.agent?.state, 'failed');
  assert.deepEqual(dead.board.finishAgent(dead.sid, 'dead-author'), { ledger: false });
  assert.equal((await dead.look()).card, undefined);
});

test('board: Finish on a run that is still alive is refused', async () => {
  const alive = await boardWith({ transcriptAgo: MIN, adhoc: 'author' });
  assert.throws(
    () => alive.board.finishAgent(alive.sid, 'dead-author'),
    (err: Error & { status?: number }) => err.status === 409,
  );
});

test('board: a run holding the heavy lock under its name is not judged dead however quiet its transcript', async () => {
  const lock = process.env.ONCE_UPON_HEAVY_LOCK as string;
  mkdirSync(lock, { recursive: true });
  writeFileSync(`${lock}.who`, `dead-author (3:40 PM): yarn test\npid ${process.pid}\n`);
  try {
    const holding = await boardWith({ transcriptAgo: 3 * 3600000 });
    assert.equal(holding.agent?.state, 'running');
    assert.equal(holding.card?.column, 'working');
  } finally {
    rmSync(lock, { recursive: true, force: true });
    rmSync(`${lock}.who`, { force: true });
  }
  const released = await boardWith({ transcriptAgo: 3 * 3600000 });
  assert.equal(released.agent?.state, 'failed', 'dead once the lock is released');
});
