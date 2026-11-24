/*
 * `once-upon compact` (cli/src/commands/checks.ts over core's compact-logs.ts): --dry-run writes nothing, the command moves the old runs to
 * <home>/archive, and `card status` still shows a card's archived runs (and a card that left backlog.jsonl).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { runCli, tmp } from './helpers.ts';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';

const DAY = 24 * 3600 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const row = (kind: string, run: string, time: string, more: Record<string, unknown> = {}) =>
  JSON.stringify({
    op: kind,
    v: 1,
    id: 'abcd1234:old',
    sid8: 'abcd1234',
    name: 'old',
    run,
    at: time,
    ...more,
  }) + '\n';

/** A card landed 40 days ago with a run that ended then, a stored card of an agent nobody ran for 60 days, and an inbox read. */
function build() {
  const home = tmp('compact-command');
  const backlog = new BacklogStore(home);
  const card = backlog.add({ title: 'landed long ago' });
  backlog.start(card.id, { branch: 'old-branch' });
  backlog.done(card.id, { sha: 'abc1234', mergedAt: ago(40) });
  appendFileSync(
    backlog.file,
    JSON.stringify({
      op: 'add',
      id: 'ic_idle000000',
      title: 'an idle agent card',
      note: null,
      repo: null,
      branch: null,
      source: 'agent',
      by: 't',
      at: ago(60),
    }) + '\n',
  );
  writeFileSync(
    path.join(home, 'agents.jsonl'),
    row('start', 'r_0000000001', ago(45), { kind: 'author', task: 't', card: card.id }) +
      row('beat', 'r_0000000001', ago(44.9), { n: 1, of: 5, step: 'code' }) +
      row('finish', 'r_0000000001', ago(44), { state: 'done' }),
  );
  appendFileSync(
    path.join(home, 'inbox.jsonl'),
    JSON.stringify({
      type: 'read',
      id: 'rd_1',
      at: ago(5),
      story: 's',
      chapter: 'c',
      reason: 'time',
    }) + '\n',
  );
  return { home, card };
}
const logs = (home: string) =>
  ['agents.jsonl', 'backlog.jsonl', 'inbox.jsonl'].map((name) =>
    readFileSync(path.join(home, name), 'utf8'),
  );

test('compact --dry-run says what would change and writes nothing', async () => {
  const { home } = build();
  const before = logs(home);
  const result = await runCli(home, ['compact', '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /agents\.jsonl .* -> .*3 lines archived.*\(dry run, nothing written\)/,
  );
  assert.match(result.stdout, /inbox\.jsonl .* -> /);
  assert.deepEqual(logs(home), before);
  assert.equal(existsSync(path.join(home, 'archive')), false);
});

test('compact archives the old run and the idle card, and card status shows both from the archive', async () => {
  const { home, card } = build();
  const result = await runCli(home, ['compact']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /agents\.jsonl .* -> /);
  const archived = readdirSync(path.join(home, 'archive'));
  assert.ok(
    archived.some((name) => /^agents-\d{4}-\d{2}\.jsonl$/.test(name)),
    archived.join(' '),
  );
  assert.ok(
    archived.some((name) => /^backlog-\d{4}-\d{2}\.jsonl$/.test(name)),
    archived.join(' '),
  );
  // the card stays in backlog.jsonl (it landed, nobody deletes a backlog card); its run is only in the archive
  const status = await runCli(home, ['card', 'status', card.id]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /runs: none/);
  assert.match(
    status.stdout,
    /archived runs \(once-upon compact moved them out of agents\.jsonl\):\n\s+abcd1234:old\tauthor\tdone/,
  );
  const json = JSON.parse((await runCli(home, ['card', 'status', card.id, '--json'])).stdout);
  assert.equal(json.runs.length, 0);
  assert.equal(json.archivedRuns.length, 1);
  assert.equal(json.archivedCard, false);
  // the stored card left the log: status finds it in the archive
  const gone = await runCli(home, ['card', 'status', 'ic_idle000000']);
  assert.equal(gone.code, 0, gone.stderr);
  assert.match(gone.stdout, /an idle agent card/);
  assert.match(gone.stdout, /archived: the card left backlog\.jsonl/);
  const missing = await runCli(home, ['card', 'status', 'ic_nothing0000']);
  assert.notEqual(missing.code, 0);
  // nothing more to do the second time
  const again = await runCli(home, ['compact']);
  assert.match(again.stdout, /nothing in agents\.jsonl, backlog\.jsonl or inbox\.jsonl to drop/);
});

test('compact takes day counts, 0 or more', async () => {
  const { home } = build();
  for (const flag of ['--keep-days', '--archive-days']) {
    const bad = await runCli(home, ['compact', flag, 'soon']);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /takes a number of days/);
  }
  const wide = await runCli(home, ['compact', '--archive-days', '90']);
  assert.equal(wide.code, 0, wide.stderr);
  assert.equal(existsSync(path.join(home, 'archive')), false, 'nothing is 90 days old');
});
