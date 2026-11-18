/*
 * `once-upon card backfill` (core/src/features/runs/backfill.ts): the `ic_` cards runs made before ADR-29 are stored with their first
 * run's start as `at`, and `--cardless` gives each recent run with no card one of its agent's. The plain verb changes no board (a stored
 * agent card is not listed); `--cardless` moves runs onto cards the board does not read yet, so it is opt-in (run just before the board
 * reads stored cards). Both are safe to repeat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runCli, tmp, writeJson } from './helpers.ts';
import { Board, noPrWatcher } from '@once-upon-a-diff/board/board';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { readAgents } from '@once-upon-a-diff/state/records/agents/read';
import { backfillCardId } from '@once-upon-a-diff/core/features/runs/backfill';
import { registrySource } from '@once-upon-a-diff/core/features/sessions/sources';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';

const DAY = 24 * 3600 * 1000;
const ago = (days: number, hours = 0) =>
  new Date(Date.now() - days * DAY + hours * 3600_000).toISOString();
const SESSION = 'abcd1234-1111-4222-8333-444444444444';

type Row = Record<string, unknown>;
const row = (kind: string, name: string, run: string | null, time: string, more: Row = {}) =>
  JSON.stringify({
    op: kind,
    v: 1,
    id: `abcd1234:${name}`,
    sid8: 'abcd1234',
    name,
    ...(run ? { run } : {}),
    at: time,
    ...more,
  }) + '\n';
const start = (name: string, run: string | null, time: string, more: Row = {}) =>
  row('start', name, run, time, { kind: 'helper', task: `task of ${name}\nsecond line`, ...more });
const finish = (name: string, run: string, time: string) =>
  row('finish', name, run, time, { state: 'done', outcome: 'ok' });

/** A home with runs of every kind, as agents.jsonl held them before stored cards. */
function build() {
  const home = tmp('card-backfill');
  const store = new BacklogStore(home);
  store.add({ id: 'ic_adopted01', title: 'adopted', source: 'agent' });
  store.adopt('ic_adopted01');
  store.add({ id: 'ic_stored001', title: 'already stored', source: 'agent' });
  const first = ago(3);
  writeFileSync(
    path.join(home, 'agents.jsonl'),
    [
      // an author, restarted once (an earlier run), on one ic_ card; the second run has no task
      start('ou-one', 'r_0000000001', first, {
        kind: 'author',
        card: 'ic_card00001',
        repo: 'acme/widgets',
        branch: 'feat-one',
        session: SESSION,
      }),
      finish('ou-one', 'r_0000000001', ago(2, 20)),
      start('ou-one', 'r_0000000002', ago(2), { kind: 'author', card: 'ic_card00001', task: '' }),
      // a helper on its own ic_ card
      start('a-helper', 'r_0000000003', ago(1), { card: 'ic_card00002' }),
      // an ic_ card that was adopted, and one that A already stored
      start('adopted-run', 'r_0000000004', ago(1), { card: 'ic_adopted01' }),
      start('stored-run', 'r_0000000005', ago(1), { card: 'ic_stored001' }),
      // no card: open, ended 2 days ago, ended 30 days ago, a standing helper, a run with no run id
      start('open-run', 'r_0000000006', ago(1), { repo: 'acme/widgets', session: SESSION }),
      start('ended-2d', 'r_0000000007', ago(2, 1)),
      finish('ended-2d', 'r_0000000007', ago(2)),
      start('ended-30d', 'r_0000000008', ago(31)),
      finish('ended-30d', 'r_0000000008', ago(30)),
      start('standing-one', 'r_0000000009', ago(1), { standing: true }),
      start('no-run-id', null, ago(1)),
      start('ou-cardless', 'r_000000000a', ago(1), {
        kind: 'author',
        repo: 'acme/widgets',
        branch: 'feat-x',
        session: SESSION,
      }),
    ].join(''),
  );
  return { home, first };
}

const backfill = async (home: string, ...args: string[]) => {
  const done = await runCli(home, ['card', 'backfill', ...args]);
  assert.equal(done.code, 0, done.stderr);
  return done.stdout.trim();
};
const bytes = (home: string) => ({
  backlog: readFileSync(path.join(home, 'backlog.jsonl'), 'utf8'),
  agents: readFileSync(path.join(home, 'agents.jsonl'), 'utf8'),
});
const NOW = new Date();
const boardJson = async (home: string) => {
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('backfill-live') });
  const data = await new Board(home, new StoryStore({ home }), noPrWatcher, new Builds(home), {
    source: registrySource,
    now: () => NOW,
  }).snapshot();
  return JSON.stringify(data);
};
const cardOf = (home: string, name: string) =>
  readAgents(home).agents.find((one) => one.name === name)?.card ?? null;

