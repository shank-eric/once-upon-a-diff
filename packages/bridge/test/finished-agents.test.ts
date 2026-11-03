import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, startBridge, TOKEN, type TestBridge } from './helpers.ts';
import { Board, noPrWatcher } from '../src/services/board/board.ts';
import { StoryStore } from '../src/services/stories/store.ts';
import { Builds } from '../src/services/inbox/builds.ts';
import { boardKey } from '../src/services/pages/page-key.ts';
import { madeSomething } from '../src/services/board/agent-home.ts';
import { doneLine, lastActivity, ledgerTime, parseLedger } from '../src/services/ledger/ledger.ts';
import { appendLine } from '../src/adapters/stores/notes.ts';
import { BoardError } from '../src/services/errors.ts';
import type { StatusSource } from '../src/adapters/iterm.ts';
import type { BoardCard } from '@once-upon-a-diff/protocol/types';

const open: TestBridge[] = [];
after(() => Promise.all(open.map((bridge) => bridge.close())));

// 3:40 PM ET on 11/2
const NOW = new Date('2026-11-02T20:40:00Z');
const MINUTE = 60000;
const SID = 'abcdef01';

const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
  encoding: 'utf8',
  env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
}).trim();

/** A board over a ledger and progress file, with a clock the test moves and one live session (the agents' parent). */
function world(config: Record<string, unknown> = {}) {
  const home = tmp('finished-home');
  const notes = tmp('finished-notes');
  const sessions = tmp('finished-sessions');
  const ledger = path.join(notes, 'ledger.md');
  const progress = path.join(notes, 'progress.md');
  writeFileSync(ledger, '');
  writeFileSync(progress, '');
  writeJson(path.join(sessions, `${process.pid}.json`), {
    pid: process.pid,
    sessionId: `${SID}-aaaa-bbbb-cccc-dddddddddddd`,
    cwd: '/tmp/finished/widgets',
    name: 'main-session',
    status: 'busy',
    startedAt: NOW.getTime() - 3600000,
    statusUpdatedAt: NOW.getTime() - 600000,
    procStart,
  });
  writeJson(path.join(home, 'config.json'), {
    board_ledger_file: ledger,
    board_progress_file: progress,
    board_sessions_dir: sessions,
    board_ledger_time_zone: 'America/New_York',
    ...config,
  });
  const clock = { now: NOW };
  const source: StatusSource = {
    name: 'iterm',
    statuses: async (live) =>
      new Map(live.map((one) => [one.session, { status: 'working', detail: null, title: null }])),
  };
  const board = new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source,
    now: () => clock.now,
    repoOf: async () => 'acme/widgets',
  });
  const cards = async (): Promise<BoardCard[]> =>
    (await board.snapshot()).lanes
      .flatMap((lane) => lane.cards)
      .filter((one) => one.kind === 'agent');
  const card = async (name: string) =>
    (await cards()).find((one) => one.id === `agent:${SID}:${name}`);
  /** moves the clock to `minutes` after NOW (past the board's two-second cache) */
  const moveTo = (minutes: number) => {
    clock.now = new Date(NOW.getTime() + minutes * MINUTE);
  };
  return { home, ledger, progress, board, cards, card, moveTo };
}

const line = (state: string, name: string, time: string, rest: string) =>
  `- [${state}] sid:${SID} ${name} — ${time} — ${rest}\n`;

test('a ledger line names its notes file, and a later line without one keeps it', () => {
  const [one] = parseLedger(
    `- [done] sid:${SID} one — 3:20 PM ET, 11/2 — result in hand — notes/research/2026-11-02-one.md\n`,
    NOW,
  );
  assert.equal(one.notes, 'notes/research/2026-11-02-one.md');
  const [two] = parseLedger(
    `- [done] sid:${SID} two — result; ~/Development/ClariFi/notes/x.md. — 3:20 PM ET, 11/2\n`,
    NOW,
  );
  assert.equal(two.notes, '~/Development/ClariFi/notes/x.md');
  const [kept] = parseLedger(
    `- [running] sid:${SID} three (sonnet) — write notes/a.md — started 3:00 PM ET, 11/2\n- [done] sid:${SID} three — 3:20 PM ET, 11/2 — fine\n`,
    NOW,
  );
  assert.equal(kept.notes, 'notes/a.md');
  assert.equal(
    parseLedger(`- [done] sid:${SID} four — 3:20 PM ET, 11/2 — nothing\n`, NOW)[0].notes,
    null,
  );
});

