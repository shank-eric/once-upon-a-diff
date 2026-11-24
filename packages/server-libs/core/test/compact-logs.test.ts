/*
 * `once-upon compact` (src/orchestration/bridge/compact-logs.ts): the runs and cards that go are archived by month, every other run keeps
 * its last beat, the inbox loses what nothing writes, a second run does nothing, --dry-run writes nothing, and the folds of what stays
 * are what they were.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { appendArchive, readArchive } from '@once-upon-a-diff/adapters/stores/fs/archive';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { readAgents } from '@once-upon-a-diff/state/records/agents/read';
import { archivedAgents } from '@once-upon-a-diff/state/records/agents/archive';
import { archivedCards } from '@once-upon-a-diff/state/queues/backlog/archive';
import { compactLogs } from '../src/orchestration/bridge/compact-logs.ts';

const DAY = 24 * 3600 * 1000;
const NOW = new Date('2026-11-24T12:00:00Z');
const ago = (days: number, hours = 0) =>
  new Date(NOW.getTime() - days * DAY + hours * 3600_000).toISOString();
const row = (kind: string, name: string, run: string, time: string, more: object = {}) =>
  JSON.stringify({
    op: kind,
    v: 1,
    id: `abcd1234:${name}`,
    sid8: 'abcd1234',
    name,
    run,
    at: time,
    ...more,
  }) + '\n';
const beats = (name: string, run: string, days: number) =>
  [1, 2, 3].map((count) =>
    row('beat', name, run, ago(days, count), { n: count, of: 5, step: 'code' }),
  );

/** A home with a card landed 40 days ago (its run in October), a card landed 5 days ago, and an open card, each with a run, plus a stored card that is idle. */
function build() {
  const home = tmp('compact-logs');
  const backlog = new BacklogStore(home);
  const old = backlog.add({ title: 'landed long ago' });
  backlog.start(old.id, { branch: 'old-branch' });
  backlog.done(old.id, { sha: 'abc1234', mergedAt: ago(40) });
  const recent = backlog.add({ title: 'landed lately' });
  backlog.start(recent.id, { branch: 'recent-branch' });
  backlog.done(recent.id, { sha: 'def5678', mergedAt: ago(5) });
  const open = backlog.add({ title: 'open' });
  backlog.start(open.id, { branch: 'open-branch' });
  appendFileSync(
    backlog.file,
    JSON.stringify({
      op: 'add',
      id: 'ic_idle00000',
      title: 'idle',
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
    [
      row('start', 'old', 'r_0000000001', ago(45), { kind: 'author', task: 't', card: old.id }),
      ...beats('old', 'r_0000000001', 45),
      row('finish', 'old', 'r_0000000001', ago(44), {
        state: 'done',
        result: { commit: 'abc1234', card: old.id },
      }),
      row('start', 'recent', 'r_0000000002', ago(10), {
        kind: 'author',
        task: 't',
        card: recent.id,
      }),
      ...beats('recent', 'r_0000000002', 10),
      row('finish', 'recent', 'r_0000000002', ago(9), {
        state: 'done',
        result: { commit: 'def5678', card: recent.id },
      }),
      row('start', 'open', 'r_0000000003', ago(40), { kind: 'author', task: 't', card: open.id }),
      ...beats('open', 'r_0000000003', 40),
      row('finish', 'open', 'r_0000000003', ago(39), {
        state: 'done',
        result: { commit: 'aaa1111', card: open.id },
      }),
    ].join(''),
  );
  const inbox = new Inbox(home);
  inbox.append({ type: 'question', story: 's', text: 'q', at: ago(50), id: 'q_1' });
  inbox.append({ type: 'answer', story: 's', question: 'q_1', text: 'a', by: 'x', at: ago(49) });
  for (const id of ['rd_1', 'rd_2']) {
    appendFileSync(
      inbox.file,
      JSON.stringify({ type: 'read', id, at: ago(50), story: 's', chapter: 'c', reason: 'time' }) +
        '\n',
    );
  }
  return { home, old, recent, open, inbox };
}
const compact = (home: string, more: object = {}) =>
  compactLogs(home, { now: NOW, liveSessions: null, ...more });
const sizeOf = (home: string, name: string) => readFileSync(path.join(home, name), 'utf8').length;

test('a run of a card landed 30+ days ago goes to the archive by month, an idle stored card with it, and the rest reads as it did', () => {
  const { home, old, recent, open, inbox } = build();
  const before = readAgents(home).agents;
  const report = compact(home);
  assert.equal(report.length, 3, report.join('\n'));
  assert.match(report[0], /^agents\.jsonl .* -> .*, 5 lines archived, the old log is kept at /);
  // the October run is archived (its rows are the month of each row), the rest is in the log
  const kept = readAgents(home).agents;
  assert.deepEqual(kept.map((agent) => agent.name).sort(), ['open', 'recent']);
  assert.deepEqual(
    archivedAgents(home).map((agent) => agent.name),
    ['old'],
  );
  assert.deepEqual(archivedAgents(home)[0].result?.commit, 'abc1234');
  assert.deepEqual(readdirSync(path.join(home, 'archive')).sort(), [
    'agents-2026-10.jsonl',
    'backlog-2026-09.jsonl',
  ]);
  // what stays folds as it did
  for (const agent of kept) {
    assert.equal(
      JSON.stringify(agent),
      JSON.stringify(before.find((one) => one.name === agent.name)),
      `${agent.name} reads the same`,
    );
  }
  // the idle stored card went to the archive, the real cards stayed
  const cards = new BacklogStore(home).items().map((card) => card.id);
  assert.ok(cards.includes(old.id) && cards.includes(recent.id) && cards.includes(open.id));
  assert.ok(!cards.includes('ic_idle00000'));
  assert.deepEqual(
    archivedCards(home).map((card) => card.id),
    ['ic_idle00000'],
  );
  // the inbox lost its reads, kept the answered question
  assert.deepEqual(
    new Inbox(home).all().map((entry) => entry.type),
    ['question', 'answer'],
  );
  assert.deepEqual(
    inbox.unread('nobody').map((entry) => entry.type),
    ['question', 'answer'],
  );
});

test('a second run does nothing, and the latest old log is the only .bak of each', () => {
  const { home } = build();
  compact(home);
  const text = ['agents.jsonl', 'backlog.jsonl', 'inbox.jsonl'].map((name) =>
    readFileSync(path.join(home, name), 'utf8'),
  );
  assert.deepEqual(compact(home), []);
  assert.deepEqual(
    ['agents.jsonl', 'backlog.jsonl', 'inbox.jsonl'].map((name) =>
      readFileSync(path.join(home, name), 'utf8'),
    ),
    text,
  );
  // a third change on another day replaces the .bak, it does not add one
  appendFileSync(path.join(home, 'agents.jsonl'), beats('open', 'r_0000000003', 40).join(''));
  compact(home, { now: new Date(NOW.getTime() + DAY) });
  assert.equal(readdirSync(home).filter((name) => /^agents\.jsonl\..*\.bak$/.test(name)).length, 1);
});

test('--dry-run writes nothing and says what would change', () => {
  const { home } = build();
  const files = ['agents.jsonl', 'backlog.jsonl', 'inbox.jsonl'].map((name) =>
    readFileSync(path.join(home, name), 'utf8'),
  );
  const report = compact(home, { dryRun: true });
  assert.equal(report.length, 3);
  assert.ok(
    report.every((line) => line.endsWith('(dry run, nothing written)')),
    report.join('\n'),
  );
  assert.deepEqual(
    ['agents.jsonl', 'backlog.jsonl', 'inbox.jsonl'].map((name) =>
      readFileSync(path.join(home, name), 'utf8'),
    ),
    files,
  );
  assert.equal(existsSync(path.join(home, 'archive')), false);
  assert.deepEqual(
    readdirSync(home).filter((name) => name.endsWith('.bak')),
    [],
  );
});

test('--archive-days moves the line: nothing is archived for 60 days, the beats still thin', () => {
  const { home } = build();
  compact(home, { archiveDays: 60 });
  assert.equal(readArchive(home, 'agents'), '');
  assert.equal(readAgents(home).agents.length, 3);
  assert.ok(sizeOf(home, 'agents.jsonl') > 0);
});

test('an idle session card stays with an untrusted registry (null) and with its session live, and goes when it is gone', () => {
  const home = tmp('compact-logs');
  const session = (id: string, who: string) =>
    JSON.stringify({
      op: 'add',
      id,
      title: id,
      note: null,
      repo: null,
      branch: null,
      source: 'session',
      session: who,
      by: 't',
      at: ago(60),
    }) + '\n';
  writeFileSync(
    path.join(home, 'backlog.jsonl'),
    session('ic_sessionlive', 'live') + session('ic_sessiongone', 'gone'),
  );
  compact(home, { liveSessions: ['live'] });
  assert.deepEqual(
    new BacklogStore(home).items().map((card) => card.id),
    ['ic_sessionlive'],
  );
  const again = tmp('compact-logs');
  writeFileSync(
    path.join(again, 'backlog.jsonl'),
    session('ic_sessionlive', 'live') + session('ic_sessiongone', 'gone'),
  );
  compact(again, { liveSessions: null });
  assert.equal(new BacklogStore(again).items().length, 2);
});

test('a line appended while the inbox is rewritten, and the cursors, survive', () => {
  const { home, inbox } = build();
  inbox.setCursor('end', Buffer.byteLength(readFileSync(inbox.file, 'utf8')));
  compact(home);
  inbox.append({ type: 'question', story: 's', text: 'late' });
  assert.deepEqual(
    inbox.unread('end').map((entry) => (entry as { text?: string }).text),
    ['late'],
  );
});

test('an unacked failed run that was restarted under its name does not stop the compaction', () => {
  const { home, old } = build();
  const file = path.join(home, 'agents.jsonl');
  const failed = [
    row('start', 'old', 'r_0000000009', ago(46), { kind: 'author', task: 't', card: old.id }),
    row('finish', 'old', 'r_0000000009', ago(45, -1), { state: 'failed', by: 'auto-finish' }),
  ].join('');
  writeFileSync(file, failed + readFileSync(file, 'utf8'));
  const report = compact(home);
  assert.ok(!report.some((line) => /left alone/.test(line)), report.join('\n'));
  assert.deepEqual(
    readAgents(home)
      .agents.map((agent) => agent.name)
      .sort(),
    ['open', 'recent'],
  );
  assert.ok(existsSync(path.join(home, 'archive', 'agents-2026-10.jsonl')));
});

test('an archived run split across two months reads in log order, to its final state', () => {
  const home = tmp('archive-order');
  const start = (run: string, time: string) =>
    row('start', 'x', run, time, { kind: 'author', task: 't', card: `bl_${run}` }).trim();
  const done = (run: string, time: string) =>
    row('finish', 'x', run, time, { state: 'done' }).trim();
  appendArchive(home, 'agents', [
    { month: '2026-10', line: start('r_p', '2026-10-31T10:00:00Z') },
    { month: '2026-10', line: start('r_q', '2026-10-01T10:00:00Z') },
    { month: '2026-10', line: done('r_q', '2026-10-03T10:00:00Z') },
  ]);
  appendArchive(home, 'agents', [{ month: '2026-11', line: done('r_p', '2026-11-01T10:00:00Z') }]);
  const agent = archivedAgents(home).find(
    (one) => one.run === 'r_p' || one.earlier?.some((e) => e.run === 'r_p'),
  );
  const runP = [agent, ...(agent?.earlier ?? [])].find((one) => one?.run === 'r_p');
  assert.equal(runP?.state, 'done');
});