test('plain backfill stores every ic_ id that has no card, with the first run as its `at`, and changes no board', async () => {
  const { home, first } = build();
  const before = await boardJson(home);
  const said = await backfill(home);
  assert.equal(said, 'added 2 cards, moved 0 runs (0 unmovable), skipped 2 stored');
  const store = new BacklogStore(home);
  const one = store.items().find((card) => card.id === 'ic_card00001');
  assert.equal(one?.source, 'agent');
  assert.equal(one?.added_at, first);
  assert.equal(one?.title, 'task of ou-one');
  assert.equal(one?.note, 'task of ou-one\nsecond line');
  assert.equal(one?.repo, 'acme/widgets');
  assert.equal(one?.branch, 'feat-one');
  assert.equal(one?.session, SESSION);
  assert.equal(one?.added_by, 'ou-one');
  assert.ok(store.items().some((card) => card.id === 'ic_card00002'));
  // the adopted card is untouched (one add and its link), and the stored one too
  assert.equal(store.items().find((card) => card.id === 'ic_adopted01')?.source, 'backlog');
  const lines = readFileSync(path.join(home, 'backlog.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.filter((line) => line.includes('"ic_stored001"')).length, 1);
  assert.equal(
    await boardJson(home),
    before,
    'a stored agent card is not listed: the board is as it was',
  );
  // the second run writes nothing
  const files = bytes(home);
  assert.equal(await backfill(home), 'added 0 cards, moved 0 runs (0 unmovable), skipped 4 stored');
  assert.deepEqual(bytes(home), files);
});

test('--dry-run writes nothing and prints the same counts', async () => {
  const { home } = build();
  const files = bytes(home);
  const dry = await backfill(home, '--dry-run', '--cardless');
  assert.deepEqual(bytes(home), files);
  assert.deepEqual(
    readdirSync(home).filter((name) => name.includes('lock')),
    [],
  );
  const real = await backfill(home, '--cardless');
  assert.equal(dry.replace('would add', 'added').replace('move', 'moved'), real);
});

test('--cardless moves the in-scope cardless runs onto one card an agent, and leaves the old, the standing and the run with no id', async () => {
  const { home } = build();
  const before = await boardJson(home);
  const said = await backfill(home, '--cardless');
  // 2 ic_ cards + 3 agents (open, ended 2 days ago, the author; the 30-day-old one is out), one run each
  assert.equal(said, 'added 5 cards, moved 3 runs (1 unmovable), skipped 2 stored');
  const open = cardOf(home, 'open-run');
  const ended = cardOf(home, 'ended-2d');
  assert.equal(open, backfillCardId('abcd1234:open-run'));
  assert.equal(ended, backfillCardId('abcd1234:ended-2d'));
  assert.notEqual(open, ended);
  assert.equal(cardOf(home, 'ended-30d'), null);
  assert.equal(cardOf(home, 'standing-one'), null);
  assert.equal(cardOf(home, 'no-run-id'), null);
  const stored = new BacklogStore(home).items();
  const card = stored.find((one) => one.id === open);
  assert.equal(card?.source, 'agent');
  assert.equal(card?.repo, 'acme/widgets');
  assert.equal(card?.session, SESSION);
  assert.equal(card?.title, 'task of open-run');
  assert.ok(stored.some((one) => one.id === ended));
  assert.equal(
    stored.some((one) => one.id === backfillCardId('abcd1234:ended-30d')),
    false,
  );
  // the board keys a cardless run's card by its agent, and so it does on the agent's own card: today the board reads the same. C reads
  // the stored cards instead, which is when a run on no card would show differently, so --cardless stays opt-in, run just before C
  assert.equal(await boardJson(home), before);
  // a second run writes nothing
  const files = bytes(home);
  assert.match(await backfill(home, '--cardless'), /^added 0 cards, moved 0 runs/);
  assert.deepEqual(bytes(home), files);
});

test('--cardless after a run that died halfway moves the runs left, with no second card', async () => {
  const { home } = build();
  // the card was stored, and none of its runs moved (the first run died between the two writes)
  const id = backfillCardId('abcd1234:open-run');
  new BacklogStore(home).add({ id, title: 'task of open-run', source: 'agent' });
  const said = await backfill(home, '--cardless');
  assert.match(said, /moved 3 runs/);
  assert.equal(cardOf(home, 'open-run'), id);
  assert.equal(new BacklogStore(home).items().filter((card) => card.id === id).length, 1);
  // and one run of an agent moved, the rest not yet: the rest go onto the same card
  const home2 = tmp('card-backfill-half');
  const first = ago(2);
  writeFileSync(
    path.join(home2, 'agents.jsonl'),
    [
      start('multi', 'r_00000000a1', first, {
        kind: 'author',
        branch: 'feat-m',
        repo: 'acme/widgets',
      }),
      finish('multi', 'r_00000000a1', ago(1, 20)),
      start('multi', 'r_00000000a2', ago(1), { kind: 'author' }),
    ].join(''),
  );
  const multi = backfillCardId('abcd1234:multi');
  new BacklogStore(home2).add({ id: multi, title: 'multi', source: 'agent' });
  appendFileSync(
    path.join(home2, 'agents.jsonl'),
    JSON.stringify({
      op: 'card',
      v: 1,
      id: 'abcd1234:multi',
      sid8: 'abcd1234',
      name: 'multi',
      run: 'r_00000000a1',
      card: multi,
      at: ago(1, 21),
    }) + '\n',
  );
  const again = await backfill(home2, '--cardless');
  assert.equal(again, 'added 0 cards, moved 1 runs (0 unmovable), skipped 1 stored');
  assert.equal(cardOf(home2, 'multi'), multi);
  assert.equal(new BacklogStore(home2).items().length, 1);
});

test('a card id that is not a card id is skipped, not thrown on', async () => {
  const home = tmp('card-backfill-bad');
  writeFileSync(
    path.join(home, 'agents.jsonl'),
    start('odd', 'r_00000000b1', ago(1), { card: 'ic_x' }),
  );
  assert.equal(await backfill(home), 'added 0 cards, moved 0 runs (0 unmovable), skipped 1 stored');
});

test('the doctor line names what backfill would do', async () => {
  const { home } = build();
  const done = await runCli(home, ['doctor', '--port', '1']);
  assert.match(
    done.stdout,
    /Stored cards: 2 ic_ ids on runs have no stored card, 3 recent cardless runs/,
  );
  assert.match(done.stdout, /once-upon card backfill/);
  await backfill(home, '--cardless');
  const after = await runCli(home, ['doctor', '--port', '1']);
  assert.match(after.stdout, /PASS\s+Stored cards: every ic_ id on a run has a stored card/);
});