test('the last thing an agent did is its latest ledger line’s time, else its start', () => {
  const agent = parseLedger(
    line('done', 'a', '3:20 PM ET, 11/2', 'ok'),
    NOW,
    'America/New_York',
  )[0];
  assert.equal(lastActivity(agent)?.toISOString(), '2026-11-02T20:20:00.000Z');
  assert.equal(
    lastActivity({ ended: null, started: new Date(NOW.getTime() - MINUTE) })?.toISOString(),
    new Date(NOW.getTime() - MINUTE).toISOString(),
  );
  assert.equal(lastActivity({ ended: null, started: null }), null);
});

test('the done line Finish writes is Eastern time with its label, whatever zone the reader is set to', () => {
  assert.equal(ledgerTime(NOW), '3:40 PM ET, 11/2');
  assert.equal(ledgerTime(new Date('2026-11-02T05:05:00Z')), '12:05 AM ET, 11/2', 'midnight is 12');
  const text = doneLine({ sid: SID, lane: 'widgets', name: 'asker' }, NOW);
  assert.match(
    text,
    /^- \[done\] sid:abcdef01 lane:widgets asker — 3:40 PM ET, 11\/2 — finished from the board$/,
  );
  for (const zone of ['America/Chicago', 'Asia/Tokyo', undefined]) {
    const [back] = parseLedger(text, NOW, zone);
    assert.deepEqual(
      [back.state, back.lane, back.ended?.toISOString(), back.outcome],
      ['done', 'widgets', NOW.toISOString(), 'finished from the board'],
      String(zone),
    );
  }
});

test('appendLine starts a new line when the file does not end with one, and makes a missing file', () => {
  const file = path.join(tmp('append-line'), 'ledger.md');
  appendLine(file, 'one');
  writeFileSync(file, 'one\ntwo');
  appendLine(file, 'three');
  assert.equal(readFileSync(file, 'utf8'), 'one\ntwo\nthree\n');
});

test('a finished agent sits in Waiting with its outcome, notes and parent, then leaves 30 minutes after its last line', async () => {
  const rig = world();
  writeFileSync(
    rig.ledger,
    line('done', 'research-a', '3:20 PM ET, 11/2', 'options laid out — notes/research/a.md') +
      line('failed', 'research-b', '3:25 PM ET, 11/2', 'the build broke') +
      line('stopped', 'research-c', '3:30 PM ET, 11/2', 'asked to stop') +
      line('done', 'research-old', '2:00 PM ET, 11/2', 'long ago'),
  );
  const first = await rig.card('research-a');
  assert.ok(first, 'a card of its own');
  assert.equal(first.column, 'waiting');
  assert.equal(first.detail, 'options laid out');
  assert.equal(first.parent, 'main-session');
  assert.equal(first.agents[0].notes, 'notes/research/a.md');
  assert.equal(first.agents[0].clears_at, '2026-11-02T20:50:00.000Z');
  assert.equal(first.since, '2026-11-02T20:20:00.000Z');
  assert.equal((await rig.card('research-b'))?.column, 'waiting', 'failed too');
  assert.equal((await rig.card('research-c'))?.column, 'waiting', 'stopped too');
  assert.equal(await rig.card('research-old'), undefined, 'past its 30 minutes');
  rig.moveTo(11);
  assert.equal(await rig.card('research-a'), undefined, 'gone at 3:51 PM');
  assert.ok(await rig.card('research-b'), 'still there: its line was later');
  rig.moveTo(21);
  assert.equal(await rig.card('research-b'), undefined);
});

const running = (name: string, task: string) =>
  `- [running] sid:${SID} ${name} (sonnet, low) — ${task} — started 3:00 PM ET, 11/2\n`;

test('a finished agent that made something is in Done, one that only researched is in Waiting', async () => {
  const rig = world();
  writeFileSync(
    rig.ledger,
    // a build agent: a commit sha in its result
    running('ou-build', 'the board fix in widgets-worktrees/board-fix') +
      line('done', 'ou-build', '3:20 PM ET, 11/2', 'branch board-fix, sha 0637f8f, tests green') +
      // a card id in its task is only text: it made nothing the board can see (a real claim is a card, not this)
      running('ou-linked', 'card bl_abc123def456 write the thing') +
      line('done', 'ou-linked', '3:21 PM ET, 11/2', 'wrote it up') +
      // a card adder: its result names the card it added
      running('ou-adder', 'look for gaps in the board') +
      line('done', 'ou-adder', '3:22 PM ET, 11/2', 'added card bl_zzz999yyy888 for the gap') +
      // a deploy with no sha
      running('ou-deployer', 'ship it') +
      line('done', 'ou-deployer', '3:23 PM ET, 11/2', 'deployed to the local board') +
      // a reviewer: findings are in the story and the file
      running('review-board-fix', 'review the diff') +
      line('done', 'review-board-fix', '3:24 PM ET, 11/2', '3 findings — notes/reviews/x.md') +
      // pure research: options and a notes file
      running('research-fees', 'compare the fee options') +
      line(
        'done',
        'research-fees',
        '3:25 PM ET, 11/2',
        'options laid out — notes/research/fees.md',
      ) +
      // a research agent that was stopped, and one that failed, even with a build-like task
      running('research-stopped', 'dig into the wedge') +
      line('stopped', 'research-stopped', '3:26 PM ET, 11/2', 'asked to stop') +
      running('ou-stopped-claim', 'card bl_abc123def456 try it') +
      line('stopped', 'ou-stopped-claim', '3:26 PM ET, 11/2', 'asked to stop') +
      running('ou-failed', 'card bl_abc123def456 try it') +
      line('failed', 'ou-failed', '3:27 PM ET, 11/2', 'the build broke, nothing committed'),
  );
  const columns: Record<string, string | undefined> = {};
  for (const name of [
    'ou-build',
    'ou-linked',
    'ou-adder',
    'ou-deployer',
    'review-board-fix',
    'research-fees',
    'research-stopped',
    'ou-stopped-claim',
    'ou-failed',
  ]) {
    columns[name] = (await rig.card(name))?.column;
  }
  assert.deepEqual(columns, {
    'ou-build': 'done',
    'ou-linked': 'waiting',
    'ou-adder': 'done',
    'ou-deployer': 'done',
    'review-board-fix': 'done',
    'research-fees': 'waiting',
    'research-stopped': 'waiting',
    'ou-stopped-claim': 'waiting',
    'ou-failed': 'waiting',
  });
  const built = await rig.card('ou-build');
  assert.equal(
    built?.agents[0].clears_at,
    '2026-11-02T20:50:00.000Z',
    'Done cards clear on the same timer',
  );
});

test('what counts as something made: a sha it produced, a build, a deploy, a branch, a card added, a reviewer', () => {
  const made = (
    task: string | null,
    outcome: string | null,
    name = 'ou-x',
    state: 'done' | 'stopped' = 'done',
  ) => madeSomething({ name, task, outcome, state });
  // shas it produced, including all-digit ones
  assert.equal(made(null, 'on main at 0637f8f'), true, 'sha');
  assert.equal(made(null, '3556751 live on phone/live after Eric’s OK'), true, 'all-digit sha');
  assert.equal(
    made(null, '5901849: per-turn clustering, 379 pass'),
    true,
    'a sha leading the result',
  );
  assert.equal(made(null, 'work done (3064178)'), true);
  assert.equal(made(null, 'stack/5 now 4fc94ff: read-only key'), true, 'a branch’s new tip');
  assert.equal(made(null, 'rebased on develop 284c668, green'), true);
  assert.equal(made(null, 'live 8dcb3bc (stack/35: worktree board), main ff’d'), true);
  // actions
  assert.equal(made(null, 'committed the fix'), true);
  assert.equal(made(null, 'pushed and deployed'), true);
  assert.equal(made(null, 'built + wired, 26 tests pass, uncommitted'), true);
  assert.equal(made(null, 'published the private Artifact'), true);
  assert.equal(made(null, 'caddy/ install.sh staged'), true);
  assert.equal(made(null, 'built as larmor-burst-guard, live'), true);
  assert.equal(made(null, 'on branch card-agent-link'), true);
  assert.equal(made(null, 'on branch feat/x'), true);
  assert.equal(
    made(null, 'record in ClariFi-worktrees/feature/12.md'),
    false,
    'a worktrees path is only text',
  );
  // cards
  assert.equal(made(null, 'filed bl_mvzro4kube937c'), true, 'a card it added');
  assert.equal(made(null, 'card bl_mvzqiqp629372e at top'), true);
  assert.equal(
    made('card bl_mvzro4kube937c do it', 'ok'),
    false,
    'a card id in the task is only text',
  );
  assert.equal(
    made('refactor in widgets-worktrees/refactor', 'ok'),
    false,
    'a worktree its task names is only text',
  );
  assert.equal(made('look at it', 'ok', 'review-thing'), true, 'a reviewer');
  assert.equal(made('look at it', 'asked to stop', 'review-thing', 'stopped'), true);
  // a stopped agent has to show output
  assert.equal(made('card bl_mvzro4kube937c do it', 'asked to stop', 'ou-x', 'stopped'), false);
  assert.equal(
    made('refactor in widgets-worktrees/refactor', null, 'ou-x', 'stopped'),
    false,
    'a worktrees path in the task alone',
  );
  assert.equal(made('card bl_mvzro4kube937c', 'committed 0637f8f', 'ou-x', 'stopped'), true);
  // research: nothing it made
  assert.equal(made('compare options', 'options laid out — notes/research/a.md'), false);
  assert.equal(made(null, null), false);
  assert.equal(
    made('see bl_mvzro4kube937c for context', 'summarised the thread'),
    false,
    'an id in passing is not a claim',
  );
  assert.equal(
    made(null, 'see card bl_mvu1ajh3e75c97, it covers this'),
    false,
    'an id with no added word',
  );
  assert.equal(made(null, 'Eric picked 2 cards (redux bl_mvu1ajh3e75c97)'), false);
  // quoted commits, PRs, sids and worktrees are not output
  assert.equal(made(null, 'cites 31d1f56 as the reason'), false);
  assert.equal(made(null, 'a stale function from before e5342ec'), false);
  assert.equal(made(null, 'found in ed7b242'), false);
  assert.equal(made(null, 'closed by sid:86c0254d'), false, 'a sid is not a sha');
  assert.equal(made(null, 'PR #6995 merged'), false);
  assert.equal(made(null, 'card dropped, worktree removed'), false);
  assert.equal(made(null, 'default = main worktree'), false);
  assert.equal(made(null, 'ideas: 12 built, 5 open'), false, 'a count of other things built');
  assert.equal(made(null, 'the live bridge keys are different'), false);
  assert.equal(made(null, 'no longer live on 2026.19.0'), false);
  // said as not done
  assert.equal(made(null, 'no branch needed, nothing deployed'), false);
  assert.equal(made(null, 'nothing was committed or pushed'), false);
  assert.equal(made(null, 'committed? no'), false);
  assert.equal(made(null, 'pushed: none'), false);
  assert.equal(made(null, 'no new worktree or branch feat/x'), false);
  assert.equal(made(null, 'no code written; findings in the note'), false);
  assert.equal(
    made(null, 'committed 794009f on docs/adrs, not pushed'),
    true,
    'a commit, not pushed',
  );
  assert.equal(made(null, 'deadbeef and 20261102 are not shas'), false);
  assert.equal(made(null, 'the branch is fine'), false);
});

test('board_finished_wait_minutes sets how long a finished agent waits', async () => {
  const text = line('done', 'quick', '3:20 PM ET, 11/2', 'ok');
  const short = world({ board_finished_wait_minutes: 10 });
  writeFileSync(short.ledger, text);
  assert.equal(await short.card('quick'), undefined, '20 minutes is past a 10-minute wait');
  const long = world({ board_finished_wait_minutes: 90 });
  writeFileSync(long.ledger, text);
  assert.ok(await long.card('quick'));
  long.moveTo(60);
  assert.ok(await long.card('quick'), 'at 80 minutes of a 90-minute wait');
  long.moveTo(75);
  assert.equal(await long.card('quick'), undefined);
});

test('a new ledger line resets the timer, and progress beats do not count', async () => {
  const rig = world();
  writeFileSync(
    rig.ledger,
    line('done', 'by-line', '3:20 PM ET, 11/2', 'first') +
      line('done', 'by-beat', '3:20 PM ET, 11/2', 'first'),
  );
  rig.moveTo(9);
  assert.equal((await rig.card('by-line'))?.agents[0].clears_at, '2026-11-02T20:50:00.000Z');
  appendFileSync(rig.ledger, line('done', 'by-line', '3:48 PM ET, 11/2', 'second look'));
  appendFileSync(rig.progress, '- 3:47 PM by-beat 6/6 done: more notes\n');
  rig.moveTo(12); // 3:52 PM, past the first window
  const byLine = await rig.card('by-line');
  assert.equal(
    byLine?.agents[0].clears_at,
    '2026-11-02T21:18:00.000Z',
    'a later line: a fresh 30 minutes',
  );
  assert.equal(byLine?.detail, 'second look');
  assert.equal(await rig.card('by-beat'), undefined, 'a beat has no date: it starts nothing');
});

test('an old agent does not come back because a beat from days ago has this time of day', async () => {
  const rig = world();
  writeFileSync(rig.ledger, line('done', 'last-week', '3:35 PM ET, 10/23', 'long finished'));
  // beat.sh writes a time of day only: 10/23's beat at 3:35 PM reads as today's 3:35 PM
  writeFileSync(rig.progress, '- 3:35 PM last-week 6/6 done: all green\n');
  assert.equal(await rig.card('last-week'), undefined);
  rig.moveTo(5);
  assert.equal(await rig.card('last-week'), undefined);
});

test('one name used by two sessions is two agents: the old one stays gone while the new one waits', async () => {
  const rig = world();
  const other = 'deadbeef';
  writeFileSync(
    rig.ledger,
    `- [done] sid:${other} review-x — 2:00 PM ET, 11/2 — first pass\n` +
      `- [done] sid:${SID} review-x — 3:30 PM ET, 11/2 — second pass\n`,
  );
  writeFileSync(rig.progress, '- 3:35 PM review-x 6/6 done: finished\n');
  const waiting = (await rig.cards()).filter((one) => one.title === 'review-x');
  assert.deepEqual(
    waiting.map((one) => one.id),
    [`agent:${SID}:review-x`],
  );
  assert.equal(waiting[0].detail, 'second pass');
});

test('Finish clears a finished agent’s card at once, writes no ledger line, and a later line brings it back', async () => {
  const rig = world();
  const text = line('done', 'finisher', '3:20 PM ET, 11/2', 'result');
  writeFileSync(rig.ledger, text);
  assert.ok(await rig.card('finisher'));
  assert.deepEqual(rig.board.finishAgent(SID, 'finisher'), { ledger: false });
  assert.equal(await rig.card('finisher'), undefined, 'gone at once');
  assert.equal(readFileSync(rig.ledger, 'utf8'), text, 'a finished agent needs no new line');
  rig.moveTo(1);
  assert.equal(await rig.card('finisher'), undefined, 'still gone on the next look');
  appendFileSync(rig.ledger, line('done', 'finisher', '3:42 PM ET, 11/2', 'one more thing'));
  rig.moveTo(3);
  const back = await rig.card('finisher');
  assert.equal(back?.detail, 'one more thing', 'it did something more');
  assert.equal(back?.agents[0].clears_at, '2026-11-02T21:12:00.000Z');
});

test('Finish on an agent waiting on a question writes its [done] line, and the card goes', async () => {
  const rig = world();
  writeFileSync(
    rig.ledger,
    line('waiting', 'asker', '3:30 PM ET, 11/2', 'needs Eric: pick A or B').trimEnd(),
  );
  const waiting = await rig.card('asker');
  assert.equal(waiting?.agents[0].state, 'waiting');
  assert.equal(waiting?.agents[0].clears_at, null, 'a question has no timer');
  assert.deepEqual(rig.board.finishAgent(SID, 'asker'), { ledger: true });
  assert.equal(
    readFileSync(rig.ledger, 'utf8').split('\n').at(-2),
    `- [done] sid:${SID} asker — 3:40 PM ET, 11/2 — finished from the board`,
  );
  assert.equal(await rig.card('asker'), undefined);
  rig.moveTo(5);
  assert.equal(await rig.card('asker'), undefined, 'its own [done] line does not bring it back');
});

test('Finish refuses a working agent, one parked on your review, and one the ledger does not have', () => {
  const rig = world();
  writeFileSync(
    rig.ledger,
    `- [running] sid:${SID} busy (sonnet, low) — a task — started 3:30 PM ET, 11/2\n` +
      line('review', 'parked', '3:30 PM ET, 11/2', 'story abc up'),
  );
  const refuses = (name: string, status: number) =>
    assert.throws(
      () => rig.board.finishAgent(SID, name),
      (err: unknown) => err instanceof BoardError && err.status === status,
    );
  refuses('busy', 409);
  refuses('parked', 409);
  refuses('nobody', 404);
  assert.throws(
    () => world({ board_ledger_file: '' }).board.finishAgent(SID, 'x'),
    (err: unknown) => err instanceof BoardError && err.status === 400,
  );
});

test('Finish still clears a card whose last line is ahead of the clock', async () => {
  const rig = world();
  // a line stamped 20 minutes after "now": a wrong zone label, or a typo
  writeFileSync(rig.ledger, line('done', 'ahead', '4:00 PM ET, 11/2', 'result'));
  assert.ok(await rig.card('ahead'));
  rig.board.finishAgent(SID, 'ahead');
  assert.equal(await rig.card('ahead'), undefined);
  rig.moveTo(30);
  assert.equal(
    await rig.card('ahead'),
    undefined,
    'and it stays gone while nothing later is written',
  );
  appendFileSync(rig.ledger, line('done', 'ahead', '4:20 PM ET, 11/2', 'more'));
  rig.moveTo(31);
  assert.equal((await rig.card('ahead'))?.detail, 'more', 'a later line brings it back');
});

test('POST /api/board/agent/finish takes the board key and a sid and name', async () => {
  const rig = world();
  writeFileSync(rig.ledger, line('done', 'routed', '3:20 PM ET, 11/2', 'result'));
  const bridge = await startBridge({ home: rig.home });
  open.push(bridge);
  const post = (key: string, body: unknown) =>
    bridge.call<{ ok?: boolean; ledger?: boolean }>('POST', '/api/board/agent/finish', body, {
      Authorization: `Bearer ${key}`,
    });
  const key = boardKey(TOKEN);
  assert.equal((await post(key, {})).status, 400);
  assert.equal((await post(key, { sid: 'nothex', name: 'routed' })).status, 400);
  assert.equal((await post(key, { sid: SID, name: '../x' })).status, 400);
  assert.equal((await post(key, { sid: SID, name: 'nobody' })).status, 404);
  assert.equal((await post('a-wrong-key', { sid: SID, name: 'routed' })).status, 401);
  const done = await post(key, { sid: SID, name: 'routed' });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { ok: true, ledger: false });
});
